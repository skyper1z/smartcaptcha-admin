// Agreement terms card (Bookings tab): the business details and policies
// printed in every service agreement. Admins edit them, review a sample PDF
// and approve; no agreement can be sent until the current version is
// approved. Writes go through the role-checked Worker API.
document.addEventListener('DOMContentLoaded', () => {
  const env = window.SMARTCAP_ENV;
  const card = document.getElementById('ct-card');
  const tabButton = document.getElementById('bookings-tab-btn');
  if (!env || !card || !tabButton || !env.workerUrl) return;

  const { escapeHtml, workerFetch, staffProfile, openWorkerPdf } = window.SmartcapWorker;
  const form = document.getElementById('ct-form');
  const statusEl = document.getElementById('ct-status');
  const summaryEl = document.getElementById('ct-summary');

  const FIELDS = [
    ['legal_name', 'Registered business name', 1],
    ['trading_name', 'Trading name', 1],
    ['registration_number', 'Registration number (optional)', 1],
    ['address', 'Address', 1],
    ['phone', 'Phone', 1],
    ['whatsapp', 'WhatsApp', 1],
    ['notice_email', 'Email for notices (optional)', 1],
    ['balance_due', 'When the balance is due', 2],
    ['cancellation', 'Cancellation by the client', 3],
    ['rescheduling', 'Rescheduling', 3],
    ['studio_cancellation', 'If the studio cannot provide the service', 2],
    ['archive_period', 'How long files are kept (e.g. 90 days after delivery)', 1],
    ['copyright', 'Copyright and client use', 3],
    ['portfolio_use', 'Portfolio and social media use', 2],
    ['complaints_period', 'Time to report a problem (e.g. 7 days)', 1],
    ['liability', 'Limit of liability', 2],
    ['disputes', 'Disputes', 2]
  ];
  const ERRORS = {
    contract_settings_incomplete: 'Fill in every field that is not marked optional.',
    contract_settings_changed: 'The terms changed since you loaded them. Refresh and review again.'
  };

  let settings = null;
  let loaded = false;

  function render() {
    const approved = settings.approved_version === settings.version;
    summaryEl.innerHTML = approved
      ? `<span class="pricing-badge pricing-badge--approved">Approved</span> version ${settings.version}, approved ${escapeHtml(new Date(settings.approved_at).toLocaleDateString())}. Agreements can be sent.`
      : `<span class="pricing-badge pricing-badge--suggested">Not approved</span> version ${settings.version}. <strong>No agreement can be sent until an admin approves these terms.</strong>`;
    form.innerHTML = FIELDS.map(([key, label, rows]) => `
      <label class="ct-field">
        <span>${escapeHtml(label)}</span>
        ${rows > 1
          ? `<textarea name="${key}" rows="${rows}" maxlength="1000">${escapeHtml(settings.terms[key] || '')}</textarea>`
          : `<input name="${key}" maxlength="1000" value="${escapeHtml(settings.terms[key] || '')}">`}
      </label>`).join('') + `
      <div class="kb-form-actions">
        <button class="button" value="save">Save changes</button>
        <button type="button" class="button" data-sample>View sample agreement (PDF)</button>
        ${approved ? '' : '<button type="button" class="button primary" data-approve>Approve these terms</button>'}
      </div>`;
  }

  async function load() {
    try {
      const me = await staffProfile();
      if (!me.permissions.includes('contracts.manage')) {
        card.classList.add('hidden');
        return;
      }
    } catch {
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
    const { data, error } = await window.supabaseClient
      .from('contract_settings')
      .select('terms, version, approved_version, approved_at')
      .maybeSingle();
    if (error || !data) {
      statusEl.textContent = `Could not load the agreement terms: ${error ? error.message : 'not found'}`;
      return;
    }
    settings = data;
    loaded = true;
    render();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => value.trim() !== (settings.terms[key] || '')).map(([k, v]) => [k, v.trim()]));
    if (Object.keys(changed).length === 0) {
      statusEl.textContent = 'Nothing changed.';
      return;
    }
    try {
      await workerFetch('/admin/contracts/settings', { method: 'POST', body: JSON.stringify({ terms: changed }) });
      statusEl.textContent = 'Saved. Review the sample, then approve the new version.';
      await load();
    } catch (err) {
      statusEl.textContent = `Not saved: ${ERRORS[err.message] || err.message}`;
    }
  });

  form.addEventListener('click', async (event) => {
    if (event.target.closest('[data-sample]')) {
      openWorkerPdf('/admin/contracts/sample.pdf').catch((err) => { statusEl.textContent = `Could not open the sample: ${err.message}`; });
      return;
    }
    if (!event.target.closest('[data-approve]')) return;
    if (!confirm('Approve these terms? Every new service agreement will use them. Have them checked by a lawyer if you can.')) return;
    try {
      await workerFetch('/admin/contracts/settings/approve', { method: 'POST', body: JSON.stringify({ version: settings.version }) });
      statusEl.textContent = 'Approved. Agreements will now be sent with event bookings.';
      await load();
    } catch (err) {
      statusEl.textContent = `Not approved: ${ERRORS[err.message] || err.message}`;
    }
  });

  tabButton.addEventListener('click', () => { if (!loaded) load(); });
  document.getElementById('bk-refresh').addEventListener('click', load);
});
