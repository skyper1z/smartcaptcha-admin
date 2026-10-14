// Pricing Review tab: lists canonical catalog prices and lets permitted staff
// approve or reject them. Reads use the signed-in user's session (staff RLS);
// approvals go only through the role-checked Worker API, never direct writes.
document.addEventListener('DOMContentLoaded', () => {
  const env = window.SMARTCAP_ENV;
  const tabButton = document.getElementById('pricing-tab-btn');
  const section = document.getElementById('pricing-tab');
  if (!env || !tabButton || !section) return;

  // The Worker admin API only exists where configured (development for now).
  if (!env.workerUrl) {
    tabButton.remove();
    section.remove();
    return;
  }

  const list = document.getElementById('pricing-list');
  const statusEl = document.getElementById('pricing-status');
  const roleEl = document.getElementById('pricing-role');
  const statusFilter = document.getElementById('pricing-status-filter');
  const typeFilter = document.getElementById('pricing-type-filter');
  const searchInput = document.getElementById('pricing-search');
  const countsEl = document.getElementById('pricing-counts');

  let items = [];
  let depositRules = [];
  let canApprove = false;
  let canEdit = false;
  let editingItemId = null;
  let loaded = false;

  const { escapeHtml, workerFetch, staffProfile, parseCedis } = window.SmartcapWorker;

  // Integer pesewas → "GHS 6,500.00" without floating-point arithmetic.
  function formatMinor(minor) {
    if (minor === null || minor === undefined) return '—';
    const value = BigInt(minor);
    const cedis = value / 100n;
    const pesewas = (value % 100n).toString().padStart(2, '0');
    return `GHS ${cedis.toLocaleString('en-US')}.${pesewas}`;
  }

  function describePrice(price) {
    switch (price.pricing_model) {
      case 'fixed': return formatMinor(price.amount_minor);
      case 'starting_at': return `From ${formatMinor(price.amount_minor)}`;
      case 'per_unit': return `${formatMinor(price.amount_minor)} per ${price.unit || 'unit'}`;
      case 'range': return `${formatMinor(price.amount_minor)} – ${formatMinor(price.max_amount_minor)}`;
      case 'percentage': return `${price.percentage_basis_points / 100}% of ${price.unit || 'base'}`;
      default: return 'Requires quote';
    }
  }

  const NEEDS_HUMAN_QUOTE = new Set(['starting_at', 'range', 'percentage', 'requires_quote']);

  function depositFor(item) {
    const now = Date.now();
    const active = depositRules.filter((rule) =>
      rule.is_active &&
      Date.parse(rule.effective_from) <= now &&
      (!rule.effective_to || Date.parse(rule.effective_to) > now) &&
      (rule.catalog_item_id === item.id || (rule.tone && rule.tone === item.tone) ||
        (!rule.catalog_item_id && !rule.tone))
    );
    active.sort((a, b) => b.priority - a.priority);
    return active[0] ? `${active[0].percentage_basis_points / 100}%` : '—';
  }

  function sourceLink(source) {
    if (!source || source.kind !== 'website_import') {
      return source && source.kind === 'owner_decision'
        ? `Owner decision ${escapeHtml(source.decided_on || '')}`
        : '';
    }
    const url = `https://github.com/${source.repository}/blob/${source.commit}/${source.file}#L${source.line}`;
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.file)}:${escapeHtml(source.line)}</a>
      <span class="pricing-muted">(website said “${escapeHtml(source.original_price)}”)</span>`;
  }

  async function load() {
    statusEl.textContent = 'Loading…';
    list.innerHTML = '';
    try {
      const me = await staffProfile();
      canApprove = me.permissions.includes('catalog.approve');
      canEdit = me.permissions.includes('catalog.edit');
      roleEl.textContent = `Signed in as ${me.staff_role}${canApprove ? '' : ' (view only)'}`;
      if (!me.permissions.includes('catalog.read_internal')) {
        statusEl.textContent = 'Your role cannot view the internal catalog.';
        return;
      }
    } catch (err) {
      roleEl.textContent = '';
      statusEl.textContent = err.status === 403
        ? 'This account has no staff role. Ask an admin to assign one.'
        : `Could not verify your role: ${err.message}`;
      return;
    }

    const [{ data, error }, deposits] = await Promise.all([
      window.supabaseClient
        .from('catalog_items')
        .select('id, code, item_type, title, category, tone, tab, review_status, metadata, source, display_order, catalog_price_versions(id, pricing_model, amount_minor, max_amount_minor, percentage_basis_points, unit, display_price, review_status, effective_from)')
        .order('display_order', { ascending: true }),
      window.supabaseClient
        .from('deposit_rules')
        .select('catalog_item_id, tone, percentage_basis_points, priority, is_active, effective_from, effective_to')
    ]);
    if (error) {
      statusEl.textContent = `Error loading catalog: ${error.message}`;
      return;
    }
    depositRules = deposits.data || [];
    items = data;
    loaded = true;
    statusEl.textContent = '';
    render();
  }

  const newestFirst = (a, b) => Date.parse(b.effective_from) - Date.parse(a.effective_from) || b.id - a.id;

  // The price customers and the assistant currently see.
  function livePrice(item) {
    const now = Date.now();
    return [...(item.catalog_price_versions || [])]
      .filter((p) => p.review_status === 'approved' && Date.parse(p.effective_from) <= now)
      .sort(newestFirst)[0];
  }

  function pendingPrice(item) {
    return [...(item.catalog_price_versions || [])]
      .filter((p) => p.review_status === 'pending_review')
      .sort(newestFirst)[0];
  }

  // What needs attention: a pending proposal, else the live price, else the
  // newest (rejected) version.
  function latestPrice(item) {
    return pendingPrice(item) || livePrice(item)
      || [...(item.catalog_price_versions || [])].sort(newestFirst)[0];
  }

  function minorToCedis(minor) {
    if (minor === null || minor === undefined) return '';
    const value = BigInt(minor);
    const pesewas = value % 100n;
    return `${value / 100n}${pesewas ? `.${pesewas.toString().padStart(2, '0')}` : ''}`;
  }

  function editForm(item, base) {
    const model = base ? base.pricing_model : 'fixed';
    const option = (value, label) => `<option value="${value}" ${value === model ? 'selected' : ''}>${label}</option>`;
    return `
      <form class="pricing-edit" data-edit-form="${item.id}">
        <select name="model" aria-label="Pricing type">
          ${option('fixed', 'Fixed price')}${option('starting_at', 'Starting from')}${option('range', 'Range')}
          ${option('per_unit', 'Per unit')}${option('percentage', 'Percentage of package')}${option('requires_quote', 'Price on request')}
        </select>
        <input name="amount" inputmode="decimal" placeholder="Amount (GHS)" value="${escapeHtml(minorToCedis(base && base.amount_minor))}" aria-label="Amount in GHS">
        <input name="max" inputmode="decimal" placeholder="Max (GHS, ranges)" value="${escapeHtml(minorToCedis(base && base.max_amount_minor))}" aria-label="Maximum in GHS">
        <input name="percent" inputmode="decimal" placeholder="%" value="${base && base.percentage_basis_points ? base.percentage_basis_points / 100 : ''}" aria-label="Percent">
        <input name="unit" placeholder="Unit (e.g. each, hour)" value="${escapeHtml((base && base.unit) || '')}" aria-label="Unit">
        <input name="note" placeholder="Reason for change" maxlength="300" aria-label="Reason for change">
        <button type="submit" class="button primary">Propose price</button>
        <button type="button" class="button" data-cancel-edit>Cancel</button>
        <p class="pricing-muted">The new price goes live on the website and in WhatsApp after an admin approves it. Existing quotes keep their price.</p>
      </form>`;
  }

  function render() {
    const statusValue = statusFilter.value;
    const typeValue = typeFilter.value;
    const query = searchInput.value.trim().toLowerCase();

    const counts = { pending_review: 0, approved: 0, rejected: 0 };
    items.forEach((item) => {
      const price = latestPrice(item);
      if (price) counts[price.review_status] = (counts[price.review_status] || 0) + 1;
    });
    countsEl.textContent = `${counts.pending_review} pending · ${counts.approved} approved · ${counts.rejected} rejected`;

    const rows = items.filter((item) => {
      const price = latestPrice(item);
      if (!price) return false;
      if (statusValue !== 'all' && price.review_status !== statusValue) return false;
      if (typeValue !== 'all' && item.item_type !== typeValue) return false;
      if (query && !`${item.title} ${item.code} ${item.category}`.toLowerCase().includes(query)) return false;
      return true;
    });

    if (rows.length === 0) {
      list.innerHTML = '<p class="pricing-muted">No prices match these filters.</p>';
      return;
    }

    list.innerHTML = rows.map((item) => {
      const price = latestPrice(item);
      const notes = (item.metadata && item.metadata.review_notes) || [];
      const flags = [];
      if (NEEDS_HUMAN_QUOTE.has(price.pricing_model)) flags.push('Needs human quote');
      if (notes.length) flags.push('Has review notes');
      const live = livePrice(item);
      const actions = (canApprove && price.review_status === 'pending_review'
        ? `<button class="button primary" data-action="approved" data-price="${price.id}">Approve</button>
           <button class="button danger" data-action="rejected" data-price="${price.id}">Reject</button>`
        : `<span class="pricing-badge pricing-badge--${escapeHtml(price.review_status)}">${escapeHtml(price.review_status.replace('_', ' '))}</span>`)
        + (canEdit ? ` <button class="button" data-edit="${item.id}">Edit price</button>` : '');
      const priceLine = live && price.review_status === 'pending_review' && live.id !== price.id
        ? `Live: ${escapeHtml(describePrice(live))} → <strong>Proposed: ${escapeHtml(describePrice(price))}</strong>`
        : escapeHtml(describePrice(price));

      return `
        <article class="pricing-row" data-item="${item.id}">
          <div class="pricing-main">
            <h3>${escapeHtml(item.title)}</h3>
            <p class="pricing-meta">
              ${escapeHtml(item.item_type)} · ${escapeHtml(item.category)}${item.tab ? ` · ${escapeHtml(item.tab)}` : ''}
              · <code>${escapeHtml(item.code)}</code>
            </p>
            <p class="pricing-price">${priceLine}
              <span class="pricing-muted">· deposit ${escapeHtml(depositFor(item))}${item.tone ? ` (${escapeHtml(item.tone)})` : ''}</span>
            </p>
            ${flags.map((flag) => `<span class="pricing-flag">${escapeHtml(flag)}</span>`).join(' ')}
            ${notes.length ? `<ul class="pricing-notes">${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>` : ''}
            <p class="pricing-source">Source: ${sourceLink(item.source)}</p>
          </div>
          <div class="pricing-actions">${actions}</div>
        </article>
        ${editingItemId === item.id ? editForm(item, live || price) : ''}`;
    }).join('');
  }

  list.addEventListener('click', (event) => {
    const editButton = event.target.closest('[data-edit]');
    if (editButton) {
      editingItemId = Number(editButton.dataset.edit);
      render();
      return;
    }
    if (event.target.closest('[data-cancel-edit]')) {
      editingItemId = null;
      render();
    }
  });

  list.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-edit-form]');
    if (!form) return;
    event.preventDefault();
    const item = items.find((candidate) => candidate.id === Number(form.dataset.editForm));
    const f = Object.fromEntries(new FormData(form).entries());
    const model = f.model;
    const body = { pricing_model: model, change_note: f.note || undefined };
    const needsAmount = ['fixed', 'starting_at', 'range', 'per_unit'].includes(model);
    if (needsAmount) {
      body.amount_minor = parseCedis(f.amount);
      if (body.amount_minor === null) { statusEl.textContent = 'Enter the amount in GHS, e.g. 6500 or 6,500.00.'; return; }
    }
    if (model === 'range') {
      body.max_amount_minor = parseCedis(f.max);
      if (body.max_amount_minor === null || body.max_amount_minor <= body.amount_minor) {
        statusEl.textContent = 'For a range, enter a maximum greater than the amount.'; return;
      }
    }
    if (model === 'percentage') {
      const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(String(f.percent).trim());
      const bp = match ? Number(match[1]) * 100 + Number((match[2] || '0').padEnd(2, '0')) : 0;
      if (bp < 1 || bp > 10000) { statusEl.textContent = 'Enter a percentage between 0.01 and 100.'; return; }
      body.percentage_basis_points = bp;
      body.unit = f.unit || 'package';
    }
    if (model === 'per_unit') body.unit = f.unit || 'each';
    if (!confirm(`Propose a new price for ${item.title}? It goes live only after approval.`)) return;
    try {
      const result = await workerFetch(`/admin/catalog/items/${encodeURIComponent(item.code)}/price-versions`, {
        method: 'POST', body: JSON.stringify(body)
      });
      statusEl.textContent = `${item.title}: proposed ${result.display_price} — waiting for approval.`;
      editingItemId = null;
      statusFilter.value = 'pending_review';
      await load();
    } catch (err) {
      statusEl.textContent = `Could not propose price: ${err.message}`;
    }
  });

  list.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const decision = button.dataset.action;
    const priceId = Number(button.dataset.price);
    const item = items.find((candidate) =>
      (candidate.catalog_price_versions || []).some((price) => price.id === priceId));
    const price = item && latestPrice(item);
    if (!item || !price) return;

    const verb = decision === 'approved' ? 'APPROVE' : 'REJECT';
    if (!confirm(`${verb} this price?\n\n${item.title}\n${describePrice(price)}\n\nApproved prices become visible to customers and usable for quotes.`)) {
      return;
    }

    button.closest('.pricing-actions').querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      await workerFetch(`/admin/catalog/price-versions/${priceId}/review`, {
        method: 'POST',
        body: JSON.stringify({ decision })
      });
      price.review_status = decision;
      if (decision === 'approved') item.review_status = 'approved';
      statusEl.textContent = `${item.title}: ${decision}.`;
      render();
    } catch (err) {
      statusEl.textContent = `Could not save decision for ${item.title}: ${err.message}`;
      button.closest('.pricing-actions').querySelectorAll('button').forEach((b) => { b.disabled = false; });
    }
  });

  [statusFilter, typeFilter].forEach((el) => el.addEventListener('change', () => loaded && render()));
  searchInput.addEventListener('input', () => loaded && render());
  document.getElementById('pricing-refresh').addEventListener('click', load);
  tabButton.addEventListener('click', () => { if (!loaded) load(); });
});
