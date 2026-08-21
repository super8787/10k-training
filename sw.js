/* 10K 教練 — Service Worker
   策略：app shell 走 cache-first（離線可開），plan.json 走 network-first（課表可更新）
   訓練紀錄不經過這裡，一律存在 localStorage。 */
const VERSION = 'v81';
const SHELL = 'shell-' + VERSION;
/* 🔴 課表存在**不隨版本清空**的 cache。
   踩過：plan.json 原本存在 shell-vNN 裡，而 activate 會刪掉所有 key !== SHELL 的 cache
   ——於是**每次部署都把課表的離線副本一起刪掉**。
   更糟的是，前面那段「伺服器回 404 就改用快取」的理由寫著「部署當下可能短暫 404」，
   而部署當下正是離線副本剛被刪掉的那一刻——保護在它宣稱要保護的時間窗裡剛好失效。
   DATA 的名字不帶 VERSION，activate 也明文放行，所以課表跨版本存活。 */
const DATA = 'data-v1';
const PLAN = 'plan.json';   // 路徑只寫一份，fetch 判斷與搬遷共用
const ASSETS = [
  './', './index.html', './style.css', './app.js', './coach.js',
  './manifest.json', './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    let keys = [];
    let rescuedFrom = null;      // 課表是從哪個舊 cache 搬過來的
    let migrated = false;        // 這次有沒有成功搬到 DATA
    try {
      keys = await caches.keys();
      // 🔴 先搬再刪。舊的 plan.json 在 shell-v70 之類的舊 cache 裡，
      //    先刪再搬會搬到一個已經空掉的地方（第一版就是這樣寫的，等於沒搬）。
      const data = await caches.open(DATA);
      if (await data.match(PLAN, { ignoreSearch: true })) {
        migrated = true;                       // DATA 本來就有，不需要搬
      } else {
        // 🔴 **從新到舊**找。caches.keys() 回的是建立順序（最舊在前），
        //    正著找會在「上次 activate 被中斷、留下兩個舊 shell」時挑到最舊的那份課表。
        for (const k of keys.slice().reverse()) {
          if (k === DATA || k === SHELL) continue;
          const old = await caches.open(k);
          const hit = await old.match(PLAN, { ignoreSearch: true });
          if (hit) {
            rescuedFrom = k;
            // put 之前再確認一次：這中間可能已經有人寫進較新的一份
            if (!(await data.match(PLAN, { ignoreSearch: true }))) {
              await data.put(PLAN, hit);
            }
            migrated = true;
            break;
          }
        }
        if (rescuedFrom === null) migrated = true;   // 舊 cache 裡本來就沒有課表
      }
    } catch (err) {
      /* 搬遷失敗不能擋住後面的清理與 claim——一次拋出的 activate 會留下殘留舊 shell，
         而那正是「搬到最舊那份」的前提。但**不要靜靜吞掉**：留一行 warn，
         而且下面的清理要跳過「還握著課表、我們卻沒搬成功」的那個 cache。 */
      console.warn('[sw] 課表搬遷失敗，保留舊 cache 等下次 activate', err);
    }
    try {
      // 🔴 只有確定課表已經在 DATA 手上，才可以刪掉來源。
      //    實測（v73 驗收）：open 失敗／舊 cache match 失敗／DATA put 配額爆這三種，
      //    catch 吞掉之後另一個 try 照樣拿著滿的 keys 把來源刪掉——**沒有下次**。
      //    我上一版的註解說「下次 activate 還有機會」，那句話被實測推翻了。
      const keep = (!migrated && rescuedFrom) ? rescuedFrom : null;
      const doomed = keys.filter(k => k !== SHELL && k !== DATA && k !== keep);
      if (!migrated && keep === null) {
        // 連來源是誰都不知道（keys 拿到了但 open/match 就炸了）→ 這輪一個都不刪
        console.warn('[sw] 不確定課表在哪，這次不清理舊 cache');
      } else {
        await Promise.all(doomed.map(k => caches.delete(k).catch(() => {})));
      }
    } catch (err) {
      console.warn('[sw] 清理舊 cache 失敗', err);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // 寫快取要掛在 e.waitUntil 上，否則 SW 可能在寫入完成前被瀏覽器終止，
  // 下次離線開啟就少了那個檔（回應照樣回得去，這裡只保住寫入）。
  // 課表進 DATA（跨版本存活），其餘進 SHELL（隨版本汰換）
  const isPlan = url.pathname.endsWith(PLAN);
  const box = isPlan ? DATA : SHELL;
  const put = (r) => {
    // cache.put 對 206 Partial Content 規定要丟 TypeError，而 res.ok 涵蓋 200-299。
    // 加上 .catch：配額爆掉或回應不可快取時，不要讓 waitUntil 收到 rejected promise。
    if (r.status !== 200) return;
    const copy = r.clone();
    e.waitUntil(caches.open(box).then(c => c.put(req, copy)).catch(() => {}));
  };
  const cached = () => caches.match(req, { ignoreSearch: true });
  // 離線又沒快取時，一定要回一個真的 Response——
  // respondWith(Promise→undefined) 會丟 TypeError，畫面變成瀏覽器的錯誤頁。
  const offline = (msg) => new Response(msg, {
    status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });

  // 課表：先連網拿最新，失敗才用快取
  if (isPlan) {
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
        if (res) put(res);
        return res;
      }).catch(() => null);
      // 有快取就直接用（背景仍在更新）；沒快取才等網路，網路也不行就回 503。
      if (hit) { e.waitUntil(net); return hit; }
      return net.then(res => res || offline('離線中，且這個檔沒有離線副本'));
    })
  );
});
