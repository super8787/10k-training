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
    // R8 要比「同樣配速下的心率」，配速差太多就沒有可比性。
    // 這個數字 app.js 的規則說明也會印，所以只能有一份。
    PACE_TOL_SEC: 45,
    MISS_STREAK: 2,      // 連續幾次沒完成就降階
    GOOD_STREAK: 3,      // 連續幾次達標就加量
    CP_LEAD_DAYS: 14,    // 檢查點提前幾天開始提醒（條件與文案共用這一份）
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
      /* z2lo 已於 2026-08-22 移除：最後一個讀者是 R1 的「目標區 139-151」，
         而那句話本身就是這輪修掉的缺陷。留一個沒人用的 Z2 值在唯一來源裡，
         跟當初 inZone2() 被整個移除的理由一樣——等於在邀請下一個人把 Z2 指標接回來。 */
      easyCeil:   z ? z.Z2.hi : R.HR_EASY_CEIL,
      /* steadyLo 直接讀 Z3.lo，不要用 easyCeil+1 去推——推導出來的副本跟抄出來的副本
         是同一種東西，權威值就在 plan.meta.zones 裡。
         🔴 取不到就回 null，**不要用 fallback 那組數字補位**。
         整組 fallback 是 {144,160,178,200}，而現行課表產出的是 {151,164,178,190}，
         兩套只有 178 對得上。fallback 唯一會觸發的情境（跨版本存活的舊 plan.json 沒有 zones，
         見 STATE 的 data-v1 段）恰好也是最難發現的情境——那時 R3 會說「Z3（145-160）」
         而課表說 152-164，沒有任何訊號。
         → 慣例照 gctNote()：取不到就把那句話整個省略。 */
      steadyLo:   z ? z.Z3.lo : null,
      steadyCeil: z ? z.Z3.hi : R.HR_STEADY_CEIL,
      ceiling:    z ? z.Z5.lo : R.HR_STEADY_CEIL + 18,   // Z5 下緣＝真的太用力的門檻
      z5hi:       z ? z.Z5.hi : 200
    };
  }
  /* inZone2() 已於 2026-08-21 移除。它最後一個呼叫端是 app.js 的「最重要的一個數字」
     （心率落在 Z2 的比例），而那個指標本身跟這份計畫的模型矛盾——41 堂課的目標帶
     其中 0 堂是 Z2，R3 也早就改用 steadyCeil。留著一個沒人用的 Z2 判定，
     等於在邀請下一個人把那個指標接回來。要看心率壓沒壓住，用該堂自己的 hrHi。 */

  /* 跑走交替的處方只能有一份：課表的檢查點 onFail 裡寫了「跑 N 分走 M 分」，
     那是 build_plan.py 的 RUNWALK_RUN/RUNWALK_WALK 格式化出來的。
     App 端從那裡讀回來，不要自己再寫一個數字。
     取不到就回不帶數字的說法——寧可少講，也不要講一個跟課表不同的數字。 */
  function runWalkNote(plan) {
    /* 🔴 第一版是去正則解析檢查點 onFail 的中文句子。那有兩個問題：
       ① plan.json 是我們自己產的——控制得了產出端卻去解析自己產的散文，
          是主動站到脆弱那一側，而且沒換到任何好處
       ② 它只讀**第一個**檢查點，但 runWalkMode 是 CP1 或 CP2 任一沒過都會觸發。
          今天兩者處方相同所以看不出來，哪天 CP2 改了，它會安靜地印 CP1 的數字
       → 改讀 build_plan.py 直接吐出來的 meta.runWalk。
       舊的離線快取 plan.json 沒有這欄 → 退回不帶數字的說法，一樣 fail-safe。 */
    var rw = plan && plan.meta && plan.meta.runWalk;
    if (rw && typeof rw.run === 'number' && typeof rw.walk === 'number') {
      return '跑 ' + rw.run + ' 分／走 ' + rw.walk + ' 分';
    }
    return '跑一段走一段（比例見課表的檢查點說明）';
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
        /* 門檻是 ceiling（Z5 下緣）不是 steadyCeil。
           2026-08-19 改：他目前用 10 分速慢跑心率就 171，落在 Z4。
           拿 Z3 上緣當門檻會每一趟都判「你又跑太快」，那是雜訊不是提醒。
           真正該提醒的是進到 Z5——那才是慢不下來。 */
        l && typeof l.hrAvg === 'number' && l.hrAvg > T.ceiling;
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
          // 🔴 這裡原本印 zoneLo-easyCeil ＝ 139-151 ＝ Z2，而同一支 App 的教練頁寫
          //    「現在要你待在 Z2 等於整堂走路」。R1 是使用者看得到的建議，兩者直接打架。
          //    第一版改成「上限 164（139 以下都算壓住了）」——139 仍是 Z2 下緣，
          //    在上限模型裡沒有意義，而且會被反過來讀成「140-164 不算壓住」。整句拿掉。
          // 🔴 這裡不能寫 Markdown。focus/detail 一律走 esc()，而 esc() 只轉 & < > " '，
          //    星號會原封不動上螢幕（實測 v78 線上就是這樣）。要強調就用詞不用符號。
          T.ceiling + '（最近一次 ' + lastHr + '）。這個強度慢不下來了。這類課的心率是上限、不是目標，'
          + '壓在 ' + T.steadyCeil + ' 以內就算壓住了，再低都不扣分。' +
          '下一次同類型的課，配速主動放慢 ' + R.PACE_SLOWDOWN +
          ' 秒/公里，長跑目標時間先打 ' + Math.round(R.LONG_CUT_SOFT * 10) +
          ' 折。慢下來不是退步，是能不能跑完 10K 的關鍵。' + nextLongNote(),
        rule: 'R1｜easy/long 課平均心率 > ' + T.ceiling + ' bpm（Z5 下緣）'
      });
    }

    /* applyAdjustments 對檢查點免調整（`&& !s.checkpoint`）。
       所以「長跑砍到 80%」這種話在「下一堂長跑剛好是檢查點」時是假的——
       驗收抓到過：教練頁說砍了，實際那週唯一的長跑是 CP2，一分鐘都沒砍。
       這支回傳一句但書（沒有但書時回空字串），R1／R2／R3 共用。 */
    function nextLongNote() {
      var nl = days.filter(function (d) {
        return d.kind === 'long' && d.date >= todayStr;
      })[0];
      if (!nl) return '';
      return nl.checkpoint
        ? '（不過下一堂長跑是 ' + nl.checkpoint.id + ' 檢查點，測驗不調整——' +
          '那一堂照原訂內容跑，調整從再下一堂長跑開始。）'
        : '';
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
          '先把降階後的量穩穩做完，連續完成 ' + R.GOOD_STREAK + ' 堂就會自動加回來。' +
          nextLongNote(),
        rule: 'R2｜連續 ≥' + R.MISS_STREAK + ' 堂排定課未打勾'
      });
    }

    /* ── R3：表現穩定，可以加量 ── */
    var easyRecent = doneAll.filter(function (d) { return d.kind === 'easy'; }).slice(-R.GOOD_STREAK);
    if (streak === 0 && easyRecent.length === R.GOOD_STREAK) {
      var allInZone = easyRecent.every(function (d) {
        var l = logs[d.date];
        /* 目標是把同樣配速的心率壓進 Z3（他現在在 Z4）。
           用 inZone2 會永遠不成立——Z2 對現在的他等於走路。 */
        return l && typeof l.hrAvg === 'number' && l.hrAvg <= T.steadyCeil;
      });
      if (allInZone) {
        adj.longRunFactor = Math.max(adj.longRunFactor, R.LONG_BOOST);
        adj.reasons.push('R3');
        advices.push({
          id: 'R3', level: 'good', icon: '📈',
          title: '有氧基礎正在長出來',
          // 🔴 下界原本用 z2lo（139）＝ Z2 的下緣，但這句話講的是 Z3。改讀 T.steadyLo（＝Z3.lo）。
          detail: '最近 ' + R.GOOD_STREAK + ' 次輕鬆跑心率都壓進 Z3' +
            // 取不到 Z3 下界就不要講區間——寧可少講一句，也不要講一組跟課表不同的數字
            (T.steadyLo ? '（' + T.steadyLo + '-' + T.steadyCeil + '）' : '') +
            // 省略區間時要留標點，否則變成「壓進 Z3而且都完成了」
            '，而且都完成了。這正是計畫要的。下次長跑可以加 ' +
            Math.round((R.LONG_BOOST - 1) * 100) + '%，但心率規則不變。' + nextLongNote(),
          rule: 'R3｜連續 ' + R.GOOD_STREAK + ' 次 easy 課完成且平均心率 ≤ ' + T.steadyCeil
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

    /* 觸地時間只能有一個來源＝plan.meta.baseline。
       2026-08-19 驗收抓到：這裡硬寫 289ms（8/14 的值），但 baseline 已是 313（8/18）。
       同一個 App 兩個值，而且 289 是比較短的那個——拿它當「你觸地太長」的證據，論證方向是反的。 */
    function gctNote(p) {
      var g = p && p.meta && p.meta.baseline && p.meta.baseline.groundContactMs;
      return g ? '（你的觸地時間 ' + g + 'ms 就是這樣來的）。' : '。';
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
            gctNote(plan) + '下一堂品質課請務必開節拍器，' +
            '小步快踩，腳落在身體正下方。這是降低受傷率最有效的單一動作。',
          rule: 'R5｜最近 ' + R.GOOD_STREAK + ' 次平均步頻 < ' + R.CADENCE_MIN + ' spm'
        });
      }
    }

    /* ── R6：檢查點 ── */
    days.filter(function (d) { return d.checkpoint; }).forEach(function (d) {
      var cp = d.checkpoint, l = logs[d.date];
      /* 🔴 效期由**檢查點自己**帶（build_plan.py 算好放進 plan.json），不要在這裡猜。
         兩個檢查點的效期不一樣：
           CP1 的 onFail 改長跑結構 → 效期到最後一堂可調長跑
           CP2 的 onFail 改比賽日策略 → 效期到比賽日
         上一輪用「還有可調整的長跑」當代理量，對 CP1 對、對 CP2 錯——
         CP2 在賽前 6 天就不再提醒，而那正是最需要決定比賽策略的幾天。
         沒有 effectiveUntil 的舊 plan.json 一律當成還在效期內（fail-open 到「會提醒」，
         寧可多講一次，也不要在該提醒的時候沉默）。 */
      var within = !cp.effectiveUntil || todayStr <= cp.effectiveUntil;
      if (d.date > todayStr) {
        var dl = Math.round((new Date(d.date) - new Date(todayStr)) / 864e5);
        if (dl <= R.CP_LEAD_DAYS) {
          advices.push({
            id: cp.id, level: 'info', icon: '🚩',
            title: cp.id + ' 檢查點還有 ' + dl + ' 天（' + d.date.slice(5).replace('-', '/') + '）',
            detail: '測驗內容：' + cp.test + '。\n通過標準：' + cp.passRule +
              '。\n沒通過的話：' + cp.onFail,
            rule: 'R6｜檢查點 ' + cp.id + ' 於 ' + R.CP_LEAD_DAYS + ' 天內到期'
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
        // 這條原本也沒有上界——賽後 365 天照跳。跟下面那條同一個 forEach、相隔三行、
        // 症狀一模一樣，上一輪只修了下面那條。用同一個 effectiveUntil。
        if (!within) { return; }
        advices.push({
          id: cp.id, level: 'hot', icon: '❓',
          title: cp.id + ' 做完了，但還沒回報結果',
          detail: '請回到「今天」或「本週」點進那天，告訴我有沒有達成：' + cp.passRule +
            '。後半段課表要照這個結果調整。',
          rule: 'R6｜檢查點已完成但 checkpointResult 未填'
        });
      } else if (d.date === todayStr) {
        /* 🔴 檢查點**當天**本來完全沒有提示。
           上面兩條只管「未來 14 天內」與「已完成」，`date === today` 且還沒做
           落在縫裡——他當天打開 App 會看不到任何提醒，而那是全計畫最重要的兩天之一。 */
        advices.push({
          id: cp.id, level: 'hot', icon: '🚩',
          title: '今天就是 ' + cp.id + ' 檢查點',
          detail: '今天要測：' + cp.test + '。\n通過標準：' + cp.passRule +
            '。\n沒通過的話：' + cp.onFail +
            '\n\n跑完記得在紀錄裡回報結果，後半段課表要照這個結果調整。',
          rule: 'R6｜檢查點 ' + cp.id + ' 就在今天'
        });
      } else if (within) {
        /* 日期過了、也沒有完成紀錄＝漏掉了。不提醒的話這個檢查點就靜靜消失，
           而課表後半段的降階判斷正是靠它。
           🔴 上界用 cp.effectiveUntil（見上面 within 的說明）。
              測過：無上界時賽後 365 天仍顯示「過了 405 天」，而且 level='hot'
              會把它排到教練頁最上面。
           🔴 也要分辨「按過今天沒跑」——那是有紀錄的，說「還沒有紀錄」對他是假話。 */
        var late = Math.round((new Date(todayStr) - new Date(d.date)) / 864e5);
        var skipped = l && l.skipped === true;
        advices.push({
          id: cp.id, level: 'hot', icon: '⚠️',
          title: cp.id + ' 檢查點過了 ' + late + ' 天，' + (skipped ? '你標了沒跑' : '還沒有紀錄'),
          detail: '原訂 ' + d.date.slice(5).replace('-', '/') + ' 要測「' + cp.test +
            '」。補做一次或直接回報結果都可以——' +
            '後半段課表要照這個結果決定要不要降階。',
          rule: 'R6｜檢查點 ' + cp.id + (skipped ? ' 已過期且標為未跑' : ' 已過期且無紀錄')
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

    /* ── R8：同樣配速下心率有沒有下降（新模型的核心指標）──
       他現在慢跑就 171，用「有沒有落在某個絕對區間」判斷沒有意義。
       真正代表有氧進步的是：同樣的配速，心率變低。 */
    /* 🔴 只收 durationBasis === 'run'（純跑步時間）的紀錄。
       'total'（捷徑／匯出檔給的整段運動時間，含暖身緩和）算出來的配速系統性慢 30-40%，
       混進來會讓下面那道「配速差 ≤ PACE_TOL_SEC」的閘門開錯，
       而且 R8 會把兩個假配速直接印給他看。
       舊紀錄沒有這個欄位 → 基準未知 → 一樣不收。寧可不觸發，也不要拿錯的兩趟去比。 */
    var paced = doneAll.filter(function (d) {
      var l = logs[d.date];
      return l && l.km > 0 && l.durationMin > 0 && typeof l.hrAvg === 'number'
        && l.durationBasis === 'run';
    });
    if (paced.length >= 4) {
      var half = Math.floor(paced.length / 2);
      var early = paced.slice(0, half), late = paced.slice(-half);
      var mean = function (arr, f) {
        return arr.reduce(function (a, d) { return a + f(logs[d.date]); }, 0) / arr.length;
      };
      var pace = function (l) { return l.durationMin * 60 / l.km; };   // 秒/公里
      var p0 = mean(early, pace), p1 = mean(late, pace);
      var h0 = mean(early, function (l) { return l.hrAvg; });
      var h1 = mean(late, function (l) { return l.hrAvg; });
      var fmt = function (sec) {
        return Math.floor(sec / 60) + "'" + String(Math.round(sec % 60)).padStart(2, '0') + '"';
      };
      if (Math.abs(p1 - p0) <= R.PACE_TOL_SEC) {   // 配速差夠近才有可比性
        if (h1 <= h0 - 3) {
          advices.push({
            id: 'R8', level: 'good', icon: '💚',
            title: '有氧基礎確實在長：同樣配速，心率降了 ' + Math.round(h0 - h1) + ' 下',
            detail: '前期 ' + fmt(p0) + '/km 時平均心率 ' + h0.toFixed(0) +
              '，最近 ' + fmt(p1) + '/km 時是 ' + h1.toFixed(0) + '。' +
              '這就是這份計畫真正要看的東西——不是你跑多快，是同樣的速度變得多輕鬆。',
            rule: 'R8｜配速相近（差 ≤' + R.PACE_TOL_SEC + ' 秒/km）且平均心率下降 ≥3 下'
          });
        } else if (h1 >= h0 + 5) {
          advices.push({
            id: 'R8', level: 'hot', icon: '🫀',
            title: '同樣配速下心率反而上升 ' + Math.round(h1 - h0) + ' 下',
            detail: '前期 ' + fmt(p0) + '/km 時 ' + h0.toFixed(0) + '，最近 ' + fmt(p1) + '/km 時 ' +
              h1.toFixed(0) + '。常見原因是累積疲勞、睡不夠、或快生病。' +
              '這幾天把強度降下來，別急著補課。',
            rule: 'R8｜配速相近但平均心率上升 ≥5 下'
          });
        }
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
  /* plan 是 2026-08-21 新增的第三個參數：跑走交替的處方要從課表的檢查點 onFail 讀，
     不能在這支裡再寫一份數字。沒傳 plan 也不會爆——runWalkNote() 會退回不帶數字的說法。 */
  function applyAdjustments(sess, adj, plan) {
    var s = Object.assign({}, sess), notes = [];
    /* 檢查點不降階。CP1／CP2 的意義就是測「做不做得到那個量」，
       自動降成 6.4K 等於測驗失去意義，而且照降階後的量跑完必然回報未達成，
       反而觸發 runWalkMode 改掉比賽策略。測驗就是測驗。 */
    if (adj.longRunFactor !== 1 && s.kind === 'long' && !s.checkpoint) {
      var f = adj.longRunFactor;
      var m0 = s.runMin, k0 = s.km, t0 = s.totalMin;

      /* ── 走跑交替的課要調「組數」，不是把它改成連續跑 ──
         指示句長這樣：「走 5 分暖身 →（跑 3 分／走 2 分）×5 → 走 5 分緩和」
         Block 1-2 刻意用交替，不能為了對數字就寫成「連續跑 12 分」。
         正確做法是動組數：×5 → ×4，跑步時間跟著變 15 → 12。 */
      var iv = /（跑\s*([\d.]+)\s*分／走\s*([\d.]+)\s*分）×(\d+)/.exec(s.detail || '');
      if (iv && !k0) {
        var runPer = parseFloat(iv[1]), walkPer = parseFloat(iv[2]), reps0 = parseInt(iv[3], 10);
        var fixed = t0 - (runPer + walkPer) * reps0;           // 暖身＋緩和，不動
        var reps = Math.max(1, Math.round(m0 * f / runPer));
        s.runMin = Math.round(runPer * reps);
        s.totalMin = Math.round(fixed + (runPer + walkPer) * reps);
        s.detail = s.detail.replace(iv[0],
          '（跑 ' + iv[1] + ' 分／走 ' + iv[2] + ' 分）×' + reps);
        // 四捨五入後組數沒變就別說「已調整」——會出現「×2 → ×2」這種自相矛盾的註記
        if (reps !== reps0) {
          notes.push('組數 ×' + reps0 + ' → ×' + reps + '（跑步時間 ' + m0 + ' → ' + s.runMin + ' 分）');
        }
      } else {
        var walk = t0 - m0;                                    // 走路時間不隨降階變動
        s.runMin = Math.round(m0 * f);
        s.totalMin = s.runMin + walk;
        if (s.km) { s.km = Math.round(s.km * f * 10) / 10; }
      }

      /* 三個欄位都要改寫。只改 title 的話，同一張卡會出現
         標題「連續 23 分」＋指示句「連續跑 25 分不停」＋重點句「約 54 分鐘」互相打架。 */
      ['title', 'detail', 'focus'].forEach(function (fld) {
        if (k0) s[fld] = retitle(s[fld], k0, s.km);
        s[fld] = retitle(s[fld], m0, s.runMin);
      });

      /* retitle 只在數字唯一出現時才換（換錯位置比不換更糟）。
         碰到「走 8 分暖身 → 連續跑 8 K」這種同一個數字出現兩次的句子它會放棄，
         留下半舊半新的指示。與其讓使用者看到矛盾的兩個數字，不如整句重講。 */
      if (!iv) {
        var stale = k0
          ? new RegExp('(?:^|[^0-9.])' + String(k0).replace('.', '\\.') + '\\s*(?:K|公里)')
          : new RegExp('連續跑\\s*' + m0 + '\\s*分');
        if (stale.test(s.detail)) {
          var w = s.totalMin - s.runMin;
          s.detail = '走 ' + Math.round(w / 2) + ' 分暖身 → ' +
            (s.km ? '連續跑 ' + s.km + ' K' : '連續跑 ' + s.runMin + ' 分不停') +
            ' → 走 ' + (w - Math.round(w / 2)) + ' 分緩和';
          notes.push('指示已依調整後的目標重寫');
        }
      }

      if (k0) {
        notes.push('長跑目標 ' + k0 + ' K → ' + s.km + ' K（' +
          (f < 1 ? '降階' : '加量') + ' ' + Math.round(Math.abs(f - 1) * 100) + '%，' +
          '預估用時 ' + m0 + ' → ' + s.runMin + ' 分）');
      } else if (!iv) {
        notes.push('長跑目標 ' + m0 + ' 分 → ' + s.runMin + ' 分（' +
          (f < 1 ? '降階' : '加量') + ' ' + Math.round(Math.abs(f - 1) * 100) + '%）');
      }
    }
    /* 🔴 檢查點是測驗，任何調整都不套——不是只有長跑量。
       原本只有 longRunFactor 有 `!s.checkpoint` 守衛，配速放慢與跑走交替沒有，
       於是 nextLongNote() 的但書寫「測驗不調整、那一堂照原訂內容跑」，
       而 CP1 的課卡上照樣出現「配速主動放慢 30 秒/公里」——兩個畫面自相矛盾。 */
    if (adj.paceSlowdownSec && !s.checkpoint && (s.kind === 'easy' || s.kind === 'long')) {
      notes.push('配速主動放慢 ' + adj.paceSlowdownSec + ' 秒/公里');
    }
    if (adj.forceCadenceDrill && s.kind === 'quality') {
      notes.push('這堂務必開節拍器（' + (s.cadence || R.CADENCE_TARGET) + ' spm）');
    }
    if (adj.runWalkMode && !s.checkpoint && s.kind === 'long') {
      // 🔴 這個 8 是硬寫的，而檢查點 onFail 的處方是「跑 12 分／走 1 分」
      //    （build_plan.py 的 RUNWALK_RUN/RUNWALK_WALK 已經收斂成一份）。
      //    同一個觸發給兩個處方 → 從課表帶進來，不要在這裡再寫一次。
      notes.push('已切換跑走交替模式：' + runWalkNote(plan) + '，重複到達標');
    }
    return { session: s, notes: notes };
  }

  global.Coach = {
    analyze: analyze, currentWeek: currentWeek,
    applyAdjustments: applyAdjustments, RULES: R, ymd: ymd,
    zonesOf: zonesOf
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
