/* Client Reports page: data log of all process values over a time frame, preview + Excel / PDF export (view-only). */
(() => {
  const { esc, api, toast } = MD;
  const $ = (id) => document.getElementById(id);
  let meta = null;

  const pad = (n) => String(n).padStart(2, "0");
  const toLocalInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const fmt = (ts) => { const d = new Date(ts * 1000); return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const num = (v, d) => (v == null ? "-" : Number(v).toFixed(d));

  function applyPreset() {
    const p = $("repPreset").value;
    if (p === "custom") return;
    const now = new Date();
    let from, to = now, iv = 900;
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (p === "today") { from = midnight; iv = 900; }
    if (p === "yesterday") { from = new Date(midnight - 86400000); to = midnight; iv = 900; }
    if (p === "24h") { from = new Date(now - 86400000); iv = 900; }
    if (p === "7d") { from = new Date(now - 7 * 86400000); iv = 3600; }
    if (p === "month") { from = new Date(now.getFullYear(), now.getMonth(), 1); iv = 3600; }
    $("repFrom").value = toLocalInput(from);
    $("repTo").value = toLocalInput(to);
    $("repInterval").value = String(iv);
  }

  async function init() {
    if (meta) return;
    meta = await api("/api/report/tags");
    $("repInterval").innerHTML = meta.intervals.map((i) => `<option value="${i.s}">${esc(i.label)}</option>`).join("");
    applyPreset();
  }

  // every report contains all reportable values (no selection)
  function params() {
    const f = new Date($("repFrom").value), t = new Date($("repTo").value);
    if (isNaN(f) || isNaN(t)) throw new Error("Choose a valid From and To date/time");
    if (t <= f) throw new Error("'To' must be after 'From'");
    return new URLSearchParams({ from: String(f / 1000), to: String(t / 1000), interval: $("repInterval").value });
  }

  async function view() {
    let p;
    try { p = params(); } catch (e) { toast(e.message, true); return; }
    $("repMsg").textContent = "Loading…";
    try {
      const r = await api(`/api/report?${p}`);
      $("repMsg").textContent = `${r.rows.length} rows`;
      render(r);
    } catch (e) { $("repMsg").textContent = ""; toast(e.message, true); }
  }

  function render(r) {
    const cols = r.columns;
    const demo = r.simulated ? `<div class="banner sim" style="margin:0 0 12px">${MD.ICON.flask}<div><strong>Demo data</strong>The values in this report are simulated, not measured plant data.</div></div>` : "";
    const shown = r.rows.slice(0, 1000);
    $("repOut").innerHTML = `
      <div class="card" style="margin-top:16px">
        <div class="card-head"><h2>Data log <span class="count">${fmt(r.from)} – ${fmt(r.to)} · ${esc(r.interval)} · ${r.rows.length} rows${r.rows.length > shown.length ? ` (first ${shown.length} shown, download for all)` : ""}</span></h2></div>
        ${demo}
        ${r.rows.length ? `<div class="rep-table"><table><tr><th>Date / time</th>${cols.map((c) => `<th style="text-align:right">${esc(c.name)}${c.unit ? `<div class="muted" style="font-weight:600">${esc(c.unit)}</div>` : ""}</th>`).join("")}</tr>
        ${shown.map((row) => `<tr><td class="num">${fmt(row.t)}</td>${row.values.map((v, i) => `<td class="n">${num(v, cols[i].decimals)}</td>`).join("")}</tr>`).join("")}
        </table></div>` : '<div class="empty">No data recorded in this period.</div>'}
      </div>`;
  }

  async function download(kind) {
    let p;
    try { p = params(); } catch (e) { toast(e.message, true); return; }
    $("repMsg").textContent = `Preparing ${kind === "xlsx" ? "Excel" : "PDF"}…`;
    try {
      const r = await fetch(`/api/report.${kind}?${p}`, { credentials: "same-origin" });
      if (r.status === 401) { location.replace("/login?expired=1"); return; }
      if (!r.ok) { let m = "Export failed"; try { m = (await r.json()).error || m; } catch (_) {} throw new Error(m); }
      const blob = await r.blob();
      const name = (r.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/)?.[1] || `report.${kind}`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      $("repMsg").textContent = `Downloaded ${name}`;
    } catch (e) { $("repMsg").textContent = ""; toast(e.message, true); }
  }

  $("repPreset").onchange = applyPreset;
  ["repFrom", "repTo"].forEach((id) => ($(id).oninput = () => ($("repPreset").value = "custom")));
  $("repView").onclick = view;
  $("repXlsx").onclick = () => download("xlsx");
  $("repPdf").onclick = () => download("pdf");

  function onRoute() { if (/^(reports|data)\b/.test((location.hash || "").slice(1))) init().catch((e) => toast(e.message, true)); }
  window.addEventListener("hashchange", onRoute);
  onRoute();
})();
