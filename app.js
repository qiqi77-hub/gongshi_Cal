(function () {
  "use strict";

  var STORAGE_KEY = "worktime-calculator-v1";
  var MIGRATION_PREFILL_KEY = "worktime-migration-v4-prefill";

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function toYMD(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function parseYMD(s) {
    var p = s.split("-").map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  function isWeekday(d) {
    var w = d.getDay();
    return w >= 1 && w <= 5;
  }

  function formatRangeCN(monday) {
    var sun = new Date(monday);
    sun.setDate(monday.getDate() + 6);
    return (
      monday.getMonth() +
      1 +
      "/" +
      monday.getDate() +
      " – " +
      (sun.getMonth() + 1) +
      "/" +
      sun.getDate()
    );
  }

  function getLunchWindowForDate(ymd) {
    var d = parseYMD(ymd);
    return {
      start: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0),
      end: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 13, 30, 0, 0),
    };
  }

  function overlapMs(a0, a1, b0, b1) {
    var s = Math.max(a0.getTime(), b0.getTime());
    var e = Math.min(a1.getTime(), b1.getTime());
    return Math.max(0, e - s);
  }

  function netWorkMsForDay(ymd, clockInIso, clockOutIso) {
    if (!clockInIso || !clockOutIso) return 0;
    var start = new Date(clockInIso);
    var end = new Date(clockOutIso);
    if (!(end > start)) return 0;
    var lunch = getLunchWindowForDate(ymd);
    var gross = end - start;
    var lunchOverlap = overlapMs(start, end, lunch.start, lunch.end);
    return gross - lunchOverlap;
  }

  function formatHM(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function hmFromIso(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  /** ymd = YYYY-MM-DD，hm 为 input[type=time] 的 HH:mm */
  function isoFromYmdHM(ymd, hm) {
    if (!hm) return null;
    var parts = hm.split(":");
    var h = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    if (isNaN(h) || isNaN(m)) return null;
    var dp = parseYMD(ymd);
    return new Date(dp.getFullYear(), dp.getMonth(), dp.getDate(), h, m, 0, 0).toISOString();
  }

  function dayAtMidnightTs(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  /** 本年按周统计的起始：上周一 0:00（含当天） */
  function getYearStatsCutoffMonday(anchorDate) {
    var thisMon = mondayOfSameWeek(anchorDate);
    var cut = new Date(thisMon);
    cut.setDate(thisMon.getDate() - 7);
    cut.setHours(0, 0, 0, 0);
    return cut;
  }

  var DEFAULT_MORNING_H = 9;
  var DEFAULT_MORNING_M = 21;

  /**
   * 同一天内傍晚误点「上班」：上下班均在 18:00 后且间隔 ≤3 小时 → 将上班时间改为当日 9:21（仅改 clockIn，不动 punchedInAt）
   */
  function fixEveningMisclickClockIn(state, anchorDate) {
    var ymd = toYMD(anchorDate);
    var rec = state.days[ymd];
    if (!rec || !rec.clockIn || !rec.clockOut) return false;
    var start = new Date(rec.clockIn);
    var end = new Date(rec.clockOut);
    if (toYMD(start) !== ymd || toYMD(end) !== ymd) return false;
    if (!(end > start)) return false;
    if (start.getHours() < 18 || end.getHours() < 18) return false;
    var gross = end.getTime() - start.getTime();
    if (gross > 3 * 3600000) return false;
    rec.clockIn = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate(),
      DEFAULT_MORNING_H,
      DEFAULT_MORNING_M,
      0,
      0
    ).toISOString();
    return true;
  }

  function formatHoursMinutes(ms) {
    if (ms <= 0) return "0 小时";
    var m = Math.round(ms / 60000);
    var h = Math.floor(m / 60);
    var r = m % 60;
    if (r === 0) return h + " 小时";
    return h + " 小时 " + r + " 分";
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { days: {}, leaves: {}, meta: {} };
      var o = JSON.parse(raw);
      return {
        days: o.days && typeof o.days === "object" ? o.days : {},
        leaves: o.leaves && typeof o.leaves === "object" ? o.leaves : {},
        meta: o.meta && typeof o.meta === "object" ? o.meta : {},
      };
    } catch (e) {
      return { days: {}, leaves: {}, meta: {} };
    }
  }

  var _fc = window.firebaseConfig;
  var cloudEnabled =
    !window.__firebaseCdnFailed &&
    typeof firebase !== "undefined" &&
    _fc &&
    _fc.apiKey &&
    String(_fc.apiKey).length > 6 &&
    _fc.projectId &&
    String(_fc.projectId).length > 0;

  var currentUser = null;
  var cloudSaveTimer = null;

  function saveState(state) {
    var payload = {
      days: state.days,
      leaves: state.leaves,
      meta: state.meta || {},
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    scheduleCloudSave();
  }

  function scheduleCloudSave() {
    if (!cloudEnabled || !currentUser) return;
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = setTimeout(function () {
      var payload = {
        days: state.days || {},
        leaves: state.leaves || {},
        meta: state.meta || {},
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      };
      firebase
        .firestore()
        .collection("users")
        .doc(currentUser.uid)
        .set(payload, { merge: true })
        .catch(function (e) {
          console.error("云端保存失败", e);
        });
    }, 700);
  }

  /** 最近一次「上班打卡」的本地时间，用于次日 6:00 前禁止再次上班打卡 */
  function nextUnlockAfterClockIn(clockInIso) {
    var t = new Date(clockInIso);
    return new Date(
      t.getFullYear(),
      t.getMonth(),
      t.getDate() + 1,
      6,
      0,
      0,
      0
    );
  }

  function canClickClockIn(state, now) {
    var last = state.meta && state.meta.lastClockInAt;
    if (!last) return true;
    return now.getTime() >= nextUnlockAfterClockIn(last).getTime();
  }

  function runPrefillMigration(state) {
    if (localStorage.getItem(MIGRATION_PREFILL_KEY)) return;
    var thisMon = mondayOfSameWeek(new Date());
    var lastMon = new Date(thisMon);
    lastMon.setDate(thisMon.getDate() - 7);
    var i;
    for (i = 0; i < 5; i++) {
      var d = new Date(lastMon);
      d.setDate(lastMon.getDate() + i);
      if (!isWeekday(d)) continue;
      var ymd = toYMD(d);
      if (!state.days[ymd]) state.days[ymd] = {};
      if (!state.days[ymd].clockIn) {
        var y = d.getFullYear();
        var m = d.getMonth();
        var dd = d.getDate();
        state.days[ymd].clockIn = new Date(y, m, dd, 9, 40, 0, 0).toISOString();
        state.days[ymd].clockOut = new Date(y, m, dd, 20, 59, 0, 0).toISOString();
      }
    }
    var t = new Date();
    var tymd = toYMD(t);
    if (!state.days[tymd]) state.days[tymd] = {};
    if (!state.days[tymd].clockIn) {
      var inAt = new Date(t.getFullYear(), t.getMonth(), t.getDate(), 9, 21, 0, 0);
      var inIso = inAt.toISOString();
      state.days[tymd].clockIn = inIso;
      state.days[tymd].punchedInAt = inIso;
      if (!state.meta) state.meta = {};
      state.meta.lastClockInAt = inIso;
    }
    localStorage.setItem(MIGRATION_PREFILL_KEY, "1");
    saveState(state);
  }

  /** 从已有打卡补全 lastClockInAt：取 punchedInAt（真实点击）或 clockIn 中最晚一条 */
  function ensureLastClockInMeta(state) {
    if (!state.meta) state.meta = {};
    if (state.meta.lastClockInAt) return;
    var best = null;
    Object.keys(state.days).forEach(function (ymd) {
      var rec = state.days[ymd];
      if (!rec) return;
      var cin = rec.punchedInAt || rec.clockIn;
      if (!cin) return;
      if (!best || new Date(cin).getTime() > new Date(best).getTime()) best = cin;
    });
    if (best) state.meta.lastClockInAt = best;
  }

  function getLeave(state, ymd) {
    return state.leaves[ymd] || null;
  }

  /** Effective workday weight for stats denominator (weekdays only caller filters) */
  function leaveWeight(leave) {
    if (!leave) return 1;
    if (leave.type === "full") return 0;
    if (leave.type === "half") return 0.5;
    return 1;
  }

  function leaveLabel(leave) {
    if (!leave) return "";
    if (leave.type === "full") return "全天假";
    if (leave.type === "half" && leave.part === "morning") return "半天假（上午）";
    if (leave.type === "half" && leave.part === "afternoon") return "半天假（下午）";
    return "请假";
  }

  function mondayOfSameWeek(d) {
    var date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var day = date.getDay();
    var diff = day === 0 ? -6 : 1 - day;
    date.setDate(date.getDate() + diff);
    return date;
  }

  function iterateWeekdaysInRange(start, end, fn) {
    var cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    var last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    while (cur <= last) {
      if (isWeekday(cur)) fn(toYMD(cur), cur);
      cur.setDate(cur.getDate() + 1);
    }
  }

  /**
   * 本周统计：分母 = 当周「已打上下班卡」的工作日天数（1 天算 1）。
   * 未到的工作日、只打上班未下班、全天假不计入分母。
   */
  function computeWeekStats(state, anchorDate) {
    var mon = mondayOfSameWeek(anchorDate);
    var sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    var totalMs = 0;
    var workedDays = 0;
    iterateWeekdaysInRange(mon, sun, function (ymd) {
      var leave = getLeave(state, ymd);
      if (leave && leave.type === "full") return;
      var day = state.days[ymd];
      if (day && day.clockIn && day.clockOut) {
        totalMs += netWorkMsForDay(ymd, day.clockIn, day.clockOut);
        workedDays += 1;
      }
    });
    return { totalMs: totalMs, denom: workedDays, mon: mon, sun: sun };
  }

  /** 按周汇总：每周分母 = 该周实际「已打上下班卡」的工作日天数（与本周日均规则一致） */
  function collectYearWeeks(state, year, cutoffMonday) {
    var map = {};
    var start = new Date(year, 0, 1);
    var end = new Date(year, 11, 31);
    var cutTs = cutoffMonday ? dayAtMidnightTs(cutoffMonday) : null;
    iterateWeekdaysInRange(start, end, function (ymd, d) {
      if (cutTs !== null && dayAtMidnightTs(d) < cutTs) return;
      var leave = getLeave(state, ymd);
      if (leave && leave.type === "full") return;
      var day = state.days[ymd];
      if (!day || !day.clockIn || !day.clockOut) return;
      var mon = mondayOfSameWeek(parseYMD(ymd));
      var key = toYMD(mon);
      if (!map[key]) {
        map[key] = { mon: mon, totalMs: 0, denom: 0 };
      }
      map[key].denom += 1;
      map[key].totalMs += netWorkMsForDay(ymd, day.clockIn, day.clockOut);
    });
    var rows = Object.keys(map)
      .map(function (k) {
        return map[k];
      })
      .sort(function (a, b) {
        return a.mon - b.mon;
      });
    rows.forEach(function (r, i) {
      r.weekIndex = i + 1;
    });
    return rows;
  }

  var state = { days: {}, leaves: {}, meta: {} };

  var elAuthPanel = document.getElementById("authPanel");
  var elMainApp = document.getElementById("mainApp");
  var elUserBar = document.getElementById("userBar");
  var elUserEmail = document.getElementById("userEmail");
  var elSyncHint = document.getElementById("syncHint");
  var elAuthEmail = document.getElementById("authEmail");
  var elAuthPassword = document.getElementById("authPassword");
  var elBtnAuthLogin = document.getElementById("btnAuthLogin");
  var elBtnAuthRegister = document.getElementById("btnAuthRegister");
  var elBtnLogout = document.getElementById("btnLogout");
  var elAuthError = document.getElementById("authError");

  var elTodayLabel = document.getElementById("todayLabel");
  var elClockIn = document.getElementById("clockInDisplay");
  var elClockOut = document.getElementById("clockOutDisplay");
  var elTodayMeta = document.getElementById("todayMeta");
  var elBtnIn = document.getElementById("btnClockIn");
  var elBtnOut = document.getElementById("btnClockOut");
  var elWeekTotal = document.getElementById("weekTotal");
  var elWeekAvg = document.getElementById("weekAvg");
  var elYearWeekAvg = document.getElementById("yearWeekAvg");
  var elYearTableBody = document.querySelector("#yearWeekTable tbody");
  var elLeaveDate = document.getElementById("leaveDate");
  var elLeaveType = document.getElementById("leaveType");
  var elHalfOptions = document.getElementById("halfOptions");
  var elBtnLeave = document.getElementById("btnLeave");
  var elLeaveList = document.getElementById("leaveList");
  var elCorrectIn = document.getElementById("correctIn");
  var elCorrectOut = document.getElementById("correctOut");
  var elBtnApplyCorrect = document.getElementById("btnApplyCorrect");
  var elBtnQuickMorning921 = document.getElementById("btnQuickMorning921");

  function todayYMD() {
    return toYMD(new Date());
  }

  function setAuthError(msg) {
    if (elAuthError) elAuthError.textContent = msg || "";
  }

  function applyLocalBootstrap() {
    state = loadState();
    if (!state.meta) state.meta = {};
    if (!cloudEnabled) runPrefillMigration(state);
    if (fixEveningMisclickClockIn(state, new Date())) saveState(state);
    ensureLastClockInMeta(state);
    saveState(state);
  }

  function updateSyncFooter() {
    if (!elSyncHint) return;
    if (cloudEnabled && currentUser) {
      elSyncHint.textContent = "已登录：数据已同步到云端，并备份在本机浏览器。";
    } else {
      elSyncHint.textContent = "数据保存在本机浏览器（localStorage）。";
    }
  }

  function showMainUi() {
    if (elAuthPanel) elAuthPanel.classList.add("hidden");
    if (elMainApp) elMainApp.classList.remove("hidden");
    if (elUserBar) elUserBar.classList.toggle("hidden", !(cloudEnabled && currentUser));
    if (elUserEmail) elUserEmail.textContent = (currentUser && currentUser.email) || "";
    updateSyncFooter();
    render();
  }

  function showAuthUi() {
    if (elMainApp) elMainApp.classList.add("hidden");
    if (elAuthPanel) elAuthPanel.classList.remove("hidden");
    if (elUserBar) elUserBar.classList.add("hidden");
    setAuthError("");
  }

  function loadFromCloudThenRender() {
    if (!currentUser) return;
    firebase
      .firestore()
      .collection("users")
      .doc(currentUser.uid)
      .get()
      .then(function (snap) {
        if (snap.exists) {
          var d = snap.data();
          state.days = d.days && typeof d.days === "object" ? d.days : {};
          state.leaves = d.leaves && typeof d.leaves === "object" ? d.leaves : {};
          state.meta = d.meta && typeof d.meta === "object" ? d.meta : {};
        } else {
          applyLocalBootstrap();
        }
        if (!state.meta) state.meta = {};
        ensureLastClockInMeta(state);
        if (fixEveningMisclickClockIn(state, new Date())) saveState(state);
        else saveState(state);
        showMainUi();
      })
      .catch(function (e) {
        setAuthError("读取云端失败：" + e.message);
      });
  }

  function initCloud() {
    if (elMainApp) elMainApp.classList.add("hidden");
    if (elAuthPanel) elAuthPanel.classList.remove("hidden");
    firebase.initializeApp(window.firebaseConfig);
    firebase.auth().onAuthStateChanged(function (user) {
      currentUser = user;
      setAuthError("");
      if (user) {
        loadFromCloudThenRender();
      } else {
        state = { days: {}, leaves: {}, meta: {} };
        showAuthUi();
      }
    });
  }

  function render() {
    var now = new Date();
    var ymd = todayYMD();
    var opts = { weekday: "long", year: "numeric", month: "long", day: "numeric" };
    elTodayLabel.textContent = now.toLocaleDateString("zh-CN", opts);

    var dayRec = state.days[ymd] || {};
    elClockIn.textContent = formatHM(dayRec.clockIn);
    elClockOut.textContent = formatHM(dayRec.clockOut);

    var leave = getLeave(state, ymd);
    var netMs = netWorkMsForDay(ymd, dayRec.clockIn, dayRec.clockOut);
    var meta = "";
    if (leave) {
      meta +=
        '<span class="leave-badge">今日：' + leaveLabel(leave) + "（分母已扣减）</span>";
    }
    if (dayRec.clockIn && dayRec.clockOut) {
      meta +=
        (meta ? " · " : "") +
        "今日净工时（已扣午休）<strong>" +
        formatHoursMinutes(netMs) +
        "</strong>";
    } else if (dayRec.clockIn && !dayRec.clockOut) {
      meta += (meta ? " · " : "") + "尚未打下班卡";
    }
    elTodayMeta.innerHTML = meta || "点击按钮记录上下班时间";

    var canIn = canClickClockIn(state, now);
    elBtnIn.disabled = !canIn;
    elBtnIn.title = canIn
      ? ""
      : "已打过上班卡，次日 6:00 后可再次上班打卡";

    elBtnOut.disabled = !dayRec.clockIn;

    if (elCorrectIn && elCorrectOut) {
      elCorrectIn.value = dayRec.clockIn ? hmFromIso(dayRec.clockIn) : "";
      elCorrectOut.value = dayRec.clockOut ? hmFromIso(dayRec.clockOut) : "";
    }

    var wk = computeWeekStats(state, now);
    elWeekTotal.textContent = formatHoursMinutes(wk.totalMs) + "（本周已打卡日合计）";
    elWeekAvg.textContent =
      wk.denom > 0
        ? formatHoursMinutes(wk.totalMs / wk.denom) + " / 天"
        : "—（本周尚无完整打卡日）";

    var y = now.getFullYear();
    var cutoffMon = getYearStatsCutoffMonday(now);
    var yearRows = collectYearWeeks(state, y, cutoffMon);
    var thisWeekMonTs = dayAtMidnightTs(mondayOfSameWeek(now));
    yearRows = yearRows.filter(function (r) {
      return dayAtMidnightTs(r.mon) <= thisWeekMonTs;
    });
    yearRows.forEach(function (r, i) {
      r.weekIndex = i + 1;
    });
    var yearTotalMs = 0;
    var yearDenom = 0;
    yearRows.forEach(function (r) {
      yearTotalMs += r.totalMs;
      yearDenom += r.denom;
    });
    elYearWeekAvg.textContent =
      yearDenom > 0
        ? formatHoursMinutes(yearTotalMs / yearDenom) + " / 天"
        : "—";

    elYearTableBody.innerHTML = "";
    yearRows.forEach(function (r) {
      var tr = document.createElement("tr");
      var perDay =
        r.denom > 0 ? formatHoursMinutes(r.totalMs / r.denom) : "—";
      tr.innerHTML =
        "<td>第 " +
        r.weekIndex +
        " 周</td>" +
        "<td>" +
        formatRangeCN(r.mon) +
        "</td>" +
        '<td class="num">' +
        formatHoursMinutes(r.totalMs) +
        "</td>" +
        '<td class="num">' + r.denom + "</td>" +
        '<td class="num">' +
        perDay +
        "</td>";
      elYearTableBody.appendChild(tr);
    });

    var leaveKeys = Object.keys(state.leaves).sort();
    elLeaveList.innerHTML = "";
    if (leaveKeys.length === 0) {
      var empty = document.createElement("li");
      empty.className = "leave-desc";
      empty.textContent = "暂无登记";
      elLeaveList.appendChild(empty);
    } else {
      leaveKeys.forEach(function (k) {
        var lv = state.leaves[k];
        var li = document.createElement("li");
        var span = document.createElement("span");
        span.className = "leave-desc";
        span.innerHTML = "<strong>" + k + "</strong> · " + leaveLabel(lv);
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn btn-ghost";
        btn.textContent = "销假";
        btn.setAttribute("data-ymd", k);
        btn.addEventListener("click", function () {
          delete state.leaves[k];
          saveState(state);
          render();
        });
        li.appendChild(span);
        li.appendChild(btn);
        elLeaveList.appendChild(li);
      });
    }
  }

  elBtnIn.addEventListener("click", function () {
    var now = new Date();
    if (!canClickClockIn(state, now)) return;
    var ymd = todayYMD();
    if (!state.days[ymd]) state.days[ymd] = {};
    var nextIn = now.toISOString();
    state.days[ymd].clockIn = nextIn;
    state.days[ymd].punchedInAt = nextIn;
    if (!state.meta) state.meta = {};
    state.meta.lastClockInAt = nextIn;
    var outIso = state.days[ymd].clockOut;
    if (outIso && new Date(outIso) <= new Date(nextIn)) {
      delete state.days[ymd].clockOut;
    }
    saveState(state);
    render();
  });

  elBtnOut.addEventListener("click", function () {
    var ymd = todayYMD();
    if (!state.days[ymd] || !state.days[ymd].clockIn) return;
    state.days[ymd].clockOut = new Date().toISOString();
    saveState(state);
    render();
  });

  function applyTodayTimesFromHM(inHm, outHm) {
    var ymd = todayYMD();
    if (!state.days[ymd]) state.days[ymd] = {};
    var rec = state.days[ymd];
    if (inHm) {
      var inIso = isoFromYmdHM(ymd, inHm);
      if (!inIso) {
        alert("上班时间格式无效");
        return false;
      }
      rec.clockIn = inIso;
    }
    if (outHm) {
      var outIso = isoFromYmdHM(ymd, outHm);
      if (!outIso) {
        alert("下班时间格式无效");
        return false;
      }
      rec.clockOut = outIso;
    }
    if (rec.clockIn && rec.clockOut && new Date(rec.clockOut) <= new Date(rec.clockIn)) {
      alert("下班时间须晚于上班时间");
      return false;
    }
    saveState(state);
    render();
    return true;
  }

  if (elBtnApplyCorrect) {
    elBtnApplyCorrect.addEventListener("click", function (e) {
      if (e && e.preventDefault) e.preventDefault();
      var inHm = elCorrectIn ? elCorrectIn.value : "";
      var outHm = elCorrectOut ? elCorrectOut.value : "";
      if (!inHm && !outHm) {
        alert("请至少填写实际上班或下班时间");
        return;
      }
      applyTodayTimesFromHM(inHm || null, outHm || null);
    });
  }

  if (elBtnQuickMorning921) {
    elBtnQuickMorning921.addEventListener("click", function (e) {
      if (e && e.preventDefault) e.preventDefault();
      var ymd = todayYMD();
      if (!state.days[ymd]) state.days[ymd] = {};
      var rec = state.days[ymd];
      var outHm =
        (elCorrectOut && elCorrectOut.value) ||
        (rec.clockOut ? hmFromIso(rec.clockOut) : "");
      if (!outHm) {
        alert("请先打下班卡，或在「下班」里填好时间后再点本按钮");
        return;
      }
      var inHm =
        pad2(DEFAULT_MORNING_H) + ":" + pad2(DEFAULT_MORNING_M);
      if (elCorrectIn) elCorrectIn.value = inHm;
      if (elCorrectOut) elCorrectOut.value = outHm;
      applyTodayTimesFromHM(inHm, outHm);
    });
  }

  elLeaveType.addEventListener("change", function () {
    elHalfOptions.classList.toggle("hidden", elLeaveType.value !== "half");
  });

  elBtnLeave.addEventListener("click", function () {
    var d = elLeaveDate.value;
    if (!d) {
      alert("请选择日期");
      return;
    }
    var wd = parseYMD(d);
    if (!isWeekday(wd)) {
      alert("仅可为周一至周五登记请假（周末不计工作日）。");
      return;
    }
    if (elLeaveType.value === "full") {
      state.leaves[d] = { type: "full" };
    } else {
      var part =
        (document.querySelector('input[name="halfPart"]:checked') || {}).value ||
        "morning";
      state.leaves[d] = { type: "half", part: part };
    }
    saveState(state);
    render();
  });

  (function initLeaveDate() {
    elLeaveDate.value = todayYMD();
  })();

  if (elBtnAuthLogin) {
    elBtnAuthLogin.addEventListener("click", function () {
      setAuthError("");
      var email = (elAuthEmail && elAuthEmail.value.trim()) || "";
      var pw = (elAuthPassword && elAuthPassword.value) || "";
      if (!email || !pw) {
        setAuthError("请填写邮箱和密码");
        return;
      }
      firebase
        .auth()
        .signInWithEmailAndPassword(email, pw)
        .catch(function (e) {
          setAuthError(e.message || "登录失败");
        });
    });
  }

  if (elBtnAuthRegister) {
    elBtnAuthRegister.addEventListener("click", function () {
      setAuthError("");
      var email = (elAuthEmail && elAuthEmail.value.trim()) || "";
      var pw = (elAuthPassword && elAuthPassword.value) || "";
      if (!email || !pw) {
        setAuthError("请填写邮箱和密码");
        return;
      }
      if (pw.length < 6) {
        setAuthError("密码至少 6 位");
        return;
      }
      firebase
        .auth()
        .createUserWithEmailAndPassword(email, pw)
        .catch(function (e) {
          setAuthError(e.message || "注册失败");
        });
    });
  }

  if (elBtnLogout) {
    elBtnLogout.addEventListener("click", function () {
      if (!cloudEnabled) return;
      firebase
        .auth()
        .signOut()
        .catch(function (e) {
          alert(e.message || "退出失败");
        });
    });
  }

  if (cloudEnabled) {
    initCloud();
  } else {
    if (elAuthPanel) elAuthPanel.classList.add("hidden");
    if (elMainApp) elMainApp.classList.remove("hidden");
    applyLocalBootstrap();
    showMainUi();
  }
})();
