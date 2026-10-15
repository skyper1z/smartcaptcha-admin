// App shell: tab memory and deep links (?tab=inbox&c=12), the service worker,
// "add to home screen", and this device's staff push notifications. Push
// subscriptions are registered through the role-checked Worker API.
document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);
  const main = document.querySelector('.admin-main');
  const tabs = () => [...document.querySelectorAll('.admin-tabs .tab')];
  const params = new URLSearchParams(location.search);
  const TAB_KEY = 'sc-admin-tab';
  const BANNER_KEY = 'sc-install-banner-dismissed';
  const store = {
    get(key) { try { return localStorage.getItem(key); } catch (_) { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch (_) { /* private mode */ } }
  };

  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const signedIn = () => !$('dashboard-container').classList.contains('hidden');

  const toastEl = document.createElement('div');
  toastEl.className = 'wa-toast';
  toastEl.setAttribute('role', 'status');
  document.body.appendChild(toastEl);
  let toastTimer = null;
  function toast(message, kind = 'info') {
    toastEl.textContent = message;
    toastEl.dataset.kind = kind;
    toastEl.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), kind === 'error' ? 6000 : 3000);
  }

  // ── Tabs ──
  function activate(tab) {
    // admin.js wires the same switch after an await; doing it here as well
    // keeps deep links working whichever runs first.
    document.querySelectorAll('.admin-tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.admin-section').forEach((s) => {
      const on = s.id === `${tab.dataset.target}-tab`;
      s.classList.toggle('active', on);
      s.classList.toggle('hidden', !on);
    });
    main.dataset.tab = tab.dataset.target;
  }
  tabs().forEach((tab) => tab.addEventListener('click', () => {
    activate(tab);
    store.set(TAB_KEY, tab.dataset.target);
    if (tab.dataset.target !== 'inbox') history.replaceState(null, '', `?tab=${tab.dataset.target}`);
    else if (!/[?&]c=/.test(location.search)) history.replaceState(history.state, '', '?tab=inbox');
    tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }));

  function openTarget(url) {
    const target = new URL(url, location.href).searchParams;
    const name = target.get('tab') || 'inbox';
    const tab = tabs().find((t) => t.dataset.target === name);
    if (!tab) return;
    tab.click();
    const chat = target.get('c');
    if (name === 'inbox' && chat && window.SmartcapInbox) window.SmartcapInbox.openChat(chat);
  }

  let initialised = false;
  function selectInitialTab() {
    if (initialised) return;
    initialised = true;
    const wanted = params.get('tab') || store.get(TAB_KEY) || 'inbox';
    const available = tabs();
    const tab = available.find((t) => t.dataset.target === wanted)
      || available.find((t) => t.dataset.target === 'inbox')
      || available[0];
    if (!tab) return;
    openTarget(`?tab=${tab.dataset.target}${tab.dataset.target === 'inbox' && params.get('c') ? `&c=${params.get('c')}` : ''}`);
  }

  // ── Service worker ──
  let registration = null;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' })
      .then((reg) => { registration = reg; })
      .catch((err) => console.warn('Service worker not registered', err));
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'open' && event.data.url) openTarget(event.data.url);
      // Phones often show no banner (and play no sound) while the app is open,
      // so the open app plays its own chime.
      if (event.data && event.data.type === 'push' && document.visibilityState === 'visible') chime();
    });
  }

  // ── Alert chime ──
  // Browsers only allow sound after the user has touched the page, so the
  // audio context is created (and resumed) on the first tap.
  let audio = null;
  const unlockAudio = () => {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audio) audio = new Ctx();
    if (audio.state === 'suspended') audio.resume().catch(() => undefined);
  };
  ['pointerdown', 'keydown'].forEach((type) => document.addEventListener(type, unlockAudio, { passive: true }));
  function chime() {
    if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
    if (!audio || audio.state !== 'running') return;
    const start = audio.currentTime;
    [[880, 0], [1320, 0.16]].forEach(([freq, offset]) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.35, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.35);
      osc.connect(gain).connect(audio.destination);
      osc.start(start + offset);
      osc.stop(start + offset + 0.4);
    });
  }
  async function swRegistration() {
    if (registration) return registration;
    return navigator.serviceWorker.ready;
  }

  // ── Install ──
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    updateBanner();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    updateBanner();
    toast('Installed. Open SC Admin from your home screen.');
  });

  async function runInstallPrompt() {
    if (!installPrompt) return false;
    installPrompt.prompt();
    const choice = await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    updateBanner();
    return Boolean(choice && choice.outcome === 'accepted');
  }

  function updateBanner() {
    const banner = $('install-banner');
    const show = signedIn() && !isStandalone() && store.get(BANNER_KEY) !== '1'
      && window.matchMedia('(pointer: coarse)').matches && (installPrompt || isIOS);
    banner.classList.toggle('hidden', !show);
  }
  $('install-banner-btn').addEventListener('click', async () => {
    if (!(await runInstallPrompt())) openSheet();
  });
  $('install-banner-close').addEventListener('click', () => {
    store.set(BANNER_KEY, '1');
    updateBanner();
  });

  // ── Push notifications ──
  function keyBytes(base64url) {
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  }
  function sameKey(buffer, bytes) {
    if (!buffer) return false;
    const a = new Uint8Array(buffer);
    return a.length === bytes.length && a.every((v, i) => v === bytes[i]);
  }

  async function currentSubscription() {
    if (!pushSupported()) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
  }

  async function subscribe() {
    const { workerFetch } = window.SmartcapWorker;
    const config = await workerFetch('/admin/push/config');
    if (!config.enabled || !config.public_key) throw new Error('Notifications are not switched on for the server yet');
    const reg = await swRegistration();
    const key = keyBytes(config.public_key);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options.applicationServerKey, key)) {
      await sub.unsubscribe();
      sub = null;
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await workerFetch('/admin/push/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
    return sub;
  }

  async function enablePush() {
    // Safari only allows the permission prompt directly from a tap.
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      toast(permission === 'denied' ? 'Notifications are blocked in your settings.' : 'Notifications were not turned on.', 'error');
      return;
    }
    await subscribe();
    toast('Notifications are on for this device 🔔');
  }

  async function disablePush() {
    const sub = await currentSubscription();
    if (!sub) return;
    try {
      await window.SmartcapWorker.workerFetch('/admin/push/unsubscribe', {
        method: 'POST',
        body: JSON.stringify({ endpoint: sub.endpoint })
      });
    } finally {
      await sub.unsubscribe().catch(() => undefined);
    }
  }

  // Re-links this device to whoever is signed in (silent; no prompt).
  let synced = false;
  async function syncPush() {
    if (synced || !pushSupported() || Notification.permission !== 'granted') return;
    synced = true;
    try {
      if (await currentSubscription()) await subscribe();
    } catch (err) {
      console.warn('Push sync failed', err);
    }
    updateDot();
  }

  async function updateDot() {
    const sub = await currentSubscription().catch(() => null);
    $('app-btn-dot').classList.toggle('hidden', Boolean(sub) || !signedIn());
  }

  // ── Sheet ──
  const sheet = $('app-sheet');
  const sheetBody = $('app-sheet-body');
  const SHARE_ICON = '<svg class="inline-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';

  async function renderSheet() {
    const sub = await currentSubscription().catch(() => null);
    const permission = 'Notification' in window ? Notification.permission : 'unsupported';

    let install;
    if (isStandalone()) {
      install = '<p class="sheet-ok">✓ Installed — you are using the app.</p>';
    } else if (installPrompt) {
      install = `<p>Install SC Admin like a normal app: its own icon, full screen, and chat alerts.</p>
        <button type="button" class="button primary sheet-cta" data-action="install">Install app</button>`;
    } else if (isIOS) {
      install = `<ol class="sheet-steps">
          <li>Open this page in <strong>Safari</strong>.</li>
          <li>Tap the <strong>Share</strong> button ${SHARE_ICON} in the toolbar.</li>
          <li>Scroll and tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li>
          <li>Open <strong>SC Admin</strong> from your Home Screen and come back here to turn on notifications.</li>
        </ol>`;
    } else {
      install = '<p>Open your browser menu <strong>⋮</strong> and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</p>';
    }

    let notify;
    if (!pushSupported()) {
      notify = isIOS && !isStandalone()
        ? '<p>On iPhone, notifications work once the app is on your Home Screen (iOS 16.4 or later). Install it first using the steps above.</p>'
        : '<p>This browser cannot show notifications. Try Chrome on Android or Safari on iPhone.</p>';
    } else if (permission === 'denied') {
      notify = `<p class="sheet-warn">Notifications are blocked for this app.</p>
        <p>${isIOS ? 'Open iPhone <strong>Settings → Notifications → SC Admin</strong> and allow notifications.' : 'Open the site settings (🔒 in the address bar or app info) and allow notifications.'} Then come back here.</p>`;
    } else if (sub && permission === 'granted') {
      notify = `<p class="sheet-ok">✓ On for this device</p>
        <div class="sheet-actions">
          <button type="button" class="button" data-action="test">Send a test</button>
          <button type="button" class="button" data-action="disable">Turn off</button>
        </div>`;
    } else {
      notify = '<button type="button" class="button primary sheet-cta" data-action="enable">Turn on notifications</button>';
    }

    sheetBody.innerHTML = `
      <section class="sheet-section">
        <h4>📲 Home screen app</h4>
        ${install}
      </section>
      <section class="sheet-section">
        <h4>🔔 Notifications</h4>
        ${notify}
        <ul class="sheet-list">
          <li>A customer writes in a chat a person is handling</li>
          <li>The AI needs a person, or a reply waits for approval</li>
          <li>A customer reports a payment (admin and finance)</li>
        </ul>
      </section>`;
  }

  function openSheet() {
    sheet.classList.remove('hidden');
    requestAnimationFrame(() => sheet.classList.add('is-open'));
    renderSheet();
  }
  function closeSheet() {
    sheet.classList.remove('is-open');
    setTimeout(() => sheet.classList.add('hidden'), 220);
  }
  $('app-btn').addEventListener('click', openSheet);
  sheet.addEventListener('click', async (event) => {
    if (event.target.closest('[data-close]')) {
      closeSheet();
      return;
    }
    const button = event.target.closest('[data-action]');
    if (!button) return;
    button.disabled = true;
    try {
      switch (button.dataset.action) {
        case 'install':
          await runInstallPrompt();
          break;
        case 'enable':
          await enablePush();
          break;
        case 'disable':
          await disablePush();
          toast('Notifications are off for this device');
          break;
        case 'test': {
          const result = await window.SmartcapWorker.workerFetch('/admin/push/test', { method: 'POST', body: '{}' });
          toast(result.sent ? 'Test sent. It should arrive in a few seconds.' : 'No device received it. Turn notifications off and on again.', result.sent ? 'info' : 'error');
          break;
        }
      }
    } catch (err) {
      toast(`Could not finish: ${err.message}`, 'error');
    } finally {
      button.disabled = false;
      renderSheet();
      updateDot();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !sheet.classList.contains('hidden')) closeSheet();
  });

  // ── Keep the full-screen chat above the iPhone keyboard ──
  if (window.visualViewport) {
    const fit = () => {
      document.documentElement.style.setProperty('--vvh', `${window.visualViewport.height}px`);
      document.documentElement.style.setProperty('--vv-top', `${window.visualViewport.offsetTop}px`);
    };
    window.visualViewport.addEventListener('resize', fit);
    window.visualViewport.addEventListener('scroll', fit);
    fit();
  }

  // ── Session ──
  window.supabaseClient.auth.onAuthStateChange((event, session) => {
    if (session && (event === 'INITIAL_SESSION' || event === 'SIGNED_IN')) {
      setTimeout(() => {
        selectInitialTab();
        syncPush();
        updateDot();
        updateBanner();
      }, 0);
    } else if (!session) {
      initialised = false;
      synced = false;
      updateBanner();
    }
  });

  window.SmartcapApp = Object.freeze({
    toast,
    openSheet,
    // Called by the logout button before signing out (bounded wait).
    beforeLogout: () => Promise.race([
      disablePush().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 3000))
    ])
  });
});
