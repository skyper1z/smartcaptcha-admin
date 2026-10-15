// Service worker for the installed admin app: staff push notifications and
// an offline fallback for the app shell. Data requests (Supabase, Worker API)
// are cross-origin and never cached.
const CACHE = 'sc-admin-v1';
const SHELL = [
  '/',
  '/style.css',
  '/admin.css',
  '/app.css',
  '/assets/icons/icon-192.png',
  '/assets/icons/badge-96.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => undefined));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

// Network first, so a deploy is picked up immediately; cache only as fallback.
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request.mode === 'navigate' ? '/' : request, copy)).catch(() => undefined);
      }
      return response;
    } catch (error) {
      const cached = await caches.match(request.mode === 'navigate' ? '/' : request, { ignoreSearch: request.mode === 'navigate' });
      if (cached) return cached;
      throw error;
    }
  })());
});

async function updateBadge() {
  if (!self.navigator.setAppBadge) return;
  const open = await self.registration.getNotifications();
  try {
    if (open.length) await self.navigator.setAppBadge(open.length);
    else await self.navigator.clearAppBadge();
  } catch (_) { /* badging unsupported */ }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Smart Captcha Admin';
  event.waitUntil((async () => {
    await self.registration.showNotification(title, {
      body: data.body || 'Something needs your attention.',
      tag: data.tag || 'sc-admin',
      renotify: true,
      // Play the phone's notification sound (and vibrate on Android).
      silent: false,
      vibrate: [200, 100, 200],
      icon: '/assets/icons/icon-192.png',
      badge: '/assets/icons/badge-96.png',
      data: { url: data.url || '/?tab=inbox' }
    });
    await updateBadge();
    // Open windows refresh immediately instead of waiting for their next poll.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    windows.forEach((client) => client.postMessage({ type: 'push', url: data.url || null }));
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/?tab=inbox', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: 'open', url: target });
    } else {
      await self.clients.openWindow(target);
    }
    await updateBadge();
  })());
});
