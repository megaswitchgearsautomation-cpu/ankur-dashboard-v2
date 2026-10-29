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
  const TITLES = { overview: "Plant dashboard", equipment: "Equipment", trends: "Trends", alarms: "Alarms" };   // Reports page removed on client request
  function route() {
    view = (location.hash || "#overview").slice(1);
    if (!TITLES[view]) view = "overview";
    $("pageTitle").textContent = TITLES[view];
    const navIc = document.querySelector(`#segNav a[data-view="${view}"] svg`);
    $("headIcon").innerHTML = navIc ? navIc.outerHTML : "";
    document.querySelectorAll("[data-section]").forEach((s) => s.classList.toggle("hidden", s.dataset.section !== view));
    document.querySelectorAll("[data-view]").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
    render();
    if (view === "trends") renderTrends(true, true);
    if (view === "alarms") loadHistory();
    if (view === "overview") loadOvTrend(true);
  }
  window.addEventListener("hashchange", route);

  // ---------- data ----------
  async function loadMeta() {
    const meta = await api("/api/meta");
    $("siteName").textContent = `${meta.site.name} · ${meta.site.panel}`;
  }
  async function poll() {
    try {
      live = await api("/api/live");
      render();
      if (view === "trends" && Date.now() - lastTrendFetch > 5000) renderTrends(false);
      if (view === "overview" && Date.now() - lastOvFetch > 5000) loadOvTrend(false);
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
    if (view === "overview") renderOverview();
    if (view === "equipment") renderEquipment();
    if (view === "alarms") renderActive($("activeTable"));
    renderAlarmPopup();
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
  // header date + clock (this computer's local time)
  function tickClock() {
    const d = new Date();
    $("headClock").textContent = d.toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short", year: "numeric" }) + " · " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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

  // ---------- hero card "Equipment running": count + ring + one block per motor, updated in place ----------
  const RING_LEN = 2 * Math.PI * 30;
  function renderHero(eq, motors, running, tripped, stopped, tag) {
    const box = $("hero");
    const sig = motors.map((e) => e.id).join(",");
    const valves = eq.filter((e) => e.type === "valve");
    if (box._sig !== sig) {
      box._sig = sig;
      box.innerHTML = `<div class="hx-top"><span class="lbl">Equipment running</span><span class="tag" id="hxTag" hidden></span></div>
        <div class="hx-mid">
          <div><div class="big num"><span id="hxRun">0</span><small> / ${motors.length}</small></div><div class="hx-sub">motors running now</div></div>
          <svg class="hx-ring" viewBox="0 0 76 76" aria-hidden="true"><circle cx="38" cy="38" r="30" class="r-bg"/>
            <circle cx="38" cy="38" r="30" class="r-val" id="hxRing" style="stroke-dasharray:0 ${RING_LEN}"/>
            <text x="38" y="42" text-anchor="middle" class="r-txt" id="hxPct">0%</text></svg>
        </div>
        <div class="hx-chips">
          <span class="hx-c t"><i></i><b class="num" id="hxTrip">0</b> Tripped</span>
          <span class="hx-c s"><i></i><b class="num" id="hxStop">0</b> Stopped</span>
          <span class="hx-c v"><i></i><b class="num" id="hxValve">0</b><small>/${valves.length}</small> Valves open</span>
        </div>`;
    }
    tweenNum($("hxRun"), running, 0);
    const pct = motors.length ? Math.round((running / motors.length) * 100) : 0;
    $("hxRing").style.strokeDasharray = `${(pct / 100) * RING_LEN} ${RING_LEN}`;
    $("hxPct").textContent = pct + "%";
    tweenNum($("hxTrip"), tripped, 0);
    tweenNum($("hxStop"), stopped, 0);
    tweenNum($("hxValve"), valves.filter((e) => e.status === "OPEN").length, 0);
    box.classList.toggle("has-trip", tripped > 0);
    const t = $("hxTag");
    t.hidden = !tag;
    t.textContent = tag || "";
  }

  // ---------- the four small overview cards: built once, then updated in place ----------
  const GAUGE_LEN = Math.PI * 46;                       // half circle, r = 46
  function gaugeXY(pct, r) { const a = Math.PI * (1 - pct / 100); return [60 + r * Math.cos(a), 58 - r * Math.sin(a)]; }
  function renderMini(red, yellow, tripped, ph, pr) {
    const box = $("miniStats");
    const sig = `${ph ? ph.id : ""}|${pr ? pr.id : ""}`;
    if (box._sig !== sig) {
      box._sig = sig;
      box.innerHTML = `
        <div class="mini mk-al" id="mkAl"><div class="lbl">Active alarms</div><span class="ic">${SVG.bell}</span>
          <div class="val num"><span id="mkAlN">0</span><span class="mk-word" id="mkAlW"></span></div>
          <div class="mk-pills"><span class="mk-p r"><i></i><b class="num" id="mkAlR">0</b> critical</span><span class="mk-p y"><i></i><b class="num" id="mkAlY">0</b> warning</span></div>
          <a class="mk-link" href="#alarms">View alarms →</a></div>
        <div class="mini mk-st" id="mkSt"><div class="lbl">Plant status</div><span class="ic">${SVG.shield}</span>
          <div class="val" id="mkStV">-</div>
          <div class="mk-meter"><span data-s="ok">Normal</span><span data-s="warn">Attention</span><span data-s="bad">Alarm</span></div>
          <div class="d" id="mkStD"></div></div>
        ${ph ? `<div class="mini mk-ph mk-click" id="mkPh" tabindex="0" role="button" title="Open pH details"><div class="lbl">${esc(ph.name.replace(/ For Process Water/i, ""))}</div><span class="ic">${SVG.drop}</span>
          <div class="val num"><span id="mkPhV">--</span> <small>pH</small><span class="mk-zone" id="mkPhZ"></span></div>
          <div class="mk-scale"><b id="mkPhSp" title="Alarm set point"></b><i id="mkPhM"></i></div>
          <div class="mk-ticks"><span>0 acidic</span><span>7 neutral</span><span>alkaline 14</span></div>
          <div class="d" id="mkPhD"></div></div>` : ""}
        ${pr ? `<div class="mini mk-pr mk-click" id="mkPr" tabindex="0" role="button" title="Open pressure details"><div class="lbl">${esc(pr.name.replace(/ Distribution Line/i, ""))}</div><span class="ic">${SVG.gauge}</span>
          <svg class="mk-gauge" viewBox="0 0 120 66" aria-hidden="true">
            <path d="M14 58 A46 46 0 0 1 106 58" class="g-bg"/>
            <path d="M14 58 A46 46 0 0 1 106 58" class="g-val" id="mkPrArc" style="stroke-dasharray:0 ${GAUGE_LEN}"/>
            <line id="mkPrSp" class="g-sp" x1="0" y1="0" x2="0" y2="0"/>
            <g id="mkPrN" class="g-needle" style="transform:rotate(-90deg)"><line x1="60" y1="58" x2="60" y2="20"/></g>
            <circle cx="60" cy="58" r="5" class="g-hub"/>
            <text x="12" y="66" class="g-t">${pr.eng_min ?? 0}</text><text x="108" y="66" text-anchor="end" class="g-t">${pr.eng_max ?? ""}</text></svg>
          <div class="val num mk-prv"><span id="mkPrV">--</span> <small>${esc(pr.unit || "")}</small></div>
          <div class="d" id="mkPrD"></div></div>` : ""}`;
      if (ph) $("mkPh").onclick = () => openTag(ph.id);
      if (pr) $("mkPr").onclick = () => openTag(pr.id);
      box.querySelectorAll(".mk-click").forEach((el) => (el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.click(); } }));
    }
    // alarms
    const n = live.alarms.length, unacked = live.alarms.some((a) => !a.acked_at);
    const al = $("mkAl");
    al.dataset.state = red ? "crit" : yellow ? "warn" : "clear";
    al.classList.toggle("ringing", unacked);
    tweenNum($("mkAlN"), n, 0);
    $("mkAlW").textContent = n ? "" : "All clear";
    tweenNum($("mkAlR"), red, 0);
    tweenNum($("mkAlY"), yellow, 0);
    // plant status
    const st = red || tripped ? "bad" : yellow ? "warn" : "ok";
    $("mkSt").dataset.state = st;
    $("mkStV").textContent = { ok: "Normal", warn: "Attention", bad: "Alarm" }[st];
    $("mkStD").textContent = st === "ok" ? "All systems normal" : st === "warn" ? `${yellow} warning${yellow > 1 ? "s" : ""} active`
      : [tripped ? `${tripped} tripped` : "", red ? `${red} critical` : ""].filter(Boolean).join(" · ");
    $("mkSt").querySelectorAll(".mk-meter span").forEach((s) => s.classList.toggle("on", s.dataset.s === st));
    // pH on a 0-14 scale
    if (ph && $("mkPh")) {
      const v = typeof ph.value === "number" ? ph.value : null;
      if (v != null) tweenNum($("mkPhV"), v, ph.decimals ?? 2); else $("mkPhV").textContent = "--";
      $("mkPhM").style.left = `${Math.max(0, Math.min(100, ((v ?? 7) / 14) * 100))}%`;
      $("mkPhM").hidden = v == null;
      const sp = ph.setpoint_value;
      $("mkPhSp").hidden = sp == null;
      if (sp != null) $("mkPhSp").style.left = `${Math.max(0, Math.min(100, (sp / 14) * 100))}%`;
      const zone = v == null ? "" : v < 6.5 ? "Acidic" : v > 8.5 ? "Alkaline" : "Neutral";
      $("mkPhZ").textContent = zone;
      $("mkPhZ").className = `mk-zone z-${zone.toLowerCase()}`;
      $("mkPh").classList.toggle("high", v != null && sp != null && v >= sp);
      $("mkPhD").textContent = sp != null ? `Alarm SP ${Number(sp).toFixed(ph.decimals ?? 2)} pH` : "";
    }
    // pressure gauge
    if (pr && $("mkPr")) {
      const v = typeof pr.value === "number" ? pr.value : null;
      const pct = pctOf(pr, v) ?? 0, spp = pctOf(pr, pr.setpoint_value);
      if (v != null) tweenNum($("mkPrV"), v, pr.decimals ?? 1); else $("mkPrV").textContent = "--";
      $("mkPrN").style.transform = `rotate(${-90 + pct * 1.8}deg)`;
      $("mkPrArc").style.strokeDasharray = `${(pct / 100) * GAUGE_LEN} ${GAUGE_LEN}`;
      const sl = $("mkPrSp");
      if (spp != null) {
        const [x1, y1] = gaugeXY(spp, 38), [x2, y2] = gaugeXY(spp, 54);
        sl.setAttribute("x1", x1); sl.setAttribute("y1", y1); sl.setAttribute("x2", x2); sl.setAttribute("y2", y2);
      }
      sl.style.display = spp == null ? "none" : "";
      $("mkPr").classList.toggle("high", v != null && pr.setpoint_value != null && v >= pr.setpoint_value);
      $("mkPrD").textContent = pr.setpoint_value != null ? `Alarm SP ${Number(pr.setpoint_value).toFixed(pr.decimals ?? 1)} ${pr.unit || ""}` : "";
    }
  }
  const tagById = (id) => live.tags.find((t) => t.id === id);

  function renderOverview() {
    const eq = live.equipment;
    const motors = eq.filter((e) => e.type === "motor");
    const running = motors.filter((e) => e.status === "RUNNING").length;
    const tripped = eq.filter((e) => ["TRIP", "FAULT"].includes(e.status)).length;
    const stopped = motors.filter((e) => e.status === "STOPPED").length;
    const red = live.alarms.filter((a) => a.priority === "red").length;
    const yellow = live.alarms.length - red;
    const tag = srcTag();

    renderHero(eq, motors, running, tripped, stopped, tag);

    const ph = live.tags.find((t) => t.kpi && t.unit === "pH");
    const pr = live.tags.find((t) => t.kpi && t.group === "Pressure");
    renderMini(red, yellow, tripped, ph, pr);

    // equipment availability card - motors only (valves are not counted)
    //   available = running + stopped-and-ready; not available = tripped / fault / no feedback / no data
    const mc = (sts) => motors.filter((e) => sts.includes(e.status)).length;
    const aRun = mc(["RUNNING", "STARTING"]), aReady = mc(["STOPPED"]), aTrip = mc(["TRIP", "FAULT"]), aWarn = mc(["NO FEEDBACK"]);
    const aNone = motors.length - aRun - aReady - aTrip - aWarn;
    const avail = aRun + aReady;
    const av = motors.length ? Math.round((avail / motors.length) * 100) : 0;
    const segs = [["Running", aRun, "#77c000"], ["Ready", aReady, "#fdd079"], ["Tripped", aTrip, "#e5484d"]];
    if (aWarn) segs.push(["No run feedback", aWarn, "#f5a524"]);
    if (aNone) segs.push(["No data", aNone, "#c9c9c4"]);
    const notAv = motors.length - avail;
    $("availCard").innerHTML = `<div class="g-top"><span class="g-lbl" title="Share of motors that are running or ready to start">Equipment availability</span>
        <span class="av-badge ${av === 100 ? "ok" : av >= 90 ? "warn" : "bad"}">${av === 100 ? "All available" : `${notAv} not available`}</span></div>
      <div class="av-line"><b class="num">${avail}</b> of <b class="num">${motors.length}</b> motors are ready to run</div>
      <div class="pie-row">${pieSVG(segs, motors.length, `${av}%`, "available")}
      <dl class="pie-legend">${segs.map(([l, n, c]) => `<dt><i style="background:${c}"></i>${l}</dt><dd class="num" ${l.startsWith("Tripped") && n ? 'style="color:var(--crit-ink)"' : ""}>${n}</dd>`).join("")}
      <dt class="sep">Last update</dt><dd class="num sep">${fmtTime(live.status.last_update)}</dd></dl></div>`;
    $("availCard").title = `Availability = (running ${aRun} + ready ${aReady}) ÷ ${motors.length} motors = ${av}%. Tripped or faulted motors lower it. Valves are not counted.`;

    // tank levels card (donut per tank, red tick = alarm set point)
    const levels = live.tags.filter((t) => t.group === "Level");
    $("levelCard").innerHTML = levels.length ? `<div class="g-top"><span class="g-lbl">Tank levels</span></div>` + levels.map((t) => {
      const pct = pctOf(t, t.value), sp = pctOf(t, t.setpoint_value);
      const high = pct != null && sp != null && pct >= sp;
      return `<div class="pie-row lvl">${levelSVG(pct, sp, high)}
        <div class="lvl-info"><div class="lvl-name">${esc(t.name.replace(/ Level$/, ""))}</div>
        <dl><dt>Level</dt><dd class="num">${esc(fmtValue(t))} ${esc(t.unit)}</dd>
        ${t.setpoint_value != null ? `<dt>Alarm set point</dt><dd class="num">${Number(t.setpoint_value).toFixed(t.decimals ?? 1)} ${esc(t.unit)}</dd>` : ""}
        <dt>Capacity</dt><dd class="num">${t.eng_max ?? "-"} ${esc(t.unit)}</dd></dl></div></div>`;
    }).join("") : '<div class="empty">No level tags</div>';

    // trend segment
    const groups = PROCESS_GROUPS.filter((g) => live.tags.some((t) => t.group === g && t.trend));
    if (!groups.includes(ovGroup)) ovGroup = groups[0];
    $("ovTrendSeg").innerHTML = groups.map((g) => `<button class="${g === ovGroup ? "active" : ""}" data-g="${esc(g)}">${esc(g)}</button>`).join("");
    $("ovTrendSeg").querySelectorAll("button").forEach((b) => (b.onclick = () => { ovGroup = b.dataset.g; loadOvTrend(true); renderOverview(); }));

    // process values
    const pv = live.tags.filter((t) => PROCESS_GROUPS.includes(t.group));
    const pgs = ["All", ...PROCESS_GROUPS.filter((g) => pv.some((t) => t.group === g))];
    $("pvSeg").innerHTML = pgs.map((g) => `<button class="${g === pvGroup ? "active" : ""}" data-g="${esc(g)}">${esc(g)}</button>`).join("");
    $("pvSeg").querySelectorAll("button").forEach((b) => (b.onclick = () => { pvGroup = b.dataset.g; renderOverview(); }));
    const shown = pv.filter((t) => pvGroup === "All" || t.group === pvGroup);
    $("pvCount").textContent = `${shown.length}`;
    renderPvTiles(shown, pv);

    // alarms
    $("alarmCount").textContent = live.alarms.length ? `${live.alarms.length}` : "";
    $("alarmMini").innerHTML = live.alarms.length
      ? `<div class="table-wrap"><table>${live.alarms.slice(0, 5).map((a) => `<tr class="${a.acked_at ? "" : "unacked"}"><td>${prio(a.priority)}<div style="font-weight:600">${esc(a.message)}</div>
          <div class="muted" style="font-size:11.5px">${fmtTime(a.raised_at)} · ${dur(Date.now() / 1000 - a.raised_at)}${a.simulated ? ' · <span class="q SIMULATED">SIM</span>' : ""}</div></td></tr>`).join("")}</table></div>`
      : `<div class="empty">No active alarms</div>`;

    // run hours
    renderRunHours(motors);

    // equipment
    const counts = {};
    eq.forEach((e) => (counts[e.status] = (counts[e.status] || 0) + 1));
    const order = [["RUNNING", "green"], ["STOPPED", "grey"], ["TRIP", "red"], ["NO FEEDBACK", "yellow"], ["STARTING", "yellow"],
      ["OPEN", "green"], ["CLOSED", "grey"], ["TRAVEL", "yellow"], ["FAULT", "red"], ["UNKNOWN", "grey"]];
    $("eqSummary").innerHTML = order.filter(([s]) => counts[s]).map(([s, col]) =>
      `<span class="status ${col}"><span class="dot"></span>${s} ${counts[s]}</span>`).join("");
    const rank = { TRIP: 0, FAULT: 0, "NO FEEDBACK": 1, UNKNOWN: 2, STARTING: 3, RUNNING: 4, OPEN: 5, STOPPED: 6, CLOSED: 7, TRAVEL: 3 };
    renderEqInto($("eqCards"), eq.slice().sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.id.localeCompare(b.id)).slice(0, 8), { view: "cards" });

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
  let rhShow = 8;
  const rhRows = new Map();
  const RH_STATE = { RUNNING: ["run", "Running"], STARTING: ["run", "Starting"], TRIP: ["trip", "Tripped"], FAULT: ["trip", "Fault"],
    "NO FEEDBACK": ["warn", "No feedback"], STOPPED: ["stop", "Stopped"] };
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
  document.querySelectorAll("#rhSeg button").forEach((b) => (b.onclick = () => {
    rhShow = b.dataset.n === "all" ? Infinity : +b.dataset.n;
    document.querySelectorAll("#rhSeg button").forEach((x) => x.classList.toggle("active", x === b));
    renderRunHours(live.equipment.filter((e) => e.type === "motor"));
  }));
  function renderRunHours(motors) {
    const sorted = motors.slice().sort((a, b) => b.run_hours - a.run_hours);
    const shown = sorted.slice(0, rhShow);
    const maxH = Math.max(0.01, ...sorted.map((e) => e.run_hours));
    const total = motors.reduce((s, e) => s + (e.run_hours || 0), 0);
    const runningNow = motors.filter((e) => e.status === "RUNNING").length;
    const starts = motors.reduce((s, e) => s + (e.starts || 0), 0);
    // summary strip (built once, numbers tween)
    if (!$("rhTotal")) {
      $("rhSum").innerHTML = `<div class="rh-k"><span class="rh-l">Total run hours</span><b class="num" id="rhTotal">0</b></div>
        <div class="rh-k"><span class="rh-l">Running now</span><b class="num"><span id="rhRun">0</span><small id="rhOf"></small></b></div>
        <div class="rh-k"><span class="rh-l">Total starts</span><b class="num" id="rhStarts">0</b></div>`;
    }
    tweenNum($("rhTotal"), total, 1, " h");
    tweenNum($("rhRun"), runningNow, 0);
    $("rhOf").textContent = ` / ${motors.length}`;
    tweenNum($("rhStarts"), starts, 0);
    $("rhNote").textContent = motors.some((e) => e.simulated) ? "Simulated hours · bar = share of the highest" : "Since commissioning · bar = share of the highest";
    // rows
    const box = $("runBars");
    const keep = new Set(shown.map((e) => e.id));
    for (const [id, el] of rhRows) if (!keep.has(id)) { el.remove(); rhRows.delete(id); }
    shown.forEach((e, i) => {
      let el = rhRows.get(e.id);
      const fresh = !el;
      if (fresh) {
        el = document.createElement("div");
        el.className = "rh-row";
        el.innerHTML = `<span class="rh-rank"></span><span class="rh-dot"></span>
          <span class="rh-nm"><b class="rh-tag"></b><span class="rh-name"></span></span>
          <span class="rh-v num"></span>
          <span class="rh-tr"><i></i></span><span class="rh-sub muted"></span>`;
        el.style.animationDelay = `${i * 45}ms`;
        rhRows.set(e.id, el);
      }
      const [cls, label] = RH_STATE[e.status] || ["stop", e.status || "-"];
      el.dataset.state = cls;
      el.title = `${e.name} - ${label}`;
      el.querySelector(".rh-rank").textContent = i + 1;
      el.querySelector(".rh-tag").textContent = e.tag_no ? e.tag_no + " " : "";
      el.querySelector(".rh-name").textContent = e.name;
      el.querySelector(".rh-sub").textContent = `${label} · ${e.starts ?? 0} starts`;
      tweenNum(el.querySelector(".rh-v"), e.run_hours || 0, 1, " h");
      const bar = el.querySelector(".rh-tr i");
      const w = `${Math.max(1.5, (e.run_hours / maxH) * 100)}%`;
      if (fresh && !reduceMotion) { bar.style.width = "0%"; requestAnimationFrame(() => requestAnimationFrame(() => (bar.style.width = w))); }
      else bar.style.width = w;
      if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);   // keep rank order
    });
  }

  // pie / donut charts (circle r=15.915 -> circumference 100, so dash lengths are percentages)
  const PIE_R = 15.915;
  function pieSVG(segs, total, big, small) {
    let at = 0, arcs = "";
    const live = segs.filter((s) => s[1] > 0);
    for (const [label, n, color] of live) {
      const p = total ? (n / total) * 100 : 0;
      const gap = live.length > 1 ? 0.8 : 0;
      arcs += `<circle cx="21" cy="21" r="${PIE_R}" fill="none" stroke="${color}" stroke-width="7"
        stroke-dasharray="${Math.max(0, p - gap)} ${100 - Math.max(0, p - gap)}" stroke-dashoffset="${-at}"><title>${esc(label)}: ${n}</title></circle>`;
      at += p;
    }
    return `<svg class="pie" viewBox="0 0 42 42" role="img" aria-label="${esc(small)} ${esc(big)}">
      <g transform="rotate(-90 21 21)"><circle cx="21" cy="21" r="${PIE_R}" fill="none" stroke="#ececea" stroke-width="7"/>${arcs}</g>
      <text x="21" y="21.5" text-anchor="middle" class="pie-big">${esc(big)}</text>
      <text x="21" y="26.6" text-anchor="middle" class="pie-small">${esc(small)}</text></svg>`;
  }
  function levelSVG(pct, sp, high) {
    const p = pct ?? 0;
    let tick = "";
    if (sp != null) {
      const a = (sp / 100) * 2 * Math.PI - Math.PI / 2;
      const xy = (r) => `${(21 + r * Math.cos(a)).toFixed(2)} ${(21 + r * Math.sin(a)).toFixed(2)}`;
      tick = `<path d="M${xy(11.4)} L${xy(20.4)}" stroke="#e5484d" stroke-width="1.1" stroke-linecap="round"><title>Alarm set point ${Math.round(sp)}%</title></path>`;
    }
    return `<svg class="pie" viewBox="0 0 42 42" role="img" aria-label="Level ${Math.round(p)}%">
      <defs><linearGradient id="lvlg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c6e48b"/><stop offset=".6" stop-color="#77c000"/><stop offset="1" stop-color="#4d7a00"/></linearGradient></defs>
      <g transform="rotate(-90 21 21)"><circle cx="21" cy="21" r="${PIE_R}" fill="none" stroke="#ececea" stroke-width="7"/>
      <circle cx="21" cy="21" r="${PIE_R}" fill="none" stroke="${high ? "#e5484d" : "url(#lvlg)"}" stroke-width="7" stroke-dasharray="${p} ${100 - p}"/></g>${tick}
      <text x="21" y="21.5" text-anchor="middle" class="pie-big">${pct == null ? "--" : Math.round(p) + "%"}</text>
      <text x="21" y="26.6" text-anchor="middle" class="pie-small">full</text></svg>`;
  }
  function pctOf(t, v) {
    if (typeof v !== "number" || t.eng_min == null || t.eng_max == null || t.eng_max <= t.eng_min) return null;
    return Math.max(0, Math.min(100, ((v - t.eng_min) / (t.eng_max - t.eng_min)) * 100));
  }
  function spLine(t) {
    return t.setpoint_value != null ? `Alarm SP ${Number(t.setpoint_value).toFixed(t.decimals ?? 1)} ${esc(t.unit)}` : `Range ${t.eng_min ?? "-"}…${t.eng_max ?? "-"} ${esc(t.unit)}`;
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
          <div class="ps-sum-txt"><div class="ps-k"><span>Panel &amp; safety</span> · <span class="ps-s" id="psSub"></span></div><div class="ps-t" id="psTitle"></div></div></div>
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
      tw.textContent = lit.length ? lit.join(" + ") : "Off";
    }
    const sum = $("psSum");
    const state = bad.length ? "trip" : nod === safety.length && safety.length ? "nodata" : "ok";
    sum.dataset.state = state;
    $("psTitle").textContent = state === "trip" ? "SAFETY TRIP" : state === "nodata" ? "NO SAFETY DATA" : "ALL SAFE";
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
        <div class="eqc-top">${e.tag_no ? `<span class="eqc-tag">${esc(e.tag_no)}</span>` : ""}<span class="eqc-pill"><span class="dot"></span><b class="st"></b></span></div>
        <div class="eqc-name" title="${esc(e.name)}">${esc(e.name)}</div>
        <div class="eqc-meta">${esc(e.area || "")}${spec ? " · " + esc(spec) : ""}${e.simulated ? ' · <span class="q SIMULATED">DEMO</span>' : ""}</div>
      </div>
      <div class="eqc-stats">
        <div><span class="sl">In this state</span><b class="num since">-</b></div>
        ${motor ? `<div><span>Run hours</span><b class="num rh">-</b></div><div><span>Starts</span><b class="num starts">-</b></div>`
          : `<div><span>Position</span><b class="pos">-</b></div><div><span>Type</span><b>On-off</b></div>`}
      </div>
      ${motor ? '<div class="eqc-bar" title="Run hours compared with the most-used motor"><i></i></div>' : ""}
    </div>`;
  }
  function eqRowHTML(e) {
    const kind = eqKind(e);
    return `<div class="eql" data-id="${esc(e.id)}" data-kind="${kind}"><span class="eqc-ic sm">${eqIcon(kind)}</span>
      <span class="eqc-tag">${esc(e.tag_no || "-")}</span><span class="eql-name" title="${esc(e.name)}">${esc(e.name)}</span>
      <span class="muted eql-area">${esc(e.area || "")}</span><span class="eqc-pill"><span class="dot"></span><b class="st"></b></span>
      <b class="num since">-</b><b class="num rh">${e.type === "motor" ? "-" : ""}</b><b class="num starts">${e.type === "motor" ? "-" : ""}</b></div>`;
  }
  // run hours as h / m / s so a running pump visibly counts up every second
  function fmtRunHours(h) {
    const s = Math.max(0, Math.floor((h || 0) * 3600));
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return hh ? `${hh.toLocaleString()} h ${String(mm).padStart(2, "0")} m` : `${mm} m ${String(ss).padStart(2, "0")} s`;
  }
  const STATE_FOR = { RUNNING: "Running for", STOPPED: "Stopped for", TRIP: "Tripped for", OPEN: "Open for", CLOSED: "Closed for" };
  function fillEq(el, e, maxH) {
    const st = eqState(e);
    if (el.dataset.state !== st) el.dataset.state = st;
    const q = (s) => el.querySelector(s);
    q(".st").textContent = EQ_TXT[e.status] || e.status || "-";
    q(".since").textContent = e.since ? dur(Date.now() / 1000 - e.since) : "-";
    if (q(".sl")) q(".sl").textContent = STATE_FOR[e.status] || "In this state";
    if (e.type === "motor") {
      if (q(".rh")) {
        q(".rh").textContent = fmtRunHours(e.run_hours);
        q(".rh").classList.toggle("counting", e.status === "RUNNING");
      }
      if (q(".starts")) q(".starts").textContent = e.starts ?? 0;
      const bar = q(".eqc-bar i");
      if (bar) bar.style.width = `${Math.max(2, ((e.run_hours || 0) / maxH) * 100)}%`;
    } else if (q(".pos")) q(".pos").textContent = EQ_TXT[e.status] || "-";
  }
  function renderEqInto(box, list, { view = "cards", group = false } = {}) {
    const maxH = Math.max(0.01, ...live.equipment.filter((m) => m.type === "motor").map((m) => m.run_hours || 0));
    const sig = `${view}|${group}|${list.map((e) => e.id).join(",")}`;
    if (box._sig !== sig) {
      box._sig = sig;
      if (!list.length) box.innerHTML = '<div class="empty">No equipment matches</div>';
      else if (view === "list") {
        box.innerHTML = `<div class="eql eql-h"><span></span><span>Tag</span><span>Equipment</span><span>Area</span><span>Status</span><span>In state</span><span>Run hours</span><span>Starts</span></div>` +
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
    list.forEach((e) => { const el = box.querySelector(`[data-id="${CSS.escape(e.id)}"]`); if (el) fillEq(el, e, maxH); });
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
    try {
      const r = await api(`/api/trend?tags=${encodeURIComponent(tags.map((t) => t.id).join(","))}&minutes=${$("ovRange").value}&points=160`);
      ovLast = { r, tags };
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
    const info = r.series.map((s, i) => {
      const pts = s.points.filter((p) => p.avg != null);
      const t = tagById(s.id) || {};
      return { s, i, color: SERIES[i], now: t.value ?? (pts.at(-1) || {}).avg, first: (pts[0] || {}).avg, sp: t.setpoint_value, hidden: ovHidden.has(s.id) };
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
    // fill the whole trend box: shrink to the minimum first so the box height is set by the row, then measure
    const box = $("ovChart");
    box.style.height = "";
    const svg = box.querySelector("svg");
    if (svg) svg.style.height = "230px";
    const h = Math.max(230, Math.floor(box.clientHeight) - 4);
    MDChart.renderMulti(box, { unit, decimals: d0, from: r.from, to: r.to, height: h, animate, area: true, limits, ...sharedAxis(tags),
      series: info.map((x) => ({ name: x.s.name, color: x.color, points: x.s.points, hidden: x.hidden })) });
    const shown = info.filter((x) => !x.hidden && x.now != null);
    const hiX = shown.reduce((a, x) => (!a || x.now > a.now ? x : a), null), loX = shown.reduce((a, x) => (!a || x.now < a.now ? x : a), null);
    const short = (n) => esc(n.split(" ")[0]);
    $("ovFoot").innerHTML = (hiX ? `<span><em>Highest now</em> <i style="background:${hiX.color}"></i>${short(hiX.s.name)} <b class="num">${fmt(hiX.now)} ${esc(unit)}</b></span>` : "") +
      (loX && loX !== hiX ? `<span><em>Lowest now</em> <i style="background:${loX.color}"></i>${short(loX.s.name)} <b class="num">${fmt(loX.now)} ${esc(unit)}</b></span>` : "") +
      (sps.length > 1 ? `<span><em>Alarm set points</em> ${sps.map(fmt).join(" / ")} ${esc(unit)}</span>` : "") +
      (sim ? '<span class="q SIMULATED">DEMO DATA</span>' : "");
  }
  $("ovRangeSeg").querySelectorAll("button").forEach((b) => (b.onclick = () => {
    $("ovRangeSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    $("ovRange").value = b.dataset.m;
    loadOvTrend(true);
  }));

  let eqStatusF = "all";
  let eqView = (() => { try { return localStorage.getItem("md-eq-view") || "cards"; } catch (_) { return "cards"; } })();
  const EQ_FILTERS = [
    ["all", "All equipment", () => true, ""],
    ["run", "Running", (e) => eqState(e) === "run" || eqState(e) === "start", "g"],
    ["stop", "Stopped / ready", (e) => e.type === "motor" && eqState(e) === "stop", "n"],
    ["trip", "Tripped", (e) => eqState(e) === "trip" || eqState(e) === "warn", "r"],
    ["valve", "Valves open", (e) => e.type === "valve", "b"],
  ];
  function renderEqKpis(eq) {
    const box = $("eqKpis");
    const motors = eq.filter((e) => e.type === "motor");
    const avail = motors.length ? Math.round((motors.filter((e) => eqState(e) !== "trip").length / motors.length) * 100) : 0;
    if (!box.children.length) {
      box.innerHTML = EQ_FILTERS.map(([k, label, , c]) => `<button class="eq-kpi k-${c || "a"}" data-f="${k}"><span class="l">${label}</span>
        <b class="num"><span class="v">0</span><small class="of"></small></b></button>`).join("") +
        `<div class="eq-kpi k-av"><span class="l">Availability</span><b class="num"><span class="v">0</span><small>%</small></b><span class="av-bar"><i></i></span></div>`;
      box.querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => { eqStatusF = eqStatusF === b.dataset.f ? "all" : b.dataset.f; renderEquipment(); }));
    }
    EQ_FILTERS.forEach(([k, , fn]) => {
      const b = box.querySelector(`[data-f="${k}"]`);
      b.classList.toggle("active", eqStatusF === k);
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
    renderEqKpis(eq);
    const areas = ["All", ...new Set(eq.map((e) => e.area))];
    const tabs = areas.map((a) => `<button class="${a === eqArea ? "active" : ""}" data-area="${esc(a)}">${esc(a)}<span class="muted">${a === "All" ? eq.length : eq.filter((e) => e.area === a).length}</span></button>`).join("");
    if ($("eqTabs")._h !== tabs) {
      $("eqTabs")._h = tabs;
      $("eqTabs").innerHTML = tabs;
      $("eqTabs").querySelectorAll("button").forEach((b) => (b.onclick = () => { eqArea = b.dataset.area; renderEquipment(); }));
    }
    const q = $("eqSearch").value.toLowerCase().trim();
    const f = (EQ_FILTERS.find((x) => x[0] === eqStatusF) || EQ_FILTERS[0])[2];
    const list = eq.filter((e) => (eqArea === "All" || e.area === eqArea) && f(e) &&
      (!q || e.name.toLowerCase().includes(q) || String(e.tag_no || "").toLowerCase().includes(q)));
    renderEqInto($("eqGrid"), list, { view: eqView, group: eqArea === "All" });
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
  let histRows = [];
  function renderActive(box) {
    const rows = live.alarms.slice().sort((a, b) => (a.acked_at ? 1 : 0) - (b.acked_at ? 1 : 0) || b.raised_at - a.raised_at);
    $("alarmCount2").textContent = rows.length ? `${rows.length}` : "";
    box.innerHTML = rows.length ? rows.map((a) => `<div class="al-row p-${esc(a.priority)} ${a.acked_at ? "acked" : "unacked"}">
        <div class="al-main"><div class="al-msg">${esc(a.message)}</div>
          <div class="al-meta"><span class="al-pr">${PRIO_TXT[a.priority] || a.priority}</span> Raised ${fmtTime(a.raised_at, true)} · active for ${dur(Date.now() / 1000 - a.raised_at)}
          ${a.simulated ? ' · <span class="q SIMULATED">DEMO</span>' : ""}</div>
          ${realNote(a) ? `<div class="al-note">“${esc(realNote(a))}”</div>` : ""}</div>
        <div class="al-ack">${a.acked_at
          ? `<span class="al-badge ok">✓ Acknowledged</span><span class="muted small">${a.acked_by ? esc(a.acked_by) + " · " : ""}${fmtTime(a.acked_at)}</span>`
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
      renderAlarmPopup();
      loadHistory();
    } catch (e) { toast(e.message, true); btn.disabled = false; }
  }
  function renderHistory() {
    const rows = histRows;
    $("histTable").innerHTML = `<thead><tr><th>Priority</th><th>Alarm</th><th>Raised</th><th>Cleared</th><th>Acknowledged</th><th>Note</th></tr></thead><tbody>` +
      (rows.length ? rows.map((a) => `<tr class="${a.cleared_at ? "" : "is-active"}"><td><span class="al-pill p-${esc(a.priority)}">${PRIO_TXT[a.priority] || a.priority}</span>${a.simulated ? ' <span class="q SIMULATED">DEMO</span>' : ""}</td>
        <td class="al-m">${esc(a.message)}</td><td class="num">${fmtTime(a.raised_at, true)}</td>
        <td class="num">${a.cleared_at ? fmtTime(a.cleared_at, true) : '<span class="al-pill act">ACTIVE</span>'}</td>
        <td>${a.acked_at ? `<span class="al-ackd">✓ ${esc(a.acked_by || "Yes")}</span><div class="muted small">${fmtTime(a.acked_at)}</div>` : '<span class="muted">-</span>'}</td>
        <td class="al-n">${realNote(a) ? esc(realNote(a)) : '<span class="muted">-</span>'}</td></tr>`).join("")
        : `<tr><td colspan="6" class="empty">No alarms in this period</td></tr>`) + "</tbody>";
  }
  async function loadHistory() {
    try {
      const r = await api(`/api/alarms?state=history&hours=${$("histRange").value}&limit=500`);
      histRows = r.alarms;
      renderHistory();
    } catch (e) { toast(e.message, true); }
  }
  $("histRange").onchange = loadHistory;
  $("histRangeSeg").querySelectorAll("button").forEach((b) => (b.onclick = () => {
    $("histRangeSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    $("histRange").value = b.dataset.h;
    loadHistory();
  }));

  // ---------- trends ----------
  function loadSel() { try { return JSON.parse(localStorage.getItem("md-trend") || "null") || []; } catch (_) { return []; } }
  function saveSel() { try { localStorage.setItem("md-trend", JSON.stringify(trendSel)); } catch (_) {} }

  // six clearly different colours; a value keeps its colour while it stays selected
  const TREND_COLORS = ["#4d7a00", "#e07a00", "#1a8fb0", "#c2185b", "#6a4fc9", "#8a6d00"];
  const GROUP_ORDER = ["Temperature", "Pressure", "Level", "Analysis"];
  let trendView = (() => { try { return localStorage.getItem("md-trend-view") || "grid"; } catch (_) { return "grid"; } })();
  let lastTrend = null;
  const colorOf = (id) => TREND_COLORS[Math.max(0, trendSel.indexOf(id)) % TREND_COLORS.length];
  const fmtN = (v, d) => (v == null || isNaN(v) ? "-" : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));

  function trendPicker(cands) {
    const groups = [...new Set(cands.map((t) => t.group || "Other"))]
      .sort((a, b) => (GROUP_ORDER.indexOf(a) + 1 || 99) - (GROUP_ORDER.indexOf(b) + 1 || 99));
    $("tagPicker").innerHTML = groups.map((g) => `<div class="tp-group g-${esc(g.toLowerCase())}"><span class="tp-h">${esc(g)}</span>
      ${cands.filter((t) => (t.group || "Other") === g).map((t) => {
        const on = trendSel.includes(t.id);
        return `<button class="tp-chip ${on ? "on" : ""}" data-id="${esc(t.id)}" style="--c:${on ? colorOf(t.id) : "transparent"}" aria-pressed="${on}">
          <i></i>${esc(t.name)}</button>`;
      }).join("")}</div>`).join("");
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
    $("trCount").innerHTML = `${trendSel.length} of 6 selected · ${esc($("trRangeSeg").querySelector(".active").textContent)}` +
      (trendSel.length ? ` · <button class="link-btn" id="tpClear">Clear all</button>` : "");
    const c = $("tpClear");
    if (c) c.onclick = () => { trendSel = []; saveSel(); renderTrends(true, true); };
  }

  function trendStats(s) {
    const pts = s.points.filter((p) => p.avg != null);
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
    if (!trendSel.length) { box.innerHTML = '<div class="card empty tr-empty">Pick one or more values above to see their trend</div>'; lastTrend = null; return; }
    try {
      const r = await api(`/api/trend?tags=${encodeURIComponent(trendSel.join(","))}&minutes=${$("trendRange").value}&points=240`);
      lastTrend = r;
      const sim = r.series.some((s) => s.points.some((p) => p.sim));
      if (trendView === "combined") {
        const units = [...new Set(r.series.map((s) => s.unit || ""))];
        box.innerHTML = units.map((u, ui) => {
          const ss = r.series.filter((s) => (s.unit || "") === u);
          return `<div class="card chart tr-card tr-combo ${animate ? "anim" : ""}" data-u="${ui}">
            <div class="tr-head"><div><span class="t">${esc(ss.map((s) => (tagById(s.id) || {}).group || "").filter((v, i, a) => v && a.indexOf(v) === i).join(" / ") || "Values")}</span>
              <div class="s">${esc(u || "no unit")} · ${ss.length} value${ss.length > 1 ? "s" : ""}${sim ? ' · <span class="q SIMULATED">DEMO DATA</span>' : ""}</div></div></div>
            <div class="tr-legend">${ss.map((s) => { const t = tagById(s.id) || {}; return `<span><i style="background:${colorOf(s.id)}"></i>${esc(s.name)} <b class="num">${fmtN(t.value, s.decimals ?? 1)}</b></span>`; }).join("")}</div>
            <div class="plot"></div></div>`;
        }).join("");
        units.forEach((u, ui) => {
          const ss = r.series.filter((s) => (s.unit || "") === u);
          MDChart.renderMulti(box.querySelector(`[data-u="${ui}"] .plot`), { unit: u, decimals: ss[0].decimals, from: r.from, to: r.to, height: 300,
            ...sharedAxis(ss.map((s) => tagById(s.id) || {})),
            area: true, animate, series: ss.map((s) => ({ name: s.name, color: colorOf(s.id), points: s.points })) });
        });
        return;
      }
      box.innerHTML = r.series.map((s) => {
        const t = tagById(s.id) || {};
        const st = trendStats(s);
        const d = s.decimals ?? 1;
        const isBool = s.data_type === "BOOL";
        const now = t.value ?? (st && st.last);
        const sp = t.setpoint_value;
        const high = !isBool && sp != null && now != null && now >= sp;
        let delta = "";
        if (st && !isBool) {
          const dv = st.last - st.first, pc = st.first ? (dv / Math.abs(st.first)) * 100 : 0;
          const dir = Math.abs(dv) < Math.pow(10, -d) ? "flat" : dv > 0 ? "up" : "down";
          delta = `<span class="tr-delta ${dir}" title="Change over the selected period">${dir === "up" ? "▲" : dir === "down" ? "▼" : "▬"} ${fmtN(Math.abs(dv), d)}${st.first ? ` (${Math.abs(pc).toFixed(1)}%)` : ""}</span>`;
        }
        return `<div class="card chart tr-card ${high ? "is-high" : ""} ${animate ? "anim" : ""}" data-id="${esc(s.id)}" style="--c:${colorOf(s.id)};animation-delay:${r.series.indexOf(s) * 70}ms">
          <div class="tr-head">
            <div class="tr-title"><span class="sw"></span><div><span class="t">${esc(s.name)}</span>
              <div class="s">${esc(t.group || "")}${s.unit ? " · " + esc(s.unit) : ""}${s.points.some((p) => p.sim) ? ' · <span class="q SIMULATED">DEMO DATA</span>' : ""}</div></div></div>
            <div class="tr-now"><b class="num">${isBool ? (now >= 0.5 ? esc((t.states || {}).true || "ON") : esc((t.states || {}).false || "OFF")) : fmtN(now, d)}</b>
              ${isBool ? "" : `<span class="u">${esc(s.unit || "")}</span>`}${delta}</div>
          </div>
          <div class="plot"></div>
          <div class="tr-stats">
            ${isBool ? `<div><span>On time</span><b class="num">${st ? Math.round(st.avg * 100) + " %" : "-"}</b></div>` : `
            <div><span>Min</span><b class="num">${st ? fmtN(st.min, d) : "-"}</b></div>
            <div><span>Average</span><b class="num">${st ? fmtN(st.avg, d) : "-"}</b></div>
            <div><span>Max</span><b class="num">${st ? fmtN(st.max, d) : "-"}</b></div>`}
            ${sp != null ? `<div><span>Alarm set point</span><b class="num sp">${fmtN(sp, d)}</b></div>` : ""}
            <div class="tr-state"><span class="pill ${high ? "crit" : "good"}"><span class="dot"></span>${high ? "ABOVE SET POINT" : "NORMAL"}</span></div>
          </div></div>`;
      }).join("");
      r.series.forEach((s) => {
        const t = tagById(s.id) || {};
        const limits = [];
        if (t.setpoint_value != null) limits.push({ v: t.setpoint_value, label: `Alarm SP ${t.setpoint_value.toFixed(s.decimals ?? 1)}` });
        ["hihi", "hi", "lo", "lolo"].forEach((k) => { if (t.alarm && t.alarm[k] != null && t.alarm[k] !== "") limits.push({ v: +t.alarm[k], label: k.toUpperCase() }); });
        MDChart.render(box.querySelector(`[data-id="${CSS.escape(s.id)}"] .plot`), {
          name: s.name, unit: s.unit, decimals: s.decimals, color: colorOf(s.id), points: s.points, height: 230,
          from: r.from, to: r.to, isBool: s.data_type === "BOOL", limits, animate, yMin: t.trend_min, yMax: t.trend_max,
        });
      });
    } catch (e) { toast(e.message, true); }
  }
  $("trRangeSeg").querySelectorAll("button").forEach((b) => (b.onclick = () => {
    $("trRangeSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    $("trendRange").value = b.dataset.m;
    trCountTxt();
    renderTrends(false, true);
  }));
  $("trViewSeg").querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.v === trendView);
    b.onclick = () => {
      trendView = b.dataset.v;
      try { localStorage.setItem("md-trend-view", trendView); } catch (_) {}
      $("trViewSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      renderTrends(false, true);
    };
  });
  $("trCsv").onclick = () => {
    if (!lastTrend || !lastTrend.series.length) { toast("Select values first"); return; }
    const ser = lastTrend.series;
    const times = [...new Set(ser.flatMap((s) => s.points.filter((p) => p.avg != null).map((p) => p.t)))].sort((a, b) => a - b);
    const maps = ser.map((s) => new Map(s.points.map((p) => [p.t, p.avg])));
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const p2 = (n) => String(n).padStart(2, "0");
    const ts = (t) => { const d = new Date(t * 1000); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
    const lines = [["Time", ...ser.map((s) => `${s.name}${s.unit ? " (" + s.unit + ")" : ""}`)].map(q).join(",")];
    times.forEach((t) => lines.push([ts(t), ...maps.map((m, i) => (m.has(t) && m.get(t) != null ? Number(m.get(t)).toFixed(ser[i].decimals ?? 2) : ""))].join(",")));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv" }));
    a.download = `trend_${ts(Date.now() / 1000).replace(/[: ]/g, "-").slice(0, 16)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
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

  loadMeta().catch(() => {});
  route();
  poll();
})();
