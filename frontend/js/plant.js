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
    OP_P6A: "Borewell main", OP_P6B: "Borewell standby", OP_P14: "Supply main", OP_P15: "Supply standby",
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
  // HH / H / L / LL level set points of a level transmitter (set on the dashboard; default % of range)
  const LV_KEYS = [["hh", "HH"], ["h", "H"], ["l", "L"], ["ll", "LL"]];
  // HH / H / L / LL: the values set on the HMI "LT Set Point" screen (read from the PLC); fallback = dashboard / default
  function plcLevels(t) {
    if (!t || !live) return null;
    const v = Object.fromEntries(LV_KEYS.map(([k]) => [k, auxNum(`${t.id}_${k.toUpperCase()}_SP`)]));
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
  function tankMini(t) {
    const p = pct(t);
    return `<div class="kp-tank"><span class="kt-fill" style="height:${p ?? 0}%"></span><b>${p == null ? "--" : Math.round(p) + "%"}</b></div>`;
  }
  function kpCard(id, cls, title, sub, valueHTML, body, chips, state) {
    return `<div class="kp-card ${cls} ${state || ""}" ${id ? `data-open="${esc(id)}" tabindex="0" role="button"` : ""}>
      <div class="kp-h"><span class="kp-t">${esc(title)}</span><span class="kp-s">${esc(sub)}</span></div>
      <div class="kp-v">${valueHTML}</div>${body}<div class="kp-eqs">${chips}</div></div>`;
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
  const secs = (groups) => `<div class="kp-dl">${groups.filter(([, r]) => r.filter(Boolean).length)
    .map(([h, r]) => `<div class="kd-sec"><div class="kd-h">${esc(h)}</div>${r.filter(Boolean).join("")}</div>`).join("")}</div>`;
  const note = (txt, cls = "") => (txt ? `<div class="kp-next ${cls}"><b>${cls === "bad" || cls === "warn" ? "⚠" : "▶"}</b>${esc(txt)}</div>` : "");
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

  function renderKeyPoints() {
    const box = $("keyPoints");
    if (!box) return;
    const lt1 = tag("LT_01"), lt2 = tag("LT_02"), pt1 = tag("PT_01"), ph = tag("PH_01"), t4 = tag("T_04"), t2 = tag("T_02"), pt3 = tag("PT_03");
    const phv = num(ph), t4v = num(t4), pt1v = num(pt1);
    const phState = phv == null ? "" : phv <= 6.5 ? "⚠ Too acidic - alkali being added" : phv >= 7.5 ? "⚠ Too alkaline - acid being added" : "✔ pH is OK";
    const steamOpen = running("OP_SV1");
    const air = sw(SW.AIR);

    // sludge tank: what happens next (logic 3.A: valve opens at LL / closes at HH; pump starts at NL / stops at VLL)
    const l1 = num(lt1), pStart = auxNum("SP_SLUDGE_PUMP_START"), pStop = auxNum("SP_SLUDGE_PUMP_STOP");
    const vOpen = auxNum("SP_SLUDGE_VALVE_OPEN"), vClose = auxNum("SP_SLUDGE_VALVE_CLOSE");
    const sPump = running("OP_P1A") || running("OP_P1B");
    let sNext = "";
    if (l1 != null && pStart != null && pStop != null) {
      sNext = sPump ? `Sludge pump running - stops when level falls to ${pStop.toFixed(0)} mm`
        : l1 >= pStart ? `Level is above pump start (${pStart.toFixed(0)} mm) - pump should be running: check Auto mode / trip`
          : `Sludge pump starts when level reaches ${pStart.toFixed(0)} mm (mixer starts 60 s before)`;
    }
    let vNext = "";
    if (vOpen != null && vClose != null) vNext = running("MV_01") ? `Feed valve open - closes at ${vClose.toFixed(0)} mm` : `Feed valve opens when level falls to ${vOpen.toFixed(0)} mm`;

    // raw water: why the make-up pumps are (not) running (logic 4: stop at LS-301 LL, keep header > 3 kg/cm²)
    const rawLL = sw(SW.LS301_LL), rawHL = sw(SW.LS301_HL);
    const mkRun = running("OP_P14") || running("OP_P15"), ugRun = running("OP_P6A") || running("OP_P6B");
    const rawNote = rawLL === false && !rawHL ? "Raw water tank below LL - supply pumps stopped (no dry running); borewell pump should be filling"
      : mkRun ? "Supply pump running on VFD - keeps header pressure above 3 kg/cm²" : "";
    const ugNote = ugRun ? "Borewell pump filling the raw water tank - stops at HL" : rawHL ? "Raw water tank full (HL) - borewell pumps off" : "";
    const [rawTxt, rawCls] = floatTank(SW.LS301_HL, SW.LS301_LL);

    // de-gasifier tank (4 switches)
    const dg = ["LS701_HH", "LS701_H", "LS701_L", "LS701_LL"].map((k) => sw(SW[k]));
    const dgTxt = dg.some((v) => v == null) ? ["No data", "unk"] : dg[0] ? ["HH - outlet valve opens", "warn"] : dg[1] ? ["H", "ok"]
      : dg[2] ? ["L", "ok"] : dg[3] ? ["Between LL and L", "warn"] : ["Below LL - recirculation pump stops", "bad"];

    const [ct1Txt, ct1Cls] = floatTank(SW.LS601_HL, SW.LS601_LL), [ct2Txt, ct2Cls] = floatTank(SW.LS602_HL, SW.LS602_LL);
    const [hwTxt, hwCls] = floatTank(SW.LS603_HL, SW.LS603_LL), [gvTxt, gvCls] = floatTank(SW.LS702_HL, SW.LS702_LL);
    const [cRawTxt, cRawCls] = floatTank(SW.LS801, SW.LS802), [cPureTxt, cPureCls] = floatTank(SW.LS803, SW.LS804);
    const ct1Run = ["OP_P7", "OP_P3", "OP_P11"].filter(running).length;
    const panels = [["Boiler", "Boiler"], ["Dryer", "Dryer"], ["Turbine", "Turbine"], ["Gasifier", "Gasifier"], ["Volute press", "Volute_Press"], ["WTP", "WTP"]];
    const pfd = (n, p) => sw(`DI_Potential_Free_DI_${n}_From_${p}_Panel`);
    const pfdTxt = (v) => (v == null ? "--" : v ? "ON" : "OFF");
    const loc = sw("DI_Submersible_Pump_Panel_Local_remote_Switch_in_Local"), rem = sw("DI_Submersible_Pump_Panel_Local_remote_Switch_in_Remote");

    box.innerHTML = `
      <div class="kp-areas">${AREAS.filter((a) => !a.overall).map((a) => areaChip(a)).join("")}</div>
      <div class="kp-grid">
        ${lt1 ? kpCard("LT_01", "kp-lvl", "Sludge storage tank", "01-LT-101 radar · pumps send sludge to the volute press", valHTML(lt1),
          tankMini(lt1) + lvRow(lt1) + note(sNext, sNext.startsWith("Level is above") ? "warn" : "") + note(vNext) + secs([
            ["Equipment", [pairRow("Sludge pumps 01-P-101/102", "OP_P1A", "OP_P1B"), eqRow("Feed valve 01-MV-101", "MV_01"),
              eqRow("Mixer OP-A1", "AGIT"), eqRow("Cavity pump OP-P201", "PCP")]],
            ["Set points & logic", [row("Pump start / stop", `${spNum("SP_SLUDGE_PUMP_START")} / ${spNum("SP_SLUDGE_PUMP_STOP")} mm`),
              row("Valve open / close", `${spNum("SP_SLUDGE_VALVE_OPEN")} / ${spNum("SP_SLUDGE_VALVE_CLOSE")} mm`),
              row("Mixer", "starts 60 s before pump · stops 60 s after")]],
            ["Alarms & safety", [row("Instrument air (for valve)", air == null ? "No data" : air ? "OK" : "LOW - valve blocked", air == null ? "unk" : air ? "ok" : "bad"),
              almRow("PLC level alarm", "LT_01_ALM")]],
          ]), "", lvState(lt1)) : ""}
        ${lt2 ? kpCard("LT_02", "kp-lvl", "Filtrate tank", "01-LT-102 radar · water squeezed out of the sludge", valHTML(lt2),
          tankMini(lt2) + lvRow(lt2) + secs([
            ["Equipment", [pairRow("Filtrate pumps 01-P-103/104", "OP_P5A", "OP_P5B")]],
            ["Set points & logic", [row("Pump starts", "at normal level"), row("Pump stops", "at very low level (dry-run protection)")]],
            ["Alarms & safety", [almRow("PLC level alarm", "LT_02_ALM")]],
          ]), "", lvState(lt2)) : ""}
        ${pt1 ? kpCard("PT_01", "kp-pr", "Water supply pressure", "03-PT-301 · water to the whole plant · should stay above 3.0 bar", valHTML(pt1),
          band(pt1, 3, pt1.eng_max, { caption: pt1v == null ? "" : pt1v >= 3 ? "✔ Pressure is OK" : "⚠ Pressure is low (below 3.0 bar)" })
          + note(rawNote, rawLL === false && !rawHL ? "bad" : "") + note(ugNote) + secs([
            ["Equipment", [pairRow("Supply pumps (VFD) 03-P-303/304", "OP_P14", "OP_P15"), pairRow("Borewell pumps 03-P-301/302", "OP_P6A", "OP_P6B")]],
            ["Tank & field signals", [row("Raw water tank 03-LS-301", esc(rawTxt), rawCls),
              swRow("Borewell flow 03-FS-301", SW.FLOW, "Flow detected", "No flow", ugRun ? false : null),
              row("Submersible panel", loc == null && rem == null ? "No data" : loc ? "LOCAL - PLC cannot start" : rem ? "REMOTE (PLC)" : "Neither", loc ? "warn" : rem ? "ok" : "unk")]],
            ["Alarms & safety", [row("Pressure alarm set point", auxTxt("PT_01_ALM_SP")), almRow("PLC pressure alarm", "PT_01_ALM")]],
          ]), "", pt1v != null && pt1v < 3 ? "warn" : "") : ""}
        ${ph ? kpCard("PH_01", "kp-ph", "Process water pH", "Acid / alkali is added automatically to keep it 6.5 - 7.5", valHTML(ph),
          band(ph, 6.5, 7.5, { caption: phState, cls: "ph" }) + secs([
            ["Equipment", [eqRow("Acid dosing 07-P-702", "OP_P12"), eqRow("Alkali dosing 07-P-703", "OP_P13")]],
            ["Set points & logic", [row("Acid starts / stops", "pH ≤ 6.5 / pH ≥ 7.0"), row("Alkali starts / stops", "pH ≥ 7.5 / pH ≤ 7.0")]],
            ["Alarms & safety", [row("Never both together", running("OP_P12") && running("OP_P13") ? "BOTH RUNNING" : "OK", running("OP_P12") && running("OP_P13") ? "bad" : "ok"),
              row("pH alarm set point", auxTxt("PH_01_ALM_SP")), almRow("PLC pH alarm", "PH_01_ALM")]],
          ]), "", phv != null && (phv < 6.5 || phv > 7.5) ? "warn" : "") : ""}
        ${t4 ? kpCard("T_04", "kp-tp", "De-gasifier water temperature", "07-TT-701 · steam heats the water · kept between 70 and 90 °C", valHTML(t4),
          band(t4, 70, 90, { caption: `LP steam valve ${steamOpen ? "open" : "closed"}${t4v != null ? (t4v < 70 ? " · heating up" : t4v > 90 ? " · too hot" : " · ✔ OK") : ""}` }) + secs([
            ["Equipment", [eqRow("LP steam valve 07-XV-701", "OP_SV1"), eqRow("Outlet valve 07-XV-702", "OP_SV2"), eqRow("Hot air blower OP-M1", "OP_M1"),
              eqRow("Condensate pump 05-P-501", "OP_P4"), eqRow("Recirculation pump 07-P-701", "OP_P9")]],
            ["Set points & logic", [row("Steam opens / closes", `${spNum("SP_LP_STEAM_OPEN")} / ${spNum("SP_LP_STEAM_CLOSE")} °C`),
              row("De-gasifier tank 07-LS-701", esc(dgTxt[0]), dgTxt[1])]],
            ["Alarms & safety", [row("Instrument air", air == null ? "No data" : air ? "OK" : "LOW - steam valve closed", air == null ? "unk" : air ? "ok" : "bad"),
              row("Temp. alarm set point", auxTxt("T_04_ALM_SP")), almRow("PLC temperature alarm", "T_04_ALM")]],
          ]), "") : ""}
        ${t2 ? kpCard("T_02", "kp-hw", "Hot water to sludge dryer", "06-TT-601 · hot water that dries the sludge", valHTML(t2),
          `<div class="kp-pair"><span>Pressure</span><b class="num">${esc(fmt(pt3))}</b> <small>${esc(pt3 ? pt3.unit : "")}</small></div>` + secs([
            ["Equipment", [eqRow("Hot water pump (VFD) 06-P-605", "OP_P2")]],
            ["Set points & logic", [row("Hot water tank 06-LS-603", esc(hwTxt), hwCls), row("Pump", "runs above LL · stops at LL")]],
            ["Alarms & safety", [row("Temp. alarm set point", auxTxt("T_02_ALM_SP")), almRow("PLC temperature alarm", "T_02_ALM"),
              row("Pressure alarm set point", auxTxt("PT_03_ALM_SP")), almRow("PLC pressure alarm", "PT_03_ALM")]],
          ]), "") : ""}
        ${kpCard("", "kp-ct", "Cooling towers", "CT-1: de-gasifier PHE, dryer condenser, boiler · CT-2: turbine oil", `<b class="num">${ct1Run}</b><small>/3 CT-1 pumps running</small>`,
          secs([
            ["Cooling tower 1", [row("Basin 06-LS-601", esc(ct1Txt), ct1Cls), eqRow("De-gasifier PHE pump 06-P-601", "OP_P7"),
              eqRow("Dryer condenser pump 06-P-602", "OP_P3"), eqRow("Boiler cooling pump 06-P-603", "OP_P11"), eqRow("Fan OP-F601", "OP_F1")]],
            ["Cooling tower 2", [row("Basin 06-LS-602", esc(ct2Txt), ct2Cls), eqRow("Turbine oil cooling pump 06-P-604", "OP_P10"), eqRow("Fan OP-F602", "OP_F2")]],
            ["Logic", [row("Fan", "runs only when a pump of its tower runs"), row("Pumps", "stop at basin LL")]],
          ]), "", ct1Cls === "bad" || ct2Cls === "bad" ? "warn" : "")}
        ${kpCard("", "kp-wtp", "Gravity tank & WTP / CTP", "07-LS-702 gravity tank → 07-P-704 → raw water tank CTP", `<b class="num">${esc(running("OP_P8") ? "Running" : "Stopped")}</b><small>07-P-704</small>`,
          secs([
            ["Equipment", [eqRow("Gravity tank → WTP pump 07-P-704", "OP_P8")]],
            ["Tank levels", [row("Gravity tank 07-LS-702", esc(gvTxt), gvCls), row("CTP raw water tank 08-LS-801/802", esc(cRawTxt), cRawCls),
              row("CTP pure water tank 08-LS-803/804", esc(cPureTxt), cPureCls)]],
            ["Logic", [row("Pump runs while", "gravity tank above LL and CTP raw tank below HH")]],
          ]), "", gvCls === "bad" ? "warn" : "")}
        ${kpCard("", "kp-pan", "Panel switches & linked panels", "OP panel push buttons and signals from the other plant panels", `<b class="num">${esc(swTxt(sw(SW.MODE), "Auto", "Manual"))}</b><small>system selector</small>`,
          secs([
            ["OP panel", [row("System auto start P.B.", esc(swTxt(sw("DI_Stm_Auto_St_Pb"), "Pressed", "Released"))),
              row("Sequential shutdown P.B.", esc(swTxt(sw("DI_Squen_Stwn"), "Pressed", "Released"))),
              row("Hooter accept P.B.", esc(swTxt(sw("DI_Htr_Acpt_Pb_With_lamp"), "Pressed", "Released"))),
              swRow("Instrument air 04-PS-401", SW.AIR, "OK", "LOW", false),
              row("Air dryer / auto drain (cmd)", `${auxTxt("DO_Air_Compressure_Dryer")} / ${auxTxt("DO_Auto_Drain_Valve")}`)]],
            ["Linked panels (signal 1 / 2)", panels.map(([n, p]) => row(`${n} panel`, `${pfdTxt(pfd(1, p))} / ${pfdTxt(pfd(2, p))}`, pfd(1, p) == null ? "unk" : "info"))],
          ]), "")}
      </div>`;
    box.querySelectorAll("[data-open]").forEach((el) => {
      el.onclick = (ev) => { if (!ev.target.closest("a")) MD.openTag(el.dataset.open); };
      el.onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); el.click(); } };
    });
    box.querySelectorAll("[data-sheet]").forEach((el) => (el.onclick = () => { setSheet(el.dataset.sheet); location.hash = "#mimic"; }));
  }
  // HH / H / L / LL set points (from the HMI) on the overview level cards; the reached one is lit
  function lvRow(t) {
    const lv = levelsOf(t), d = 0;
    return `<div class="kp-lvrow"><a class="kp-lvlink" href="#levels" title="Open Tank levels">Set points${plcLevels(t) ? " (HMI)" : ""}</a>
      ${LV_KEYS.map(([k, l]) => `<span class="kp-lv ${lvActive(t, k) ? `on ${k}` : ""}">${l} <b class="num">${Number(lv[k]).toFixed(d)}</b></span>`).join("")}</div>`;
  }
  const lvState = (t) => { const s = lvStatus(t)[0]; return s === "hh" || s === "ll" ? "warn" : ""; };
  function lampChip(id, label) {
    const v = sw(id);
    return `<span class="kp-eq ${v == null ? "unk" : v ? "lamp" : "stop"}" title="Float switch ${v == null ? "no data" : v ? "ON" : "OFF"}"><i></i>${esc(label)}</span>`;
  }

  // ---------- plant areas = mimic sheets ----------
  const AREAS = [
    { id: "overall", name: "Overall plant", eq: [], overall: true },
    { id: "sludge", name: "Sludge & filtrate", eq: ["AGIT", "OP_P1A", "OP_P1B", "PCP", "MV_01", "OP_P5A", "OP_P5B"] },
    { id: "raw", name: "Raw water", eq: ["OP_P6A", "OP_P6B", "OP_P14", "OP_P15"] },
    { id: "ct1", name: "Cooling tower 1", eq: ["OP_F1", "OP_P7", "OP_P3", "OP_P11"] },
    { id: "ct2", name: "Cooling tower 2 & hot water", eq: ["OP_F2", "OP_P10", "OP_P2"] },
    { id: "degas", name: "De-gasifier & dosing", eq: ["OP_M1", "OP_P4", "OP_P9", "OP_P12", "OP_P13", "OP_P8", "OP_SV1", "OP_SV2"] },
    { id: "wtp", name: "WTP / CTP", eq: [] },
  ];
  function areaChip(a) {
    const list = a.eq.map(eq).filter(Boolean);
    const motors = list.filter((e) => e.type === "motor");
    const run = motors.filter((e) => ["RUNNING", "STARTING"].includes(e.status)).length;
    const trip = list.filter((e) => ["TRIP", "FAULT"].includes(e.status)).length;
    return `<button class="kp-area ${trip ? "trip" : run ? "run" : ""}" data-sheet="${a.id}">
      <span class="ka-n">${esc(a.name)}</span>
      <span class="ka-s">${motors.length ? `<b class="num">${run}</b>/${motors.length} running` : "Level switches"}${trip ? ` · <b class="t">${trip} tripped</b>` : ""}</span>
      <span class="ka-go">Mimic →</span></button>`;
  }

  // ======================================================================================
  // MIMIC - SVG process sheets. Built once per sheet; live values are patched in place.
  // ======================================================================================
  const W = 1000, H = 560;
  // drawing primitives (all return SVG strings)
  const P = {
    pipe(d, kind, flow = []) {
      // arrow at the end of the line shows the flow direction
      return `<path class="pp k-${kind}" d="${d}" marker-end="url(#ar-${kind})"/><path class="pf k-${kind}" d="${d}" data-flow="${flow.join(",")}"/>`;
    },
    tank(x, y, w, h, o = {}) {
      const id = o.level ? `data-lvl="${o.level}"` : o.sw ? `data-swl="${o.sw.map((s) => `${s.id}:${s.at}`).join(",")}"` : "";
      let s = `<g class="tank${o.sw && !o.level ? " ind" : ""}"><rect class="t-body" x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.r ?? 6}"/>
        <clipPath id="cl${x}_${y}"><rect x="${x + 3}" y="${y + 3}" width="${w - 6}" height="${h - 6}" rx="${Math.max(0, (o.r ?? 6) - 2)}"/></clipPath>
        <rect class="t-fill ${o.fluid || "water"}" clip-path="url(#cl${x}_${y})" x="${x}" y="${y + h}" width="${w}" height="0" ${id} data-y0="${y}" data-h="${h}"/>`;
      if (o.label) s += `<text class="t-lbl" x="${x + w / 2}" y="${y + h + (o.labelDy ?? 18)}" text-anchor="middle">${esc(o.label)}</text>`;
      const rx = x + (o.readX ?? w / 2);                 // level readout position (moved aside when pump risers pass through)
      if (o.level) s += `<g class="t-read" data-tag="${o.level}"><rect x="${rx - 44}" y="${y + 10}" width="88" height="34" rx="6"/>
        <text class="tr-v num" x="${rx}" y="${y + 26}" text-anchor="middle" data-val="${o.level}">--</text>
        <text class="tr-p" x="${rx}" y="${y + 39}" text-anchor="middle" data-pct="${o.level}">--</text></g>`;
      (o.sw || []).forEach((sv, i) => (s += P.lamp(x + w + 8, y + h * sv.at, sv.id, sv.label)));
      if (o.level) {                                    // HH / H / L / LL: lamps beside the tank + dashed set-point lines inside
        [0.1, 0.3, 0.7, 0.9].forEach((at, i) => {
          const [k, l] = LV_KEYS[i];
          s += P.lvLamp(x + w + 8, y + h * at, `${o.level}:${k}`, l);
          s += `<g class="lv-ln" data-lvln="${o.level}:${k}" data-y0="${y}" data-h="${h}"><line x1="${x + 4}" x2="${x + w - 4}" y1="${y + h}" y2="${y + h}"/>
            <text x="${x + w - 8}" y="${y + h - 3}" text-anchor="end">${l}</text></g>`;
        });
      }
      return s + "</g>";
    },
    lvLamp(x, y, key, label) {                          // level set-point lamp, lit from the transmitter value
      return `<g class="lamp lvl" data-lv="${key}"><rect x="${x}" y="${y - 9}" width="30" height="18" rx="9"/><text x="${x + 15}" y="${y + 4}" text-anchor="middle">${esc(label)}</text></g>`;
    },
    lamp(x, y, id, label) {
      return `<g class="lamp" data-sw="${id}"><rect x="${x}" y="${y - 9}" width="30" height="18" rx="9"/><text x="${x + 15}" y="${y + 4}" text-anchor="middle">${esc(label)}</text></g>`;
    },
    pump(x, y, id, o = {}) {
      const lbl = o.label ?? PID[id] ?? id;
      // motor + centrifugal pump set on a base plate (shaded like the HMI graphic); motor colour = state,
      // status light top-left, impeller in the volute spins while running
      const fins = [-18, -14, -10, -6].map((d) => `<line class="pm-fin" x1="${x + d}" y1="${y - 7}" x2="${x + d}" y2="${y + 7}"/>`).join("");
      return `<g class="eq pump" data-eq="${id}" tabindex="0" transform="translate(${x} ${y}) scale(1.2) translate(${-x} ${-y})">
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
        <circle class="pm-led" cx="${x - 12}" cy="${y - 13}" r="3.5"/>
        <text class="eq-t" x="${x}" y="${y + (o.below === false ? -24 : 30)}" text-anchor="middle">${esc(lbl)}</text>
        ${o.name !== false && PUMP_NAME[id] ? `<text class="eq-n" x="${x}" y="${y + (o.below === false ? -34 : 40)}" text-anchor="middle">${esc(PUMP_NAME[id])}</text>` : ""}</g>`;
    },
    // submersible pump (P&ID: sludge / filtrate tank pumps, borewell pumps): vertical body standing on the floor at (x, y),
    // motor at the bottom (coloured by state), intake screen, discharge flange on top at y - 50; name beside it
    subPump(x, y, id, o = {}) {
      const tagTxt = o.label ?? PID[id] ?? id, nm = PUMP_NAME[id] || "", side = o.side || "right";
      const bw = 8 + Math.max(tagTxt.length * 6.6, nm.length * 5.2);
      const below = side === "below";                    // label under the pump (borewell pumps)
      const tx = below ? x : side === "left" ? x - 14 : x + 14, anchor = below ? "middle" : side === "left" ? "end" : "start";
      const bx = below ? x - bw / 2 : side === "left" ? tx - bw + 4 : tx - 4, ly = below ? y + 44 : y;
      const fins = [-26, -20, -14].map((d) => `<line class="pm-fin" x1="${x - 8}" y1="${y + d}" x2="${x + 8}" y2="${y + d}"/>`).join("");
      return `<g class="eq pump sub" data-eq="${id}" tabindex="0">
        <rect class="pm-noz" x="${x - 5}" y="${y - 50}" width="10" height="6" rx="1"/>
        <rect class="pm-cap" x="${x - 7}" y="${y - 44}" width="14" height="10" rx="2"/>
        <line class="pm-scr" x1="${x - 4}" y1="${y - 42}" x2="${x - 4}" y2="${y - 36}"/><line class="pm-scr" x1="${x}" y1="${y - 42}" x2="${x}" y2="${y - 36}"/><line class="pm-scr" x1="${x + 4}" y1="${y - 42}" x2="${x + 4}" y2="${y - 36}"/>
        <rect class="pm-motor" x="${x - 9}" y="${y - 34}" width="18" height="28" rx="4"/>${fins}
        <rect class="pm-base" x="${x - 11}" y="${y - 6}" width="22" height="6" rx="1.5"/>
        <circle class="pm-led" cx="${x}" cy="${y - 10}" r="2.6"/>
        <rect class="pm-lb" x="${bx}" y="${ly - 41}" width="${bw}" height="${nm ? 27 : 16}" rx="4"/>
        <text class="eq-t" x="${tx}" y="${ly - 29}" text-anchor="${anchor}">${esc(tagTxt)}</text>
        ${nm ? `<text class="eq-n" x="${tx}" y="${ly - 18}" text-anchor="${anchor}">${esc(nm)}</text>` : ""}</g>`;
    },
    ground(x1, x2, y, label = "ground level") {         // ground line with hatching (borewell pumps hang below it)
      let h = "";
      for (let x = x1; x < x2; x += 10) h += `M${x} ${y} l-7 9 `;
      return `<g class="gnd"><line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"/><path d="${h}"/><text x="${x2 - 2}" y="${y - 4}" text-anchor="end">${esc(label)}</text></g>`;
    },
    well(x, y1, y2) { return `<rect class="well" x="${x - 13}" y="${y1}" width="26" height="${y2 - y1}" rx="3"/>`; },
    fan(x, y, id, label) {
      return `<g class="eq fan" data-eq="${id}" tabindex="0"><circle cx="${x}" cy="${y}" r="15"/>
        <g class="spin" style="transform-origin:${x}px ${y}px"><path class="eq-ic" d="M${x} ${y} l0 -11 a5 5 0 0 1 5 5 Z M${x} ${y} l11 0 a5 5 0 0 1 -5 5 Z M${x} ${y} l0 11 a5 5 0 0 1 -5 -5 Z M${x} ${y} l-11 0 a5 5 0 0 1 5 -5 Z"/></g>
        <text class="eq-t" x="${x}" y="${y - 22}" text-anchor="middle">${esc(label ?? PID[id] ?? id)}</text></g>`;
    },
    mixer(x, y, id, label) {
      return `<g class="eq mixer" data-eq="${id}" tabindex="0"><line x1="${x}" y1="${y - 40}" x2="${x}" y2="${y}" class="shaft"/>
        <g class="spin" style="transform-origin:${x}px ${y}px"><path class="eq-ic" d="M${x - 14} ${y - 4} L${x + 14} ${y + 4} M${x - 14} ${y + 4} L${x + 14} ${y - 4}"/></g>
        <circle cx="${x}" cy="${y - 44}" r="9"/><text class="eq-t" x="${x + 14}" y="${y - 40}">${esc(label ?? PID[id] ?? id)}</text></g>`;
    },
    valve(x, y, id, o = {}) {
      return `<g class="eq valve" data-eq="${id}" tabindex="0"><path d="M${x - 11} ${y - 8} L${x + 11} ${y + 8} L${x + 11} ${y - 8} L${x - 11} ${y + 8} Z"/>
        <line x1="${x}" y1="${y}" x2="${x}" y2="${y - 14}" class="stem"/><rect x="${x - 7}" y="${y - 20}" width="14" height="7" rx="1" class="act"/>
        <text class="eq-t" x="${x}" y="${y + (o.below ? 24 : -26)}" text-anchor="middle">${esc(o.label ?? PID[id] ?? id)}</text></g>`;
    },
    tx(x, y, id, label) {                                 // transmitter bubble, tag no above, live value below
      return `<g class="tx" data-tag="${id}" tabindex="0">
        <circle cx="${x}" cy="${y}" r="13"/><text class="tx-i" x="${x}" y="${y + 4}" text-anchor="middle">${esc(label.split("-")[0])}</text>
        <rect class="tx-box" x="${x - 44}" y="${y + 17}" width="88" height="22" rx="5"/>
        <text class="tx-v num" x="${x}" y="${y + 32}" text-anchor="middle" data-val="${id}">--</text>
        <text class="tx-n" x="${x}" y="${y - 18}" text-anchor="middle">${esc(TAG_PID[id] || label)}</text></g>`;
    },
    box(x, y, w, h, text, kind = "") {
      const lines = String(text).split("\n");
      return `<g class="dest ${kind}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>${lines.map((l, i) =>
        `<text x="${x + w / 2}" y="${y + h / 2 + 4 + (i - (lines.length - 1) / 2) * 14}" text-anchor="middle">${esc(l)}</text>`).join("")}</g>`;
    },
    // induced-draft cooling tower (footprint x..x+120, y-24..y+144): fan stack on top (fan drawn at x+60, y-11),
    // drift eliminator, spray, fill pack, air-inlet louvers and the cold-water basin at the bottom
    tower(x, y, label) {
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
        <text class="t-lbl" x="${x + 60}" y="${y + 162}" text-anchor="middle">${esc(label)}</text></g>`;
    },
    hx(x, y, label) {
      return `<g class="hx"><rect x="${x}" y="${y}" width="44" height="90" rx="5"/><path d="M${x + 8} ${y + 14} L${x + 36} ${y + 14} M${x + 8} ${y + 32} L${x + 36} ${y + 32} M${x + 8} ${y + 50} L${x + 36} ${y + 50} M${x + 8} ${y + 68} L${x + 36} ${y + 68}"/>
        <text class="t-lbl" x="${x + 22}" y="${y + 108}" text-anchor="middle">${esc(label)}</text></g>`;
    },
    text(x, y, s, cls = "note") { return `<text class="${cls}" x="${x}" y="${y}">${esc(s)}</text>`; },
    chip(x, y, ids, label, w = 150) {                   // compact live readout (one or two values), click for the trend
      return `<g class="chip" data-tag="${ids[0]}" tabindex="0"><rect x="${x - w / 2}" y="${y - 11}" width="${w}" height="22" rx="6"/>
        <text class="ch-l" x="${x - w / 2 + 7}" y="${y + 4}">${esc(label)}</text>
        <text class="ch-v num" x="${x + w / 2 - 7}" y="${y + 4}" text-anchor="end" data-vals="${ids.join(",")}">--</text></g>`;
    },
  };
  const LS = (id, at, label) => ({ id: SW[id], at, label });

  // small label with a light background, placed on a connection line
  function CL(x, y, text, anchor = "start") {
    const w = 10 + text.length * 6.1, rx = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
    return `<g class="cl"><rect x="${rx}" y="${y - 11}" width="${w}" height="16" rx="8"/><text x="${rx + w / 2}" y="${y + 1}" text-anchor="middle">${esc(text)}</text></g>`;
  }

  const SHEETS = {
    overall: {
      name: "Overall plant - complete process", note: "One drawing of the whole plant: 1 water supply · 2 sludge & hot water · 3 water recovery. Click a pump or value for details; the tabs above show each area larger.",
      vb: [1400, 965],
      draw: () => [
        `<text class="band" x="1385" y="20" text-anchor="end">1 · WATER SUPPLY</text><text class="band" x="1385" y="282" text-anchor="end">2 · SLUDGE &amp; HOT WATER</text><text class="band" x="1385" y="574" text-anchor="end">3 · WATER RECOVERY</text>`,
        // ---- 1 water supply: borewell pumps -> raw water tank -> supply pumps -> header -> towers / hot water tank
        P.pipe("M88 98 L120 98 M88 200 L120 200 M120 98 L120 200 M120 150 L148 150", "water", ["OP_P6A", "OP_P6B"]),
        P.pump(60, 98, "OP_P6A"), P.pump(60, 200, "OP_P6B"),
        P.lamp(140, 258, SW.FLOW, "FS"), P.text(176, 262, "03-FS-301 flow"),
        P.tank(150, 60, 190, 150, { fluid: "water", label: "Raw water tank (03-LS-301)", sw: [LS("LS301_HL", 0.18, "HL"), LS("LS301_LL", 0.85, "LL")] }),
        P.pipe("M260 210 L260 235 L395 235 L395 108 L412 108 M395 210 L412 210", "water", ["OP_P14", "OP_P15"]),
        P.pump(440, 108, "OP_P14"), P.pump(440, 210, "OP_P15"),
        P.pipe("M468 108 L500 108 M468 210 L500 210 M500 108 L500 210 M500 160 L560 160 L560 40 L1360 40", "water", ["OP_P14", "OP_P15"]),
        P.tx(610, 120, "PT_01", "PT-301"),
        P.text(585, 32, "raw water header: make-up to towers, hot water tank, boiler, vacuum pump, sludge screen"),
        P.pipe("M688 40 L688 72", "water", ["OP_P14", "OP_P15"]), P.tower(670, 70, "Cooling tower-1 (06-LS-601)"), P.fan(730, 59, "OP_F1", ""), P.text(764, 54, "06-F-601", "fan-l"),
        P.lamp(798, 160, SW.LS601_HL, "HL"), P.lamp(798, 195, SW.LS601_LL, "LL"),
        P.pipe("M790 205 L815 205 L815 90 L837 90 M815 150 L837 150 M815 205 L815 210 L837 210", "water", ["OP_P7", "OP_P3", "OP_P11"]),
        P.pump(865, 90, "OP_P7", { name: false }), P.pump(865, 150, "OP_P3", { name: false }), P.pump(865, 210, "OP_P11", { name: false }),
        P.text(900, 94, "De-gasifier PHE pump", "dtxt"), P.text(900, 154, "Dryer condenser pump", "dtxt"), P.text(900, 214, "Boiler cooling pump", "dtxt"),
        P.pipe("M1040 40 L1040 298", "water", ["OP_P14", "OP_P15"]),
        P.pipe("M1128 40 L1128 72", "water", ["OP_P14", "OP_P15"]), P.tower(1110, 70, "Cooling tower-2 (06-LS-602)"), P.fan(1170, 59, "OP_F2", ""), P.text(1204, 54, "06-F-602", "fan-l"),
        P.lamp(1238, 160, SW.LS602_HL, "HL"), P.lamp(1238, 195, SW.LS602_LL, "LL"),
        P.pipe("M1230 205 L1262 205 L1262 150 L1292 150", "water", ["OP_P10"]), P.pump(1320, 150, "OP_P10", { name: false }),
        P.text(1278, 214, "Turbine oil cooling", "dtxt"),
        // ---- 2 sludge & hot water
        P.box(20, 300, 100, 30, "Sludge in"), P.pipe("M70 330 L70 400 L128 400", "sludge", ["MV_01"]), P.valve(100, 400, "MV_01", { label: "01-MV-101" }),
        P.tank(130, 340, 200, 130, { level: "LT_01", fluid: "sludge", label: "Sludge storage tank", readX: 155 }), P.mixer(315, 455, "AGIT", ""),
        P.pipe("M165 414 L165 326 M225 414 L225 326 M165 326 L410 326 L410 480 L442 480", "sludge", ["OP_P1A", "OP_P1B"]),
        P.subPump(165, 464, "OP_P1A", { side: "left" }), P.subPump(225, 464, "OP_P1B"),
        
        P.pump(470, 480, "PCP", { label: "OP-P201" }),
        P.pipe("M481 461 L481 422", "sludge", ["PCP"]),
        P.box(430, 360, 130, 60, "Volute press\n(screw press)", "dest-proc"),
        P.pipe("M560 385 L618 385", "sludge", ["PCP"]), P.text(563, 377, "cake"),
        P.pipe("M505 420 L505 648", "water", ["PCP"]), CL(511, 545, "filtrate"),
        `<g class="dest dest-proc"><rect x="620" y="355" width="200" height="80" rx="6"/><text x="720" y="375" text-anchor="middle" class="dr-t">Sludge dryer</text></g><g class="chip" data-tag="T_02"><text class="ch-l" x="630" y="398">Hot water in</text><text class="ch-v num" x="812" y="398" text-anchor="end" data-vals="T_02,PT_03">--</text></g><g class="chip" data-tag="T_01"><text class="ch-l" x="630" y="420">Hot water out</text><text class="ch-v num" x="812" y="420" text-anchor="end" data-vals="T_01,PT_02">--</text></g>`,
        P.tank(930, 300, 130, 100, { fluid: "hot", label: "Hot water tank (06-LS-603)", sw: [LS("LS603_HL", 0.2, "HL"), LS("LS603_LL", 0.8, "LL")] }),
        P.pipe("M995 400 L995 455 L928 455", "hot", ["OP_P2"]), P.pump(900, 455, "OP_P2"),
        P.pipe("M872 455 L845 455 L845 410 L822 410", "hot", ["OP_P2"]),
        
        P.pipe("M760 435 L760 540 L1080 540 L1080 488 L1098 488", "hot", ["OP_P2"]), CL(900, 540, "hot water to radiator", "middle"),
        P.box(1100, 470, 100, 36, "Radiator", "dest-proc"), P.pipe("M1200 488 L1228 488", "hot", ["OP_P2"]),
        P.box(1230, 470, 140, 36, "Surface condenser", "dest-proc"), P.chip(1240, 530, ["T_03", "PT_04"], "After radiator", 210),
        P.pipe("M1295 470 L1295 430 L1040 430 L1040 402", "hot", ["OP_P2"]), CL(1160, 430, "hot water return", "middle"),
        // ---- 3 water recovery
        P.tank(470, 650, 200, 120, { level: "LT_02", fluid: "water", label: "Filtrate tank", readX: 125 }),
        P.pipe("M545 714 L545 610 L645 610 M645 714 L645 610 M600 610 L600 598", "water", ["OP_P5A", "OP_P5B"]),
        P.subPump(545, 764, "OP_P5A", { side: "left" }), P.subPump(645, 764, "OP_P5B", { side: "left" }),
        P.box(555, 570, 90, 26, "To client reuse"),
        P.pipe("M724 435 L724 640 L752 640", "water", ["OP_P4"]), CL(730, 520, "condensate"),
        P.pump(780, 640, "OP_P4"), P.pipe("M808 640 L848 640", "water", ["OP_P4"]),
        P.tank(850, 615, 110, 165, { fluid: "water", label: "De-gasifier (07-LS-701)", r: 14,
          sw: [LS("LS701_HH", 0.1, "HH"), LS("LS701_H", 0.3, "H"), LS("LS701_L", 0.7, "L"), LS("LS701_LL", 0.9, "LL")] }),
        P.chip(905, 642, ["PH_01"], "pH", 90),
        P.fan(1012, 700, "OP_M1", "OP-M1"), P.pipe("M997 700 L964 700", "air", ["OP_M1"]),
        P.pipe("M905 780 L905 810", "water", ["OP_P9"]), P.pump(905, 830, "OP_P9"),
        P.pipe("M933 830 L1062 830 L1062 742", "water", ["OP_P9"]), P.hx(1040, 650, "PHE-1"),
        P.pipe("M1062 650 L1062 605 L930 605 L930 613", "water", ["OP_P9"]), P.chip(1062, 790, ["T_04"], "PHE temp", 130),
        P.box(1150, 770, 80, 26, "LP steam"), P.pipe("M1190 770 L1190 700 L1086 700", "steam", ["OP_SV1"]), P.valve(1135, 700, "OP_SV1", { label: "07-XV-701" }),
        P.pump(772, 760, "OP_P12"), P.pump(772, 860, "OP_P13"),
        P.pipe("M800 760 L848 760 M800 860 L818 860 L818 760", "chem", ["OP_P12", "OP_P13"]),
        P.pipe("M880 615 L880 592 L1275 592 L1275 638", "water", ["OP_SV2"]), P.valve(1150, 592, "OP_SV2", { label: "07-XV-702" }),
        P.tank(1220, 640, 110, 90, { fluid: "water", label: "Gravity PP tank (07-LS-702)", sw: [LS("LS702_HL", 0.2, "HL"), LS("LS702_LL", 0.8, "LL")] }),
        P.pipe("M1275 730 L1275 735 M1275 754 L1275 770", "water", ["OP_P8"]), P.pump(1275, 790, "OP_P8"),
        P.pipe("M1303 790 L1318 790", "water", ["OP_P8"]), P.box(1320, 775, 75, 34, "To WTP"),
        P.lamp(1322, 826, SW.LS801, "HH"), P.lamp(1356, 826, SW.LS802, "LL"),
        P.pipe("M1395 800 L1395 945 L15 945 L15 50 L245 50 L245 58", "ctp", []), CL(700, 945, "treated water from WTP / CTP back to the raw water tank", "middle"),
      ],
    },
    sludge: {
      name: "Sludge & filtrate", note: "Feed valve opens at LL, closes at HH · Mixer starts 60 s before the sludge pump",
      draw: () => [
        // P&ID sheet 1: both pump pairs are submersible, standing on the tank floor; discharge risers leave through the tank top
        P.box(10, 240, 90, 36, "Sludge in"), P.pipe("M100 258 L148 258", "sludge", ["MV_01"]), P.valve(124, 258, "MV_01", { label: "01-MV-101" }),
        P.tank(150, 150, 300, 260, { level: "LT_01", fluid: "sludge", label: "Sludge storage tank", readX: 205 }),
        P.mixer(405, 385, "AGIT", "OP-A1"),
        P.pipe("M190 352 L190 112 M260 352 L260 112 M190 112 L520 112 L520 250 L530 250", "sludge", ["OP_P1A", "OP_P1B"]),
        P.subPump(190, 404, "OP_P1A", { side: "left" }), P.subPump(260, 404, "OP_P1B"),
        P.pump(560, 250, "PCP", { label: "OP-P201" }),
        P.pipe("M588 250 L605 250 L605 120 L618 120", "sludge", ["PCP"]),
        P.box(620, 95, 140, 50, "Volute press\n(screw press)", "dest-proc"),
        P.pipe("M690 145 L690 200 L720 200 L720 228", "water", ["PCP"]), P.text(696, 192, "filtrate"),
        P.tank(690, 230, 230, 200, { level: "LT_02", fluid: "water", label: "Filtrate tank", readX: 105 }),
        P.pipe("M740 374 L740 172 M850 374 L850 172 M740 172 L960 172 L960 60 L860 60", "water", ["OP_P5A", "OP_P5B"]),
        P.subPump(740, 424, "OP_P5A", { side: "left" }), P.subPump(850, 424, "OP_P5B", { side: "left" }),
        P.box(760, 40, 100, 40, "To client\n(reuse)"),
      ],
    },
    raw: {
      name: "Raw water distribution", note: "UG pumps fill on LL, stop on HL · Transfer pumps (VFD) hold header ≥ 3 bar, stop on LL",
      draw: () => {
        const dests = ["Boiler RO + DM make-up", "Boiler wet scrubber conveyor", "Cooling tower-1 make-up", "Cooling tower-2 make-up",
          "Vacuum pump & KO drum", "Volute press", "Sludge screen", "Hot water tank make-up"];
        return [
          P.pump(60, 480, "OP_P6A"), P.pump(170, 480, "OP_P6B"),
          P.pipe("M88 480 L110 480 L110 430 M140 480 L110 480", "water", ["OP_P6A", "OP_P6B"]),
          P.pipe("M110 430 L110 160 L200 160", "water", ["OP_P6A", "OP_P6B"]),
          P.lamp(30, 330, SW.FLOW, "FS"), P.text(22, 356, "03-FS-301 flow"), P.pipe("M60 330 L110 330", "ctp"),
          P.box(30, 60, 130, 40, "From CTP plant"), P.pipe("M95 100 L95 130 L200 130 L200 160", "ctp"),
          P.tank(200, 140, 260, 220, { fluid: "water", label: "Raw water storage tank (03-LS-301)", sw: [LS("LS301_HL", 0.18, "HL"), LS("LS301_LL", 0.85, "LL")] }),
          P.pipe("M460 320 L520 320", "water", ["OP_P14", "OP_P15"]),
          P.pipe("M520 320 L520 250 L560 250 M520 320 L520 390 L560 390", "water", ["OP_P14", "OP_P15"]),
          P.pump(575, 250, "OP_P14"), P.pump(575, 390, "OP_P15"),
          P.pipe("M590 250 L640 250 L640 390 L590 390 M640 320 L700 320", "water", ["OP_P14", "OP_P15"]),
          P.tx(670, 268, "PT_01", "PT-301"),
          P.pipe(`M700 ${50} L700 ${50 + 64 * 7}`, "water", ["OP_P14", "OP_P15"]),
          ...dests.map((d, i) => P.pipe(`M700 ${50 + 64 * i} L760 ${50 + 64 * i}`, "water", ["OP_P14", "OP_P15"]) + P.box(760, 30 + 64 * i, 210, 40, d)),
          P.box(240, 420, 200, 40, "Wash room & general purpose"), P.pipe("M200 380 L200 440 L240 440", "water"),
        ];
      },
    },
    ct1: {
      name: "Cooling tower 1", note: "CT pumps run when 06-LS-601 above L, stop at LL · Fan runs only with a CT-1 pump",
      draw: () => [
        P.box(30, 400, 120, 40, "Make-up water"), P.pipe("M150 420 L200 420", "water"),
        P.tower(200, 190, "Cooling tower-1 (06-LS-601)"), P.fan(260, 179, "OP_F1"),
        P.lamp(330, 260, SW.LS601_HL, "HL"), P.lamp(330, 300, SW.LS601_LL, "LL"),
        P.pipe("M308 320 L420 320 L420 120 L540 120", "water", ["OP_P7"]), P.pipe("M420 320 L420 290 L540 290", "water", ["OP_P3"]),
        P.pipe("M420 320 L420 450 L540 450", "water", ["OP_P11"]),
        P.pump(555, 120, "OP_P7"), P.pump(555, 290, "OP_P3"), P.pump(555, 450, "OP_P11"),
        P.pipe("M570 120 L680 120", "water", ["OP_P7"]), P.box(680, 100, 170, 40, "De-gasifier PHE"),
        P.pipe("M570 290 L680 290", "water", ["OP_P3"]), P.box(680, 270, 170, 40, "Dryer surface condenser"),
        P.pipe("M570 450 L680 450", "water", ["OP_P11"]), P.box(680, 430, 170, 40, "Boiler cooling water"),
        P.pipe("M850 120 L940 120 L940 60 L130 60 L130 230 L200 230", "water", ["OP_P7", "OP_P3", "OP_P11"]),
        P.pipe("M850 290 L900 290 L900 60", "water", ["OP_P3"]), P.pipe("M850 450 L940 450 L940 120", "water", ["OP_P11"]),
        P.text(500, 52, "warm return to tower"),
      ],
    },
    ct2: {
      name: "Cooling tower 2 & hot water loop", note: "Hot water pump 06-P-605 runs above LL of 06-LS-603 · Fan OP-F602 runs with pump 06-P-604",
      draw: () => [
        P.tower(620, 60, "Cooling tower-2 (06-LS-602)"), P.fan(680, 49, "OP_F2"),
        P.lamp(750, 130, SW.LS602_HL, "HL"), P.lamp(750, 170, SW.LS602_LL, "LL"),
        P.pipe("M728 190 L830 190 L830 240", "water", ["OP_P10"]), P.pump(830, 255, "OP_P10", { label: "06-P-604" }),
        P.pipe("M845 255 L900 255", "water", ["OP_P10"]), P.box(860, 270, 120, 40, "Turbine oil PHE"),
        P.pipe("M920 270 L920 30 L600 30 L600 100 L632 100", "water", ["OP_P10"]),
        P.tank(60, 380, 150, 110, { fluid: "hot", label: "Hot water tank (06-LS-603)", sw: [LS("LS603_HL", 0.2, "HL"), LS("LS603_LL", 0.8, "LL")] }),
        P.pipe("M210 470 L290 470", "hot", ["OP_P2"]), P.pump(305, 470, "OP_P2"),
        P.pipe("M320 470 L560 470 L560 380 L600 380", "hot", ["OP_P2"]),
        P.tx(380, 420, "T_02", "TT-601"), P.tx(470, 420, "PT_03", "PT-601"),
        P.box(600, 360, 120, 44, "Sludge dryer", "dest-proc"),
        P.pipe("M660 360 L660 330 L560 330 L560 240 L470 240", "hot", ["OP_P2"]),
        P.tx(500, 275, "PT_02", "PT-602"), P.tx(620, 275, "T_01", "TT-dryer"),
        P.box(380, 220, 90, 40, "Radiator", "dest-proc"),
        P.pipe("M380 240 L170 240 L170 300", "hot", ["OP_P2"]), P.tx(220, 185, "PT_04", "PT-603"), P.tx(330, 185, "T_03", "TT-rad"),
        P.box(100, 300, 150, 40, "Surface condenser", "dest-proc"), P.pipe("M135 340 L135 380", "hot", ["OP_P2"]),
        P.box(20, 230, 90, 34, "Turbine"), P.box(260, 300, 90, 34, "Boiler"),
      ],
    },
    degas: {
      name: "De-gasifier, pH dosing & gravity tank", note: "Acid starts ≤ 6.5 pH · Alkali starts ≥ 7.5 pH · Steam 07-XV-701 opens ≤ 70 °C, closes ≥ 90 °C",
      draw: () => [
        P.box(20, 440, 170, 50, "Process condensate\nfrom dryer (T-101)"), P.pump(240, 465, "OP_P4"),
        P.pipe("M190 465 L225 465 M255 465 L290 465 L290 300 L320 300", "water", ["OP_P4"]),
        P.fan(120, 90, "OP_M1", "OP-M1 hot air blower"), P.pipe("M135 90 L340 90 L340 120", "air", ["OP_M1"]),
        P.tank(320, 120, 160, 260, { fluid: "water", label: "De-gasifier (07-LS-701)", r: 14,
          sw: [LS("LS701_HH", 0.1, "HH"), LS("LS701_H", 0.3, "H"), LS("LS701_L", 0.7, "L"), LS("LS701_LL", 0.9, "LL")] }),
        P.pipe("M400 380 L400 470 L460 470", "water", ["OP_P9"]), P.pump(475, 470, "OP_P9"),
        P.pipe("M490 470 L600 470 L600 310", "water", ["OP_P9"]), P.hx(578, 200, "PHE-1"),
        P.pipe("M600 200 L600 160 L480 160", "water", ["OP_P9"]),
        P.box(760, 60, 150, 36, "LP steam inlet"), P.pipe("M760 78 L700 78 L700 230 L622 230", "steam", ["OP_SV1"]),
        P.valve(730, 78, "OP_SV1", { below: true }), P.tx(660, 300, "T_04", "TT-701"),
        P.tx(535, 392, "PH_01", "AT-pH"),
        P.box(560, 526, 100, 30, "Acid tank 80 L"), P.box(700, 526, 110, 30, "Alkali tank 80 L"),
        P.pump(610, 505, "OP_P12", { below: false, name: false }), P.pump(755, 505, "OP_P13", { below: false, name: false }),
        P.pipe("M610 490 L610 440 M755 490 L755 440 L540 440 L540 470", "chem", ["OP_P12", "OP_P13"]),
        P.pipe("M480 250 L820 250 L820 300", "water", ["OP_SV2"]), P.valve(760, 250, "OP_SV2", { label: "07-XV-702 outlet" }),
        P.tank(800, 300, 140, 110, { fluid: "water", label: "Gravity PP tank (07-LS-702)", sw: [LS("LS702_HL", 0.2, "HL"), LS("LS702_LL", 0.8, "LL")] }),
        P.pipe("M870 410 L870 420 M870 436 L870 500 L900 500", "water", ["OP_P8"]), P.pump(915, 500, "OP_P8"),
        P.pipe("M930 500 L975 500 L975 150", "water", ["OP_P8"]), P.box(905, 110, 90, 40, "To WTP"),
      ],
    },
    wtp: {
      name: "WTP / CTP plant", note: "Packaged WTP: only the CTP tank float switches are wired to this panel",
      draw: () => {
        const steps = ["Sand filter", "Carbon filter", "pH / antiscalant dosing", "Micron filter", "Booster pump", "RO / membrane", "UV sterilizer"];
        return [
          P.tank(40, 140, 130, 200, { fluid: "water", label: "Raw water tank CTP", sw: [LS("LS801", 0.15, "HH"), LS("LS802", 0.85, "LL")] }),
          P.pipe("M170 300 L230 300 L230 110 L940 110 L940 330", "ctp"),
          ...steps.map((s, i) => P.box(230 + i * 102, 150, 92, 70, s.replace(" / ", " /\n").replace(" filter", "\nfilter"), "dest-proc")),
          P.pipe("M940 330 L940 420 L700 420", "ctp"),
          P.tank(560, 340, 130, 170, { fluid: "pure", label: "Pure water tank CTP", sw: [LS("LS803", 0.15, "HH"), LS("LS804", 0.85, "LL")] }),
          P.pipe("M560 450 L420 450", "water"), P.box(260, 430, 160, 40, "Drinking water tank"),
          P.box(260, 330, 160, 40, "Mineral cartridge"), P.pipe("M420 350 L560 350", "water"),
        ];
      },
    },
  };

  function legend() {
    return `<div class="mm-guide"><b>How to read:</b>
      <span><i class="g-run"></i>Green machine = running</span><span><i class="g-stop"></i>Grey = stopped</span>
      <span><i class="g-trip"></i>Red, blinking = tripped (fault)</span><span><i class="g-flow"></i>Moving dashes = liquid is flowing, arrow shows the direction</span>
      <span><i class="g-lamp"></i>Yellow lamp = float switch ON (water has reached that level)</span>
      <span><i class="g-trip"></i>HH / LL lamp red, <i class="g-hl"></i>H / L lamp orange = tank level reached that set point (dashed line)</span><span>👆 Click any pump, valve or value to see details</span></div>
      <div class="mm-legend">${[["water", "Water"], ["hot", "Hot water"], ["sludge", "Sludge"], ["steam", "Steam"], ["air", "Air"],
      ["chem", "Chemical dosing"], ["ctp", "CTP line"]].map(([k, l]) => `<span><i class="lg k-${k}"></i>${l}</span>`).join("")}
      <span class="sep"></span><span><i class="lg-eq run"></i>Running / open</span><span><i class="lg-eq stop"></i>Stopped / closed</span>
      <span><i class="lg-eq trip"></i>Tripped</span><span><i class="lg-lamp"></i>Float switch ON</span>
      <span class="muted">Moving dashes = flow (pump running) · Hatched tank = level from float switches only</span></div>`;
  }
  function setSheet(id) {
    if (!SHEETS[id]) return;
    sheet = id;
    try { localStorage.setItem("md-mimic2", id); } catch (_) {}
    const box = $("mimicSvg");
    if (box) box._sheet = null;
  }
  function renderMimic() {
    const tabs = $("mimicTabs"), box = $("mimicSvg");
    if (!tabs || !box) return;
    if (!SHEETS[sheet]) sheet = "overall";              // a remembered sheet that no longer exists
    if (tabs._sheet !== sheet) {
      tabs._sheet = sheet;
      let n = 0;
      tabs.innerHTML = AREAS.map((a) => `<button class="${a.id === sheet ? "active" : ""}${a.overall ? " all" : ""}" data-s="${a.id}"><b>${a.d3 ? "3D" : a.overall ? "★" : ++n}</b> ${esc(a.name)}</button>`).join("");
      tabs.querySelectorAll("button").forEach((b) => (b.onclick = () => { setSheet(b.dataset.s); renderMimic(); }));
    }
    if (box._sheet !== sheet) {
      box._sheet = sheet;
      const s = SHEETS[sheet];
      const [vw, vh] = s.vb || [W, H];                  // the overall sheet uses a larger drawing area
      box.innerHTML = `<svg viewBox="0 0 ${vw} ${vh}" class="mimic${s.vb ? " big" : ""}" role="img" aria-label="${esc(s.name)} process mimic">
        <defs>
          ${[["water", "#2f7fd1"], ["hot", "#e8731a"], ["sludge", "#a8781e"], ["steam", "#c43d3d"], ["air", "#1fb5b5"], ["chem", "#8e44c9"], ["ctp", "#3a3f2a"]]
            .map(([k, c]) => `<marker id="ar-${k}" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="${c}"/></marker>`).join("")}
          <linearGradient id="gCT" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#b9bdb4"/><stop offset=".35" stop-color="#eef0ea"/><stop offset=".7" stop-color="#d4d8cf"/><stop offset="1" stop-color="#a3a89d"/></linearGradient>
          <linearGradient id="gWater" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8cc4f0"/><stop offset="1" stop-color="#2f7fd1"/></linearGradient>
          <linearGradient id="gMetal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f4f1"/><stop offset=".45" stop-color="#c9c9c3"/><stop offset="1" stop-color="#85857e"/></linearGradient>
          <linearGradient id="gRun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b9ec7c"/><stop offset=".5" stop-color="#4fa612"/><stop offset="1" stop-color="#2b6a06"/></linearGradient>
          <linearGradient id="gStop" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ecece8"/><stop offset=".5" stop-color="#a9a9a2"/><stop offset="1" stop-color="#6f6f68"/></linearGradient>
          <linearGradient id="gTrip" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb3b3"/><stop offset=".5" stop-color="#d93a3f"/><stop offset="1" stop-color="#8d1c1f"/></linearGradient>
          <linearGradient id="gWarn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe2a0"/><stop offset=".5" stop-color="#e09a12"/><stop offset="1" stop-color="#8a5800"/></linearGradient>
          <pattern id="hatch" width="8" height="8" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><rect width="8" height="8" class="hatch-bg"/><line x1="0" y1="0" x2="0" y2="8" class="hatch-ln"/></pattern></defs>
        ${s.draw().join("")}</svg>`;
      $("mimicTitle").textContent = s.name;
      $("mimicNote").textContent = s.note;
      $("mimicLegend").innerHTML = legend();
      box.querySelectorAll("[data-eq]").forEach((g) => {
        g.onclick = () => eqPop(g.dataset.eq, g);
        g.onkeydown = (ev) => { if (ev.key === "Enter") eqPop(g.dataset.eq, g); };
      });
      box.querySelectorAll("[data-tag]").forEach((g) => (g.onclick = () => MD.openTag(g.dataset.tag)));
      box.querySelectorAll("[data-goto]").forEach((g) => {
        g.onclick = () => { setSheet(g.dataset.goto); renderMimic(); };
        g.onkeydown = (ev) => { if (ev.key === "Enter") g.onclick(); };
      });
    }
    patchMimic(box);
  }
  function patchMimic(box) {
    box.querySelectorAll("[data-eq]").forEach((g) => {
      const e = eq(g.dataset.eq);
      g.setAttribute("class", g.getAttribute("class").replace(/\s(run|stop|trip|warn|unk)\b/g, "") + " " + eqCls(e));
      const t = g.querySelector("title") || g.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "title"));
      t.textContent = e ? `${e.name} (${PID[e.id] || e.tag_no}) - ${STATE_TXT[e.status] || e.status} · ${modeTxt(e)}` : "No data";
    });
    box.querySelectorAll("[data-flow]").forEach((p) => {
      const ids = p.dataset.flow ? p.dataset.flow.split(",") : [];
      p.classList.toggle("on", ids.some(running));
    });
    box.querySelectorAll("[data-val]").forEach((el) => {
      const t = tag(el.dataset.val);
      el.textContent = t ? `${fmt(t)} ${t.unit || ""}` : "--";
    });
    box.querySelectorAll("[data-vals]").forEach((el) => {
      el.textContent = el.dataset.vals.split(",").map((id) => { const t = tag(id); return t ? `${fmt(t)} ${t.unit || ""}`.trim() : "--"; }).join(" · ");
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
    box.querySelectorAll("[data-lvln]").forEach((g) => {        // dashed set-point lines inside the tank
      const [id, k] = g.dataset.lvln.split(":"), t = tag(id), lv = levelsOf(t), p = lv ? pct(t, lv[k]) : null;
      g.style.display = p == null ? "none" : "";
      if (p == null) return;
      const y = +g.dataset.y0 + +g.dataset.h * (1 - p / 100);
      const ln = g.querySelector("line"), tx = g.querySelector("text");
      ln.setAttribute("y1", y); ln.setAttribute("y2", y); tx.setAttribute("y", y - 3);
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
  function eqPop(id, g) {
    const e = eq(id);
    const pop = $("mimicPop");
    if (!e || !pop) return;
    pop.innerHTML = `<div class="mp-h"><b>${esc(e.name)}</b><button class="btn sm" id="mpX" aria-label="Close">✕</button></div>
      <dl class="kv"><dt>P&amp;ID tag</dt><dd>${esc(PID[e.id] || e.tag_no || "-")}</dd>
      <dt>State</dt><dd><span class="kp-eq ${eqCls(e)}"><i></i>${esc(STATE_TXT[e.status] || e.status)}</span></dd>
      <dt>Mode (HMI)</dt><dd>${esc(modeTxt(e))}</dd>
      ${e.type === "motor" ? `<dt>Run hours</dt><dd class="num">${e.run_hours ?? "-"} h</dd>` : ""}
      ${e.kw ? `<dt>Rating</dt><dd>${esc(String(e.kw))} kW</dd>` : ""}</dl>`;
    const r = g.getBoundingClientRect(), host = $("mimicSvg").getBoundingClientRect();
    pop.style.left = `${Math.min(host.width - 260, Math.max(0, r.left - host.left + r.width / 2 - 130))}px`;
    pop.style.top = `${r.bottom - host.top + 8}px`;
    pop.classList.remove("hidden");
    $("mpX").onclick = () => pop.classList.add("hidden");
  }

  // ======================================================================================
  // INSTRUMENTS - every transmitter with its range, PLC scaling and live 4-20 mA signal
  // ======================================================================================
  const INST_GROUPS = ["Level", "Pressure", "Temperature", "Analysis"];
  let editing = null;                                    // instrument id whose scaling form is open (updates pause)
  function renderInstruments() {
    const box = $("instGrid");
    if (!box || editing) return;
    const list = live.tags.filter((t) => INST_GROUPS.includes(t.group))
      .sort((a, b) => INST_GROUPS.indexOf(a.group) - INST_GROUPS.indexOf(b.group));
    box.innerHTML = list.map((t) => {
      const p = pct(t), d = t.decimals ?? 1;
      const rmin = auxNum(`${t.id}_RMIN`), rmax = auxNum(`${t.id}_RMAX`);
      const dash = t.scaling_mode === "signal";          // value calculated on the dashboard from this range
      const lo = dash ? t.eng_min : rmin ?? t.eng_min, hi = dash ? t.eng_max : rmax ?? t.eng_max;
      const sp = t.setpoint_value, spp = pct(t, sp);
      const f = (x, dd = d) => (x == null ? "--" : Number(x).toFixed(dd));
      const zone = p == null ? "" : p < 10 ? "Very low" : p < 30 ? "Low" : p > 90 ? "Very high" : p > 75 ? "High" : "Normal";
      const overSp = sp != null && num(t) != null && num(t) >= sp;
      return `<div class="inst ${overSp ? "bad" : ""}" data-open="${esc(t.id)}" tabindex="0" role="button">
        <div class="in-h"><span class="in-g">${esc(t.group)}</span><span class="in-p">${esc(TAG_PID[t.id] || "")}</span></div>
        <div class="in-n">${esc(t.name.replace(/^[A-Z]+-\d+\s/, ""))}</div>
        <div class="in-v"><b class="num">${esc(fmt(t))}</b> <small>${esc(t.unit || "")}</small><span class="in-pc">${p == null ? "" : `${Math.round(p)} % · ${zone}`}</span></div>
        <div class="in-bar"><span class="ib-f" style="width:${p ?? 0}%"></span>${spp != null ? `<span class="ib-sp" style="left:${spp}%" title="Alarm at ${f(sp)}"></span>` : ""}</div>
        <div class="in-ends"><span>${f(t.eng_min, 0)}</span><span>${f(t.eng_max, 0)} ${esc(t.unit || "")}</span></div>
        <div class="in-sc">
          <div class="sc-row"><span>Measuring range</span><b class="num">${f(lo, 0)} to ${f(hi, 0)} ${esc(t.unit || "")}</b>${dash ? '<em class="dash">set on dashboard</em>' : '<em class="plc">from PLC</em>'}</div>
          ${sp != null ? `<div class="sc-row"><span>Alarm at</span><b class="num">${f(sp)} ${esc(t.unit || "")}</b>${overSp ? '<em class="hi">reached</em>' : ""}</div>` : ""}
          <button class="btn sm sc-edit" data-edit="${esc(t.id)}" type="button">✎ Edit range</button>
        </div></div>`;
    }).join("") || '<div class="empty">No instruments</div>';
    box.querySelectorAll("[data-open]").forEach((el) => {
      el.onclick = (ev) => { if (!ev.target.closest(".sc-edit")) MD.openTag(el.dataset.open); };
      el.onkeydown = (ev) => { if (ev.key === "Enter" && ev.target === el) MD.openTag(el.dataset.open); };
    });
    box.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = (ev) => { ev.stopPropagation(); openScaling(b.dataset.edit, b.closest(".inst")); }));
    $("instNote").textContent = `Each card is one measuring instrument. The bar shows how far the value is between the lowest and highest it can measure; the red mark is where the alarm comes. "Edit range" changes only this dashboard - the PLC and HMI are not changed. Updated ${fmtTime(live.status.last_update)}.`;
  }
  // scaling editor (dashboard-side only; saved to the dashboard's tag config, nothing is written to the PLC)
  function openScaling(id, card) {
    const t = tag(id);
    if (!t || !card) return;
    editing = id;
    const hasSig = auxNum(`${id}_MA`) != null || (live.aux || {})[`${id}_MA`];
    const sc = card.querySelector(".in-sc");
    sc.innerHTML = `<form class="sc-form" novalidate>
      <label>Value comes from<select name="source">
        <option value="plc" ${t.scaling_mode !== "signal" ? "selected" : ""}>PLC (same as HMI)</option>
        ${hasSig ? `<option value="signal" ${t.scaling_mode === "signal" ? "selected" : ""}>Calculate on dashboard using this range</option>` : ""}</select></label>
      <div class="sc-2"><label>Lowest value<input name="range_min" type="number" step="any" value="${t.eng_min ?? 0}" required></label>
        <label>Highest value<input name="range_max" type="number" step="any" value="${t.eng_max ?? 100}" required></label></div>
      <label>Decimal places<input name="decimals" type="number" min="0" max="4" step="1" value="${t.decimals ?? 1}"></label>
      <p class="sc-hint">Lowest / highest = what the instrument can measure (for example 0 to 3600 mm). Only this dashboard changes.</p>
      <div class="sc-btns"><button class="btn sm primary" type="submit">Save</button><button class="btn sm" type="button" data-cancel>Cancel</button></div>
      <div class="sc-err" hidden></div></form>`;
    const form = sc.querySelector("form");
    form.onclick = (ev) => ev.stopPropagation();
    form.querySelector("[data-cancel]").onclick = () => { editing = null; renderInstruments(); };
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const fd = new FormData(form), err = form.querySelector(".sc-err");
      const body = { id, source: fd.get("source"), range_min: +fd.get("range_min"), range_max: +fd.get("range_max"), decimals: +fd.get("decimals") };
      if (!(body.range_max > body.range_min)) { err.hidden = false; err.textContent = "Highest value must be greater than lowest value"; return; }
      try {
        await MD.api("/api/client/scaling", { method: "POST", body });
        MD.toast(`Range saved for ${t.name}`);
        editing = null;
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
        <tbody>${rows.map((r) => { const d = new Date(r.t * 1000); return `<tr><td>${d.toLocaleDateString()}</td><td>${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
          ${r.values.map((v, i) => `<td class="num">${v == null ? "-" : Number(v).toFixed(cols[i].decimals)}</td>`).join("")}</tr>`; }).join("")}</tbody>`;
      $("dlNote").textContent = `${rows.length} rows · average per interval · newest first${live && live.status.state === "demo" ? " · DEMO DATA" : ""}`;
    } catch (e) { $("dlNote").textContent = e.message; }
  }

  // ======================================================================================
  // TANK LEVELS - actual level against the HH / H / L / LL set points set on the HMI (LT Set Point screen)
  // ======================================================================================
  const LV_TANKS = [
    { id: "LT_01", name: "Sludge storage tank", pid: "01-LT-101", fluid: "sludge",
      plc: [["Pump start", "SP_SLUDGE_PUMP_START"], ["Pump stop", "SP_SLUDGE_PUMP_STOP"], ["Valve open", "SP_SLUDGE_VALVE_OPEN"], ["Valve close", "SP_SLUDGE_VALVE_CLOSE"]] },
    { id: "LT_02", name: "Filtrate tank", pid: "01-LT-102", fluid: "water", plc: [] },
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
  // vertical storage tank: domed roof, dished bottom, legs, inlet / outlet nozzles; liquid drawn inside the shell
  function tankSVG(c) {
    const id = c.id, B = GY0 + GH;
    const shell = `M80 ${GY0} A50 13 0 0 1 180 ${GY0} V${B} A50 13 0 0 1 80 ${B} Z`;
    const inner = `M83 ${GY0} A47 11 0 0 1 177 ${GY0} V${B} A47 11 0 0 1 83 ${B} Z`;
    return `<defs>
        <linearGradient id="shell_${id}" x1="0" x2="1"><stop offset="0" stop-color="#b9bdb3"/><stop offset=".3" stop-color="#f8f9f5"/><stop offset=".62" stop-color="#e2e4dc"/><stop offset="1" stop-color="#9ea296"/></linearGradient>
        <linearGradient id="shade_${id}" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".22"/><stop offset=".3" stop-color="#fff" stop-opacity=".28"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".25"/></linearGradient>
        <clipPath id="clip_${id}"><path d="${inner}"/></clipPath></defs>
      <rect class="lvg-leg" x="90" y="${B + 6}" width="6" height="${312 - B - 8}"/><rect class="lvg-leg" x="164" y="${B + 6}" width="6" height="${312 - B - 8}"/>
      <rect class="lvg-noz" x="121" y="4" width="18" height="10"/><rect class="lvg-fl" x="117" y="1" width="26" height="4" rx="1"/>
      <rect class="lvg-noz" x="180" y="${B - 16}" width="12" height="10"/><rect class="lvg-fl" x="191" y="${B - 19}" width="4" height="16" rx="1"/>
      <path class="lvg-shell" d="${shell}" fill="url(#shell_${id})"/>
      <g clip-path="url(#clip_${id})">
        <rect class="lvg-fill ${c.fluid}" data-fill x="80" y="${B}" width="100" height="0"/>
        <ellipse class="lvg-surf ${c.fluid}" data-surf cx="130" cy="${B}" rx="47" ry="5" style="display:none"/>
        <path d="${inner}" fill="url(#shade_${id})" pointer-events="none"/>
      </g>
      <path class="lvg-seam" d="M80 ${GY0 + GH / 3} H180 M80 ${GY0 + (GH * 2) / 3} H180"/>
      <path class="lvg-tank" d="${shell}"/>`;
  }
  function lvStatus(t) {
    const v = num(t), lv = levelsOf(t);
    if (v == null || !lv) return ["nd", "No data"];
    if (v >= lv.hh) return ["hh", "HIGH-HIGH - above the HH set point"];
    if (v >= lv.h) return ["h", "HIGH - above the H set point"];
    if (v <= lv.ll) return ["ll", "LOW-LOW - below the LL set point"];
    if (v <= lv.l) return ["l", "LOW - below the L set point"];
    return ["ok", "NORMAL - between L and H"];
  }
  function lvCardHTML(c) {
    const t = tag(c.id);
    if (!t) return "";
    const marks = LV_KEYS.map(([k, l]) => `<g class="lvg-ln ${k}" data-k="${k}"><line x1="78" x2="182" y1="0" y2="0"/><text x="188" y="4">${l}</text><text class="v num" x="210" y="4">--</text></g>`).join("");
    const plcMarks = c.plc.map(([l, id], i) => `<g class="lvg-plc" data-sp="${id}"><path d="M72 0 l-7 -5 v10 Z"/><text x="62" y="4" text-anchor="end">${esc(l)}</text></g>`).join("");
    return `<div class="card lvc" data-lt="${c.id}">
      <div class="card-head"><h2>${esc(c.name)} <span class="muted small">${esc(c.pid)} · level transmitter</span></h2><span class="lv-src" data-src></span></div>
      <div class="lvc-body">
        <svg class="lvg" viewBox="0 0 270 312" role="img" aria-label="${esc(c.name)} level gauge">
          ${tankSVG(c)}
          ${marks}${plcMarks}
          <text class="lvg-pct num" x="130" y="${GY0 + GH / 2}" text-anchor="middle" data-pct>--</text>
          <text class="lvg-end" x="76" y="${GY0 + GH + 4}" text-anchor="end">${esc(String(t.eng_min ?? 0))}</text>
          <text class="lvg-end" x="76" y="${GY0 + 6}" text-anchor="end">${esc(String(t.eng_max ?? ""))}</text>
        </svg>
        <div class="lvc-info">
          <div class="lvc-val"><b class="num" data-v>--</b> <small>${esc(t.unit || "")}</small></div>
          <div class="lvc-st" data-st>--</div>
          <table class="lvc-t"><thead><tr><th>Level</th><th>Set point</th><th>Set delay</th><th>Actual delay</th><th></th></tr></thead>
            <tbody>${LV_KEYS.map(([k, l]) => { const up = k.toUpperCase(); return `<tr data-row="${k}"><td><b>${l}</b></td>
              <td class="num lv-cell" data-w="${c.id}_${up}_SP" data-lbl="${l} set point"><span data-sp>--</span><button class="lv-ed" type="button" title="Change ${l} set point">✎</button></td>
              <td class="num lv-cell" data-w="${c.id}_${up}_DLY" data-lbl="${l} set delay"><span data-dly>--</span><button class="lv-ed" type="button" title="Change ${l} set delay">✎</button></td>
              <td class="num" data-act>--</td><td><i class="lvc-lamp"></i></td></tr>`; }).join("")}</tbody></table>
          <div class="lv-note muted small">✎ writes the new value into the PLC (same as changing it on the HMI). The dashboard then reads it back from the PLC.</div>
          ${c.plc.length ? `<div class="lvc-plc"><b>Pump &amp; valve control levels (HMI selector screen)</b>
            ${c.plc.map(([l, id]) => `<span>${esc(l)} <b class="num" data-plc="${id}">--</b></span>`).join("")}</div>` : ""}
        </div>
      </div>
      <div class="lvc-trend"><div class="lvc-th">Level - last 8 hours <span class="muted small">dashed lines = set points</span></div><div class="chart" data-chart></div></div>
    </div>`;
  }
  let lvTrendAt = 0;
  function renderLevels() {
    const box = $("lvCards"), swBox = $("lvSwitches");
    if (!box) return;
    if (!box.dataset.built) { box.innerHTML = LV_TANKS.map(lvCardHTML).join(""); box.dataset.built = "1"; lvTrendAt = 0;
      box.querySelectorAll(".lvc").forEach((el) => el.querySelector(".lvc-val").onclick = () => MD.openTag(el.dataset.lt));
      box.onclick = (ev) => { const b = ev.target.closest(".lv-ed"); if (b) lvEdit(b.closest(".lv-cell")); }; }
    box.querySelectorAll(".lvc").forEach((el) => {
      const t = tag(el.dataset.lt);
      if (!t) return;
      const lv = levelsOf(t), p = pct(t), [stc, stt] = lvStatus(t), d = t.decimals ?? 1;
      const yOf = (val) => GY0 + GH * (1 - (pct(t, val) ?? 0) / 100);
      const fh = GH * (p ?? 0) / 100, fill = el.querySelector("[data-fill]");
      // liquid fills the dished bottom too (+14); the surface ellipse sits on top of the liquid
      fill.setAttribute("y", GY0 + GH - fh); fill.setAttribute("height", p ? fh + 14 : 0);
      const surf = el.querySelector("[data-surf]");
      surf.setAttribute("cy", GY0 + GH - fh); surf.style.display = p ? "" : "none";
      el.querySelector("[data-pct]").textContent = p == null ? "--" : `${Math.round(p)} %`;
      el.querySelector("[data-v]").textContent = fmt(t);
      const st = el.querySelector("[data-st]"); st.textContent = stt; st.className = `lvc-st ${stc}`;
      el.querySelector("[data-src]").textContent = plcLevels(t) ? "Set points from HMI / PLC" : "Set points: default (HMI values not read)";
      LV_KEYS.forEach(([k, l]) => {
        const g = el.querySelector(`.lvg-ln[data-k="${k}"]`), y = yOf(lv[k]);
        g.setAttribute("transform", `translate(0 ${y.toFixed(1)})`);
        g.querySelector(".v").textContent = Number(lv[k]).toFixed(0);
        g.classList.toggle("on", !!lvActive(t, k));
        const row = el.querySelector(`tr[data-row="${k}"]`), up = k.toUpperCase();
        const spEl = row.querySelector("[data-sp]"), dlyEl = row.querySelector("[data-dly]");
        if (spEl) spEl.textContent = `${Number(lv[k]).toFixed(d)} ${t.unit || ""}`;   // (absent while that cell is being edited)
        if (dlyEl) dlyEl.textContent = auxTxt(`${t.id}_${up}_DLY`);
        row.querySelector("[data-act]").textContent = auxTxt(`${t.id}_${up}_ACT`);
        row.className = lvActive(t, k) ? `on ${k}` : "";
      });
      el.querySelectorAll(".lvg-plc").forEach((g) => {
        const v = auxNum(g.dataset.sp);
        g.style.display = v == null ? "none" : "";
        if (v != null) g.setAttribute("transform", `translate(0 ${yOf(v).toFixed(1)})`);
      });
      el.querySelectorAll("[data-plc]").forEach((b) => (b.textContent = auxTxt(b.dataset.plc)));
    });
    if (Date.now() - lvTrendAt > 60000) { lvTrendAt = Date.now(); loadLevelTrends(box); }
    if (swBox) swBox.innerHTML = SW_TANKS.map((tk) => {
      const st = tk.sw.map(([k, l]) => [l, sw(SW[k])]);
      const top = st.find(([, v]) => v);
      const nd = st.every(([, v]) => v == null);
      const txt = nd ? "No data" : top ? `Water at ${top[0]} switch or above` : `Below the ${st[st.length - 1][0]} switch`;
      return `<div class="lsw"><div class="lsw-h"><b>${esc(tk.name)}</b><span class="muted small">${esc(tk.pid)}</span></div>
        <div class="lsw-lamps">${st.map(([l, v]) => `<span class="lsw-l ${v == null ? "nd" : v ? "on" : ""}">${l}</span>`).join("")}</div>
        <div class="lsw-t ${top ? "" : "low"}">${esc(txt)}</div></div>`;
    }).join("");
  }
  // write one set point / set delay to the PLC: inline input -> confirm -> POST -> show the value read back
  function lvEdit(cell) {
    if (!cell || cell.classList.contains("editing")) return;
    const id = cell.dataset.w, a = (live.aux || {})[id] || {}, unit = a.unit || "";
    const cur = typeof a.value === "number" ? a.value : "";
    const saved = cell.innerHTML;
    cell.classList.add("editing");
    cell.innerHTML = `<form class="lv-form"><input type="number" step="any" value="${cur === "" ? "" : Number(cur).toFixed(a.decimals ?? 1)}" aria-label="${esc(cell.dataset.lbl)}">
      <span class="u">${esc(unit)}</span><button class="btn sm primary" type="submit">Write</button><button class="btn sm" type="button" data-x>✕</button></form>`;
    const form = cell.querySelector("form"), inp = form.querySelector("input");
    const close = () => { cell.classList.remove("editing"); cell.innerHTML = saved; };
    form.querySelector("[data-x]").onclick = close;
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const v = Number(inp.value);
      if (inp.value === "" || !isFinite(v)) { MD.toast("Enter a number", true); return; }
      const demo = live.status.state === "demo";
      if (!confirm(`Write ${cell.dataset.lbl} = ${v} ${unit} ${demo ? "(demo data - nothing is sent to the PLC)" : "to the PLC"}?\n\nThis changes the plant's level control, the same as changing it on the HMI.`)) return;
      form.querySelectorAll("button,input").forEach((x) => (x.disabled = true));
      try {
        const r = await MD.api("/api/client/write", { method: "POST", body: { id, value: v } });
        MD.toast(`${cell.dataset.lbl}: ${Number(r.value).toFixed(a.decimals ?? 1)} ${unit} ${r.simulated ? "(demo)" : "written - read back from PLC"}`);
        if (live.aux && live.aux[id]) live.aux[id].value = r.value;
        lvTrendAt = 0;
        close();
      } catch (e) { MD.toast(e.message, true); form.querySelectorAll("button,input").forEach((x) => (x.disabled = false)); }
    };
    inp.focus(); inp.select();
  }
  async function loadLevelTrends(box) {
    for (const el of box.querySelectorAll(".lvc")) {
      const t = tag(el.dataset.lt);
      if (!t) continue;
      try {
        const r = await MD.api(`/api/trend?tags=${encodeURIComponent(t.id)}&minutes=480&points=240`);
        const s = r.series[0], lv = levelsOf(t);
        if (s) MDChart.render(el.querySelector("[data-chart]"), { name: s.name, unit: s.unit, decimals: s.decimals, color: "var(--s3)", points: s.points,
          from: r.from, to: r.to, limits: LV_KEYS.map(([k, l]) => ({ v: lv[k], label: `${l} ${Number(lv[k]).toFixed(0)}` })), yMin: t.eng_min, yMax: t.eng_max });
      } catch (_) { /* trend is optional */ }
    }
  }

  // ======================================================================================
  // HELP - plain-language guide to every page (opens in the side drawer)
  // ======================================================================================
  const HELP = [
    ["Colours", `<ul class="hp-c"><li><i class="run"></i><b>Green</b> - running / open / OK</li><li><i class="stop"></i><b>Grey</b> - stopped / closed</li>
      <li><i class="trip"></i><b>Red (blinking)</b> - tripped or alarm: needs attention</li><li><i class="warn"></i><b>Orange</b> - warning, value outside its normal band</li>
      <li><i class="lamp"></i><b>Yellow lamp</b> - float switch ON (water has reached that level)</li></ul>
      <p><b>DEMO DATA</b> at the top means the values are simulated, not from the plant.</p>`],
    ["Overview", `<p>The first page. The top row shows each plant area and how many of its machines are running - click one to see its drawing.</p>
      <p>The six big cards are the most important values: tank levels, water pressure, pH, de-gasifier temperature and hot water to the dryer. Each card says in words whether the value is OK.</p>`],
    ["Mimic", `<p>Drawings of the plant. <b>Overall plant</b> shows all areas joined together; the other tabs show each area in detail.
      Pumps turn green when running, pipes show moving dashes when liquid is flowing (the arrow is the direction), tanks fill up with the real level. Click a pump or value for details.</p>`],
    ["Instruments", `<p>One card per measuring instrument (level, pressure, temperature, pH). The bar shows where the value is between the lowest and highest it can measure; the red mark is where the alarm comes.
      <b>Edit range</b> changes the lowest / highest value used on this dashboard only - the PLC and HMI are not changed.</p>`],
    ["Equipment", `<p>Every pump, fan and valve with its state, run hours and mode. <b>Auto</b> = the PLC starts and stops it by itself; <b>Manual</b> = an operator controls it.
      For main / standby pump pairs it shows which pump is selected. The selector and set-value cards show the same settings as the HMI. <b>Field signals</b> lists every input and output ON / OFF.</p>`],
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

  window.Plant = {
    render(l, view) {
      live = l;
      if (view === "overview") renderKeyPoints();
      if (view === "levels") renderLevels();
      if (view === "mimic") renderMimic();
      if (view === "instruments") renderInstruments();
      if (view === "datalog") renderDatalog(false);
    },
    show(view) {
      if (view === "mimic") { const b = $("mimicSvg"); if (b) b._sheet = null; const t = $("mimicTabs"); if (t) t._sheet = null; }
      if (view === "datalog") { renderDatalog(true); return; }
      if (view === "levels") lvTrendAt = 0;
      if (view !== "instruments") editing = null;
      if (live) this.render(live, view);
    },
  };
})();
