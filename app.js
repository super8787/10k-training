/* 10K 教練 — 主程式
   ============================================================
   資料：課表唯讀自 plan.json（由 scripts/build_plan.py 產生）
         訓練紀錄只存 localStorage，不上傳任何地方。
   ============================================================ */
(function () {
'use strict';

var KEY = 'coach10k.v1';

/* ── 步頻門檻：唯一定義來源 ──
   踩過兩次「同一個數字在兩個畫面得到相反評價」：
   第一次是徽章(150) vs 圖上點色/綠區(160)；
   第二次是我只修了數據頁，今天頁的徽章還留著舊門檻。
   所以門檻與配色一律從這裡取，不要在各處重寫數字。 */
var CAD = {
  warn:   Coach.RULES.CADENCE_MIN,     // 與 R5 判定門檻同一個數字
  target: Coach.RULES.CADENCE_TARGET,  // 與教練引擎的目標步頻同一個數字
  // good 已移除：達標門檻改成「那天課表要求的步頻」，見 cadGoalOn()。
  // 不要再加回一個全域達標值——它一定會跟課表的分段目標打架。
  min: 60, max: 260
};
var HR = { min: 30, max: 250 };
/* 心率門檻一律走 Coach.zonesOf(PLAN)，唯一來源是 plan.meta.zones（由 HRmax 算出）。
   踩過：coach.js 抄一份 144/160、app.js 再抄一份，HRmax 一改三邊打架。 */
function hrT() { return Coach.zonesOf(PLAN); }
/* 🔴 基準線數字只能從 plan.meta.baseline 取，不要在文案裡手抄。
   驗收四輪抓到四份手抄本：md 的「從 2K」、index.html、manifest.json，
   以及這支檔案裡的「9 分 17 秒」（與 plan.json 的 9'19" 差 2 秒）與「2 公里」。 */
/* 缺值一律回 null，讓呼叫端整句不顯示——不要吐 "NaN 分 NaN 秒" 這種字串。
   驗收指出：安靜出貨的壞字串比拋例外更難發現，因為沒有人會收到訊號。
   （coach.js 的 gctNote() 也是同一個慣例：取不到就把那句話整個省略。） */
function B() { return (PLAN && PLAN.meta && PLAN.meta.baseline) || {}; }
function bDate() {
  var d = B().date;
  return (typeof d === 'string' && d.length >= 10)
    ? +d.slice(5, 7) + '/' + +d.slice(8, 10) : null;
}
function bPace() {
  var t = B().paceSec;
  if (typeof t !== 'number' || !isFinite(t) || t <= 0) return null;
  return Math.floor(t / 60) + ' 分 ' + String(Math.round(t % 60)).padStart(2, '0') + ' 秒';
}
/* 名字要講清楚算的是什麼：這是「基準線那天 → 比賽日」的固定天數（82），
   不是「距今幾天」。原名 daysSinceBase() 會讓下一個人拿去當倒數用。 */
function baseToRaceDays() {
  var a = B().date, b = PLAN && PLAN.meta && PLAN.meta.raceDate;
  if (!a || !b) return null;
  var n = Math.round((new Date(b) - new Date(a)) / 864e5);
  return isFinite(n) ? n : null;
}
/* 「達標」是相對於**那一天課表要求的步頻**，不是一個全域常數。
   踩過的前身：CAD.good 寫死 160，而課表 Block 2 起目標升到 165/170——
   同一筆紀錄會在記錄表單顯示「目標 170」、在紀錄列與趨勢圖顯示「✓ 達標」。
   ⚠️ 而且一定要用「那天的」課表值，不能用今天的：
      Block 1 存的 160 若拿 Block 3 的門檻回頭判，歷史紀錄會變臉成「差 10」。
      已經達標的過去不該因為目標上調而變成沒達標。 */
function cadGoalOn(date) {
  if (!date) return CAD.target;
  var exact = PLAN.days.filter(function (d) { return d.date === date; })[0];
  if (exact && exact.cadence) return exact.cadence;
  // 休息日／開訓前沒有課，取「該日之前最近一堂」的目標；再取不到才用 fallback。
  var before = PLAN.days.filter(function (d) { return d.date <= date && d.cadence; });
  if (before.length) return before[before.length - 1].cadence;
  var after = PLAN.days.filter(function (d) { return d.cadence; });
  return after.length ? after[0].cadence : CAD.target;
}
function cadenceBadge(v, date) {
  var g = cadGoalOn(date);
  return v >= g ? ['up', '✓ 達標']
       : v >= CAD.warn ? ['warn', '差 ' + (g - v)]
       : ['down', '偏低'];
}
function cadenceColor(v, date) {
  var g = cadGoalOn(date);
  return v >= g ? 'var(--green)'
       : v >= CAD.warn ? 'var(--amber)' : 'var(--red)';
}
/* 心率的判定同樣只能有一份。踩過：徽章判 `<=144` 就給「✓ Z2」，
   但 45 bpm 也 <=144，於是同一列出現「低於 Z1 ✓ Z2」自相矛盾。
   「在 Z2 帶內」必須是雙邊條件，跟圖上的點色、zoneOf 用同一套。 */
function inZ2(v) { return Coach.inZone2(PLAN, v); }
function hrColor(v) {
  var t = hrT();
  return v > t.steadyCeil ? 'var(--red)'
       : v > t.easyCeil   ? 'var(--amber)'
       : v >= t.z2lo      ? 'var(--green)' : 'var(--accent)';
}
var PLAN = null, S = null, TAB = 'today';

/* ── 紀錄淨化 ──
   所有進入 S.logs 的資料都必須先過這裡。理由：匯入備份是使用者可控的入口，
   一筆動過手腳的 JSON 就能讓數值欄位變成字串或物件，往下會造成
   XSS、NaN、[object Object]、以及 totKm.toFixed 直接讓整頁 render 失敗。
   數值一律 Number() 後檢查範圍，範圍外就丟掉（不是留著）。 */
var LOG_NUM = {
  km:          [0, 100, 2],
  durationMin: [0, 600, 0],
  hrAvg:       [HR.min, HR.max, 0],
  cadence:     [CAD.min, CAD.max, 0],
  restingHr:   [25, 150, 0],
  rpe:         [1, 5,   0]
};
function sanitizeLog(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  var o = { done: raw.done === true };
  if (raw.skipped === true) o.skipped = true;
  Object.keys(LOG_NUM).forEach(function (k) {
    var rv = raw[k];
    // 缺值就是缺值，不要變成 0。Number(null)===0 會把「沒填」寫成「跑了 0 公里」，
    // 真正的 0（例如休息日紀錄）會以數字 0 傳進來，不受影響。
    if (rv === null || rv === undefined || rv === '') return;
    var sp = LOG_NUM[k], v = Number(rv);
    if (isFinite(v) && v >= sp[0] && v <= sp[1]) {
      o[k] = sp[2] ? Math.round(v * 100) / 100 : Math.round(v);
    }
  });
  if (raw.checkpointResult === 'pass' || raw.checkpointResult === 'fail') {
    o.checkpointResult = raw.checkpointResult;
  }
  if (raw.source === 'shortcut' || raw.source === 'manual') o.source = raw.source;
  if (raw.cadenceDerived === true) o.cadenceDerived = true;
  // 只收 ISO 格式，不要讓任意字串（含 XSS payload）留在 store 裡等下游踩
  // 形狀對還不夠：2026-99-99T99:99:99Z 也符合正則。用 Date 往返比對確認真的是那個時刻。
  if (typeof raw.completedAt === 'string' &&
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(raw.completedAt)) {
    var dt = new Date(raw.completedAt);
    if (!isNaN(dt.getTime()) && dt.toISOString() === raw.completedAt) {
      o.completedAt = raw.completedAt;
    }
  }
  return o;
}
function sanitizeLogs(logs) {
  var out = {};
  if (!logs || typeof logs !== 'object') return out;
  Object.keys(logs).forEach(function (d) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    var o = sanitizeLog(logs[d]);
    if (o) out[d] = o;
  });
  return out;
}

/* ── 儲存 ── */
function load() {
  try {
    var raw = localStorage.getItem(KEY);
    if (raw) {
      var o = JSON.parse(raw);
      if (o && o.logs) {
        return { version: 1, logs: sanitizeLogs(o.logs),
                 createdAt: typeof o.createdAt === 'string' ? o.createdAt : new Date().toISOString() };
      }
    }
  } catch (e) { console.warn('讀取紀錄失敗', e); }
  return { version: 1, logs: {}, createdAt: new Date().toISOString() };
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch (e) { toast('存檔失敗：' + e.message); }
}

/* ── 小工具 ── */
function ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
    '-' + String(d.getDate()).padStart(2, '0');
}
function today() { return ymd(new Date()); }
function md(s) { return s.slice(5).replace('-', '/'); }
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function el(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function $(s, r) { return (r || document).querySelector(s); }
function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }

var KIND = {
  easy:    { label: '輕鬆跑', cls: 'easy' },
  quality: { label: '品質課', cls: 'quality' },
  long:    { label: '長跑',   cls: 'long' },
  race:    { label: '比賽',   cls: 'race' }
};
function pace(km, min) {
  if (!km || !min) return null;
  var s = min * 60 / km;
  return Math.floor(s / 60) + "'" + String(Math.round(s % 60)).padStart(2, '0') + '"';
}
function toast(msg) {
  var t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { t.hidden = true; }, 2200);
}

function sessionOf(date) {
  return PLAN.days.find(function (d) { return d.date === date; }) || null;
}
/* 🔴 凡是要「顯示給使用者」或「當成預填值」的課表，一律走這個，不要直接用 sessionOf()。
   這個病灶在驗收裡出現四次：重點句、本週列表、面板標題、面板預填值，
   每次都是「拿了原始物件去畫，旁邊的數字卻是調整後的」。
   最後一次更嚴重——預填的是沒跑過的距離，按一下儲存就寫進訓練紀錄。
   sessionOf() 之後只該用在「這天是不是訓練日」這種存在性判斷。 */
function shownSession(date) {
  var s0 = sessionOf(date);
  if (!s0) return null;
  var r = Coach.applyAdjustments(s0, coachNow().adjustments);
  return { session: r.session, notes: r.notes };
}
function coachNow() { return Coach.analyze(PLAN, S.logs, today()); }

/* ── 課程內容區塊（今天／點開某天共用）── */
/* 只負責畫。調整一律在 shownSession() 做完再傳進來——
   曾經兩邊都套，結果 6K 被降階兩次變成 3.8K。 */
function sessionBlock(s, notes) {
  var sess = s;
  var k = KIND[s.kind] || KIND.easy;
  notes = notes || [];
  var h = '';

  h += '<div class="hero-top">';
  h += '<span class="tag ' + k.cls + '">' + k.label + '</span>';
  if (sess.deload) h += '<span class="tag deload">減量週</span>';
  if (sess.checkpoint) h += '<span class="tag cp">檢查點 ' + esc(sess.checkpoint.id) + '</span>';
  h += '<span class="tag">W' + sess.week + '</span>';
  h += '</div>';

  h += '<h1>' + esc(s.title) + '</h1>';
  h += '<div class="hero-detail">' + esc(s.detail) + '</div>';

  if (sess.hrGate) {
    /* 2026-08-19 改：心率不再當即時開關。
       實測他用 10 分速慢跑心率就 171，用心率 gating 會整堂走路。
       改成說話測試當主要控制、心率只當上限。 */
    h += '<div class="gate"><div class="gate-h">怎麼控制強度</div>' +
      '<div class="gate-talk">' + esc(sess.hrGate.talk || '能講完一句話就對了') + '</div>' +
      '<div class="gate-b">' +
      '<div class="gate-c stop"><div class="gate-n">' + esc(sess.hrGate.walkAbove) + '</div>' +
      '<div class="gate-l">心率上限，超過就走一段</div></div>' +
      '<div class="gate-c go"><div class="gate-n">' + esc(sess.hrLo) + '-' + esc(sess.hrHi) + '</div>' +
      '<div class="gate-l">目標區（現在會偏高，正常）</div></div>' +
      '</div></div>';
  }

  h += '<div class="metrics' + (s.km ? ' four' : '') + '">';
  if (s.km) {
    // 兩個時間都要露出來，否則卡片寫「43 分」、記錄面板預填「53 分」，
    // 使用者不知道差在哪（43 是跑步、53 是含暖身緩和的總時間）
    h += '<div class="metric"><div class="metric-n">' + s.km + '<span class="metric-u"> K</span></div><div class="metric-l">距離</div></div>';
    h += '<div class="metric"><div class="metric-n">' + s.runMin + '<span class="metric-u"> 分</span></div><div class="metric-l">預估跑步</div></div>';
    h += '<div class="metric"><div class="metric-n">' + s.totalMin + '<span class="metric-u"> 分</span></div><div class="metric-l">全部含走路</div></div>';
  } else {
    h += '<div class="metric"><div class="metric-n">' + s.runMin + '<span class="metric-u"> 分</span></div><div class="metric-l">跑步時間</div></div>';
    h += '<div class="metric"><div class="metric-n">' + s.totalMin + '<span class="metric-u"> 分</span></div><div class="metric-l">全部含走路</div></div>';
  }
  h += '<div class="metric"><div class="metric-n rng">' + esc(sess.hrLo) + '-' + esc(sess.hrHi) + '</div><div class="metric-l">心率 ' + esc(sess.zone) + '</div></div>';
  h += '</div>';

  if (notes.length) {
    h += '<div class="focus warn"><b>教練已調整這堂課</b><br>' +
      notes.map(esc).join('<br>') + '</div>';
  }
  // 必須用 s（調整後）不是 sess（原始）。
  // 驗收抓到：coach.js 已經把 focus 改寫好，但這裡畫的是原始物件，
  // 於是「標題 4.8 公里／數字卡 43 分」旁邊還留著「約 54 分鐘」。
  h += '<div class="focus">' + esc(s.focus) + '</div>';

  if (sess.checkpoint) {
    h += '<div class="focus alert"><b>🚩 檢查點 ' + esc(sess.checkpoint.id) + '</b><br>' +
      '通過標準：' + esc(sess.checkpoint.passRule) + '<br>' +
      '沒過的話：' + esc(sess.checkpoint.onFail) + '</div>';
  }
  return h;
}

/* ── 今天 ── */
function renderToday() {
  var t = today(), c = coachNow(), shown = shownSession(t), sess = shown && shown.session;
  var h = '<div class="stack">';
  var start = PLAN.meta.startDate, race = PLAN.meta.raceDate;

  if (t < start) {
    var d0 = daysBetween(t, start);
    h += '<div class="hero"><div class="hero-top"><span class="tag">尚未開訓</span></div>' +
      '<h1>還有 ' + d0 + ' 天開訓</h1>' +
      '<div class="hero-detail">第一堂課是 ' + md(start) +
      '。之後隔一天跑一次。<br>' +
      '在那之前：把跑鞋準備好，手錶的體能訓練 App 熟悉一下，' +
      '然後記住這句話——<b>這 11 週你唯一要學會的事，是慢下來。</b></div></div>';
    h += '<div class="sec-h"><h2>第一堂課長這樣</h2></div>';
    var first = shownSession(PLAN.days[0].date);
    h += '<div class="hero">' + sessionBlock(first.session, first.notes) + '</div>';
    h += baselineCard();
    h += '</div>'; return h;
  }

  if (c.adjustments.restToday && sess) {
    h += '<div class="advice crit"><div class="advice-i">🛌</div><div class="advice-b">' +
      '<div class="advice-t">教練建議今天改休息</div>' +
      '<div class="advice-d">靜止心率異常升高。今天休一天，明天再跑。</div></div></div>';
  }

  if (!sess) {
    var next = PLAN.days.find(function (d) { return d.date > t; });
    h += '<div class="hero"><div class="hero-top"><span class="tag rest">休息日</span></div>' +
      '<h1>今天休息</h1>' +
      '<div class="hero-detail">休息不是空白，是身體把上一堂課變成能力的時間。' +
      '真正變強是在休息的時候發生的，不是在跑的時候。</div></div>';
    if (next) {
      h += '<div class="sec-h"><h2>下一堂 · ' + md(next.date) + '（週' + next.weekday + '）</h2></div>';
      var nx = shownSession(next.date);
      h += '<div class="hero">' + sessionBlock(nx.session, nx.notes) + '</div>';
    } else {
      h += '<div class="card center"><div class="empty-i">🏁</div>' +
        '<div class="empty-t">課表已經跑完了</div>' +
        '<div class="muted" style="margin-top:8px">11/08 那場比賽是這份計畫的終點。' +
        '要接著練，跟我說一聲，我再排下一個週期。</div></div>';
    }
    h += '</div>'; return h;
  }

  var lg = S.logs[t] || {};
  h += '<div class="hero">' + sessionBlock(sess, shown.notes) + '</div>';
  if (lg.skipped && !lg.done) {
    h += '<div class="focus warn"><b>已記錄：今天沒跑</b><br>' +
      '不用補課——補出來的疲勞比跳過一堂更傷。照原本的課表往下走就好。<br>' +
      '如果其實有跑，按下面的「完成」就會蓋掉這筆。</div>';
  }

  if (t === race) {
    h += '<div class="focus alert" style="margin-top:0"><b>🏁 就是今天</b><br>' +
      (baseToRaceDays() && B().km
        ? baseToRaceDays() + ' 天前你只跑得動 ' + B().km + ' 公里。今天你要跑 10 公里。<br>'
        : '今天你要跑 10 公里。<br>') +
      '記住唯一那件事：<b>前 2K 壓慢</b>。旁邊的人衝出去，讓他們去。</div>';
  }

  h += '<div class="btn-row">';
  if (lg.done) {
    h += '<button class="btn done" data-act="log"><svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>已完成 · 點這裡改資料</button>';
  } else {
    h += '<button class="btn" data-act="done"><svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>' +
      (t === race ? '我完賽了 🏁' : lg.skipped ? '其實有跑，改成完成' : '完成今天的訓練') + '</button>';
    if (!lg.skipped) {
      h += '<button class="btn ghost" data-act="skip">' +
        (t === race ? '今天沒能上場' : '今天沒跑') + '</button>';
    }
  }
  h += '</div>';

  if (lg.done) h += logCard(t, lg, sess);
  h += '</div>'; return h;
}

function logCard(date, lg, sess) {
  var h = '<div class="sec-h"><h2>這堂的紀錄</h2></div><div class="card">';
  var rows = [];
  if (lg.km) rows.push(['距離', esc(lg.km) + ' <small>km</small>']);
  if (lg.durationMin) rows.push(['跑步時間', esc(lg.durationMin) +
    ' <small>分（不含暖身緩和）</small>']);
  if (lg.km && lg.durationMin) rows.push(['平均配速', pace(lg.km, lg.durationMin) + ' <small>/km</small>']);
  if (lg.hrAvg) {
    var z = zoneOf(lg.hrAvg), warn = '';
    // 同一個心率在不同課別的意義相反：輕鬆跑落在 Z2 是跑對了，
    // 品質課（處方 Z3）落在 Z2 是**強度不足**，給綠勾會鼓勵他繼續練不到東西。
    var wantZ3 = sess.kind === 'quality' || sess.kind === 'race';
    if (!wantZ3 && lg.hrAvg > hrT().steadyCeil)
      warn = ' <span class="delta down">偏高</span>';
    else if (wantZ3 && inZ2(lg.hrAvg))
      warn = ' <span class="delta warn">強度不足</span>';
    else if (!wantZ3 && inZ2(lg.hrAvg))
      warn = ' <span class="delta up">✓ Z2</span>';
    else if (wantZ3 && lg.hrAvg > hrT().easyCeil && lg.hrAvg <= hrT().steadyCeil)
      warn = ' <span class="delta up">✓ Z3</span>';
    rows.push(['平均心率', esc(lg.hrAvg) + ' <small>bpm · ' + esc(z) + '</small>' + warn]);
  }
  if (lg.cadence) {
    var cb = cadenceBadge(lg.cadence, sess.date);
    rows.push(['步頻', esc(lg.cadence) + ' <small>spm' +
      (lg.cadenceDerived ? ' · 換算值' : '') + '</small>' +
      ' <span class="delta ' + cb[0] + '">' + cb[1] + '</span>']);
  }
  if (lg.restingHr) rows.push(['靜止心率', esc(lg.restingHr) + ' <small>bpm</small>']);
  if (lg.rpe >= 1 && lg.rpe <= 5) rows.push(['體感', ['', '很輕鬆', '輕鬆', '有點喘', '很喘', '快掛了'][lg.rpe]]);
  if (lg.checkpointResult) rows.push(['檢查點結果',
    lg.checkpointResult === 'pass' ? '<span class="delta up">通過</span>' : '<span class="delta down">未通過</span>']);
  if (lg.source) rows.push(['資料來源', lg.source === 'shortcut' ? '手錶自動同步' : '手動輸入']);

  if (!rows.length) {
    h += '<div class="muted center">已打勾，但沒填數據。<br>' +
      '填一下距離和心率，教練才能依實際狀況調課表。</div>';
  } else {
    rows.forEach(function (r) {
      h += '<div class="kv"><div class="kv-k">' + r[0] + '</div><div class="kv-v">' + r[1] + '</div></div>';
    });
  }
  h += '</div>';
  return h;
}

function baselineCard() {
  var b = PLAN.meta.baseline;
  var h = '<div class="sec-h"><h2>你的起點</h2><span>' + md(b.date) + ' 實測</span></div><div class="card">';
  // 時間與配速一律從資料導出，不要硬編（舊版寫死 14:42／7'16"，換了基準線就變假話）
  var mm = Math.floor(b.durationSec / 60), ss = b.durationSec % 60;
  var pm = Math.floor(b.paceSec / 60), ps = b.paceSec % 60;
  h += '<div class="kv"><div class="kv-k">距離 / 時間</div><div class="kv-v">' + esc(b.km) +
    ' <small>km</small> · ' + mm + ':' + String(ss).padStart(2, '0') + '</div></div>';
  h += '<div class="kv"><div class="kv-k">平均配速</div><div class="kv-v">' + pm + '\'' +
    String(ps).padStart(2, '0') + '" <small>/km</small></div></div>';
  h += '<div class="kv"><div class="kv-k">平均心率</div><div class="kv-v">' + esc(b.hrAvg) +
    ' <small>bpm</small> <span class="delta down">' +
    Math.round(b.hrAvg / PLAN.meta.hrMax * 100) + '% 最大值</span></div></div>';
  if (b.restingHr) h += '<div class="kv"><div class="kv-k">靜止心率</div><div class="kv-v">' +
    esc(b.restingHr) + ' <small>bpm</small></div></div>';
  if (b.vo2max) h += '<div class="kv"><div class="kv-k">心肺適能 VO₂Max</div><div class="kv-v">' +
    esc(b.vo2max) + ' <small>mL/min·kg</small></div></div>';
  h += '<div class="kv"><div class="kv-k">步頻</div><div class="kv-v">' + b.cadence +
    ' <small>spm</small> <span class="delta down">偏低</span></div></div>';
  h += '<div class="kv"><div class="kv-k">觸地時間</div><div class="kv-v">' + b.groundContactMs +
    ' <small>ms</small> <span class="delta down">偏長</span></div></div>';
  h += '</div><div class="focus">' + esc(b.note) + '</div>';
  if (b.history) h += '<div class="focus warn"><b>你不是零基礎</b><br>' + esc(b.history) + '</div>';
  if (b.prev) h += '<div class="muted" style="margin-top:10px">前一趟 ' + esc(md(b.prev.date)) +
    '：' + esc(b.prev.km) + ' km、' + esc(b.prev.note) + '</div>';
  return h;
}

function zoneOf(hr) {
  var z = PLAN.meta.zones, names = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5'];
  if (hr < z.Z1.lo) return '低於 Z1';   // 45 bpm 不該顯示成「Z1 恢復」
  for (var i = 0; i < names.length; i++) {
    // 用「小於下一區的下緣」判定：Z1.hi 與 Z2.lo 同為 120，用 <= hi 會讓 120 落進 Z1，
    // 於是出現「Z1 恢復 ✓ Z2」自相矛盾。
    var nxt = z[names[i + 1]];
    if (nxt ? hr < nxt.lo : hr <= z.Z5.hi) return names[i] + ' ' + z[names[i]].name;
  }
  return 'Z5 ' + z.Z5.name;
}

/* ── 本週 ── */
function renderWeek() {
  var t = today(), wk = Coach.currentWeek(PLAN, t);
  var c = coachNow();
  var days = PLAN.days.filter(function (d) { return d.week === wk; });
  var wl = PLAN.weeklyLoad.find(function (w) { return w.week === wk; });
  var h = '<div class="sec-h"><h2>第 ' + wk + ' 週 · ' + esc(days[0].theme) + '</h2>' +
    '<span>' + md(days[0].date) + '–' + md(days[days.length - 1].date) + '</span></div>';
  h += '<div class="card flat" style="margin-bottom:13px"><div class="muted">' +
    esc(days[0].weekNote) + '</div></div>';

  h += '<div class="stack">';
  days.forEach(function (d0) {
    // 本週列表也要顯示調整後的數字。原本用原始物件，於是同一堂課
    // 今天頁寫「跑 12 分」、本週列寫「跑 15 分」——跨頁兩個數字。
    var d = (shownSession(d0.date) || {}).session || d0;
    var lg = S.logs[d.date] || {}, k = KIND[d.kind] || KIND.easy;
    var cls = 'day';
    if (d.date === t) cls += ' is-today';
    if (lg.done) cls += ' is-done';
    else if (lg.skipped || d.date < t) cls += ' is-miss';
    h += '<div class="' + cls + '" data-open="' + d.date + '">';
    h += '<div class="day-date"><div class="day-wd">週' + d.weekday + '</div>' +
      '<div class="day-dd">' + Number(d.date.slice(8)) + '</div></div>';
    h += '<div class="day-main"><div class="day-t">' + esc(d.title) +
      (d.checkpoint ? ' <span class="tag cp">' + esc(d.checkpoint.id) + '</span>' : '') + '</div>';
    h += '<div class="day-d"><span class="tag ' + k.cls + '" style="padding:1px 7px;font-size:10px">' +
      k.label + '</span> ' + (d.km ? d.km + ' K' : d.runMin + ' 分') +
      ' · 心率 ' + d.hrLo + '-' + d.hrHi;
    if (lg.done && lg.hrAvg) h += ' · 實際 ' + esc(lg.hrAvg);
    h += '</div></div>';
    h += '<div class="day-chk' + (lg.done ? ' on' : '') + '">' +
      (lg.done ? '<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>'
       : lg.skipped ? '<svg viewBox="0 0 24 24" style="stroke:var(--red)"><path d="M18 6L6 18M6 6l12 12"/></svg>'
       : '') + '</div>';
    h += '</div>';
  });
  h += '</div>';

  var doneN = days.filter(function (d) { return (S.logs[d.date] || {}).done; }).length;
  h += '<div class="sec-h"><h2>本週統計</h2></div><div class="card">';
  h += '<div class="kv"><div class="kv-k">完成度</div><div class="kv-v">' + doneN + ' / ' + days.length + '</div></div>';
  h += '<div class="kv"><div class="kv-k">計畫跑量</div><div class="kv-v">' + wl.load + ' <small>分</small></div></div>';
  if (wl.deload) h += '<div class="kv"><div class="kv-k">週型</div><div class="kv-v"><span class="tag deload">減量週</span></div></div>';
  h += '</div>';
  return h;
}

/* ── 全期 ── */
function renderAll() {
  var t = today(), wkNow = Coach.currentWeek(PLAN, t);
  var h = '';
  PLAN.meta.blocks.forEach(function (b) {
    h += '<div class="blockhead"><b>Block ' + b.id + '　' + esc(b.name) + '</b>' +
      '<span>' + esc(b.weeks) + '</span></div>';
    h += '<div class="card flat" style="margin-bottom:10px"><div class="muted">' + esc(b.goal) + '</div></div>';
    h += '<div class="stack">';
    PLAN.weeklyLoad.filter(function (w) {
      return PLAN.days.find(function (d) { return d.week === w.week; }).block === b.id;
    }).forEach(function (w) {
      var days = PLAN.days.filter(function (d) { return d.week === w.week; });
      var done = days.filter(function (d) { return (S.logs[d.date] || {}).done; }).length;
      var pct = done / days.length * 100;
      var cls = 'wk' + (w.week === wkNow ? ' now' : (days[days.length - 1].date < t ? ' past' : ''));
      var cp = days.find(function (d) { return d.checkpoint; });
      h += '<div class="' + cls + '">';
      h += '<div class="wk-n">W' + w.week + '</div>';
      h += '<div class="wk-main"><div class="wk-t">' + esc(w.theme) +
        (cp ? ' 🚩' : '') + (w.deload ? ' <span class="tag deload" style="padding:1px 6px;font-size:9.5px">減量</span>' : '') + '</div>';
      h += '<div class="wk-bar"><div class="wk-fill' + (pct === 100 ? ' full' : '') +
        '" style="width:' + pct + '%"></div></div></div>';
      h += '<div class="wk-c">' + done + '/' + days.length + '</div>';
      h += '</div>';
    });
    h += '</div>';
  });

  var allDone = PLAN.days.filter(function (d) { return (S.logs[d.date] || {}).done; }).length;
  h += '<div class="sec-h"><h2>總進度</h2></div><div class="card">';
  h += '<div class="kv"><div class="kv-k">完成堂數</div><div class="kv-v">' + allDone + ' / ' + PLAN.days.length + '</div></div>';
  h += '<div class="kv"><div class="kv-k">距離比賽</div><div class="kv-v">' +
    Math.max(0, daysBetween(t, PLAN.meta.raceDate)) + ' <small>天</small></div></div>';
  h += '<div class="kv"><div class="kv-k">目標</div><div class="kv-v">' + esc(PLAN.meta.goal) + '</div></div>';
  h += '</div>';
  return h;
}

/* ── 數據 ── */
function sparkline(vals, opt) {
  opt = opt || {};
  if (vals.length < 2) return '';
  var w = 320, hgt = 78, pad = 6;
  var min = opt.min != null ? opt.min : Math.min.apply(null, vals);
  var max = opt.max != null ? opt.max : Math.max.apply(null, vals);
  if (max === min) { max = min + 1; }
  var dx = (w - pad * 2) / (vals.length - 1);
  var pts = vals.map(function (v, i) {
    var x = pad + i * dx;
    var y = pad + (hgt - pad * 2) * (1 - (v - min) / (max - min));
    return [x, y];
  });
  var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
  var band = '';
  if (opt.bandLo != null && opt.bandHi != null) {
    // y 與 height 都要夾在框內，否則調 band 範圍時 rect 會溢出（目前保底值走不到，先堵住）
    var y1 = pad + (hgt - pad * 2) * (1 - (opt.bandHi - min) / (max - min));
    var y2 = pad + (hgt - pad * 2) * (1 - (opt.bandLo - min) / (max - min));
    var yTop = Math.min(hgt, Math.max(0, y1));
    var yBot = Math.min(hgt, Math.max(0, y2));
    band = '<rect x="0" y="' + yTop.toFixed(1) + '" width="' + w +
      '" height="' + Math.max(0, yBot - yTop).toFixed(1) +
      '" fill="var(--green)" opacity="0.13"/>';
  }
  var dots = pts.map(function (p, i) {
    // 第二個參數是索引：步頻的點色要跟「那一天」的課表目標比，不是全域門檻。
    var col = opt.dotColor ? opt.dotColor(vals[i], i) : 'var(--accent)';
    // 換算值畫空心圈，跟實測值一眼分得開
    var hollow = opt.derived && opt.derived[i];
    return '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) +
      '" r="' + (hollow ? '3.4' : '3') + '" fill="' + (hollow ? 'var(--bg)' : col) +
      '" stroke="' + col + '" stroke-width="' + (hollow ? '1.8' : '0') + '"/>';
  }).join('');
  return '<svg class="spark" viewBox="0 0 ' + w + ' ' + hgt + '" preserveAspectRatio="none">' +
    band + '<path d="' + d + '" fill="none" stroke="var(--accent)" stroke-width="2" ' +
    'stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>' +
    dots + '</svg>';
}

function renderData() {
  var done = PLAN.days.filter(function (d) { return (S.logs[d.date] || {}).done; })
    .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  if (!done.length) {
    return '<div class="empty"><div class="empty-i">📈</div>' +
      '<div class="empty-t">還沒有訓練紀錄</div>' +
      '<div class="empty-d">跑完第一堂、在「今天」按下完成並填一下數據，<br>' +
      '這裡就會開始畫趨勢。</div></div>' + baselineCard();
  }

  var Z = PLAN.meta.zones;
  var hrs = done.filter(function (d) { return S.logs[d.date].hrAvg; });
  var easyLong = hrs.filter(function (d) { return d.kind === 'easy' || d.kind === 'long'; });
  // 必須用雙邊判定。單邊 `<= Z2.hi` 會把 45／95 bpm 也算成「落在 Z2」，
  // 於是 App 標題最大的那個數字顯示 100% ＋「有氧基礎正在長出來」——完全相反的結論。
  var nInZ2 = easyLong.filter(function (d) { return inZ2(S.logs[d.date].hrAvg); }).length;
  var pctZ2 = easyLong.length ? Math.round(nInZ2 / easyLong.length * 100) : 0;

  var h = '';
  /* 最重要的一個數字 */
  h += '<div class="sec-h"><h2>最重要的一個數字</h2></div>';
  // 0/0（只記了品質課、還沒有輕鬆跑或長跑）不是「0%」，是「還沒有資料」。
  // 顯示紅色 0% ＋「你還在用拚的方式跑步」會冤枉人。
  var noData = easyLong.length === 0;
  h += '<div class="card big"><div class="big-n" style="color:' +
    (noData ? 'var(--tx3)' : pctZ2 >= 70 ? 'var(--green)' : pctZ2 >= 40 ? 'var(--amber)' : 'var(--red)') + '">' +
    (noData ? '—' : pctZ2 + '<span class="big-u">%</span>') + '</div>' +
    '<div class="big-l">輕鬆跑／長跑中，平均心率落在 Z2（' + Z.Z2.lo + '-' + Z.Z2.hi + '）的比例<br>' +
    '<span class="muted">' + nInZ2 + ' / ' + easyLong.length + ' 堂 · 目標 70% 以上</span></div></div>';
  h += '<div class="focus' + (noData || pctZ2 >= 70 ? '' : ' warn') + '">' +
    (noData
      ? '還沒有輕鬆跑或長跑的心率紀錄。跑完一堂並填上平均心率，這個數字才有意義。'
      : pctZ2 >= 70
      ? '很好。有氧基礎正在長出來，這就是能跑完 10K 的東西。'
      : '這個數字比配速重要得多。它低，代表你還在用「拚」的方式跑步——' +
        '那種跑法練不出 10K 的耐力，只會累積疲勞。慢下來。') + '</div>';

  /* 心率趨勢 */
  if (hrs.length >= 2) {
    var hv = hrs.map(function (d) { return S.logs[d.date].hrAvg; });
    var first = hv[0], last = hv[hv.length - 1];
    h += '<div class="sec-h"><h2>平均心率趨勢</h2><span>越低越好</span></div><div class="card">';
    h += '<div class="kv" style="border:none;padding-top:0">' +
      '<div class="kv-k">最近一次</div><div class="kv-v">' + last + ' <small>bpm</small>' +
      '<span class="delta ' + (last < first ? 'up' : last > first ? 'down' : 'flat') + '">' +
      (last < first ? '↓' : last > first ? '↑' : '→') + Math.abs(last - first) + '</span></div></div>';
    h += sparkline(hv, {
      min: Math.min(110, Math.min.apply(null, hv) - 5),
      max: Math.max(190, Math.max.apply(null, hv) + 5),
      bandLo: Z.Z2.lo, bandHi: Z.Z2.hi,
      dotColor: hrColor
    });
    h += '<div class="muted center" style="margin-top:6px">綠色區塊 = Z2（' +
      Z.Z2.lo + '-' + Z.Z2.hi + '）。點落在綠區裡才算跑對。</div>';
    h += '<div class="muted center" style="margin-top:4px">起點 ' +
      PLAN.meta.baseline.hrAvg + ' bpm（8/18 實測）</div></div>';
  }

  /* 步頻 */
  var cads = done.filter(function (d) { return S.logs[d.date].cadence; });
  if (cads.length >= 2) {
    var cv = cads.map(function (d) { return S.logs[d.date].cadence; });
    // 目標會隨 Block 上調，所以標題寫「目前目標」＝今天這堂的要求，不是一個固定數字。
    var goalNow = cadGoalOn(Coach.ymd(new Date())) ;
    h += '<div class="sec-h"><h2>步頻趨勢</h2><span>越高越好，目前目標 ' + goalNow + '</span></div><div class="card">';
    // 徽章門檻要跟圖上的點色與綠區一致，否則同一張卡會自相矛盾：
    // 155 spm 曾經同時顯示綠色 ✓、琥珀色的點、以及落在綠區外的位置。
    var lastDate = cads[cads.length - 1].date;
    var lastCad = cv[cv.length - 1];
    var badge = cadenceBadge(lastCad, lastDate);
    h += '<div class="kv" style="border:none;padding-top:0"><div class="kv-k">最近一次</div>' +
      '<div class="kv-v">' + esc(lastCad) + ' <small>spm</small>' +
      '<span class="delta ' + badge[0] + '">' + badge[1] + '</span></div></div>';
    var cDeriv = cads.map(function (d) { return S.logs[d.date].cadenceDerived === true; });
    var nDeriv = cDeriv.filter(Boolean).length;
    // y 範圍要跟著資料走。寫死 135-175 會把最該被看見的值畫到框外——
    // 低於 150 的實測值正是 R5 要警告的情境，換算誤差大的值也一樣。
    // 保底仍涵蓋 135-175，綠區不會因為資料集中而消失。
    var cMin = Math.min(135, Math.min.apply(null, cv) - 5);
    var cMax = Math.max(175, Math.max.apply(null, cv) + 5);
    h += sparkline(cv, {
      min: cMin, max: cMax,
      // 綠區是「目前目標以上」的開放區間，上緣要跟著圖頂走。
      // 寫死 175 的話，步頻 >175 的點會畫在綠帶「上方」，跟文案「160 以上」對不起來。
      // 綠區用「目前目標」畫；每個點各自跟它那天的目標比（dotColor 吃日期）。
      bandLo: goalNow, bandHi: cMax, derived: cDeriv,
      dotColor: function (v, i) { return cadenceColor(v, cads[i] && cads[i].date); }
    });
    h += '<div class="muted center" style="margin-top:6px">起點 ' +
      PLAN.meta.baseline.cadence + ' spm。綠區 = 目前目標 ' + goalNow + ' 以上。' +
      '每個點是跟<b>那天</b>課表的目標比，所以目標上調不會讓過去的紀錄變臉。</div>';
    if (nDeriv) {
      h += '<div class="muted center" style="margin-top:4px">空心圈 = 舊版換算值（' + nDeriv +
        ' / ' + cv.length + ' 筆），實測誤差可達 26 spm，<b>不會拿來改課表</b>。' +
        '新紀錄一律照手錶螢幕上的「平均步頻」手動填。</div>';
    }
    h += '</div>';
  }

  /* 配速 */
  var paces = done.filter(function (d) { var l = S.logs[d.date]; return l.km && l.durationMin; });
  if (paces.length >= 2) {
    var pv = paces.map(function (d) { var l = S.logs[d.date]; return l.durationMin * 60 / l.km; });
    h += '<div class="sec-h"><h2>配速趨勢</h2><span>Z2 心率下自然變快 = 進步</span></div><div class="card">';
    var lastP = pv[pv.length - 1];
    h += '<div class="kv" style="border:none;padding-top:0"><div class="kv-k">最近一次</div>' +
      '<div class="kv-v">' + Math.floor(lastP / 60) + "'" +
      String(Math.round(lastP % 60)).padStart(2, '0') + '" <small>/km</small></div></div>';
    h += sparkline(pv.map(function (v) { return -v; }), { dotColor: function () { return 'var(--accent)'; } });
    h += '<div class="muted center" style="margin-top:6px">往上 = 變快。' +
      '重點不是快，是「同樣心率下能跑多快」。</div></div>';
  }

  /* 累計 */
  var totKm = 0, totMin = 0;
  done.forEach(function (d) {
    var l = S.logs[d.date];
    totKm += Number(l.km) || 0;
    totMin += Number(l.durationMin) || 0;
  });
  h += '<div class="sec-h"><h2>累計</h2></div><div class="card">';
  h += '<div class="kv"><div class="kv-k">完成堂數</div><div class="kv-v">' + done.length + ' <small>堂</small></div></div>';
  if (totKm) h += '<div class="kv"><div class="kv-k">總距離</div><div class="kv-v">' + totKm.toFixed(1) + ' <small>km</small></div></div>';
  if (totMin) h += '<div class="kv"><div class="kv-k">總時間</div><div class="kv-v">' +
    Math.floor(totMin / 60) + ' <small>小時</small> ' + (totMin % 60) + ' <small>分</small></div></div>';
  h += '</div>';
  return h;
}

/* ── 教練 ── */
function renderCoach() {
  var c = coachNow();
  var h = '<div class="sec-h"><h2>教練調整</h2><span>依你的實際數據</span></div><div class="stack">';
  c.advices.forEach(function (a) {
    var cls = 'advice' + (a.level === 'crit' ? ' crit' : a.level === 'hot' ? ' hot' : a.level === 'good' ? ' good' : '');
    h += '<div class="' + cls + '"><div class="advice-i">' + esc(a.icon) + '</div><div class="advice-b">';
    h += '<div class="advice-t">' + esc(a.title) + '</div>';
    h += '<div class="advice-d">' + esc(a.detail).replace(/\n/g, '<br>') + '</div>';
    h += '<div class="advice-r">觸發規則 → ' + esc(a.rule) + '</div>';
    h += '</div></div>';
  });
  h += '</div>';

  h += '<div class="sec-h"><h2>全部規則</h2><span>沒有黑箱</span></div><div class="card">';
  // 門檻一律讀真值，不要在這裡重打數字。
  // ⚠️ 心率要走 hrT()（唯一來源＝plan.meta.zones）；CR.HR_EASY_CEIL／HR_STEADY_CEIL
  //    現在只是 coach.js 的 fallback，讀它們會在 HRmax 改動後顯示舊數字。
  var CR = Coach.RULES, TZ = hrT();
  [['R1', '輕鬆／長跑平均心率 > ' + TZ.ceiling + '（Z5 下緣）',
    '下次放慢 ' + CR.PACE_SLOWDOWN + ' 秒/km，長跑打 ' + Math.round(CR.LONG_CUT_SOFT * 10) + ' 折'],
   ['R2', '連續 ' + CR.MISS_STREAK + ' 堂沒完成', '長跑降到 ' + Math.round(CR.LONG_CUT * 100) + '%'],
   // 原本寫「心率 ≤ 144」，但實際判定是雙邊的 inZone2——110 bpm 符合「≤144」卻不觸發 R3。
   // 這一頁的標題是「沒有黑箱」，寫錯規則比別頁嚴重。
   ['R3', '連續 ' + CR.GOOD_STREAK + ' 次輕鬆跑心率 ≤ ' + TZ.steadyCeil + '（壓進 Z3）',
    '長跑加 ' + Math.round((CR.LONG_BOOST - 1) * 100) + '%'],
   ['R4', '靜止心率比近期均值高 ≥ ' + CR.RHR_JUMP + '　<b style="color:var(--amber)">（需接手錶捷徑才會啟用）</b>', '建議今天休息'],
   ['R5', '最近 ' + CR.GOOD_STREAK + ' 次<b>實測</b>步頻平均 < ' + CR.CADENCE_MIN +
    '　<b style="color:var(--tx3)">（換算值不採計）</b>', '下堂品質課強制節拍器'],
   ['R6', '檢查點 CP1／CP2 到期或已回報', '依結果切換課表'],
   ['R7', '本週已過課程完成率 < 50%', '提醒，但不要補課'],
   ['R8', '<b>同樣配速下</b>平均心率的變化（配速差 ≤' + Coach.RULES.PACE_TOL_SEC + ' 秒/km 才比）',
    '降 ≥3 下＝有氧在長；升 ≥5 下＝該減量']
  ].forEach(function (r) {
    /* r[1] 是本檔硬編的字串常數（含少量標記），非外部輸入，故不逃逸；r[2] 照常逃逸 */
    h += '<div class="rule"><div class="rule-h"><span class="rule-id">' + r[0] + '</span>' +
      r[1] + '</div><div class="rule-a">→ ' + esc(r[2]) + '</div></div>';
  });
  h += '</div>';

  h += '<div class="sec-h"><h2>心率區間</h2><span>HRmax ' + PLAN.meta.hrMax + '（Karvonen）</span></div>';
  h += '<div class="focus warn">這些區間是<b>看趨勢用的，不是每一堂要待著的地方</b>。' +
    (bDate() && bPace() && B().hrAvg
      ? '你 ' + bDate() + ' 用 ' + bPace() + ' 配速慢跑，心率就 ' + B().hrAvg +
        '（' + zoneOf(B().hrAvg) + '）——現在要你待在 Z2 等於整堂走路。'
      : '慢跑心率就會偏高是正常的，現在要你待在 Z2 等於整堂走路。') +
    '跑步時只要顧兩件事：<b>能講完一句話</b>、<b>心率別破 ' + hrT().ceiling + '</b>。' +
    '目標是同樣配速下心率慢慢往 Z3 掉。</div>';
  h += '<div class="card">';
  ['Z1', 'Z2', 'Z3', 'Z4', 'Z5'].forEach(function (z) {
    var o = PLAN.meta.zones[z];
    h += '<div class="kv"><div class="kv-k"><b>' + z + '</b> ' + esc(o.name) +
      ' <small style="color:var(--tx3)">' + esc(o.talk) + '</small></div>' +
      '<div class="kv-v">' + o.lo + '-' + o.hi + '</div></div>';
  });
  h += '</div>';

  h += '<div class="sec-h"><h2>資料</h2></div><div class="stack">';
  h += '<button class="btn ghost" data-act="export">匯出紀錄（JSON 備份）</button>';
  h += '<button class="btn ghost" data-act="import">匯入備份</button>';
  h += '<button class="btn danger" data-act="reset">清除所有紀錄</button>';
  h += '</div>';
  h += '<div class="muted" style="margin-top:12px;text-align:center">' +
    '訓練紀錄只存在這支手機裡，不會上傳任何地方。<br>' +
    '真正的原始資料在「健康」App，這裡清掉了也還原得回來。</div>';
  return h;
}

/* ── 記錄面板 ── */
var draft = null;
function openSheet(date) {
  if (!sessionOf(date)) return;
  /* 🔴 預填值必須用調整後的課表。
     踩過：卡片顯示「4.8 K／43 分」但面板預填 6.00 km／64 分（未降階的原值），
     而面板寫著「跑完隨手點一下就好」——照做按儲存就把沒跑過的 6 公里寫進紀錄，
     然後污染累計距離、配速與教練引擎的判斷。 */
  var sess = shownSession(date).session;
  var lg = S.logs[date] || {};
  draft = {
    km: lg.km != null ? lg.km : (sess.km || null),
    // 🔴 預填用 runMin（純跑步時間）不是 totalMin（含暖身緩和）。
    //    「距離」是跑步距離，兩者相除才是配速；用 totalMin 會系統性偏慢——
    //    實測：一鍵儲存後顯示「11'03"/km」，而同一張卡的目標寫「9'00" 上下」。
    durationMin: lg.durationMin != null ? lg.durationMin : sess.runMin,
    hrAvg: lg.hrAvg != null ? lg.hrAvg : null,
    cadence: lg.cadence != null ? lg.cadence : null,
    rpe: lg.rpe || null,
    checkpointResult: lg.checkpointResult || null,
    date: date
  };
  $('#sheetTitle').textContent = md(date) + '（週' + sess.weekday + '）' + sess.title;
  drawSheet(sess);
  $('#sheet').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeSheet() {
  $('#sheet').hidden = true; draft = null;
  document.body.style.overflow = '';
}
function drawSheet(sess) {
  var h = '<div class="sheet-sub">跑完隨手點一下就好，全部可以留空。' +
    '填了心率和步頻，教練才調得動課表。</div>';

  if (sess.checkpoint) {
    h += '<div class="field"><div class="field-l">🚩 ' + esc(sess.checkpoint.id) +
      ' 有沒有達成？<em>' + esc(sess.checkpoint.passRule) + '</em></div><div class="chips">';
    h += '<button class="chip wide' + (draft.checkpointResult === 'pass' ? ' on' : '') +
      '" data-cp="pass">✅ 有，達成了</button>';
    h += '<button class="chip wide' + (draft.checkpointResult === 'fail' ? ' on' : '') +
      '" data-cp="fail">🔁 沒有，中途停下來了</button>';
    h += '</div></div>';
  }

  h += stepField('距離', 'km', draft.km, 'km', 0.1);
  h += stepField('跑步時間', 'durationMin', draft.durationMin, '分', 1,
    '不含暖身與緩和｜今天課表是 ' + sess.runMin + ' 分');
  h += stepField('平均心率', 'hrAvg', draft.hrAvg, 'bpm', 1, '手錶上那個數字');
  h += stepField('步頻', 'cadence', draft.cadence, 'spm', 1,
    '看手錶的「平均步頻」照填｜目標 ' + (sess.cadence || CAD.target));

  h += '<div class="field"><div class="field-l">跑起來的感覺<em>可略過</em></div><div class="chips">';
  ['很輕鬆', '輕鬆', '有點喘', '很喘', '快掛了'].forEach(function (t, i) {
    h += '<button class="chip' + (draft.rpe === i + 1 ? ' on' : '') + '" data-rpe="' + (i + 1) +
      '" style="flex:1 1 30%;font-size:13px">' + t + '</button>';
  });
  h += '</div></div>';

  if (draft.km && draft.durationMin) {
    h += '<div class="focus">換算平均配速：<b>' + pace(draft.km, draft.durationMin) + ' / 公里</b></div>';
  }
  if (draft.hrAvg) {
    var over = (sess.kind === 'easy' || sess.kind === 'long') && draft.hrAvg > hrT().steadyCeil;
    h += '<div class="focus' + (over ? ' alert' : '') + '">心率 ' + draft.hrAvg + ' = <b>' +
      zoneOf(draft.hrAvg) + '</b>' + (over ? '　⚠️ 這堂課跑太快了' : '') + '</div>';
  }

  h += '<div class="btn-row"><button class="btn" data-act="save">儲存</button>';
  h += '<button class="btn ghost" data-close>關閉</button></div>';
  $('#sheetBody').innerHTML = h;
}
/* 🔴 範圍不接受呼叫端傳入，一律從 LOG_NUM 取。
   踩過的坑：步進器寫 km[0,30]／min[0,300] 但淨化層是 [0,100]／[0,600]，
   捷徑同步進 42.2km／420分之後，使用者按一下步進器就被夾成 30／300 並存檔＝靜默資料破壞。
   兩處各寫一份範圍遲早會漂移，所以直接拿掉「各寫一份」的可能性。 */
function stepField(label, key, val, unit, step, hint) {
  var sp = LOG_NUM[key];
  var min = sp[0], max = sp[1], dec = sp[2];   // 小數位數也只有這一份
  var shown = val == null ? '—' : (dec ? Number(val).toFixed(dec) : Math.round(val));
  return '<div class="field"><div class="field-l">' + label +
    (hint ? '<em>' + esc(hint) + '</em>' : '<em>可留空</em>') + '</div>' +
    '<div class="stepper">' +
    '<button data-step="' + key + '" data-dir="-1" data-s="' + step + '" data-min="' + min + '" data-max="' + max + '" aria-label="減少">−</button>' +
    '<div class="stepper-v">' + shown + '<small>' + unit + '</small></div>' +
    '<button data-step="' + key + '" data-dir="1" data-s="' + step + '" data-min="' + min + '" data-max="' + max + '" aria-label="增加">+</button>' +
    '</div></div>';
}

/* ── 事件 ── */
function onTap(e) {
  var t = e.target;

  var closeEl = t.closest('[data-close]');
  if (closeEl) { closeSheet(); return; }

  var step = t.closest('[data-step]');
  if (step) {
    var k = step.dataset.step, dir = +step.dataset.dir, s = +step.dataset.s;
    var mn = +step.dataset.min, mx = +step.dataset.max;
    var cur = draft[k];
    if (cur == null) {
      var sess0 = shownSession(draft.date).session;
      cur = k === 'hrAvg' ? 140 : k === 'cadence' ? (sess0.cadence || CAD.target) : 0;
    } else {
      cur = cur + dir * s;
    }
    cur = Math.min(mx, Math.max(mn, cur));
    var d2 = LOG_NUM[k][2];   // 精度取自同一份定義，別在這裡重寫 Math.round(x*10)/10
    draft[k] = d2 ? Math.round(cur * Math.pow(10, d2)) / Math.pow(10, d2) : Math.round(cur);
    drawSheet(shownSession(draft.date).session);
    return;
  }
  var rpe = t.closest('[data-rpe]');
  if (rpe) { draft.rpe = draft.rpe === +rpe.dataset.rpe ? null : +rpe.dataset.rpe; drawSheet(shownSession(draft.date).session); return; }
  var cp = t.closest('[data-cp]');
  if (cp) { draft.checkpointResult = draft.checkpointResult === cp.dataset.cp ? null : cp.dataset.cp; drawSheet(shownSession(draft.date).session); return; }

  var open = t.closest('[data-open]');
  if (open) { openSheet(open.dataset.open); return; }

  var act = t.closest('[data-act]');
  if (!act) return;
  var a = act.dataset.act;

  if (a === 'done') {
    var d = today();
    S.logs[d] = Object.assign({}, S.logs[d], { done: true, skipped: false,
      completedAt: new Date().toISOString(), source: 'manual' });
    save(); render(); toast('已完成 ✓');
    setTimeout(function () { openSheet(d); }, 260);
  }
  else if (a === 'skip') {
    var d2 = today();
    S.logs[d2] = { done: false, skipped: true, completedAt: new Date().toISOString() };
    save(); render(); toast('記錄為沒跑。明天繼續。');
  }
  else if (a === 'log') openSheet(today());
  else if (a === 'save') {
    var dt = draft.date, prev = S.logs[dt] || {};
    var o = { done: true, source: prev.source || 'manual',
      completedAt: prev.completedAt || new Date().toISOString() };
    ['km', 'durationMin', 'hrAvg', 'cadence', 'rpe', 'checkpointResult'].forEach(function (k) {
      if (draft[k] != null && draft[k] !== '') o[k] = draft[k];
    });
    if (prev.restingHr != null) o.restingHr = prev.restingHr;
    // 步頻沒被動過就保留「換算值」註記；手動調整過就是實測值，註記要消失
    if (prev.cadenceDerived === true && o.cadence === prev.cadence) o.cadenceDerived = true;
    S.logs[dt] = o; save(); closeSheet(); render(); toast('已儲存');
  }
  else if (a === 'export') doExport();
  else if (a === 'import') doImport();
  else if (a === 'reset') {
    if (confirm('確定清除所有訓練紀錄？\n\n課表不會消失，但打勾與數據會全部歸零。\n建議先按「匯出紀錄」備份。')) {
      S = { version: 1, logs: {}, createdAt: new Date().toISOString() };
      save(); render(); toast('已清除');
    }
  }
}

function doExport() {
  var txt = JSON.stringify(S, null, 1);
  var name = '10K教練備份_' + today() + '.json';
  if (navigator.share && navigator.canShare) {
    try {
      var f = new File([txt], name, { type: 'application/json' });
      if (navigator.canShare({ files: [f] })) {
        navigator.share({ files: [f], title: name }).catch(function () {});
        return;
      }
    } catch (e) { /* 掉到下面的複製 */ }
  }
  if (navigator.clipboard) {
    navigator.clipboard.writeText(txt).then(function () {
      toast('備份已複製到剪貼簿');
    }, function () { showRaw(txt); });
  } else showRaw(txt);
}
function showRaw(txt) {
  $('#sheetTitle').textContent = '備份內容（長按全選複製）';
  $('#sheetBody').innerHTML = '<div class="sheet-sub">把這段文字貼到備忘錄存起來。</div>' +
    '<textarea readonly style="width:100%;height:210px;background:var(--card);' +
    'color:var(--tx);border:1px solid var(--line);border-radius:12px;padding:11px;' +
    'font-size:12px;font-family:ui-monospace,monospace">' + esc(txt) + '</textarea>' +
    '<div class="btn-row"><button class="btn ghost" data-close>關閉</button></div>';
  $('#sheet').hidden = false;
}
function doImport() {
  $('#sheetTitle').textContent = '匯入備份';
  $('#sheetBody').innerHTML = '<div class="sheet-sub">把之前匯出的 JSON 貼進來，會覆蓋目前的紀錄。</div>' +
    '<textarea id="impTa" placeholder=\'{"version":1,"logs":{...}}\' style="width:100%;height:180px;' +
    'background:var(--card);color:var(--tx);border:1px solid var(--line);border-radius:12px;' +
    'padding:11px;font-size:12px;font-family:ui-monospace,monospace"></textarea>' +
    '<div class="btn-row"><button class="btn" id="impGo">匯入</button>' +
    '<button class="btn ghost" data-close>取消</button></div>';
  $('#sheet').hidden = false;
  $('#impGo').addEventListener('click', function () {
    try {
      var o = JSON.parse($('#impTa').value);
      if (!o || typeof o.logs !== 'object' || o.logs === null) throw new Error('格式不對：找不到 logs');
      var clean = sanitizeLogs(o.logs);
      var dropped = Object.keys(o.logs).length - Object.keys(clean).length;
      S = { version: 1, logs: clean, createdAt: o.createdAt || new Date().toISOString() };
      save(); closeSheet(); render();
      toast('已匯入 ' + Object.keys(clean).length + ' 筆' + (dropped > 0 ? '（' + dropped + ' 筆格式不符已略過）' : ''));
    } catch (err) { alert('匯入失敗：' + err.message); }
  });
}

/* ── 捷徑帶參數進來（層 2）──
   步頻的處理：HealthKit **沒有跑步步頻**（runningCadence）這個型別。
   有的是 cyclingCadence（自行車，iOS 17+），跑步只有 runningPower／runningSpeed／
   runningStrideLength／runningVerticalOscillation／runningGroundContactTime（iOS 16+）。
   查證範圍：Apple HKQuantityTypeIdentifier 文件頁 ＋ 開發者論壇 thread/708208
   （2026-08-19 查；該串三則回覆皆為社群使用者 boerni／trispo／Lorenz5，
   **不是 Apple 官方回覆**，換算公式 speed = stride × cadence 出自 Lorenz5）。

   🔴 2026-08-19 更正：本來這裡還接受兩種換算來源（步數÷分鐘、速度÷步幅），現已**兩條都廢除**。
   詳細理由與實測數字寫在下方 ingestURL() 內「2. 步頻」那段註解，
   重點只有一句：**步幅法本身不成立，步數法其實準（是我沒跨來源去重才算出 266），
   但捷徑送來的 steps 無法保證已去重，所以一律不收。**

   同一份匯出檔的功率算出 137.56 W、手錶顯示 137 W，證明取樣窗與平均法本身沒問題。

   → 現在只接受 cad（捷徑直接給步頻）。拿不到就留空，由使用者照手錶螢幕手動填。
     舊紀錄殘留的 cadenceDerived 標記保留，UI 標示為換算值，R5 一樣不採用。 */
function ingestURL() {
  var q = new URLSearchParams(location.search);
  if (q.get('log') !== '1') return false;
  var d = q.get('date') || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) d = today();
  if (!sessionOf(d)) {
    toast(md(d) + ' 不是訓練日，已略過');
    history.replaceState(null, '', location.pathname);
    return false;
  }
  var num = function (k, min, max) {
    var v = parseFloat(q.get(k));
    return (isFinite(v) && v >= min && v <= max) ? v : null;
  };
  // 對應到紀錄欄位的參數，範圍一律取自 LOG_NUM（同上，不留第二份定義）
  var numField = function (param, field) {
    var sp = LOG_NUM[field];
    return num(param, sp[0], sp[1]);
  };
  var prev = S.logs[d] || {};

  // 1. 這次 URL 帶來的值
  var uKm  = numField('km',  'km'),
      uMin = numField('min', 'durationMin'),
      uHr  = numField('hr',  'hrAvg'),
      uCad = numField('cad', 'cadence'),
      uRhr = numField('rhr', 'restingHr');

  // 2. 步頻：只收手錶直接給的值，**不再換算**
  //    2026-08-19 拿 8/18 那趟實測，兩條換算路徑的下場不同，理由要分清楚：
  //
  //    ① 步幅法（速度÷步幅）→ 128，手錶 154。**方法本身不成立**：
  //       那趟只有 24 筆步幅樣本卻有 659 筆速度樣本，拿稀疏平均去除密集平均。
  //       （8/14 步幅有 143 筆，算出 144、手錶 143，我當時以為驗證通過——那是巧合。）
  //
  //    ② 步數法（步數÷分鐘）→ 我一開始算出 266，**但那是我的 bug 不是方法的錯**。
  //       只取 Apple Watch 來源重算：8/18＝154.19（手錶 154）、8/14＝144.05（手錶 143），
  //       三種算法裡最準。266 是把 iPhone 重複記錄的步數也加進去了（跨來源沒去重）。
  //
  //    仍然兩條都不留，理由是**捷徑送來的 steps 無法保證已按來源去重**——
  //    一個「大多數時候對、偶爾差 100」的值比沒有更危險，它會讓 R5 誤判、讓趨勢圖說謊。
  //    手動照手錶抄一個數字的成本，遠低於追查一個偶發錯誤。
  var cadence = uCad, derived = false;

  var raw = {
    done: true, source: 'shortcut',
    completedAt: prev.completedAt || new Date().toISOString(),
    km: uKm, durationMin: uMin, hrAvg: uHr, restingHr: uRhr, cadence: cadence,
    rpe: prev.rpe != null ? prev.rpe : null,
    checkpointResult: prev.checkpointResult || null
  };
  // 3. 這次沒帶到的欄位才沿用舊值，不要把已填好的資料清掉
  ['km', 'durationMin', 'hrAvg', 'restingHr'].forEach(function (k) {
    if (raw[k] == null && prev[k] != null) raw[k] = prev[k];
  });
  var reusedCad = false, keptMeasured = false;
  var prevMeasured = (prev.cadence != null && prev.cadenceDerived !== true);
  if (derived && prevMeasured) {
    // 🔴 換算值不得覆蓋手動填的實測值。
    //    ①量測值永遠優於估計值 ②R5 只認實測值，被蓋掉就等於永久失去那個資料點。
    //    捷徑直接給的 cad 不受此限（那也是量測值，走 derived=false 這條）。
    raw.cadence = prev.cadence; derived = false; keptMeasured = true;
  } else if (raw.cadence == null && prev.cadence != null) {
    raw.cadence = prev.cadence; reusedCad = true;
    if (prev.cadenceDerived === true) raw.cadenceDerived = true;
  } else if (derived) {
    raw.cadenceDerived = true;
  }

  var o = sanitizeLog(raw);
  S.logs[d] = o; save();
  history.replaceState(null, '', location.pathname);
  toast('已從手錶同步 ' + md(d) +
    (derived ? '（步頻為換算值）'
     : keptMeasured ? '（步頻保留你填的實測值）'
     : reusedCad ? '（步頻沿用原紀錄）' : ''));
  return true;
}

/* ── 版面 ── */
function render() {
  var v = $('#view');
  var html = TAB === 'today' ? renderToday()
    : TAB === 'week' ? renderWeek()
    : TAB === 'all' ? renderAll()
    : TAB === 'data' ? renderData()
    : renderCoach();
  v.innerHTML = html;
  $$('.tab').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === TAB); });

  var left = daysBetween(today(), PLAN.meta.raceDate);
  var cd = $('#countdown');
  if (left > 0) cd.innerHTML = '距離比賽<b>' + left + ' 天</b>';
  else if (left === 0) cd.innerHTML = '<b>就是今天 🏁</b>';
  else cd.innerHTML = '比賽已結束<b>' + md(PLAN.meta.raceDate) + '</b>';

  var c = coachNow();
  var hot = c.advices.filter(function (a) { return a.level === 'crit' || a.level === 'hot'; }).length;
  var ct = $('.tab[data-tab="coach"]');
  var dot = $('.dot', ct);
  if (hot && !dot) ct.appendChild(el('<span class="dot"></span>'));
  if (!hot && dot) dot.remove();

  $('#brandSub').textContent = 'W' + Coach.currentWeek(PLAN, today());
  v.scrollTop = 0; window.scrollTo(0, 0);
}

/* ── 啟動 ── */
function boot() {
  S = load();
  fetch('plan.json', { cache: 'no-cache' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (p) {
      PLAN = p;
      ingestURL();
      $('#boot').hidden = true;
      $('#app').hidden = false;
      document.addEventListener('click', onTap);
      $('#tabbar').addEventListener('click', function (e) {
        var b = e.target.closest('.tab');
        if (b) { TAB = b.dataset.tab; render(); }
      });
      render();
      if ('serviceWorker' in navigator && location.protocol !== 'file:') {
        navigator.serviceWorker.register('sw.js').catch(function (e) {
          console.warn('Service Worker 註冊失敗', e);
        });
      }
    })
    .catch(function (e) {
      var b = $('#boot');
      b.classList.add('err');
      b.innerHTML = '<div class="boot-mark">!</div><div class="boot-msg">' +
        '課表載不進來。<br><br>錯誤訊息：<br>' + esc(e.message) +
        '<br><br>如果你是直接用檔案開啟這一頁（網址開頭是 file://），' +
        '瀏覽器會擋住讀取課表。請改用網址開啟。</div>';
    });
}
document.addEventListener('DOMContentLoaded', boot);
})();
