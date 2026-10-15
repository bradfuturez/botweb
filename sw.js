/* BotWeb service worker: the app opens offline after the first visit; chat traffic (POST to the relay) is never cached. */
const VERSION = 'botweb-1.5.0';
const SHELL = ['./', './index.html', './styles.css?v=1.5.0', './app.js?v=1.5.0', './manifest.webmanifest', './vendor/blob-client-2.8.1.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== MEDIA).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const timeout = ms => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (BLOB_HOST.test(url.hostname)) { e.respondWith(media(e, req, url)); return; }
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

/* Media cache: thumbnails and opened photos/videos from the private Blob store, cache-first by blob pathname (the signed
   query string changes, the file never does). ~200 MB cap, least-recently-used entries evicted first. */
const MEDIA = 'bw-media-v1', CAP = 200 * 1048576, MAX_ITEM = 100 * 1048576, IDX = 'https://bw-media.invalid/__index';
const BLOB_HOST = /^[a-z0-9]+\.(private|public)\.blob\.vercel-storage\.com$/;
const keyOf = u => 'https://bw-media.invalid/' + u.hostname + u.pathname;
const inflight = new Set(); let idx = null;
async function loadIdx(c) { if (!idx) { const r = await c.match(IDX); idx = r ? await r.json().catch(() => ({})) : {}; } return idx; }
const saveIdx = c => c.put(IDX, new Response(JSON.stringify(idx), { headers: { 'content-type': 'application/json' } }));
async function evict(c) {
  const ix = await loadIdx(c); let total = Object.values(ix).reduce((n, v) => n + (v.s || 0), 0);
  for (const [k] of Object.entries(ix).sort((a, b) => a[1].t - b[1].t)) { if (total <= CAP) break; total -= ix[k].s || 0; delete ix[k]; await c.delete(k); }
}
async function ranged(res, range) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(range || ''); if (!m) return res;
  const b = await res.blob(), n = b.size; let s = m[1] === '' ? Math.max(0, n - +m[2]) : +m[1], en = m[1] !== '' && m[2] !== '' ? Math.min(+m[2], n - 1) : n - 1;
  if (s >= n) return new Response('', { status: 416, headers: { 'content-range': `bytes */${n}` } });
  return new Response(b.slice(s, en + 1), { status: 206, headers: { 'content-type': res.headers.get('content-type') || '', 'content-range': `bytes ${s}-${en}/${n}`, 'content-length': String(en - s + 1), 'accept-ranges': 'bytes' } });
}
async function media(e, req, url) {
  const c = await caches.open(MEDIA), key = keyOf(url), ix = await loadIdx(c), range = req.headers.get('range');
  const hit = await c.match(key);
  if (hit) { ix[key] = { s: (ix[key] && ix[key].s) || +hit.headers.get('content-length') || 0, t: Date.now() }; e.waitUntil(saveIdx(c)); return ranged(hit, range); }
  if (!url.search) return new Response('', { status: 504 }); // unsigned link and not cached: the app will sign and retry
  if (inflight.has(key)) return fetch(req); // a video seek while the full file is still downloading
  let res; try { res = await fetch(url.href, { mode: 'cors', credentials: 'omit' }); } catch (_) { return fetch(req); }
  const len = +res.headers.get('content-length') || 0;
  if (!res.ok || !res.body || len > MAX_ITEM) return res;
  inflight.add(key);
  const type = res.headers.get('content-type') || 'application/octet-stream', [a, b] = res.body.tee();
  e.waitUntil(new Response(b).blob().then(async bl => {
    if (len && bl.size !== len) return;
    await c.put(key, new Response(bl, { headers: { 'content-type': type, 'content-length': String(bl.size) } }));
    ix[key] = { s: bl.size, t: Date.now() }; await evict(c); await saveIdx(c);
  }).catch(() => {}).finally(() => inflight.delete(key)));
  const h = { 'content-type': type, 'accept-ranges': 'bytes' }; if (len) h['content-length'] = String(len);
  return new Response(a, { status: 200, headers: h });
}

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
