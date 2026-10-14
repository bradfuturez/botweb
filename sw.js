/* BotWeb service worker: the app opens offline after the first visit; chat traffic (POST to the relay) is never cached. */
const VERSION = 'botweb-1.4.0';
const SHELL = ['./', './index.html', './styles.css?v=1.4.0', './app.js?v=1.4.0', './manifest.webmanifest', './vendor/blob-client-2.8.1.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const timeout = ms => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await Promise.race([fetch(req, { cache: 'no-cache' }), timeout(4000)]);
        if (res && res.ok) { const c = await caches.open(VERSION); c.put('./index.html', res.clone()); }
        return res;
      } catch (_) { return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error(); }
    })());
    return;
  }
  if (url.origin === self.location.origin) {
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(req); if (hit) return hit;
      const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res;
    }));
  }
});

/* Web Push: a bot @mentioned Brad. Payload {title, body, id, url, tag} comes from the relay. */
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data && e.data.text() }; }
  const url = d.url || './';
  e.waitUntil(self.registration.showNotification(d.title || 'BotWeb', {
    body: d.body || 'You were mentioned', tag: d.tag || 'botweb-mention', renotify: true,
    icon: './icons/icon-192.png', badge: './icons/icon-192.png', data: { url, id: d.id || null },
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const { url = './', id = null } = e.notification.data || {};
  const target = new URL(url, self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = wins.find(c => c.url.startsWith(self.registration.scope));
    if (w) { await w.focus(); w.postMessage({ type: 'jump', id }); return; }
    await self.clients.openWindow(target);
  })());
});
