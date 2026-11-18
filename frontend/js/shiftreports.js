/* Reports page (v3 brief 14-11-2026, SC07): plant report and data log for a start..end date range (IST), from the
   stored history only.
   - Period: Daily / Weekly / Monthly / Custom fill the Start and End dates (Daily = one day, Weekly = Monday-Sunday,
     Monthly = 1st-last day, of the day in "End date"); the dates can always be changed, and the type follows the dates.
     Dates are limited to the history actually kept (MD_META.history: retention_days + oldest stored sample).
   - Plant report: laid out like a printed plant report: header with logos, summary KPIs, process values against their
     alarm set points (with a small trend), log sheet, equipment run hours / starts / trips, alarm summary + log, sign-off.
     Excel = /api/report/period.xlsx, CSV = /api/report/period.csv, PDF = the browser's print (A4 landscape).
   - Data log (was its own page): averaged readings every 1 min / 5 min / 15 min / 1 h, grouped Temperature / Pressure /
     Level & pH, from /api/report. Excel / CSV / PDF of the shown group = /api/report.xlsx|csv|pdf.
   No production / consumption KPIs - there is no source data or definition for them. */
(() => {
  const $ = (id) => document.getElementById(id);
  const { esc, api, fmtTime } = MD;
  const DAY = 86400;
  let kind = "daily", view = "report", last = null, lastQ = "", dl = null, dlQ = null, dlGroup = 0, dlTags = null;
  const GROUP = { Level: "Tank levels", Temperature: "Temperatures", Pressure: "Pressures", Analysis: "Water quality (pH)" };
  const KIND_STEP = { 3600: "Hourly", 21600: "6-hourly", 86400: "Daily" };
  const DL_GROUPS = [["Temperature", ["Temperature"]], ["Pressure", ["Pressure"]], ["Level & pH", ["Level", "Analysis"]]];
  const INTERVAL = { 60: "1 min", 300: "5 min", 900: "15 min", 3600: "1 hour" };

  // ---------- dates (ISO YYYY-MM-DD, IST days) ----------
  const pad = (n) => String(n).padStart(2, "0");
  const isoOf = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
  const partsOf = (iso) => iso.split("-").map(Number);
  const addDays = (iso, n) => { const [y, m, d] = partsOf(iso); return isoOf(y, m, d + n); };
  const weekday = (iso) => { const [y, m, d] = partsOf(iso); return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; };   // Mon = 0
  const monthEnd = (iso) => { const [y, m] = partsOf(iso); return isoOf(y, m + 1, 0); };
  const today = () => MD.istDate(Date.now() / 1000);
  const minIso = () => MD.istDate(MD.v3.historyStart());
  const clampIso = (iso) => (iso < minIso() ? minIso() : iso > today() ? today() : iso);
  const dayText = (ts) => { const p = MD.istParts(ts); return `${pad(p.d)} ${MD.MON[p.mo - 1]} ${p.y}`; };

  function setDates(f, t) { $("rpFrom").value = clampIso(f); $("rpTo").value = clampIso(t); }
  function fillKind(k) {                  // preset -> dates, anchored on the end date (default today)
    const a = clampIso($("rpTo").value || today());
    if (k === "daily") setDates(a, a);
    else if (k === "weekly") { const mon = addDays(a, -weekday(a)); setDates(mon, addDays(mon, 6)); }
    else if (k === "monthly") { const first = a.slice(0, 8) + "01"; setDates(first, monthEnd(a)); }
  }
  function detectKind() {                 // dates -> which type they are (end date may stop at today)
    const f = $("rpFrom").value, t = $("rpTo").value, now = today();
    if (f && f === t) return "daily";
    if (f && weekday(f) === 0 && (t === addDays(f, 6) || (t === now && t < addDays(f, 7)))) return "weekly";
    if (f && f.endsWith("-01") && t.slice(0, 7) === f.slice(0, 7) && (t === monthEnd(f) || t === now)) return "monthly";
    return "custom";
  }
  function showKind(k) {
    kind = k;
    $("rpKind").querySelectorAll("button").forEach((b) => { b.classList.toggle("active", b.dataset.k === k); b.setAttribute("aria-pressed", b.dataset.k === k); });
  }

  function init() {
    $("rpCal").outerHTML = MD.v3.CAL;
    const lo = minIso(), hi = today();
    ["rpFrom", "rpTo"].forEach((id) => { $(id).min = lo; $(id).max = hi; });
    setDates(hi, hi);
    showKind("daily");
    const h = (window.MD_META || {}).history || {};
    $("rpHist").innerHTML = `${MD.v3.CAL}<span>History available <b>${dayText(MD.v3.historyStart())} – ${dayText(Date.now() / 1000)}</b>
      · kept for ${esc(h.retention_days || 30)} days${h.log_interval_s ? ` · recorded every ${esc(h.log_interval_s)} s` : ""}</span>`;

    // start / end days: calendar pop-up (client review 17-11-2026) - the date box and "Custom" open it
    const openCal = () => MD.v3.calendar({
      anchor: $("rpDates"), from: $("rpFrom").value, to: $("rpTo").value, min: minIso(), max: today(), title: "Report period",
      onApply: (f, t) => { setDates(f, t); showKind(detectKind()); },
    });
    const dates = $("rpDates");
    dates.setAttribute("role", "button"); dates.tabIndex = 0; dates.title = "Pick start and end dates";
    dates.setAttribute("aria-label", "Report period: pick start and end dates");
    ["rpFrom", "rpTo"].forEach((id) => { $(id).tabIndex = -1; $(id).readOnly = true; });
    dates.onclick = openCal;
    dates.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openCal(); } };
    $("rpKind").querySelectorAll("button").forEach((b) => (b.onclick = () => {
      if (b.dataset.k === "custom") { openCal(); return; }
      fillKind(b.dataset.k);
      showKind(b.dataset.k);
    }));
    $("rpFrom").onchange = () => {
      if (!$("rpFrom").value) return;
      $("rpFrom").value = clampIso($("rpFrom").value);
      if ($("rpTo").value < $("rpFrom").value) $("rpTo").value = $("rpFrom").value;
      showKind(detectKind());
    };
    $("rpTo").onchange = () => {
      if (!$("rpTo").value) return;
      $("rpTo").value = clampIso($("rpTo").value);
      if ($("rpFrom").value > $("rpTo").value) $("rpFrom").value = $("rpTo").value;
      showKind(detectKind());
    };
    $("rpView").querySelectorAll("button").forEach((b) => (b.onclick = () => setView(b.dataset.v)));
    $("rpRun").onclick = () => (view === "report" ? runReport() : runLog());

    $("rpXlsx").onclick = () => (view === "report" ? last && download(`/api/report/period.xlsx?${lastQ}`) : dl && download(`/api/report.xlsx?${dlQs()}`));
    $("rpCsv").onclick = () => (view === "report" ? last && download(`/api/report/period.csv?${lastQ}`) : dl && download(`/api/report.csv?${dlQs()}`));
    // PDF: plant report = print of the report sheet only (A4 landscape; class removed after printing);
    // data log = paginated PDF from the server
    $("rpPdf").onclick = () => {
      if (view === "report") { if (!last) return; document.body.classList.add("print-rp"); window.print(); }
      else if (dl) download(`/api/report.pdf?${dlQs()}`);
    };
    window.addEventListener("afterprint", () => document.body.classList.remove("print-rp"));
    setView("report");
  }

  function setView(v) {
    view = v;
    $("rpView").querySelectorAll("button").forEach((b) => { b.classList.toggle("active", b.dataset.v === v); b.setAttribute("aria-pressed", b.dataset.v === v); });
    $("rpBody").classList.toggle("hidden", v !== "report");
    $("dlBody").classList.toggle("hidden", v !== "log");
    $("rpEveryL").classList.toggle("hidden", v !== "log");
    syncExports();
  }
  function syncExports() {
    const ok = view === "report" ? !!last : !!dl;
    $("rpXlsx").disabled = $("rpCsv").disabled = $("rpPdf").disabled = !ok;
  }
  function range() {
    const f = $("rpFrom").value, t = $("rpTo").value;
    if (!f || !t) { MD.toast("Pick both a start and an end date", true); return null; }
    if (t < f) { MD.toast("The end date must be on or after the start date", true); return null; }
    return [f, t];
  }

  // file download through fetch, so a refused request shows its message instead of leaving the page
  async function download(url) {
    try {
      const r = await fetch(url, { credentials: "same-origin" });
      if (!r.ok) {
        let msg = `Download failed (${r.status})`;
        try { msg = (await r.json()).error || msg; } catch (_) { /* not JSON */ }
        throw new Error(msg);
      }
      const name = (/filename="([^"]+)"/.exec(r.headers.get("Content-Disposition") || "") || [])[1] || "report";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(await r.blob());
      a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { MD.toast(e.message, true); }
  }

  const num = (v, d) => (v == null ? '<span class="muted">-</span>' : Number(v).toFixed(d));
  const ist = (ts, o) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", ...o }).format(new Date(ts * 1000));
  const hrs = (h) => (h == null ? "-" : h >= 100 ? h.toFixed(0) : h.toFixed(1));

  // small trend of the log-sheet averages, with the alarm set point as a dashed red line
  function spark(v) {
    const pts = v.log.map((y, i) => [i, y]).filter((p) => p[1] != null);
    if (pts.length < 2) return '<span class="muted small">-</span>';
    const ys = pts.map((p) => p[1]).concat(v.set_point != null ? [v.set_point] : []);
    let lo = Math.min(...ys), hi = Math.max(...ys);
    if (hi === lo) { hi += 1; lo -= 1; }
    const W = 110, H = 26, n = Math.max(1, v.log.length - 1);
    const X = (i) => (i / n) * W, Y = (y) => H - 2 - ((y - lo) / (hi - lo)) * (H - 4);
    const path = pts.map((p, k) => `${k ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
    const sp = v.set_point != null ? `<line x1="0" x2="${W}" y1="${Y(v.set_point).toFixed(1)}" y2="${Y(v.set_point).toFixed(1)}" class="sp"/>` : "";
    return `<svg class="rp-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${sp}<path d="${path}"/></svg>`;
  }

  function kpi(label, value, sub, cls = "") {
    return `<div class="rp-kpi ${cls}"><span>${esc(label)}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
  }

  function valueRows(list) {
    return list.map((v) => {
      const pct = v.pct ? `<span class="muted small"> (${v.pct.min}-${v.pct.max}%)</span>` : "";
      const sp = v.set_point == null ? '<span class="muted">-</span>' : `${num(v.set_point, v.decimals)}`;
      const ab = v.minutes_above_sp == null ? '<span class="muted">-</span>'
        : v.minutes_above_sp ? `<span class="rp-bad">${v.minutes_above_sp} min</span>` : '<span class="rp-ok">0</span>';
      return `<tr><td>${esc(v.name)}</td><td class="muted">${esc(v.unit)}</td>
        <td class="r num">${num(v.min, v.decimals)}</td><td class="r num">${num(v.max, v.decimals)}${pct}</td>
        <td class="r num"><b>${num(v.avg, v.decimals)}</b>${v.pct ? `<span class="muted small"> (${v.pct.avg}%)</span>` : ""}</td>
        <td class="r num">${sp}</td><td class="r">${ab}</td><td>${spark(v)}</td>
        <td class="r"><span class="cov ${v.coverage_pct >= 95 ? "ok" : v.coverage_pct > 0 ? "warn" : "bad"}">${v.coverage_pct}%</span></td></tr>`;
    }).join("");
  }

  // ======================================================================================
  // PLANT REPORT
  // ======================================================================================
  async function runReport() {
    const rg = range();
    if (!rg) return;
    const q = `kind=${kind}&from=${rg[0]}&to=${rg[1]}`;
    $("rpBody").innerHTML = '<p class="dv-empty">Building the report…</p>';
    last = null; syncExports();
    $("rpRun").disabled = true;
    try { last = await api(`/api/report/period?${q}`); lastQ = q; }
    catch (e) { $("rpBody").innerHTML = `<p class="dv-empty bad">${esc(e.message)}</p>`; return; }
    finally { $("rpRun").disabled = false; syncExports(); }
    const r = last, s = r.summary;
    const noData = r.values.every((v) => v.avg == null);
    const groups = Object.keys(GROUP).map((g) => [g, r.values.filter((v) => v.group === g)]).filter(([, l]) => l.length);
    const logFmt = r.log_step_s >= 86400 ? { day: "2-digit", month: "short" } : r.log_step_s >= 21600 || r.to - r.from > DAY
      ? { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
    const nowTs = Date.now() / 1000;
    const eqSorted = [...r.equipment].sort((a, b) => b.run_hours - a.run_hours);
    const maxRun = Math.max(0.01, ...eqSorted.map((e) => e.run_hours));

    $("rpBody").innerHTML = `<article class="rp-doc" id="rpDoc">
      <header class="rp-hd">
        <img src="img/ankur-logo.png" alt="Ankur Scientific">
        <div class="rp-hd-t"><h3>${esc(r.title)}</h3>
          <div>${esc(r.site.name || "FSTP-200")}${r.site.panel ? " · " + esc(r.site.panel) : ""}</div>
          <div class="muted rp-period">${MD.v3.CAL}<span>${fmtTime(r.from, true)} → ${fmtTime(r.to, true)} IST${r.complete ? "" : " · <b>period still running - figures up to now</b>"}</span></div></div>
        <img src="img/medge-logo.png" alt="Medge Controls">
      </header>
      ${r.simulated ? '<div class="rp-demo">DEMO DATA - simulated values, not measured plant data</div>' : ""}
      ${r.history_note ? `<p class="rp-note">${esc(r.history_note)}</p>` : ""}
      ${noData ? '<p class="dv-empty">No history was recorded in this period (the dashboard server was not running, or the data source was offline).</p>' : ""}

      <h4><span>1</span> Summary</h4>
      <div class="rp-kpis">
        ${kpi("System run time", `${hrs(s.system_run_hours)} h`, `of ${hrs(s.period_hours)} h period · hot air blower`)}
        ${kpi("Machine run hours", `${hrs(s.machine_run_hours)} h`, `${s.machines_run} of ${s.machines_total} machines ran · ${s.starts} starts`)}
        ${kpi("Trips", s.trips, s.trips ? "see equipment table" : "no trips", s.trips ? "bad" : "ok")}
        ${kpi("Alarms", s.alarms, `${s.critical} critical · ${s.still_active} still active`, s.critical ? "bad" : s.alarms ? "warn" : "ok")}
        ${kpi("Set point exceeded", s.values_above_sp, s.values_above_sp ? "values reached their alarm set point" : "all within set points", s.values_above_sp ? "warn" : "ok")}
        ${kpi("Data coverage", `${s.data_coverage_pct}%`, "minutes with valid readings", s.data_coverage_pct >= 95 ? "ok" : s.data_coverage_pct > 0 ? "warn" : "bad")}
      </div>

      <h4><span>2</span> Process values</h4>
      <table class="dv-t rp-t"><thead><tr><th>Value</th><th>Unit</th><th class="r">Min</th><th class="r">Max</th><th class="r">Average</th>
        <th class="r">Alarm set point*</th><th class="r">Time at / above set point</th><th>Trend</th><th class="r">Coverage</th></tr></thead>
      ${groups.map(([g, l]) => `<tbody><tr class="rp-grp"><td colspan="9">${esc(GROUP[g])}</td></tr>${valueRows(l)}</tbody>`).join("")}</table>
      <p class="muted small">* Current alarm set point (set points are not kept in the history). Tank levels also in % of range. Trend = ${(KIND_STEP[r.log_step_s] || "").toLowerCase()} averages, red dashed line = alarm set point. Coverage below 100 % means minutes without data - they are not in min / max / average.</p>

      <h4><span>3</span> ${esc(KIND_STEP[r.log_step_s] || "")} log sheet <small class="muted">(average per ${r.log_step_s >= 86400 ? "day" : r.log_step_s >= 21600 ? "6 hours" : "hour"} · readings at every interval are in the Data log view)</small></h4>
      <div class="rp-scroll"><table class="dv-t rp-t rp-log"><thead><tr><th>Time (IST)</th>${r.values.map((v) => `<th class="r" title="${esc(v.name)}">${esc(v.name.split(" ")[0])}<small>${esc(v.unit)}</small></th>`).join("")}</tr></thead><tbody>
      ${r.log_times.map((t, i) => [t, i]).filter(([t]) => t < nowTs).map(([t, i]) => `<tr><td class="num">${ist(t, logFmt)}</td>${r.values.map((v) => {
        const y = v.log[i], over = y != null && v.set_point != null && (v.group === "Temperature" || v.group === "Pressure") && y >= v.set_point;
        return `<td class="r num${over ? " rp-bad" : ""}">${num(y, v.decimals)}</td>`; }).join("")}</tr>`).join("")}</tbody></table></div>

      <h4><span>4</span> Equipment</h4>
      <table class="dv-t rp-t"><thead><tr><th>Tag</th><th>Equipment</th><th>Area</th><th class="r">kW</th><th class="r">Run hours</th><th>Utilisation</th><th class="r">Starts</th><th class="r">Trips</th></tr></thead><tbody>
      ${eqSorted.map((e) => `<tr${e.trips ? ' class="rp-row-bad"' : ""}><td class="mono">${esc(e.tag_no)}</td><td>${esc(e.name)}</td><td class="muted">${esc(e.area || "")}</td>
        <td class="r num">${e.kw ?? "-"}</td><td class="r num"><b>${e.run_hours.toFixed(2)}</b></td>
        <td><span class="rp-bar"><i style="width:${Math.min(100, (e.run_hours / maxRun) * 100).toFixed(0)}%"></i></span> <span class="small">${e.utilisation_pct}%</span></td>
        <td class="r num">${e.starts}</td><td class="r num">${e.trips ? `<span class="rp-bad">${e.trips}</span>` : "0"}</td></tr>`).join("")}</tbody></table>
      <p class="muted small">From the logged run-feedback signals; stretches without data are not counted as running. Utilisation = run time ÷ period. A machine already running at the start of the period is not counted as a start.</p>

      <h4><span>5</span> Alarm summary <small class="muted">(${r.alarm_counts.total} alarms · ${r.alarm_counts.plc} from the plant · ${r.alarm_counts.dashboard} dashboard-calculated)</small></h4>
      ${r.top_alarms.length ? `<table class="dv-t rp-t"><thead><tr><th>Most frequent alarms</th><th>Severity</th><th class="r">Count</th><th class="r">Total time active</th><th>Last raised (IST)</th></tr></thead><tbody>
        ${r.top_alarms.map((g) => `<tr><td>${esc(g.message)}</td><td>${g.priority === "red" ? '<span class="rp-bad">Critical</span>' : "Warning"}</td>
          <td class="r num"><b>${g.count}</b></td><td class="r num">${g.minutes >= 120 ? (g.minutes / 60).toFixed(1) + " h" : g.minutes + " min"}</td><td class="num">${fmtTime(g.last, true)}</td></tr>`).join("")}</tbody></table>`
        : '<p class="rp-ok">No alarms in this period.</p>'}

      ${r.alarms.length ? `<h4><span>6</span> Alarm log</h4>
      <table class="dv-t rp-t"><thead><tr><th>Raised (IST)</th><th>Severity</th><th>Source</th><th>Alarm</th><th class="r">Duration</th><th>Acknowledged</th><th>Cleared</th></tr></thead><tbody>
      ${r.alarms.map((a) => `<tr><td class="num">${fmtTime(a.raised_at, true)}</td><td>${a.priority === "red" ? '<span class="rp-bad">Critical</span>' : "Warning"}</td>
        <td>${a.source === "dashboard" ? '<span class="al-src-b dash">DASHBOARD</span>' : '<span class="al-src-b plc">PLANT</span>'}</td>
        <td>${esc(a.message)}${a.simulated ? ' <span class="q SIMULATED">DEMO</span>' : ""}</td>
        <td class="r num">${a.duration_min >= 120 ? (a.duration_min / 60).toFixed(1) + " h" : a.duration_min + " min"}</td>
        <td>${a.acked_at ? `${esc(a.acked_by || "")} ${fmtTime(a.acked_at)}` : '<span class="muted">-</span>'}</td>
        <td>${a.cleared_at ? fmtTime(a.cleared_at, true) : '<span class="al-pill act">ACTIVE</span>'}</td></tr>`).join("")}</tbody></table>` : ""}

      <h4 class="rp-keep"><span>${r.alarms.length ? 7 : 6}</span> Remarks &amp; sign-off</h4>
      <div class="rp-sign rp-keep">
        <div class="rp-remarks">Remarks:</div>
        <div><span>Prepared by (operator)</span></div><div><span>Checked by (shift in-charge)</span></div><div><span>Approved by (plant in-charge)</span></div>
      </div>
      <footer class="rp-ft">Generated ${fmtTime(r.generated, true)} IST from the dashboard history · Medge Controls plant monitoring · Production / consumption figures are not shown: no source data is configured for them.</footer>
    </article>`;
    // wide tables scroll inside the report on small screens instead of widening the page
    $("rpDoc").querySelectorAll("table.rp-t").forEach((t) => {
      if (t.parentElement.classList.contains("rp-scroll")) return;
      const w = document.createElement("div");
      w.className = "rp-scroll";
      t.before(w); w.append(t);
    });
    // v3 (SC03): search bar for the report tables (process values, log sheet, equipment, alarms)
    $("rpBody").insertAdjacentHTML("afterbegin", '<div class="rp-srch no-print" id="rpSrch"></div>');
    MD.v3.tableSearch($("rpSrch"), $("rpDoc"), { placeholder: "Search value, tag, equipment or alarm…", onSearch: (s) => {
      // keep a group heading row visible while any row of its group matches
      $("rpDoc").querySelectorAll("tr.rp-grp").forEach((g) => {
        g.hidden = !!s && ![...g.parentElement.querySelectorAll("tr:not(.rp-grp)")].some((r) => !r.hidden);
      });
    } });
  }

  // ======================================================================================
  // DATA LOG (was the separate Data log page): readings averaged per interval, grouped like before
  // ======================================================================================
  function dlQs() {                      // export query for the shown group (same window / interval as on screen)
    const ids = dlCols().map((c) => c.id);
    return `${dlQ}&tags=${encodeURIComponent(ids.join(","))}&title=${encodeURIComponent("Data log - " + DL_GROUPS[dlGroup][0])}`;
  }
  function dlCols() {
    const groupOf = Object.fromEntries((dlTags || []).map((t) => [t.id, t.group]));
    return dl ? dl.columns.map((c, i) => ({ ...c, i })).filter((c) => DL_GROUPS[dlGroup][1].includes(groupOf[c.id])) : [];
  }

  async function runLog() {
    const rg = range();
    if (!rg) return;
    const nowTs = Math.floor(Date.now() / 1000);
    const from = MD.istDayStart(rg[0]), to = Math.min(nowTs, MD.istDayStart(rg[1]) + DAY);
    const q = `from=${from}&to=${to}&interval=${$("rpEvery").value}`;
    $("dlBody").innerHTML = '<p class="dv-empty">Loading the readings…</p>';
    dl = null; syncExports();
    $("rpRun").disabled = true;
    try {
      if (!dlTags) dlTags = (await api("/api/report/tags")).tags;
      dl = await api(`/api/report?${q}`);                 // all reportable values; the group only filters columns
      dlQ = q;
    } catch (e) { $("dlBody").innerHTML = `<p class="dv-empty bad">${esc(e.message)}</p>`; return; }
    finally { $("rpRun").disabled = false; syncExports(); }
    renderLog();
  }

  function renderLog() {
    if (!dl) return;
    const cols = dlCols();
    const rows = dl.rows.slice().reverse();               // newest first, like the former Data log page
    const hasData = (r) => cols.some((c) => r.values[c.i] != null);
    const shown = rows.filter(hasData);
    $("dlBody").innerHTML = `
      <div class="dl-top">
        <div class="seg sm" id="dlGroup" role="group" aria-label="Values">${DL_GROUPS.map(([l], i) =>
          `<button type="button" data-i="${i}" class="${i === dlGroup ? "active" : ""}" aria-pressed="${i === dlGroup}">${esc(l)}</button>`).join("")}</div>
        <span class="dl-note">${MD.v3.CAL}<span>${fmtTime(dl.from, true).slice(0, 16)} – ${fmtTime(dl.to, true).slice(0, 16)} IST
          · ${shown.length} rows · average per ${esc(INTERVAL[dl.interval_s] || dl.interval)} · newest first</span></span>
        <span class="dl-srch no-print" id="dlSrch"></span>
      </div>
      ${dl.simulated ? '<div class="rp-demo">DEMO DATA - simulated values, not measured plant data</div>' : ""}
      ${dl.history_note ? `<p class="rp-note">${esc(dl.history_note)}</p>` : ""}
      ${shown.length ? `<div class="rp-scroll dl-scroll"><table class="dv-t rp-t rp-dl"><thead><tr><th>Date</th><th>Time (IST)</th>${cols.map((c) =>
        `<th title="${esc(c.name)}">${esc(c.name.replace(/^[A-Z]+-\d+\s/, ""))}<small>${esc(c.unit)}</small></th>`).join("")}</tr></thead>
        <tbody>${shown.map((r) => `<tr><td class="num">${MD.istDate(r.t).split("-").reverse().join("-")}</td><td class="num">${fmtTime(r.t).slice(0, 5)}</td>${cols.map((c) => {
          const v = r.values[c.i]; return `<td class="num">${v == null ? '<span class="muted">-</span>' : Number(v).toFixed(c.decimals)}</td>`; }).join("")}</tr>`).join("")}</tbody></table></div>`
        : '<p class="dv-empty">No readings were stored for these values in this period.</p>'}`;
    $("dlGroup").querySelectorAll("button").forEach((b) => (b.onclick = () => { dlGroup = +b.dataset.i; renderLog(); }));
    // v3 (SC03): search bar - finds rows by date / time (e.g. 14-11 or 08:15); kept when the value group changes
    const srch = MD.v3.tableSearch($("dlSrch"), $("dlBody"), { placeholder: "Search date or time…",
      onSearch: (s) => { dlFind = s; } });
    if (dlFind) { const i = $("dlSrch").querySelector("input"); i.value = dlFind; srch.run(); }
  }
  let dlFind = "";

  window.ShiftReports = { init };
})();
