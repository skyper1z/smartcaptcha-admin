// Shared helpers for tabs that call the role-checked WhatsApp AI Worker API.
// Every request carries the signed-in user's Supabase access token; the
// Worker verifies it and checks the staff permission server-side.
(function () {
  const escapeHtml = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));

  async function workerFetch(path, init = {}) {
    const env = window.SMARTCAP_ENV;
    if (!env || !env.workerUrl) throw new Error('Worker API not configured');
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session) throw new Error('Not signed in');
    const response = await fetch(`${env.workerUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        authorization: `Bearer ${session.access_token}`,
        'content-type': 'application/json'
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  // Opens a PDF the Worker generates (it needs the sign-in token, so it is
  // fetched here and shown from memory). The tab opens first so phones do
  // not block it as a pop-up.
  async function openWorkerPdf(path) {
    const tab = window.open('', '_blank');
    try {
      const env = window.SMARTCAP_ENV;
      const { data: { session } } = await window.supabaseClient.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const response = await fetch(`${env.workerUrl}${path}`, { headers: { authorization: `Bearer ${session.access_token}` } });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      const url = URL.createObjectURL(await response.blob());
      if (tab) tab.location.href = url;
      else window.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
      if (tab) tab.close();
      throw error;
    }
  }

  // "4550", "4,550" or "4550.50" (cedis) → integer pesewas; null if invalid.
  function parseCedis(text) {
    const value = String(text).trim();
    const match = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(value);
    if (!match) return null;
    const minor = BigInt(match[1].replace(/,/g, '')) * 100n + BigInt((match[2] || '0').padEnd(2, '0'));
    return minor > 0n && minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
  }

  // One /admin/me lookup per page load, shared by all tabs.
  let mePromise = null;
  function staffProfile() {
    if (!mePromise) {
      mePromise = workerFetch('/admin/me').catch((error) => {
        mePromise = null;
        throw error;
      });
    }
    return mePromise;
  }

  // A different user may sign in without a page reload.
  window.supabaseClient.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') mePromise = null;
  });

  window.SmartcapWorker = Object.freeze({ escapeHtml, workerFetch, staffProfile, parseCedis, openWorkerPdf });
})();
