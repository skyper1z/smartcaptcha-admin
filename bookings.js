// Bookings tab: build a quote from approved items, hold a date, record a
// customer's reported payment, verify payments (admin/finance), and cancel
// (admin). All writes go through the role-checked Worker API; totals and
// deposits come only from the server-side quote engine.
document.addEventListener('DOMContentLoaded', () => {
  const env = window.SMARTCAP_ENV;
  const tabButton = document.getElementById('bookings-tab-btn');
  const section = document.getElementById('bookings-tab');
  if (!env || !tabButton || !section) return;
  if (!env.workerUrl) {
    tabButton.remove();
    section.remove();
    return;
  }

  const { escapeHtml, workerFetch, staffProfile, parseCedis, openWorkerPdf } = window.SmartcapWorker;
  const el = (id) => document.getElementById(id);
  const statusEl = el('bookings-status');
  let me = null;
  let catalog = [];
  let lastQuote = null;

  const can = (permission) => Boolean(me && me.permissions.includes(permission));

  // Integer pesewas → "GHS 4,550.00" without floating point.
  function money(minor) {
    if (minor === null || minor === undefined) return '—';
    const value = BigInt(minor);
    return `GHS ${(value / 100n).toLocaleString('en-US')}.${(value % 100n).toString().padStart(2, '0')}`;
  }

  const ERROR_TEXT = {
    date_unavailable: 'That date is already taken.',
    quote_not_bookable: 'This quote needs human pricing before it can be booked.',
    quote_expired: 'This quote has expired. Create a new one.',
    quote_already_booked: 'This quote already has an active booking.',
    hold_expired: 'The hold expired before payment was recorded.',
    duplicate_transaction_reference: 'That transaction reference was already used.',
    amount_below_deposit: 'The approved amount does not cover the deposit.',
    reason_required: 'A reason is required.',
    contract_not_accepted: 'The customer has not accepted the service agreement yet. The booking can be confirmed once they tap "I agree".',
    contract_settings_not_approved: 'The agreement terms are not approved yet (see "Agreement terms" below).',
    contract_details_required: 'Add the customer\'s full name and the venue first (Agreement details).',
    contract_already_accepted: 'The customer has already accepted the agreement.',
    invalid_contract_details: 'Enter the customer\'s full name and the venue.',
    outside_service_window: 'The customer has not messaged in the last 24 hours, so WhatsApp will not deliver this.'
  };
  const explain = (err) => ERROR_TEXT[err.message] || err.message;

  async function run(label, action) {
    statusEl.textContent = `${label}…`;
    try {
      const result = await action();
      statusEl.textContent = '';
      await loadAll();
      return result;
    } catch (err) {
      statusEl.textContent = `${label} failed: ${explain(err)}`;
      return null;
    }
  }

  // ── Quote builder ───────────────────────────────────────────
  async function loadConversations() {
    const select = el('bk-conversation');
    if (!can('conversations.read')) {
      select.disabled = true;
      return;
    }
    const { data } = await window.supabaseClient
      .from('conversations')
      .select('id, wa_id, profile_name, last_message_at')
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(50);
    const current = select.value;
    select.innerHTML = '<option value="">— No chat linked —</option>' + (data || []).map((c) =>
      `<option value="${c.id}">${escapeHtml(c.profile_name || 'Customer')} · ${/^\d+$/.test(c.wa_id) ? `+${escapeHtml(c.wa_id)}` : 'number hidden'}</option>`).join('');
    select.value = current;
  }

  async function loadCatalog() {
    const { data } = await window.supabaseClient
      .from('catalog_public')
      .select('code, title, item_type, display_price, pricing_model')
      .order('display_order', { ascending: true });
    catalog = data || [];
    el('bk-quote-items').innerHTML = catalog.length
      ? catalog.map((item, index) => `
          <label class="bk-item">
            <input type="checkbox" data-index="${index}">
            <span>${escapeHtml(item.title)} <span class="pricing-muted">· ${escapeHtml(item.display_price)}</span></span>
            ${item.pricing_model === 'per_unit' ? `<input type="number" min="1" max="100" value="1" class="bk-qty" data-qty="${index}" aria-label="Quantity">` : ''}
          </label>`).join('')
      : '<p class="pricing-muted">No approved items yet. Approve prices in Pricing Review first.</p>';
  }

  el('bk-quote-btn').addEventListener('click', async () => {
    const items = [...el('bk-quote-items').querySelectorAll('input[type=checkbox]:checked')].map((box) => {
      const item = catalog[Number(box.dataset.index)];
      const qtyInput = el('bk-quote-items').querySelector(`[data-qty="${box.dataset.index}"]`);
      return qtyInput ? { code: item.code, quantity: Number(qtyInput.value) || 1 } : { code: item.code };
    });
    if (items.length === 0) {
      statusEl.textContent = 'Select at least one item.';
      return;
    }
    const conversationId = Number(el('bk-conversation').value) || undefined;
    const quote = await run('Calculating quote', () =>
      workerFetch('/admin/quotes', { method: 'POST', body: JSON.stringify({ items, conversation_id: conversationId }) }));
    if (!quote) return;
    lastQuote = quote;
    el('bk-quote-result').innerHTML = `
      <p><strong>${escapeHtml(quote.quote_number)}</strong> · ${escapeHtml(quote.status.replace('_', ' '))}</p>
      <ul class="bk-lines">${quote.items.map((line) => `
        <li>${escapeHtml(line.title)}${line.quantity > 1 ? ` × ${line.quantity}` : ''}:
          ${line.requires_human_pricing ? `<em>${escapeHtml(line.note || 'needs human pricing')}</em>` : escapeHtml(money(line.line_total_minor))}</li>`).join('')}
      </ul>
      <p>Total <strong>${escapeHtml(money(quote.total_minor))}</strong> · deposit ${quote.deposit_basis_points ? `${quote.deposit_basis_points / 100}%` : ''} <strong>${escapeHtml(money(quote.deposit_minor))}</strong> · valid until ${escapeHtml(new Date(quote.valid_until).toLocaleDateString())}</p>`;
    el('bk-hold-form').classList.toggle('hidden', quote.status !== 'draft' || !can('bookings.hold'));
  });

  el('bk-hold-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!lastQuote) return;
    const eventDate = el('bk-event-date').value;
    if (!eventDate) return;
    const customerName = el('bk-customer').value.trim();
    const venue = el('bk-venue').value.trim();
    run('Holding date', async () => {
      const booking = await workerFetch('/admin/bookings', {
        method: 'POST',
        body: JSON.stringify({ quote_id: lastQuote.quote_id, event_date: eventDate, customer_name: customerName || undefined })
      });
      // Events need the name and venue for their service agreement.
      if (customerName && venue) {
        await workerFetch(`/admin/bookings/${booking.id}/contract-details`, {
          method: 'POST', body: JSON.stringify({ customer_name: customerName, event_location: venue })
        });
      }
      return booking;
    }).then((booking) => {
      if (booking) {
        statusEl.textContent = `Date held. Payment reference ${booking.payment_reference}.`;
        el('bk-hold-form').reset();
        el('bk-hold-form').classList.add('hidden');
        el('bk-quote-result').innerHTML = '';
        lastQuote = null;
      }
    });
  });

  // ── Bookings list ───────────────────────────────────────────
  async function loadBookings() {
    let query = window.supabaseClient
      .from('bookings')
      .select('id, event_date, status, customer_name, event_location, contract_required, total_minor, deposit_due_minor, payment_reference, confirmation_code, hold_expires_at, conversation_id, contracts(id, status, contract_number, accepted_at, reminded_at, created_at)')
      .order('event_date', { ascending: true })
      .limit(100);
    const filter = el('bk-filter').value;
    if (filter !== 'all') query = query.in('status', filter.split(','));
    const { data, error } = await query;
    if (error) {
      el('bk-list').innerHTML = `<p class="status-text">${escapeHtml(error.message)}</p>`;
      return;
    }
    el('bk-list').innerHTML = (data || []).map((b) => {
      const open = b.status === 'held' || b.status === 'payment_submitted';
      const current = (b.contracts || []).filter((c) => c.status !== 'superseded').sort((x, y) => y.id - x.id)[0];
      const agreement = !b.contract_required ? ''
        : current && current.status === 'accepted'
          ? `<p class="bk-contract bk-contract--ok">📝 Agreement ${escapeHtml(current.contract_number)} accepted ${escapeHtml(new Date(current.accepted_at).toLocaleString())}</p>`
          : current
            ? `<p class="bk-contract">📝 Agreement ${escapeHtml(current.contract_number)} sent ${escapeHtml(new Date(current.created_at).toLocaleString())} · <strong>waiting for "I agree"</strong>${current.reminded_at ? ' · reminder sent' : ''}</p>`
            : `<p class="bk-contract">📝 Agreement needed · <strong>not sent yet</strong>${b.event_location ? '' : ' · venue missing'}</p>`;
      const agreementActions = !b.contract_required ? '' : [
        open && can('bookings.hold') ? `<button class="button" data-details="${b.id}" data-name="${escapeHtml(b.customer_name || '')}" data-venue="${escapeHtml(b.event_location || '')}">Agreement details</button>` : '',
        open && b.conversation_id && can('conversations.reply') && (!current || current.status !== 'accepted')
          ? `<button class="button" data-contract="${b.id}" data-resend="${current ? 1 : 0}">${current ? 'Resend agreement' : 'Send agreement'}</button>` : '',
        current || open ? `<button class="button" data-pdf="${b.id}">View agreement</button>` : ''
      ].join('');
      return `
      <article class="pricing-row">
        <div class="pricing-main">
          <h3>${escapeHtml(new Date(`${b.event_date}T00:00:00`).toDateString())} · ${escapeHtml(b.customer_name || 'Customer')}</h3>
          <p class="pricing-meta">
            <span class="pricing-badge pricing-badge--${b.status === 'confirmed' ? 'approved' : b.status === 'cancelled' || b.status === 'expired' ? 'rejected' : 'pending'}">${escapeHtml(b.status.replace('_', ' '))}</span>
            · total ${escapeHtml(money(b.total_minor))} · deposit ${escapeHtml(money(b.deposit_due_minor))}
            · ref <code>${escapeHtml(b.payment_reference)}</code>
            ${b.confirmation_code ? ` · code <strong>${escapeHtml(b.confirmation_code)}</strong>` : ''}
            ${b.status === 'held' ? ` · hold expires ${escapeHtml(new Date(b.hold_expires_at).toLocaleString())}` : ''}
            ${b.conversation_id ? ' · 💬 chat linked' : ' · no WhatsApp chat linked'}
            ${b.event_location ? ` · 📍 ${escapeHtml(b.event_location)}` : ''}
          </p>
          ${agreement}
        </div>
        <div class="pricing-actions bk-actions">
          ${open && b.conversation_id && can('conversations.reply') ? `<button class="button primary" data-instructions="${b.id}">Send payment details</button>` : ''}
          ${open && can('payments.submit') ? `<button class="button" data-pay="${b.id}" data-deposit="${b.deposit_due_minor}">Record payment</button>` : ''}
          ${agreementActions}
          ${['held', 'payment_submitted', 'confirmed'].includes(b.status) && can('bookings.cancel') ? `<button class="button danger" data-cancel="${b.id}">Cancel</button>` : ''}
        </div>
      </article>`;
    }).join('') || '<p class="pricing-muted">No bookings.</p>';
  }

  el('bk-list').addEventListener('click', (event) => {
    const details = event.target.closest('[data-details]');
    if (details) {
      const name = prompt('Customer\'s full name (as it should appear on the agreement):', details.dataset.name);
      if (name === null) return;
      const venue = prompt('Event venue / address:', details.dataset.venue);
      if (venue === null) return;
      run('Saving agreement details', () => workerFetch(`/admin/bookings/${details.dataset.details}/contract-details`, {
        method: 'POST', body: JSON.stringify({ customer_name: name.trim(), event_location: venue.trim() })
      }));
      return;
    }
    const contract = event.target.closest('[data-contract]');
    if (contract) {
      const resend = contract.dataset.resend === '1';
      if (!confirm(resend
        ? 'Send a fresh copy of the service agreement? It replaces the one not yet accepted.'
        : 'Send the service agreement (PDF) to this customer on WhatsApp? They accept it by tapping "I agree".')) return;
      contract.disabled = true;
      run('Sending agreement', () => workerFetch(`/admin/bookings/${contract.dataset.contract}/contract`, { method: 'POST', body: '{}' }))
        .then((result) => {
          if (result) statusEl.textContent = `Agreement ${result.contractNumber} sent on WhatsApp.`;
        });
      return;
    }
    const pdf = event.target.closest('[data-pdf]');
    if (pdf) {
      openWorkerPdf(`/admin/bookings/${pdf.dataset.pdf}/contract.pdf`).catch((err) => { statusEl.textContent = `Could not open the agreement: ${explain(err)}`; });
      return;
    }
    const instructions = event.target.closest('[data-instructions]');
    if (instructions) {
      if (!confirm('Send the deposit amount, payment reference and MoMo/bank details to this customer on WhatsApp? This takes the chat out of AI mode.')) return;
      instructions.disabled = true;
      run('Sending payment details', () => workerFetch(`/admin/bookings/${instructions.dataset.instructions}/payment-instructions`, {
        method: 'POST', body: JSON.stringify({ client_message_id: crypto.randomUUID() })
      })).then((result) => {
        if (!result) return;
        const contract = result.contract || {};
        statusEl.textContent = 'Payment details sent on WhatsApp.' + (
          contract.sendStatus === 'sent' ? ` Service agreement ${contract.contractNumber} sent too.`
            : contract.sendStatus === 'not_sent' || contract.sendStatus === 'failed' ? ` The service agreement was NOT sent: ${explain({ message: contract.error || 'unknown error' })}`
              : '');
      });
      return;
    }
    const pay = event.target.closest('[data-pay]');
    const cancel = event.target.closest('[data-cancel]');
    if (pay) {
      const deposit = money(pay.dataset.deposit);
      const amountText = prompt(`Amount the customer reports paying, in GHS (deposit due ${deposit}):`);
      if (amountText === null) return;
      const amountMinor = parseCedis(amountText);
      if (amountMinor === null) {
        statusEl.textContent = 'Enter an amount like 4550 or 4,550.00.';
        return;
      }
      const reference = prompt('MoMo / bank transaction reference:');
      if (!reference) return;
      run('Recording payment', () => workerFetch(`/admin/bookings/${pay.dataset.pay}/payments`, {
        method: 'POST',
        body: JSON.stringify({ amount_minor: amountMinor, transaction_reference: reference.trim() })
      }));
    } else if (cancel) {
      const reason = prompt('Reason for cancelling this booking:');
      if (!reason || !reason.trim()) return;
      run('Cancelling booking', () => workerFetch(`/admin/bookings/${cancel.dataset.cancel}/cancel`, {
        method: 'POST', body: JSON.stringify({ reason: reason.trim() })
      }));
    }
  });

  // ── Payment review queue (admin / finance) ──────────────────
  async function loadPayments() {
    const panel = el('bk-payments');
    if (!can('payments.read')) {
      panel.closest('.tool-card').classList.add('hidden');
      return;
    }
    const { data } = await window.supabaseClient
      .from('payment_submissions')
      .select('id, booking_id, amount_minor, transaction_reference, submitted_at, submitted_by, bookings(event_date, customer_name, deposit_due_minor, payment_reference)')
      .eq('status', 'pending_review')
      .order('submitted_at', { ascending: true });
    panel.innerHTML = (data || []).map((s) => `
      <article class="pricing-row">
        <div class="pricing-main">
          <h3>${escapeHtml(money(s.amount_minor))} · ref <code>${escapeHtml(s.transaction_reference)}</code></h3>
          <p class="pricing-meta">
            ${escapeHtml(s.bookings ? `${s.bookings.customer_name || 'Customer'} · ${s.bookings.event_date} · deposit due ${money(s.bookings.deposit_due_minor)} · booking ref ${s.bookings.payment_reference}` : '')}
            · submitted ${escapeHtml(new Date(s.submitted_at).toLocaleString())}
          </p>
          <p class="pricing-muted">${s.submitted_by ? 'Recorded by staff.' : '📱 Reported by the customer on WhatsApp — the amount shown is the deposit they were asked to pay.'} Check the MoMo / bank statement before approving.</p>
        </div>
        <div class="pricing-actions">
          ${can('payments.verify') ? `<button class="button primary" data-review="approved" data-sub="${s.id}">Approve</button>
          <button class="button danger" data-review="rejected" data-sub="${s.id}">Reject</button>` : ''}
        </div>
      </article>`).join('') || '<p class="pricing-muted">No payments awaiting review.</p>';
  }

  el('bk-payments').addEventListener('click', (event) => {
    const button = event.target.closest('[data-review]');
    if (!button) return;
    const decision = button.dataset.review;
    let reason = null;
    if (decision === 'approved') {
      if (!confirm('Approve this payment? This CONFIRMS the booking and issues a confirmation code.')) return;
    } else {
      reason = prompt('Reason for rejecting this payment (shared with staff):');
      if (!reason || !reason.trim()) return;
    }
    run(decision === 'approved' ? 'Approving payment' : 'Rejecting payment', () =>
      workerFetch(`/admin/payments/${button.dataset.sub}/review`, {
        method: 'POST', body: JSON.stringify({ decision, reason })
      })).then((result) => {
      if (result && result.confirmation_code) {
        const message = result.confirmation_message || {};
        statusEl.textContent = `Booking confirmed. Code ${result.confirmation_code}. ` + (message.status === 'sent'
          ? 'Confirmation sent to the customer on WhatsApp.'
          : `Confirmation NOT sent (${message.reason || 'unknown'}) — tell the customer manually.`);
      }
    });
  });

  async function loadAll() {
    await Promise.all([loadBookings(), loadPayments()]);
  }

  async function open() {
    statusEl.textContent = 'Loading…';
    try {
      me = await staffProfile();
    } catch (err) {
      statusEl.textContent = `Could not verify your role: ${err.message}`;
      return;
    }
    if (!can('bookings.read')) {
      statusEl.textContent = 'Your role cannot view bookings.';
      return;
    }
    el('bk-quote-card').classList.toggle('hidden', !can('quotes.create'));
    statusEl.textContent = '';
    await Promise.all([loadCatalog(), loadConversations(), loadAll()]);
  }

  el('bk-filter').addEventListener('change', loadBookings);
  el('bk-refresh').addEventListener('click', loadAll);
  tabButton.addEventListener('click', open);
});
