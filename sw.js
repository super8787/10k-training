/* 10K 教練 — Service Worker
   策略：app shell 走 cache-first（離線可開），plan.json 走 network-first（課表可更新）
   訓練紀錄不經過這裡，一律存在 localStorage。 */
const VERSION = 'v71';
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

  // 寫快取要掛在 e.waitUntil 上，否則 SW 可能在寫入完成前被瀏覽器終止，
  // 下次離線開啟就少了那個檔（回應照樣回得去，這裡只保住寫入）。
  const put = (r) => {
    const copy = r.clone();
    e.waitUntil(caches.open(SHELL).then(c => c.put(req, copy)));
  };
  const cached = () => caches.match(req, { ignoreSearch: true });
  // 離線又沒快取時，一定要回一個真的 Response——
  // respondWith(Promise→undefined) 會丟 TypeError，畫面變成瀏覽器的錯誤頁。
  const offline = (msg) => new Response(msg, {
    status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });

  // 課表：先連網拿最新，失敗才用快取
  if (url.pathname.endsWith('plan.json')) {
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.ok) { put(res); return res; }
        // 🔴 伺服器回 404／500 時不要直接穿透。
        //    fetch 沒有丟例外，所以 .catch 不會觸發，畫面會顯示「課表載不進來」
        //    ——即使快取裡有一份完好的課表。Pages 部署當下就可能短暫 404。
        return cached().then(hit => hit || res || offline('課表載不進來，也沒有離線副本'));
      }).catch(() => cached().then(hit => hit || offline('離線中，且沒有課表的離線副本')))
    );
    return;
  }

  // 其餘：先快取，背景更新
  e.respondWith(
    // ignoreSearch：index.html 請求的是 style.css?v=N，預快取存的是 style.css，
    // 預設 ignoreSearch:false 會永遠 miss，等於預快取白存。
    cached().then(hit => {
      const net = fetch(req).then(res => {
        if (res && res.ok) put(res);
        return res;
      }).catch(() => null);
      // 有快取就直接用（背景仍在更新）；沒快取才等網路，網路也不行就回 503。
      if (hit) { e.waitUntil(net); return hit; }
      return net.then(res => res || offline('離線中，且這個檔沒有離線副本'));
    })
  );
});
