/* Client dashboard - plant pages: key points (overview band), live process mimic and instruments (scaling).
   Driven by dashboard.js, which calls Plant.render(live, view) after every /api/live poll.
   The HMI mimic sheets were used as a reference for the process layout only; the drawing is our own. */
(() => {
  const { esc, fmtValue, fmtTime, dur } = MD;
  const $ = (id) => document.getElementById(id);
  let live = null;
  let sheet = "overall";
  try { sheet = localStorage.getItem("md-mimic2") || "overall"; } catch (_) {}

  // ---------- P&ID numbers (client logic document) for our equipment ids ----------
  const PID = {
    OP_P1A: "01-P-101", OP_P1B: "01-P-102", OP_P5A: "01-P-103", OP_P5B: "01-P-104", AGIT: "OP-A1", PCP: "OP-P201",
    MV_01: "01-MV-101", OP_P6A: "03-P-301", OP_P6B: "03-P-302", OP_P14: "03-P-303", OP_P15: "03-P-304", OP_P4: "05-P-501",
    OP_P7: "06-P-601", OP_P3: "06-P-602", OP_P11: "06-P-603", OP_P10: "06-P-604", OP_P2: "06-P-605", OP_F1: "06-F-601",
    OP_F2: "06-F-602", OP_M1: "OP-M1", OP_P9: "07-P-701", OP_P12: "07-P-702", OP_P13: "07-P-703", OP_P8: "07-P-704",
    OP_SV1: "07-XV-701", OP_SV2: "07-XV-702",
  };
  // short descriptive pump names shown under the tag on the mimic (full name in the tooltip / pop-over)
  const PUMP_NAME = {
    OP_P1A: "Sludge main", OP_P1B: "Sludge standby", OP_P5A: "Filtrate main", OP_P5B: "Filtrate standby",
    // raw water inlet pumps 03-P-301 / 302: P&ID "Ground water pump" + "Standby pump" (not "borewell")
    OP_P6A: "Ground water pump", OP_P6B: "Standby pump", OP_P14: "Supply main", OP_P15: "Supply standby",
    OP_P7: "De-gasifier PHE", OP_P3: "Dryer condenser", OP_P11: "Boiler cooling", OP_P10: "Turbine oil cooling",
    OP_P2: "Hot water to dryer", OP_P4: "Condensate", OP_P9: "Recirculation", OP_P12: "Acid dosing",
    OP_P13: "Alkali dosing", OP_P8: "Gravity tank → WTP", PCP: "Progressive cavity",
  };
  const TAG_PID = { LT_01: "01-LT-101", LT_02: "01-LT-102", PT_01: "03-PT-301", T_04: "07-TT-701", T_02: "06-TT-601",
    PT_03: "06-PT-601", PT_02: "06-PT-602", PT_04: "06-PT-603", PH_01: "pH" };
  const SW = {
    LS301_LL: "DI_Magnetic_Float_Sensor_Raw_Water_Tank_LL", LS301_HL: "DI_Magnetic_Float_Sensor_Raw_Water_Tank_HL",
    LS601_LL: "DI_Float_Sensor_Cooling_Tower_1_LL", LS601_HL: "DI_Float_Sensor_Cooling_Tower_1_HL",
    LS602_LL: "DI_Float_Sensor_Cooling_Tower_2_LL", LS602_HL: "DI_Float_Sensor_Cooling_Tower_2_HL",
    LS603_LL: "DI_Magnetic_Float_Sensor_Hot_Water_Tank_LL", LS603_HL: "DI_Magnetic_Float_Sensor_Hot_Water_Tank_HL",
    LS701_HH: "DI_Magnetic_Float_Sensor_De_Gasifier_HH", LS701_H: "DI_Magnetic_Float_Sensor_De_Gasifier_H",
    LS701_L: "DI_Magnetic_Float_Sensor_De_Gasifier_L", LS701_LL: "DI_Magnetic_Float_Sensor_De_Gasifier_LL",
    LS702_LL: "DI_Magnetic_Float_Sensor_Gravity_Tank_LL", LS702_HL: "DI_Magnetic_Float_Sensor_Gravity_Tank_HL",
    LS801: "DI_Float_Sensor_Raw_Water_Tank_1_HL", LS802: "DI_Float_Sensor_Raw_Water_Tank_1_LL",
    LS803: "DI_Float_Sensor_Pure_Water_Tank_2_HL", LS804: "DI_Float_Sensor_Pure_Water_Tank_2_LL",
    AIR: "DI_Pressure_Switch_for_Pneumatic_Air_Line", FLOW: "DI_Flow_Switch_for_Ground_Water_Pump_to_Raw_Water_Storage_T",
    MODE: "DI_Stm_Am_Ss",
  };

  // ---------- data helpers ----------
  const eq = (id) => live.equipment.find((e) => e.id === id);
  const tag = (id) => live.tags.find((t) => t.id === id);
  const isOn = (v) => v === true || v === 1 || v === "1" || (typeof v === "number" && v >= 0.5);
  function sw(id) {                                   // true / false / null (no data)
    const a = (live.aux || {})[id];
    return !a || a.quality === "NODATA" || a.value == null ? null : isOn(a.value);
  }
  function auxNum(id) {
    const a = (live.aux || {})[id];
    return a && typeof a.value === "number" && a.quality !== "NODATA" ? a.value : null;
  }
  const num = (t) => (t && typeof t.value === "number" && !["NODATA"].includes(t.quality) ? t.value : null);
  const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
  function pct(t, v = num(t)) {
    if (v == null || t.eng_min == null || t.eng_max == null || t.eng_max === t.eng_min) return null;
    return clamp(((v - t.eng_min) / (t.eng_max - t.eng_min)) * 100);
  }
  const STATE = { RUNNING: "run", STARTING: "run", OPEN: "run", TRAVEL: "warn", STOPPED: "stop", CLOSED: "stop",
    TRIP: "trip", FAULT: "trip", "NO FEEDBACK": "warn" };
  const STATE_TXT = { RUNNING: "Running", STARTING: "Starting", OPEN: "Open", TRAVEL: "Moving", STOPPED: "Stopped",
    CLOSED: "Closed", TRIP: "Tripped", FAULT: "Fault", "NO FEEDBACK": "No feedback" };
  const eqCls = (e) => (e ? STATE[e.status] || "unk" : "unk");
  const running = (id) => { const e = eq(id); return !!e && ["RUNNING", "STARTING", "OPEN"].includes(e.status); };
  const fmt = (t) => (t ? fmtValue(t) : "--");
  function modeTxt(e) {                                 // HMI soft selectors
    if (!e || e.auto == null) return "-";
    return (e.auto ? "Auto" : "Manual") + (e.pair && e.standby_selected != null ? (e.standby_selected ? " · Standby selected" : " · Main selected") : "");
  }
  function auxTxt(id) {                                 // formatted value of an aux (hidden) tag
    const a = (live.aux || {})[id];
    if (!a || a.value == null || a.quality === "NODATA") return "--";
    if (typeof a.value === "boolean") return a.value ? "ON" : "OFF";
    return `${Number(a.value).toFixed(a.decimals ?? 1)} ${a.unit || ""}`.trim();
  }
  // Level set points are entered on the HMI in % of the transmitter range (client philosophy: "% settable").
  // The unit comes from the tag ("%"); for comparing with the level they are converted to the tank's unit (mm).
  const spIsPct = (id) => ((live.aux || {})[id] || {}).unit === "%";
  function spToLevel(t, id, v = auxNum(id)) {
    if (v == null || !t || !spIsPct(id)) return v;
    const lo = t.eng_min ?? 0, hi = t.eng_max ?? 100;
    return lo + (v / 100) * (hi - lo);
  }
  function spTxt(t, id) {                               // "66.7 % (2400 mm)"
    const v = auxNum(id);
    if (v == null) return "--";
    if (!spIsPct(id) || !t) return auxTxt(id);
    return `${Number(v).toFixed(1)} % (${Math.round(spToLevel(t, id, v))} ${t.unit || "mm"})`;
  }
  // HH / H / L / LL level set points of a level transmitter (set on the dashboard; default % of range)
  const LV_KEYS = [["hh", "HH"], ["h", "H"], ["l", "L"], ["ll", "LL"]];
  // HH / H / L / LL: the values set on the HMI "LT Set Point" screen (read from the PLC); fallback = dashboard / default
  function plcLevels(t) {
    if (!t || !live) return null;
    const v = Object.fromEntries(LV_KEYS.map(([k]) => [k, spToLevel(t, `${t.id}_${k.toUpperCase()}_SP`)]));
    return LV_KEYS.every(([k]) => v[k] != null) ? v : null;
  }
  function levelsOf(t) {
    if (!t) return null;
    const plc = plcLevels(t);
    if (plc) return plc;
    if (t.levels) return t.levels;
    const lo = t.eng_min ?? 0, span = (t.eng_max ?? 100) - lo;
    return { hh: lo + span * 0.9, h: lo + span * 0.75, l: lo + span * 0.25, ll: lo + span * 0.1 };
  }
  function lvActive(t, key) {                         // HH/H lit at or above, L/LL lit at or below the set point
    const v = num(t), lv = levelsOf(t);
    if (v == null || !lv) return null;
    return key === "hh" || key === "h" ? v >= lv[key] : v <= lv[key];
  }
  function hhmm(h) {                                   // run hour meter, format HHHHHH:MM
    if (h == null) return "--";
    const m = Math.floor(h * 60);
    return `${String(Math.floor(m / 60)).padStart(6, "0")}:${String(m % 60).padStart(2, "0")}`;
  }

  // ======================================================================================
  // KEY POINTS (top of the overview): the things the client's control philosophy is built on
  // ======================================================================================
  function chip(id, label) {
    const e = eq(id);
    const c = eqCls(e);
    return `<span class="kp-eq ${c}" title="${esc(e ? `${e.name} - ${STATE_TXT[e.status] || e.status}` : "No data")}"><i></i>${esc(label || PID[id] || id)}</span>`;
  }
  function band(t, lo, hi, opts = {}) {                 // horizontal scale with a highlighted control band
    const p = pct(t), a = pct(t, lo), b = pct(t, hi);
    return `<div class="kp-band${opts.cls ? " " + opts.cls : ""}">
      <span class="kb-zone" style="left:${a ?? 0}%;width:${(b ?? 0) - (a ?? 0)}%"></span>
      ${p != null ? `<span class="kb-mark" style="left:${p}%"></span>` : ""}
      <span class="kb-l">${esc(String(t.eng_min ?? ""))}</span><span class="kb-r">${esc(String(t.eng_max ?? ""))}</span></div>
      <div class="kb-cap"><span>${esc(opts.caption || "")}</span></div>`;
  }
  // level as a slim horizontal bar (overview list rows)
  function tankMini(t) {
    const p = pct(t);
    return `<div class="kr-level ${t.id === "LT_01" ? "sludge" : "water"}"><span class="kr-bar"><i style="width:${Math.max(0, Math.min(100, p ?? 0))}%"></i></span>
      <b class="num">${p == null ? "--" : Math.round(p) + "%"}</b></div>`;
  }
  // which rows have their "Details" open - kept across the 1 s refreshes (the rows are rebuilt each time)
  const kpOpen = new Set();
  // one key value = one full-width row: status dot + name | big value | bar / status lines | Details (opens under the row)
  function kpCard(id, cls, title, sub, valueHTML, body, chips, state) {
    const i = body.indexOf('<div class="kr-full');
    const main = i < 0 ? body : body.slice(0, i), det = i < 0 ? "" : body.slice(i);
    const st = /km-f bad/.test(det) ? "bad" : state === "warn" || /km-f warn/.test(det) ? "warn" : "ok";
    return `<div class="kp-row kr-${cls} st-${st}" ${id ? `data-open="${esc(id)}" tabindex="0" role="button"` : ""}>
      <div class="kr-top"><div class="kr-name"><span class="kr-dot"></span><div><span class="kp-t">${esc(title)}</span><span class="kp-s">${esc(sub)}</span></div></div>
        <div class="kr-val kp-v">${valueHTML}</div></div>
      ${main.trim() ? `<div class="kr-body">${main}</div>` : ""}${det}${chips ? `<div class="kp-eqs">${chips}</div>` : ""}</div>`;
  }
  const valHTML = (t) => `<b class="num">${esc(fmt(t))}</b><small>${esc(t ? t.unit : "")}</small>`;
  const swTxt = (v, on, off) => (v == null ? "No data" : v ? on : off);

  // ---------- detail rows inside the key-point cards (everything the control philosophy uses) ----------
  // cls: ok / bad / warn / stop / unk = coloured status badge; info = plain value (set points, logic text)
  // the P&ID tag at the end of a label ("Sludge pumps 01-P-101/102") goes on its own small grey line
  function row(label, val, cls = "info") {
    const m = label.match(/^(.*?)\s+((?:\d{2}|OP)-[A-Z]{1,3}-?[\w/]*.*)$/);
    const lab = m ? `${esc(m[1])}<small>${esc(m[2])}</small>` : esc(label);
    const v = cls === "info" ? val : val.includes('class="pl"') ? val : `<span class="pl">${val}</span>`;
    return `<div class="kd-r ${cls}"><span>${lab}</span><b>${v}</b></div>`;
  }
  // card details in titled groups: [["Equipment", rows], ["Set points & logic", rows], ["Alarms & safety", rows]]
  // shown folded ("Details") so the card shows only its headline; a red mark on the fold if something inside is wrong
  const secs = (groups) => {
    const inner = groups.filter(([, r]) => r.filter(Boolean).length)
      .map(([h, r]) => `<div class="kd-sec"><div class="kd-h">${esc(h)}</div>${r.filter(Boolean).join("")}</div>`).join("");
    const bad = (inner.match(/kd-r bad/g) || []).length, warn = (inner.match(/kd-r warn/g) || []).length;
    const flag = bad ? `<span class="km-f bad">${bad} need attention</span>` : warn ? `<span class="km-f warn">${warn} to check</span>` : '<span class="km-f ok">all normal</span>';
    // full details always shown (no fold): equipment, set points & logic, alarms & safety
    return `<div class="kr-full" data-st="${bad ? "bad" : warn ? "warn" : "ok"}">${flag}<div class="kp-dl">${inner}</div></div>`;
  };
  const note = (txt, cls = "") => (txt ? `<div class="kp-next ${cls}" title="${esc(txt)}"><b>${cls === "bad" || cls === "warn" ? "⚠" : "▶"}</b>${esc(txt)}</div>` : "");
  const tripped = (id) => { const e = eq(id); return !!e && ["TRIP", "FAULT"].includes(e.status); };
  const spNum = (id, d = 0) => { const v = auxNum(id); return v == null ? "--" : Number(v).toFixed(d); };
  const modeEm = (e) => (e && e.auto != null ? `<em>${e.auto ? "Auto" : "Manual"}</em>` : "");
  function eqRow(label, id) {                           // one motor / valve: state badge + Auto/Manual
    const e = eq(id);
    if (!e) return row(label, "No data", "unk");
    const c = eqCls(e);
    return row(label, `<span class="pl">${esc(STATE_TXT[e.status] || e.status)}</span>${modeEm(e)}`,
      c === "run" ? "ok" : c === "trip" ? "bad" : c === "warn" ? "warn" : c === "unk" ? "unk" : "stop");
  }
  function pairRow(label, a, b) {                       // main / standby pair: running one (badge), selected one, mode
    const ea = eq(a), eb = eq(b);
    if (!ea && !eb) return row(label, "No data", "unk");
    const e = ea || eb;
    const run = running(a) ? PID[a] : running(b) ? PID[b] : "";
    const trips = [a, b].filter(tripped).map((x) => PID[x]);
    const badge = trips.length ? `${trips.join(", ")} TRIPPED` : run ? `${run} running` : "Both stopped";
    const sel = e.standby_selected == null ? "" : e.standby_selected ? "Standby selected" : "Main selected";
    return row(label, `<span class="pl">${esc(badge)}</span><em>${esc([sel, e.auto == null ? "" : e.auto ? "Auto" : "Manual"].filter(Boolean).join(" · "))}</em>`,
      trips.length ? "bad" : run ? "ok" : "stop");
  }
  function swRow(label, id, onTxt, offTxt, badWhen) {   // a digital input; badWhen = the state that is a problem
    const v = sw(id);
    return row(label, esc(swTxt(v, onTxt, offTxt)), v == null ? "unk" : badWhen != null && v === badWhen ? "bad" : "ok");
  }
  function almRow(label, id) {                          // PLC alarm bit for an analog input
    const v = sw(id);
    return row(label, v == null ? "No data" : v ? "ALARM" : "Normal", v == null ? "unk" : v ? "bad" : "ok");
  }
  // float switch: ON = liquid has reached the switch
  const floatRow = (label, id) => swRow(label, id, "Water at switch", "Below switch");
  function floatTank(hl, ll) {                          // text level from an HL + LL switch pair
    const h = sw(hl), l = sw(ll);
    if (h == null || l == null) return ["No data", "unk"];
    if (h) return ["HIGH (HL switch on)", "warn"];
    if (!l) return ["LOW (below LL switch)", "bad"];
    return ["Normal (between LL and HL)", "ok"];
  }

  // ======================================================================================
  // DASHBOARD PROCESS CARDS (v3, brief SC02 - replaces the text rows and the separate Tank levels page)
  // One card per process area: pictorial tank / gauge / switch tanks, the ACTUAL values first, a short set point
  // summary with a pencil that opens the matching section of Set points (editing stays there), equipment as symbols
  // with state colour + icon + text, "Show more" for the secondary details and the trend. Cards can be dragged
  // (or moved with the arrow buttons) into the user's own order, saved per user on the server.
  // Built once, then patched every second, so open cards, trends, drag state and keyboard focus survive the refresh.
  // Only the sludge (LT-01) and filtrate (LT-02) tanks have level transmitters; switch-only tanks show their switches.
  // ======================================================================================
  const EQ_LABEL = { MV_01: "Feed valve", AGIT: "Mixer", OP_SV1: "LP steam valve", OP_SV2: "Outlet valve", OP_M1: "Hot air blower",
    OP_F1: "CT-1 fan", OP_F2: "CT-2 fan" };
  const ST_IC = { ok: "✓", on: "✓", off: "■", warn: "⚠", alarm: "!", unk: "?", info: "▶" };   // alarm "!" is drawn as a red alert badge (css)
  const ST_TXT = { ok: "Normal", warn: "Check", alarm: "Alert", unk: "No data" };
  const SYM = {        // one simple symbol per equipment type (P&ID style)
    // centrifugal pump: base + volute casing with the outlet nozzle on top, impeller inside (turns while running)
    pump: '<path class="b" d="M11 31 H29 L32 37 H8 Z"/><path class="b" d="M20 8 H34 V14.5 H29.9 A12 12 0 1 1 20 8 Z"/>'
      + '<g class="r"><circle cx="20" cy="20" r="2.6"/>'
      + [0, 90, 180, 270].map((a) => `<path transform="rotate(${a} 20 20)" d="M20 18.2 C21.5 14 24.5 11.6 28.4 12.2 C26 14 23.4 16.6 21.6 19.6 Z"/>`).join("") + "</g>",
    valve: '<path class="b" d="M6 11 L34 29 V11 L6 29 Z"/>',
    // top-entry mixer: tank, motor + gearbox on top, shaft with a two-blade propeller (turns while running)
    mixer: '<rect class="b" x="6" y="14" width="28" height="22" rx="3"/><rect class="m" x="14.5" y="2.5" width="11" height="8" rx="1.5"/><rect class="m" x="18" y="10.5" width="4" height="3.5"/>'
      + '<g class="r"><rect x="19.1" y="14" width="1.8" height="14.5"/><path d="M20 28.5 C16.5 25.6 11.5 26 10 28.6 C11.5 31.2 16.5 31.4 20 28.5 Z M20 28.5 C23.5 25.6 28.5 26 30 28.6 C28.5 31.2 23.5 31.4 20 28.5 Z"/></g>',
    fan: '<circle class="b" cx="20" cy="20" r="14"/><g class="r"><path d="M20 20 C16 14 18 8 20 7 C22 8 24 14 20 20 Z"/><path d="M20 20 C27 18 31 23 31 25 C29 27 23 25 20 20 Z"/><path d="M20 20 C17 26 11 27 10 25 C10 23 14 18 20 20 Z"/></g>',
  };
  const GRIP = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';
  const ARW = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="${d}"/></svg>`;
  const UP = ARW("M6 15l6-6 6 6"), DOWN = ARW("M6 9l6 6 6-6"), CHEV = ARW("M6 9l6 6 6-6");
  const FS_IC = ARW("M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5");
  const RANK = ["alarm", "unk", "warn", "ok"];
  const worst = (list) => RANK.find((r) => list.includes(r)) || "ok";
  function eqKind(id, e) {
    if ((e && e.type === "valve") || /^(MV_|OP_SV)/.test(id)) return "valve";
    if (id === "AGIT") return "mixer";
    if (/^OP_(F\d|M1)$/.test(id)) return "fan";
    return "pump";
  }
  function eqSt(e) {                                    // on / off / alarm / warn / unk
    if (!e) return "unk";
    const c = eqCls(e);
    return c === "run" ? "on" : c === "stop" ? "off" : c === "trip" ? "alarm" : c === "warn" ? "warn" : "unk";
  }
  const eqStates = (ids) => ids.map((id) => { const s = eqSt(eq(id)); return s === "alarm" ? "alarm" : s === "warn" ? "warn" : "ok"; });
  function eqItem(id) {                                 // symbol + tag + short name + state (icon + text) + Auto / Manual (read-only)
    const e = eq(id), s = eqSt(e), kind = eqKind(id, e);
    const txt = e ? STATE_TXT[e.status] || e.status : "No data";
    const name = EQ_LABEL[id] || PUMP_NAME[id] || (e ? e.name : id);
    return `<div class="dc-eq st-${s}" title="${esc(`${PID[id] || id} ${e ? e.name : ""} - ${txt}`)}">
      <svg class="dc-sym k-${kind}" viewBox="0 0 40 40" role="img" aria-label="${esc(`${PID[id] || id} ${name}, ${txt}`)}">${SYM[kind]}</svg>
      <span class="dc-eq-t"><b>${esc(PID[id] || id)}</b><span>${esc(name)}</span></span>
      <span class="dc-eq-s"><span class="dc-st st-${s}"><i aria-hidden="true">${ST_IC[s]}</i>${esc(txt)}</span>${e && e.auto != null ? `<em>${e.auto ? "Auto" : "Manual"}</em>` : ""}</span></div>`;
  }
  const chipHTML = (s, txt) => `<span class="dc-st big st-${s}"><i aria-hidden="true">${ST_IC[s]}</i>${esc(txt || ST_TXT[s])}</span>`;
  // card header chip: when something needs a look it is a button - hover lists the problems, click jumps to them
  const PROB_SEL = ".dc-st.st-alarm, .dc-st.st-warn, .dc-st.st-unk, .dc-note.st-alarm, .dc-note.st-warn";
  function dcProblems(card) {                         // [element, text] for each problem shown inside the card body / details
    const seen = new Set(), out = [];
    card.querySelectorAll(PROB_SEL).forEach((st) => {
      if (st.closest(".dc-chip")) return;
      const row = st.closest(".dc-eq, .dc-r, tr, .dc-sw, .dc-note, .dc-stl") || st;
      if (seen.has(row)) return;
      seen.add(row);
      let txt;
      if (row.matches(".dc-eq")) txt = row.title;
      else if (row.matches(".dc-r")) txt = `${row.querySelector(".dc-r-l").textContent}: ${st.textContent.replace(/^\W\s*/, "")}`;
      else if (row.matches("tr")) txt = `${row.cells[0].textContent} level: ${st.textContent.replace(/^\W\s*/, "")}`;
      else if (row.matches(".dc-sw")) txt = `${row.querySelector(".dc-sw-i > b").textContent}: ${st.textContent.replace(/^\W\s*/, "")}`;
      else if (row.matches(".dc-swst")) txt = `${row.querySelector(".dc-lbl").textContent.split(" · ")[0]}: ${st.textContent.replace(/^\W\s*/, "")}`;
      else txt = row.textContent.replace(/^\W\s*/, "");
      out.push([row, txt.replace(/\s+/g, " ").trim()]);
    });
    return out;
  }
  function chipBtnHTML(s, probs) {
    if (s === "ok" || !probs.length) return chipHTML(s);
    const tip = probs.map(([, t]) => `• ${t}`).join("\n");
    return `<button type="button" class="dc-chip-b" data-prob title="${esc(tip + "\n\nClick to show it")}" aria-label="${esc(`${ST_TXT[s]}: ${probs.map(([, t]) => t).join("; ")}. Show it`)}">${chipHTML(s, `${ST_TXT[s]}${probs.length > 1 ? ` (${probs.length})` : ""}`)}</button>`;
  }
  const stLine = (s, txt) => `<div class="dc-stl"><span class="dc-st st-${s}"><i aria-hidden="true">${ST_IC[s]}</i>${esc(txt)}</span></div>`;
  function dRow(label, val, st = "info") {             // one secondary detail: label | value (status icon when it is a state)
    return `<div class="dc-r"><span class="dc-r-l">${esc(label)}</span><span class="dc-r-v">${st === "info" ? esc(val)
      : `<span class="dc-st st-${st}"><i aria-hidden="true">${ST_IC[st]}</i>${esc(val)}</span>`}</span></div>`;
  }
  const dl = (rows) => `<div class="dc-dl">${rows.filter(Boolean).join("")}</div>`;
  const notes = (list) => list.filter(([t]) => t).map(([t, s]) => `<div class="dc-note st-${s}"><i aria-hidden="true">${ST_IC[s]}</i>${esc(t)}</div>`).join("");
  function alRow(label, id) {                           // plant alarm bit of an instrument
    const v = sw(id);
    return dRow(label, v == null ? "No data" : v ? "Alarm" : "Normal", v == null ? "unk" : v ? "alarm" : "ok");
  }
  function swRow2(label, id, onTxt, offTxt, badWhen) {  // a digital input; badWhen = the state that is a problem
    const v = sw(id);
    return dRow(label, v == null ? "No data" : v ? onTxt : offTxt, v == null ? "unk" : badWhen != null && v === badWhen ? "warn" : "ok");
  }
  function pairSel(id) {                                // main / standby selection of a pump pair (read-only)
    const e = eq(id);
    return !e || e.standby_selected == null ? "-" : e.standby_selected ? "Standby selected" : "Main selected";
  }
  const airRow = (label, lowTxt) => { const a = sw(SW.AIR); return dRow(label, a == null ? "No data" : a ? "OK" : lowTxt, a == null ? "unk" : a ? "ok" : "alarm"); };

  // ---- level transmitter tanks: graphic (flat Mimic-style tank, reused from the former Tank levels page) ----
  function lvFigHTML(c, t) {
    const marks = LV_KEYS.map(([k, l]) => `<g class="lvg-ln ${k}" data-k="${k}"><line x1="78" x2="182" y1="0" y2="0"/><text x="188" y="5">${l}</text><text class="v num" x="214" y="5">--</text></g>`).join("");
    const plcMarks = c.plc.map(([l, id]) => `<g class="lvg-plc" data-sp="${id}"><path d="M72 0 l-7 -5 v10 Z"/><text x="62" y="5" text-anchor="end">${esc(l)}</text></g>`).join("");
    return `<svg class="lvg" viewBox="-28 0 298 312" role="img" aria-label="${esc(c.name)} level graphic">${tankSVG(c)}${marks}${plcMarks}
      <text class="lvg-pct num" x="130" y="${GY0 + GH / 2}" text-anchor="middle" data-pct>--</text>
      <text class="lvg-end" x="76" y="${GY0 + GH + 1}" text-anchor="end">${esc(String(t.eng_min ?? 0))}</text>
      <text class="lvg-end" x="76" y="${GY0 + 9}" text-anchor="end">${esc(String(t.eng_max ?? ""))}</text></svg>`;
  }
  function lvFigUpdate(el, t, cfg) {                    // liquid, set point lines, inflow / outflow, mixer, filling / draining
    if (!el || !t || !el.querySelector("[data-liq]")) return;
    const lv = levelsOf(t), p = pct(t), [stc] = lvStatus(t);
    const yOf = (val) => GY0 + GH * (1 - (pct(t, val) ?? 0) / 100);
    const fh = GH * Math.max(0, Math.min(100, p ?? 0)) / 100, surfY = GY0 + GH - fh;
    el.querySelector("[data-liq]").style.transform = `translateY(${(p ? surfY : GY0 + GH + 16).toFixed(1)}px)`;
    const inflow = cfg.inlet ? running(cfg.inlet) : false, outflow = (cfg.outlet || []).some(running);
    const pour = el.querySelector("[data-pour]");
    pour.setAttribute("y2", surfY.toFixed(1)); pour.classList.toggle("on", inflow);
    el.querySelector("[data-out]").classList.toggle("on", outflow && !!p);
    const mix = el.querySelector("[data-mix]");
    if (mix) mix.classList.toggle("on", running(cfg.mixer));
    const now = Date.now(), hist = (el._lvHist = (el._lvHist || []).filter((h) => now - h[0] < 20000));
    if (p != null) hist.push([now, p]);
    const dp = hist.length > 1 ? hist[hist.length - 1][1] - hist[0][1] : 0;
    el._lvDir = dp > 0.3 ? "up" : dp < -0.3 ? "down" : (Math.abs(dp) < 0.05 ? "" : el._lvDir || "");
    const dir = el.querySelector("[data-dir]");
    dir.setAttribute("class", `lvg-dir ${el._lvDir}`);
    dir.querySelector("text").textContent = el._lvDir === "up" ? "▲ Filling" : el._lvDir === "down" ? "▼ Draining" : "";
    el.querySelector("[data-shell]").setAttribute("class", `lvg-tank flat ${stc === "hh" || stc === "ll" ? "alarm" : stc === "h" || stc === "l" ? "warn" : ""}`);
    el.querySelector("[data-pct]").textContent = p == null ? "--" : `${Math.round(p)} %`;
    LV_KEYS.forEach(([k]) => {
      const g = el.querySelector(`.lvg-ln[data-k="${k}"]`);
      g.setAttribute("transform", `translate(0 ${yOf(lv[k]).toFixed(1)})`);
      g.querySelector(".v").textContent = Number(lv[k]).toFixed(0);
      g.classList.toggle("on", !!lvActive(t, k));
    });
    el.querySelectorAll(".lvg-plc").forEach((g) => {
      const v = spToLevel(t, g.dataset.sp);
      g.style.display = v == null ? "none" : "";
      if (v != null) g.setAttribute("transform", `translate(0 ${yOf(v).toFixed(1)})`);
    });
  }
  const lvSt = (t) => { const s = lvStatus(t)[0]; return s === "hh" || s === "ll" ? "alarm" : s === "h" || s === "l" ? "warn" : s === "nd" ? "unk" : "ok"; };
  function lvAct(t) {
    const p = pct(t), s = lvSt(t), cls = s === "alarm" ? "lv-alarm" : s === "warn" ? "lv-warn" : "";
    return `<div class="dc-a"><span class="dc-lbl">Actual level</span><div class="dc-big"><b class="num ${cls}">${num(t) == null ? "--" : esc(fmt(t))}</b><small>${esc(t.unit || "")}</small></div>
      <div class="dc-a2 num">${p == null ? "" : `${Math.round(p)} % of range`}</div></div>${stLine(s, lvStatus(t)[1])}`;
  }
  function lvSpTxt(t) {                                 // brief summary: HH 90 % · H 75 % · L 25 % · LL 10 %
    const lv = levelsOf(t), plc = plcLevels(t);
    const shown = (k) => { const id = `${t.id}_${k.toUpperCase()}_SP`; return plc && spIsPct(id) ? `${Number(auxNum(id)).toFixed(0)} %` : `${Number(lv[k]).toFixed(0)} ${t.unit || ""}`; };
    return LV_KEYS.map(([k, l]) => `${l} ${shown(k)}`).join(" · ") + (plc ? "" : " (default - plant values not read)");
  }
  function lvTable(t) {                                 // HH / H / L / LL: set point, set delay, delay now, status
    const lv = levelsOf(t), nd = num(t) == null;
    return `<div class="dc-tw"><table class="dc-lt"><caption class="sr">${esc(t.name)} level set points</caption><thead><tr><th>Level</th><th>Set point</th><th>Set delay</th><th>Delay now</th><th>Status</th></tr></thead><tbody>${LV_KEYS.map(([k, l]) => {
      const up = k.toUpperCase(), sid = `${t.id}_${up}_SP`, on = !!lvActive(t, k);
      const actV = ((live.aux || {})[`${t.id}_${up}_ACT`] || {}).value, timing = !on && typeof actV === "number" && actV > 0;
      const s = nd ? "unk" : on ? (k === "hh" || k === "ll" ? "alarm" : "warn") : timing ? "warn" : "ok";
      return `<tr><td><b>${l}</b></td><td class="num">${esc(plcLevels(t) && spIsPct(sid) ? spTxt(t, sid) : `${Number(lv[k]).toFixed(t.decimals ?? 1)} ${t.unit || ""}`)}</td>
        <td class="num">${esc(auxTxt(`${t.id}_${up}_DLY`))}</td><td class="num">${esc(auxTxt(`${t.id}_${up}_ACT`))}</td>
        <td><span class="dc-st st-${s}"><i aria-hidden="true">${ST_IC[s]}</i>${nd ? "No data" : on ? "Reached" : timing ? "Timing" : "Normal"}</span></td></tr>`;
    }).join("")}</tbody></table></div>`;
  }
  const lvLimits = (t) => { const lv = levelsOf(t); return lv ? LV_KEYS.map(([k, l]) => ({ v: lv[k], label: `${l} ${Number(lv[k]).toFixed(0)}` })) : []; };

  // ---- switch-only tanks: outline + the switch positions (no level fill - these tanks have no level transmitter) ----
  const swT = (pid) => SW_TANKS.find((x) => x.pid === pid);
  // switches are listed top (HH / HL) to bottom (LL). Water at a higher switch is above every lower one too, so the lower
  // switches show as reached ("implied"); a lower switch that still reads OFF is reported as a switch to check.
  function swInfo(tk) {
    const raw = tk.sw.map(([k, l]) => [l, sw(SW[k])]);
    const topI = raw.findIndex(([, v]) => v), nd = raw.every(([, v]) => v == null);
    const st = raw.map(([l, v], i) => [l, topI >= 0 && i > topI ? true : v, topI >= 0 && i > topI && !v]);   // [label, shown, implied]
    const odd = st.filter(([, , imp], i) => imp && raw[i][1] === false).map(([l]) => l);
    const top = topI >= 0 ? raw[topI] : null;
    return { st, s: nd ? "unk" : odd.length ? "warn" : top ? "ok" : "warn",
      txt: nd ? "No data" : top ? `Water at ${top[0]} switch or above${odd.length ? ` · ${odd.join(", ")} switch reads OFF - check it` : ""}`
        : `Below the ${raw[raw.length - 1][0]} switch` };
  }
  const swState = (tk) => (tk ? swInfo(tk).s : "ok");
  // the switch status line on its own, for the card's right-hand column (client 18-11-2026: the box under the tank
  // moved into the empty space under "Set point"); the tank name keeps it readable there
  function swStatus(tk) {
    if (!tk) return "";
    const { s, txt } = swInfo(tk);
    return `<div class="dc-stl dc-swst"><span class="dc-lbl">${esc(tk.name)} · ${esc(tk.pid)}</span> <span class="dc-st st-${s}"><i aria-hidden="true">${ST_IC[s]}</i>${esc(txt)}</span></div>`;
  }
  function swTile(tk, withStatus = true) {
    if (!tk) return "";
    const { st, s, txt } = swInfo(tk), n = st.length;
    const marks = st.map(([l, v, imp], i) => {
      const y = n === 1 ? 50 : 16 + (68 * i) / (n - 1);
      return `<g class="sw-m ${v == null ? "nd" : v ? "on" : ""}${imp ? " imp" : ""}" transform="translate(0 ${y.toFixed(1)})"><line x1="12" x2="50" y1="0" y2="0"/><circle cx="50" cy="0" r="5"/><text x="60" y="5">${l}</text></g>`;
    }).join("");
    const lampTip = (l, v, imp) => imp ? `${l} - water is above it (a higher switch is ON)` : `${l} switch ${v == null ? "no data" : v ? "ON - water has reached it" : "OFF"}`;
    return `<div class="dc-sw">
      <svg class="dc-swg" viewBox="0 0 92 100" role="img" aria-label="${esc(`${tk.name} ${tk.pid}: ${txt}`)}"><rect class="sw-tank" x="6" y="4" width="46" height="92" rx="6"/>${marks}</svg>
      <div class="dc-sw-i"><b>${esc(tk.name)}</b><span class="dc-subt">${esc(tk.pid)} · level switches</span>
        <div class="lsw-lamps">${st.map(([l, v, imp]) => `<span class="lsw-l ${v == null ? "nd" : v ? "on" : ""}${imp ? " imp" : ""}" title="${esc(lampTip(l, v, imp))}">${l}</span>`).join("")}</div>
        ${withStatus ? `<span class="dc-st st-${s}"><i aria-hidden="true">${ST_IC[s]}</i>${esc(txt)}</span>` : ""}</div></div>`;
  }

  // ---- analog values: half-dial gauge with the warning band (90 % of the alarm set point) and alarm band ----
  function dialSVG(t, o = {}) {
    if (!t) return "";
    const lo = t.eng_min ?? 0, hi = t.eng_max ?? 100, span = hi - lo || 1, v = num(t);
    const R = 62, cx = 84, cy = 78;
    const ang = (x) => Math.PI * (1 - clamp((x - lo) / span, 0, 1));
    const P = (x, r = R) => `${(cx + r * Math.cos(ang(x))).toFixed(1)} ${(cy - r * Math.sin(ang(x))).toFixed(1)}`;
    const arc = (a, b, cls, r = R) => (b > a ? `<path class="${cls}" d="M${P(a, r)} A${r} ${r} 0 0 1 ${P(b, r)}"/>` : "");
    let bands = "";
    if (o.sp != null && isFinite(o.sp)) {
      const band = ((window.MD_META || {}).warn_band_pct ?? 90) / 100, warnAt = o.sp >= 0 ? o.sp * band : o.sp / band;
      bands = arc(Math.max(lo, warnAt), Math.min(hi, o.sp), "dg-warn") + arc(Math.max(lo, Math.min(hi, o.sp)), hi, "dg-alarm");
    }
    const ctl = o.band ? arc(Math.max(lo, o.band[0]), Math.min(hi, o.band[1]), "dg-band", R - 13) : "";
    const marks = (o.marks || []).map((m) => `<line class="dg-mark" x1="${P(m, R - 18).split(" ")[0]}" y1="${P(m, R - 18).split(" ")[1]}" x2="${P(m, R + 7).split(" ")[0]}" y2="${P(m, R + 7).split(" ")[1]}"/>`).join("");
    const s = v == null ? "unk" : MD.v3.level(v, o.sp ?? null, "high") || "ok";
    const needle = v == null ? "" : `<line class="dg-needle st-${s}" x1="${cx}" y1="${cy}" x2="${P(v, R - 10).split(" ")[0]}" y2="${P(v, R - 10).split(" ")[1]}"/>`;
    return `<svg class="dc-dial" viewBox="0 0 168 100" role="img" aria-label="${esc(`${t.name}: ${v == null ? "no data" : `${fmt(t)} ${t.unit || ""}`}`)}">
      ${arc(lo, hi, "dg-track")}${bands}${ctl}${marks}${needle}<circle class="dg-hub" cx="${cx}" cy="${cy}" r="5"/>
      <text class="dg-end" x="${cx - R}" y="${cy + 18}" text-anchor="middle">${esc(String(lo))}</text><text class="dg-end" x="${cx + R}" y="${cy + 18}" text-anchor="middle">${esc(String(hi))}</text></svg>`;
  }
  const anSt = (t, spId) => { const v = num(t); if (v == null) return "unk"; const s = MD.v3.level(v, spId ? auxNum(spId) : null, "high"); return s === "alarm" || s === "warn" ? s : "ok"; };
  function anAct(t, label, spId, small) {
    if (!t) return "";
    const s = anSt(t, spId), cls = s === "alarm" ? "lv-alarm" : s === "warn" ? "lv-warn" : "";
    return `<div class="dc-a${small ? " sm" : ""}"><span class="dc-lbl">Actual · ${esc(label)}</span><div class="dc-big"><b class="num ${cls}">${num(t) == null ? "--" : esc(fmt(t))}</b><small>${esc(t.unit || "")}</small></div></div>`;
  }
  const bitSt = (id) => (sw(id) ? "alarm" : "ok");

  // ---- the cards (default order); calc() returns what changes every second ----
  const DC = [
    { k: "sludge", title: "Sludge storage tank", sub: "01-LT-101 level transmitter · pumps send sludge to the volute press", tankId: "LT_01",
      sp: { goto: "sp-tank-LT_01", what: "sludge tank level set points" }, sp2: { label: "Pump & valve levels", goto: "sp-process", what: "sludge pump and valve levels" },
      trend: { tag: "LT_01", title: "Level trend", limits: () => lvLimits(tag("LT_01")) },
      eqs: ["OP_P1A", "OP_P1B", "MV_01", "AGIT", "PCP"],
      calc(c) {
        const t = tag("LT_01");
        if (!t) return null;
        const l1 = num(t), pStart = spToLevel(t, "SP_SLUDGE_PUMP_START"), pStop = spToLevel(t, "SP_SLUDGE_PUMP_STOP");
        const sPump = running("OP_P1A") || running("OP_P1B");
        let next = "", nextSt = "info";
        if (l1 != null && pStart != null && pStop != null) {
          if (sPump) next = `Sludge pump running - stops when the level falls to ${spTxt(t, "SP_SLUDGE_PUMP_STOP")}`;
          else if (l1 >= pStart) { next = `Level is above pump start ${spTxt(t, "SP_SLUDGE_PUMP_START")} - a pump should be running: check Auto mode / trip`; nextSt = "warn"; }
          else next = `Sludge pump starts when the level reaches ${spTxt(t, "SP_SLUDGE_PUMP_START")} (mixer starts 60 s before)`;
        }
        const vNext = auxNum("SP_SLUDGE_VALVE_OPEN") == null ? "" : running("MV_01") ? `Feed valve open - closes at ${spTxt(t, "SP_SLUDGE_VALVE_CLOSE")}`
          : `Feed valve opens when the level falls to ${spTxt(t, "SP_SLUDGE_VALVE_OPEN")}`;
        return { st: worst([lvSt(t), ...eqStates(c.eqs), bitSt("LT_01_ALM"), sw(SW.AIR) === false ? "alarm" : "ok", nextSt === "warn" ? "warn" : "ok"]),
          act: lvAct(t), sp: lvSpTxt(t),
          sp2: `Pump start ${spTxt(t, "SP_SLUDGE_PUMP_START")} · stop ${spTxt(t, "SP_SLUDGE_PUMP_STOP")} · Valve open ${spTxt(t, "SP_SLUDGE_VALVE_OPEN")} · close ${spTxt(t, "SP_SLUDGE_VALVE_CLOSE")}`,
          more: notes([[next, nextSt], [vNext, "info"]]) + dl([dRow("Sludge pump selection", pairSel("OP_P1A")),
            dRow("Mixer OP-A1", "starts 60 s before the pump · stops 60 s after"), airRow("Instrument air (for the valve)", "Low - valve blocked"),
            alRow("Level alarm", "LT_01_ALM")]) + lvTable(t) };
      } },
    { k: "filtrate", title: "Filtrate tank", sub: "01-LT-102 level transmitter · water squeezed out of the sludge", tankId: "LT_02",
      sp: { goto: "sp-tank-LT_02", what: "filtrate tank level set points" },
      trend: { tag: "LT_02", title: "Level trend", limits: () => lvLimits(tag("LT_02")) },
      eqs: ["OP_P5A", "OP_P5B"],
      calc(c) {
        const t = tag("LT_02");
        if (!t) return null;
        return { st: worst([lvSt(t), ...eqStates(c.eqs), bitSt("LT_02_ALM")]), act: lvAct(t), sp: lvSpTxt(t),
          more: dl([dRow("Filtrate pump selection", pairSel("OP_P5A")), dRow("Pump starts", "at normal level"),
            dRow("Pump stops", "at very low level (dry-run protection)"), alRow("Level alarm", "LT_02_ALM")]) + lvTable(t) };
      } },
    { k: "raw", title: "Raw water & supply pressure", sub: "03-PT-301 supply header · 03-LS-301 raw water storage tank",
      sp: { goto: "sp-alarm", what: "supply pressure alarm set point" },
      trend: { tag: "PT_01", title: "Supply pressure trend", limits: () => [auxNum("PT_01_ALM_SP") != null ? { v: auxNum("PT_01_ALM_SP"), label: "Alarm" } : null, { v: 3, label: "Min 3.0" }].filter(Boolean) },
      eqs: ["OP_P14", "OP_P15", "OP_P6A", "OP_P6B"],
      calc(c) {
        const t = tag("PT_01");
        if (!t) return null;
        const v = num(t), tk = swT("03-LS-301"), low = v != null && v < 3;
        const rawLL = sw(SW.LS301_LL), rawHL = sw(SW.LS301_HL), lowTank = rawLL === false && !rawHL;
        const mkRun = running("OP_P14") || running("OP_P15"), ugRun = running("OP_P6A") || running("OP_P6B");
        const rawNote = lowTank ? "Raw water tank below LL - supply pumps stopped (no dry running); a ground water pump should be filling"
          : mkRun ? "Supply pump running on VFD - keeps the header pressure above 3.0 bar" : "";
        const ugNote = ugRun ? "Ground water pump filling the raw water tank - stops at HL" : rawHL ? "Raw water tank full (HL) - ground water pumps off" : "";
        const loc = sw("DI_Submersible_Pump_Panel_Local_remote_Switch_in_Local"), rem = sw("DI_Submersible_Pump_Panel_Local_remote_Switch_in_Remote");
        return { st: worst([anSt(t, "PT_01_ALM_SP"), bitSt("PT_01_ALM"), low ? "warn" : "ok", swState(tk), lowTank ? "alarm" : "ok", ...eqStates(c.eqs)]),
          fig: dialSVG(t, { sp: auxNum("PT_01_ALM_SP"), marks: [3] }) + swTile(tk, false), swst: swStatus(tk),
          act: anAct(t, "Supply pressure", "PT_01_ALM_SP") + stLine(v == null ? "unk" : low ? "warn" : "ok", v == null ? "No data" : low ? "Below 3.0 bar - header pressure low" : "Above 3.0 bar"),
          sp: `Alarm ${auxTxt("PT_01_ALM_SP")}`,
          more: notes([[rawNote, lowTank ? "alarm" : "info"], [ugNote, "info"]]) + dl([dRow("Supply pump selection (VFD)", pairSel("OP_P14")),
            dRow("Ground water pump selection", pairSel("OP_P6A")), swRow2("Ground water flow 03-FS-301", SW.FLOW, "Flow detected", "No flow", ugRun ? false : null),
            dRow("Submersible pump panel", loc == null && rem == null ? "No data" : loc ? "Local - cannot start from the panel" : rem ? "Remote" : "Neither", loc ? "warn" : rem ? "ok" : "unk"),
            dRow("Supply header minimum", "3.0 bar (control logic)"), alRow("Pressure alarm", "PT_01_ALM")]) };
      } },
    { k: "ph", title: "Process water pH", sub: "pH-01 · acid / alkali dosed automatically to keep 6.5 - 7.5",
      sp: { goto: "sp-alarm", what: "pH alarm set point" },
      trend: { tag: "PH_01", title: "pH trend", limits: () => [auxNum("PH_01_ALM_SP") != null ? { v: auxNum("PH_01_ALM_SP"), label: "Alarm" } : null, { v: 6.5, label: "6.5" }, { v: 7.5, label: "7.5" }].filter(Boolean) },
      eqs: ["OP_P12", "OP_P13"],
      calc(c) {
        const t = tag("PH_01");
        if (!t) return null;
        const v = num(t), out = v != null && (v < 6.5 || v > 7.5), both = running("OP_P12") && running("OP_P13");
        const txt = v == null ? "No data" : v < 6.5 ? "Too acidic - alkali being added" : v > 7.5 ? "Too alkaline - acid being added" : "Within 6.5 - 7.5";
        return { st: worst([anSt(t, "PH_01_ALM_SP"), bitSt("PH_01_ALM"), out ? "warn" : "ok", both ? "alarm" : "ok", ...eqStates(c.eqs)]),
          fig: dialSVG(t, { sp: auxNum("PH_01_ALM_SP"), band: [6.5, 7.5] }),
          act: anAct(t, "pH", "PH_01_ALM_SP") + stLine(v == null ? "unk" : out ? "warn" : "ok", txt),
          sp: `Alarm ${auxTxt("PH_01_ALM_SP")} · dosing band 6.5 - 7.5`,
          more: dl([dRow("Acid dosing starts / stops", "pH ≤ 6.5 / pH ≥ 7.0"), dRow("Alkali dosing starts / stops", "pH ≥ 7.5 / pH ≤ 7.0"),
            dRow("Never both together", both ? "Both running" : "OK", both ? "alarm" : "ok"), alRow("pH alarm", "PH_01_ALM")]) };
      } },
    { k: "degas", title: "De-gasifier", sub: "07-TT-701 water temperature · 07-LS-701 tank switches · steam heats the water",
      sp: { goto: "sp-process", what: "LP steam valve set points" }, sp2: { label: "Alarm", goto: "sp-alarm", what: "temperature alarm set point" },
      trend: { tag: "T_04", title: "Temperature trend", limits: () => [["T_04_ALM_SP", "Alarm"], ["SP_LP_STEAM_OPEN", "Steam open"], ["SP_LP_STEAM_CLOSE", "Steam close"]]
        .filter(([id]) => auxNum(id) != null).map(([id, l]) => ({ v: auxNum(id), label: l })) },
      eqs: ["OP_SV1", "OP_SV2", "OP_M1", "OP_P4", "OP_P9"],
      calc(c) {
        const t = tag("T_04");
        if (!t) return null;
        const v = num(t), so = auxNum("SP_LP_STEAM_OPEN"), scl = auxNum("SP_LP_STEAM_CLOSE"), tk = swT("07-LS-701");
        const dg = ["LS701_HH", "LS701_H", "LS701_L", "LS701_LL"].map((k) => sw(SW[k]));
        const dgTxt = dg.some((x) => x == null) ? ["No data", "unk"] : dg[0] ? ["HH - outlet valve opens", "warn"] : dg[1] ? ["H", "ok"]
          : dg[2] ? ["L", "ok"] : dg[3] ? ["Between LL and L", "warn"] : ["Below LL - recirculation pump stops", "alarm"];
        const heat = v == null ? "No data" : so != null && v < so ? "Below steam open set point - heating" : scl != null && v > scl ? "Above steam close set point" : "Within the steam control band";
        return { st: worst([anSt(t, "T_04_ALM_SP"), bitSt("T_04_ALM"), sw(SW.AIR) === false ? "alarm" : "ok", dgTxt[1] === "unk" ? "ok" : dgTxt[1], ...eqStates(c.eqs)]),
          fig: dialSVG(t, { sp: auxNum("T_04_ALM_SP"), band: so != null && scl != null ? [Math.min(so, scl), Math.max(so, scl)] : null }) + swTile(tk, false), swst: swStatus(tk),
          act: anAct(t, "Water temperature", "T_04_ALM_SP") + stLine(v == null ? "unk" : "info", heat),
          sp: `Steam valve opens ${spNum("SP_LP_STEAM_OPEN")} · closes ${spNum("SP_LP_STEAM_CLOSE")} °C`,
          sp2: `Temperature alarm ${auxTxt("T_04_ALM_SP")}`,
          more: dl([dRow("De-gasifier tank 07-LS-701", dgTxt[0], dgTxt[1]), airRow("Instrument air", "Low - steam valve closed"), alRow("Temperature alarm", "T_04_ALM")]) };
      } },
    { k: "hotwater", title: "Hot water to sludge dryer", sub: "06-TT-601 temperature · 06-PT-601 pressure · 06-LS-603 hot water tank",
      sp: { goto: "sp-alarm", what: "hot water alarm set points" },
      trend: { tag: "T_02", title: "Temperature trend", limits: () => (auxNum("T_02_ALM_SP") != null ? [{ v: auxNum("T_02_ALM_SP"), label: "Alarm" }] : []) },
      eqs: ["OP_P2"],
      calc(c) {
        const t = tag("T_02"), p = tag("PT_03");
        if (!t) return null;
        const tk = swT("06-LS-603"), ps = p ? anSt(p, "PT_03_ALM_SP") : "ok";
        return { st: worst([anSt(t, "T_02_ALM_SP"), ps === "unk" ? "ok" : ps, bitSt("T_02_ALM"), bitSt("PT_03_ALM"), swState(tk), ...eqStates(c.eqs)]),
          fig: dialSVG(t, { sp: auxNum("T_02_ALM_SP") }) + swTile(tk, false), swst: swStatus(tk),
          act: anAct(t, "Temperature", "T_02_ALM_SP") + anAct(p, "Pressure", "PT_03_ALM_SP", true),
          sp: `Alarm ${auxTxt("T_02_ALM_SP")} · ${auxTxt("PT_03_ALM_SP")}`,
          more: dl([dRow("Hot water pump (VFD)", "runs above LL · stops at LL (and at HH)"), alRow("Temperature alarm", "T_02_ALM"), alRow("Pressure alarm", "PT_03_ALM")]) };
      } },
    { k: "ct", title: "Cooling towers", sub: "CT-1: de-gasifier PHE, dryer condenser, boiler · CT-2: turbine oil", noMain: true,
      eqs: ["OP_P7", "OP_P3", "OP_P11", "OP_F1", "OP_P10", "OP_F2"],
      calc(c) {
        const a = swT("06-LS-601"), b = swT("06-LS-602");
        return { st: worst([swState(a), swState(b), ...eqStates(c.eqs)]), fig: swTile(a) + swTile(b),
          more: dl([dRow("Fans", "run only when a pump of their tower runs"), dRow("Pumps", "stop at basin LL")]) };
      } },
    { k: "gravity", title: "Gravity tank & CTP", sub: "07-LS-702 gravity tank → 07-P-704 → CTP raw water tank", noMain: true,
      eqs: ["OP_P8"],
      calc(c) {
        const tks = ["07-LS-702", "08-LS-801/802", "08-LS-803/804"].map(swT);
        return { st: worst([...tks.map(swState), ...eqStates(c.eqs)]), fig: tks.map(swTile).join(""),
          more: dl([dRow("Pump 07-P-704 runs while", "gravity tank above LL and CTP raw water tank below HH")]) };
      } },
  ];
  const DC_BY = Object.fromEntries(DC.map((c) => [c.k, c]));
  const TANK_CFG = (id) => LV_TANKS.find((x) => x.id === id);
  function dcSkeleton(c) {
    const lt = c.tankId ? tag(c.tankId) : null;
    const pen = (goto, what) => `<button class="v3-pen" type="button" data-goto="${goto}" aria-label="Change the ${esc(what)} on the Set points page" title="Change on the Set points page">${MD.v3.PEN}</button>`;
    return `<article class="dc" data-card="${c.k}" aria-labelledby="dch-${c.k}">
      <header class="dc-h">
        <button class="dc-grip" type="button" draggable="true" aria-label="Drag to move the ${esc(c.title)} card" title="Drag to reorder">${GRIP}</button>
        <div class="dc-ttl"><h3 id="dch-${c.k}">${esc(c.title)}</h3><span class="dc-subt">${esc(c.sub)}</span></div>
        <span class="dc-chip" data-slot="chip"></span>
        <span class="dc-mv"><button type="button" data-mv="-1" aria-label="Move the ${esc(c.title)} card up" title="Move up">${UP}</button><button type="button" data-mv="1" aria-label="Move the ${esc(c.title)} card down" title="Move down">${DOWN}</button></span>
      </header>
      <div class="dc-body${c.noMain ? " no-main" : ""}">
        <div class="dc-fig" data-slot="${lt ? "tank" : "fig"}">${lt ? lvFigHTML(TANK_CFG(c.tankId), lt) : ""}</div>
        ${c.noMain ? "" : `<div class="dc-main"><div class="dc-acts" data-slot="act"></div>
          ${c.sp ? `<div class="dc-sp"><span class="dc-lbl">Set point</span><span class="dc-sp-v" data-slot="sp"></span>${pen(c.sp.goto, c.sp.what)}</div>` : ""}
          <div data-slot="swst"></div></div>`}
        <div class="dc-eqs"><span class="dc-lbl">Equipment</span><div class="dc-eql" data-slot="eqs"></div></div>
      </div>
      <div class="dc-more" id="dcm-${c.k}" hidden>
        <div data-slot="more"></div>
        ${c.sp2 ? `<div class="dc-sp"><span class="dc-lbl">${esc(c.sp2.label)}</span><span class="dc-sp-v" data-slot="sp2"></span>${pen(c.sp2.goto, c.sp2.what)}</div>` : ""}
        ${c.trend ? `<div class="dc-trend"><div class="dc-trend-h"><h4>${esc(c.trend.title)}</h4><div class="dc-rp"></div>
          <button class="dc-fs" type="button" aria-pressed="false" title="Show the trend on the whole screen (Esc to close)">${FS_IC}<span>Full screen</span></button></div><div class="chart dc-chart"></div></div>` : ""}
      </div>
      <button class="dc-tog" type="button" aria-expanded="false" aria-controls="dcm-${c.k}"><span>Show more</span>${CHEV}</button>
    </article>`;
  }
  const slotOf = (el, n) => el.querySelector(`[data-slot="${n}"]`);
  function setH(el, html) { if (el && el._h !== html) { el.innerHTML = html; el._h = html; } }
  function dcOrder(box, order) {                        // restore the user's saved order (unknown / new cards keep their place at the end)
    if (!Array.isArray(order) || !order.length) return;
    const cards = [...box.children];
    const rank = (k) => { const i = order.indexOf(k); return i < 0 ? order.length + DC.findIndex((c) => c.k === k) : i; };
    cards.sort((a, b) => rank(a.dataset.card) - rank(b.dataset.card)).forEach((c) => box.appendChild(c));
  }
  const dcSave = (box) => MD.v3.savePrefs({ card_order: [...box.children].map((c) => c.dataset.card) });
  const REDUCED = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  function dcSetOpen(card, open) {
    const more = card.querySelector(".dc-more"), tog = card.querySelector(".dc-tog");
    if (more.hidden !== open) return;                 // already in that state
    more.hidden = !open;
    tog.setAttribute("aria-expanded", String(open));
    tog.querySelector("span").textContent = open ? "Show less" : "Show more";
    card.classList.toggle("open", open);
    if (open) dcTrendOpen(card);
  }
  function dcFlash(el) { el.classList.remove("dc-flash"); void el.offsetWidth; el.classList.add("dc-flash"); }
  // "Alert" chip clicked: open the details if the problem is there, scroll to it and mark it
  function dcShowProblem(card) {
    const probs = dcProblems(card);
    if (!probs.length) return;
    const [el] = probs[0];
    if (el.closest(".dc-more")) {
      const box = card.parentNode;
      [...box.children].filter((c) => !c.hidden && c.offsetTop === card.offsetTop).forEach((c) => dcSetOpen(c, true));
    }
    el.scrollIntoView({ block: "center", behavior: REDUCED() ? "auto" : "smooth" });
    probs.forEach(([p]) => dcFlash(p));
  }
  // trend in full screen (Esc or the button closes it); the chart is drawn again at the new size, keeping the zoom
  function dcTrendFull(card) {
    const tr = card.querySelector(".dc-trend");
    if (document.fullscreenElement === tr || tr.classList.contains("fs")) {
      if (document.fullscreenElement) document.exitFullscreen(); else dcTrendFsDone(card, false);
      return;
    }
    if (tr.requestFullscreen) tr.requestFullscreen().catch(() => dcTrendFsDone(card, true));
    else dcTrendFsDone(card, true);                   // no Fullscreen API: fill the window instead
  }
  function dcTrendFsDone(card, on) {
    const tr = card.querySelector(".dc-trend"), b = card.querySelector(".dc-fs");
    tr.classList.toggle("fs", on);
    card._trFs = on;
    b.setAttribute("aria-pressed", String(on));
    b.querySelector("span").textContent = on ? "Exit full screen" : "Full screen";
    if (card._trRange) {
      const c = DC_BY[card.dataset.card];
      requestAnimationFrame(() => dcTrendLoad(card, card._trRange[0], card._trRange[1], MDChart.getView(`tank-${c.trend.tag}`)));
    }
  }
  document.addEventListener("fullscreenchange", () => {
    document.querySelectorAll(".dc").forEach((card) => {
      const tr = card.querySelector(".dc-trend");
      if (!tr) return;
      const on = document.fullscreenElement === tr;
      if (on !== !!card._trFs) dcTrendFsDone(card, on);
    });
  });
  document.addEventListener("keydown", (e) => {      // Esc also closes the window-filling fallback
    if (e.key !== "Escape") return;
    document.querySelectorAll(".dc-trend.fs").forEach((tr) => { if (!document.fullscreenElement) dcTrendFsDone(tr.closest(".dc"), false); });
  });
  function dcWire(box) {
    let dragEl = null;
    box.addEventListener("dragstart", (e) => {
      const g = e.target.closest && e.target.closest(".dc-grip");
      if (!g) return;
      dragEl = g.closest(".dc");
      dragEl.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", dragEl.dataset.card); e.dataTransfer.setDragImage(dragEl, 24, 24); } catch (_) { /* old browsers */ }
    });
    box.addEventListener("dragover", (e) => {
      if (!dragEl) return;
      e.preventDefault();
      const over = e.target.closest(".dc");
      if (!over || over === dragEl || over.parentNode !== box) return;
      const kids = [...box.children];
      if (kids.indexOf(dragEl) < kids.indexOf(over)) over.after(dragEl); else over.before(dragEl);
    });
    box.addEventListener("drop", (e) => { if (dragEl) e.preventDefault(); });
    box.addEventListener("dragend", () => { if (!dragEl) return; dragEl.classList.remove("dragging"); dragEl = null; dcSave(box); });
    box.addEventListener("click", (e) => {
      const tog = e.target.closest(".dc-tog");
      if (tog) {
        const card = tog.closest(".dc"), open = card.querySelector(".dc-more").hidden;
        // cards side by side share a row: open / close the whole row together, so the neighbour does not stand
        // beside a tall card with an empty white area (each card still has its own button)
        const row = [...box.children].filter((c) => !c.hidden && c.offsetTop === card.offsetTop);
        row.forEach((c) => dcSetOpen(c, open));
        if (!open && card.getBoundingClientRect().top < 0) {   // Show less: the row shrank above the view - bring it back so the user is not left on the next card
          card.scrollIntoView({ block: "start", behavior: REDUCED() ? "auto" : "smooth" });
          row.forEach(dcFlash);
        }
        return;
      }
      const prob = e.target.closest("[data-prob]");
      if (prob) { dcShowProblem(prob.closest(".dc")); return; }
      const fs = e.target.closest(".dc-fs");
      if (fs) { dcTrendFull(fs.closest(".dc")); return; }
      const pen = e.target.closest("[data-goto]");
      if (pen) { gotoSp(pen.dataset.goto); return; }
      const mv = e.target.closest("[data-mv]");
      if (mv) {
        const card = mv.closest(".dc"), d = +mv.dataset.mv;
        const sib = d < 0 ? card.previousElementSibling : card.nextElementSibling;
        if (!sib) return;
        if (d < 0) sib.before(card); else sib.after(card);
        mv.focus();
        dcSave(box);
      }
    });
  }
  // trend inside an opened card: 8 hours / 2 days / 7 days / custom range (IST), limited to the kept history
  function dcTrendOpen(card) {
    const c = DC_BY[card.dataset.card];
    if (!c.trend) return;
    if (card._rp) { if (card._rp.key !== "custom") card._rp.refresh(); return; }
    card._rp = MD.v3.rangePicker(card.querySelector(".dc-rp"), { presets: [["8 hours", "8h"], ["2 days", "2d"], ["7 days", "7d"], ["Custom", "custom"]],
      initial: "8h", onApply: (f, t, k) => dcTrendLoad(card, f, t, null, card._trKey !== undefined && (card._trKey !== k || k === "custom")) });
  }
  // [f, t] = the selected range (zoom "home"); view = zoomed window to fetch finer data for; reset = new range picked
  async function dcTrendLoad(card, f, t, view, reset) {
    const c = DC_BY[card.dataset.card], id = c.trend.tag, tg = tag(id), box = card.querySelector(".dc-chart");
    card._trAt = Date.now(); card._trKey = card._rp ? card._rp.key : ""; card._trRange = [f, t];
    const [qf, qt] = view || [f, t];
    try {
      const r = await MD.api(`/api/trend?tags=${encodeURIComponent(id)}&from=${Math.floor(qf)}&to=${Math.ceil(qt)}&points=300`);
      const s = r.series[0];
      if (!s) { box.innerHTML = '<p class="muted">No trend is recorded for this value.</p>'; return; }
      MDChart.render(box, { name: s.name, unit: s.unit, decimals: s.decimals, color: "var(--s3)", points: s.points, from: f, to: t,
        limits: c.trend.limits(), yMin: tg ? tg.eng_min : undefined, yMax: tg ? tg.eng_max : undefined,
        height: card._trFs ? Math.max(240, box.closest(".dc-trend").clientHeight - box.offsetTop - 64) : 240,   // 64 = zoom bar + padding
        zoomGroup: `tank-${id}`, resetZoom: !!reset, ...(view ? { view } : {}),
        onView: (a, b, o) => { const [hf, ht] = card._trRange; dcTrendLoad(card, hf, ht, o && o.reset ? null : [a, b]); } });
    } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
  }

  function renderKeyPoints() {
    const box = $("keyPoints");
    if (!box || !live) return;
    if (!box._built) {
      box._built = true;
      box.classList.add("dc-grid");
      box.innerHTML = DC.map(dcSkeleton).join("");
      dcWire(box);
      if (MD.v3 && MD.v3.prefs) MD.v3.prefs().then((p) => dcOrder(box, p && p.card_order)).catch(() => {});
    }
    const now = Date.now();
    box.querySelectorAll(".dc").forEach((el) => {
      const c = DC_BY[el.dataset.card];
      let r = null;
      try { r = c.calc(c); } catch (e) { console.warn("card", c.k, e); }
      el.hidden = !r;
      if (!r) return;
      RANK.forEach((s) => el.classList.toggle(`st-${s}`, s === r.st));
      if (c.tankId) lvFigUpdate(slotOf(el, "tank"), tag(c.tankId), TANK_CFG(c.tankId)); else setH(slotOf(el, "fig"), r.fig || "");
      setH(slotOf(el, "act"), r.act || "");
      setH(slotOf(el, "swst"), r.swst || "");
      setH(slotOf(el, "sp"), esc(r.sp || "--"));
      setH(slotOf(el, "sp2"), esc(r.sp2 || "--"));
      setH(slotOf(el, "eqs"), c.eqs.map(eqItem).join(""));
      setH(slotOf(el, "more"), r.more || "");
      setH(slotOf(el, "chip"), chipBtnHTML(r.st, r.st === "ok" ? [] : dcProblems(el)));   // after the body: it lists what the body shows
      if (el._rp && el.classList.contains("open") && el._rp.key !== "custom" && now - (el._trAt || 0) > 60000
        && !(MDChart.getView && MDChart.getView(`tank-${c.trend.tag}`))) el._rp.refresh();   // not while zoomed in
    });
    dcAlignRows(box);
    if (!box._ro && window.ResizeObserver) { box._ro = new ResizeObserver(() => dcAlignRows(box)); box._ro.observe(box); }
  }
  // cards side by side: the "Equipment" line of every card in a row at the same height (client 18-11-2026: "both lines
  // not aligned"). Only where the equipment list sits UNDER the picture / values; recomputed on every update and resize.
  function dcAlignRows(box) {
    if (box._alignRaf) return;
    box._alignRaf = setTimeout(() => {               // (a timer, not an animation frame: also runs in a background tab)
      box._alignRaf = 0;
      const cards = [...box.querySelectorAll(".dc")].filter((d) => !d.hidden && d.offsetParent);
      const eqsOf = (d) => d.querySelector(":scope > .dc-body > .dc-eqs");
      // the first body row (picture | values) is made taller, so the values column divider still meets the line
      cards.forEach((d) => { const b = d.querySelector(".dc-body"); if (b && b.style.gridTemplateRows) b.style.gridTemplateRows = ""; });
      const rows = new Map();
      cards.forEach((d) => { const k = Math.round(d.offsetTop); if (!rows.has(k)) rows.set(k, []); rows.get(k).push(d); });
      rows.forEach((row) => {
        if (row.length < 2) return;
        const below = row.map((d) => {                  // equipment under the picture / values (not beside them)?
          const e = eqsOf(d), b = d.querySelector(".dc-body");
          if (!e || !b) return null;
          const bt = b.getBoundingClientRect().top, et = e.getBoundingClientRect().top;
          return et > bt + 8 ? { b, row1: et - bt - parseFloat(getComputedStyle(b).rowGap || 0), y: et - d.getBoundingClientRect().top } : null;
        }).filter(Boolean);
        if (below.length < 2) return;
        const max = Math.max(...below.map((x) => x.y));
        below.forEach((x) => { if (max - x.y > 0.5) x.b.style.gridTemplateRows = `${(x.row1 + max - x.y).toFixed(1)}px auto`; });
      });
    }, 0);
  }
  // pencil beside a set point summary: open Set points at the matching section (editing stays there)
  let spTarget = null;
  function gotoSp(id) {
    spTarget = id;
    if (location.hash === "#setpoints") spScroll(); else location.hash = "#setpoints";
  }
  function spScroll() {
    if (!spTarget) return;
    const el = document.getElementById(spTarget);
    if (!el || el.closest(".hidden")) return;        // built / shown on the next render
    spTarget = null;
    // the page may still grow while it is first built: jump after it settles, then correct once more
    setTimeout(() => {
      el.scrollIntoView({ behavior: "auto", block: "start" });
      setTimeout(() => { if (Math.abs(el.getBoundingClientRect().top - 16) > 24) el.scrollIntoView({ behavior: "auto", block: "start" }); }, 400);
      el.classList.add("sp-flash");
      setTimeout(() => el.classList.remove("sp-flash"), 1800);
    }, 150);
  }
  function lampChip(id, label) {
    const v = sw(id);
    return `<span class="kp-eq ${v == null ? "unk" : v ? "lamp" : "stop"}" title="Float switch ${v == null ? "no data" : v ? "ON" : "OFF"}"><i></i>${esc(label)}</span>`;
  }

  // ---------- plant areas = mimic sheets ----------
  const AREAS = [
    { id: "overall", name: "Overall plant", eq: [], overall: true },
    // v3 (SC04): no separate "3D plant" tab - 3D is the 2D / 3D switch beside the mimic heading (SHEETS.d3)
    { id: "sludge", name: "Sludge & filtrate", eq: ["AGIT", "OP_P1A", "OP_P1B", "MV_01", "OP_P5A", "OP_P5B"] },
    { id: "volute", name: "Volute press", eq: ["PCP"] },
    { id: "raw", name: "Raw water", eq: ["OP_P6A", "OP_P6B", "OP_P14", "OP_P15"] },
    { id: "ct1", name: "Cooling tower 1", eq: ["OP_F1", "OP_P7", "OP_P3", "OP_P11"] },
    { id: "ct2", name: "Cooling tower 2 & hot water", eq: ["OP_F2", "OP_P10", "OP_P2"] },
    { id: "degas", name: "De-gasifier & dosing", eq: ["OP_M1", "OP_P4", "OP_P9", "OP_P12", "OP_P13", "OP_P8", "OP_SV1", "OP_SV2"] },
    { id: "wtp", name: "WTP / CTP", eq: [] },
  ];
  function areaChip(a) {
    // the overall card counts every machine on the dashboard and opens the whole-plant mimic
    const list = a.overall ? live.equipment : a.eq.map(eq).filter(Boolean);
    const motors = list.filter((e) => e.type === "motor");
    const run = motors.filter((e) => ["RUNNING", "STARTING"].includes(e.status)).length;
    const trip = list.filter((e) => ["TRIP", "FAULT"].includes(e.status)).length;
    const nod = motors.filter((e) => e.status === "UNKNOWN").length;      // no data: not counted as stopped
    return `<button class="kp-area ${trip ? "trip" : run ? "run" : ""}${a.overall ? " all" : ""}" data-sheet="${a.id}">
      <span class="ka-n">${esc(a.overall ? "Plant overview" : a.name)}</span>
      <span class="ka-s">${!motors.length ? "Level switches" : nod === motors.length ? `No data (${motors.length} machines)`
        : `<b class="num">${run}</b>/${motors.length} running${nod ? ` · ${nod} no data` : ""}`}${trip ? ` · <b class="t">${trip} tripped</b>` : ""}</span>
      <span class="ka-go">Mimic →</span></button>`;
  }

  // ======================================================================================
  // MIMIC - SVG process sheets. Built once per sheet; live values are patched in place.
  // ======================================================================================
  const W = 1000, H = 560;
  // v3 (SC04): label scale of the sheet being drawn. Text is 15 user units on the area sheets (≥ 12 px on screen at fit
  // on a 1366 px window: the 1240-unit sheet is drawn ≈ 1000 px wide) and 15 × 1.3 on the 1600-unit overall sheet.
  // Boxes that hold text (lamps, chips, readouts, badges) are sized with the same factor.
  let FS = 1;
  const T = (u) => u * FS;                              // a size in "label units" of the current sheet
  const tw = (s, u = 15, k = 0.6) => String(s).length * u * k * FS;   // estimated text width (bold ≈ 0.6 em)
  // pipes are collected while a sheet is drawn; their flow chevrons are added afterwards (sheetSVG), placed clear of
  // the valves, gauges and labels registered in OB
  let PIPES = [], OB = [], OY = 0;
  const ob = (x1, y1, x2, y2) => { OB.push([Math.min(x1, x2), Math.min(y1, y2) + OY, Math.max(x1, x2), Math.max(y1, y2) + OY]); return ""; };
  // part of a sheet moved down by dy (keeps its own coordinates; obstacles are registered at the moved position)
  function shiftY(dy, fn) { OY += dy; const s = fn().join(""); OY -= dy; return `<g transform="translate(0 ${dy})">${s}</g>`; }
  // drawing primitives (all return SVG strings)
  const P = {
    // flow = IO machines that move liquid in this line (any one running); o.need = conditions that must also hold:
    // a valve id (must be confirmed open) or "sw:<signal>" (must not be OFF). Lines without machines never animate.
    // Lines are drawn source → destination: the arrow at the end and the chevrons along long runs show that direction.
    pipe(d, kind, flow = [], o = {}) {
      PIPES.push({ d, kind, arrows: o.arrows !== false, oy: OY });
      return `<path class="pp k-${kind}" d="${d}" marker-end="url(#ar-${kind})"/><path class="pf k-${kind}" d="${d}" data-flow="${flow.join(",")}"${o.need ? ` data-need="${o.need.join(",")}"` : ""}/><!--AR${PIPES.length - 1}-->`;
    },
    tank(x, y, w, h, o = {}) {
      const id = o.level ? `data-lvl="${o.level}"` : o.sw ? `data-swl="${o.sw.map((s) => `${s.id}:${s.at}`).join(",")}"` : "";
      let s = `<g class="tank${o.sw && !o.level ? " ind" : ""}"><rect class="t-body" x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.r ?? 6}"/>
        <clipPath id="cl${x}_${y}"><rect x="${x + 3}" y="${y + 3}" width="${w - 6}" height="${h - 6}" rx="${Math.max(0, (o.r ?? 6) - 2)}"/></clipPath>
        <rect class="t-fill ${o.fluid || "water"}" clip-path="url(#cl${x}_${y})" x="${x}" y="${y + h}" width="${w}" height="0" ${id} data-y0="${y}" data-h="${h}"/>`;
      if (o.label) s += `<text class="t-lbl" x="${o.labelX ?? x + w / 2}" y="${y + h + (o.labelDy ?? T(18))}" text-anchor="${o.labelAnchor || "middle"}">${esc(o.label)}</text>`;
      // switch / transmitter tag no under the name, shown when zoomed in (the area sheets carry it too)
      if (o.sub) s += `<text class="note lod" x="${o.labelX ?? x + w / 2}" y="${y + h + (o.labelDy ?? T(18)) + T(15)}" text-anchor="${o.labelAnchor || "middle"}">${esc(o.sub)}</text>`;
      s += ob(x, y, x + w, y + h);
      // v3 (SC04): level transmitter tanks only - actual level and % in large text in the middle of the tank
      // (moved sideways with readX where pump risers pass through); switch-only tanks get no number (none is measured)
      const rx = x + (o.readX ?? w / 2), rw = T(124), rh = T(50), ry = y + (o.readY ?? h / 2) - rh / 2;
      const rd = !o.level ? "" : `<g class="t-read" data-tag="${o.level}"><rect x="${rx - rw / 2}" y="${ry}" width="${rw}" height="${rh}" rx="${T(8)}"/>
        <text class="tr-v num" x="${rx}" y="${ry + T(23)}" text-anchor="middle" data-val="${o.level}">--</text>
        <text class="tr-p num" x="${rx}" y="${ry + T(42)}" text-anchor="middle" data-pct="${o.level}">--</text></g>` + ob(rx - rw / 2, ry, rx + rw / 2, ry + rh);
      (o.sw || []).forEach((sv, i) => (s += P.lamp(o.lampX ?? x + w + 8, y + h * sv.at, sv.id, sv.label)));   // lampX: lamps on the other side
      if (o.level) {                                    // HH / H / L / LL: lamps beside the tank + dashed set-point lines inside
        // each lamp follows its set-point line (patchMimic), joined to the tank wall by a short leader; lvAt only gives
        // the band the lamps may use (kept clear of a bottom mixer) - the letters are on the lamps, not repeated inside
        const at = o.lvAt || [0.1, 0.3, 0.7, 0.9], lo = y + h * Math.min(...at), hi = y + h * Math.max(...at);
        at.forEach((a, i) => {
          const [k, l] = LV_KEYS[i];
          s += `<line class="lv-lead" data-lvlead="${o.level}:${k}" x1="${x + w}" x2="${x + w + 8}" y1="${y + h * a}" y2="${y + h * a}"/>`;
          s += P.lvLamp(x + w + 8, y + h * a, `${o.level}:${k}`, l);
          s += `<g class="lv-ln" data-lvln="${o.level}:${k}" data-y0="${y}" data-h="${h}" data-lo="${lo}" data-hi="${hi}"><line x1="${x + 4}" x2="${x + w - 4}" y1="${y + h}" y2="${y + h}"/></g>`;
        });
      }
      return s + rd + "</g>";                            // readout last: drawn over the dashed set-point lines
    },
    lvLamp(x, y, key, label) {                          // level set-point lamp, lit from the transmitter value
      const w = Math.max(T(40), tw(label) + T(14)), h = T(22);
      return `<g class="lamp lvl" data-lv="${key}" data-cy="${y}"><rect x="${x}" y="${y - h / 2}" width="${w}" height="${h}" rx="${h / 2}"/><text x="${x + w / 2}" y="${y + T(5)}" text-anchor="middle">${esc(label)}</text></g>` + ob(x, y - h / 2, x + w, y + h / 2);
    },
    lamp(x, y, id, label) {
      const w = Math.max(T(40), tw(label) + T(14)), h = T(22);
      return `<g class="lamp" data-sw="${id}"><rect x="${x}" y="${y - h / 2}" width="${w}" height="${h}" rx="${h / 2}"/><text x="${x + w / 2}" y="${y + T(5)}" text-anchor="middle">${esc(label)}</text></g>` + ob(x, y - h / 2, x + w, y + h / 2);
    },
    pump(x, y, id, o = {}) {
      const lbl = o.label ?? PID[id] ?? id;
      // motor + centrifugal pump set on a base plate (shaded like the HMI graphic); motor colour = state,
      // status light top-left, impeller in the volute spins while running
      const fins = [-18, -14, -10, -6].map((d) => `<line class="pm-fin" x1="${x + d}" y1="${y - 7}" x2="${x + d}" y2="${y + 7}"/>`).join("");
      // o.flip mirrors the set (suction on the right); labels stay outside the scaled group so they never mirror
      const up = o.below === false;
      const ty = up ? y - 21 - T(3.75) : y + 20 + T(11.25);   // tag under the base plate (or above the nozzle), clear of the symbol
      return `<g class="eq pump" data-eq="${id}" tabindex="0"><g transform="translate(${x} ${y}) scale(${o.flip ? -1.2 : 1.2} 1.2) translate(${-x} ${-y})">
        <rect class="pm-base" x="${x - 25}" y="${y + 10}" width="48" height="4" rx="1"/>
        <rect class="pm-foot" x="${x - 19}" y="${y + 7}" width="5" height="4"/><rect class="pm-foot" x="${x - 9}" y="${y + 7}" width="5" height="4"/>
        <rect class="pm-foot" x="${x + 7}" y="${y + 7}" width="6" height="4"/>
        <rect class="pm-cap" x="${x - 26}" y="${y - 5}" width="4" height="10" rx="1.5"/>
        <rect class="pm-motor" x="${x - 22}" y="${y - 8}" width="20" height="16" rx="3"/>${fins}
        <rect class="pm-cpl" x="${x - 2}" y="${y - 3}" width="3.5" height="6"/>
        <rect class="pm-noz" x="${x + 11}" y="${y - 16}" width="7" height="8" rx="1"/>
        <rect class="pm-noz" x="${x + 18}" y="${y - 3}" width="5" height="7" rx="1"/>
        <circle class="pm-vol" cx="${x + 10}" cy="${y}" r="8.5"/>
        <g class="spin" style="transform-origin:${x + 10}px ${y}px"><path class="pm-imp" d="M${x + 10} ${y} l5 -3 M${x + 10} ${y} l-2.5 5.5 M${x + 10} ${y} l-3 -4.5"/></g>
        <circle class="pm-led" cx="${x - 12}" cy="${y - 13}" r="3.5"/></g>
        <text class="eq-t pm-t" x="${x}" y="${ty}" text-anchor="middle">${esc(lbl)}</text>
        ${o.name !== false && PUMP_NAME[id] ? `<text class="eq-n pm-n" x="${x}" y="${up ? ty - T(16) - 2 : ty + T(16)}" text-anchor="middle">${esc(PUMP_NAME[id])}</text>` : ""}</g>`
        + ob(x - 32, y - 20, x + 28, y + 17);
    },
    // submersible pump (P&ID: sludge / filtrate tank pumps, ground water pumps): vertical body standing on the floor at (x, y),
    // motor at the bottom (coloured by state), intake screen, discharge flange on top at y - 50; name beside it
    subPump(x, y, id, o = {}) {
      const tagTxt = o.label ?? PID[id] ?? id, nm = PUMP_NAME[id] || "", side = o.side || "right";
      // tag on a light plate (readable over the tank fill); the descriptive name under it shows when zoomed in
      const bw = 8 + tw(tagTxt);
      const below = side === "below";                    // label under the pump (ground water pumps)
      const tx = below ? x : side === "left" ? x - 14 : x + 14, anchor = below ? "middle" : side === "left" ? "end" : "start";
      const bx = below ? x - bw / 2 : side === "left" ? tx - bw + 4 : tx - 4, ly = below ? y + 44 : y + (o.dy || 0);
      const fins = [-26, -20, -14].map((d) => `<line class="pm-fin" x1="${x - 8}" y1="${y + d}" x2="${x + 8}" y2="${y + d}"/>`).join("");
      return `<g class="eq pump sub" data-eq="${id}" tabindex="0">
        <rect class="pm-noz" x="${x - 5}" y="${y - 50}" width="10" height="6" rx="1"/>
        <rect class="pm-cap" x="${x - 7}" y="${y - 44}" width="14" height="10" rx="2"/>
        <line class="pm-scr" x1="${x - 4}" y1="${y - 42}" x2="${x - 4}" y2="${y - 36}"/><line class="pm-scr" x1="${x}" y1="${y - 42}" x2="${x}" y2="${y - 36}"/><line class="pm-scr" x1="${x + 4}" y1="${y - 42}" x2="${x + 4}" y2="${y - 36}"/>
        <rect class="pm-motor" x="${x - 9}" y="${y - 34}" width="18" height="28" rx="4"/>${fins}
        <rect class="pm-base" x="${x - 11}" y="${y - 6}" width="22" height="6" rx="1.5"/>
        <circle class="pm-led" cx="${x}" cy="${y - 10}" r="2.6"/>
        <rect class="pm-lb" x="${bx}" y="${ly - 30 - T(15)}" width="${bw}" height="${T(20)}" rx="4"/>
        <text class="eq-t" x="${tx}" y="${ly - 30}" text-anchor="${anchor}">${esc(tagTxt)}</text>
        ${nm ? `<text class="eq-n" x="${tx}" y="${ly - 28 + T(12)}" text-anchor="${anchor}">${esc(nm)}</text>` : ""}</g>`
        + ob(x - 11, y - 50, x + 11, y) + ob(bx, ly - 30 - T(15), bx + bw, ly - 30 + T(5));
    },
    ground(x1, x2, y, label = "ground level") {         // ground line with hatching (ground water pumps hang below it)
      let h = "";
      for (let x = x1; x < x2; x += 10) h += `M${x} ${y} l-7 9 `;
      return `<g class="gnd"><line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"/><path d="${h}"/><text x="${x2 - 2}" y="${y - 4}" text-anchor="end">${esc(label)}</text></g>`;
    },
    well(x, y1, y2) { return `<rect class="well" x="${x - 13}" y="${y1}" width="26" height="${y2 - y1}" rx="3"/>`; },
    fan(x, y, id, label) {
      return `<g class="eq fan" data-eq="${id}" tabindex="0"><circle cx="${x}" cy="${y}" r="15"/>
        <g class="spin" style="transform-origin:${x}px ${y}px"><path class="eq-ic" d="M${x} ${y} l0 -11 a5 5 0 0 1 5 5 Z M${x} ${y} l11 0 a5 5 0 0 1 -5 5 Z M${x} ${y} l0 11 a5 5 0 0 1 -5 -5 Z M${x} ${y} l-11 0 a5 5 0 0 1 5 -5 Z"/></g>
        <text class="eq-t" x="${x}" y="${y - 19 - T(3.75)}" text-anchor="middle">${esc(label ?? PID[id] ?? id)}</text></g>` + ob(x - 16, y - 16, x + 16, y + 16);
    },
    mixer(x, y, id, label) {
      return `<g class="eq mixer" data-eq="${id}" tabindex="0"><line x1="${x}" y1="${y - 40}" x2="${x}" y2="${y}" class="shaft"/>
        <g class="spin" style="transform-origin:${x}px ${y}px"><path class="eq-ic" d="M${x - 14} ${y - 4} L${x + 14} ${y + 4} M${x - 14} ${y + 4} L${x + 14} ${y - 4}"/></g>
        <circle cx="${x}" cy="${y - 44}" r="9"/><text class="eq-t" x="${x + 14}" y="${y - 40}">${esc(label ?? PID[id] ?? id)}</text></g>`;
    },
    // on/off valve. v3 (SC05): body colour = position confirmed by the limit switches (green open / grey closed);
    // a commanded position without confirmation = outline only + "cmd"; nothing known = dashed + "?" (v-cue, set live)
    valve(x, y, id, o = {}) {
      const ly = o.below ? y + 10 + T(11.25) : y - 22 - T(3.75);
      return `<g class="eq valve" data-eq="${id}" tabindex="0"><path class="v-body" d="M${x - 11} ${y - 8} L${x + 11} ${y + 8} L${x + 11} ${y - 8} L${x - 11} ${y + 8} Z"/>
        <line x1="${x}" y1="${y}" x2="${x}" y2="${y - 14}" class="stem"/><rect x="${x - 7}" y="${y - 20}" width="14" height="7" rx="1" class="act"/>
        <text class="v-cue" x="${o.below ? x + 11 : x}" y="${o.below ? y - 13 : y + 10 + T(11.25)}" text-anchor="${o.below ? "start" : "middle"}"></text>
        <text class="eq-t" x="${x}" y="${ly}" text-anchor="middle">${esc(o.label ?? PID[id] ?? id)}</text></g>` + ob(x - 12, y - 21, x + 12, y + 9);
    },
    tx(x, y, id, label) {                                 // transmitter bubble, tag no above, live value below
      const bw = T(100), bh = T(24);
      return `<g class="tx" data-tag="${id}" tabindex="0">
        <circle cx="${x}" cy="${y}" r="13"/><text class="tx-i" x="${x}" y="${y + 4}" text-anchor="middle">${esc(label.split("-")[0])}</text>
        <rect class="tx-box" x="${x - bw / 2}" y="${y + 17}" width="${bw}" height="${bh}" rx="5"/>
        <text class="tx-v num" x="${x}" y="${y + 17 + bh / 2 + T(5)}" text-anchor="middle" data-val="${id}">--</text>
        <text class="tx-n" x="${x}" y="${y - 15 - T(3.75)}" text-anchor="middle">${esc(TAG_PID[id] || label)}</text>
        <text class="tx-sp" x="${x}" y="${y + 19 + bh + T(10)}" text-anchor="middle" data-spv="alm:${id}" data-pre="alarm SP "></text></g>`
        + ob(x - bw / 2, y - 14, x + bw / 2, y + 17 + bh);
    },
    // compact live value with its alarm set point underneath (overall sheet)
    chipSP(x, y, id, label, w = 150, o = {}) {        // o.spAbove: alarm SP caption above the chip (top chip of a stacked pair,
      w = Math.max(w, tw(label) + T(92));             // so the chip below never hides it)
      const h = T(26), sy = o.spAbove ? y - h / 2 - T(5) : y + h / 2 + T(11);
      return `<g class="chip sp" data-tag="${id}" tabindex="0"><rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="6"/>
        <text class="ch-l" x="${x - w / 2 + 7}" y="${y + T(5)}">${esc(label)}</text>
        <text class="ch-v num" x="${x + w / 2 - 7}" y="${y + T(5)}" text-anchor="end" data-vals="${id}">--</text>
        <text class="tx-sp" x="${x - w / 2 + 7}" y="${sy}" data-spv="alm:${id}" data-pre="alarm SP "></text></g>` + ob(x - w / 2, y - h / 2, x + w / 2, y + h / 2);
    },
    // set points read from the PLC (entered on the HMI); key: lv:<LT>:<hh|h|l|ll> · aux:<tag> · alm:<tag> (its _ALM_SP)
    spCard(x, y, title, rows) {
      const w = Math.max(tw(title) + T(16), Math.max(...rows.map(([l]) => tw(l, 15, 0.53))) + T(120)), rh = T(20);
      return `<g class="spc"><rect x="${x}" y="${y}" width="${w}" height="${T(30) + rows.length * rh}" rx="6"/>
        <text class="sp-h" x="${x + 8}" y="${y + T(20)}">${esc(title)}</text>
        ${rows.map(([l, k], i) => `<text class="sp-l" x="${x + 8}" y="${y + T(42) + i * rh}">${esc(l)}</text><text class="sp-v num" x="${x + w - 8}" y="${y + T(42) + i * rh}" text-anchor="end" data-spv="${k}">--</text>`).join("")}</g>`
        + ob(x, y, x + w, y + T(30) + rows.length * rh);
    },
    box(x, y, w, h, text, kind = "") {
      const lines = String(text).split("\n"), lh = T(18);
      return `<g class="dest ${kind}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>${lines.map((l, i) =>
        `<text x="${x + w / 2}" y="${y + h / 2 + T(5) + (i - (lines.length - 1) / 2) * lh}" text-anchor="middle">${esc(l)}</text>`).join("")}</g>` + ob(x, y, x + w, y + h);
    },
    // induced-draft cooling tower (footprint x..x+120, y-24..y+144): fan stack on top (fan drawn at x+60, y-11),
    // drift eliminator, spray, fill pack, air-inlet louvers and the cold-water basin at the bottom
    tower(x, y, label, sub, dx = 0) {                 // dx: name moved sideways (clear of a pipe)
      let fill = "", louv = "", spray = "";
      for (let i = 0; i < 10; i++) fill += `M${x + 12 + i * 10} ${y + 44} l10 34 M${x + 22 + i * 10} ${y + 44} l-10 34 `;
      for (let i = 0; i < 4; i++) louv += `M${x + 4 - i * 1.2} ${y + 88 + i * 8} L${x + 116 + i * 1.2} ${y + 88 + i * 8} `;
      for (let i = 0; i < 9; i++) spray += `M${x + 18 + i * 11} ${y + 28} l-2 8 M${x + 18 + i * 11} ${y + 28} l2 8 `;
      return `<g class="tower">
        <path class="ct-stack" d="M${x + 32} ${y - 24} L${x + 88} ${y - 24} L${x + 84} ${y - 2} L${x + 36} ${y - 2} Z"/>
        <line class="ct-ring" x1="${x + 33}" y1="${y - 17}" x2="${x + 87}" y2="${y - 17}"/>
        <rect class="ct-deck" x="${x}" y="${y - 3}" width="120" height="6" rx="1.5"/>
        <path class="ct-body" d="M${x + 4} ${y + 3} L${x + 116} ${y + 3} L${x + 120} ${y + 118} L${x} ${y + 118} Z"/>
        <rect class="ct-drift" x="${x + 10}" y="${y + 10}" width="100" height="9" rx="1"/>
        <path class="ct-hdr" d="M${x + 12} ${y + 26} L${x + 108} ${y + 26}"/><path class="ct-spray" d="${spray}"/>
        <rect class="ct-fillbg" x="${x + 10}" y="${y + 44}" width="100" height="34"/><path class="ct-fill" d="${fill}"/>
        <rect class="ct-inlet" x="${x + 2}" y="${y + 84}" width="116" height="34"/><path class="ct-louv" d="${louv}"/>
        <rect class="ct-basin" x="${x - 6}" y="${y + 116}" width="132" height="28" rx="3"/>
        <rect class="ct-water" x="${x - 3}" y="${y + 122}" width="126" height="19" rx="2"/>
        <path class="ct-wave" d="M${x} ${y + 125} q8 -3 16 0 t16 0 t16 0 t16 0 t16 0 t16 0 t16 0 t16 0"/>
        <text class="t-lbl" x="${x + 60 + dx}" y="${y + 150 + T(12)}" text-anchor="middle">${esc(label)}</text>
        ${sub ? `<text class="note lod" x="${x + 60 + dx}" y="${y + 150 + T(27)}" text-anchor="middle">${esc(sub)}</text>` : ""}</g>` + ob(x - 6, y - 24, x + 126, y + 144);
    },
    hx(x, y, label) {
      return `<g class="hx"><rect x="${x}" y="${y}" width="44" height="90" rx="5"/><path d="M${x + 8} ${y + 14} L${x + 36} ${y + 14} M${x + 8} ${y + 32} L${x + 36} ${y + 32} M${x + 8} ${y + 50} L${x + 36} ${y + 50} M${x + 8} ${y + 68} L${x + 36} ${y + 68}"/>
        <text class="t-lbl" x="${x + 22}" y="${y + 108}" text-anchor="middle">${esc(label)}</text></g>`;
    },
    // free text; anchor "end" / "middle" optional; registered so flow chevrons keep off it
    text(x, y, s, cls = "note", anchor = "start") {
      const w = tw(s, 15, cls.includes("note") ? 0.53 : 0.6), x1 = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
      return `<text class="${cls}" x="${x}" y="${y}"${anchor !== "start" ? ` text-anchor="${anchor}"` : ""}>${esc(s)}</text>` + ob(x1, y - T(12), x1 + w, y + T(4));
    },
    chip(x, y, ids, label, w = 150) {                   // compact live readout (one or two values), click for the trend
      w = Math.max(w, tw(label) + T(92));
      const h = T(26);
      return `<g class="chip" data-tag="${ids[0]}" tabindex="0"><rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="6"/>
        <text class="ch-l" x="${x - w / 2 + 7}" y="${y + T(5)}">${esc(label)}</text>
        <text class="ch-v num" x="${x + w / 2 - 7}" y="${y + T(5)}" text-anchor="end" data-vals="${ids.join(",")}">--</text></g>` + ob(x - w / 2, y - h / 2, x + w / 2, y + h / 2);
    },

    // ---------- P&ID detail symbols (area sheets follow the client P&ID R1, 12-12-2025) ----------
    // package equipment (Norsen / PAR scope) is not wired to this panel: it is drawn with data-run, i.e. shown
    // for reference only: never animated (no running state is guessed - user request 2026-11-04)
    head(id, cls, run, why) {
      if (id) return `class="eq ${cls}" data-eq="${id}" tabindex="0"`;
      return `class="pk ${cls}" data-run="${(run || []).join(",")}" data-why="${esc(why || "")}"`;
    },
    hv(x, y, vert = false) {                          // manual valve (bow-tie) sitting on the pipe
      const d = vert ? `M${x - 6} ${y - 7} L${x + 6} ${y - 7} L${x - 6} ${y + 7} L${x + 6} ${y + 7} Z`
        : `M${x - 7} ${y - 6} L${x - 7} ${y + 6} L${x + 7} ${y - 6} L${x + 7} ${y + 6} Z`;
      return `<path class="hv" d="${d}"><title>Manual valve</title></path>` + ob(x - 8, y - 8, x + 8, y + 8);
    },
    nrv(x, y, dir = "r") {                            // non-return valve, triangle points the flow direction
      const rot = { r: 0, d: 90, l: 180, u: 270 }[dir] || 0;
      return `<g class="nrv" transform="rotate(${rot} ${x} ${y})"><path d="M${x - 7} ${y - 6} L${x + 4} ${y} L${x - 7} ${y + 6} Z"/>
        <line x1="${x + 5}" y1="${y - 7}" x2="${x + 5}" y2="${y + 7}"/><title>Non-return valve</title></g>` + ob(x - 8, y - 8, x + 8, y + 8);
    },
    strn(x, y) {                                       // Y-strainer
      return `<g class="strn"><path d="M${x - 8} ${y - 5} L${x + 8} ${y - 5} L${x + 8} ${y + 5} L${x - 8} ${y + 5} Z M${x - 2} ${y + 5} L${x + 5} ${y + 14} L${x + 9} ${y + 11} L${x + 4} ${y + 5}"/><title>Strainer</title></g>` + ob(x - 9, y - 6, x + 10, y + 15);
    },
    gauge(x, y, tagNo, kind = "PG", down = false) {  // local gauge (PG / TG / PI) - read on site, no PLC signal
      const sy = down ? y - 10 : y + 10, ey = down ? y - 24 : y + 24;
      return `<g class="gauge"><line x1="${x}" y1="${sy}" x2="${x}" y2="${ey}"/><circle cx="${x}" cy="${y}" r="10"/>
        <path class="g-nd" d="M${x} ${y} L${x + 5} ${y - 5}"/><text class="g-k" x="${x}" y="${y + 7}" text-anchor="middle">${kind}</text>
        <text class="g-n" x="${x}" y="${down ? y + 22 : y - 14}" text-anchor="middle">${esc(tagNo)}</text>
        <title>${tagNo ? `${esc(tagNo)} - ` : ""}local ${kind === "TG" ? "temperature" : "pressure"} gauge, read on site (no signal to the panel)</title></g>`
        + ob(x - 11, Math.min(y - 11, sy, ey), x + 11, Math.max(y + 11, sy, ey));
    },
    pkInst(x, y, kind, label) {                       // package instrument bubble (FT, LT, LS) without a signal here
      return `<g class="gauge pki"><circle cx="${x}" cy="${y}" r="12"/><text class="g-k" x="${x}" y="${y + 3.5}" text-anchor="middle">${kind}</text>
        ${label ? `<text class="g-n" x="${x}" y="${y - 16}" text-anchor="middle">${esc(label)}</text>` : ""}<title>${esc(kind)} - package instrument, not wired to this panel</title></g>` + ob(x - 13, y - 13, x + 13, y + 13);
    },
    // top-mounted agitator standing on a tank roof at (x, y): motor, gearbox, shaft, propeller at y + depth.
    // The two blade pairs squash in turn, which reads as a propeller turning when seen from the side.
    agit(x, y, depth, o = {}) {
      const py = y + depth, bl = (cls) => `<g class="prop ${cls}" style="transform-origin:${x}px ${py}px"><path class="ag-bl" d="M${x} ${py} C${x + 6} ${py - 8} ${x + 19} ${py - 7} ${x + 21} ${py} C${x + 19} ${py + 7} ${x + 6} ${py + 8} ${x} ${py} Z M${x} ${py} C${x - 6} ${py - 8} ${x - 19} ${py - 7} ${x - 21} ${py} C${x - 19} ${py + 7} ${x - 6} ${py + 8} ${x} ${py} Z"/></g>`;
      return `<g ${P.head(o.id, "agit", o.run, o.why)}>
        <rect class="ag-mot" x="${x - 11}" y="${y - 48}" width="22" height="27" rx="4"/>
        <line class="ag-fin" x1="${x - 8}" y1="${y - 40}" x2="${x + 8}" y2="${y - 40}"/><line class="ag-fin" x1="${x - 8}" y1="${y - 34}" x2="${x + 8}" y2="${y - 34}"/><line class="ag-fin" x1="${x - 8}" y1="${y - 28}" x2="${x + 8}" y2="${y - 28}"/>
        <rect class="ag-gb" x="${x - 8}" y="${y - 21}" width="16" height="13" rx="2"/><rect class="ag-fl" x="${x - 15}" y="${y - 8}" width="30" height="6" rx="1"/>
        <line class="shaft" x1="${x}" y1="${y - 2}" x2="${x}" y2="${py}"/>${bl("p1")}${bl("p2")}<circle class="ag-hub" cx="${x}" cy="${py}" r="3.5"/>
        ${o.label ? `<text class="eq-t" x="${x + 16}" y="${y - 32}">${esc(o.label)}</text>` : ""}${o.sub ? `<text class="eq-n" x="${x + 16}" y="${y - 30 + T(13)}">${esc(o.sub)}</text>` : ""}
        ${o.id ? "" : `<title>${esc(o.why || "")}</title>`}</g>` + ob(x - 15, y - 48, x + 15, y);
    },
    // side-entry propeller mixer through the right-hand tank wall at (x, y) (P&ID sheet 1: F1 / OP-A1)
    sideMix(x, y, o = {}) {
      const px = x - 46, bl = (cls) => `<g class="prop v ${cls}" style="transform-origin:${px}px ${y}px"><path class="ag-bl" d="M${px} ${y} C${px - 8} ${y - 6} ${px - 7} ${y - 19} ${px} ${y - 21} C${px + 7} ${y - 19} ${px + 8} ${y - 6} ${px} ${y} Z M${px} ${y} C${px - 8} ${y + 6} ${px - 7} ${y + 19} ${px} ${y + 21} C${px + 7} ${y + 19} ${px + 8} ${y + 6} ${px} ${y} Z"/></g>`;
      return `<g ${P.head(o.id, "agit side", o.run, o.why)}>
        <line class="shaft" x1="${px}" y1="${y}" x2="${x + 4}" y2="${y}"/>${bl("p1")}${bl("p2")}<circle class="ag-hub" cx="${px}" cy="${y}" r="3.5"/>
        <rect class="ag-fl" x="${x + 2}" y="${y - 14}" width="6" height="28" rx="1"/><rect class="ag-gb" x="${x + 8}" y="${y - 8}" width="12" height="16" rx="2"/>
        <rect class="ag-mot" x="${x + 20}" y="${y - 11}" width="30" height="22" rx="4"/>
        <line class="ag-fin" x1="${x + 27}" y1="${y - 8}" x2="${x + 27}" y2="${y + 8}"/><line class="ag-fin" x1="${x + 34}" y1="${y - 8}" x2="${x + 34}" y2="${y + 8}"/><line class="ag-fin" x1="${x + 41}" y1="${y - 8}" x2="${x + 41}" y2="${y + 8}"/>
        <circle class="pm-led" cx="${x + 35}" cy="${y - 17}" r="3"/>
        ${o.below ? `${o.label ? `<text class="eq-t" x="${x + 10}" y="${y + 14 + T(11.25)}" text-anchor="start">${esc(o.label)}</text>` : ""}${o.sub ? `<text class="eq-n" x="${x + 35}" y="${y + 16 + T(11.25) + T(13)}" text-anchor="middle">${esc(o.sub)}</text>` : ""}`
          : `${o.label ? `<text class="eq-t" x="${x + 56}" y="${y + T(4)}">${esc(o.label)}</text>` : ""}${o.sub ? `<text class="eq-n" x="${x + 56}" y="${y + T(6) + T(12)}">${esc(o.sub)}</text>` : ""}`}</g>` + ob(x + 2, y - 21, x + 50, y + 14);
    },
    // screw conveyor / screw press drum (volute press): trough x..x+w on centre line y, drive on the right,
    // feed hopper top-right, cake drops out at the left end; the flights travel towards the cake end while running
    screw(x, y, w, o = {}) {
      let fl = "";
      for (let i = -24; i < w + 24; i += 12) fl += `M${x + i} ${y - 10} L${x + i + 8} ${y + 10} `;
      const cid = `sc${x}_${y}`;
      return `<g ${P.head(o.id, "sc", o.run, o.why)}>
        <clipPath id="${cid}"><rect x="${x + 2}" y="${y - 10}" width="${w - 4}" height="20" rx="3"/></clipPath>
        <path class="sc-hop" d="M${x + w - 40} ${y - 30} L${x + w - 8} ${y - 30} L${x + w - 16} ${y - 12} L${x + w - 32} ${y - 12} Z"/>
        <rect class="sc-tr" x="${x}" y="${y - 12}" width="${w}" height="24" rx="5"/>
        <g clip-path="url(#${cid})"><line class="sc-sh" x1="${x}" y1="${y}" x2="${x + w}" y2="${y}"/><path class="flights" d="${fl}"/></g>
        <path class="sc-out" d="M${x + 4} ${y + 12} L${x + 24} ${y + 12} L${x + 20} ${y + 22} L${x + 8} ${y + 22} Z"/>
        <rect class="ag-gb" x="${x + w}" y="${y - 8}" width="12" height="16" rx="2"/><rect class="ag-mot" x="${x + w + 12}" y="${y - 11}" width="30" height="22" rx="4"/>
        <circle class="pm-led" cx="${x + w + 27}" cy="${y - 17}" r="3"/>
        ${o.spray ? `<g class="spray"><path d="M${x + o.spray - 10} ${y - 22} l-4 8 M${x + o.spray} ${y - 22} l0 8 M${x + o.spray + 10} ${y - 22} l4 8"/></g><rect class="sc-noz" x="${x + o.spray - 12}" y="${y - 27}" width="24" height="5" rx="2"/>` : ""}
        <text class="eq-t" x="${o.labelAt ? o.labelAt[0] : x + w / 2 - 10}" y="${o.labelAt ? o.labelAt[1] : y + 14 + T(11.25)}" text-anchor="${o.labelAt ? o.labelAt[2] : "middle"}">${esc(o.label || "")}</text>
        <text class="eq-n" x="${x + w + 27}" y="${y + 13 + T(9)}" text-anchor="middle">${esc(o.drive ?? "VFD F/R")}</text>
        ${o.id ? "" : `<title>${esc(o.why || "")}</title>`}</g>` + ob(x, y - 30, x + w + 42, y + 22);
    },
    // progressive cavity pump on centre line y: discharge flange at the left end (x - 66), suction housing
    // with the inlet port on top at x + 42, drive on the right; the rotor wave travels while running
    pcp(x, y, id, o = {}) {
      let rw = `M${x - 84} ${y}`;
      for (let i = 0; i < 9; i++) rw += ` q6 -7 12 0 q6 7 12 0`;
      const cid = `pc${x}_${y}`;
      return `<g ${P.head(id, "pump pcp", o.run, o.why)}>
        <clipPath id="${cid}"><rect x="${x - 58}" y="${y - 8}" width="86" height="16"/></clipPath>
        <rect class="pm-base" x="${x - 66}" y="${y + 13}" width="170" height="5" rx="1"/>
        <rect class="pm-noz" x="${x - 68}" y="${y - 11}" width="8" height="22" rx="1"/>
        <rect class="pc-st" x="${x - 60}" y="${y - 10}" width="90" height="20" rx="4"/>
        <g clip-path="url(#${cid})"><path class="rotor" d="${rw}"/></g>
        <rect class="pc-hs" x="${x + 30}" y="${y - 13}" width="26" height="26" rx="3"/><rect class="pm-noz" x="${x + 36}" y="${y - 22}" width="14" height="9" rx="1"/>
        <rect class="ag-gb" x="${x + 56}" y="${y - 8}" width="12" height="16" rx="2"/>
        <rect class="pm-motor" x="${x + 68}" y="${y - 11}" width="34" height="22" rx="4"/>
        <circle class="pm-led" cx="${x + 85}" cy="${y - 17}" r="3.2"/>
        <text class="eq-t" x="${x + 10}" y="${y + 20 + T(11.25)}" text-anchor="middle">${esc(o.label ?? PID[id] ?? "")}</text>
        <text class="eq-n" x="${x + 10}" y="${y + 22 + T(11.25) + T(13)}" text-anchor="middle">Progressive cavity pump</text></g>` + ob(x - 68, y - 22, x + 104, y + 18);
    },
    // centrifugal exhaust blower at (x, y): motor on the left, scroll casing, discharge on top (to the vent duct)
    blower(x, y, id, o = {}) {
      return `<g ${P.head(id, "pump blower")}>
        <rect class="pm-base" x="${x - 52}" y="${y + 24}" width="90" height="6" rx="1"/>
        <rect class="pm-motor" x="${x - 50}" y="${y - 11}" width="28" height="22" rx="4"/><rect class="pm-cpl" x="${x - 22}" y="${y - 3}" width="6" height="6"/>
        <path class="bw-cs" d="M${x} ${y - 24} L${x + 30} ${y - 24} L${x + 30} ${y - 14} A24 24 0 1 1 ${x} ${y - 24} Z"/>
        <circle class="pm-vol" cx="${x}" cy="${y}" r="14"/>
        <g class="spin" style="transform-origin:${x}px ${y}px"><path class="pm-imp" d="M${x} ${y} l9 -5 M${x} ${y} l0 10 M${x} ${y} l-9 -5 M${x} ${y} l9 5 M${x} ${y} l-9 5 M${x} ${y} l0 -10"/></g>
        <circle class="pm-led" cx="${x - 36}" cy="${y - 17}" r="3.2"/>
        <text class="eq-t" x="${x - 8}" y="${y + 32 + T(11.25)}" text-anchor="middle">${esc(o.label ?? PID[id] ?? id)}</text>
        ${o.sub ? `<text class="eq-n" x="${x - 8}" y="${y + 34 + T(11.25) + T(13)}" text-anchor="middle">${esc(o.sub)}</text>` : ""}</g>` + ob(x - 52, y - 24, x + 30, y + 30);
    },
    // package pump (no panel signal): same picture as P.pump, state follows the listed panel motors
    pkPump(x, y, label, run, why, o = {}) {
      const s = P.pump(x, y, "", { ...o, label }).replace(/class="eq pump" data-eq="" tabindex="0"/, `class="eq pump pk" data-run="${(run || []).join(",")}"`);
      return `${s.slice(0, -4)}<title>${esc(why || "")}</title></g>`;
    },
    // plate heat exchanger: frame, plate pack, two connections each side
    phe(x, y, w, h, label, sub) {
      let pl = "";
      for (let i = 10; i < w - 8; i += 5) pl += `M${x + i} ${y + 8} L${x + i} ${y + h - 8} `;
      return `<g class="phe"><rect class="ph-fr" x="${x}" y="${y}" width="${w}" height="${h}" rx="3"/><path class="ph-pl" d="${pl}"/>
        <rect class="ph-end" x="${x}" y="${y}" width="8" height="${h}" rx="2"/><rect class="ph-end" x="${x + w - 8}" y="${y}" width="8" height="${h}" rx="2"/>
        <text class="t-lbl" x="${x + w / 2}" y="${y + h + 4 + T(12)}" text-anchor="middle">${esc(label)}</text>
        ${sub ? `<text class="note" x="${x + w / 2}" y="${y + h + 6 + T(12) + T(15)}" text-anchor="middle">${esc(sub)}</text>` : ""}</g>` + ob(x, y, x + w, y + h);
    },
    // radiator: finned core with its cooling fan
    radiator(x, y, run, why) {
      let fin = "";
      for (let i = 6; i < 90; i += 6) fin += `M${x + i} ${y + 4} L${x + i} ${y + 56} `;
      return `<g class="pk rad" data-run="${(run || []).join(",")}"><rect class="rd-core" x="${x}" y="${y}" width="96" height="60" rx="3"/><path class="rd-fin" d="${fin}"/>
        <circle class="rd-ring" cx="${x + 48}" cy="${y + 30}" r="22"/>
        <g class="spin" style="transform-origin:${x + 48}px ${y + 30}px"><path class="rd-fan" d="M${x + 48} ${y + 30} l0 -18 a7 7 0 0 1 7 7 Z M${x + 48} ${y + 30} l18 0 a7 7 0 0 1 -7 7 Z M${x + 48} ${y + 30} l0 18 a7 7 0 0 1 -7 -7 Z M${x + 48} ${y + 30} l-18 0 a7 7 0 0 1 7 -7 Z"/></g>
        <text class="t-lbl" x="${x + 48}" y="${y + 64 + T(12)}" text-anchor="middle">Radiator</text><title>${esc(why || "")}</title></g>` + ob(x, y, x + 96, y + 60);
    },
    // static vessel for package tanks (no level signal): fill shown as an indicative working level
    vessel(x, y, w, h, o = {}) {
      const cid = `vs${x}_${y}`, fh = h * (o.fill ?? 0.6);
      return `<g class="vs"><clipPath id="${cid}"><rect x="${x + 3}" y="${y + 3}" width="${w - 6}" height="${h - 6}" rx="3"/></clipPath>
        <rect class="t-body" x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.r ?? 5}"/>
        <rect class="t-fill vs-fill ${o.fluid || "water"}" clip-path="url(#${cid})" x="${x}" y="${y + h - fh}" width="${w}" height="${fh}"/>
        ${(o.parts || []).map((px) => `<line class="vs-part" x1="${px}" y1="${y}" x2="${px}" y2="${y + h}"/>`).join("")}
        ${o.label ? `<text class="t-lbl" x="${o.labelX ?? x + w / 2}" y="${y + h + (o.labelDy ?? T(18))}" text-anchor="${o.labelAnchor || "middle"}">${esc(o.label)}</text>` : ""}
        ${o.sub ? `<text class="note lod" x="${o.labelX ?? x + w / 2}" y="${y + h + (o.labelDy ?? T(18)) + T(4) + T(9) + 2}" text-anchor="${o.labelAnchor || "middle"}">${esc(o.sub)}</text>` : ""}</g>` + ob(x, y, x + w, y + h);
    },
    // chemical powder tank with cone bottom (vibrator + timer on the cone)
    hopperTank(x, y, w, label) {
      return `<g class="vs"><path class="t-body" d="M${x} ${y} L${x + w} ${y} L${x + w} ${y + 46} L${x + w / 2 + 8} ${y + 78} L${x + w / 2 - 8} ${y + 78} L${x} ${y + 46} Z"/>
        <path class="vs-pow" d="M${x + 4} ${y + 22} L${x + w - 4} ${y + 22} L${x + w - 4} ${y + 46} L${x + w / 2 + 7} ${y + 75} L${x + w / 2 - 7} ${y + 75} L${x + 4} ${y + 46} Z"/>
        <text class="t-lbl" x="${x + w + 8}" y="${y + T(14)}">${esc(label)}</text></g>` + ob(x, y, x + w, y + 78);
    },
    // pressure / gravity filter vessel (sand, carbon) with the multiport auto valve on top
    filterV(x, y, label) {
      return `<g class="fv"><rect class="fv-av" x="${x + 22}" y="${y - 16}" width="26" height="14" rx="2"/><text class="note lod" x="${x + 35}" y="${y - 20}" text-anchor="middle">auto valve</text>
        <path class="fv-body" d="M${x} ${y + 26} Q${x} ${y} ${x + 35} ${y} Q${x + 70} ${y} ${x + 70} ${y + 26} L${x + 70} ${y + 150} L${x} ${y + 150} Z"/>
        <path class="fv-st" d="M${x + 4} ${y + 70} L${x + 66} ${y + 44} M${x + 4} ${y + 110} L${x + 66} ${y + 84} M${x + 4} ${y + 146} L${x + 66} ${y + 124}"/>
        <path class="fv-leg" d="M${x + 6} ${y + 150} Q${x + 35} ${y + 132} ${x + 64} ${y + 150} L${x + 70} ${y + 162} L${x + 52} ${y + 162} Q${x + 35} ${y + 150} ${x + 18} ${y + 162} L${x} ${y + 162} Z"/>
        <text class="t-lbl" x="${x + 35}" y="${y + 166 + T(12)}" text-anchor="middle">${esc(label)}</text></g>` + ob(x, y - 16, x + 70, y + 162);
    },
    // link box to another sheet (click to open it)
    link(x, y, w, h, text, goto, kind = "") {
      const lines = String(text).split("\n"), lh = T(18);
      return `<g class="dest link ${kind}" data-goto="${goto}" tabindex="0"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>${lines.map((l, i) =>
        `<text x="${x + w / 2 - 6}" y="${y + h / 2 + T(5) + (i - (lines.length - 1) / 2) * lh}" text-anchor="middle">${esc(l)}</text>`).join("")}
        <text class="lk-go" x="${x + w - 9}" y="${y + h / 2 + T(6)}" text-anchor="middle">›</text><title>Open this sheet</title></g>` + ob(x, y, x + w, y + h);
    },
  };
  const LS = (id, at, label) => ({ id: SW[id], at, label });

  // small label with a light background, placed on a connection line
  function CL(x, y, text, anchor = "start") {
    const w = T(12) + tw(text), h = T(20), rx = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
    return `<g class="cl"><rect x="${rx}" y="${y - h / 2 - T(1)}" width="${w}" height="${h}" rx="${h / 2}"/><text x="${rx + w / 2}" y="${y + T(4)}" text-anchor="middle">${esc(text)}</text></g>` + ob(rx, y - h / 2, rx + w, y + h / 2);
  }

  const SHEETS = {
    // 3D view of the whole plant (js/plant3d.js, canvas): same live states, positions indicative (not to scale)
    d3: {
      name: "3D plant - whole plant (indicative layout)",
      note: "Drag to rotate · wheel to zoom · right-drag to move · click a machine for details · pulsing green ring = running (shaft / fan turning), red ring = tripped, no ring = stopped · moving lights in a pipe = flowing · package equipment is shown faded and not animated",
      d3: true,
      draw: () => [],
    },
    overall: {
      name: "Overall plant - complete process (P&ID R1)",
      note: "Whole plant on one drawing, following the client P&ID: 1 water supply & cooling towers · 2 sludge & volute press · 3 hot water & dryer · 4 de-gasifier & water recovery. Click a machine, value or box for details; the tabs above show each area larger.",
      vb: [1600, 1450], fs: 1.2,                       // 1600 units ≈ 1000-1200 px at fit: labels × 1.2 (11-13 px) - smaller text leaves more open space (16-11-2026); zoom for more
      draw: () => {
        const ug = ["OP_P6A", "OP_P6B"], sup = ["OP_P14", "OP_P15"], vp = ["OP_P1A", "OP_P1B", "PCP"], ct1 = ["OP_P7", "OP_P3", "OP_P11"];
        const why = "Volute press package (Norsen scope) - not wired to this panel. Shown for reference only - not animated (no signal).";
        // v3 (SC04): re-spaced for labels at 15 × 1.3 units; sections 3 and 4 are drawn 70 units lower (shiftY) to make room
        const D34 = 70;
        return [
          `<text class="band" x="1590" y="18" text-anchor="end">1 · WATER SUPPLY &amp; COOLING TOWERS</text><text class="band" x="1590" y="306" text-anchor="end">2 · SLUDGE &amp; VOLUTE PRESS</text>`,
          // ===== 1 water supply: ground water pumps -> NRV -> raw water tank (branch to the wash room after the NRV) -> supply pumps (VFD)
          // -> header -> towers, volute press, hot water tank. Both ground water pumps join one riser, so every stretch flows one way.
          P.pipe("M102 110 L124 110 M102 190 L124 190 L124 90 L168 90", "water", ug, { need: [`sw:${SW.FLOW}`] }),
          P.pipe("M156 90 L156 294 L168 294", "water", ug, { need: [`sw:${SW.FLOW}`] }), P.box(170, 278, 132, 32, "Wash room"),
          P.pipe("M208 20 L250 20 L250 68", "ctp"), P.link(8, 4, 200, 32, "From CTP plant", "wtp"),
          P.hv(112, 110), P.hv(112, 190), P.nrv(140, 90, "r"), P.lamp(98, 68, SW.FLOW, "FS"),
          P.pump(74, 110, "OP_P6A", { name: false }), P.pump(74, 190, "OP_P6B", { name: false }),
          P.tank(170, 70, 170, 150, { fluid: "water", label: "Raw water tank", sub: "03-LS-301", sw: [LS("LS301_HL", 0.15, "HL"), LS("LS301_LL", 0.7, "LL")] }),
          P.pipe("M340 190 L442 190", "water", ["OP_P15"]), P.pipe("M410 190 L410 110 L442 110", "water", ["OP_P14"]),
          P.hv(430, 110), P.hv(430, 190),
          P.pipe("M498 110 L530 110 L530 150", "water", ["OP_P14"]), P.pipe("M498 190 L530 190 L530 150", "water", ["OP_P15"]),
          P.pipe("M530 150 L548 150 L548 40 L1590 40", "water", sup), P.nrv(514, 110), P.nrv(514, 190),
          P.gauge(575, 66, "PG-301", "PG", true),
          P.pump(470, 110, "OP_P14"), P.pump(470, 190, "OP_P15"),
          P.chipSP(485, 262, "PT_01", "PT-301", 190),
          P.text(640, 35, "header also feeds: boiler DM make-up · wet scraper · vacuum pump & KO drum (PAR)", "note lod"),
          // cooling tower 1 -> 3 pumps (make-up from the header; switch lamps on the free side of the tower)
          P.pipe("M615 40 L615 210 L622 210", "water", sup), P.hv(615, 185, true),
          P.tower(630, 80, "Cooling tower-1", "06-LS-601", 12), P.fan(690, 69, "OP_F1", ""), P.text(724, 64, "06-F-601", "fan-l"),
          P.lamp(544, 150, SW.LS601_HL, "HL"), P.lamp(544, 180, SW.LS601_LL, "LL"),
          P.pipe("M756 210 L800 210 M800 210 L800 100 L822 100 M800 210 L800 230 L822 230 M800 165 L822 165", "water", ct1),
          P.pipe("M878 100 L905 100", "water", ["OP_P7"]), P.pipe("M878 165 L905 165", "water", ["OP_P3"]), P.pipe("M878 230 L905 230", "water", ["OP_P11"]),
          P.pump(850, 100, "OP_P7", { name: false }), P.pump(850, 165, "OP_P3", { name: false }), P.pump(850, 230, "OP_P11", { name: false }),
          P.text(912, 108, "→ PHE-1", "dtxt"), P.text(912, 173, "→ Dryer condenser", "dtxt"), P.text(912, 238, "→ Boiler cooling", "dtxt"),
          // cooling tower 2 -> turbine oil PHE
          P.pipe("M1115 40 L1115 210 L1122 210", "water", sup), P.hv(1115, 185, true),
          P.tower(1130, 80, "Cooling tower-2", "06-LS-602"), P.fan(1190, 69, "OP_F2", ""), P.text(1224, 64, "06-F-602", "fan-l"),
          P.lamp(1262, 150, SW.LS602_HL, "HL"), P.lamp(1262, 180, SW.LS602_LL, "LL"),
          P.pipe("M1256 210 L1330 210 L1330 160 L1352 160", "water", ["OP_P10"]), P.pipe("M1408 160 L1430 160", "water", ["OP_P10"]),
          P.pipe("M1500 160 L1530 160 L1530 100 L1252 100", "water", ["OP_P10"]),
          P.phe(1430, 135, 70, 50, "Turbine oil PHE"), P.pump(1380, 160, "OP_P10", { name: false, below: false }),
          // ===== 2 sludge storage -> volute press (flocculation, PC pump, screws) -> cake hopper; filtrate -> filtrate tank
          P.box(6, 318, 168, 34, "Raw sludge in"), P.pipe("M60 352 L60 425 L146 425", "sludge", ["MV_01"]),
          P.valve(88, 425, "MV_01", { label: "01-MV-101", below: true }), P.lamp(6, 612, SW.AIR, "AIR"), P.text(66, 618, "inst. air"),
          `<g class="scr"><rect class="t-body" x="146" y="395" width="50" height="62" rx="3"/><path class="scr-c" d="M154 400 L168 452"/><path class="scr-f" d="M174 400 L188 452"/>
            <text class="note" x="171" y="482" text-anchor="middle">screens</text></g>` + ob(146, 395, 196, 486),
          P.pipe("M196 425 L228 425", "sludge", ["MV_01"]),
          P.pipe("M256 534 L256 330 L276 330 M296 534 L296 330 L276 330 M276 330 L276 312 L1100 312 L1100 398", "sludge", ["OP_P1A", "OP_P1B"]),
          // the mixer OP-A1 is mounted near the tank bottom -> level lamps sit higher on that side
          P.tank(230, 360, 260, 230, { level: "LT_01", fluid: "sludge", label: "Sludge storage tank", sub: "01-LT-101", lvAt: [0.08, 0.26, 0.48, 0.66] }),
          P.hv(256, 346, true), P.hv(296, 346, true), P.gauge(360, 292, "01-PG-101"),
          P.subPump(256, 584, "OP_P1A", { side: "left" }), P.subPump(296, 584, "OP_P1B"),
          P.sideMix(490, 560, { id: "AGIT", label: "OP-A1" }),
          P.pipe("M600 40 L600 450 L618 450", "water", sup), P.pipe("M600 450 L600 606 L700 606 L700 612 M600 606 L930 606 L930 612", "water", sup),
          P.hopperTank(540, 326, 56, "Chemical tank"), P.pipe("M568 404 L568 432 L618 432", "chem"),
          P.pipe("M660 490 L660 520 M740 490 L740 520 M820 490 L820 520 M660 520 L908 520", "chem"),
          P.pipe("M964 520 L1020 520 L1020 512", "chem"),
          // dilution tank name below its outlet header, clear of the outlets (image78)
          P.vessel(620, 400, 240, 90, { fluid: "chem", parts: [700, 780], label: "Chemical dilution tank", labelX: 740, labelDy: 59, fill: 0.6 }),
          P.agit(660, 400, 62, { run: vp, why }), P.agit(740, 400, 62, { run: vp, why }), P.agit(820, 400, 62, { run: vp, why }),
          P.pkPump(936, 520, "Dosing pump", vp, why, { below: false }),
          P.pipe("M1160 440 L1178 440", "sludge"),
          P.vessel(1000, 400, 160, 110, { fluid: "sludge", label: "Flocculation tank", labelX: 1090, labelDy: T(24), fill: 0.7 }),
          P.agit(1060, 400, 75, { run: vp, why }),
          P.vessel(1180, 420, 80, 70, { fluid: "sludge", label: "Collecting tank", labelX: 1268, labelAnchor: "start", labelDy: -35, fill: 0.55 }),
          P.pipe("M1220 490 L1220 627", "sludge", ["PCP"]),
          P.pipe("M1109 650 L1095 650 L1095 597 L786 597 L786 609 M1016 597 L1016 609", "sludge", ["PCP"]),
          P.pcp(1177, 650, "PCP", { label: "OP-P201" }),
          // filtrate from the screws (package) back to the filtrate tank: no IO signal on this line -> not animated
          P.pipe(`M1030 652 L1030 680 L545 680 L545 ${1008 + D34} M800 652 L800 680`, "water"), CL(539, 880, "filtrate", "end"),
          P.pipe("M644 662 L644 686 M874 662 L874 700 L696 700", "sludge"),
          P.screw(630, 640, 180, { run: vp, why, label: "Screw-1", spray: 70, drive: "" }), P.screw(860, 640, 180, { run: vp, why, label: "Screw-2", spray: 70, drive: "" }),
          `<g class="vs"><path class="t-body" d="M580 688 L700 688 L680 718 L600 718 Z"/><path class="t-fill sludge" d="M588 700 L692 700 L678 716 L602 716 Z"/>
            <text class="t-lbl" x="640" y="${718 + T(18)}" text-anchor="middle">Cake hopper</text></g>` + ob(580, 688, 700, 718),
          shiftY(D34, () => [
          `<text class="band" x="1590" y="690" text-anchor="end">3 · HOT WATER LOOP &amp; DRYER</text><text class="band" x="1590" y="944" text-anchor="end">4 · DE-GASIFIER &amp; RECOVERY</text>`,
          // ===== 3 hot water loop: tank -> 06-P-605 -> dryer -> radiator -> surface condenser -> tank
          P.box(430, 700, 100, 28, "Boiler"), P.box(430, 734, 100, 28, "Turbine"),
          P.pipe("M530 714 L560 714 L560 730 L598 730 M530 748 L560 748 L560 730", "steam"),
          P.box(600, 704, 126, 56, "Surface\ncondenser", "dest-proc"),
          P.pipe("M640 760 L640 798", "hot", ["OP_P2"]),
          P.box(436, 844, 96, 32, "Make-up"), P.pipe("M532 860 L618 860", "water"),
          P.tank(620, 800, 140, 120, { fluid: "hot", label: "Hot water tank", sub: "06-LS-603", sw: [LS("LS603_HL", 0.2, "HL"), LS("LS603_LL", 0.8, "LL")] }),
          P.pipe("M760 910 L812 910", "hot", ["OP_P2"]), P.pipe("M868 910 L1158 910", "hot", ["OP_P2"]),
          P.pump(840, 910, "OP_P2", { name: false }),
          P.chipSP(1060, 844, "T_02", "TT-601", 190, { spAbove: true }), P.chipSP(1060, 880, "PT_03", "PT-601", 190),
          `<g class="dest dest-proc"><rect x="1160" y="820" width="180" height="100" rx="6"/><text class="dr-t" x="1250" y="878" text-anchor="middle">DRYER</text></g>` + ob(1160, 820, 1340, 920),
          P.pipe("M1250 820 L1250 730 L1128 730", "hot", ["OP_P2"]),
          P.chipSP(1440, 752, "T_01", "TT dryer out", 150, { spAbove: true }), P.chipSP(1440, 788, "PT_02", "PT-602 dryer out", 160),
          P.radiator(1030, 700, ["OP_P2"], "Radiator fan - not wired to this panel; shown for reference only - not animated (no signal). PID holds TT."),
          P.pipe("M1030 730 L728 730", "hot", ["OP_P2"]),
          P.chipSP(900, 756, "T_03", "TT rad. out", 150, { spAbove: true }), P.chipSP(900, 792, "PT_04", "PT-603", 150),
          // ===== 4 filtrate tank -> client; de-gasifier, pH dosing, gravity tank -> PHE-2 -> WTP
          P.pipe("M470 1104 L470 990 L420 990 M630 1104 L630 990 L470 990", "water", ["OP_P5A", "OP_P5B"]),
          P.tank(440, 1010, 220, 150, { level: "LT_02", fluid: "water", label: "Filtrate tank", sub: "01-LT-102", readY: 56 }),   // centred across; a little above the middle, clear of the pump tags (short tank)
          P.gauge(575, 966, "01-PG-102"), P.box(226, 974, 192, 32, "To client reuse"),
          P.subPump(470, 1154, "OP_P5A", { side: "left" }), P.subPump(630, 1154, "OP_P5B", { side: "left" }),
          // air: plated filter -> column -> exhaust blower -> vent
          P.pipe("M800 1100 L878 1100", "air", ["OP_M1"]), P.pipe("M930 1008 L930 990 L816 990", "air", ["OP_M1"]), P.pipe("M805 986 L805 968", "air", ["OP_M1"]),
          P.text(812, 976, "vent"),
          `<g class="vs"><rect class="t-body" x="770" y="1080" width="30" height="80" rx="6"/><path class="pf-pl" d="M776 1092 L794 1092 M776 1104 L794 1104 M776 1116 L794 1116 M776 1128 L794 1128 M776 1140 L794 1140 M776 1152 L794 1152"/>
            <text class="note" x="766" y="1180" text-anchor="end">plated filter</text></g>` + ob(770, 1080, 800, 1160),
          P.blower(790, 1010, "OP_M1", { label: "OP-M1" }),
          // process condensate from the dryer -> 05-P-501 -> column top
          P.pipe("M1200 920 L1200 985 L1138 985", "water", ["OP_P4"]), P.pipe("M1082 985 L960 985 L960 1008", "water", ["OP_P4"]),
          P.text(1194, 952, "process condensate", "note", "end"),
          P.pump(1110, 985, "OP_P4", { flip: true }),
          `<path class="t-body" d="M884 1186 L976 1186 L940 1216 L920 1216 Z"/>`,
          // de-gasifier column: float switch lamps on the free (left) side, name under the column
          P.tank(880, 1010, 100, 180, { fluid: "water", r: 25, lampX: 826, sw: [LS("LS701_HH", 0.1, "HH"), LS("LS701_H", 0.3, "H"), LS("LS701_L", 0.7, "L"), LS("LS701_LL", 0.9, "LL")] }),
          P.text(912, 1238, "De-gasifier", "t-lbl", "end"), P.text(912, 1256, "07-LS-701", "note lod", "end"),
          // recirculation through steam-heated PHE-1
          P.pipe("M930 1216 L930 1240 L962 1240", "water", ["OP_P9"]), P.pipe("M1018 1240 L1105 1240 L1105 1132", "water", ["OP_P9"]),
          P.pipe("M1105 1060 L1105 1046 L982 1046", "water", ["OP_P9"]),
          P.phe(1080, 1060, 50, 70, ""), P.text(1136, 1090, "PHE-1"), P.pump(990, 1240, "OP_P9"),
          P.chipSP(1260, 1040, "T_04", "TT-701", 190, { spAbove: true }),
          P.pipe("M1290 1112 L1132 1112", "steam", ["OP_SV1"]), P.valve(1250, 1112, "OP_SV1", { label: "07-XV-701" }), P.box(1290, 1096, 112, 32, "LP steam"),
          // hot water -> process water valve -> gravity PP tank; acid / alkali dosing pumps (stacked) into the line
          P.pipe("M982 1150 L1388 1150", "water", ["OP_SV2"]), P.valve(1040, 1150, "OP_SV2", { label: "07-XV-702", below: true }),
          P.chipSP(1190, 1192, "PH_01", "pH", 130),
          P.pipe("M1160 1250 L1222 1250", "chem", ["OP_P12"]), P.pipe("M1160 1320 L1222 1320", "chem", ["OP_P13"]),
          P.pipe("M1278 1250 L1330 1250 L1330 1152", "chem", ["OP_P12"]), P.pipe("M1278 1320 L1350 1320 L1350 1152", "chem", ["OP_P13"]),
          P.pump(1250, 1250, "OP_P12", { name: false }), P.pump(1250, 1320, "OP_P13", { name: false }),
          P.vessel(1100, 1238, 60, 26, { fluid: "chem", label: "Acid 80 L", labelX: 1130, labelDy: T(16), fill: 0.6 }),
          P.vessel(1100, 1308, 60, 26, { fluid: "chem", label: "Alkali 80 L", labelX: 1130, labelDy: T(16), fill: 0.6 }),
          P.tank(1390, 1040, 110, 120, { fluid: "water", label: "Gravity PP tank", labelX: 1445, labelDy: -130, sw: [LS("LS702_HL", 0.2, "HL"), LS("LS702_LL", 0.8, "LL")] }),
          P.pipe("M1445 1160 L1445 1215 L1452 1215", "water", ["OP_P8"]), P.pipe("M1508 1215 L1582 1215 L1582 1122", "water", ["OP_P8"]),
          P.pipe("M1582 1060 L1582 1006", "water", ["OP_P8"]),
          P.pump(1480, 1215, "OP_P8"), P.phe(1564, 1060, 36, 60, ""), P.text(1558, 1104, "PHE-2", "note", "end"),
          P.link(1390, 972, 200, 32, "WTP / CTP (RO)", "wtp"),
          P.lamp(1210, 990, SW.LS801, "HL"), P.lamp(1266, 990, SW.LS802, "LL"), P.text(1214, 970, "CTP tank"),
          ]),
        ];
      },
    },
    // ---- area sheets drawn from the client P&ID R1 (12-12-2025): every pump, valve, strainer, gauge and agitator
    sludge: {
      name: "Sludge storage tank & filtrate tank (P&ID sheet 1)",
      note: "MV-101 opens at LL, closes at HH (needs instrument air 04-PS-401) · Pumps start at NL, stop at VLL (auto) · Mixer starts 60 s before and stops 60 s after the sludge pump · PC pump runs with the sludge pump",
      vb: [1240, 680],
      draw: () => [
        P.box(6, 292, 130, 52, "Raw sludge in\nSL-200NB uPVC"),
        P.pipe("M136 320 L250 320", "sludge", ["MV_01"]), P.valve(180, 320, "MV_01", { label: "01-MV-101" }),
        P.text(10, 368, "LL: opens · HH: closes"), P.lamp(128, 210, SW.AIR, "AIR"), P.text(176, 215, "instrument air 04-PS-401"),
        `<g class="scr"><rect class="t-body" x="250" y="262" width="120" height="120" rx="4"/><path class="scr-c" d="M268 272 L300 372"/><path class="scr-f" d="M318 272 L350 372"/>
          <text class="t-lbl" x="310" y="254" text-anchor="middle">Screening chamber</text>
          <text class="note" x="300" y="402" text-anchor="middle">coarse + magnetic screen</text><text class="note" x="300" y="420" text-anchor="middle">+ fine screen</text></g>` + ob(250, 240, 370, 424),
        P.pipe("M370 330 L398 330", "sludge", ["MV_01"]),
        P.pipe("M470 474 L470 130 L545 130 M620 474 L620 130 L545 130 M545 130 L545 80 L660 80", "sludge", ["OP_P1A", "OP_P1B"]),
        P.tank(400, 200, 380, 330, { level: "LT_01", fluid: "sludge", label: "Sludge storage tank (01-LT-101)", lvAt: [0.08, 0.26, 0.48, 0.66] }),
        P.hv(470, 178, true), P.hv(620, 178, true), P.nrv(470, 156, "u"), P.nrv(620, 156, "u"),
        P.gauge(510, 106, "01-PG-101"),
        P.subPump(470, 524, "OP_P1A"), P.subPump(620, 524, "OP_P1B"),
        P.sideMix(780, 498, { id: "AGIT", label: "OP-A1 (F1)", below: true }),   // mounted near the tank bottom; label under it (filtrate tank on the right)
        P.link(660, 58, 170, 44, "To volute press\n(sheet 2)", "volute", "dest-proc"),
        P.spCard(20, 430, "Sludge tank set points", [
          ["HH level", "lv:LT_01:hh"], ["H level", "lv:LT_01:h"], ["L level", "lv:LT_01:l"], ["LL level", "lv:LT_01:ll"],
          ["Pump start (NL)", "aux:SP_SLUDGE_PUMP_START"], ["Pump stop (VLL)", "aux:SP_SLUDGE_PUMP_STOP"],
          ["Valve open (LL)", "aux:SP_SLUDGE_VALVE_OPEN"], ["Valve close (HH)", "aux:SP_SLUDGE_VALVE_CLOSE"]]),
        // filtrate tank
        // filtrate from the volute press package (gravity, no IO signal on this line) -> not animated
        P.pipe("M1105 84 L1105 248", "water"),
        P.link(1000, 40, 210, 44, "From volute press\n(filtrate, sheet 2)", "volute"),
        P.pipe("M930 474 L930 200 L1000 200 M1030 474 L1030 200 L1000 200 M1000 200 L1000 140 L982 140", "water", ["OP_P5A", "OP_P5B"]),
        P.tank(900, 250, 260, 280, { level: "LT_02", fluid: "water", label: "Filtrate tank (01-LT-102)" }),   // level readout in the middle of the tank (user request 17-11-2026)
        P.hv(930, 236, true), P.hv(1030, 236, true), P.nrv(930, 218, "u"), P.nrv(1030, 218, "u"),
        P.gauge(1030, 176, "01-PG-102"),
        P.subPump(930, 524, "OP_P5A"), P.subPump(1030, 524, "OP_P5B"),
        P.box(880, 120, 100, 40, "To client\n(reuse)"),
        P.spCard(900, 566, "Filtrate tank set points", [
          ["HH level", "lv:LT_02:hh"], ["H level", "lv:LT_02:h"], ["L level", "lv:LT_02:l"], ["LL level", "lv:LT_02:ll"]]),
      ],
    },
    volute: {
      name: "Volute press - flocculation & dewatering (P&ID sheet 2)",
      note: "Package (Norsen scope): only the PC pump OP-P201 is wired to this panel · the other machines have no signal and are shown for reference only (not animated) · low water flow stops the chemical feeder",
      vb: [1240, 730],
      draw: () => {
        const run = ["OP_P1A", "OP_P1B", "PCP"];
        const why = "Volute press package (Norsen scope) - not wired to this panel. Shown for reference only - not animated (no signal).";
        return [
          // water: raw water main -> dilution tank inlet + screw spray
          // raw water from the header (pumped by 03-P-303 / 304, manual valves only) -> animated while a supply pump runs
          P.pipe("M1100 442 L110 442 L110 150 L230 150 L230 178", "water", ["OP_P14", "OP_P15"]),
          P.pipe("M110 442 L110 566 L290 566 L290 572 M110 486 L290 486 L290 492", "water", ["OP_P14", "OP_P15"]),
          P.link(1100, 420, 130, 44, "Raw water\n(sheet 3)", "raw"),
          P.strn(1085, 442), P.gauge(1062, 418, "PI"), P.pkInst(700, 442, "FT", ""),
          P.text(716, 424, "low water flow → chemical feeder stops"),
          P.text(118, 140, "water inlet"),
          // chemical powder -> screw feeder -> dilution tank (3 compartments, 3 agitators)
          P.hopperTank(371, 6, 90, "Chemical tank"), P.text(469, 38, "vibrator + timer"),
          P.lamp(469, 58, "", "LS"), P.text(516, 63, "level switch"),
          P.pipe("M304 134 L304 178", "chem"),
          P.screw(290, 112, 150, { run, why, label: "Chemical screw feeder", drive: "VFD", labelAt: [282, 116, "end"] }),
          P.pipe("M270 320 L270 370 M410 320 L410 370 M550 320 L550 370 M270 370 L972 370", "chem"),
          P.pipe("M270 370 L150 370", "chem"), P.text(150, 394, "drain"),
          // name beside the tank (right), clear of the three outlet valves under it (image78)
          P.vessel(200, 180, 420, 140, { fluid: "chem", parts: [340, 480], label: "Chemical dilution tank", sub: "3 compartments - polymer solution", labelX: 630, labelAnchor: "start", labelDy: -70, fill: 0.62 }),
          P.agit(270, 180, 105, { run, why }), P.agit(410, 180, 105, { run, why }), P.agit(550, 180, 105, { run, why }),
          P.pkInst(600, 160, "LT"),
          P.hv(270, 345, true), P.hv(410, 345, true), P.hv(550, 345, true), P.hv(175, 370),
          // dosing pump -> flocculation tank
          P.pipe("M1028 370 L1060 370 L1060 470 L960 470 L960 488", "chem"),
          P.pkPump(1000, 370, "Chemical dosing pump", run, why, { below: false }),   // label above: the PI gauge label sits below
          P.pipe("M1040 601 L1002 601", "sludge", ["OP_P1A", "OP_P1B"]), P.hv(1022, 601),
          P.link(1040, 578, 170, 46, "Raw sludge from\n01-P-101 / 102", "sludge"),
          P.pipe("M790 520 L737 520", "sludge"),
          P.vessel(790, 490, 210, 150, { fluid: "sludge", label: "Flocculation tank", fill: 0.7 }),
          P.agit(895, 490, 110, { run, why, label: "VFD agitator" }),
          // sludge collecting tank -> PC pump -> screw 1 / 2
          P.pipe("M680 580 L680 627", "sludge", ["PCP"]),
          P.vessel(625, 500, 110, 80, { fluid: "sludge", label: "Sludge collecting tank", labelDy: -88, fill: 0.55 }),
          P.pipe("M572 650 L520 650 L520 480 L376 480 L376 489 M520 556 L376 556 L376 569", "sludge", ["PCP"]),
          P.pcp(640, 650, "PCP", { label: "OP-P201" }),
          P.pipe("M380 532 L380 540 L450 540 L450 658 M380 612 L380 620 L450 620", "water"),
          P.pipe("M214 542 L214 552 L160 552 L160 640 M214 622 L214 632 L160 632", "sludge"),
          P.screw(200, 520, 200, { run, why, label: "Screw-1", spray: 90 }),
          P.screw(200, 600, 200, { run, why, label: "Screw-2", spray: 90 }),
          P.link(390, 660, 180, 34, "To filtrate tank", "sludge"),
          `<g class="vs"><path class="t-body" d="M90 640 L230 640 L200 700 L120 700 Z"/><path class="t-fill sludge" d="M100 662 L220 662 L200 698 L120 698 Z"/>
            <text class="t-lbl" x="160" y="720" text-anchor="middle">Sludge storage hopper (cake)</text></g>`,
        ];
      },
    },
    raw: {
      name: "Raw water storage & distribution (P&ID sheet 3)",
      note: "03-P-301 / 302 fill the tank: start at LL, stop at HL · 03-P-303 / 304 (VFD) run above LL, stop at LL; the VFD holds the header at ≥ 3 kg/cm² from PT-301",
      vb: [1520, 660],                                  // wider: the volute press line goes on to dosing make-up + screw spray (P&ID sheet 3)
      draw: () => {
        const both = ["OP_P14", "OP_P15"], ug = ["OP_P6A", "OP_P6B"];
        const dests = [["Boiler DM plant make-up tank\n(PAR scope)", "CW-25NB"], ["Boiler wet scraper conveyor\n(PAR scope)", "CW-25NB"],
          ["OP cooling tower-2 make-up", "CW-20NB", "ct2"], ["OP cooling tower-1 make-up", "CW-20NB", "ct1"],
          ["Vacuum pump & KO drum\n(PAR scope)", "CW-25NB"], ["To volute press\n(sheet 2)", "CW-25NB", "volute"],
          ["Sludge screen", "CW-40NB", "sludge"], ["Hot water tank make-up", "CW-40NB", "ct2"]];
        // ground water lines also need the flow switch: no animation while 03-FS-301 reports no flow
        const fs = { need: [`sw:${SW.FLOW}`] };
        return [
          // both ground water pumps join one riser below the NRV; the wash-room branch leaves the riser above the NRV,
          // so every stretch of line has a single flow direction (brief SC04: two-way arrow mismatch)
          P.pipe("M228 600 L250 600 L250 560 L130 560 M98 600 L130 600 L130 160 L298 160", "water", ug, fs),
          P.pipe("M130 440 L405 440 L405 464", "water", ug, fs), P.hv(200, 440), P.box(300, 466, 210, 46, "Wash room &\ngeneral purpose tank"),
          P.pipe("M220 250 L220 200 L298 200", "ctp"), P.hv(220, 226, true), P.link(160, 250, 120, 44, "From CTP\nplant", "wtp"),
          P.hv(114, 600), P.hv(250, 580, true), P.nrv(130, 520, "u"),
          P.lamp(138, 380, SW.FLOW, "FS"), P.text(184, 385, "03-FS-301"),
          P.pump(70, 600, "OP_P6A"), P.pump(200, 600, "OP_P6B"),
          P.tank(300, 140, 260, 260, { fluid: "water", label: "Raw water storage tank (03-LS-301)", sw: [LS("LS301_HL", 0.12, "HL"), LS("LS301_LL", 0.85, "LL")] }),
          // transfer pumps (VFD): valve - strainer - valve - pump - NRV - valve
          P.pipe("M560 380 L620 380 L620 300 L692 300", "water", ["OP_P14"]), P.pipe("M620 380 L620 460 L692 460", "water", ["OP_P15"]),
          P.pipe("M748 300 L830 300 L830 380", "water", ["OP_P14"]), P.pipe("M748 460 L830 460 L830 380", "water", ["OP_P15"]),
          ...[300, 460].map((y) => P.hv(638, y) + P.strn(664, y) + P.nrv(770, y) + P.hv(800, y)),
          P.pump(720, 300, "OP_P14"), P.pump(720, 460, "OP_P15"),
          P.pipe("M830 380 L900 380", "water", both), P.pipe("M900 380 L900 60 M900 380 L900 550", "water", both),
          P.gauge(865, 356, "03-PG-301"),
          `<path class="tx-leg" d="M853 200 L900 200"/>`, P.tx(840, 200, "PT_01", "PT-301"),
          ...dests.map(([d, sz, go], i) => {
            const y = 60 + i * 70;
            // v3: longer branch stub so the pipe size (CW-25NB …) sits fully between the header and the box
            return P.pipe(`M900 ${y} L986 ${y}`, "water", both) + P.hv(950, y) + `<text class="psz" x="906" y="${y - 10}">${sz}</text>` +
              (go ? P.link(986, y - 22, 250, 44, d, go) : P.box(986, y - 22, 250, 44, d));
          }),
          // volute press line (y 410) continues past the volute press to the dosing system make-up (up) and the screw spray
          // (down) - Norsen scope, as on P&ID sheet 3; no signal on these lines, so they follow the supply pumps like the rest
          P.pipe("M1236 410 L1290 410 L1290 270 L1310 270 M1290 410 L1290 550 L1310 550", "water", both),
          P.box(1310, 248, 200, 44, "Dosing system make-up\n(Norsen scope)"), P.box(1310, 528, 200, 44, "Screw spray\n(Norsen scope)"),
        ];
      },
    },
    ct1: {
      name: "Cooling tower 1 (P&ID sheet 6)",
      note: "CT pumps run when 06-LS-601 is above LL, stop at LL · Fan 06-F-601 runs only with a CT-1 pump",
      vb: [1240, 700],
      // drawn like P&ID sheet 6 (user request 17-11-2026): tower outlet (TG-604) -> suction header -> 3 pumps, each with
      // valve - strainer - valve and a bypass (diverter) loop, PG + NRV on the discharge -> user -> its OWN return line
      // with a TG and a valve back to the top of the tower (three separate returns, not one header)
      draw: () => {
        // [row y, pump, user, goto, suction / return size, PG tag, return TG tag, return lane y, lane x right, lane x left]
        const rows = [
          [190, "OP_P7", "De-gasifier PHE-1\n(sheet 7)", "degas", "CW-50NB-MS", "06-PG-601", "06-TG-603", 110, 1100, 230],
          [430, "OP_P3", "For dryer surface\ncondenser (PAR scope)", "", "CW-100NB-MS", "06-PG-602", "06-TG-602", 75, 1140, 190],
          [610, "OP_P11", "For boiler\n(PAR scope)", "", "CW-25NB-MS", "06-PG-603", "06-TG-601", 40, 1180, 150]];
        const ids = rows.map((r) => r[1]);
        return [
          // make-up water from the raw water header (sheet 3): CW-20NB-uPVC with its valve into the tower
          P.pipe("M170 400 L300 400", "water", ["OP_P14", "OP_P15"]), P.hv(235, 400), P.link(14, 378, 156, 44, "Make-up water\n(sheet 3)", "raw"),
          `<text class="psz" x="180" y="390">CW-20NB-uPVC</text>`,
          // tower outlet -> TG-604 -> suction header feeding the three pumps
          P.pipe("M426 430 L520 430 M520 430 L520 190 M520 430 L520 610", "water", ids), P.gauge(470, 454, "06-TG-604", "TG", true),
          ...rows.map(([y, id, d, go, sz, pg, tg, ly, xr, xl]) =>
            // suction: valve - strainer - valve, bypass loop with its own valve under it
            P.pipe(`M520 ${y} L672 ${y}`, "water", [id]) + P.pipe(`M540 ${y} L540 ${y + 34} L660 ${y + 34} L660 ${y}`, "water") +
            P.hv(560, y) + P.strn(600, y) + P.hv(640, y) + P.hv(600, y + 34) + `<text class="psz" x="566" y="${y + 56}">${sz}</text>` +
            P.pump(700, y, id) +
            // discharge: PG (with its root valve) + NRV -> user
            P.pipe(`M728 ${y} L840 ${y}`, "water", [id]) + P.gauge(765, y - 24, pg, "PG") + P.nrv(805, y) +
            (go ? P.link(840, y - 22, 190, 44, d, go) : P.box(840, y - 22, 190, 44, d, "dest-proc")) +
            // its own return: right, up to its lane, back over the top, down to the tower inlet - TG + valve on the way
            P.pipe(`M1030 ${y} L${xr} ${y} L${xr} ${ly} L${xl} ${ly} L${xl} 320`, "water", [id]) +
            P.gauge(xl + 40, ly - 24, tg, "TG") + P.hv(xl, 270, true) + `<text class="psz" x="${xl + 140}" y="${ly - 8}">${sz}</text>`),
          // the three returns enter the top of the tower
          P.pipe("M150 320 L304 320", "water", ids),
          P.tower(300, 300, "Cooling tower-1"), P.fan(360, 289, "OP_F1", "06-F-601"),
          P.lamp(436, 340, SW.LS601_HL, "HL"), P.lamp(436, 366, SW.LS601_LL, "LL"), P.text(436, 324, "06-LS-601"),
          `<text class="band" x="1225" y="692" text-anchor="end">3 RETURN LINES WITH TG GAUGES → TOP OF THE TOWER (P&amp;ID SHEET 6)</text>`,
        ];
      },
    },
    ct2: {
      name: "Cooling tower 2 & hot water loop to dryer (P&ID sheet 6)",
      note: "06-P-604 runs when 06-LS-602 is above LL, stops at LL; fan 06-F-602 runs only with it · Hot water pump 06-P-605 runs above LL of 06-LS-603, stops at LL (and at HH per the interlock list) · Radiator fan is held by PID on the outlet temperature",
      vb: [1240, 720],
      draw: () => {
        const hot = ["OP_P2"];
        return [
          `<text class="band" x="1225" y="24" text-anchor="end">COOLING TOWER-2 · TURBINE OIL COOLING</text><text class="band" x="1225" y="324" text-anchor="end">HOT WATER LOOP · DRYER</text>`,
          // cooling tower-2 as on P&ID sheet 6: make-up CW-20NB-uPVC -> tower -> valve / strainer / valve with bypass loop
          // (CW-25NB-uPVC) -> 06-P-604 -> PG-604 + TG-605 -> turbine PHE (PAR scope) -> return over the top, TG-606 and a
          // valve, into the top of the tower
          P.pipe("M140 240 L158 240", "water", ["OP_P14", "OP_P15"]), P.hv(149, 240), P.link(4, 218, 136, 44, "Make-up water\n(sheet 3)", "raw"),
          `<text class="psz" x="6" y="208">CW-20NB-uPVC</text>`,
          P.pipe("M286 244 L442 244", "water", ["OP_P10"]), P.pipe("M340 244 L340 270 L400 270 L400 244", "water"),
          P.hv(318, 244), P.strn(370, 244), P.hv(422, 244), P.hv(370, 270), `<text class="psz" x="300" y="230">CW-25NB-uPVC</text>`,
          P.pipe("M498 244 L600 244", "water", ["OP_P10"]), P.gauge(506, 220, "06-PG-604", "PG"), P.gauge(572, 220, "06-TG-605", "TG"),
          P.pipe("M710 244 L780 244 L780 60 L130 60 L130 140 L156 140", "water", ["OP_P10"]), P.hv(130, 100, true), P.gauge(230, 36, "06-TG-606", "TG"),
          `<text class="psz" x="420" y="52">CW-25NB-uPVC</text>`,
          P.phe(600, 214, 110, 60, "For turbine PHE (PAR scope)"),
          P.tower(160, 110, "Cooling tower-2"), P.fan(220, 99, "OP_F2", "06-F-602"),
          P.lamp(300, 150, SW.LS602_HL, "HL"), P.lamp(300, 176, SW.LS602_LL, "LL"), P.text(346, 168, "06-LS-602"),
          P.pump(470, 244, "OP_P10", { label: "06-P-604" }),
          // hot water loop
          P.pipe("M140 582 L176 582", "water", ["OP_P14", "OP_P15"]), P.hv(158, 582), P.link(4, 560, 136, 44, "Make-up water\n(sheet 3)", "raw"),
          // v3: transmitters spaced 110-120 apart so their boxes and "alarm SP" captions never touch
          `<path class="tx-leg" d="M590 612 L590 625 M710 612 L710 625 M910 386 L910 400 M790 386 L790 400 M540 386 L540 400 M430 386 L430 400"/>`,
          P.pipe("M318 625 L412 625", "hot", hot), P.hv(370, 625),
          P.pipe("M468 625 L898 625", "hot", hot), P.gauge(515, 601, "06-PG-605", "PG"), `<text class="psz" x="760" y="644">150-HW-MS</text>`,
          P.pipe("M1000 560 L1000 400 L698 400", "hot", hot), P.gauge(726, 376, "06-PG-606", "PG"), `<text class="psz" x="1008" y="480">150-HW-MS</text>`,
          P.pipe("M600 400 L382 400", "hot", hot), P.gauge(485, 424, "06-PG-607", "PG", true),   // under the pipe, clear of the PT / TT readouts above
          P.pipe("M248 424 L248 518", "hot", hot), `<text class="psz" x="256" y="476">200-HW-MS</text>`,
          P.pipe("M240 362 L240 378 M330 362 L330 378", "steam"),
          P.tank(178, 520, 140, 120, { fluid: "hot", label: "Hot water tank (06-LS-603)", sw: [LS("LS603_HL", 0.2, "HL"), LS("LS603_LL", 0.7, "LL")] }),
          P.pump(440, 625, "OP_P2", { label: "06-P-605" }),
          P.tx(590, 556, "PT_03", "PT-601"), P.tx(710, 556, "T_02", "TT-601"),
          `<g class="dest dest-proc"><rect x="900" y="560" width="200" height="110" rx="6"/><text class="dr-t" x="1000" y="620" text-anchor="middle">DRYER</text></g>`,
          P.tx(910, 330, "PT_02", "PT-602"), P.tx(790, 330, "T_01", "TT"),
          P.radiator(600, 370, hot, "Radiator fan - not wired to this panel; shown for reference only - not animated (no signal). PID holds TT."),
          P.tx(540, 330, "T_03", "TT"), P.tx(430, 330, "PT_04", "PT-603"),
          P.box(180, 380, 200, 44, "Surface condenser", "dest-proc"), P.box(200, 332, 80, 30, "Boiler"), P.box(290, 332, 80, 30, "Turbine"),
        ];
      },
    },
    degas: {
      name: "De-gasifier, pH dosing & gravity tank (P&ID sheet 7)",
      note: "05-P-501 starts when T-101 is above low and 07-LS-701 at H, stops at HH or T-101 low · 07-P-701 runs above L, stops at LL · Outlet 07-XV-702 opens at HH, closes at H · Steam 07-XV-701 opens ≤ 70 °C, closes ≥ 90 °C (set points) · Acid on ≤ 6.5 / off ≥ 7.0, alkali on ≥ 7.5 / off ≤ 7.0 (never both) · 07-P-704 runs while 07-LS-702 > LL and the CTP tank < HH",
      vb: [1240, 760],
      // drawn like P&ID sheet 7 (user request 17-11-2026): every line, valve and instrument where the P&ID has it
      draw: () => [
        // ===== air: plated filter (air in at the bottom) -> BFV -> 4" duct -> sparger in the column; column top -> 10" duct
        // -> BFV -> hot air blower on its stand -> 3" duct -> vent cap
        P.pipe("M296 556 L318 556 L318 420 L366 420", "air", ["OP_M1"]), P.hv(306, 556),
        P.pipe("M440 150 L440 120 L212 120", "air", ["OP_M1"]), P.hv(226, 120), P.pipe("M165 96 L165 30", "air", ["OP_M1"]),
        `<path class="t-body" d="M148 28 L182 28 L172 14 L158 14 Z"/>`,
        P.text(174, 66, "3\" duct"), P.text(300, 112, "10\" duct"), P.text(324, 500, "4\" duct"),
        `<g class="vs"><rect class="t-body" x="250" y="542" width="46" height="108" rx="6"/><rect class="t-body" x="246" y="536" width="54" height="7" rx="1"/>
          <path class="pf-pl" d="M258 556 L288 556 M258 570 L288 570 M258 584 L288 584 M258 598 L288 598 M258 612 L288 612"/>
          <rect class="t-body" x="234" y="626" width="16" height="12" rx="2"/><path class="t-body" d="M256 650 L256 690 M290 650 L290 690"/>
          <text class="t-lbl" x="273" y="526" text-anchor="middle">Plated filter</text><text class="note" x="236" y="660" text-anchor="end">air in</text></g>` + ob(232, 512, 300, 690),
        `<path class="t-body" d="M92 150 L198 150 L198 156 L92 156 Z M100 156 L100 204 M190 156 L190 204 M100 188 L190 188"/>`,
        P.blower(150, 120, "OP_M1", { label: "OP-M1", sub: "hot air blower" }),
        // ===== process condensate from the dryer (P&ID sheet 5) -> 25 NB -> 3/4" nozzle of the column
        P.box(4, 640, 136, 50, "Process condensate\nfrom dryer (sh. 5)"), P.pump(176, 665, "OP_P4"),
        P.pipe("M204 665 L214 665 L214 230 L362 230", "water", ["OP_P4"]), `<text class="psz" x="220" y="450">25 NB</text>`,
        // ===== column (vessel drawing): flanged top + vent nozzle, side nozzles 3/4" and 1 1/4", body flange with support
        // lugs, air sparger, conical bottom with the 2" BSP level-sensor nozzle, outlet at the bottom
        `<path class="t-body" d="M380 470 L500 470 L456 506 L424 506 Z"/><rect class="t-body" x="434" y="506" width="12" height="12"/>`,
        P.tank(380, 186, 120, 284, { fluid: "water", r: 2, lampX: 332, sw: [LS("LS701_HH", 0.1, "HH"), LS("LS701_H", 0.3, "H"), LS("LS701_L", 0.7, "L"), LS("LS701_LL", 0.9, "LL")] }),
        `<g class="dg-v"><rect class="t-body" x="372" y="176" width="136" height="10" rx="1"/>
          <rect class="t-body" x="432" y="156" width="16" height="20"/><rect class="t-body" x="426" y="150" width="28" height="6" rx="1"/>
          <rect class="t-body" x="366" y="224" width="14" height="12"/><rect class="t-body" x="362" y="220" width="5" height="20"/>
          <rect class="t-body" x="500" y="224" width="14" height="12"/><rect class="t-body" x="513" y="220" width="5" height="20"/>
          <rect class="t-body" x="372" y="352" width="136" height="7" rx="1"/><rect class="t-body" x="372" y="360" width="136" height="7" rx="1"/>
          <path class="t-body" d="M372 367 L356 367 L372 381 Z M508 367 L524 367 L508 381 Z"/>
          <rect class="t-body" x="366" y="414" width="14" height="12"/>
          <rect class="dg-sp" x="382" y="416" width="100" height="8" rx="3"/>
          <path class="dg-holes" d="M390 424 v3 M400 424 v3 M410 424 v3 M420 424 v3 M430 424 v3 M440 424 v3 M450 424 v3 M460 424 v3 M470 424 v3"/>
          <rect class="t-body" x="472" y="482" width="16" height="7"/></g>`,
        `<text class="note lod" x="358" y="254" text-anchor="end">3/4"</text><text class="note lod" x="522" y="216">1 1/4"</text>`,
        `<text class="note lod" x="492" y="486">2" BSP (LS)</text>`,
        P.text(458, 166, "De-gasifier (07-LS-701)", "t-lbl"),
        // ===== bottom outlets: drain (left), 2 1/2" -> recirculation pump suction (down), 3" -> 2" -> 07-XV-702 -> gravity tank (right)
        P.pipe("M434 512 L360 512 L360 692", "water"), P.hv(360, 600, true), P.text(366, 700, "Drain"),
        P.pipe("M440 518 L440 690 L482 690", "water", ["OP_P9"]), P.hv(440, 560, true), `<text class="note lod" x="446" y="548">2 1/2"</text>`,
        P.pipe("M446 512 L470 512 L470 565 L842 565 L842 510 L860 510", "water", ["OP_SV2"]), P.hv(470, 540, true), P.valve(800, 565, "OP_SV2", { label: "07-XV-702", below: true }),
        `<text class="note lod" x="476" y="530">3" → 2"</text>`,
        // ===== recirculation: 07-P-701 -> PG-701 -> hot water 70 °C 40 NB -> pH sensor -> PHE-1 (bottom right) ->
        // PHE-1 (bottom left) -> TT-701 -> 1 1/4" nozzle at the top of the column
        P.pump(510, 690, "OP_P9"),
        P.pipe("M538 690 L560 690 L560 530 L708 530 L708 420", "water", ["OP_P9"]), P.gauge(640, 506, "07-PG-701", "PG"),
        `<text class="psz" x="604" y="548">70 °C · 40 NB</text>`,
        P.pipe("M662 420 L662 446 L545 446 L545 230 L518 230", "water", ["OP_P9"]),
        `<path class="tx-leg" d="M545 280 L587 280"/>`, P.tx(600, 280, "T_04", "TT-701"),
        P.phe(650, 300, 70, 120, ""), P.text(726, 364, "PHE-1", "t-lbl"),
        // pH sensor on the line into PHE-1 -> pH controller -> control cable to the two dosing pumps
        `<path class="tx-leg" d="M708 470 L747 462"/>`, P.tx(760, 462, "PH_01", "pH"),
        P.box(820, 418, 120, 32, "pH controller"),
        `<path class="ctl-cbl" d="M773 458 L820 438 M830 450 L830 646 L788 646 M728 646 L668 646"/>`,
        // ===== steam: inlet 25 NB -> 07-XV-701 -> TG-701 -> PHE-1 (top left); PHE-1 (top right) -> NRV -> condensate outlet
        P.pipe("M900 137 L662 137 L662 300", "steam", ["OP_SV1"]), P.valve(800, 137, "OP_SV1", { label: "07-XV-701" }), P.hv(866, 137),
        P.gauge(720, 113, "07-TG-701", "TG"),
        P.box(900, 120, 150, 34, "Steam inlet 25 NB"), P.lamp(845, 92, SW.AIR, "AIR"), P.text(893, 97, "instrument air 04-PS-401"),
        P.pipe("M708 300 L708 190 L900 190", "steam"), P.nrv(770, 190), P.hv(866, 190), P.box(900, 173, 150, 34, "Cond. outlet"),
        // ===== pH dosing: acid / alkali tanks 80 L with dosing pumps 0-10 LPH -> PU tube -> NRV + valve -> recirculation suction
        P.vessel(605, 660, 70, 50, { fluid: "chem", label: "Acid tank 80 L", labelDy: 16 }), P.vessel(725, 660, 70, 50, { fluid: "chem", label: "Alkali tank 80 L", labelDy: 16 }),
        P.pump(640, 646, "OP_P12", { name: false }), P.pump(760, 646, "OP_P13", { name: false }),
        P.pipe("M654 627 L654 600", "chem", ["OP_P12"]), P.pipe("M774 627 L774 600 L654 600", "chem", ["OP_P13"]),
        P.pipe("M654 600 L462 600 L462 690", "chem", ["OP_P12", "OP_P13"]), P.nrv(530, 600, "l"), P.hv(494, 600),
        `<text class="psz" x="572" y="594">PU tube</text>`,
        // ===== gravity PP tank 2000 L -> 25 NB -> 07-P-704 -> PHE-2 (bottom left) -> PHE-2 (bottom right) -> TG-702 -> WT plant;
        // cooling water: 114TR CT plant line -> TG-703 -> PHE-2 (top right) -> PHE-2 (top left) -> CW water (P&ID sheet 6)
        // gravity PP tank drawn like the P&ID (user request 17-11-2026): plastic tank with corrugated walls, top rim + roof
        // with a lid, level sensor 07-LS-702 entering from the top, inlet near the top, name written inside
        P.tank(860, 500, 150, 150, { fluid: "water", r: 12, lampX: 1028, label: "Gravity PP tank", labelX: 945, labelDy: -92, sw: [LS("LS702_HL", 0.2, "HL"), LS("LS702_LL", 0.8, "LL")] }),
        `<g class="gpt"><path class="gpt-rib" d="M860 512 ${"q-9 8 0 16 ".repeat(8)}M1010 512 ${"q9 8 0 16 ".repeat(8)}"/>
          <path class="t-body" d="M862 492 L896 476 L974 476 L1008 492 Z"/><rect class="t-body" x="852" y="490" width="166" height="11" rx="2"/>
          <rect class="t-body" x="915" y="466" width="40" height="11" rx="2"/><line class="gpt-ls" x1="878" y1="470" x2="878" y2="628"/></g>`,
        `<text class="note" x="945" y="584" text-anchor="middle">(2000 Ltr.)</text><text class="note lod" x="872" y="462" text-anchor="end">07-LS-702</text>`,
        P.pipe("M1010 640 L1020 640 L1020 680 L1032 680", "water", ["OP_P8"]), P.hv(1020, 660, true),
        P.pump(1060, 680, "OP_P8", { name: false }),
        P.pipe("M1074 661 L1074 420", "water", ["OP_P8"]), P.nrv(1074, 600, "u"), P.hv(1074, 560, true), `<text class="psz" x="1080" y="520">25 NB</text>`,
        P.phe(1062, 300, 70, 120, ""), P.text(1056, 364, "PHE-2", "t-lbl", "end"),
        P.pipe("M1120 420 L1120 470 L1150 470", "water", ["OP_P8"]), P.gauge(1135, 446, "07-TG-702", "TG"),
        P.link(1150, 450, 86, 40, "To WTP\n(sheet 8)", "wtp"),
        P.pipe("M1150 258 L1120 258 L1120 300", "water"), P.gauge(1135, 234, "07-TG-703", "TG"), P.box(1150, 236, 86, 44, "114TR CT\nplant"),
        P.pipe("M1074 300 L1074 190 L1150 190", "water"), P.link(1150, 168, 86, 44, "CW water\n(sh. 6)", "ct1"),
        P.spCard(780, 226, "De-gasifier set points", [
          ["Steam valve open", "aux:SP_LP_STEAM_OPEN"], ["Steam valve close", "aux:SP_LP_STEAM_CLOSE"],
          ["PHE-1 temp alarm", "alm:T_04"], ["pH alarm", "alm:PH_01"]]),
      ],
    },
    wtp: {
      name: "Condensate treatment plant - WTP / CTP (P&ID sheet 8)",
      note: "Packaged plant (Norsen scope): only the four tank float switches are wired to this panel; pumps and filters here have no signal",
      vb: [1240, 640],
      draw: () => {
        const why = "Package pump (Norsen scope) - not wired to this panel, no state available.";
        return [
          P.pipe("M140 300 L187 300", "ctp"),
          P.pipe("M243 300 L250 300 L250 70 L328 70 L328 92", "ctp"), P.pipe("M342 92 L342 58 L468 58 L468 92", "ctp"),
          P.pipe("M482 92 L482 46 L660 46 L660 300 L672 300", "ctp"), P.pipe("M600 180 L600 120 L660 120", "chem"),
          P.pipe("M728 300 L768 300", "ctp"), P.pipe("M814 230 L850 230 L850 300 L862 300", "ctp"),
          P.pipe("M918 300 L950 300 L950 120 L978 120", "ctp"),
          P.pipe("M1200 200 L1220 200 L1220 420 L902 420", "ctp"), P.pipe("M760 420 L640 420 L640 380 L530 380 L530 398", "water"),
          P.pipe("M1200 120 L1232 120 L1232 560 L1192 560", "ctp"),
          P.pipe("M590 510 L690 510", "water"), P.pipe("M860 510 L875 510 L875 558", "water"),
          P.tank(30, 160, 110, 170, { fluid: "water", label: "Raw water tank", sw: [LS("LS801", 0.15, "HL"), LS("LS802", 0.7, "LL")] }),
          P.pkPump(215, 300, "Raw water pump", [], why),
          P.filterV(300, 110, "Sand filter"), P.filterV(440, 110, "Carbon filter"),
          P.vessel(560, 180, 80, 120, { fluid: "chem", label: "Dosing", sub: "pH & antiscalant", fill: 0.6 }),
          P.pkPump(700, 300, "Raw water pump", [], why),
          P.vessel(770, 200, 44, 110, { fluid: "water", label: "Micron filter", labelDy: -120, fill: 0.9, r: 14 }),
          P.pkPump(890, 300, "Booster pump", [], why),
          `<g class="ro">${[0, 1, 2, 3].map((i) => `<rect x="980" y="${100 + i * 32}" width="220" height="22" rx="11"/><circle cx="992" cy="${111 + i * 32}" r="5"/><circle cx="1188" cy="${111 + i * 32}" r="5"/>`).join("")}
            <text class="t-lbl" x="1090" y="250" text-anchor="middle">RO module</text><text class="note" x="1226" y="112" text-anchor="end">reject</text></g>`,
          `<g class="uv"><rect x="760" y="406" width="140" height="28" rx="14"/><rect x="744" y="410" width="16" height="20" rx="3"/><rect x="900" y="410" width="16" height="20" rx="3"/>
            <text class="t-lbl" x="830" y="456" text-anchor="middle">UV sterilizer</text></g>`,
          P.tank(470, 400, 120, 160, { fluid: "pure", label: "Pure water tank", sw: [LS("LS803", 0.15, "HL"), LS("LS804", 0.85, "LL")] }),
          P.box(690, 490, 170, 40, "Mineral cartridge"), P.box(780, 560, 190, 40, "Drinking water tank"),
          P.link(982, 540, 210, 40, "Filtrate tank (sh. 1)", "sludge"),
        ];
      },
    },
  };

  // ---------- v3 (SC05): valve position from the IO list signals ----------
  // open / closed only when a limit-switch input confirms it; an output (command) alone does not prove the position
  function vState(e) {
    if (!e) return { k: "unk", cue: "?", txt: "No data - position unknown" };
    const io = e.io || {}, o = io.open, c = io.close, oc = io.open_cmd, cc = io.close_cmd;
    if (o === true && c === true) return { k: "conf", cue: "!", txt: "Open and closed limit switches both ON - check the valve / wiring" };
    if (o === true) return { k: "open", cue: "", txt: "Open - confirmed by the open limit switch" };
    if (c === true) return { k: "closed", cue: "", txt: "Closed - confirmed by the closed limit switch" };
    const mid = o === false && c === false;                 // both switches OFF: travelling or not reached
    if (oc === true && cc !== true) return { k: "cmd-open", cue: "cmd", txt: `Commanded open - not confirmed${mid ? " (no limit switch ON yet)" : ""}` };
    if (cc === true && oc !== true) return { k: "cmd-closed", cue: "cmd", txt: `Commanded closed - not confirmed${mid ? " (no limit switch ON yet)" : ""}` };
    return { k: "unk", cue: "?", txt: "Position unknown - no limit switch confirms it" };
  }
  const isValve = (id) => { const e = eq(id); return !!e && e.type === "valve"; };
  // flow in a line: one of its machines running (a valve counts only when confirmed open) and every condition met
  function flowOn(ids, need = []) {
    if (!ids.length) return false;
    const go = (id) => (isValve(id) ? vState(eq(id)).k === "open" : running(id));
    return ids.some(go) && need.every((n) => (n.startsWith("sw:") ? sw(n.slice(3)) !== false : vState(eq(n)).k === "open"));
  }
  // the cue ("cmd", "?", "!") gets its own room so it never runs into the legend words
  const vIcon = (k, cue = "") => `<svg class="lg-v v-${k}${cue.length > 1 ? " lg-v-w" : ""}" viewBox="0 0 ${cue.length > 1 ? 58 : 40} 18" aria-hidden="true"><path d="M2 2 L22 16 L22 2 L2 16 Z"/>${cue ? `<text x="27" y="13">${cue}</text>` : ""}</svg>`;
  function legend() {
    return `<div class="mm-guide"><b>How to read:</b>
      <span><i class="g-run"></i>Green machine = running</span><span><i class="g-stop"></i>Grey = stopped</span>
      <span><i class="g-trip"></i>Red, blinking = tripped (fault)</span><span><i class="g-flow"></i>Moving dashes = flow: the pump is running and the valves on the line are confirmed open</span>
      <span>▶ Arrows on the lines = flow direction (source → destination)</span>
      <span><i class="g-lamp"></i>Yellow lamp = float switch ON (water has reached that level)</span><span><i class="g-trip"></i>AIR lamp red = instrument air low (pneumatic valves blocked)</span>
      <span><i class="g-trip"></i>HH / LL lamp red, <i class="g-hl"></i>H / L lamp orange = tank level reached that set point (dashed line)</span><span>Click any pump, valve or value to see details · Ctrl + scroll or + / − to zoom · drag (or scroll when zoomed in) to move</span></div>
      <div class="mm-legend">${[["water", "Water"], ["hot", "Hot water"], ["sludge", "Sludge"], ["steam", "Steam"], ["air", "Air"],
      ["chem", "Chemical dosing"], ["ctp", "CTP line"]].map(([k, l]) => `<span><i class="lg k-${k}"></i>${l}</span>`).join("")}
      <span class="sep"></span><span><i class="lg-eq run"></i>Running</span><span><i class="lg-eq stop"></i>Stopped</span>
      <span><i class="lg-eq trip"></i>Tripped</span><span><i class="lg-lamp"></i>Float switch ON</span>
      <span class="muted">Hatched tank = level from float switches only (no number)</span></div>
      <div class="mm-legend mm-vlg"><b>Valves:</b><span>${vIcon("open")}Open - confirmed</span><span>${vIcon("closed")}Closed - confirmed</span>
      <span>${vIcon("cmd-open", "cmd")}Commanded open, not confirmed</span><span>${vIcon("cmd-closed", "cmd")}Commanded closed, not confirmed</span>
      <span>${vIcon("unk", "?")}No confirmation</span><span>${vIcon("conf", "!")}Both limit switches ON</span>
      <span class="muted">Confirmed = limit switch input · commanded = output only</span></div>`;
  }
  let mmUser = false;                                    // v3 (SC04): the mimic opens on the overall plant until a sheet is picked
  function setSheet(id) {
    if (!SHEETS[id]) return;
    sheet = id;
    mmUser = true;
    try { localStorage.setItem("md-mimic2", id); } catch (_) {}
    const box = $("mimicSvg");
    if (box) box._sheet = null;
  }

  // ---------- v3 (SC04): zoom / pan / fit / full screen (viewBox of the sheet's svg) ----------
  const MMV = { s: 1, x: 0, y: 0, fit: 1, vw: W, vh: H, fs: 1, at: true };
  const mmSvg = () => { const b = $("mimicSvg"); return b ? b.querySelector("svg.mimic") : null; };
  // full screen = the browser's Fullscreen API, or (iPhone, which has no Fullscreen API for pages) the card filling the window
  const mmFull = () => (!!document.fullscreenElement && document.fullscreenElement === $("mimicCard")) || !!($("mimicCard") && $("mimicCard").classList.contains("mm-fs-win"));
  const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
  function mmLayout() {                                   // normal view: canvas as tall as the whole drawing at fit width
    const host = $("mimicHost");
    if (!host) return;
    host.style.height = mmSvg() && !mmFull() ? `${Math.round(host.clientWidth * MMV.vh / MMV.vw)}px` : "";
  }
  function mmFit() {
    const host = $("mimicHost");
    if (!host || !mmSvg()) return;
    if (mmAnim) { cancelAnimationFrame(mmAnim.raf); mmAnim = null; }
    mmLayout();
    const cw = host.clientWidth, ch = host.clientHeight;
    if (!cw || !ch) return;
    // normal view: the canvas is as tall as the drawing at full width. Full screen: the drawing fills the screen WIDTH
    // (user request 17-11-2026 - like the 168 % view, no empty sides), starting at the top; scroll / drag moves it up
    // and down where it is taller than the screen
    const sw = cw / MMV.vw;
    MMV.fit = MMV.s = mmFull() ? sw : Math.min(sw, ch / MMV.vh);
    MMV.x = (MMV.vw - cw / MMV.s) / 2;
    MMV.y = Math.min(0, (MMV.vh - ch / MMV.s) / 2);
    MMV.at = true;
    mmApply();
  }
  function mmApply() {
    const svg = mmSvg(), host = $("mimicHost");
    if (!svg || !host) return;
    const cw = host.clientWidth, ch = host.clientHeight;
    if (!cw || !ch) return;
    const vw = cw / MMV.s, vh = ch / MMV.s;
    MMV.x = clampN(MMV.x, -vw * 0.75, MMV.vw - vw * 0.25);   // part of the drawing always stays on screen
    MMV.y = clampN(MMV.y, -vh * 0.75, MMV.vh - vh * 0.25);
    svg.setAttribute("viewBox", `${MMV.x.toFixed(2)} ${MMV.y.toFixed(2)} ${vw.toFixed(2)} ${vh.toFixed(2)}`);
    svg.setAttribute("preserveAspectRatio", "xMinYMin meet");
    const z = MMV.s / MMV.fit;
    const pctEl = $("mmZoomPct");
    if (pctEl) pctEl.textContent = `${Math.round(z * 100)} %`;
    const zi = $("mmZoomIn"), zo = $("mmZoomOut");
    if (zi) zi.disabled = z >= 3.999;
    if (zo) zo.disabled = z <= 0.251;
    // labels never drawn below 12 px: zoom-only details hide until large enough; zoomed out past fit all text hides
    svg.classList.toggle("lod-hide", MMV.s * 12 * MMV.fs < 11.5);
    // all text hides only when it would be too small to read at all (< 5 px) - zooming out (e.g. 94 %) keeps every label
    // (user report 17-11-2026: at 94 % the whole drawing went blank)
    svg.classList.toggle("lbl-hide", z < 0.999 && MMV.s * 15 * MMV.fs < 5);
  }
  let mmAnim = null;                                     // smooth zoom in progress: { s (target scale), px, py, ux, uy, raf }
  function mmZoomAt(f, px, py) {                         // instant zoom (pinch on touch screens, touchpad pinch)
    if (!mmSvg()) return;
    if (mmAnim) { cancelAnimationFrame(mmAnim.raf); mmAnim = null; }
    const s2 = clampN(MMV.s * f, MMV.fit * 0.25, MMV.fit * 4);
    const ux = MMV.x + px / MMV.s, uy = MMV.y + py / MMV.s;
    MMV.s = s2; MMV.x = ux - px / s2; MMV.y = uy - py / s2; MMV.at = false;
    mmApply();
  }
  // smooth zoom (client review 17-11-2026: zoom in / out must feel smooth with a mouse): mouse wheel notches and the
  // + / − buttons glide to the new zoom over a few frames, always keeping the point under the cursor in place;
  // quick notches add up to one movement
  function mmZoomSmooth(f, px, py) {
    if (!mmSvg()) return;
    const target = clampN((mmAnim ? mmAnim.s : MMV.s) * f, MMV.fit * 0.25, MMV.fit * 4);
    if (mmAnim) cancelAnimationFrame(mmAnim.raf);
    mmAnim = { s: target, px, py, ux: MMV.x + px / MMV.s, uy: MMV.y + py / MMV.s, raf: 0 };
    MMV.at = false;
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const step = () => {
      const a = mmAnim;
      if (!a) return;
      const done = reduce || Math.abs(Math.log(a.s / MMV.s)) < 0.004;
      MMV.s = done ? a.s : MMV.s * Math.pow(a.s / MMV.s, 0.28);   // ease in log space: even speed in and out
      MMV.x = a.ux - a.px / MMV.s; MMV.y = a.uy - a.py / MMV.s;
      mmApply();
      if (done) mmAnim = null; else a.raf = requestAnimationFrame(step);
    };
    mmAnim.raf = requestAnimationFrame(step);
  }
  function mmHint(host) {                               // "Ctrl + scroll to zoom" shown briefly when the user scrolls over the mimic
    let h = host.querySelector(".mm-hint");
    if (!h) { h = document.createElement("div"); h.className = "mm-hint"; h.setAttribute("aria-hidden", "true"); h.textContent = "Hold Ctrl and scroll to zoom · when zoomed in, scroll or drag to move"; host.appendChild(h); }
    h.classList.add("on");
    clearTimeout(h._t);
    h._t = setTimeout(() => h.classList.remove("on"), 1400);
  }
  function mmZoomCenter(f) { const h = $("mimicHost"); if (h) mmZoomSmooth(f, h.clientWidth / 2, h.clientHeight / 2); }
  function mmBind() {
    const host = $("mimicHost"), card = $("mimicCard");
    if (!host || host._mm) return;
    host._mm = true;
    const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
    on("mmZoomIn", () => mmZoomCenter(1.25));
    on("mmZoomOut", () => mmZoomCenter(0.8));
    on("mmFitBtn", () => mmFit());
    const mmFsSync = () => {
      const fs = mmFull(), b = $("mmFsBtn");
      if (card) card.classList.toggle("mm-fs", fs);
      if (b) {
        b.setAttribute("aria-pressed", String(fs)); b.title = fs ? "Exit full screen (Esc)" : "Full screen"; b.setAttribute("aria-label", b.title);
        const t = b.querySelector(".mm-fs-txt"); if (t) t.textContent = fs ? "Exit full screen" : "Full screen";
      }
      requestAnimationFrame(() => mmFit());
    };
    const mmWinFs = (onOff) => {                          // fallback: fill the browser window (phones without the Fullscreen API)
      if (!card) return;
      card.classList.toggle("mm-fs-win", onOff);
      document.documentElement.classList.toggle("mm-fs-lock", onOff);
      mmFsSync();
    };
    on("mmFsBtn", () => {
      if (document.fullscreenElement) { if (document.exitFullscreen) document.exitFullscreen().catch(() => {}); }
      else if (card && card.classList.contains("mm-fs-win")) mmWinFs(false);
      else if (card && card.requestFullscreen) {
        card.requestFullscreen().catch(() => {});
        setTimeout(() => { if (!document.fullscreenElement) mmWinFs(true); }, 400);   // refused / not possible here: fill the window
      } else mmWinFs(true);
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && card && card.classList.contains("mm-fs-win")) mmWinFs(false); });
    window.addEventListener("hashchange", () => { if (card && card.classList.contains("mm-fs-win") && location.hash !== "#mimic") mmWinFs(false); });
    document.addEventListener("fullscreenchange", mmFsSync);
    $("mimicDim") && $("mimicDim").querySelectorAll("button").forEach((b) => (b.onclick = () => {
      if (b.dataset.d === "3d") setSheet("d3");             // 3D = the whole plant
      else if (sheet === "d3") setSheet("overall");
      renderMimic();
    }));
    // pan: drag (mouse / touch / pen), pinch to zoom; a drag never counts as a click on a symbol
    const pts = new Map();
    let drag = null, pinch = null;
    // zoom box: Shift + drag (or the "Zoom to area" button, then drag) draws a rectangle; that area then fills the view
    let zbox = null;
    const zArm = (on) => { host.classList.toggle("zbox-armed", on); const b = $("mmBoxBtn"); if (b) b.setAttribute("aria-pressed", String(on)); };
    on("mmBoxBtn", () => zArm(!host.classList.contains("zbox-armed")));
    host.addEventListener("pointerdown", (ev) => {
      if (!mmSvg() || ev.target.closest(".mm-pop") || (ev.pointerType === "mouse" && ev.button !== 0)) return;
      if ((ev.shiftKey || host.classList.contains("zbox-armed")) && !pts.size) {
        const r = host.getBoundingClientRect();
        zbox = { x0: ev.clientX - r.left, y0: ev.clientY - r.top, el: document.createElement("div") };
        zbox.el.className = "mm-zbox";
        host.appendChild(zbox.el);
        try { host.setPointerCapture(ev.pointerId); } catch (_) {}
        ev.preventDefault();
        return;
      }
      if (mmAnim) { cancelAnimationFrame(mmAnim.raf); mmAnim = null; }   // grabbing the drawing stops a zoom glide
      pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pts.size === 1) drag = { x: ev.clientX, y: ev.clientY, mx: MMV.x, my: MMV.y, moved: false };
      else if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: MMV.s };
        if (drag) { drag.moved = true; drag.dead = true; }
      }
    });
    host.addEventListener("pointermove", (ev) => {
      if (zbox) {
        const r = host.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
        Object.assign(zbox.el.style, { left: `${Math.min(x, zbox.x0)}px`, top: `${Math.min(y, zbox.y0)}px`, width: `${Math.abs(x - zbox.x0)}px`, height: `${Math.abs(y - zbox.y0)}px` });
        zbox.x1 = x; zbox.y1 = y;
        return;
      }
      if (!pts.has(ev.pointerId)) return;
      pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pinch && pts.size >= 2) {
        const [a, b] = [...pts.values()], r = host.getBoundingClientRect();
        mmZoomAt((pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d) / MMV.s, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
        return;
      }
      if (!drag || drag.dead) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      if (!drag.moved) { drag.moved = true; host.classList.add("dragging"); try { host.setPointerCapture(ev.pointerId); } catch (_) {} }
      MMV.x = drag.mx - dx / MMV.s; MMV.y = drag.my - dy / MMV.s; MMV.at = false;
      mmApply();
    });
    const end = (ev) => {
      if (zbox) {
        const b = zbox; zbox = null; b.el.remove(); zArm(false);
        host._dragged = Date.now();                       // the box is not a click on a symbol
        const rw = Math.abs((b.x1 ?? b.x0) - b.x0), rh = Math.abs((b.y1 ?? b.y0) - b.y0);
        if (ev.type === "pointercancel" || rw < 12 || rh < 12) return;
        const hr = host.getBoundingClientRect(), cw = host.clientWidth;
        const top0 = Math.max(0, -hr.top), visH = Math.min(host.clientHeight - top0, window.innerHeight - Math.max(0, hr.top));   // the part of the canvas on screen
        const f = Math.min(cw / rw, visH / rh), s2 = clampN(MMV.s * f, MMV.fit * 0.25, MMV.fit * 4);
        const ux = MMV.x + Math.min(b.x0, b.x1) / MMV.s, uy = MMV.y + Math.min(b.y0, b.y1) / MMV.s;
        // centre the chosen area in the visible part of the canvas
        MMV.x = ux + rw / MMV.s / 2 - cw / s2 / 2; MMV.y = uy + rh / MMV.s / 2 - visH / s2 / 2 - top0 / s2;
        MMV.s = s2; MMV.at = false;
        mmApply();
        return;
      }
      pts.delete(ev.pointerId);
      if (pts.size < 2) pinch = null;
      if (!pts.size) { if (drag && drag.moved) host._dragged = Date.now(); drag = null; host.classList.remove("dragging"); }
    };
    host.addEventListener("pointerup", end);
    host.addEventListener("pointercancel", end);
    host.addEventListener("click", (ev) => {
      if (host._dragged && Date.now() - host._dragged < 350) { ev.stopPropagation(); ev.preventDefault(); host._dragged = 0; }
    }, true);
    host.addEventListener("wheel", (ev) => {                // Ctrl + wheel (or touchpad pinch) zooms towards the cursor; plain wheel / two-finger scroll scrolls the page
      if (!mmSvg()) return;
      if (!ev.ctrlKey && !ev.metaKey) {
        // drawing bigger than the view (zoomed in, or full screen fitted to the width): two-finger scroll / wheel moves
        // (pans) the drawing; when all of it is in view the wheel scrolls the page
        const over = MMV.vw * MMV.s > host.clientWidth + 2 || MMV.vh * MMV.s > host.clientHeight + 2;
        if (!over) { mmHint(host); return; }
        ev.preventDefault();
        const k = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? host.clientHeight : 1;
        const dx = ev.shiftKey && !ev.deltaX ? ev.deltaY : ev.deltaX, dy = ev.shiftKey && !ev.deltaX ? 0 : ev.deltaY;
        MMV.x += (dx * k) / MMV.s; MMV.y += (dy * k) / MMV.s; MMV.at = false;
        mmApply();
        return;
      }
      ev.preventDefault();
      const r = host.getBoundingClientRect(), px = ev.clientX - r.left, py = ev.clientY - r.top;
      // mouse wheel: big steps (a notch = 100 px or 1-3 lines) -> smooth glide; touchpad pinch: many tiny steps -> follow
      // the fingers directly (both stay smooth; the factor is the same per pixel)
      const notch = ev.deltaMode !== 0 || Math.abs(ev.deltaY) >= 40;
      const f = Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : notch ? 0.0022 : 0.01));
      if (notch) mmZoomSmooth(f, px, py); else mmZoomAt(f, px, py);
    }, { passive: false });
    host.addEventListener("keydown", (ev) => {              // arrow keys pan, + / − zoom, 0 = fit (when the mimic has focus)
      if (!mmSvg() || ev.altKey || ev.ctrlKey || ev.metaKey) return;
      const st = 48 / MMV.s, d = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] }[ev.key];
      if (d) { MMV.x += d[0]; MMV.y += d[1]; MMV.at = false; mmApply(); }
      else if (ev.key === "+" || ev.key === "=") mmZoomCenter(1.25);
      else if (ev.key === "-" || ev.key === "_") mmZoomCenter(0.8);
      else if (ev.key === "0") mmFit();
      else return;
      ev.preventDefault();
    });
    if (window.ResizeObserver) {
      let lw = 0, lh = 0;
      new ResizeObserver(() => {
        const w = host.clientWidth, h = host.clientHeight;
        if (!w || (w === lw && h === lh)) return;
        const wChanged = w !== lw;
        lw = w; lh = h;
        if (!mmSvg()) return;
        if (MMV.at) mmFit(); else { if (wChanged) mmLayout(); mmApply(); }
      }).observe(host);
    }
  }

  // ---------- v3 (SC04): active alerts that belong to the sheet on screen ----------
  // trip inputs of the machines (tag ids from the IO list configuration) -> machine
  const TRIP_EQ = {
    DI_Under_Grnd_Slud_Pmp_TO_VP_Mn_Tp: "OP_P1A", DI_Under_Grnd_Slud_Pmp_TO_VP_Stby_Tp: "OP_P1B", DI_Dry_Hot_Wtr_Inlet_Pmp_Vfd_Tp: "OP_P2",
    DI_Cool_Twr_Pmp_For_Su_Co_Of_Dry_Tp: "OP_P3", DI_Cool_Twr_Fn_For_Su_Co_Of_Dry_An_P2_Tp: "OP_F1", DI_Centrifug_Pmp_Su_Co_To_Degas_Tp: "OP_P4",
    DI_Filtrate_Tnk_Pmp_Main_Tp: "OP_P5A", DI_Filtrate_Tnk_Pump_Stby_Tp: "OP_P5B", DI_Undr_Grnd_Subm_Pmp_Mn_Tp: "OP_P6A", DI_Undr_Grnd_Subm_pmp_Stby_Tp: "OP_P6B",
    DI_Degf_Phe_Cool_Twr_Wtr_Cirul_Pmp_Tp: "OP_P7", DI_Gvt_Tnk_To_wtp_Phe_Wtr_Pmp_Tp: "OP_P8", DI_Degasifier_Exhaust_Blower_Hot_Air_Blower_Trip: "OP_M1",
    DI_Degf_Cirul_Wtr_Pmp_Tp: "OP_P9", DI_Turb_Oil_Cool_Cirul_Pmp_Tp: "OP_P10", DI_Trub_Oil_Cool_Twr_Fan_Tp: "OP_F2", DI_Blr_Cool_Wtr_Pmp_Tp: "OP_P11",
    DI_Acid_Dosing_Pump_Trip: "OP_P12", DI_Base_Dosing_Pmp_Tp: "OP_P13", DI_Make_Up_Wtr_Pmp_Mn_Tp: "OP_P14", DI_Make_Up_Wtr_Pmp_Stby_Tp: "OP_P15",
    DI_Prog_Cavity_Pmp_Tp: "PCP", DI_Agita_Prop_Mix_For_Slud_Tnk_Tp: "AGIT",
  };
  function sheetSig(box) {                               // every signal and machine drawn on the sheet
    const tags = new Set(), eqs = new Set();
    box.querySelectorAll("[data-tag],[data-val],[data-vals],[data-lvl],[data-sw],[data-swl],[data-lv],[data-spv],[data-eq],[data-flow]").forEach((el) => {
      const d = el.dataset;
      [d.tag, d.val, d.lvl, d.sw].forEach((v) => v && tags.add(v));
      (d.vals || "").split(",").forEach((v) => v && tags.add(v));
      (d.swl || "").split(",").forEach((v) => v && tags.add(v.split(":")[0]));
      if (d.lv) tags.add(d.lv.split(":")[0]);
      if (d.spv && d.spv.startsWith("alm:")) tags.add(d.spv.split(":")[1]);
      if (d.eq) eqs.add(d.eq);
      (d.flow || "").split(",").forEach((v) => v && eqs.add(v));
    });
    return { tags, eqs };
  }
  function mmAlerts(box) {
    const el = $("mimicAlerts");
    if (!el || !live) return;
    const s = SHEETS[sheet], all = live.alarms || [];
    if (!box._sig && !s.d3) box._sig = sheetSig(box);
    const sig = box._sig || { tags: new Set(), eqs: new Set() };
    const wide = (a) => a.tag === "_COMM" || ((live.aux || {})[a.tag] || {}).group === "Safety";
    const mine = all.filter((a) => s.overall || s.d3 || wide(a) || sig.tags.has(a.tag) || sig.tags.has(String(a.tag || "").replace(/_ALM$/, "")) || sig.eqs.has(TRIP_EQ[a.tag]))
      .sort((a, b) => (a.priority === "red" ? 0 : 1) - (b.priority === "red" ? 0 : 1) || (b.raised_at || 0) - (a.raised_at || 0));
    const others = all.length - mine.length;
    const more = others > 0 ? `<a class="mm-al-more" href="#alarms">${others} other alert${others > 1 ? "s" : ""} in the plant</a>` : "";
    const html = !mine.length
      ? `<span class="mm-al-ok"><i aria-hidden="true"></i>No active alerts on this ${s.overall || s.d3 ? "plant" : "sheet"}</span>${more}`
      : `<span class="mm-al-n">${mine.length} active alert${mine.length > 1 ? "s" : ""}</span>${mine.slice(0, 4).map((a) =>
          `<span class="mm-al ${a.priority === "red" ? "red" : "yel"}${a.acked_at ? " ack" : ""}" title="${esc(a.tag_name || "")}${a.acked_at ? " - acknowledged" : ""}"><b aria-hidden="true">${a.priority === "red" ? "✕" : "⚠"}</b>${esc(a.message || a.tag_name || "")}</span>`).join("")}
         ${mine.length > 4 ? `<span class="mm-al-n">+${mine.length - 4} more</span>` : ""}<a class="mm-al-more" href="#alarms">Open alarms</a>${others > 0 ? more : ""}`;
    if (el._h !== html) { el._h = html; el.innerHTML = html; }
    el.classList.toggle("has", mine.length > 0);
  }

  // ---------- open one machine on the mimic (client review 17-11-2026: click the tag on the Equipment page) ----------
  // the area sheet that draws it (else the overall plant), zoomed in on it, flashing, with its details pop-over
  let mmFocusId = null;
  const mmSheetOf = {};
  function sheetFor(id) {
    if (mmSheetOf[id] !== undefined) return mmSheetOf[id];
    const a = AREAS.find((x) => !x.overall && (x.eq || []).includes(id) && SHEETS[x.id]);
    const has = (k) => { try { return SHEETS[k] && !SHEETS[k].d3 && sheetSVG(SHEETS[k]).includes(`data-eq="${id}"`); } catch (_) { return false; } };
    const k = a && has(a.id) ? a.id : AREAS.filter((x) => !x.overall).map((x) => x.id).find(has) || (has("overall") ? "overall" : null);
    return (mmSheetOf[id] = k);
  }
  function showOnMimic(id) {
    const k = sheetFor(id);
    if (!k) return false;
    setSheet(k);
    const go = () => { mmFocusId = id; const b = $("mimicSvg"); if (b && b._sheet !== k) b._sheet = null; if (live) renderMimic(); };
    if (location.hash !== "#mimic") {
      location.hash = "#mimic";                         // the page switch draws the sheet first; zoom in once it has settled
      setTimeout(go, 450);
    } else go();
    return true;
  }
  function mmFocusEq() {
    const id = mmFocusId, svg = mmSvg(), host = $("mimicHost"), card = $("mimicCard");
    if (!id || !svg || !host || !host.clientWidth) return;
    mmFocusId = null;
    const g = svg.querySelector(`g.eq[data-eq="${CSS.escape(id)}"]`);
    if (!g) return;
    if (card) card.scrollIntoView({ block: "start" });
    const b = g.getBBox(), cw = host.clientWidth, hr = host.getBoundingClientRect();
    const top0 = Math.max(0, -hr.top), visH = Math.max(120, Math.min(host.clientHeight - top0, window.innerHeight - Math.max(0, hr.top)));
    const s2 = clampN(Math.min(cw / (b.width + 320), visH / (b.height + 220)), MMV.fit, MMV.fit * 3);
    MMV.s = s2; MMV.x = b.x + b.width / 2 - cw / s2 / 2; MMV.y = b.y + b.height / 2 - (top0 + visH / 2) / s2; MMV.at = false;
    mmApply();
    g.classList.remove("eq-find"); void g.getBBox(); g.classList.add("eq-find");
    setTimeout(() => g.classList.remove("eq-find"), 4200);
    eqPop(id, g, "mimicPop", $("mimicSvg"));
  }

  function renderMimic() {
    const tabs = $("mimicTabs"), box = $("mimicSvg");
    if (!tabs || !box) return;
    if (!mmUser) sheet = "overall";                      // open on the overall plant first
    if (!SHEETS[sheet]) sheet = "overall";              // a remembered sheet that no longer exists
    mmBind();
    const is3d = !!SHEETS[sheet].d3, tabSel = is3d ? "overall" : sheet;
    if (tabs._sheet !== sheet) {
      tabs._sheet = sheet;
      let n = 0;
      // area tabs (3D is the 2D / 3D switch beside the heading, not a tab); picking an area always shows its 2D sheet
      tabs.innerHTML = AREAS.map((a) => `<button role="tab" aria-selected="${a.id === tabSel}" class="${a.id === tabSel ? "active" : ""}${a.overall ? " all" : ""}" data-s="${a.id}"><b>${a.overall ? "★" : ++n}</b> ${esc(a.name)}</button>`).join("");
      tabs.querySelectorAll("button").forEach((b) => (b.onclick = () => { setSheet(b.dataset.s); renderMimic(); }));
      const dim = $("mimicDim");
      if (dim) dim.querySelectorAll("button").forEach((b) => { const act = (b.dataset.d === "3d") === is3d; b.classList.toggle("active", act); b.setAttribute("aria-pressed", String(act)); });
      // 2D / 3D switch only on Overall plant (and its 3D view) - the area sheets are 2D only (user request 15-11-2026)
      if (dim) dim.hidden = tabSel !== "overall";
    }
    if (box._sheet !== sheet) {
      box._sheet = sheet;
      box._sig = null;
      const s = SHEETS[sheet], card = $("mimicCard");
      $("mimicTitle").textContent = s.name;
      $("mimicNote").textContent = s.note;
      if (card) card.classList.toggle("is-3d", is3d);
      const pop = $("mimicPop");
      if (pop) pop.classList.add("hidden");
      if (s.d3 && !window.Plant3D) {                     // 3D module (three.js) still loading: try again on the next update
        box._sheet = null;
        box.innerHTML = '<p class="muted" style="padding:40px;text-align:center">Loading the 3D plant…</p>';
        window.addEventListener("plant3d-ready", () => live && renderMimic(), { once: true });
        return;
      }
      if (s.d3) {                                        // 3D view: three.js scene, no SVG drawing
        box.innerHTML = "";
        mmLayout();
        $("mimicLegend").innerHTML = "";
        Plant3D.mount(box, {
          pct: (id) => { const t = tag(id); return t ? pct(t) : null; },
          sw: (key) => sw(SW[key] || key),
          tagTxt: (id) => { const t = tag(id); if (!t || num(t) == null) return null; const p = pct(t); return `${fmt(t)} ${t.unit || ""}${p == null ? "" : ` · ${Math.round(p)} %`}`.trim(); },
          val: (id) => { const t = tag(id); return t && num(t) != null ? `${fmt(t)} ${t.unit || ""}`.trim() : null; },
          tagName: (id) => { const t = tag(id); return t ? t.name : ""; },
          over: (id) => { const t = tag(id), v = num(t), sp = auxNum(`${id}_ALM_SP`); return v != null && sp != null && t.group !== "Analysis" && v >= sp; },
          pid: (id) => PID[id] || id,
          stateTxt: (e) => (e.type === "valve" ? vState(e).txt.split(" - ")[0] : STATE_TXT[e.status] || e.status),
          valve: (e) => vState(e).k,                     // v3 (SC05): same valve rule as the 2D sheets
          flowOn: (ids) => flowOn(ids),
        }, (id, x, y) => eqPop(id, { getBoundingClientRect: () => ({ left: x - 6, right: x + 6, top: y - 6, bottom: y + 6, width: 12, height: 12 }) }, "mimicPop", $("mimicHost") || box));
      } else {
        if (window.Plant3D) Plant3D.unmount();
        box.innerHTML = sheetSVG(s);
        const svg = mmSvg();
        MMV.vw = +svg.dataset.vw; MMV.vh = +svg.dataset.vh; MMV.fs = +svg.dataset.fs || 1;
        $("mimicLegend").innerHTML = legend();
        bindSheet(box, (id) => { setSheet(id); renderMimic(); }, "mimicPop");
        mmFit();                                         // whole sheet in view first
      }
    }
    mmAlerts(box);
    if (SHEETS[sheet].d3) { if (window.Plant3D) Plant3D.update(live); return; }
    if (MMV.at && mmSvg() && !mmSvg().getAttribute("preserveAspectRatio")) mmFit();   // section was hidden at build time
    patchMimic(box);
    if (mmFocusId) mmFocusEq();
  }
  // shared fills used by the stylesheet (url(#gRun) etc.): one always-rendered copy for every drawing on the page -
  // gradients inside a hidden page section would not paint
  function ensureDefs() {
    if ($("mmDefs")) return;
    const d = document.createElement("div");
    d.innerHTML = `<svg id="mmDefs" class="mimic" width="0" height="0" aria-hidden="true" focusable="false"
        style="position:absolute;width:0;height:0;overflow:hidden;min-width:0"><defs>
          <linearGradient id="gCT" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#b9bdb4"/><stop offset=".35" stop-color="#eef0ea"/><stop offset=".7" stop-color="#d4d8cf"/><stop offset="1" stop-color="#a3a89d"/></linearGradient>
          <linearGradient id="gWater" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8cc4f0"/><stop offset="1" stop-color="#2f7fd1"/></linearGradient>
          <linearGradient id="gMetal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f4f1"/><stop offset=".45" stop-color="#c9c9c3"/><stop offset="1" stop-color="#85857e"/></linearGradient>
          <linearGradient id="gRun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b9ec7c"/><stop offset=".5" stop-color="#4fa612"/><stop offset="1" stop-color="#2b6a06"/></linearGradient>
          <linearGradient id="gStop" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ecece8"/><stop offset=".5" stop-color="#a9a9a2"/><stop offset="1" stop-color="#6f6f68"/></linearGradient>
          <linearGradient id="gTrip" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb3b3"/><stop offset=".5" stop-color="#d93a3f"/><stop offset="1" stop-color="#8d1c1f"/></linearGradient>
          <linearGradient id="gWarn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe2a0"/><stop offset=".5" stop-color="#e09a12"/><stop offset="1" stop-color="#8a5800"/></linearGradient>
          <pattern id="hatch" width="8" height="8" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><rect width="8" height="8" class="hatch-bg"/><line x1="0" y1="0" x2="0" y2="8" class="hatch-ln"/></pattern></defs></svg>`;
    document.body.prepend(d.firstElementChild);
  }
  // the drawing of one sheet (SVG string); idp prefixes the SVG ids (arrows, clip paths) so two drawings can be on the page at once
  // straight segments of a pipe path (mimic pipes use absolute M / L only)
  function pipeSegs(d) {
    const segs = [];
    let cx = 0, cy = 0;
    String(d).replace(/([ML])\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/g, (_, c, x, y) => { x = +x; y = +y; if (c === "L") segs.push([cx, cy, x, y]); cx = x; cy = y; return ""; });
    return segs;
  }
  // v3 (SC04): flow-direction chevrons at regular intervals on long runs, in the drawn direction (source → destination);
  // each one is moved a little along the line if it would sit on a valve, gauge, label or another chevron
  function chevrons(p) {
    if (!p.arrows) return "";
    const segs = pipeSegs(p.d), SP = 130, MIN = 110;
    const hit = (x, y, r) => OB.some(([a, b, c, d]) => x > a - r && x < c + r && y > b - r && y < d + r);
    let out = "";
    segs.forEach(([x1, y1, x2, y2], si) => {
      const L = Math.hypot(x2 - x1, y2 - y1);
      if (L < MIN) return;
      const ux = (x2 - x1) / L, uy = (y2 - y1) / L, n = Math.max(1, Math.floor(L / SP));
      const end = si === segs.length - 1 ? 34 : 22;     // keep clear of the arrowhead at the end of the line
      for (let i = 1; i <= n; i++) {
        const t0 = (i / (n + 1)) * L;
        for (const dt of [0, 14, -14, 28, -28, 42, -42, 56, -56]) {
          const t = t0 + dt;
          if (t < 22 || t > L - end) continue;
          const px = x1 + ux * t, py = y1 + uy * t;
          if (hit(px, py + p.oy, 7)) continue;
          const f = (a, b) => `${(px + ux * a - uy * b).toFixed(1)} ${(py + uy * a + ux * b).toFixed(1)}`;
          out += `<path class="pa k-${p.kind}" d="M${f(7, 0)} L${f(-5, -6)} L${f(-5, 6)} Z"/>`;
          ob(px - 7, py - 7 + p.oy, px + 7, py + 7 + p.oy);
          break;
        }
      }
    });
    return out;
  }
  function sheetSVG(s, idp = "") {
    ensureDefs();
    const [vw, vh] = s.vb || [W, H];                  // the overall sheet uses a larger drawing area
    FS = s.fs || 1; PIPES = []; OB = []; OY = 0;
    const body = s.draw().join("").replace(/<!--AR(\d+)-->/g, (_, i) => chevrons(PIPES[+i]));
    let svg = `<svg viewBox="0 0 ${vw} ${vh}" class="mimic${s.vb ? " big" : ""}" style="--fs:${FS}" role="img" aria-label="${esc(s.name)} process mimic" data-vw="${vw}" data-vh="${vh}" data-fs="${FS}">
        <defs>
          ${[["water", "#2f7fd1"], ["hot", "#e8731a"], ["sludge", "#a8781e"], ["steam", "#c43d3d"], ["air", "#1fb5b5"], ["chem", "#8e44c9"], ["ctp", "#3a3f2a"]]
            .map(([k, c]) => `<marker id="ar-${k}" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="${c}"/></marker>`).join("")}</defs>
        ${body}</svg>`;
    FS = 1;
    if (idp) svg = svg.replace(/(\s)id="/g, `$1id="${idp}`).replace(/url\(#/g, `url(#${idp}`);
    return svg;
  }
  function bindSheet(box, goto, popId) {
    box.querySelectorAll("[data-eq]").forEach((g) => {
      g.onclick = () => eqPop(g.dataset.eq, g, popId, box);
      g.onkeydown = (ev) => { if (ev.key === "Enter") eqPop(g.dataset.eq, g, popId, box); };
    });
    box.querySelectorAll("[data-tag]").forEach((g) => (g.onclick = () => MD.openTag(g.dataset.tag)));
    box.querySelectorAll("[data-goto]").forEach((g) => {
      g.onclick = () => goto(g.dataset.goto);
      g.onkeydown = (ev) => { if (ev.key === "Enter") g.onclick(); };
    });
  }
  // Auto / Manual badge on every machine that has an HMI A/M selector (like the HMI mimic): "AUTO" green, "MAN" amber.
  // Placed above the motor (or the symbol) once the drawing is on screen; the text follows the PLC bit every update.
  const SVGNS = "http://www.w3.org/2000/svg";
  // Exception only (user request 16-11-2026, the drawing was too crowded): Auto is the normal state and gets no badge;
  // a machine switched to Manual shows the amber "MAN" badge. Auto / Manual stays in each machine's details.
  function amBadge(svg, g, e) {
    let b = svg.querySelector(`g.am-b[data-am="${g.dataset.eq}"]`);
    if (!e || e.auto == null || e.auto) { if (b) b.remove(); return; }
    // level lines move after the first draw: if one now sits under the badge, place the badge again
    if (b) {
      const br = b.querySelector("rect").getBoundingClientRect();
      // (any label now under the badge - e.g. labels that were hidden at the zoom when the badge was placed)
      const hit = br.width && !b.dataset.forced && [...svg.querySelectorAll("text, .lamp rect")].filter((t) => !t.closest(".am-b")).some((t) => { const r = t.getBoundingClientRect();
        return r.width && !(r.right < br.left + 1 || r.left > br.right - 1 || r.bottom < br.top + 1 || r.top > br.bottom - 1); });
      if (hit) { b.remove(); b = null; }
    }
    if (!b) {
      // v3 (SC04): anchor on the motor / actuator, never on a rotating part (the side mixer has no .pm-motor: its first
      // circle was the propeller hub, so the badge sat on the propeller)
      const shape = g.querySelector(".pm-motor") || g.querySelector(".ag-mot") || g.querySelector(".act") || g.querySelector("circle") || g.querySelector("path");
      const r = shape && shape.getBoundingClientRect(), m = svg.getScreenCTM();
      if (!r || !r.width || !m) return;                  // sheet not on screen yet: try again on the next update
      const inv = m.inverse();
      const toSvg = (rc) => { const a = new DOMPoint(rc.left, rc.top).matrixTransform(inv), c = new DOMPoint(rc.right, rc.bottom).matrixTransform(inv);
        return { l: Math.min(a.x, c.x), t: Math.min(a.y, c.y), r: Math.max(a.x, c.x), b: Math.max(a.y, c.y) }; };
      const s = toSvg(r), cx = (s.l + s.r) / 2, cy = (s.t + s.b) / 2;
      // first free spot (no text, no other badge) of: above, right, left, below the motor / symbol
      const busy = [...svg.querySelectorAll("text")].filter((t) => !t.closest(".am-b")).map((t) => t.getBoundingClientRect()).filter((x) => x.width).map(toSvg)
        // level / switch lamps and tank readouts are wider than their text: keep the badge off the whole pill
        .concat([...svg.querySelectorAll(".am-b rect, .lamp rect, .t-read rect")].map((x) => x.getBoundingClientRect()).filter((x) => x.width).map(toSvg))
        .concat([...svg.querySelectorAll(".lv-ln text")].map((x) => x.getBoundingClientRect()).filter((x) => x.width).map(toSvg)
          .map((o) => ({ l: o.l - 6, t: o.t - 4, r: o.r + 6, b: o.b + 4 })))
        // every machine / package part (shafts, propellers, impellers, valve bodies) and every chevron: badge never covers them
        .concat([...svg.querySelectorAll("[data-eq] :is(rect,circle,path,line), .pk :is(rect,circle,path,line), .pa, .hv, .nrv path, .gauge circle")]
          .map((x) => x.getBoundingClientRect()).filter((x) => x.width || x.height).map(toSvg));
      const fs = +svg.dataset.fs || 1, bw = 48 * fs, bh = 20 * fs;   // text 15 units × sheet scale (≥ 12 px at fit)
      // texts (labels / tags / values) must never be covered; shapes only as a last resort
      const nText = [...svg.querySelectorAll("text")].filter((t) => !t.closest(".am-b") && t.getBoundingClientRect().width).length;
      // whole drawing (the viewBox itself changes with zoom / pan): 0 0 MMV.vw MMV.vh
      const full = MMV && MMV.vw ? [0, 0, MMV.vw, MMV.vh] : null;
      const inside = ([x, y]) => !full || (x >= full[0] + 2 && y >= full[1] + 2 && x + bw <= full[0] + full[2] - 2 && y + bh <= full[1] + full[3] - 2);
      const cost = ([x, y]) => {
        if (!inside([x, y])) return 1e9;
        let c = 0;
        busy.forEach((o, i) => { if (!(o.r < x - 1 || o.l > x + bw + 1 || o.b < y - 1 || o.t > y + bh + 1)) c += i < nText ? 1000 : 1; });
        return c;
      };
      // same corner first on every symbol (top-right), then above, right, left, below, then further out
      const spots = [[s.r + 4, s.t - bh - 2], [cx - bw / 2, s.t - bh - 4], [s.r + 4, cy - bh / 2], [s.l - bw - 4, cy - bh / 2], [cx - bw / 2, s.b + 4],
        [s.l - bw - 4, s.t - bh - 2], [s.r + 4, s.b + 2], [s.l - bw - 4, s.b + 2], [cx - bw / 2, s.t - 2 * bh - 8], [s.r + bw / 2, s.t - bh - 2],
        [s.l, s.t - bh - 4], [s.r - bw, s.t - bh - 4], [s.r + 8, s.t - 2 * bh - 6], [s.l - bw - 8, s.t - 2 * bh - 6], [s.r + bw + 8, cy - bh / 2],
        [cx - bw / 2, s.b + bh + 10], [s.l - 2 * bw - 8, cy - bh / 2]];
      let best = spots[0], bestC = Infinity;
      for (const p of spots) { const c = cost(p); if (c < bestC) { best = p; bestC = c; } if (c === 0) break; }
      const [bx, by] = best;
      b = document.createElementNS(SVGNS, "g");
      b.setAttribute("class", "am-b");
      b.dataset.am = g.dataset.eq;
      if (bestC >= 1000) b.dataset.forced = "1";        // no label-free spot exists: don't keep re-placing it every update
      b.innerHTML = `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${bh / 2}"/><text x="${bx + bw / 2}" y="${by + bh / 2 + 5 * fs}" text-anchor="middle"></text>`;
      svg.appendChild(b);
    }
    const man = !e.auto;
    b.classList.toggle("man", man);
    b.querySelector("text").textContent = man ? "MAN" : "AUTO";
  }
  function patchMimic(box) {
    const svg = box.querySelector("svg");
    box.querySelectorAll("[data-eq]").forEach((g) => {
      const e = eq(g.dataset.eq), base = g.getAttribute("class").replace(/\s(run|stop|trip|warn|unk|v-[a-z-]+)\b/g, "");
      const t = g.querySelector("title") || g.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "title"));
      if (g.classList.contains("valve")) {                 // v3 (SC05): confirmed / commanded / unknown, see vState
        const v = vState(e), cue = g.querySelector(".v-cue");
        g.setAttribute("class", `${base} v-${v.k}`);
        if (cue) cue.textContent = v.cue;
        t.textContent = `${e ? `${e.name} (${PID[e.id] || e.tag_no})` : PID[g.dataset.eq] || g.dataset.eq} - ${v.txt}${e ? ` · ${modeTxt(e)}` : ""}`;
      } else {
        g.setAttribute("class", `${base} ${eqCls(e)}`);
        t.textContent = e ? `${e.name} (${PID[e.id] || e.tag_no}) - ${STATE_TXT[e.status] || e.status} · ${modeTxt(e)}` : "No data";
      }
      if (svg && g.dataset.eq) amBadge(svg, g, e);
    });
    // v3 (SC05): a line flows only while its IO machine runs and its valves are confirmed open (same rule on every sheet)
    box.querySelectorAll("[data-flow]").forEach((p) => {
      const ids = p.dataset.flow ? p.dataset.flow.split(",") : [], need = p.dataset.need ? p.dataset.need.split(",") : [];
      p.classList.toggle("on", flowOn(ids, need));
    });
    box.querySelectorAll("[data-val]").forEach((el) => {
      const t = tag(el.dataset.val);
      el.textContent = t ? `${fmt(t)} ${t.unit || ""}` : "--";
    });
    box.querySelectorAll("[data-vals]").forEach((el) => {
      el.textContent = el.dataset.vals.split(",").map((id) => { const t = tag(id); return t ? `${fmt(t)} ${t.unit || ""}`.trim() : "--"; }).join(" · ");
    });
    box.querySelectorAll("[data-spv]").forEach((el) => {       // set points from the PLC / HMI
      const [k, id, lk] = el.dataset.spv.split(":");
      let v = "--";
      if (k === "aux") v = spIsPct(id) ? spTxt(tag(id.startsWith("SP_SLUDGE") ? "LT_01" : id.slice(0, 5)), id) : auxTxt(id);
      else if (k === "alm") v = auxTxt(`${id}_ALM_SP`);
      else if (k === "lv") {
        const t = tag(id), lv = levelsOf(t), sid = `${id}_${lk.toUpperCase()}_SP`;
        if (lv && lv[lk] != null) v = plcLevels(t) && spIsPct(sid) ? spTxt(t, sid)
          : `${Number(lv[lk]).toFixed(t.decimals ?? 0)} ${t.unit || ""}${plcLevels(t) ? "" : " *"}`.trim();
      }
      if (k === "alm" && el.dataset.pre) {
        if (v === "--" && !((live.aux || {})[`${id}_ALM_SP`])) { el.textContent = ""; return; }
        if (v !== "--" && !/[a-z%°]/i.test(v)) { const t = tag(id); if (t && t.unit) v += ` ${t.unit}`; }
      }
      el.textContent = (el.dataset.pre || "") + v;
    });
    // package equipment (not in our IO list, no signal to this panel): drawn as per the P&ID but NOT animated -
    // no running / stopped state is guessed from other motors (user request 2026-11-04)
    box.querySelectorAll("[data-run]").forEach((g) => {
      if (g.classList.contains("na")) return;
      g.classList.remove("run", "stop");
      g.classList.add("na");
      const t = g.querySelector(":scope > title") || g.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "title"));
      t.textContent = "Package equipment - not in the panel IO list, no signal: shown for reference only (not animated)";
    });
    box.querySelectorAll("[data-pct]").forEach((el) => { const p = pct(tag(el.dataset.pct)); el.textContent = p == null ? "" : `${Math.round(p)} %`; });
    box.querySelectorAll("[data-lvl]").forEach((r) => fillRect(r, pct(tag(r.dataset.lvl))));
    box.querySelectorAll("[data-swl]").forEach((r) => {      // switch-only tanks: indicative level up to the highest switch that is ON
      let p = null;
      r.dataset.swl.split(",").forEach((s) => {
        const [id, at] = s.split(":"), v = sw(id);
        if (v == null) return;
        p = Math.max(p ?? 6, v ? (1 - +at) * 100 + 4 : 6);
      });
      fillRect(r, p == null ? null : clamp(p));
    });
    box.querySelectorAll("[data-sw]").forEach((g) => {
      const v = sw(g.dataset.sw);
      g.setAttribute("class", `lamp ${v == null ? "nd" : v ? "on" : "off"}`);
    });
    box.querySelectorAll("[data-lv]").forEach((g) => {          // HH / H / L / LL lamps from the level value
      const [id, k] = g.dataset.lv.split(":"), t = tag(id), v = lvActive(t, k), lv = levelsOf(t);
      g.setAttribute("class", `lamp lvl ${v == null ? "nd" : v ? `on ${k}` : "off"}`);
      const tt = g.querySelector("title") || g.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "title"));
      tt.textContent = lv ? `${k.toUpperCase()} set point ${Number(lv[k]).toFixed(0)} ${t.unit || ""}${t.levels ? "" : " (default)"}` : "";
    });
    const lvRows = {};                                            // tank -> [{k, y}] of the visible set-point lines
    box.querySelectorAll("[data-lvln]").forEach((g) => {        // dashed set-point lines inside the tank
      const [id, k] = g.dataset.lvln.split(":"), t = tag(id), lv = levelsOf(t), p = lv ? pct(t, lv[k]) : null;
      g.style.display = p == null ? "none" : "";
      if (p == null) return;
      const y = +g.dataset.y0 + +g.dataset.h * (1 - p / 100);
      const ln = g.querySelector("line");
      ln.setAttribute("y1", y); ln.setAttribute("y2", y);
      (lvRows[id] ||= { lo: +g.dataset.lo, hi: +g.dataset.hi, rows: [] }).rows.push({ k, y });
    });
    // each HH / H / L / LL lamp at the height of its line (lamps never overlap, and stay in the band given by lvAt), with
    // a leader from the tank wall at the line to the lamp
    Object.entries(lvRows).forEach(([id, { lo, hi, rows }]) => {
      const gap = T(22) + 3;
      rows.sort((a, b) => a.y - b.y);
      rows.forEach((r, i) => (r.ly = Math.max(lo, r.y, i ? rows[i - 1].ly + gap : -Infinity)));
      for (let i = rows.length - 1; i >= 0; i--) rows[i].ly = Math.min(rows[i].ly, i === rows.length - 1 ? hi : rows[i + 1].ly - gap);
      rows.forEach(({ k, y, ly }) => {
        const lamp = box.querySelector(`.lamp.lvl[data-lv="${id}:${k}"]`), lead = box.querySelector(`[data-lvlead="${id}:${k}"]`);
        if (lamp) lamp.setAttribute("transform", `translate(0 ${(ly - +lamp.dataset.cy).toFixed(1)})`);
        if (lead) { lead.setAttribute("y1", y.toFixed(1)); lead.setAttribute("y2", ly.toFixed(1)); }
      });
    });
    box.querySelectorAll("[data-dot]").forEach((g) => {        // overall sheet: equipment state dots
      const e = eq(g.dataset.dot);
      g.setAttribute("class", `dot ${eqCls(e)}`);
      const t = g.querySelector("title") || g.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "title"));
      t.textContent = e ? `${e.name} - ${STATE_TXT[e.status] || e.status}` : "No data";
    });
    box.querySelectorAll(".area[data-goto]").forEach((g) => {  // area border: red if anything in it tripped
      const ids = [...g.querySelectorAll("[data-dot]")].map((d) => d.dataset.dot);
      g.classList.toggle("trip", ids.some((id) => eqCls(eq(id)) === "trip"));
    });
  }
  function fillRect(r, p) {
    const y0 = +r.dataset.y0, h = +r.dataset.h, fh = p == null ? 0 : (h * p) / 100;
    r.setAttribute("y", y0 + h - fh);
    r.setAttribute("height", fh);
  }
  // small equipment pop-over on the mimic
  function eqPop(id, g, popId = "mimicPop", hostBox = $("mimicSvg")) {
    const e = eq(id);
    const pop = $(popId);
    if (!e || !pop) return;
    pop.innerHTML = `<div class="mp-h"><b>${esc(e.name)}</b><button class="btn sm" id="mpX" aria-label="Close">✕</button></div>
      <dl class="kv"><dt>P&amp;ID tag</dt><dd>${esc(PID[e.id] || e.tag_no || "-")}</dd>
      ${e.type === "valve" ? (() => {                    // v3 (SC05): position + the four signals behind it
        const v = vState(e), io = e.io || {}, sig = (x) => (x == null ? "no data" : x ? "ON" : "OFF");
        return `<dt>Position</dt><dd><span class="kp-eq mm-vp v-${v.k}"><i></i>${esc(v.txt)}</span></dd>
          <dt>Open limit switch</dt><dd>${sig(io.open)}</dd><dt>Closed limit switch</dt><dd>${sig(io.close)}</dd>
          <dt>Open command</dt><dd>${sig(io.open_cmd)}</dd><dt>Close command</dt><dd>${sig(io.close_cmd)}</dd>`;
      })() : `<dt>State</dt><dd><span class="kp-eq ${eqCls(e)}"><i></i>${esc(STATE_TXT[e.status] || e.status)}</span></dd>`}
      <dt>Mode</dt><dd>${esc(modeTxt(e))}</dd>
      ${e.type === "motor" ? `<dt>Run hours</dt><dd class="num">${e.run_hours ?? "-"} h</dd>` : ""}
      ${e.kw ? `<dt>Rating</dt><dd>${esc(String(e.kw))} kW</dd>` : ""}</dl>`;
    const r = g.getBoundingClientRect(), host = hostBox.getBoundingClientRect();
    pop.style.left = `${Math.min(host.width - 260, Math.max(0, r.left - host.left + r.width / 2 - 130))}px`;
    pop.style.top = `${r.bottom - host.top + 8}px`;
    pop.classList.remove("hidden");
    // v3: the canvas clips (zoom / pan) - open above the symbol when there is no room under it
    const ph = pop.offsetHeight;
    if (r.bottom - host.top + 8 + ph > host.height) pop.style.top = `${Math.max(0, r.top - host.top - ph - 8)}px`;
    pop.querySelector("#mpX").onclick = () => pop.classList.add("hidden");
  }

  // ======================================================================================
  // INSTRUMENTS - every transmitter with its range, PLC scaling and live 4-20 mA signal
  // ======================================================================================
  const INST_GROUPS = ["Level", "Pressure", "Temperature", "Analysis"];
  let editing = null;                                    // instrument id whose scaling pop-up is open
  function renderInstruments() {
    const box = $("instGrid");
    if (!box) return;
    const list = live.tags.filter((t) => INST_GROUPS.includes(t.group))
      .sort((a, b) => INST_GROUPS.indexOf(a.group) - INST_GROUPS.indexOf(b.group));
    box.innerHTML = list.map((t) => {
      const p = pct(t), d = t.decimals ?? 1;
      const sp = t.setpoint_value, spp = pct(t, sp);
      const f = (x, dd = d) => (x == null ? "--" : Number(x).toFixed(dd));
      const zone = p == null ? "" : p < 10 ? "Very low" : p < 30 ? "Low" : p > 90 ? "Very high" : p > 75 ? "High" : "Normal";
      const overSp = sp != null && num(t) != null && num(t) >= sp;
      // alarm set point outside what the instrument can measure (e.g. range 0-20 °C, alarm 170 °C): the alarm can never come
      const outR = sp != null && t.eng_min != null && t.eng_max != null && (sp > t.eng_max || sp < t.eng_min);
      const u = esc(t.unit || ""), aux = live.aux || {};
      const almId = [t.setpoint_tag, `${t.id}_ALM_SP`].find((k) => k && aux[k] && aux[k].writable);
      const acts = `<div class="in-act">${canWrite() && almId ? `<button type="button" class="btn sm${outR ? " primary" : ""}" data-alm="${esc(almId)}">Change alarm</button>` : ""}
        <button type="button" class="btn sm${outR ? " primary" : ""}" data-scale="${esc(t.id)}" title="Lowest / highest value of this instrument (IO list › Analog inputs)">Scaling (min / max)</button></div>`;
      return `<div class="inst ${overSp ? "bad" : ""}${outR ? " out-range" : ""}" data-open="${esc(t.id)}" tabindex="0" role="button">
        <div class="in-h"><span class="in-g">${esc(t.group)}</span><span class="in-p">${esc(TAG_PID[t.id] || "")}</span></div>
        <div class="in-n">${esc(t.name.replace(/^[A-Z]+-\d+\s/, ""))}</div>
        <div class="in-v"><b class="num">${esc(fmt(t))}</b> <small>${esc(t.unit || "")}</small><span class="in-pc">${p == null ? "" : `${Math.round(p)} % · ${zone}`}</span></div>
        <div class="in-bar"><span class="ib-f" style="width:${p ?? 0}%"></span>${spp != null ? `<span class="ib-sp" style="left:${spp}%" title="Alarm at ${f(sp)}"></span>` : ""}</div>
        <div class="in-ends"><span>${f(t.eng_min, 0)}</span><span>${f(t.eng_max, 0)} ${esc(t.unit || "")}</span></div>
        ${sp != null ? `<div class="in-sc"><div class="sc-row"><span>Alarm at</span><b class="num">${f(sp)} ${u}</b>${overSp ? '<em class="hi">reached</em>' : ""}</div></div>` : ""}
        ${outR ? `<div class="in-oor" role="alert"><b>! Alarm ${f(sp)} ${u} is ${sp > t.eng_max ? "above" : "below"} the range ${f(t.eng_min, 0)} … ${f(t.eng_max, 0)} ${u}</b>
          The alarm can never come. Change the alarm value or the min / max range.</div>` : ""}
        ${acts}
        </div>`;
    }).join("") || '<div class="empty">No instruments</div>';
    box.querySelectorAll("[data-alm]").forEach((b) => (b.onclick = (ev) => { ev.stopPropagation(); openSpEdit(b.dataset.alm); }));
    box.querySelectorAll("[data-scale]").forEach((b) => (b.onclick = (ev) => { ev.stopPropagation(); openScaling(b.dataset.scale); }));
    box.querySelectorAll("[data-open]").forEach((el) => {
      el.onclick = () => MD.openTag(el.dataset.open);
      el.onkeydown = (ev) => { if (ev.key === "Enter" && ev.target === el) MD.openTag(el.dataset.open); };
    });
    $("instNote").textContent = `Each card is one measuring instrument. The bar shows where the value is in its range; the red mark is where the alarm comes. Scaling is set on IO list › Analog inputs. Updated ${fmtTime(live.status.last_update)}.`;
  }
  // scaling editor (IO list › Analog inputs), shown as a pop-up. "PLC" source: the new lowest / highest are WRITTEN
  // into the PLC scaling block (<AI>_RMIN / <AI>_RMAX, FC16, read back) - the PLC then scales with them and the
  // panel shows the same; the dashboard's display range follows. "Calculate on dashboard": dashboard config only.
  // an analog channel: a dashboard instrument, or a hidden one (spare) known from the IO list - spares get scaled too,
  // so the range is ready when the spare is put to use (user request 17-11-2026)
  const aiTag = (id) => tag(id) || ((ioData || []).find((x) => x.id === id && x.kind === "ai") || null);
  function openScaling(id) {
    const t = aiTag(id);
    if (!t) return;
    document.querySelector(".sc-modal")?.remove();
    const modal = document.createElement("div");
    modal.className = "sc-modal";
    modal.innerHTML = `<div class="sc-box" role="dialog" aria-modal="true"><div class="sc-head"><b>Scaling - ${esc(t.name)}</b>
      <button class="sc-x" type="button" aria-label="Close">✕</button></div><div class="in-sc"></div></div>`;
    document.body.appendChild(modal);
    const close = () => { modal.remove(); editing = null; renderIO(); };
    modal.querySelector(".sc-x").onclick = close;
    modal.onclick = (ev) => { if (ev.target === modal) close(); };
    const card = modal.querySelector(".sc-box");
    editing = id;
    const aux = live.aux || {}, me = window.MD_ME || {};
    const rMin = aux[`${id}_RMIN`], rMax = aux[`${id}_RMAX`];
    const plcOk = !!(rMin && rMax && rMin.writable && rMax.writable && me.can_operate);
    const curMin = auxNum(`${id}_RMIN`), curMax = auxNum(`${id}_RMAX`);
    const hasSig = auxNum(`${id}_MA`) != null || aux[`${id}_MA`];
    const plcSrc = t.scaling_mode !== "signal";
    const startMin = plcSrc && curMin != null ? curMin : t.eng_min ?? 0, startMax = plcSrc && curMax != null ? curMax : t.eng_max ?? 100;
    const sc = card.querySelector(".in-sc");
    sc.innerHTML = `<form class="sc-form" novalidate>
      <label>Value comes from<select name="source">
        <option value="plc" ${plcSrc ? "selected" : ""}>Plant (same as panel)</option>
        ${hasSig ? `<option value="signal" ${!plcSrc ? "selected" : ""}>Calculate on dashboard using this range</option>` : ""}</select></label>
      <div class="sc-2"><label>Lowest value<input name="range_min" type="number" step="any" value="${startMin}" required></label>
        <label>Highest value<input name="range_max" type="number" step="any" value="${startMax}" required></label></div>
      <label>Decimal places<input name="decimals" type="number" min="0" max="4" step="1" value="${t.decimals ?? 1}"></label>
      <p class="sc-hint" data-hint></p>
      <div class="sc-btns"><button class="btn sm primary" type="submit" data-save>Save</button><button class="btn sm" type="button" data-cancel>Cancel</button></div>
      <div class="sc-err" hidden></div></form>`;
    const form = sc.querySelector("form");
    const hint = () => {
      const plc = form.source.value === "plc";
      form.querySelector("[data-hint]").innerHTML = !plc
        ? "Lowest / highest = what the instrument can measure. Only this dashboard changes - the plant control is not changed."
        : plcOk ? `<b>Save writes this range into the plant control</b> (scaling min / max${rMin.value == null ? "" : `, now ${curMin ?? "--"} … ${curMax ?? "--"}`}): the plant calculates the value with it.`
          : !me.can_operate ? "Your account is view-only - it cannot change the plant range."
            : "Writing this range is not enabled (Settings › Tags › _RMIN / _RMAX).";
      form.querySelector("[data-save]").disabled = plc && !plcOk;
    };
    form.source.onchange = () => {
      if (form.source.value === "plc" && curMin != null && curMax != null) { form.range_min.value = curMin; form.range_max.value = curMax; }
      hint();
    };
    hint();
    form.onclick = (ev) => ev.stopPropagation();
    form.querySelector("[data-cancel]").onclick = close;
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const fd = new FormData(form), err = form.querySelector(".sc-err");
      const body = { id, source: fd.get("source"), range_min: +fd.get("range_min"), range_max: +fd.get("range_max"), decimals: +fd.get("decimals") };
      if (!(body.range_max > body.range_min)) { err.hidden = false; err.textContent = "Highest value must be greater than lowest value"; return; }
      err.hidden = true;
      try {
        if (body.source === "plc") {
          if (!plcOk) return;
          if (!confirm(`Write the scaling range of ${t.name}?\n\nLowest:  ${curMin ?? "--"}  →  ${body.range_min}\nHighest: ${curMax ?? "--"}  →  ${body.range_max}  ${t.unit || ""}\n\n`
            + "The plant will calculate this value with the new range.")) return;
          // write order keeps lowest < highest in the PLC at every moment
          const steps = curMax != null && body.range_min >= curMax
            ? [[`${id}_RMAX`, body.range_max], [`${id}_RMIN`, body.range_min]]
            : [[`${id}_RMIN`, body.range_min], [`${id}_RMAX`, body.range_max]];
          const back = {};
          for (const [tid, v] of steps) back[tid] = (await MD.api("/api/client/write", { method: "POST", body: { id: tid, value: v } }));
          await MD.api("/api/client/scaling", { method: "POST", body });          // dashboard display range follows the PLC
          const sim = Object.values(back).some((r) => r.simulated);
          MD.toast(`${t.name}: range ${back[`${id}_RMIN`].value} … ${back[`${id}_RMAX`].value} ${t.unit || ""}${sim ? " (demo mode - not written to the plant)" : " - read back from the plant"}`);
        } else {
          await MD.api("/api/client/scaling", { method: "POST", body });
          MD.toast(`Dashboard range saved for ${t.name} (plant not changed)`);
        }
        close();
      } catch (e) { err.hidden = false; err.textContent = e.message; }
    };
    form.querySelector("select").focus();
  }

  // ======================================================================================
  // DATA LOG (HMI data log screens) - interval table from the dashboard historian
  // ======================================================================================
  const DL_GROUPS = [["Temperature", ["Temperature"]], ["Pressure", ["Pressure"]], ["Level & pH", ["Level", "Analysis"]]];
  let dlGroup = 0, dlTags = null, dlLast = 0;
  async function renderDatalog(force) {
    const tbl = $("dlTable");
    if (!tbl) return;
    if (!force && Date.now() - dlLast < 60000) return;
    dlLast = Date.now();
    const seg = $("dlGroup");
    seg.innerHTML = DL_GROUPS.map(([l], i) => `<button class="${i === dlGroup ? "active" : ""}" data-i="${i}">${l}</button>`).join("");
    seg.querySelectorAll("button").forEach((b) => (b.onclick = () => { dlGroup = +b.dataset.i; renderDatalog(true); }));
    $("dlRange").onchange = $("dlInt").onchange = () => renderDatalog(true);
    try {
      if (!dlTags) dlTags = (await MD.api("/api/report/tags")).tags;
      const ids = dlTags.filter((t) => DL_GROUPS[dlGroup][1].includes(t.group)).map((t) => t.id);
      const to = Math.floor(Date.now() / 1000), from = to - +$("dlRange").value * 3600;
      const qs = `from=${from}&to=${to}&interval=${$("dlInt").value}&tags=${encodeURIComponent(ids.join(","))}`;
      const rep = await MD.api(`/api/report?${qs}`);
      $("dlXlsx").href = `/api/report.xlsx?${qs}`;
      const cols = rep.columns;
      const rows = rep.rows.slice().reverse();
      tbl.innerHTML = `<thead><tr><th>Date</th><th>Time</th>${cols.map((c) => `<th>${esc(c.name.replace(/^[A-Z]+-\d+\s/, ""))}<small>${esc(c.unit)}</small></th>`).join("")}</tr></thead>
        <tbody>${rows.map((r) => `<tr><td>${MD.istDate(r.t)}</td><td>${MD.fmtTime(r.t).slice(0, 5)}</td>
          ${r.values.map((v, i) => `<td class="num">${v == null ? "-" : Number(v).toFixed(cols[i].decimals)}</td>`).join("")}</tr>`).join("")}</tbody>`;
      $("dlNote").textContent = `${rows.length} rows · average per interval · newest first${live && live.status.state === "demo" ? " · DEMO DATA" : ""}`;
    } catch (e) { $("dlNote").textContent = e.message; }
  }

  // ======================================================================================
  // TANK LEVELS - actual level against the HH / H / L / LL set points set on the HMI (LT Set Point screen)
  // ======================================================================================
  const LV_TANKS = [
    { id: "LT_01", name: "Sludge storage tank", pid: "01-LT-101", fluid: "sludge", inlet: "MV_01", outlet: ["OP_P1A", "OP_P1B"], mixer: "AGIT",
      plc: [["Pump start", "SP_SLUDGE_PUMP_START"], ["Pump stop", "SP_SLUDGE_PUMP_STOP"], ["Valve open", "SP_SLUDGE_VALVE_OPEN"], ["Valve close", "SP_SLUDGE_VALVE_CLOSE"]] },
    { id: "LT_02", name: "Filtrate tank", pid: "01-LT-102", fluid: "water", outlet: ["OP_P5A", "OP_P5B"], plc: [] },
  ];
  const SW_TANKS = [
    { name: "Raw water storage tank", pid: "03-LS-301", sw: [["LS301_HL", "HL"], ["LS301_LL", "LL"]] },
    { name: "Cooling tower-1 basin", pid: "06-LS-601", sw: [["LS601_HL", "HL"], ["LS601_LL", "LL"]] },
    { name: "Cooling tower-2 basin", pid: "06-LS-602", sw: [["LS602_HL", "HL"], ["LS602_LL", "LL"]] },
    { name: "Hot water tank", pid: "06-LS-603", sw: [["LS603_HL", "HL"], ["LS603_LL", "LL"]] },
    { name: "De-gasifier", pid: "07-LS-701", sw: [["LS701_HH", "HH"], ["LS701_H", "H"], ["LS701_L", "L"], ["LS701_LL", "LL"]] },
    { name: "Gravity PP tank", pid: "07-LS-702", sw: [["LS702_HL", "HL"], ["LS702_LL", "LL"]] },
    { name: "Raw water tank (CTP)", pid: "08-LS-801/802", sw: [["LS801", "HH"], ["LS802", "LL"]] },
    { name: "Pure water tank (CTP)", pid: "08-LS-803/804", sw: [["LS803", "HH"], ["LS804", "LL"]] },
  ];
  const GY0 = 22, GH = 268;                              // gauge tank top / height (viewBox 0 0 270 312)
  // vertical storage tank: domed roof, dished bottom, legs, inlet / outlet nozzles; liquid drawn inside the shell.
  // Animated: the liquid group moves to the level (CSS transition), two waves roll on the surface, bubbles rise in
  // water, the feed pours in while the inlet valve is open, the outlet flows while a pump runs, the side mixer turns.
  const wave = (amp, y0) => {               // periodic (60 px) wave from x=-60 to 300, filled down to y=20
    let d = `M-60 ${y0}`;
    for (let x = -60; x < 300; x += 30) d += ` q15 ${amp * (x % 60 ? 1 : -1)} 30 0`;
    return `${d} V20 H-60 Z`;
  };
  // flat tank in the Mimic style: light grey rounded body, grey outline, flat liquid colour (same look as the
  // Mimic sheets), level readout lines and markers drawn by the card; liquid animated inside
  const WX0 = 83, WX1 = 177;
  function tankSVG(c) {
    const id = c.id, B = GY0 + GH;
    const shell = `M88 ${GY0} H172 Q180 ${GY0} 180 ${GY0 + 8} V${B - 8} Q180 ${B} 172 ${B} H88 Q80 ${B} 80 ${B - 8} V${GY0 + 8} Q80 ${GY0} 88 ${GY0} Z`;
    const inner = `M88 ${GY0 + 3} H172 Q177 ${GY0 + 3} 177 ${GY0 + 8} V${B - 8} Q177 ${B - 3} 172 ${B - 3} H88 Q83 ${B - 3} 83 ${B - 8} V${GY0 + 8} Q83 ${GY0 + 3} 88 ${GY0 + 3} Z`;
    const bubbles = c.fluid === "water" ? Array.from({ length: 8 }, (_, i) =>
      `<circle class="lvg-bub" cx="${WX0 + 8 + ((i * 29) % 80)}" cy="${GH * 0.9}" r="${1.4 + (i % 3) * 0.7}" style="animation-delay:-${(i * 0.73).toFixed(2)}s;animation-duration:${(3.2 + (i % 4) * 0.6).toFixed(1)}s"/>`).join("")
      : Array.from({ length: 6 }, (_, i) => `<circle class="lvg-part" cx="${WX0 + 10 + ((i * 23) % 70)}" cy="${30 + ((i * 53) % 150)}" r="${1.2 + (i % 2)}" style="animation-delay:-${i * 1.1}s"/>`).join("");
    // scale inside the left wall: every 10 %, longer at 50 %
    const ticks = Array.from({ length: 9 }, (_, i) => (i + 1) * 10).map((p) => { const y = GY0 + GH * (1 - p / 100); return `<line x1="${WX0}" x2="${WX0 + (p === 50 ? 12 : 6)}" y1="${y}" y2="${y}"/>`; }).join("");
    // side-entry propeller mixer near the bottom (OP-A1)
    const mixer = c.mixer ? `<g class="lvg-mix" data-mix transform="translate(${WX0 + 1} ${B - 22})"><title>Mixer OP-A1</title>
        <rect class="lvg-mix-m" x="-1" y="-4" width="6" height="8" rx="1"/>
        <line class="lvg-mix-s" x1="4" y1="0" x2="20" y2="0"/>
        <g class="lvg-prop" transform="translate(22 0)"><ellipse cx="0" cy="-6.5" rx="2.6" ry="6.5"/><ellipse cx="0" cy="6.5" rx="2.6" ry="6.5"/></g>
        <circle class="lvg-hub" cx="22" cy="0" r="2.2"/></g>` : "";
    return `<defs><clipPath id="clip_${id}"><path d="${inner}"/></clipPath></defs>
      <path class="lvg-mpipe" d="M130 2 V${GY0}"/>
      <path class="lvg-mpipe" d="M180 ${B - 14} H232"/><path class="lvg-flow out ${c.fluid}" data-out d="M180 ${B - 14} H232"/>
      <path class="lvg-body" d="${shell}"/>
      <g clip-path="url(#clip_${id})">
        <line class="lvg-pour ${c.fluid}" data-pour x1="130" x2="130" y1="${GY0}" y2="${B}"/>
        <g class="lvg-liq ${c.fluid}" data-liq style="transform:translateY(${B}px)">
          <g class="lvg-wave w2"><path class="lvg-w2 ${c.fluid}" d="${wave(3, 1)}"/></g>
          <rect class="lvg-lq ${c.fluid}" x="70" y="8" width="120" height="${GH + 30}"/>
          <g class="lvg-wave w1"><path class="lvg-lq ${c.fluid}" d="${wave(2.4, 3)}"/></g>
          <g class="lvg-bubs">${bubbles}</g>
        </g>
        ${mixer}
        <g class="lvg-ticks">${ticks}</g>
      </g>
      <path class="lvg-tank flat" data-shell d="${shell}"/>
      <g class="lvg-dir" data-dir transform="translate(130 ${GY0 + GH / 2 + 20})"><text text-anchor="middle" y="0"></text></g>`;
  }
  function lvStatus(t) {
    const v = num(t), lv = levelsOf(t);
    if (v == null || !lv) return ["nd", "No data"];
    if (v >= lv.hh) return ["hh", "High-high - at or above the HH set point"];
    if (v >= lv.h) return ["h", "High - at or above the H set point"];
    if (v <= lv.ll) return ["ll", "Low-low - at or below the LL set point"];
    if (v <= lv.l) return ["l", "Low - at or below the L set point"];
    return ["ok", "Normal - between L and H"];
  }
  // (v3: the Tank levels page - cards, set point table with inline edit, trends and float-switch tiles - moved into the
  //  dashboard process cards; set point / set delay editing is on the Set points page, with the same write + read-back)

  // ======================================================================================
  // HELP - plain-language guide to every page (opens in the side drawer)
  // ======================================================================================
  const HELP = [
    ["Colours", `<ul class="hp-c"><li><i class="run"></i><b>Green</b> - running / open / OK</li><li><i class="stop"></i><b>Grey</b> - stopped / closed</li>
      <li><i class="trip"></i><b>Red (blinking)</b> - tripped or alarm (Alert)</li><li><i class="warn"></i><b>Orange</b> - warning, value outside its normal band</li>
      <li><i class="lamp"></i><b>Yellow lamp</b> - float switch ON (water has reached that level)</li></ul>
      <p><b>DEMO DATA</b> at the top means the values are simulated, not from the plant.</p>`],
    ["Dashboard", `<p>The first page. The status bar at the top shows the panel and safety signals.</p>
      <p>One card per process area: tank or gauge picture, the <b>Actual</b> value, a short <b>Set point</b> summary (the pencil opens it on the Set points page), and the pumps and valves with their state.
      <b>Show more</b> opens the details and the trend. Drag a card by its handle (or use the arrows) to put it where you want - the order is kept for your user.</p>`],
    ["Mimic", `<p>Drawings of the plant. <b>Overall plant</b> shows all areas joined together; the other tabs show each area in detail.
      Pumps turn green when running, pipes show moving dashes when liquid is flowing (the arrow is the direction), tanks fill up with the real level. Click a pump or value for details.</p>`],
    ["Instruments", `<p>One card per measuring instrument (level, pressure, temperature, pH). The bar shows where the value is between the lowest and highest it can measure; the red mark is where the alarm comes.
      Scaling (lowest / highest value) is set on <b>IO list › Analog inputs › ✎ Scaling</b>.</p>`],
    ["Equipment", `<p>Every pump, fan and valve with its state, run hours and mode. <b>Auto</b> = the plant control starts and stops it by itself; <b>Manual</b> = an operator controls it.
      For main / standby pump pairs it shows which pump is selected. The selector and set-value cards show the plant settings. <b>Field signals</b> lists every input and output ON / OFF.</p>`],
    ["Trends & Data log", `<p><b>Trends</b> draws values over time (pick up to 6). <b>Data log</b> is a table of average values every 1 min to 1 hour, newest first, with an Excel download.</p>`],
    ["Alarms", `<p>Active alarms first, then history. The number on the bell in the menu shows how many alarms are active. Press <b>Acknowledge</b> on the Alarms page to mark one as seen - nothing is changed in the plant.</p>`],
  ];
  function openHelp() {
    const d = $("drawer"), bg = $("drawerBg");
    d.innerHTML = `<div class="row" style="justify-content:space-between"><h2>How to read this dashboard</h2><button class="btn sm" id="hpX">Close</button></div>
      <p class="muted">This dashboard only shows the plant - it cannot start, stop or change anything in the plant.</p>
      ${HELP.map(([h, b]) => `<section class="hp"><h3>${esc(h)}</h3>${b}</section>`).join("")}`;
    d.classList.remove("hidden");
    bg.classList.remove("hidden");
    $("hpX").onclick = () => { d.classList.add("hidden"); bg.classList.add("hidden"); };
    $("hpX").focus();
  }
  if ($("helpBtn")) $("helpBtn").onclick = openHelp;
  // Clicking "Mimic" in the menu opens the normal Mimic page; full screen only from the Full screen button
  // on the mimic toolbar (user request 17-11-2026 - the earlier automatic full screen on the menu click is removed).

  // ======================================================================================
  // IO LIST - every PLC input / output with its address and live state (HMI screens IO DI 0-6, IO DO 0-3, IO AI)
  // ======================================================================================
  let ioTab = "di", ioAt = 0, ioData = null;
  const IO_TABS = [["di", "Digital inputs"], ["do", "Digital outputs"], ["ai", "Analog inputs"]];
  async function renderIO(force) {
    const body = $("ioBody");
    if (!body) return;
    if (force || Date.now() - ioAt > 2000) {
      ioAt = Date.now();
      try { ioData = (await MD.api("/api/client/io")).io; } catch (e) { body.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
    }
    if (!ioData) return;
    ioWire();
    const q = ($("ioSearch").value || "").trim().toLowerCase();
    const count = (k) => ioData.filter((x) => x.kind === k).length;
    // tabs rebuilt only when something changes, so keyboard focus stays on the tab (v3: they stay at the top while scrolling)
    setH($("ioTabs"), IO_TABS.map(([k, l]) => `<button type="button" role="tab" aria-selected="${k === ioTab}" class="${k === ioTab ? "active" : ""}" data-k="${k}">${l} <span class="muted">${count(k)}</span></button>`).join(""));
    const order = (a) => { const m = a.match(/(\d+)\.(\d+)/); return m ? +m[1] * 100 + +m[2] : 0; };
    const rows = ioData.filter((x) => x.kind === ioTab && (!q || `${x.name} ${x.addr} ${x.desc}`.toLowerCase().includes(q)))
      .sort((a, b) => order(a.addr) - order(b.addr));
    const dig = ioTab !== "ai", on = rows.filter((x) => dig && isOn(x.value)).length;
    $("ioSum").textContent = dig ? `${rows.length} signals · ${on} TRUE · ${rows.length - on} FALSE` : `${rows.length} analog channels`;
    // one table per card, like the HMI pages: X0, X1 ... / Y0 ... / AI 0, AI 1 ...
    const groups = {};
    rows.forEach((x) => { const m = x.addr.match(/^(AI \d+|[XY]\d+)/); (groups[m ? m[1] : "?"] ||= []).push(x); });
    const label = (g) => (g[0] === "X" ? `IO DI ${g.slice(1)} · inputs ${g}.0 - ${g}.15` : g[0] === "Y" ? `IO DO ${g.slice(1)} · outputs ${g}.0 - ${g}.15` : `IO ${g} · analog channels`);
    const part = (d, i) => (d.split("·")[i] || "").trim();
    // fixed column widths: every card's table lines up, the ON / OFF pills form one straight column
    const cols = dig ? `<colgroup><col style="width:90px"><col><col style="width:32%"><col style="width:110px"></colgroup>`
      : `<colgroup><col style="width:90px"><col><col style="width:120px"><col style="width:170px"><col style="width:26%"><col style="width:110px"></colgroup>`;
    // analog scaling: the plant's scaling min / max (<AI>_RMIN / _RMAX) or the dashboard range when calculated here
    const scTxt = (x) => {
      const t = aiTag(x.id);
      if (!t) return '<span class="muted">-</span>';
      const lo = auxNum(`${x.id}_RMIN`), hi = auxNum(`${x.id}_RMAX`), dash = t.scaling_mode === "signal";
      const a = dash ? t.eng_min : lo ?? t.eng_min, b = dash ? t.eng_max : hi ?? t.eng_max;
      const f = (v) => (v == null ? "--" : Number(v).toFixed(Math.min(2, t.decimals ?? 1)));
      return `<b class="num">${f(a)} … ${f(b)}</b> ${esc(t.unit || "")}<br><em class="io-scsrc ${dash ? "dash" : "plc"}">${dash ? "set on dashboard" : "from plant"}</em>`;
    };
    body.innerHTML = Object.keys(groups).map((g) => `<div class="io-grp"><h3>${esc(label(g))}</h3><table class="io-t io-fixed ${dig ? "io-dig" : "io-ai"}">${cols}<thead><tr><th>Address</th><th>Signal</th>
        ${dig ? `<th>${ioTab === "di" ? "Contact" : "Drives"}</th><th class="io-stc">State</th>` : '<th>Value</th><th>Scaling (min … max)</th><th>Range / signal</th><th class="no-export"><span class="sr">Scaling</span></th>'}</tr></thead><tbody>
      ${groups[g].map((x) => {
        const nd = x.value == null || x.quality === "NODATA";   // spare channels look the same as the others (user request 17-11-2026)
        return `<tr><td class="num">${esc(x.addr)}</td><td>${esc(x.name)}</td>` + (dig
          ? `<td class="muted">${esc(part(x.desc, 1))}</td><td class="io-stc"><span class="io-st ${nd ? "nd" : isOn(x.value) ? "on" : "off"}"><i></i>${nd ? "No data" : isOn(x.value) ? "TRUE" : "FALSE"}</span></td>`
          : `<td class="num"><b>${nd ? "--" : Number(x.value).toFixed(x.decimals ?? 1)}</b> ${esc(x.unit || "")}</td><td>${scTxt(x)}</td>
            <td class="muted">${esc(x.desc.split("·").slice(2).join("·").trim())}</td>
            <td class="no-export">${aiTag(x.id) ? `<button class="btn sm io-sc" type="button" data-sc="${esc(x.id)}">✎ Scaling</button>` : ""}</td>`) + "</tr>";
      }).join("")}</tbody></table></div>`).join("") || `<p class="muted">No signal matches "${esc(q)}".</p>`;
    body.querySelectorAll("[data-sc]").forEach((b) => (b.onclick = () => openScaling(b.dataset.sc)));
  }
  // v3 (brief SC05): tabs + search stay at the top while the list scrolls (below the phone top bar when it is sticky),
  // list stays read-only, CSV / PDF export of the rows shown (current tab + search)
  function ioTop() {
    const card = $("ioCard"), rail = document.querySelector(".rail");
    if (!card) return;
    const railTop = rail && getComputedStyle(rail).position === "sticky" && rail.getBoundingClientRect().height < 160 ? Math.ceil(rail.getBoundingClientRect().height) : 0;
    card.style.setProperty("--io-top", `${railTop}px`);
  }
  function ioWire() {
    const tabs = $("ioTabs");
    if (!tabs || tabs._wired) return;
    tabs._wired = true;
    tabs.addEventListener("click", (e) => { const b = e.target.closest("button[data-k]"); if (b) { ioTab = b.dataset.k; renderIO(); } });
    $("ioSearch").addEventListener("input", () => renderIO());
    if ($("ioCsv")) $("ioCsv").onclick = () => {
      const tables = [...$("ioBody").querySelectorAll("table")];
      if (!tables.length) { MD.toast("No signals to export", true); return; }
      const rows = [];
      tables.forEach((tb) => {
        const r = MD.v3.tableRows(tb), grp = (tb.closest(".io-grp").querySelector("h3") || {}).textContent || "";
        if (!rows.length && r.length) rows.push(["Group", ...r[0]]);
        r.slice(1).forEach((x) => rows.push([grp, ...x]));
      });
      MD.v3.exportCsv(`io-list-${ioTab}-${MD.istDate(Date.now() / 1000)}.csv`, rows);
    };
    if ($("ioPdf")) $("ioPdf").onclick = () => {
      const l = (IO_TABS.find(([k]) => k === ioTab) || [])[1] || "";
      const q = $("ioSearch").value.trim();
      MD.v3.printPdf($("ioCard"), `IO list · ${l}${q ? ` · search "${q}"` : ""}`);
    };
    ioTop();
    window.addEventListener("resize", ioTop);
  }

  // ======================================================================================
  // SET POINTS (v3, brief SC03) - alarm set points, tank level HH / H / L / LL and process set values together.
  // The pencil sits right beside the value it changes -> small pop-up (Save / Cancel) -> confirm -> write -> read back
  // (same write path and checks as before). Built once and patched every second, so search, focus and the pop-up stay.
  // ======================================================================================
  const ALM_SP = ["T_01", "T_02", "T_03", "T_04", "PT_01", "PT_02", "PT_03", "PT_04", "PH_01"];
  // Alarm direction. Each instrument has ONE alarm set point (no separate hi / lo configured); its set delay and
  // "delay now" count while the value is above it and the plant alarm comes at or above it, so all of these are
  // HIGH-limit alarms (pH too: one high set point). A low-limit alarm would be listed here as "low" - the warning
  // band then works downwards (MD.v3.level).
  const ALM_DIR = {};
  const almDir = (id) => ALM_DIR[id] || "high";
  const LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  const canWrite = () => !!(window.MD_ME || {}).can_operate && document.body.dataset.role !== "viewer";
  // pencil per set point: only for operator / admin (viewers see none), only for values the admin marked "writable"
  function spBtn(id, what) {
    const a = (live.aux || {})[id];
    if (!a || !canWrite()) return "";
    if (!a.writable) return `<span class="sp-lock" role="img" aria-label="Read-only" title="Read-only: writing is not enabled for this value yet (its data format must be confirmed first)">${LOCK}</span>`;
    return `<button class="v3-pen" type="button" data-sp="${esc(id)}" aria-label="Change ${esc(what || a.name)}" title="Change">${MD.v3.PEN}</button>`;
  }
  function openSpEdit(id) {
    const a = (live.aux || {})[id];
    if (!a) return;
    const lo = a.eng_min, hi = a.eng_max, d = a.decimals ?? 1;
    const lvTag = id.startsWith("LT_0") ? tag(id.slice(0, 5)) : id.startsWith("SP_SLUDGE") ? tag("LT_01") : null;
    const chk = "<b>Check that the current value above matches the panel</b> before saving. If it doesn't match, don't save - tell Medge.";
    const warn = id.endsWith("_ALM_DLY") ? `<div class="sp-warn">⚠ Address from our IO list; format (Word, seconds) inferred from the tank set delays, not confirmed. ${chk}</div>`
      : id.endsWith("_ALM_SP") ? `<div class="sp-warn">⚠ Written as Double Word ×10 (e.g. 50.0 → 500), like the tank set points. ${chk}</div>`
      : id.startsWith("SP_") ? `<div class="sp-warn">⚠ The format of this value (REAL) is assumed, not confirmed. ${chk}</div>` : "";
    const demo = live.status && live.status.state === "demo";
    // an alarm set point must lie inside what its instrument can measure (its min / max range), else the alarm can never come
    const inst = id.endsWith("_ALM_SP") ? tag(id.slice(0, -7)) : null;
    const rng = inst && inst.eng_min != null && inst.eng_max != null ? [inst.eng_min, inst.eng_max] : lo != null && hi != null ? [lo, hi] : null;
    const spRangeErr = (box, v) => {
      const err = box.querySelector("#spErr"), u = esc(a.unit || "");
      err.innerHTML = `<p><b>${esc(String(v))} ${u} is ${v > rng[1] ? "above the highest" : "below the lowest"} value${inst ? ` ${esc(inst.name)} can measure` : " allowed"} (${rng[0]} … ${rng[1]} ${u}).</b>
        ${inst ? "Change the alarm value, or change the instrument's min / max range." : "Enter a value inside the range."}</p>
        <div class="sp-range-btns"><button type="button" class="btn sm" data-fix="alarm">Change alarm setting</button>
        ${inst ? `<button type="button" class="btn sm primary" data-fix="range">Change min / max setting</button>` : ""}</div>`;
      err.hidden = false;
      err.querySelector('[data-fix="alarm"]').onclick = () => { const i = box.querySelector("#spNew"); i.value = String(v > rng[1] ? rng[1] : rng[0]); i.focus(); i.select(); err.hidden = true; };
      const r = err.querySelector('[data-fix="range"]');
      if (r) r.onclick = () => { pop.close(); location.hash = "#io"; setTimeout(() => openScaling(inst.id), 300); };
    };
    const pop = MD.v3.popup({ title: a.name, saveLabel: "Save",
      body: `<p class="sp-cur">Current value: <b class="num">${esc(lvTag && a.unit === "%" ? spTxt(lvTag, id) : auxTxt(id))}</b></p>${warn}
        <label for="spNew">New value ${a.unit ? `(${esc(a.unit)})` : ""}</label>
        <input id="spNew" type="number" inputmode="decimal" step="${Math.pow(10, -d)}" ${lo != null ? `min="${lo}"` : ""} ${hi != null ? `max="${hi}"` : ""} value="${a.value ?? ""}">
        <div class="v3-hint" id="spHint">${rng ? `Allowed ${rng[0]} … ${rng[1]} ${esc(a.unit || "")}${inst ? " (instrument range)" : ""}` : ""}</div>
        <div class="sp-range-err" id="spErr" role="alert" hidden></div>
        <p class="v3-hint">${demo ? "Demo data - nothing is sent to the plant. " : ""}The value is written to the plant and read back. Every change is logged with your user name.</p>`,
      onSave: async (box) => {
        const v = parseFloat(box.querySelector("#spNew").value);
        if (isNaN(v)) { MD.toast("Enter a number", true); return false; }
        if (rng && (v < rng[0] || v > rng[1])) { spRangeErr(box, v); return false; }   // outside the range: say why + the two ways out
        box.querySelector("#spErr").hidden = true;
        if (!confirm(`Write ${a.name}\n\n${auxTxt(id)}  →  ${v.toFixed(d)} ${a.unit || ""}\n\nto the plant?`)) return false;
        try {
          const r = await MD.api("/api/client/write", { method: "POST", body: { id, value: v } });
          MD.toast(`${a.name}: ${Number(r.value).toFixed(d)} ${a.unit || ""}${r.simulated ? " (demo - not written to the plant)" : " - read back from the plant"}`);
          if (live.aux && live.aux[id]) live.aux[id].value = r.value;
          return true;
        } catch (e) { MD.toast(e.message, true); throw e; }   // pop-up stays open with the typed value + the reason
      } });
    if (lvTag && a.unit === "%") pop.box.querySelector("#spNew").oninput = (ev) => {
      const v = parseFloat(ev.target.value);
      pop.box.querySelector("#spHint").textContent = isNaN(v) ? "" : `= ${Math.round(spToLevel(lvTag, id, v))} ${lvTag.unit || "mm"} · allowed ${lo} … ${hi} %`;
    };
  }
  // (Selectors page removed on request 2026-11-14 - Auto / Manual is shown read-only on Equipment and the Mimic)
  const SP_PROC = [   // process set values (control philosophy): label, value id, note
    ["Sludge pump start (normal level)", "SP_SLUDGE_PUMP_START", "pumps 01-P-101/102 start at or above"],
    ["Sludge pump stop (very low level)", "SP_SLUDGE_PUMP_STOP", "dry-run protection"],
    ["Sludge feed valve open", "SP_SLUDGE_VALVE_OPEN", "sludge tank level"],
    ["Sludge feed valve close", "SP_SLUDGE_VALVE_CLOSE", "sludge tank level"],
    ["LP steam valve open", "SP_LP_STEAM_OPEN", "de-gasifier temperature"],
    ["LP steam valve close", "SP_LP_STEAM_CLOSE", "de-gasifier temperature"],
  ];
  const SP_LT = ["LT_01", "LT_02"];
  function spSig() {                                    // rebuild the tables only when rows / pencils change
    const ids = [...ALM_SP.flatMap((i) => [`${i}_ALM_SP`, `${i}_ALM_DLY`]), ...SP_LT.flatMap((i) => LV_KEYS.flatMap(([, L]) => [`${i}_${L}_SP`, `${i}_${L}_DLY`])), ...SP_PROC.map((p) => p[1])];
    const aux = live.aux || {};
    return `${canWrite()}|${ids.map((i) => (aux[i] ? (aux[i].writable ? "w" : "r") : "-")).join("")}|${[...ALM_SP, ...SP_LT].map((i) => (tag(i) ? 1 : 0)).join("")}`;
  }
  function spBuild(box) {
    const keep = Object.fromEntries(Object.entries(box._srch || {}).map(([k, s]) => [k, s.value]));
    const almRows = ALM_SP.filter(tag).map((id) => {
      const t = tag(id), no = t.name.split(" ")[0], nm = t.name.split(" ").slice(1).join(" ");
      const pidNo = TAG_PID[id] && /\d/.test(TAG_PID[id]) ? TAG_PID[id] : "";   // P&ID tag number first (16-11-2026); short id kept for the panel
      return `<tr data-id="${id}" data-search="${esc(`${no} ${pidNo}`)}"><td><b>${esc(pidNo || no)}</b><span class="sp-nm">${pidNo ? `${esc(no)} · ` : ""}${esc(nm)}</span></td>
        <td class="num" data-f="v"></td>
        <td class="num"><span class="sp-val" data-f="sp"></span>${spBtn(`${id}_ALM_SP`, `${no} alarm set point`)}</td>
        <td class="num" data-f="diff"></td><td data-f="st"></td>
        <td class="num"><span class="sp-val" data-f="dly"></span>${spBtn(`${id}_ALM_DLY`, `${no} set delay`)}</td>
        <td class="num" data-f="act"></td></tr>`;
    }).join("");
    const lvBlocks = SP_LT.filter(tag).map((id) => {
      const t = tag(id);
      return `<div class="sp-lv" id="sp-tank-${id}" data-group><div class="sp-lv-h"><h3>${esc(t.name)}</h3><span class="num" data-f="now"></span></div>
        <div class="table-wrap"><table class="dv-t sp-t sp-lt"><thead><tr><th>Level</th><th>Set point</th><th>Reached</th><th>Set delay</th><th>Delay now</th></tr></thead><tbody>
        ${LV_KEYS.map(([k, L]) => `<tr data-lv="${k}" data-search="${esc(`${t.name} ${TAG_PID[id] || ""}`)}"><td><b>${L}</b></td>
          <td class="num"><span class="sp-val" data-f="sp"></span>${spBtn(`${id}_${L}_SP`, `${t.name} ${L} set point`)}</td>
          <td data-f="reach"></td>
          <td class="num"><span class="sp-val" data-f="dly"></span>${spBtn(`${id}_${L}_DLY`, `${t.name} ${L} set delay`)}</td>
          <td class="num" data-f="act"></td></tr>`).join("")}</tbody></table></div>
        <div class="sp-src" data-f="src"></div></div>`;
    }).join("");
    const procRows = SP_PROC.map(([n, id, note]) => `<tr data-pid="${id}"><td>${esc(n)}</td><td class="num"><span class="sp-val" data-f="v"></span>${spBtn(id, n)}</td><td class="muted">${esc(note)}</td></tr>`).join("");
    const band = (window.MD_META || {}).warn_band_pct ?? 90;
    box.innerHTML = `
      <div class="card sp-card" id="sp-alarm"><div class="card-head"><h2>Alarm set points</h2>${MD.v3.info(`Each instrument has one alarm set point. The plant raises its alarm when the live value stays at or above the set point for the set delay; "Delay now" counts while it is above. The live value turns amber from ${band} % of the set point and red at or above it. Plant alarm = the plant's own alarm signal.`, "Alarm set points")}</div>
        <div class="sp-bar" data-srch="alm"></div>
        <div class="table-wrap"><table class="dv-t sp-t sp-alm"><thead><tr><th>Instrument</th><th>Live value</th><th>Alarm set point</th>
          <th><span class="sp-th">Difference${MD.v3.info("Difference = live value − alarm set point, with its sign. Negative: the value is below its set point. Zero or positive: the value is at or above the set point.", "Difference")}</span></th>
          <th>Plant alarm</th><th>Set delay</th><th>Delay now</th></tr></thead><tbody>${almRows}</tbody></table></div></div>
      <div class="card sp-card" id="sp-tank"><div class="card-head"><h2>Tank level set points</h2>${MD.v3.info("HH / H / L / LL of the two tanks with a level transmitter, set in % of the transmitter range (mm in brackets). HH and H are reached at or above, L and LL at or below. Set delay = how long the level must stay there before the alarm is raised.", "Tank level set points")}</div>
        <div class="sp-bar" data-srch="tank"></div><div class="sp-lvs">${lvBlocks}</div></div>
      <div class="card sp-card" id="sp-process"><div class="card-head"><h2>Process set values</h2>${MD.v3.info("Values the plant control uses to start and stop pumps and valves (control philosophy), read from the plant. Sludge levels are in % of the tank level range, mm in brackets.", "Process set values")}</div>
        <div class="sp-bar" data-srch="proc"></div>
        <div class="table-wrap"><table class="dv-t sp-t sp-proc"><thead><tr><th>Set value</th><th>Value</th><th>Note</th></tr></thead><tbody>${procRows}</tbody></table></div></div>`;
    box._srch = {};
    [["alm", "#sp-alarm", "Search instrument, e.g. PT-02"], ["tank", "#sp-tank", "Search tank or level, e.g. HH"], ["proc", "#sp-process", "Search set value, e.g. steam"]].forEach(([k, sel, ph]) => {
      const host = box.querySelector(`[data-srch="${k}"]`);
      box._srch[k] = MD.v3.tableSearch(host, box.querySelector(sel), { placeholder: ph });
      if (keep[k]) { host.querySelector("input").value = keep[k]; box._srch[k].run(); }
    });
  }
  function spUpdate(box) {
    const nd = '<span class="muted">--</span>';
    const chip = (s, txt) => `<span class="dc-st st-${s}"><i aria-hidden="true">${ST_IC[s]}</i>${esc(txt)}</span>`;
    box.querySelectorAll("#sp-alarm tr[data-id]").forEach((tr) => {
      const id = tr.dataset.id, t = tag(id), f = (n) => tr.querySelector(`[data-f="${n}"]`);
      if (!t) return;
      const d = t.decimals ?? 1, v = num(t), sp = auxNum(`${id}_ALM_SP`), bit = sw(`${id}_ALM`), u = esc(t.unit || "");
      const lvl = MD.v3.level(v, sp, almDir(id)), cls = lvl === "alarm" ? "lv-alarm" : lvl === "warn" ? "lv-warn" : "";
      const diff = v != null && sp != null ? v - sp : null;
      setH(f("v"), v == null ? nd : `<b class="${cls}">${Number(v).toFixed(d)}</b> <span class="muted">${u}</span>`);
      const outR = sp != null && t.eng_min != null && t.eng_max != null && (sp > t.eng_max || sp < t.eng_min);   // alarm outside the instrument range
      setH(f("sp"), sp == null ? nd : `<b>${Number(sp).toFixed(d)}</b> <span class="muted">${u}</span>${outR
        ? ` <span class="sp-oor" title="Outside the instrument range ${t.eng_min} … ${t.eng_max} ${u} - the alarm can never come. Click the pencil to fix.">! outside range ${t.eng_min}…${t.eng_max}</span>` : ""}`);   // set point: black
      setH(f("diff"), diff == null ? nd : `${diff >= 0 ? "+" : "-"}${Math.abs(diff).toFixed(d)} <span class="muted">${u}</span>`);
      setH(f("st"), bit == null ? chip("unk", "No data") : bit ? chip("alarm", "Alarm") : chip("ok", "Normal"));
      const dly = auxNum(`${id}_ALM_DLY`), act = auxNum(`${id}_ALM_ACT`);
      setH(f("dly"), dly == null ? nd : `<b>${dly}</b> <span class="muted">s</span>`);
      setH(f("act"), act == null ? nd : `${act} <span class="muted">s</span>`);
    });
    SP_LT.forEach((id) => {
      const blk = box.querySelector(`#sp-tank-${id}`), t = tag(id);
      if (!blk || !t) return;
      const v = num(t), p = pct(t, v), lv = levelsOf(t);
      setH(blk.querySelector('[data-f="now"]'), v == null ? "Actual --" : `Actual <b>${Math.round(v)} ${esc(t.unit || "mm")}</b>${p == null ? "" : ` <span class="muted">(${p.toFixed(1)} %)</span>`}`);
      setH(blk.querySelector('[data-f="src"]'), plcLevels(t) ? "Set points read from the plant" : "Plant values not read - the dashboard uses default levels");
      blk.querySelectorAll("tr[data-lv]").forEach((tr) => {
        const k = tr.dataset.lv, L = k.toUpperCase(), f = (n) => tr.querySelector(`[data-f="${n}"]`);
        setH(f("sp"), `<b>${esc(spTxt(t, `${id}_${L}_SP`))}</b>`);
        // reached: HH / H at or above, L / LL at or below; "near" inside the warning band
        const s = MD.v3.level(v, lv ? lv[k] : null, k === "hh" || k === "h" ? "high" : "low");
        setH(f("reach"), !s ? nd : s === "alarm" ? chip(k === "hh" || k === "ll" ? "alarm" : "warn", "Reached") : s === "warn" ? chip("warn", "Near") : chip("ok", "No"));
        setH(f("dly"), `<b>${esc(auxTxt(`${id}_${L}_DLY`))}</b>`);
        setH(f("act"), esc(auxTxt(`${id}_${L}_ACT`)));
      });
    });
    box.querySelectorAll("#sp-process tr[data-pid]").forEach((tr) => {
      const id = tr.dataset.pid;
      setH(tr.querySelector('[data-f="v"]'), `<b>${esc(id.startsWith("SP_SLUDGE") ? spTxt(tag("LT_01"), id) : auxTxt(id))}</b>`);
    });
  }
  function renderSetpoints() {
    const box = $("spBody");
    if (!box || !live) return;
    if (!box._bound) {
      box._bound = true;
      box.addEventListener("click", (ev) => {
        const b = ev.target.closest("[data-sp]");
        if (b) openSpEdit(b.dataset.sp);
      });
    }
    const sig = spSig();
    if (box._sig !== sig) { box._sig = sig; spBuild(box); }
    spUpdate(box);
    Object.values(box._srch || {}).forEach((s) => { if (s.value) s.run(); });
    spScroll();
  }

  window.Plant = {
    showOnMimic,
    render(l, view) {
      live = l;
      if (view === "setpoints") renderSetpoints();
      if (view === "io") renderIO();
      if (view === "overview") renderKeyPoints();
      if (view === "mimic") renderMimic();
      if (view === "instruments") renderInstruments();
      if (view === "datalog") renderDatalog(false);
    },
    show(view) {
      if (view === "mimic") { const b = $("mimicSvg"); if (b) b._sheet = null; const t = $("mimicTabs"); if (t) t._sheet = null; }
      if (view === "datalog") { renderDatalog(true); return; }
      if (view === "io") { renderIO(true); return; }
      if (view !== "instruments") editing = null;
      if (live) this.render(live, view);
    },
  };
})();
