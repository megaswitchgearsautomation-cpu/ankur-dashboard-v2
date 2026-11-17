/* Client dashboard (Ankur Scientific) - VIEW ONLY: process values, equipment, trends, alarms.
   No PLC / network / address / tag internals are shown here (those live in the admin page). */
(() => {
  const { esc, api, fmtTime, ago, dur, fmtValue, ICON, prio, toast } = MD;
  const $ = (id) => document.getElementById(id);
  const SERIES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s1)", "var(--s2)"];
  const PROCESS_GROUPS = ["Temperature", "Pressure", "Level", "Analysis"];
  const SVG = {
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3z"/><path d="m9 12 2 2 4-4"/></svg>',
    drop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/></svg>',
    gauge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 18a8 8 0 1 1 16 0"/><path d="m12 14 4-5"/></svg>',
  };
  let live = null;
  let view = "overview";
  let eqArea = "All";
  let pvGroup = "All";
  let ovGroup = "Temperature";
  let trendSel = loadSel();
  let lastTrendFetch = 0;
  let lastOvFetch = 0;
  let ovMin = 60;             // overview trend: rolling live window (minutes)
  let ovHist = null;          // overview trend: custom {from, to} (epoch s) from the range picker, null = live
  let ovZoom = null;          // overview trend: zoomed window [a, b] inside the range, null = full range
  let ovSeq = 0;              // only the newest overview trend request may draw

  // ---------- v3 (SC06) range pickers: presets + ONE calendar icon (MD.v3.rangePicker) ----------
  // Own preset keys ("15m", "1h", "3d") are handled here: rolling windows ending now. The picker computes a custom
  // window for keys it does not know, so for every rolling key the applied text is written here.
  const ROLL_MIN = { "15m": 15, "1h": 60, "8h": 480, "24h": 1440, "2d": 2880, "3d": 4320, "7d": 10080, "30d": 43200 };
  const MAX_TREND_S = 31 * 86400;                         // /api/trend limit for a custom range
  const nowS = () => Date.now() / 1000;
  function appliedLabel(f, t, suffix = "") { return `${fmtTime(f, true).slice(0, 16)} – ${fmtTime(t, true).slice(0, 16)} IST${suffix}`; }
  function setApplied(host, f, t, suffix) { const e = host && host.querySelector(".dr-txt"); if (e) e.textContent = appliedLabel(f, t, suffix); }
  // a preset always spans its full period (only the retention limit applies): "7 days" on a 2-day-old history shows
  // 7 days, with the time before the first sample drawn as empty, so the range matches what was picked
  function availMin(min) {
    const keep = MD.v3 ? Math.floor((nowS() - MD.v3.retentionStart()) / 60) : min;
    return Math.max(15, Math.min(min, keep));
  }
  function syncPickerLimits(host) {
    if (!host || !MD.v3) return;
    const lo = MD.istDate(MD.v3.retentionStart()), hi = MD.istDate(nowS());
    host.querySelectorAll(".dr-from, .dr-to").forEach((i) => { i.min = lo; i.max = hi; });
  }
  // onRange({minutes} | {from, to}, key)
  function makePicker(host, presets, initial, onRange, { trendLimit = true, liveSuffix = " · live" } = {}) {
    // a rolling preset must not be blocked by half-typed custom dates (the picker validates them for every key)
    host.addEventListener("click", (e) => {
      const b = e.target.closest && e.target.closest(".dr-presets button");
      if (!b || !ROLL_MIN[b.dataset.k]) return;
      const f = host.querySelector(".dr-from"), t = host.querySelector(".dr-to");
      if (f && t && (!f.value || !t.value || t.value < f.value)) { t.value = t.max || MD.istDate(nowS()); f.value = t.value; }
    }, true);
    const p = MD.v3.rangePicker(host, {
      presets, initial, fireInitial: false,
      onApply: (f, t, k) => {
        if (ROLL_MIN[k] && k !== "custom") {
          const m = trendLimit ? availMin(ROLL_MIN[k]) : ROLL_MIN[k], n = nowS();
          setApplied(host, n - m * 60, n, liveSuffix);
          onRange({ minutes: m }, k);
          return;
        }
        if (trendLimit && t - f > MAX_TREND_S) {
          f = t - MAX_TREND_S;
          toast("Charts show at most 31 days - showing the last 31 days of the selected dates");
          setApplied(host, f, t);
        }
        onRange({ from: f, to: t }, k);
      },
    });
    if (ROLL_MIN[initial]) { const m = trendLimit ? availMin(ROLL_MIN[initial]) : ROLL_MIN[initial], n = nowS(); setApplied(host, n - m * 60, n, liveSuffix); }
    return p;
  }
  // trend data for the selected range; when zoomed, finer data for the zoomed window is merged in
  async function fetchTrend(ids, base, zoom, points = 300) {
    const enc = encodeURIComponent(ids.join(","));
    const q = base.from != null ? `from=${Math.floor(base.from)}&to=${Math.ceil(base.to)}&minutes=1` : `minutes=${base.minutes}`;
    const r = await api(`/api/trend?tags=${enc}&${q}&points=${points}`);
    if (zoom && zoom[1] - zoom[0] >= 60) {
      const z = await api(`/api/trend?tags=${enc}&from=${Math.floor(zoom[0])}&to=${Math.ceil(zoom[1])}&minutes=1&points=300`);
      r.series.forEach((s) => {
        const zs = z.series.find((x) => x.id === s.id);
        if (zs) s.points = s.points.filter((p) => p.t < zoom[0] || p.t > zoom[1]).concat(zs.points).sort((a, b) => a.t - b.t);
      });
    }
    return r;
  }
  const inWin = (pts, w) => pts.filter((p) => p.avg != null && p.t >= w[0] && p.t <= w[1]);

  // ---------- theme ----------
  try { const t = localStorage.getItem("md-theme"); if (t) document.documentElement.dataset.theme = t; } catch (_) {}
  $("themeBtn").onclick = () => {
    const cur = document.documentElement.dataset.theme || "light";
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("md-theme", next); } catch (_) {}
    if (view === "trends") renderTrends(true);
    if (view === "overview") loadOvTrend(true);
  };

  $("logoutBtn").onclick = MD.logout;

  // ---------- routing ----------
  // v3 (brief SC01): Tank levels merged into the dashboard cards, Data log moved into Reports - both menus removed
  const TITLES = { overview: "Plant dashboard", mimic: "Process mimic", instruments: "Instruments",
    equipment: "Equipment", trends: "Trends", io: "IO list", alarms: "Alarms",
    reports: "Reports", setpoints: "Set points" };   // Selectors page removed on request (2026-11-14)   // Totalizer page removed on request   // Devices page removed on request   // Data log = HMI data log screens; Reports = daily / shift (rebuild brief)
  let rpInit = false;
  function route() {
    const prevView = view;
    view = (location.hash || "#overview").slice(1);
    if (!TITLES[view]) view = "overview";
    // v3 (SC01 navigation): a newly opened page starts at its top, not at the previous page's scroll position
    // (a pencil jump to a Set points section scrolls there afterwards - see Plant.gotoSp)
    if (prevView && prevView !== view) window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    $("pageTitle").textContent = TITLES[view];
    const navIc = document.querySelector(`#segNav a[data-view="${view}"] svg`);
    $("headIcon").innerHTML = navIc ? navIc.outerHTML : "";
    document.querySelectorAll("[data-section]").forEach((s) => s.classList.toggle("hidden", s.dataset.section !== view));
    document.querySelectorAll("[data-view]").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
    render();
    if (window.Plant) Plant.show(view);
    if (view === "trends") renderTrends(true, true);
    if (view === "alarms") loadHistory();
    if (view === "overview") loadOvTrend(true);
    if (view === "reports" && window.ShiftReports && window.MD_META && !rpInit) { rpInit = true; ShiftReports.init(); }  }
  window.addEventListener("hashchange", route);

  // ---------- data ----------
  async function loadMeta() {
    const meta = await api("/api/meta");
    $("siteName").textContent = `${meta.site.name} · ${meta.site.panel}`;
    window.MD_META = meta;
    ["ovRange", "trRange", "histRange"].forEach((id) => syncPickerLimits($(id)));   // history actually kept
  }
  // signed-in user: role decides what is shown (the server enforces the same rules)
  let me = null;
  async function loadMe() {
    me = await api("/api/whoami");
    window.MD_ME = me;
    document.body.dataset.role = me.role;
    const foot = document.querySelector(".rail-foot");
    if (me.can_configure && foot && !document.getElementById("settingsLink")) {
      foot.insertAdjacentHTML("afterbegin", `<a class="rail-btn" id="settingsLink" href="/admin" title="Settings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></a>`);
    }
    const u = document.getElementById("userChip");
    if (u) u.innerHTML = `<b>${esc(me.username)}</b><span class="role-${esc(me.role)}">${esc(me.role)}</span>`;
  }
  async function poll() {
    try {
      live = await api("/api/live");
      render();
      // a custom date range or a zoomed chart is not refreshed (the view would move under the user)
      if (view === "trends" && !trRange && !trZoom && Date.now() - lastTrendFetch > 5000) renderTrends(false);
      if (view === "overview" && !ovHist && !ovZoom && Date.now() - lastOvFetch > 5000) loadOvTrend(false);
    } catch (e) {
      $("banner").innerHTML = `<div class="banner crit">${ICON.crit}<div><strong>Dashboard temporarily unavailable</strong>Reconnecting…</div></div>`;
    } finally {
      setTimeout(poll, 1000);          // live values refresh every second
    }
  }

  // ---------- render ----------
  function render() {
    if (!live) return;
    renderConn();
    renderBanner();
    const n = live.alarms.length;
    $("navAlarmCount").textContent = n;
    $("navAlarmCount").classList.toggle("hidden", !n);
    $("segAlarmCount").textContent = n;
    $("segAlarmCount").classList.toggle("hidden", !n);
    if (view === "overview") renderOverview();       // (summary strip removed on request)
    if (view === "equipment") renderEquipment();
    if (view === "alarms") renderActive($("activeTable"));
    if (window.Plant) Plant.render(live, view);      // key points, mimic, instruments (js/plant.js)
    // alarm pop-up removed on client request: alarms are shown on the Alarms page (bell badge shows the count)
  }

  // ---------- alarm pop-up: opens for unacknowledged alarms, closes on Acknowledge ----------
  let popShownIds = "";
  let acking = false;
  const drafts = {};     // alarm id -> note being typed
  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.25].forEach((t) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 880; g.gain.value = 0.08;
        o.connect(g); g.connect(ctx.destination);
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.15);
      });
      setTimeout(() => ctx.close(), 800);
    } catch (_) { /* audio blocked until the user interacts - the pop-up is enough */ }
  }
  function renderAlarmPopup() {
    if (acking) return;
    if (me && !me.can_operate) {           // viewers cannot acknowledge: no blocking pop-up, the bell + Alarms page show it
      $("alarmPop").classList.add("hidden");
      $("alarmPopBg").classList.add("hidden");
      return;
    }
    const pending = live.alarms.filter((a) => !a.acked_at)
      .sort((a, b) => (a.priority === "red" ? 0 : 1) - (b.priority === "red" ? 0 : 1) || b.raised_at - a.raised_at);
    const ids = pending.map((a) => a.id).join(",");
    if (!pending.length) {
      $("alarmPop").classList.add("hidden");
      $("alarmPopBg").classList.add("hidden");
      popShownIds = "";
      return;
    }
    const isNew = pending.some((a) => !popShownIds.split(",").includes(String(a.id)));
    if (ids === popShownIds && !$("alarmPop").classList.contains("hidden")) return;
    const red = pending.filter((a) => a.priority === "red").length;
    $("alarmPopHead").classList.toggle("yellow", !red);
    $("alarmPopTitle").textContent = pending.length === 1 ? (red ? "Critical alarm" : "Warning") : `${pending.length} new alarms`;
    $("alarmPopSub").textContent = red ? `${red} critical · ${pending.length - red} warning` : `${pending.length} warning`;
    // keep anything already typed when the list is re-drawn
    $("alarmPopList").querySelectorAll("textarea[data-id]").forEach((t) => { if (t.value) drafts[t.dataset.id] = t.value; });
    $("alarmPopList").innerHTML = pending.slice(0, 8).map((a) => {
      const prev = a.previous_notes || [];
      return `<div class="ap-item">${prio(a.priority)}
      <div class="ap-body"><div class="msg">${esc(a.message)}</div><div class="when">${fmtTime(a.raised_at, true)} · ${dur(Date.now() / 1000 - a.raised_at)} ago
      ${a.simulated ? ' · <span class="q SIMULATED">DEMO</span>' : ""}</div>
      ${prev.length ? `<div class="ap-prev"><div class="ap-prev-h">${MD.ICON.info} Previous notes for this alarm (${prev.length})</div>
        ${prev.map((n) => `<div class="ap-prev-n"><div>${esc(n.note)}</div><span>${esc(n.author)} · ${fmtTime(n.created_at, true)}</span></div>`).join("")}</div>` : ""}
      <label class="ap-note"><span>Problem / cause and action taken <i>(optional)</i></span>
        <textarea data-id="${a.id}" rows="2" maxlength="500" placeholder="e.g. Trip due to over-voltage - SPP relay reset, supply checked">${esc(drafts[a.id] || "")}</textarea></label>
      </div></div>`;
    }).join("") +
      (pending.length > 8 ? `<div class="muted" style="padding:8px 0;font-size:12px">+ ${pending.length - 8} more - see the Alarms page</div>` : "");
    $("alarmPopNote").textContent = "Your note is saved and shown the next time this alarm occurs.";
    $("alarmPop").classList.remove("hidden");
    $("alarmPopBg").classList.remove("hidden");
    if (isNew) { beep(); const first = $("alarmPopList").querySelector("textarea"); (first || $("alarmPopAck")).focus(); }
    popShownIds = ids;
  }
  $("alarmPopAck").onclick = async () => {
    const ids = popShownIds.split(",").filter(Boolean).map(Number);
    if (!ids.length) return;
    const notes = {};
    $("alarmPopList").querySelectorAll("textarea[data-id]").forEach((t) => { if (t.value.trim()) notes[t.dataset.id] = t.value.trim(); });
    acking = true;
    $("alarmPopAck").disabled = true;
    try {
      const r = await api("/api/client/alarms/ack", { method: "POST", body: { ids, notes } });
      ids.forEach((i) => delete drafts[i]);
      if (r.notes_saved) toast(`Alarm acknowledged - ${r.notes_saved} note(s) saved`);
      const now = Date.now() / 1000;
      live.alarms.forEach((a) => { if (ids.includes(a.id)) a.acked_at = now; });   // close immediately
      $("alarmPop").classList.add("hidden");
      $("alarmPopBg").classList.add("hidden");
      popShownIds = "";
      if (!r.notes_saved) toast("Alarm acknowledged");
      if (view === "alarms") { renderActive($("activeTable")); loadHistory(); }
    } catch (e) { toast(e.message, true); }
    finally { acking = false; $("alarmPopAck").disabled = false; }
  };

  // client-facing status only: demo / live / commissioning / offline - no technical details
  function srcTag() {
    const s = live.status;
    return s.state === "demo" ? "DEMO DATA" : (s.state === "live" && !s.validated ? "COMMISSIONING" : "");
  }
  function statusPill(s) {
    if (s.state === "demo") return '<span class="pill sim"><span class="dot"></span>DEMO DATA</span>';
    if (s.state === "offline") return '<span class="pill crit"><span class="dot"></span>OFFLINE</span>';
    if (s.state === "live") return s.validated ? '<span class="pill good"><span class="dot"></span>LIVE</span>'
      : '<span class="pill warn"><span class="dot"></span>LIVE · COMMISSIONING</span>';
    return '<span class="pill idle"><span class="dot"></span>CONNECTING</span>';
  }

  function renderConn() {
    const s = live.status;
    $("connStrip").innerHTML = `${statusPill(s)}
      <span>Updated <b class="num" title="${fmtTime(s.last_update, true)}">${fmtTime(s.last_update)}</b></span>`;
  }
  // header date + clock in plant time (Asia/Kolkata), whatever the viewer's computer zone is
  function tickClock() {
    const now = Date.now() / 1000;
    $("headClock").textContent = `${MD.istLong(now)} · ${fmtTime(now)} IST`;
  }
  tickClock();
  setInterval(tickClock, 1000);

  function renderBanner() {
    const s = live.status;
    let h = "";
    if (s.state === "demo") {
      h = `<div class="banner sim">${ICON.flask}<div><strong>Demo data</strong>
        The values, status and alarms on this page are simulated for demonstration. Live plant data will appear here after commissioning.</div></div>`;
    } else if (s.state === "offline") {
      h = `<div class="banner crit">${ICON.crit}<div><strong>Live data temporarily unavailable</strong>
        Showing the last received values from ${s.last_update ? fmtTime(s.last_update, true) : "-"} (${ago(s.last_update)}).</div></div>`;
    } else if (s.state === "live" && !s.validated) {
      h = `<div class="banner warn">${ICON.warn}<div><strong>Commissioning in progress</strong>
        Live values are being validated and may not yet be final.</div></div>`;
    }
    $("banner").innerHTML = h;
  }

  const tagById = (id) => live.tags.find((t) => t.id === id);

  function renderOverview() {
    // ("Equipment running" hero, availability, tank-level and pH / pressure mini cards removed: the key-point cards show them)

    // trend segment
    const groups = PROCESS_GROUPS.filter((g) => live.tags.some((t) => t.group === g && t.trend));
    if (!groups.includes(ovGroup)) ovGroup = groups[0];
    $("ovTrendSeg").innerHTML = groups.map((g) => `<button class="${g === ovGroup ? "active" : ""}" data-g="${esc(g)}">${esc(g)}</button>`).join("");
    $("ovTrendSeg").querySelectorAll("button").forEach((b) => (b.onclick = () => { ovGroup = b.dataset.g; loadOvTrend(true); renderOverview(); }));

    // process values: only the ones that do not already have their own key-point card above (shown once)
    const inCards = new Set(["LT_01", "LT_02", "PT_01", "PH_01", "T_04", "T_02", "PT_03"]);
    const pv = live.tags.filter((t) => PROCESS_GROUPS.includes(t.group) && !inCards.has(t.id));
    const pgs = ["All", ...PROCESS_GROUPS.filter((g) => pv.some((t) => t.group === g))];
    $("pvSeg").innerHTML = pgs.map((g) => `<button class="${g === pvGroup ? "active" : ""}" data-g="${esc(g)}">${esc(g)}</button>`).join("");
    $("pvSeg").querySelectorAll("button").forEach((b) => (b.onclick = () => { pvGroup = b.dataset.g; renderOverview(); }));
    const shown = pv.filter((t) => pvGroup === "All" || t.group === pvGroup);
    $("pvCount").textContent = `${shown.length}`;
    renderPvTiles(shown, pv);

    // (active-alarms card removed from the overview on request: alarms stay on the Alarms page and the pop-up)

    // (overview equipment list removed: every pump is already in its key-point card and on the Equipment page)

    // panel & safety
    renderPanelSafety();
  }

  // client-facing data badge: only DEMO or a data problem is shown; normal live values carry no badge
  function qBadge(t) {
    if (t.quality === "SIMULATED") return '<span class="q SIMULATED">DEMO</span>';
    if (t.quality === "STALE") return '<span class="q STALE">NOT UPDATED</span>';
    if (t.quality === "NODATA") return '<span class="q BAD">NO DATA</span>';
    return "";
  }
  // ---------- run hours: rows are kept and updated in place so bars / numbers animate between polls ----------
  const reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  function tweenNum(el, to, digits, suffix = "") {
    const from = el._v ?? 0;
    el._v = to;
    if (reduceMotion || Math.abs(to - from) < 1e-9) { el.textContent = to.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }) + suffix; return; }
    const t0 = performance.now(), dur = from === 0 ? 1100 : 700;
    cancelAnimationFrame(el._raf);
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = (from + (to - from) * e).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }) + suffix;
      if (k < 1) el._raf = requestAnimationFrame(step);
    };
    el._raf = requestAnimationFrame(step);
  }
  function pctOf(t, v) {
    if (typeof v !== "number" || t.eng_min == null || t.eng_max == null || t.eng_max <= t.eng_min) return null;
    return Math.max(0, Math.min(100, ((v - t.eng_min) / (t.eng_max - t.eng_min)) * 100));
  }

  // ---------- panel & safety: built once, then updated in place (lamps / waves keep animating) ----------
  const isOn = (t) => t.value === true || t.value === 1 || t.value === "1" || (typeof t.value === "number" && t.value >= 0.5);
  const noData = (t) => ["NODATA", "STALE"].includes(t.quality) || t.value == null;
  function safetyIcon(t) {
    const n = (t.name || "").toLowerCase();
    if (/emergency|e-stop|eme/.test(n)) return `<svg viewBox="0 0 48 48" class="psi"><rect x="10" y="30" width="28" height="12" rx="3" class="ln"/>
      <path d="M17 30 V25 H31 V30" class="ln"/><path d="M8 25 Q8 9 24 9 Q40 9 40 25 Z" class="cap"/>${/remote|rmt/.test(n) ? '<path d="M38 6 q5 4 0 8 M42 3 q8 7 0 14" class="ln wave"/>' : ""}</svg>`;
    if (/earth/.test(n)) return `<svg viewBox="0 0 48 48" class="psi"><path d="M24 4 V22 M10 22 H38 M15 29 H33 M20 36 H28 M23 42 H25" class="ln"/><path d="M28 8 l-6 7 h5 l-5 7" class="ln bolt"/></svg>`;
    return `<svg viewBox="0 0 48 48" class="psi"><rect x="9" y="8" width="30" height="34" rx="4" class="ln"/><path d="M16 18 H32 M16 26 H26" class="ln"/>
      <path d="M17 34 l4 -6 l4 6 l4 -6" class="ln bolt"/><circle cx="33" cy="34" r="2.5" class="cap"/></svg>`;
  }
  const psShort = (n) => String(n || "").replace(/\s*\(cmd\)/i, "").replace(/Emergency Stop/i, "E-Stop").replace(/\s*P\.?\s?B\.?$/i, "")
    .replace(/^Hooter With Lamp$/i, "Hooter").replace(/^Emergency On Lamp$/i, "Emergency lamp");
  function renderPanelSafety() {
    const box = $("panelStatus");
    const safety = live.tags.filter((t) => t.group === "Safety");
    const panel = live.tags.filter((t) => t.group === "Panel indication");
    if (!safety.length && !panel.length) { box.innerHTML = '<div class="empty">No panel signals</div>'; return; }
    const sig = safety.concat(panel).map((t) => t.id).join(",");
    const find = (re) => panel.find((t) => re.test(t.id + " " + t.name));
    const tower = { r: find(/red/i), y: find(/yellow|amber/i), g: find(/green/i) };
    const hooter = find(/hooter|siren|buzzer/i), beacon = find(/emergency.*lamp|beacon/i);
    const used = new Set([tower.r, tower.y, tower.g, hooter, beacon].filter(Boolean).map((t) => t.id));
    const others = panel.filter((t) => !used.has(t.id));
    if (box._sig !== sig) {
      box._sig = sig;
      box.innerHTML = `
        <div class="ps-sum" id="psSum"><svg viewBox="0 0 64 64" class="shield"><path d="M32 4 L54 12 V30 C54 45 44 55 32 60 C20 55 10 45 10 30 V12 Z" class="sh"/>
          <path d="M21 32 L29 40 L44 24" class="ok-mark"/><path d="M32 18 V36 M32 44 V46" class="bad-mark"/></svg>
          <div class="ps-sum-txt"><div class="ps-k">Panel &amp; safety</div><div class="ps-t" id="psTitle"></div><span class="ps-s" id="psSub"></span></div></div>
        <div class="ps-dev">${safety.map((t) => `<div class="psd" data-id="${esc(t.id)}">${safetyIcon(t)}<div class="psd-txt"><span class="psd-n" title="${esc(t.name)}">${esc(psShort(t.name))}</span>
          <b class="psd-v"></b></div><span class="psd-mark"></span></div>`).join("")}</div>
        <div class="ps-panel">
          ${tower.r || tower.y || tower.g ? `<div class="ps-tower" title="Tower light"><svg viewBox="0 0 60 150" class="tower">
            <rect x="18" y="4" width="24" height="6" rx="2" class="cap"/>
            <rect x="14" y="10" width="32" height="30" rx="5" class="lamp r" data-id="${esc((tower.r || {}).id || "")}"/>
            <rect x="14" y="42" width="32" height="30" rx="5" class="lamp y" data-id="${esc((tower.y || {}).id || "")}"/>
            <rect x="14" y="74" width="32" height="30" rx="5" class="lamp g" data-id="${esc((tower.g || {}).id || "")}"/>
            <rect x="24" y="106" width="12" height="30" class="pole"/><rect x="12" y="136" width="36" height="8" rx="3" class="pole"/></svg>
            <div class="psd-txt"><span class="psd-n">Tower light</span><b class="psd-v ps-cap"></b></div></div>` : ""}
          <div class="ps-ind">
            ${hooter ? `<div class="psx hooter" data-id="${esc(hooter.id)}"><svg viewBox="0 0 48 48" class="psi"><path d="M8 18 H16 L28 8 V40 L16 30 H8 Z" class="cap"/>
              <path d="M33 17 q5 7 0 14 M38 12 q9 12 0 24" class="ln wave"/></svg><div class="psd-txt"><span class="psd-n" title="${esc(hooter.name)}">${esc(psShort(hooter.name))}</span><b class="psd-v"></b></div></div>` : ""}
            ${beacon ? `<div class="psx beacon" data-id="${esc(beacon.id)}"><svg viewBox="0 0 48 48" class="psi"><path d="M14 34 V22 Q14 10 24 10 Q34 10 34 22 V34 Z" class="cap"/>
              <rect x="10" y="34" width="28" height="7" rx="2" class="ln"/><path d="M24 2 V5 M6 12 L9 14 M42 12 L39 14" class="ln rays"/></svg>
              <div class="psd-txt"><span class="psd-n" title="${esc(beacon.name)}">${esc(psShort(beacon.name))}</span><b class="psd-v"></b></div></div>` : ""}
            ${others.map((t) => `<div class="psx" data-id="${esc(t.id)}"><span class="lampdot"></span><div class="psd-txt"><span class="psd-n" title="${esc(t.name)}">${esc(psShort(t.name))}</span><b class="psd-v"></b></div></div>`).join("")}
          </div>
        </div>`;
      box.style.setProperty("--n", box.querySelectorAll(".psd, .psx, .ps-tower").length);   // equal columns after the summary
    }
    // safety devices
    let bad = [], nod = 0;
    safety.forEach((t) => {
      const el = box.querySelector(`.psd[data-id="${CSS.escape(t.id)}"]`);
      if (!el) return;
      const st = noData(t) ? "nodata" : isOn(t) ? "trip" : "ok";
      if (st === "trip") bad.push(t); if (st === "nodata") nod++;
      el.dataset.state = st;
      el.querySelector(".psd-v").textContent = st === "nodata" ? "No data" : fmtValue(t);
    });
    // panel lamps
    box.querySelectorAll(".lamp[data-id]").forEach((l) => {
      const t = panel.find((x) => x.id === l.dataset.id);
      l.classList.toggle("on", !!t && !noData(t) && isOn(t));
    });
    panel.forEach((t) => {
      const el = box.querySelector(`.psx[data-id="${CSS.escape(t.id)}"]`);
      if (!el) return;
      el.dataset.state = noData(t) ? "nodata" : isOn(t) ? "on" : "off";
      el.querySelector(".psd-v").textContent = noData(t) ? "No data" : fmtValue(t);
    });
    const tw = box.querySelector(".ps-tower .ps-cap");
    if (tw) {
      const lit = [["r", "Red"], ["y", "Yellow"], ["g", "Green"]].filter(([k]) => box.querySelector(`.lamp.${k}.on`)).map(([, n]) => n);
      const lampNoData = panel.length && panel.every((t) => noData(t));
      tw.textContent = lampNoData ? "No data" : lit.length ? lit.join(" + ") : "Off";
    }
    const sum = $("psSum");
    // "ALL SAFE" only when every safety device reported healthy; any missing reading = no / incomplete data (grey)
    const state = bad.length ? "trip" : nod ? "nodata" : "ok";
    sum.dataset.state = state;
    $("psTitle").textContent = state === "trip" ? "SAFETY TRIP" : state === "nodata" ? (nod === safety.length ? "NO SAFETY DATA" : "SAFETY DATA INCOMPLETE") : "ALL SAFE";
    $("psSub").textContent = state === "trip" ? bad.map((t) => `${psShort(t.name)} ${fmtValue(t)}`).join(" · ")
      : `${safety.length - nod}/${safety.length} healthy${nod ? ` · ${nod} no data` : ""}`;
    $("psChip").className = `ps-chip ${state}`;
    $("psChip").innerHTML = `<span class="dot"></span>${state === "trip" ? `${bad.length} TRIPPED` : state === "nodata" ? "NO DATA" : "HEALTHY"}`;
  }

  // ---------- equipment cards: animated icon per kind, updated in place so animations keep running ----------
  const EQ_STATE = { RUNNING: "run", STARTING: "start", TRAVEL: "start", OPEN: "open", CLOSED: "stop", STOPPED: "stop",
    TRIP: "trip", FAULT: "trip", "NO FEEDBACK": "warn", UNKNOWN: "unk" };
  const EQ_TXT = { RUNNING: "Running", STARTING: "Starting", TRAVEL: "Moving", OPEN: "Open", CLOSED: "Closed", STOPPED: "Stopped",
    TRIP: "Tripped", FAULT: "Fault", "NO FEEDBACK": "No feedback", UNKNOWN: "No data" };
  const KIND_LABEL = { pump: "Pump", fan: "Fan", blower: "Blower", mixer: "Mixer", dosing: "Dosing pump", valve: "Valve" };
  const eqState = (e) => EQ_STATE[e.status] || "unk";
  function eqKind(e) {
    const n = (e.name || "").toLowerCase();
    if (e.type === "valve") return "valve";
    if (/agitator|mixer/.test(n)) return "mixer";
    if (/blower/.test(n)) return "blower";
    if (/\bfan\b/.test(n)) return "fan";
    if (/dosing/.test(n)) return "dosing";
    return "pump";
  }
  function eqIcon(kind) {
    const blades = (n, d, cx, cy) => Array.from({ length: n }, (_, i) => `<path d="${d}" transform="rotate(${(360 / n) * i} ${cx} ${cy})"/>`).join("");
    switch (kind) {
      case "fan": return `<svg viewBox="0 0 64 64" class="ico"><circle cx="32" cy="30" r="25" class="ln"/><rect x="26" y="54" width="12" height="6" rx="1.5" class="fl"/>
        <g class="rot">${blades(4, "M32 30 C 26 20, 28 9, 34 7 C 38 13, 37 22, 32 30Z", 32, 30)}<circle cx="32" cy="30" r="4" class="hub"/></g></svg>`;
      case "blower": return `<svg viewBox="0 0 64 64" class="ico"><path d="M32 8 A22 22 0 1 0 54 30 L54 8 Z" class="ln"/><rect x="8" y="54" width="48" height="5" rx="2" class="fl"/>
        <g class="rot">${blades(8, "M32 30 L32 14", 32, 30)}<circle cx="32" cy="30" r="5" class="hub"/></g></svg>`;
      case "mixer": return `<svg viewBox="0 0 64 64" class="ico"><rect x="22" y="3" width="20" height="12" rx="2" class="fl"/><path d="M32 15 V48" class="ln"/>
        <path d="M8 22 V54 Q8 60 14 60 H50 Q56 60 56 54 V22" class="ln"/><path d="M10 40 H54" class="ln wv"/>
        <g class="prop"><ellipse cx="24" cy="49" rx="8" ry="3" class="fl"/><ellipse cx="40" cy="49" rx="8" ry="3" class="fl"/></g></svg>`;
      case "dosing": return `<svg viewBox="0 0 64 64" class="ico"><rect x="14" y="26" width="28" height="22" rx="4" class="ln"/><path d="M42 37 H56 V52" class="ln"/>
        <g class="piston"><rect x="24" y="8" width="8" height="16" rx="2" class="fl"/></g><rect x="8" y="54" width="44" height="5" rx="2" class="fl"/>
        <path class="drop" d="M56 54 q-3 4 0 6 q3 -2 0 -6Z"/></svg>`;
      case "valve": return `<svg viewBox="0 0 64 64" class="ico"><path d="M4 30 H14 M50 30 H60" class="ln"/><path d="M14 18 L32 30 L14 42 Z M50 18 L32 30 L50 42 Z" class="body"/>
        <path d="M32 30 V12" class="ln"/><path d="M22 10 H42" class="ln stem"/><g class="flow"><circle cx="8" cy="30" r="2"/><circle cx="56" cy="30" r="2"/></g>
        <path d="M27 24 L37 36" class="ln x"/></svg>`;
      default: return `<svg viewBox="0 0 64 64" class="ico"><rect x="4" y="54" width="56" height="5" rx="2" class="fl"/><path d="M40 16 H58 V26 H44" class="ln"/>
        <circle cx="28" cy="34" r="18" class="ln"/><path d="M20 52 L18 54 M36 52 L38 54" class="ln"/>
        <g class="rot">${blades(5, "M28 34 C 31 29, 31 23, 27 19", 28, 34)}<circle cx="28" cy="34" r="3.5" class="hub"/></g></svg>`;
    }
  }
  function eqCardHTML(e) {
    const kind = eqKind(e);
    const spec = [e.kw != null ? `${e.kw} kW` : "", KIND_LABEL[kind]].filter(Boolean).join(" · ");
    const motor = e.type === "motor";
    return `<div class="eqc" data-id="${esc(e.id)}" data-kind="${kind}" tabindex="0">
      <div class="eqc-ic">${eqIcon(kind)}</div>
      <div class="eqc-main">
        <div class="eqc-top">${e.tag_no ? `<span class="eqc-tag">${esc(e.tag_no)}</span>` : `<span class="eqc-tag none" title="No tag number on the P&amp;ID">–</span>`}<span class="eqc-pill"><span class="dot"></span><b class="st"></b></span></div>
        <div class="eqc-name" title="${esc(e.name)}">${esc(e.name)}</div>
        <div class="eqc-meta">${esc(e.area || "")}${spec ? " · " + esc(spec) : ""}${e.simulated ? ' · <span class="q SIMULATED">DEMO</span>' : ""}</div>
      </div>
      <div class="eqc-stats">
        ${motor ? `<div><span>Run hours</span><b class="num rh">-</b></div>` : `<div><span>Position</span><b class="pos">-</b></div>`}
        <div><span>Mode</span><b class="mode">-</b></div>
      </div>
      <div class="eqc-io" title="Field signals (lit = ON)">${(motor ? [["cmd", "CMD"], ["run", "RUN"], ["trip", "TRIP"]]
        : [["open_cmd", "OPEN CMD"], ["close_cmd", "CLOSE CMD"], ["open", "OPEN"], ["close", "CLOSED"]])
        .filter(([k]) => e.io && k in e.io).map(([k, l]) => `<span class="sig" data-io="${k}"><i></i>${l}</span>`).join("")}</div>
    </div>`;   // (run-hours comparison bar removed 16-11-2026: there is no fixed maximum, so the bar had no meaning)
  }
  function eqRowHTML(e) {
    const kind = eqKind(e);
    return `<div class="eql" data-id="${esc(e.id)}" data-kind="${kind}"><span class="eqc-ic sm">${eqIcon(kind)}</span>
      <span class="eqc-tag${e.tag_no ? "" : " none"}"${e.tag_no ? "" : ' title="No tag number on the P&amp;ID"'}>${esc(e.tag_no || "–")}</span><span class="eql-name" title="${esc(e.name)}">${esc(e.name)}</span>
      <span class="muted eql-area">${esc(e.area || "")}</span><span class="eqc-pill"><span class="dot"></span><b class="st"></b></span>
      <b class="mode">-</b><b class="num rh">${e.type === "motor" ? "-" : ""}</b><b class="num starts">${e.type === "motor" ? "-" : ""}</b></div>`;
  }
  // run hours as h / m / s so a running pump visibly counts up every second
  function fmtRunHours(h) {
    const s = Math.max(0, Math.floor((h || 0) * 3600));
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return hh ? `${hh.toLocaleString()} h ${String(mm).padStart(2, "0")} m` : `${mm} m ${String(ss).padStart(2, "0")} s`;
  }
  // HMI soft selectors: Auto / Manual, and for main-standby pairs which pump is selected
  function modeTxt(e) {
    if (e.auto == null) return "-";
    let s = e.auto ? "Auto" : "Manual";
    if (e.pair && e.standby_selected != null) s += e.standby_selected ? " · Standby sel." : " · Main sel.";
    return s;
  }
  function fillEq(el, e) {
    const st = eqState(e);
    if (el.dataset.state !== st) el.dataset.state = st;
    const q = (s) => el.querySelector(s);
    q(".st").textContent = EQ_TXT[e.status] || e.status || "-";
    if (q(".mode")) { q(".mode").textContent = modeTxt(e); q(".mode").classList.toggle("man", e.auto === false); }
    el.querySelectorAll("[data-io]").forEach((s) => {           // CMD / RUN / TRIP lamps
      const v = (e.io || {})[s.dataset.io];
      s.className = `sig ${s.dataset.io}${v == null ? " nd" : v ? " on" : ""}`;
    });
    if (e.type === "motor") {
      if (q(".rh")) {
        q(".rh").textContent = fmtRunHours(e.run_hours);
        q(".rh").classList.toggle("counting", e.status === "RUNNING");
      }
      if (q(".starts")) q(".starts").textContent = e.starts ?? 0;
    } else if (q(".pos")) q(".pos").textContent = EQ_TXT[e.status] || "-";
  }
  function renderEqInto(box, list, { view = "cards", group = false, empty = "No equipment matches" } = {}) {
    const sig =`${view}|${group}|${list.map((e) => e.id).join(",")}|${list.length ? "" : empty}`;
    if (box._sig !== sig) {
      box._sig = sig;
      if (!list.length) box.innerHTML = `<div class="empty">${esc(empty)}</div>`;
      else if (view === "list") {
        box.innerHTML = `<div class="eql eql-h"><span></span><span>Tag</span><span>Equipment</span><span>Area</span><span>Status</span><span>Mode</span><span>Run hours</span><span>Starts</span></div>` +
          list.map(eqRowHTML).join("");
      } else if (group) {
        const areas = [...new Set(list.map((e) => e.area || "Other"))];
        box.innerHTML = areas.map((a) => `<div class="eq-area" data-area="${esc(a)}"><div class="eq-ah"><h3>${esc(a)}</h3><span class="eq-ac"></span></div>
          <div class="eqg">${list.filter((e) => (e.area || "Other") === a).map(eqCardHTML).join("")}</div></div>`).join("");
      } else box.innerHTML = `<div class="eqg">${list.map(eqCardHTML).join("")}</div>`;
      box.querySelectorAll("[data-id]").forEach((el, i) => (el.style.animationDelay = `${Math.min(i, 20) * 35}ms`));
      box.classList.add("eq-anim");
      setTimeout(() => box.classList.remove("eq-anim"), 1400);
    }
    list.forEach((e) => { const el = box.querySelector(`[data-id="${CSS.escape(e.id)}"]`); if (el) fillEq(el, e); });
    box.querySelectorAll(".eq-area").forEach((sec) => {
      const inA = list.filter((e) => (e.area || "Other") === sec.dataset.area);
      const run = inA.filter((e) => ["run", "open"].includes(eqState(e))).length, bad = inA.filter((e) => eqState(e) === "trip").length;
      sec.querySelector(".eq-ac").innerHTML = `${inA.length} items · <b class="ok">${run} running/open</b>${bad ? ` · <b class="bad">${bad} tripped</b>` : ""}`;
    });
  }

  // ---------- process value tiles: same layout, built once and updated in place (values count, bars glide) ----------
  const PV_ICON = {
    temperature: '<path d="M10 4a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0Z"/><path d="M12 9v7" class="hot"/>',
    pressure: '<circle cx="12" cy="13" r="8"/><path d="M12 13l4-4" class="needle"/><path d="M7 19h10"/>',
    level: '<path d="M5 4v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4"/><path d="M5 13c2.3-1.3 4.7 1.3 7 0s4.7-1.3 7 0" class="wave"/>',
    analysis: '<path d="M12 3c3 4.2 6 7.6 6 11a6 6 0 0 1-12 0c0-3.4 3-6.8 6-11Z"/><path d="M9.5 15.5h1.6m1.6 0h1.8" />',
  };
  let pvSpark = {}, pvSparkAt = 0;
  async function loadPvSpark(ids) {
    pvSparkAt = Date.now();
    try {
      for (let i = 0; i < ids.length; i += 8) {
        const r = await api(`/api/trend?tags=${encodeURIComponent(ids.slice(i, i + 8).join(","))}&minutes=30&points=40`);
        r.series.forEach((s) => (pvSpark[s.id] = s.points.filter((p) => p.avg != null)));
      }
      document.querySelectorAll("#pvList .pv[data-tag]").forEach((el) => drawSpark(el));
    } catch (_) { /* sparklines are decoration only */ }
  }
  function drawSpark(el) {
    const pts = pvSpark[el.dataset.tag];
    const svg = el.querySelector(".pv-spark");
    if (!svg) return;
    if (!pts || pts.length < 2) { svg.classList.add("empty"); return; }
    svg.classList.remove("empty");
    const lo = Math.min(...pts.map((p) => p.avg)), hi = Math.max(...pts.map((p) => p.avg)), span = hi - lo || 1;
    const t0 = pts[0].t, t1 = pts.at(-1).t || t0 + 1;
    const xy = pts.map((p) => [((p.t - t0) / (t1 - t0 || 1)) * 100, 24 - ((p.avg - lo) / span) * 20]);
    const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
    svg.querySelector(".l").setAttribute("d", d);
    svg.querySelector(".a").setAttribute("d", `${d}L100,28L0,28Z`);
    const last = xy.at(-1);
    const dot = svg.querySelector(".d");
    dot.setAttribute("cx", last[0]); dot.setAttribute("cy", last[1]);
    // direction over the last ~10 minutes
    const ref = pts.find((p) => p.t >= pts.at(-1).t - 600) || pts[0];
    const dv = pts.at(-1).avg - ref.avg, eps = span * 0.04;
    const tr = el.querySelector(".pv-tr");
    tr.className = `pv-tr ${dv > eps ? "up" : dv < -eps ? "down" : "flat"}`;
    tr.textContent = dv > eps ? "▲" : dv < -eps ? "▼" : "▬";
    tr.title = dv > eps ? "Rising (last 10 min)" : dv < -eps ? "Falling (last 10 min)" : "Steady (last 10 min)";
  }
  function pvTileHTML(t) {
    const g = String(t.group || "").toLowerCase();
    return `<div class="pv g-${esc(g)}" data-tag="${esc(t.id)}" tabindex="0" role="button" aria-label="${esc(t.name)}">
      <div class="top"><span class="pv-ic"><svg viewBox="0 0 24 24">${PV_ICON[g] || PV_ICON.analysis}</svg></span><div class="n">${esc(t.name)}</div><span class="badge"></span></div>
      <div class="v num"><span class="pv-num">--</span><small>${esc(t.unit || "")}</small><span class="pv-tr flat"></span></div>
      <svg class="pv-spark empty" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><path class="a"/><path class="l"/><circle class="d" r="2.2"/></svg>
      <div class="bar"><i></i><b title="Alarm set point"></b></div>
      <div class="meta"><span class="pv-sp"></span><span class="pv-q"></span></div></div>`;
  }
  function renderPvTiles(shown, all) {
    const box = $("pvList");
    const sig = shown.map((t) => t.id).join(",");
    if (box._sig !== sig) {
      box._sig = sig;
      box.innerHTML = shown.map(pvTileHTML).join("");
      box.querySelectorAll(".pv").forEach((el, i) => {
        el.style.animationDelay = `${i * 40}ms`;
        el.onclick = () => openTag(el.dataset.tag);
        el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openTag(el.dataset.tag); } };
        drawSpark(el);
      });
      box.classList.add("pv-anim");
      setTimeout(() => box.classList.remove("pv-anim"), 1200);
    }
    shown.forEach((t) => {
      const el = box.querySelector(`.pv[data-tag="${CSS.escape(t.id)}"]`);
      if (!el) return;
      const inAlarm = live.alarms.some((a) => a.tag === t.id || a.tag === t.id + "_ALM");
      const bad = ["NODATA", "STALE"].includes(t.quality);
      el.classList.toggle("alarm", inAlarm);
      el.classList.toggle("bad", bad);
      const badge = el.querySelector(".badge");
      badge.className = `badge ${inAlarm || bad ? "al" : "ok"}`;
      badge.textContent = inAlarm ? "Alarm" : bad ? "No data" : "Normal";
      const num = el.querySelector(".pv-num");
      if (typeof t.value === "number") tweenNum(num, t.value, t.decimals ?? 1);
      else { num._v = undefined; num.textContent = fmtValue(t); }
      const pct = pctOf(t, t.value), sp = pctOf(t, t.setpoint_value);
      const bar = el.querySelector(".bar");
      bar.hidden = pct == null;
      bar.querySelector("i").style.width = `${pct ?? 0}%`;
      const mk = bar.querySelector("b");
      mk.hidden = sp == null;
      if (sp != null) mk.style.left = `${sp}%`;
      el.querySelector(".pv-sp").textContent = t.setpoint_value != null ? `Alarm at ${Number(t.setpoint_value).toFixed(t.decimals ?? 1)} ${t.unit || ""}`
        : `Range ${t.eng_min ?? "-"}–${t.eng_max ?? "-"} ${t.unit || ""}`;
      const qb = qBadge(t);
      const q = el.querySelector(".pv-q");
      if (q._h !== qb) { q._h = qb; q.innerHTML = qb; }
    });
    if (Date.now() - pvSparkAt > 60000) loadPvSpark(all.map((t) => t.id));
  }

  async function loadOvTrend(force) {
    if (!live || !ovGroup) return;
    lastOvFetch = Date.now();
    const tags = live.tags.filter((t) => t.group === ovGroup && t.trend).slice(0, 4);
    if (!tags.length) return;
    $("trendUnit").textContent = tags[0].unit ? `· ${tags[0].unit}` : "";
    const seq = ++ovSeq;
    try {
      const r = await fetchTrend(tags.map((t) => t.id), ovHist || { minutes: ovMin }, ovZoom, ovHist ? 300 : 200);
      if (seq !== ovSeq) return;                         // a newer request (zoom / range change) is on its way
      ovLast = { r, tags };
      if (!ovHist) setApplied($("ovRange"), r.from, r.to, " · live");
      drawOvTrend(!!force);
    } catch (e) { if (force) toast(e.message, true); }
  }
  // one chart with several tags: use a fixed Y-axis end only when every tag on it has one (lowest min / highest max)
  function sharedAxis(tags) {
    const mins = tags.map((t) => t.trend_min), maxs = tags.map((t) => t.trend_max);
    const ok = (a) => a.length && a.every((v) => v != null && v !== "");
    return { yMin: ok(mins) ? Math.min(...mins) : null, yMax: ok(maxs) ? Math.max(...maxs) : null };
  }
  // chips above the chart: live value + change; click = show/hide, hover = highlight that line
  let ovLast = null;
  const ovHidden = new Set();
  function drawOvTrend(animate) {
    if (!ovLast) return;
    const { r, tags } = ovLast;
    const d0 = tags[0].decimals ?? 1, unit = tags[0].unit || "";
    const fmt = (v) => (v == null ? "-" : Number(v).toLocaleString(undefined, { minimumFractionDigits: d0, maximumFractionDigits: d0 }));
    const win = ovZoom || [r.from, r.to];
    const past = !!(ovHist || ovZoom);
    const info = r.series.map((s, i) => {
      const pts = inWin(s.points, win);
      const t = tagById(s.id) || {};
      // custom range / zoom: the chip shows the last value of the window shown, not today's live value
      return { s, i, color: SERIES[i], now: past ? (pts.at(-1) || {}).avg : t.value ?? (pts.at(-1) || {}).avg, first: (pts[0] || {}).avg,
        sp: t.setpoint_value, hidden: ovHidden.has(s.id) };
    });
    const sim = r.series.some((s) => s.points.some((p) => p.sim));
    $("ovLegend").innerHTML = info.map((x) => {
      const dv = x.now != null && x.first != null ? x.now - x.first : null;
      const dir = dv == null || Math.abs(dv) < Math.pow(10, -d0) ? "flat" : dv > 0 ? "up" : "down";
      const high = x.sp != null && x.now != null && x.now >= x.sp;
      return `<button class="ov-chip ${x.hidden ? "off" : ""} ${high ? "high" : ""}" data-i="${x.i}" data-id="${esc(x.s.id)}" style="--c:${x.color}" aria-pressed="${!x.hidden}"
        title="${esc(x.s.name)} - click to ${x.hidden ? "show" : "hide"}"><i></i><span class="nm">${esc(x.s.name)}</span>
        <b class="num">${fmt(x.now)}<small>${esc(unit)}</small></b><span class="tr-delta ${dir}">${dir === "up" ? "▲" : dir === "down" ? "▼" : "▬"}${dv == null ? "" : " " + fmt(Math.abs(dv))}</span></button>`;
    }).join("");
    $("ovLegend").querySelectorAll(".ov-chip").forEach((b) => {
      b.onclick = () => { const id = b.dataset.id; ovHidden.has(id) ? ovHidden.delete(id) : ovHidden.add(id); drawOvTrend(true); };
      b.onmouseenter = () => { const svg = $("ovChart").querySelector("svg"); if (svg && !b.classList.contains("off")) svg.dataset.hl = b.dataset.i; };
      b.onmouseleave = () => { const svg = $("ovChart").querySelector("svg"); if (svg) delete svg.dataset.hl; };
    });
    // alarm set point line(s) - one per distinct set point of the shown values
    const sps = [...new Set(info.filter((x) => !x.hidden && x.sp != null).map((x) => x.sp))];
    const limits = sps.length === 1 ? [{ v: sps[0], label: `Alarm SP ${fmt(sps[0])} ${unit}` }] : [];
    // fixed height (the card is alone on its row); in full screen the chart takes the screen height left under the
    // header and chips; the zoom toolbar sits above the plot inside the box
    const box = $("ovChart"), card = $("ovTrendCard");
    box.style.height = "";
    const full = document.fullscreenElement === card;
    const height = full ? Math.max(280, card.clientHeight - box.offsetTop - $("ovFoot").offsetHeight - 110) : 280;
    MDChart.renderMulti(box, { unit, decimals: d0, from: r.from, to: r.to, height, animate, area: true, limits, ...sharedAxis(tags),
      zoomGroup: "ov",
      onView: (a, b, { reset }) => { ovZoom = reset ? null : [a, b]; ovBadge(); loadOvTrend(false); },
      series: info.map((x) => ({ name: x.s.name, color: x.color, points: x.s.points, hidden: x.hidden })) });
    const shown = info.filter((x) => !x.hidden && x.now != null);
    const hiX = shown.reduce((a, x) => (!a || x.now > a.now ? x : a), null), loX = shown.reduce((a, x) => (!a || x.now < a.now ? x : a), null);
    const short = (n) => esc(n.split(" ")[0]);
    const when = past ? "at end of the range shown" : "now";
    $("ovFoot").innerHTML = (hiX ? `<span><em>Highest ${when}</em> <i style="background:${hiX.color}"></i>${short(hiX.s.name)} <b class="num">${fmt(hiX.now)} ${esc(unit)}</b></span>` : "") +
      (loX && loX !== hiX ? `<span><em>Lowest ${when}</em> <i style="background:${loX.color}"></i>${short(loX.s.name)} <b class="num">${fmt(loX.now)} ${esc(unit)}</b></span>` : "") +
      (sps.length > 1 ? `<span><em>Alarm set points</em> ${sps.map(fmt).join(" / ")} ${esc(unit)}</span>` : "") +
      (sim ? '<span class="q SIMULATED">DEMO DATA</span>' : "") + gapNote(r);
  }
  // explain empty stretches: history is only recorded while the dashboard server is running
  function gapNote(r) {
    const ts = [...new Set(r.series.flatMap((s) => s.points.filter((p) => p.avg != null).map((p) => p.t)))].sort((a, b) => a - b);
    const bucket = (r.to - r.from) / 160, minGap = Math.max(bucket * 4, 180);
    const edges = [r.from - bucket, ...ts, r.to + bucket];
    const gaps = [];
    for (let i = 1; i < edges.length; i++) if (edges[i] - edges[i - 1] > minGap) gaps.push([Math.max(r.from, edges[i - 1]), Math.min(r.to, edges[i])]);
    if (!gaps.length) return "";
    const t = (s) => fmtTime(s).replace(/:\d\d$/, "");
    const txt = !ts.length ? "No data was recorded in this period"
      : `No data ${gaps.slice(0, 2).map(([a, b]) => `${t(a)} - ${t(b)}`).join(", ")}${gaps.length > 2 ? " and more" : ""}`;
    return `<span class="ov-gap" title="History is saved by the dashboard server. While it is not running nothing is recorded.">⚠ ${txt}: the dashboard server was not running.</span>`;
  }
  // range picker: rolling presets (live, refreshed every 5 s) or a custom start / end date (history, not refreshed)
  function ovBadge() {
    const b = $("ovLiveBadge");
    const live = !ovHist && !ovZoom;
    b.classList.toggle("hist", !live);
    b.innerHTML = live ? '<span class="dot"></span>Live' : ovHist ? "History" : "Zoomed · paused";
    b.title = live ? "Updates automatically" : ovHist ? "Custom date range - not updated automatically" : "Zoomed in - press Full range to return to the live trend";
  }
  // process trend in full screen (Esc or the button closes it); the chart is drawn again at the new size, keeping the zoom
  if ($("ovFsBtn")) {
    $("ovFsBtn").onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else $("ovTrendCard").requestFullscreen().catch(() => toast("Full screen is not allowed here", true));
    };
    document.addEventListener("fullscreenchange", () => {
      const on = document.fullscreenElement === $("ovTrendCard"), b = $("ovFsBtn");
      b.setAttribute("aria-pressed", String(on));
      b.querySelector("span").textContent = on ? "Exit full screen" : "Full screen";
      requestAnimationFrame(() => drawOvTrend(false));
    });
  }
  const OV_PRESETS = [["1 hour", "1h"], ["8 hours", "8h"], ["24 hours", "24h"], ["2 days", "2d"], ["7 days", "7d"], ["Custom", "custom"]];
  makePicker($("ovRange"), OV_PRESETS, "1h", (w) => {
    if (w.minutes) { ovHist = null; ovMin = w.minutes; } else ovHist = { from: w.from, to: w.to };
    ovZoom = null;
    MDChart.resetZoom("ov");
    ovBadge();
    loadOvTrend(true);
  });

  // Equipment filters (brief SC05): the status filter (KPI tiles) and the area tab COMBINE -
  // Running + an area = running items of that area only; Tripped + All areas = every tripped item.
  // The KPI numbers count inside the selected area; the area tabs count the items that pass the status filter.
  let eqStatusF = "all";
  let eqView = (() => { try { return localStorage.getItem("md-eq-view") || "cards"; } catch (_) { return "cards"; } })();
  const areaOf = (e) => e.area || "Other";
  const EQ_FILTERS = [
    ["all", "All equipment", () => true, ""],
    ["run", "Running", (e) => eqState(e) === "run" || eqState(e) === "start", "g"],
    ["stop", "Stopped / ready", (e) => e.type === "motor" && eqState(e) === "stop", "n"],
    ["trip", "Tripped", (e) => eqState(e) === "trip" || eqState(e) === "warn", "r"],
    ["valve", "Valves open", (e) => e.type === "valve", "b"],          // shows every valve (open first count / total)
  ];
  const EQ_WORD = { all: "", run: "running ", stop: "stopped ", trip: "tripped ", valve: "valve " };
  function renderEqKpis(eq) {                // eq = equipment of the selected area
    const box = $("eqKpis");
    const motors = eq.filter((e) => e.type === "motor");
    const avail = motors.length ? Math.round((motors.filter((e) => eqState(e) !== "trip").length / motors.length) * 100) : 0;
    if (!box.children.length) {
      box.innerHTML = EQ_FILTERS.map(([k, label, , c]) => `<button type="button" class="eq-kpi k-${c || "a"}" data-f="${k}" aria-pressed="false"><span class="l">${label}</span>
        <b class="num"><span class="v">0</span><small class="of"></small></b></button>`).join("") +
        `<div class="eq-kpi k-av"><span class="l">Availability</span><b class="num"><span class="v">0</span><small>%</small></b><span class="av-bar"><i></i></span></div>`;
      box.querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => { eqStatusF = eqStatusF === b.dataset.f ? "all" : b.dataset.f; renderEquipment(); }));
    }
    const where = eqArea === "All" ? "all areas" : eqArea;
    EQ_FILTERS.forEach(([k, label, fn]) => {
      const b = box.querySelector(`[data-f="${k}"]`);
      b.classList.toggle("active", eqStatusF === k);
      b.setAttribute("aria-pressed", String(eqStatusF === k));
      b.title = `${label} - ${where}`;
      const n = k === "valve" ? eq.filter((e) => e.type === "valve" && eqState(e) === "open").length : eq.filter(fn).length;
      tweenNum(b.querySelector(".v"), n, 0);
      b.querySelector(".of").textContent = k === "valve" ? ` / ${eq.filter((e) => e.type === "valve").length}` : k === "run" ? ` / ${motors.length}` : "";
      if (k === "trip") b.classList.toggle("alert", n > 0);
    });
    const av = box.querySelector(".k-av");
    tweenNum(av.querySelector(".v"), avail, 0);
    av.querySelector(".av-bar i").style.width = avail + "%";
  }
  function renderEquipment() {
    const eq = live.equipment;
    const areas = ["All", ...new Set(eq.map(areaOf))];
    if (!areas.includes(eqArea)) eqArea = "All";
    const inArea = eq.filter((e) => eqArea === "All" || areaOf(e) === eqArea);
    renderEqKpis(inArea);
    const fx = EQ_FILTERS.find((x) => x[0] === eqStatusF) || EQ_FILTERS[0];
    const f = fx[2];
    const tabs = areas.map((a) => `<button type="button" class="${a === eqArea ? "active" : ""}" data-area="${esc(a)}" aria-pressed="${a === eqArea}">${esc(a === "All" ? "All areas" : a)}<span class="muted">${
      eq.filter((e) => (a === "All" || areaOf(e) === a) && f(e)).length}</span></button>`).join("");
    if ($("eqTabs")._h !== tabs) {
      $("eqTabs")._h = tabs;
      $("eqTabs").innerHTML = tabs;
      $("eqTabs").querySelectorAll("button").forEach((b) => (b.onclick = () => { eqArea = b.dataset.area; renderEquipment(); }));
    }
    const q = $("eqSearch").value.toLowerCase().trim();
    const list = inArea.filter((e) => f(e) &&
      (!q || e.name.toLowerCase().includes(q) || String(e.tag_no || "").toLowerCase().includes(q)));
    // what is shown: status filter + area (+ search), with a one-click way back to everything
    let note = $("eqShowing");
    if (!note) {
      note = document.createElement("div");
      note.id = "eqShowing"; note.className = "eq-showing"; note.setAttribute("aria-live", "polite");
      $("eqGrid").before(note);
    }
    const where = eqArea === "All" ? "all areas" : eqArea;
    const txt = `Showing ${list.length} ${EQ_WORD[fx[0]]}item${list.length === 1 ? "" : "s"} · ${where}${q ? ` · search “${$("eqSearch").value.trim()}”` : ""}`;
    const filtered = fx[0] !== "all" || eqArea !== "All";
    const h = `<span>${esc(txt)}</span>${filtered ? '<button type="button" class="link-btn" id="eqShowAll">Show all equipment</button>' : ""}`;
    if (note._h !== h) {
      note._h = h; note.innerHTML = h;
      const all = $("eqShowAll");
      if (all) all.onclick = () => { eqStatusF = "all"; eqArea = "All"; renderEquipment(); };
    }
    renderEqInto($("eqGrid"), list, { view: eqView, group: eqArea === "All",
      empty: `No ${EQ_WORD[fx[0]]}equipment in ${where}${q ? " matching the search" : ""}` });
  }
  $("eqSearch").oninput = () => live && renderEquipment();
  $("eqViewSeg").querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.v === eqView);
    b.onclick = () => {
      eqView = b.dataset.v;
      try { localStorage.setItem("md-eq-view", eqView); } catch (_) {}
      $("eqViewSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      renderEquipment();
    };
  });

  // ---------- alarms (simple: active alarms with Acknowledge + history list) ----------
  const realNote = (a) => (a.note && a.note !== "Acknowledged from alarm pop-up" && a.note !== "Acknowledged from alarms page" ? a.note : "");
  const PRIO_TXT = { red: "Critical", yellow: "Warning" };
  // where an alarm comes from: a PLC / field signal, or calculated by this dashboard (analog limits, comm loss)
  const srcBadge = (a) => (a.source === "dashboard"
    ? '<span class="al-src-b dash" title="Calculated by the dashboard from an analog limit or communication loss - not a plant alarm">DASHBOARD</span>'
    : '<span class="al-src-b plc" title="Alarm from the plant / field (trip input, alarm bit, safety input)">PLANT</span>');
  let histRows = [];
  function renderActive(box) {
    const rows = live.alarms.slice().sort((a, b) => (a.acked_at ? 1 : 0) - (b.acked_at ? 1 : 0) || b.raised_at - a.raised_at);
    $("alarmCount2").textContent = rows.length ? `${rows.length}` : "";
    box.innerHTML = rows.length ? rows.map((a) => `<div class="al-row p-${esc(a.priority)} ${a.acked_at ? "acked" : "unacked"}">
        <div class="al-main"><div class="al-msg">${esc(a.message)}</div>
          <div class="al-meta"><span class="al-pr">${PRIO_TXT[a.priority] || a.priority}</span>${srcBadge(a)} <b>${esc(a.tag_name || "")}</b> · Raised ${fmtTime(a.raised_at, true)} IST · active for ${dur(Date.now() / 1000 - a.raised_at)}
          ${a.simulated ? ' · <span class="q SIMULATED">DEMO</span>' : ""}</div>
          ${realNote(a) ? `<div class="al-note">“${esc(realNote(a))}”</div>` : ""}</div>
        <div class="al-ack">${a.acked_at
          ? `<span class="al-badge ok">✓ Acknowledged</span><span class="muted small">${a.acked_by ? esc(a.acked_by) + " · " : ""}${fmtTime(a.acked_at)}</span>`
          : me && !me.can_operate ? '<span class="al-badge">Not acknowledged</span><span class="muted small">view-only account</span>'
          : `<button class="btn primary al-ackbtn" data-ack="${a.id}">Acknowledge</button>`}</div></div>`).join("")
      : `<div class="al-clear"><span class="al-ok">✓</span><div><b>No active alarms</b></div></div>`;
    box.querySelectorAll("[data-ack]").forEach((b) => (b.onclick = () => ackFromPage(+b.dataset.ack, b)));
  }
  async function ackFromPage(id, btn) {
    btn.disabled = true;
    try {
      await api("/api/client/alarms/ack", { method: "POST", body: { ids: [id], notes: {} } });
      const now = Date.now() / 1000;
      live.alarms.forEach((a) => { if (a.id === id) a.acked_at = now; });
      toast("Alarm acknowledged");
      renderActive($("activeTable"));
      loadHistory();
    } catch (e) { toast(e.message, true); btn.disabled = false; }
  }
  // alarm history: range picker (presets + one calendar icon), search box, CSV / PDF of the rows shown
  let histWin = { minutes: 72 * 60 };
  function renderHistory() {
    const rows = histRows;
    const cal = MD.v3.CAL;
    // acknowledged and cleared are separate: an alarm can be cleared and never acknowledged, or acknowledged and still active
    $("histTable").innerHTML = `<thead><tr><th>Severity</th><th>Source</th><th>Device</th><th>Alarm</th><th>${cal}Raised (IST)</th><th>${cal}Cleared (IST)</th><th>Acknowledged</th><th>Note</th></tr></thead><tbody>` +
      (rows.length ? rows.map((a) => `<tr class="${a.cleared_at ? "" : "is-active"}"><td><span class="al-pill p-${esc(a.priority)}">${PRIO_TXT[a.priority] || a.priority}</span>${a.simulated ? ' <span class="q SIMULATED">DEMO</span>' : ""}</td>
        <td>${srcBadge(a)}</td><td>${esc(a.tag_name || "")}</td>
        <td class="al-m">${esc(a.message)}</td><td class="num">${fmtTime(a.raised_at, true)}</td>
        <td class="num" data-export="${a.cleared_at ? fmtTime(a.cleared_at, true) : "Active"}">${a.cleared_at ? fmtTime(a.cleared_at, true) : '<span class="al-pill act">ACTIVE</span>'}</td>
        <td data-export="${a.acked_at ? esc(`${a.acked_by || "Yes"} ${fmtTime(a.acked_at, true)}`) : "-"}">${a.acked_at ? `<span class="al-ackd">✓ ${esc(a.acked_by || "Yes")}</span><div class="muted small num">${fmtTime(a.acked_at, true)}</div>` : '<span class="muted">-</span>'}</td>
        <td class="al-n">${realNote(a) ? esc(realNote(a)) : '<span class="muted">-</span>'}</td></tr>`).join("")
        : `<tr class="al-none"><td colspan="8" class="empty">No alarms in this period</td></tr>`) + "</tbody>";
    histSearch.run();
    histCountTxt();
  }
  function histCountTxt() {
    const shown = [...$("histTable").querySelectorAll("tbody tr:not(.al-none)")].filter((tr) => !tr.hidden).length;
    $("histCount").textContent = histRows.length ? (shown === histRows.length ? `${shown}` : `${shown} of ${histRows.length}`) : "";
  }
  async function loadHistory() {
    try {
      const n = nowS();
      const custom = histWin.from != null;
      const hours = custom ? Math.max(1, Math.ceil((n - histWin.from) / 3600)) : histWin.minutes / 60;
      const r = await api(`/api/alarms?state=history&hours=${hours}&limit=1000`);
      histRows = custom ? r.alarms.filter((a) => a.raised_at >= histWin.from && a.raised_at <= histWin.to) : r.alarms;
      if (!custom) setApplied($("histRange"), n - histWin.minutes * 60, n);
      renderHistory();
    } catch (e) { toast(e.message, true); }
  }
  const histSearch = MD.v3.tableSearch($("histSearch"), $("histTable"), { placeholder: "Search alarm, device or note…", onSearch: () => histCountTxt() });
  makePicker($("histRange"), [["24 hours", "24h"], ["3 days", "3d"], ["7 days", "7d"], ["30 days", "30d"], ["Custom", "custom"]], "3d", (w) => {
    histWin = w;
    loadHistory();
  }, { trendLimit: false, liveSuffix: "" });
  $("histCsv").onclick = () => {
    if (!histRows.length) { toast("No alarms in this period"); return; }
    MD.v3.exportCsv(`alarm-history_${MD.istDate(nowS())}.csv`, MD.v3.tableRows($("histTable")));
  };
  $("histPdf").onclick = () => {
    const txt = ($("histRange").querySelector(".dr-txt") || {}).textContent || "";
    MD.v3.printPdf($("histTable").closest(".card"), `Alarm history · ${txt}`);
  };

  // ---------- trends ----------
  function loadSel() { try { return JSON.parse(localStorage.getItem("md-trend") || "null") || []; } catch (_) { return []; } }
  function saveSel() { try { localStorage.setItem("md-trend", JSON.stringify(trendSel)); } catch (_) {} }

  // six clearly different colours; a value keeps its colour while it stays selected
  const TREND_COLORS = ["#4d7a00", "#e07a00", "#1a8fb0", "#c2185b", "#6a4fc9", "#8a6d00"];
  const GROUP_ORDER = ["Temperature", "Pressure", "Level", "Analysis"];
  let trendView = (() => { try { return localStorage.getItem("md-trend-view") || "grid"; } catch (_) { return "grid"; } })();
  let lastTrend = null;
  let trMin = 60;              // rolling live window (minutes) from a preset
  let trRange = null;          // custom {from, to} epoch s from the range picker; null = live rolling window
  let trZoom = null;           // zoomed window [a, b] inside the range (chart zoom / pan); null = full range
  let trSeq = 0;               // only the newest fetch may draw (a slow live refresh never overwrites a zoom)
  const colorOf = (id) => TREND_COLORS[Math.max(0, trendSel.indexOf(id)) % TREND_COLORS.length];
  const fmtN = (v, d) => (v == null || isNaN(v) ? "-" : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));

  // value pills: equal-width grid per measurement group (Temperature / Pressure / Level / Analysis), client order + names
  function trendPicker(cands) {
    const groups = [...new Set(cands.map((t) => t.group || "Other"))]
      .sort((a, b) => (GROUP_ORDER.indexOf(a) + 1 || 99) - (GROUP_ORDER.indexOf(b) + 1 || 99));
    $("tagPicker").innerHTML = groups.map((g) => `<div class="tp-group g-${esc(g.toLowerCase())}" role="group" aria-label="${esc(g)}"><span class="tp-h">${esc(g)}</span>
      <div class="tp-grid">${cands.filter((t) => (t.group || "Other") === g).map((t) => {
        const on = trendSel.includes(t.id);
        return `<button type="button" class="tp-chip ${on ? "on" : ""}" data-id="${esc(t.id)}" style="--c:${on ? colorOf(t.id) : "transparent"}" aria-pressed="${on}" title="${esc(t.name)}">
          <i aria-hidden="true"></i><span class="tp-n">${esc(t.name)}</span></button>`;
      }).join("")}</div></div>`).join("");
    $("tagPicker").querySelectorAll(".tp-chip").forEach((b) => (b.onclick = () => {
      const id = b.dataset.id;
      if (trendSel.includes(id)) trendSel = trendSel.filter((x) => x !== id);
      else if (trendSel.length >= 6) { toast("Maximum 6 values - remove one first"); return; }
      else trendSel.push(id);
      saveSel();
      renderTrends(true, true);
    }));
    trCountTxt();
  }
  function trCountTxt() {
    $("trCount").innerHTML = `${trendSel.length} of 6 selected` +
      (trendSel.length ? ` · <button type="button" class="link-btn" id="tpClear">Clear all</button>` : "");
    const c = $("tpClear");
    if (c) c.onclick = () => { trendSel = []; saveSel(); renderTrends(true, true); };
  }
  function trLiveBadge() { $("trLive").classList.toggle("hidden", !!(trRange || trZoom)); }
  // the range the charts show, right above them (calendar icon + start – end, IST)
  function trStrip(r, win) {
    const live = !trRange && !trZoom;
    return `<div class="tr-applied">${MD.v3.CAL}<span>${trZoom
      ? `<b>Zoomed</b> ${esc(appliedLabel(win[0], win[1]))} <span class="muted">· selected ${esc(appliedLabel(r.from, r.to))}</span>`
      : esc(appliedLabel(r.from, r.to, live ? " · live" : ""))}</span>
      ${trZoom ? '<button type="button" class="btn sm" id="trFull">Full range</button>' : ""}</div>`;
  }
  function trOnView(a, b, { reset }) {
    trZoom = reset ? null : [a, b];
    trLiveBadge();
    renderTrends(false, false);                       // finer data for the zoomed window
  }

  function trendStats(s, win) {
    const pts = inWin(s.points, win);
    if (!pts.length) return null;
    const mins = pts.map((p) => p.min ?? p.avg), maxs = pts.map((p) => p.max ?? p.avg);
    return { min: Math.min(...mins), max: Math.max(...maxs), avg: pts.reduce((a, p) => a + p.avg, 0) / pts.length,
      first: pts[0].avg, last: pts.at(-1).avg };
  }

  async function renderTrends(rebuildPicker, animate) {
    if (!live) return;
    const cands = live.tags.filter((t) => t.trend);
    if (!trendSel.length && !loadSel().length && !renderTrends._init) trendSel = cands.filter((t) => t.data_type !== "BOOL").slice(0, 4).map((t) => t.id);
    renderTrends._init = true;
    trendSel = trendSel.filter((id) => cands.some((t) => t.id === id));
    if (rebuildPicker || !$("tagPicker").children.length) trendPicker(cands);
    lastTrendFetch = Date.now();
    const box = $("charts");
    box.classList.toggle("combined", trendView === "combined");
    const seq = ++trSeq;
    if (!trendSel.length) { box.innerHTML = '<div class="card empty tr-empty">Pick one or more values above to see their trend</div>'; lastTrend = null; return; }
    try {
      const r = await fetchTrend(trendSel, trRange || { minutes: trMin }, trZoom, 300);
      if (seq !== trSeq) return;
      lastTrend = r;
      if (!trRange) setApplied($("trRange"), r.from, r.to, " · live");
      const win = trZoom || [r.from, r.to];
      const past = !!(trRange || trZoom);              // custom / zoomed: numbers come from the window, never live
      // the zoom window itself lives in the chart group "trends" (survives these re-renders); trZoom mirrors it here
      const zopts = { zoomGroup: "trends", onView: trOnView };
      const sim = r.series.some((s) => s.points.some((p) => p.sim));
      const bindFull = () => { const b = $("trFull"); if (b) b.onclick = () => MDChart.zoom("trends", "reset"); };
      if (trendView === "combined") {
        // grouped by unit (= measurement type, e.g. all temperatures in °C) - one chart per unit, never a dual axis
        const units = [...new Set(r.series.map((s) => s.unit || ""))];
        box.innerHTML = trStrip(r, win) + units.map((u, ui) => {
          const ss = r.series.filter((s) => (s.unit || "") === u);
          return `<div class="card chart tr-card tr-combo ${animate ? "anim" : ""}" data-u="${ui}">
            <div class="tr-head"><div><span class="t">${esc(ss.map((s) => (tagById(s.id) || {}).group || "").filter((v, i, a) => v && a.indexOf(v) === i).join(" / ") || "Values")}</span>
              <div class="s">${esc(u || "no unit")} · ${ss.length} value${ss.length > 1 ? "s" : ""}${sim ? ' · <span class="q SIMULATED">DEMO DATA</span>' : ""}</div></div></div>
            <div class="tr-legend">${ss.map((s) => {
              const t = tagById(s.id) || {}, st = trendStats(s, win);
              const v = past ? (st ? st.last : null) : (t.value ?? (st && st.last));
              return `<span><i style="background:${colorOf(s.id)}"></i>${esc(s.name)} <b class="num">${fmtN(v, s.decimals ?? 1)}</b></span>`;
            }).join("")}</div>
            <div class="plot"></div></div>`;
        }).join("");
        bindFull();
        units.forEach((u, ui) => {
          const ss = r.series.filter((s) => (s.unit || "") === u);
          MDChart.renderMulti(box.querySelector(`[data-u="${ui}"] .plot`), { unit: u, decimals: ss[0].decimals, from: r.from, to: r.to, height: 300,
            ...sharedAxis(ss.map((s) => tagById(s.id) || {})), ...zopts,
            area: true, animate, series: ss.map((s) => ({ name: s.name, color: colorOf(s.id), points: s.points })) });
        });
        return;
      }
      box.innerHTML = trStrip(r, win) + r.series.map((s) => {
        const t = tagById(s.id) || {};
        const st = trendStats(s, win);
        const d = s.decimals ?? 1;
        const isBool = s.data_type === "BOOL";
        // custom / zoomed window: the big number is the window's last value (never the live one)
        const now = past ? (st ? st.last : null) : (t.value ?? (st && st.last));
        const sp = t.setpoint_value;
        const high = !isBool && sp != null && now != null && now >= sp;
        let delta = "";
        if (st && !isBool) {
          const dv = st.last - st.first, pc = st.first ? (dv / Math.abs(st.first)) * 100 : 0;
          const dir = Math.abs(dv) < Math.pow(10, -d) ? "flat" : dv > 0 ? "up" : "down";
          delta = `<span class="tr-delta ${dir}" title="Change over the range shown">${dir === "up" ? "▲" : dir === "down" ? "▼" : "▬"} ${fmtN(Math.abs(dv), d)}${st.first ? ` (${Math.abs(pc).toFixed(1)}%)` : ""}</span>`;
        }
        return `<div class="card chart tr-card ${high ? "is-high" : ""} ${animate ? "anim" : ""}" data-id="${esc(s.id)}" style="--c:${colorOf(s.id)};animation-delay:${r.series.indexOf(s) * 70}ms">
          <div class="tr-head">
            <div class="tr-title"><span class="sw"></span><div><span class="t">${esc(s.name)}</span>
              <div class="s">${esc(t.group || "")}${s.unit ? " · " + esc(s.unit) : ""}${s.points.some((p) => p.sim) ? ' · <span class="q SIMULATED">DEMO DATA</span>' : ""}</div></div></div>
            <div class="tr-now"><b class="num">${now == null ? "--" : isBool ? (now >= 0.5 ? esc((t.states || {}).true || "ON") : esc((t.states || {}).false || "OFF")) : fmtN(now, d)}</b>
              ${isBool ? "" : `<span class="u">${esc(s.unit || "")}</span>`}${delta}</div>
          </div>
          <div class="plot"></div>
          <div class="tr-stats">
            ${isBool ? `<div><span>On time</span><b class="num">${st ? Math.round(st.avg * 100) + " %" : "-"}</b></div>` : `
            <div><span>Min</span><b class="num">${st ? fmtN(st.min, d) : "-"}</b></div>
            <div><span>Average</span><b class="num">${st ? fmtN(st.avg, d) : "-"}</b></div>
            <div><span>Max</span><b class="num">${st ? fmtN(st.max, d) : "-"}</b></div>`}
            ${sp != null ? `<div><span>Alarm set point</span><b class="num sp">${fmtN(sp, d)}</b></div>` : ""}
            <div class="tr-state">${st ? `<span class="pill ${high ? "crit" : "good"}"><span class="dot"></span>${high ? "ABOVE SET POINT" : "NORMAL"}</span>`
              : '<span class="pill"><span class="dot"></span>NO DATA</span>'}</div>
          </div></div>`;
      }).join("");
      bindFull();
      r.series.forEach((s) => {
        const t = tagById(s.id) || {};
        const limits = [];
        if (t.setpoint_value != null) limits.push({ v: t.setpoint_value, label: `Alarm SP ${t.setpoint_value.toFixed(s.decimals ?? 1)}` });
        ["hihi", "hi", "lo", "lolo"].forEach((k) => { if (t.alarm && t.alarm[k] != null && t.alarm[k] !== "") limits.push({ v: +t.alarm[k], label: k.toUpperCase() }); });
        MDChart.render(box.querySelector(`[data-id="${CSS.escape(s.id)}"] .plot`), {
          name: s.name, unit: s.unit, decimals: s.decimals, color: colorOf(s.id), points: s.points, height: 230,
          from: r.from, to: r.to, isBool: s.data_type === "BOOL", limits, animate, yMin: t.trend_min, yMax: t.trend_max, ...zopts,
        });
      });
    } catch (e) { toast(e.message, true); }
  }
  // ONE range control: presets (rolling, live) + one calendar icon with a start / end date (history kept only)
  makePicker($("trRange"), [["15 min", "15m"], ["1 hour", "1h"], ["8 hours", "8h"], ["24 hours", "24h"], ["7 days", "7d"], ["Custom", "custom"]], "1h", (w) => {
    if (w.minutes) { trRange = null; trMin = w.minutes; } else trRange = { from: Math.round(w.from), to: Math.round(w.to) };
    trZoom = null;
    MDChart.resetZoom("trends");
    trLiveBadge();
    renderTrends(false, true);
  });
  $("trViewSeg").querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.v === trendView);
    b.onclick = () => {
      trendView = b.dataset.v;
      try { localStorage.setItem("md-trend-view", trendView); } catch (_) {}
      $("trViewSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      renderTrends(false, true);
    };
  });
  // CSV of the values for the range shown (the zoomed window when zoomed), times in IST
  $("trCsv").onclick = () => {
    if (!lastTrend || !lastTrend.series.length) { toast("Select values first"); return; }
    const ser = lastTrend.series, win = trZoom || [lastTrend.from, lastTrend.to];
    const times = [...new Set(ser.flatMap((s) => inWin(s.points, win).map((p) => p.t)))].sort((a, b) => a - b);
    const maps = ser.map((s) => new Map(s.points.map((p) => [p.t, p.avg])));
    const p2 = (n) => String(n).padStart(2, "0");
    const ts = (t) => { const d = MD.istParts(t); return `${d.y}-${p2(d.mo)}-${p2(d.d)} ${p2(d.h)}:${p2(d.mi)}:${p2(d.s)}`; };
    const rows = [["Time (IST, Asia/Kolkata)", ...ser.map((s) => `${s.name}${s.unit ? " (" + s.unit + ")" : ""}`)]];
    times.forEach((t) => rows.push([ts(t), ...maps.map((m, i) => (m.has(t) && m.get(t) != null ? Number(m.get(t)).toFixed(ser[i].decimals ?? 2) : ""))]));
    const fn = (t) => ts(t).slice(0, 16).replace(/[: ]/g, "-");
    MD.v3.exportCsv(`trend_${fn(win[0])}_to_${fn(win[1])}.csv`, rows);
  };
  $("trPdf").onclick = () => {
    if (!lastTrend || !lastTrend.series.length) { toast("Select values first"); return; }
    const a = $("charts").querySelector(".tr-applied");
    MD.v3.printPdf($("charts"), `Trends · ${a ? a.textContent.replace(/\s+/g, " ").replace("Full range", "").trim() : ""}`);
  };
  let rz;
  window.addEventListener("resize", () => {
    clearTimeout(rz);
    rz = setTimeout(() => { if (view === "trends") renderTrends(false); if (view === "overview") loadOvTrend(false); }, 250);
  });

  // ---------- tag drawer ----------
  async function openTag(id) {
    const t = tagById(id);
    if (!t) return;
    $("drawer").innerHTML = `<div class="row" style="justify-content:space-between"><h2>${esc(t.name)}</h2>
      <button class="btn sm" id="dClose">Close</button></div>
      <div style="font-size:36px;font-weight:800" class="num">${esc(fmtValue(t))} <span style="font-size:15px" class="muted">${esc(t.unit)}</span></div>
      <p>${qBadge(t)} <span class="muted">updated ${fmtTime(t.ts, true)} (${ago(t.ts)})</span></p>
      <dl class="kv"><dt>Type</dt><dd>${esc(t.group)}</dd><dt>Range</dt><dd>${t.eng_min ?? "-"} … ${t.eng_max ?? "-"} ${esc(t.unit)}</dd>
      ${t.setpoint_value != null ? `<dt>Alarm set point</dt><dd>${t.setpoint_value.toFixed(t.decimals ?? 1)} ${esc(t.unit)}</dd>` : ""}</dl>
      <h3 style="font-size:14px;margin:18px 0 6px">Last 1 hour</h3><div class="chart" id="dChart"></div>`;
    $("drawer").classList.remove("hidden");
    $("drawerBg").classList.remove("hidden");
    $("dClose").onclick = closeDrawer;
    $("dClose").focus();
    try {
      const r = await api(`/api/trend?tags=${encodeURIComponent(id)}&minutes=60&points=240`);
      const s = r.series[0];
      if (s) MDChart.render($("dChart"), { name: s.name, unit: s.unit, decimals: s.decimals, color: SERIES[0], points: s.points,
        from: r.from, to: r.to, isBool: s.data_type === "BOOL", limits: t.setpoint_value != null ? [{ v: t.setpoint_value, label: "SP" }] : [],
        yMin: t.trend_min, yMax: t.trend_max });
    } catch (e) { $("dChart").textContent = e.message; }
  }
  function closeDrawer() { $("drawer").classList.add("hidden"); $("drawerBg").classList.add("hidden"); }
  $("drawerBg").onclick = closeDrawer;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
    if (e.key === "Enter" && e.target.classList && e.target.classList.contains("pv")) openTag(e.target.dataset.tag);
  });

  MD.openTag = openTag;                               // used by js/plant.js
  loadMeta().then(() => { if (view === "reports") route(); }).catch(() => {});   // these pages need the meta (shifts, RTD group)
  loadMe().catch(() => {});
  route();
  poll();
})();
