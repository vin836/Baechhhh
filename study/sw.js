// 刷題本離線快取：有網路時先抓最新版（打開就是新題庫），沒網路或網路太慢才用快取（通勤離線也能用）。
const CACHE = 'study-quiz-v13';
const SHELL = ['./', './index.html', './style.css', './app.js', './banks.js', './ai.js', './manifest.webmanifest', './icon.svg'];
const NETWORK_TIMEOUT = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('study-quiz-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      // no-cache：每次都向伺服器確認是否有新版（沒變就很快回 304）
      const res = await Promise.race([fetch(req.url, { cache: 'no-cache' }), timeout(NETWORK_TIMEOUT)]);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      return (await cache.match(req, { ignoreSearch: true })) || Response.error();
    }
  })());
});
