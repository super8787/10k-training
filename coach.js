/* 10K 教練 — 自動調整引擎
   ============================================================
   設計原則：規則全部寫死在這裡，每條建議都回報「是哪條規則觸發的」。
   不做黑箱推薦——使用者要能自己判斷這條建議合不合理。

   純函式，不碰 DOM、不碰 storage。輸入課表＋紀錄，輸出建議＋調整量。
   ============================================================ */
(function (global) {
  'use strict';

  var R = {
    /* ⚠️ HR_EASY_CEIL / HR_STEADY_CEIL 是 fallback，正式值一律由 zonesOf(plan) 從
       plan.meta.zones 取。它們原本是 0.72×HRMAX / 0.80×HRMAX 的手抄副本——
       HRmax 一改（實測值本來就會重測），這裡不動就會跟課表打架。 */
    HR_EASY_CEIL: 144,   // fallback：Z2 上限
    HR_STEADY_CEIL: 160, // fallback：Z3 上限
    CADENCE_MIN: 150,    // R5 判定門檻；app.js 的 CAD.warn 直接引用這個值
    CADENCE_TARGET: 165, // 目標步頻；課表沒指定時的 fallback
    MISS_STREAK: 2,      // 連續幾次沒完成就降階
    GOOD_STREAK: 3,      // 連續幾次達標就加量
    LONG_CUT: 0.80,      // R2 降階時長跑乘數
    LONG_CUT_SOFT: 0.90, // R1 心率過高時長跑乘數
    LONG_BOOST: 1.10,    // 加量時長跑乘數
    PACE_SLOWDOWN: 30,   // 建議放慢秒數/km
    RHR_JUMP: 7          // 靜止心率比 7 日均值高幾下就建議休息
  };

  /* 心率門檻的唯一來源。plan.meta.zones 是 build_plan.py 從 HRmax 算出來的，
     coach.js 與 app.js 都必須從這裡取，不要各自抄一份數字。 */
  function zonesOf(plan) {
    var z = plan && plan.meta && plan.meta.zones;
    return {
      z2lo:       z ? z.Z2.lo : R.HR_EASY_CEIL - 24,
      easyCeil:   z ? z.Z2.hi : R.HR_EASY_CEIL,
      steadyCeil: z ? z.Z3.hi : R.HR_STEADY_CEIL,
      z5hi:       z ? z.Z5.hi : 200
    };
  }
  function inZone2(plan, v) {
    var t = zonesOf(plan);
    return v >= t.z2lo && v <= t.easyCeil;
  }

  function ymd(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  /* 已過期（含今天之前）且該做的課 */
  function pastSessions(days, todayStr) {
    return days.filter(function (d) {
      return d.date < todayStr && d.kind !== 'race';
    });
  }
  function completed(days, logs) {
    return days.filter(function (d) {
      var l = logs[d.date];
      return l && l.done;
    });
  }

  /* ---------------------------------------------------------- */
  function analyze(plan, logs, todayStr) {
    logs = logs || {};
    todayStr = todayStr || ymd(new Date());
    var days = plan.days;
    var T = zonesOf(plan);
    var zoneLo = T.z2lo;
    var advices = [];
    var adj = {
      paceSlowdownSec: 0,
      longRunFactor: 1,
      forceCadenceDrill: false,
      restToday: false,
      reasons: []
    };

    var past = pastSessions(days, todayStr);
    var doneAll = completed(days, logs).sort(function (a, b) {
      return a.date < b.date ? -1 : 1;
    });
    var recent = doneAll.slice(-6);

    /* ── R1：輕鬆跑／長跑的平均心率太高 ── */
    var hotOnes = recent.filter(function (d) {
      var l = logs[d.date];
      return (d.kind === 'easy' || d.kind === 'long') &&
        l && typeof l.hrAvg === 'number' && l.hrAvg > T.steadyCeil;
    });
    if (hotOnes.length > 0) {
      var last = hotOnes[hotOnes.length - 1];
      var lastHr = logs[last.date].hrAvg;
      adj.paceSlowdownSec = R.PACE_SLOWDOWN;
      adj.longRunFactor = Math.min(adj.longRunFactor, R.LONG_CUT_SOFT);
      adj.reasons.push('R1');
      advices.push({
        id: 'R1', level: hotOnes.length >= 2 ? 'crit' : 'hot', icon: '🔥',
        title: '你又跑太快了',
        detail: '最近 ' + hotOnes.length + ' 次輕鬆／長跑的平均心率超過 ' +
          T.steadyCeil + '（最近一次 ' + lastHr + '）。輕鬆跑該落在 ' +
          zoneLo + '-' + T.easyCeil + '。' +
          '下一次同類型的課，配速主動放慢 ' + R.PACE_SLOWDOWN +
          ' 秒/公里，長跑目標時間先打 ' + Math.round(R.LONG_CUT_SOFT * 10) +
          ' 折。慢下來不是退步，是唯一能讓你跑完 10K 的路。',
        rule: 'R1｜easy/long 課平均心率 > ' + T.steadyCeil + ' bpm'
      });
    }

    /* ── R2：連續沒完成 ── */
    var streak = 0;
    for (var i = past.length - 1; i >= 0; i--) {
      var lg = logs[past[i].date];
      if (lg && lg.done) break;
      streak++;
    }
    if (streak >= R.MISS_STREAK) {
      adj.longRunFactor = Math.min(adj.longRunFactor, R.LONG_CUT);
      adj.reasons.push('R2');
      advices.push({
        id: 'R2', level: 'crit', icon: '⚠️',
        title: '連續 ' + streak + ' 堂沒完成，本週自動降階',
        detail: '長跑目標砍到 ' + Math.round(R.LONG_CUT * 100) + '%。' +
          '這不是懲罰——身體跟不上原本的量，硬撐只會受傷。' +
          '先把降階後的量穩穩做完，連續完成 ' + R.GOOD_STREAK + ' 堂就會自動加回來。',
        rule: 'R2｜連續 ≥' + R.MISS_STREAK + ' 堂排定課未打勾'
      });
    }

    /* ── R3：表現穩定，可以加量 ── */
    var easyRecent = doneAll.filter(function (d) { return d.kind === 'easy'; }).slice(-R.GOOD_STREAK);
    if (streak === 0 && easyRecent.length === R.GOOD_STREAK) {
      var allInZone = easyRecent.every(function (d) {
        var l = logs[d.date];
        return l && typeof l.hrAvg === 'number' && inZone2(plan, l.hrAvg);
      });
      if (allInZone) {
        adj.longRunFactor = Math.max(adj.longRunFactor, R.LONG_BOOST);
        adj.reasons.push('R3');
        advices.push({
          id: 'R3', level: 'good', icon: '📈',
          title: '有氧基礎正在長出來',
          detail: '最近 ' + R.GOOD_STREAK + ' 次輕鬆跑心率都待在 Z2（' + T.z2lo + '-' + T.easyCeil +
            '）而且都完成了。這正是計畫要的。下次長跑可以加 ' +
            Math.round((R.LONG_BOOST - 1) * 100) + '%，但心率規則不變。',
          rule: 'R3｜連續 ' + R.GOOD_STREAK + ' 次 easy 課完成且平均心率落在 Z2（' + T.z2lo + '-' + T.easyCeil + '）'
        });
      }
    }

    /* ── R4：靜止心率升高（需要層 2 捷徑資料）── */
    var rhrLogs = doneAll.filter(function (d) {
      return logs[d.date] && typeof logs[d.date].restingHr === 'number';
    }).slice(-8);
    if (rhrLogs.length >= 4) {
      var vals = rhrLogs.map(function (d) { return logs[d.date].restingHr; });
      var latest = vals[vals.length - 1];
      var base = vals.slice(0, -1);
      var mean = base.reduce(function (a, b) { return a + b; }, 0) / base.length;
      if (latest - mean >= R.RHR_JUMP) {
        adj.restToday = true;
        adj.reasons.push('R4');
        advices.push({
          id: 'R4', level: 'crit', icon: '🛌',
          title: '今天建議改休息',
          detail: '靜止心率 ' + latest + '，比近期平均 ' + mean.toFixed(0) + ' 高了 ' +
            (latest - mean).toFixed(0) + ' 下。這通常是累積疲勞或快生病的前兆。' +
            '今天休息一天，比硬跑一堂划算得多。',
          rule: 'R4｜靜止心率 − 近期均值 ≥ ' + R.RHR_JUMP + ' bpm'
        });
      }
    }

    /* ── R5：步頻偏低 ──
       只採用「實測」步頻。換算值（cadenceDerived）不參與，因為 HealthKit 沒有跑步步頻型別，
       換算值受步幅估計誤差影響，不足以拿來改課表。實測值＝使用者在手錶上看到數字後手動填的。 */
    var cadLogs = doneAll.filter(function (d) {
      var l = logs[d.date];
      return l && typeof l.cadence === 'number' && l.cadenceDerived !== true;
    }).slice(-R.GOOD_STREAK);
    if (cadLogs.length === R.GOOD_STREAK) {
      var cadAvg = cadLogs.reduce(function (a, d) {
        return a + logs[d.date].cadence; }, 0) / cadLogs.length;
      if (cadAvg < R.CADENCE_MIN) {
        adj.forceCadenceDrill = true;
        adj.reasons.push('R5');
        advices.push({
          id: 'R5', level: 'hot', icon: '🥁',
          // 用 toFixed(0) 會把 149.67 顯示成 150，跟「< 150」的規則自相矛盾。
          title: '步頻還是偏低（' + cadAvg.toFixed(1) + ' 步/分）',
          detail: '最近 ' + R.GOOD_STREAK + ' 次平均 ' + cadAvg.toFixed(1) +
            '，低於 ' + R.CADENCE_MIN + '。步頻低代表你在跨大步、騰空久、落地衝擊大' +
            '（你的觸地時間 289ms 就是這樣來的）。下一堂品質課請務必開節拍器，' +
            '小步快踩，腳落在身體正下方。這是降低受傷率最有效的單一動作。',
          rule: 'R5｜最近 ' + R.GOOD_STREAK + ' 次平均步頻 < ' + R.CADENCE_MIN + ' spm'
        });
      }
    }

    /* ── R6：檢查點 ── */
    days.filter(function (d) { return d.checkpoint; }).forEach(function (d) {
      var cp = d.checkpoint, l = logs[d.date];
      if (d.date > todayStr) {
        var dl = Math.round((new Date(d.date) - new Date(todayStr)) / 864e5);
        if (dl <= 14) {
          advices.push({
            id: cp.id, level: 'info', icon: '🚩',
            title: cp.id + ' 檢查點還有 ' + dl + ' 天（' + d.date.slice(5).replace('-', '/') + '）',
            detail: '測驗內容：' + cp.test + '。\n通過標準：' + cp.passRule +
              '。\n沒通過的話：' + cp.onFail,
            rule: 'R6｜檢查點 ' + cp.id + ' 於 14 天內到期'
          });
        }
      } else if (l && l.done && l.checkpointResult) {
        var pass = l.checkpointResult === 'pass';
        advices.push({
          id: cp.id, level: pass ? 'good' : 'hot', icon: pass ? '✅' : '🔁',
          title: cp.id + (pass ? ' 通過' : ' 未通過，課表已切換'),
          detail: pass
            ? '你達成了「' + cp.test + '」。原訂目標「全程不走完賽」繼續有效。'
            : cp.onFail,
          rule: 'R6｜檢查點 ' + cp.id + ' 已回報結果：' + l.checkpointResult
        });
        if (!pass) { adj.runWalkMode = true; adj.reasons.push('R6-fail'); }
      } else if (l && l.done) {
        advices.push({
          id: cp.id, level: 'hot', icon: '❓',
          title: cp.id + ' 做完了，但還沒回報結果',
          detail: '請回到「今天」或「本週」點進那天，告訴我有沒有達成：' + cp.passRule +
            '。後半段課表要照這個結果調整。',
          rule: 'R6｜檢查點已完成但 checkpointResult 未填'
        });
      }
    });

    /* ── R7：本週進度 ── */
    var wkNow = currentWeek(plan, todayStr);
    if (wkNow) {
      var wkDays = days.filter(function (d) { return d.week === wkNow; });
      var wkPast = wkDays.filter(function (d) { return d.date < todayStr; });
      var wkDone = wkPast.filter(function (d) { return logs[d.date] && logs[d.date].done; });
      if (wkPast.length >= 2 && wkDone.length / wkPast.length < 0.5 && streak < R.MISS_STREAK) {
        advices.push({
          id: 'R7', level: 'hot', icon: '📅',
          title: '本週進度落後',
          detail: '這週已排 ' + wkPast.length + ' 堂，完成 ' + wkDone.length +
            ' 堂。剩下的課還來得及，但別想著「補回來」——補課補出來的疲勞比跳過一堂更傷。' +
            '照原本的課表往下走就好。',
          rule: 'R7｜本週已過課程完成率 < 50%'
        });
      }
    }

    /* ── 全都沒事 ── */
    if (advices.length === 0) {
      advices.push({
        id: 'OK', level: 'good', icon: '👍',
        title: '目前沒有需要調整的地方',
        detail: doneAll.length === 0
          ? '還沒有訓練紀錄。跑完第一堂並記錄之後，這裡就會開始依你的實際數據給建議。'
          : '已完成 ' + doneAll.length + ' 堂，數據看起來都在該在的範圍。照課表走就好。',
        rule: '七條規則全部未觸發'
      });
    }

    var order = { crit: 0, hot: 1, info: 2, good: 3 };
    advices.sort(function (a, b) { return order[a.level] - order[b.level]; });
    return { advices: advices, adjustments: adj };
  }

  /* 目前第幾週（比賽後回傳最後一週） */
  function currentWeek(plan, todayStr) {
    var days = plan.days;
    if (todayStr < days[0].date) return days[0].week;
    var wk = null;
    for (var i = 0; i < days.length; i++) {
      if (days[i].date <= todayStr) wk = days[i].week;
    }
    if (wk === null) return days[0].week;
    // 若今天晚於該週最後一堂，且還有下一週，就進到下一週
    var lastOfWk = days.filter(function (d) { return d.week === wk; }).pop();
    if (todayStr > lastOfWk.date) {
      var next = days.find(function (d) { return d.week === wk + 1; });
      if (next) return wk + 1;
    }
    return wk;
  }

  /* 標題裡的數字要跟著調整走，否則會出現「標題寫 12 分、數字卡寫 10 分」的矛盾。
     只在該數字於標題中剛好出現一次時才替換，避免改到不相干的數字。 */
  function retitle(title, from, to) {
    var a = String(from), parts = String(title).split(a);
    return parts.length === 2 ? parts[0] + String(to) + parts[1] : title;
  }

  /* 把調整量套到單一堂課，回傳 {session, notes[]} */
  function applyAdjustments(sess, adj) {
    var s = Object.assign({}, sess), notes = [];
    if (adj.longRunFactor !== 1 && (s.kind === 'long')) {
      var f = adj.longRunFactor;
      var walk = s.totalMin - s.runMin;   // 走路（暖身/緩和）時間不隨降階變動
      var m0 = s.runMin, k0 = s.km;
      s.runMin = Math.round(s.runMin * f);
      s.totalMin = s.runMin + walk;
      if (s.km) { s.km = Math.round(s.km * f * 10) / 10; }
      /* 三個欄位都要改寫。只改 title 的話，同一張卡會出現
         標題「連續 23 分」＋指示句「連續跑 25 分不停」＋重點句「約 54 分鐘」互相打架。 */
      ['title', 'detail', 'focus'].forEach(function (fld) {
        if (k0) s[fld] = retitle(s[fld], k0, s.km);
        s[fld] = retitle(s[fld], m0, s.runMin);
      });
      /* retitle 只在數字唯一出現時才換（換錯位置比不換更糟）。
         碰到「走 8 分暖身 → 連續跑 8 K」這種同一個數字出現兩次的句子它會放棄，
         留下半舊半新的指示。與其讓使用者看到矛盾的兩個數字，不如整句重講。 */
      var stale = k0
        ? new RegExp('(?:^|[^0-9.])' + String(k0).replace('.', '\\.') + '\\s*(?:K|公里)')
        : new RegExp('連續跑\\s*' + m0 + '\\s*分');
      if (stale.test(s.detail)) {
        s.detail = '走 ' + Math.round(walk / 2) + ' 分暖身 → ' +
          (s.km ? '連續跑 ' + s.km + ' K' : '連續跑 ' + s.runMin + ' 分不停') +
          ' → 走 ' + (walk - Math.round(walk / 2)) + ' 分緩和';
        notes.push('指示已依調整後的目標重寫');
      }
      if (k0) {
        notes.push('長跑目標 ' + k0 + ' K → ' + s.km + ' K（' +
          (f < 1 ? '降階' : '加量') + ' ' + Math.round(Math.abs(f - 1) * 100) + '%，' +
          '預估用時 ' + m0 + ' → ' + s.runMin + ' 分）');
      } else {
        notes.push('長跑目標 ' + m0 + ' 分 → ' + s.runMin + ' 分（' +
          (f < 1 ? '降階' : '加量') + ' ' + Math.round(Math.abs(f - 1) * 100) + '%）');
      }
    }
    if (adj.paceSlowdownSec && (s.kind === 'easy' || s.kind === 'long')) {
      notes.push('配速主動放慢 ' + adj.paceSlowdownSec + ' 秒/公里');
    }
    if (adj.forceCadenceDrill && s.kind === 'quality') {
      notes.push('這堂務必開節拍器（' + (s.cadence || R.CADENCE_TARGET) + ' spm）');
    }
    if (adj.runWalkMode && s.kind === 'long') {
      notes.push('已切換跑走交替模式：跑 8 分／走 1 分，重複到達標');
    }
    return { session: s, notes: notes };
  }

  global.Coach = {
    analyze: analyze, currentWeek: currentWeek,
    applyAdjustments: applyAdjustments, RULES: R, ymd: ymd,
    zonesOf: zonesOf, inZone2: inZone2
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
