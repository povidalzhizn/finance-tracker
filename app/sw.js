/* Офлайн-оболочка. При изменении списка файлов поднять VERSION. */
const VERSION = 'v1', SHELL = 'shell-' + VERSION, RUNTIME = 'runtime-' + VERSION;
const FILES = ['./', 'index.html', 'engine.js', 'store.js', 'manifest.webmanifest', 'vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== RUNTIME).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* файлы приложения: сразу копия из кэша, обновление — к следующему запуску */
async function fresh(req){
  const c = await caches.open(SHELL), hit = await c.match(req, { ignoreSearch: true });
  const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; });
  if (hit){ net.catch(() => {}); return hit; }
  return net;
}
/* шрифты не меняются: скачать один раз */
async function once(req){
  const c = await caches.open(RUNTIME), hit = await c.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok || r.type === 'opaque') c.put(req, r.clone());
  return r;
}
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com') e.respondWith(once(e.request));
  else if (u.origin === location.origin) e.respondWith(fresh(e.request));
});
