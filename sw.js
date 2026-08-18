/* 10K 教練 — Service Worker
   策略：app shell 走 cache-first（離線可開），plan.json 走 network-first（課表可更新）
   訓練紀錄不經過這裡，一律存在 localStorage。 */
const VERSION = 'v7';
const SHELL = 'shell-' + VERSION;
const ASSETS = [
  './', './index.html', './style.css', './app.js', './coach.js',
  './manifest.json', './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // 課表：先連網拿最新，失敗才用快取
  if (url.pathname.endsWith('plan.json')) {
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.ok) {            // 只快取成功的回應，否則離線時會拿到快取的 404
          const copy = res.clone();
          caches.open(SHELL).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }))
    );
    return;
  }

  // 其餘：先快取，背景更新
  e.respondWith(
    // ignoreSearch：index.html 請求的是 style.css?v=N，預快取存的是 style.css，
    // 預設 ignoreSearch:false 會永遠 miss，等於預快取白存。
    caches.match(req, { ignoreSearch: true }).then(hit => {
      const net = fetch(req).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(SHELL).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
