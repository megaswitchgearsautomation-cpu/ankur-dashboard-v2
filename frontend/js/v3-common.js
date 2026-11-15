/* v3 shared UI helpers (brief 14-11-2026 + scada_design.md). Loaded right after common.js; adds MD.v3.
   - rangePicker   : ONE calendar icon + From / To dates (IST) + presets, limited to the history actually kept
   - info          : (i) icon on the RIGHT of a card heading -> small tooltip below it; long text -> centred pop-up
   - popup         : small centred pop-up with Save / Cancel (replaces the big side drawer for edits)
   - tableSearch   : search box that filters the rows of one or more tables (and hides empty groups)
   - level         : warning band rule for a live value against an alarm set point (high / low limit)
   - exportCsv / printPdf : CSV download of a table, and print (Save as PDF) of one element only */
(() => {
  const { esc } = MD;
  const CAL = '<svg class="v3-cal" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
  const INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/></svg>';
  const PEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="m13.5 6.5 4 4"/></svg>';
  const SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
  const DAY = 86400;

  // ---------- history limits (from /api/meta.history) ----------
  function historyStart() {
    const h = (window.MD_META || {}).history || {};
    const now = Date.now() / 1000;
    const byRetention = now - (h.retention_days || 30) * DAY;
    return Math.max(byRetention, h.first_ts || byRetention);
  }

  // ---------- date range picker ----------
  // host: element. opts: { presets: [[label, key]], onApply(fromTs, toTs, key), value: {from, to} , withTime: false }
  // Preset keys: "8h", "2d", "7d", "today", "24h", "month", "custom". Dates are IST days; "to" = end of that day.
  function rangePicker(host, opts = {}) {
    const presets = opts.presets || [["8 hours", "8h"], ["2 days", "2d"], ["7 days", "7d"], ["Custom", "custom"]];
    host.classList.add("dr-wrap");
    host.innerHTML = `<div class="seg sm dr-presets" role="group" aria-label="Time range">${presets.map(([l, k]) =>
      `<button type="button" data-k="${esc(k)}">${esc(l)}</button>`).join("")}</div>
      <div class="dr-pick" hidden>${CAL}<label class="sr">From</label><input type="date" class="dr-from" aria-label="From date (IST)">
        <span class="dr-dash">–</span><input type="date" class="dr-to" aria-label="To date (IST)">
        <button type="button" class="btn sm primary dr-apply">Show</button></div>
      <span class="dr-applied">${CAL}<span class="dr-txt"></span></span>`;
    const q = (s) => host.querySelector(s);
    const from = q(".dr-from"), to = q(".dr-to");
    const now = () => Date.now() / 1000;
    const minIso = MD.istDate(historyStart()), maxIso = MD.istDate(now());
    [from, to].forEach((i) => { i.min = minIso; i.max = maxIso; });
    from.value = MD.istDate(now() - 6 * DAY); to.value = maxIso;
    let key = opts.initial || presets[0][1];
    function windowOf(k) {
      const n = now();
      if (k === "8h") return [n - 8 * 3600, n];
      if (k === "24h") return [n - DAY, n];
      if (k === "2d") return [n - 2 * DAY, n];
      if (k === "7d") return [n - 7 * DAY, n];
      if (k === "30d") return [n - 30 * DAY, n];
      if (k === "today") return [MD.istDayStart(MD.istDate(n)), n];
      if (k === "month") { const p = MD.istParts(n); return [MD.istDayStart(`${p.y}-${String(p.mo).padStart(2, "0")}-01`), n]; }
      const f = MD.istDayStart(from.value), t = Math.min(n, MD.istDayStart(to.value) + DAY);
      return [f, t];
    }
    function label(f, t) { return `${MD.fmtTime(f, true).slice(0, 16)} – ${MD.fmtTime(t, true).slice(0, 16)} IST`; }
    function apply(k, fire = true) {
      key = k;
      host.querySelectorAll(".dr-presets button").forEach((b) => b.classList.toggle("active", b.dataset.k === k));
      q(".dr-pick").hidden = k !== "custom";
      if (k === "custom" && fire === "open") return;            // wait for Show
      let [f, t] = windowOf(k);
      f = Math.max(f, historyStart() - 3600);
      if (t <= f) { MD.toast("The end date must be after the start date", true); return; }
      q(".dr-txt").textContent = label(f, t);
      if (fire && opts.onApply) opts.onApply(f, t, k);
    }
    host.querySelectorAll(".dr-presets button").forEach((b) => (b.onclick = () => apply(b.dataset.k, b.dataset.k === "custom" ? "open" : true)));
    q(".dr-apply").onclick = () => {
      if (!from.value || !to.value) return MD.toast("Pick both a start and an end date", true);
      if (to.value < from.value) return MD.toast("The end date must be after the start date", true);
      apply("custom");
    };
    apply(key, opts.fireInitial !== false);
    return {
      get key() { return key; },
      get window() { return windowOf(key); },
      set(f, t) {                      // e.g. after a chart zoom: show the zoomed window as a custom range
        key = "custom";
        host.querySelectorAll(".dr-presets button").forEach((b) => b.classList.toggle("active", b.dataset.k === "custom"));
        from.value = MD.istDate(f); to.value = MD.istDate(t);
        q(".dr-txt").textContent = label(f, t);
      },
      refresh: () => apply(key),
    };
  }

  // ---------- info icon + tooltip / pop-up ----------
  function info(text, title = "") {
    return `<button type="button" class="v3-info" aria-label="More information" data-info="${esc(text)}" data-title="${esc(title)}">${INFO}</button>`;
  }
  let tipEl = null;
  function closeTip() { if (tipEl) { tipEl.remove(); tipEl = null; } }
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".v3-info");
    if (!b) { if (tipEl && !e.target.closest(".v3-tip")) closeTip(); return; }
    e.preventDefault(); e.stopPropagation();
    const txt = b.dataset.info || "";
    if (txt.length > 220) { closeTip(); return popup({ title: b.dataset.title || "Information", body: `<p class="v3-long">${esc(txt)}</p>`, okOnly: true }); }
    if (tipEl && tipEl._for === b) return closeTip();
    closeTip();
    tipEl = document.createElement("div");
    tipEl.className = "v3-tip"; tipEl.role = "tooltip"; tipEl._for = b;
    tipEl.textContent = txt;
    document.body.appendChild(tipEl);
    const r = b.getBoundingClientRect(), w = tipEl.offsetWidth;
    tipEl.style.top = `${r.bottom + window.scrollY + 8}px`;
    tipEl.style.left = `${Math.max(8, Math.min(window.scrollX + document.documentElement.clientWidth - w - 8, r.right + window.scrollX - w))}px`;
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeTip(); });

  // ---------- small centred pop-up (Save / Cancel) ----------
  // popup({title, body (html), saveLabel, onSave: async (box) => true|false(keep open), okOnly})
  function popup(o) {
    const bg = document.createElement("div");
    bg.className = "v3-pop-bg";
    bg.innerHTML = `<div class="v3-pop" role="dialog" aria-modal="true" aria-label="${esc(o.title || "")}">
      <div class="v3-pop-h"><h3>${esc(o.title || "")}</h3><button type="button" class="v3-x" aria-label="Close">×</button></div>
      <div class="v3-pop-b">${o.body || ""}</div>
      <div class="v3-pop-msg" role="alert"></div>
      <div class="v3-pop-f">${o.okOnly ? '<button type="button" class="btn primary v3-cancel">OK</button>'
        : `<button type="button" class="btn v3-cancel">Cancel</button><button type="button" class="btn primary v3-save">${esc(o.saveLabel || "Save")}</button>`}</div></div>`;
    document.body.appendChild(bg);
    const box = bg.querySelector(".v3-pop");
    const close = () => { bg.remove(); document.removeEventListener("keydown", onKey); if (o.onClose) o.onClose(); };
    const onKey = (e) => { if (e.key === "Escape") close(); if (e.key === "Enter" && e.target.tagName === "INPUT") { const s = box.querySelector(".v3-save"); if (s) s.click(); } };
    document.addEventListener("keydown", onKey);
    bg.addEventListener("mousedown", (e) => { if (e.target === bg) close(); });
    box.querySelector(".v3-x").onclick = close;
    box.querySelector(".v3-cancel").onclick = close;
    const save = box.querySelector(".v3-save");
    if (save) save.onclick = async () => {
      save.disabled = true; save.setAttribute("aria-busy", "true");
      box.querySelector(".v3-pop-msg").textContent = "";
      try { const keep = await o.onSave(box); if (keep !== false) close(); }
      catch (err) { box.querySelector(".v3-pop-msg").textContent = err.message || String(err); }
      finally { save.disabled = false; save.removeAttribute("aria-busy"); }
    };
    const first = box.querySelector("input, select, textarea, .v3-save, .v3-cancel");
    if (first) setTimeout(() => first.focus(), 0);
    return { box, close, msg: (t) => (box.querySelector(".v3-pop-msg").textContent = t) };
  }

  // ---------- table search ----------
  // tableSearch(host, scopeEl, {placeholder}) - filters every <tbody><tr> under scopeEl; hides a table / [data-group]
  // block when none of its rows match. Rows may carry data-search="extra words".
  function tableSearch(host, scope, opts = {}) {
    host.innerHTML = `<label class="v3-search">${SEARCH}<input type="search" placeholder="${esc(opts.placeholder || "Search tag or name…")}" aria-label="Search"></label>`;
    const inp = host.querySelector("input");
    const run = () => {
      const s = inp.value.trim().toLowerCase();
      const root = typeof scope === "function" ? scope() : scope;
      if (!root) return;
      root.querySelectorAll("tbody tr").forEach((tr) => {
        const hay = (tr.textContent + " " + (tr.dataset.search || "")).toLowerCase();
        tr.hidden = !!s && !hay.includes(s);
      });
      root.querySelectorAll("[data-group]").forEach((g) => {
        const rows = g.querySelectorAll("tbody tr");
        g.hidden = !!s && rows.length > 0 && [...rows].every((r) => r.hidden);
      });
      if (opts.onSearch) opts.onSearch(s);
    };
    inp.addEventListener("input", run);
    return { run, get value() { return inp.value; } };
  }

  // ---------- warning band for a live value vs its alarm set point ----------
  // dir "high" (alarm at/above SP) or "low" (alarm at/below SP). Returns "ok" | "warn" | "alarm" | "" (no data)
  function level(value, sp, dir = "high") {
    if (typeof value !== "number" || typeof sp !== "number" || !isFinite(value) || !isFinite(sp)) return "";
    const band = ((window.MD_META || {}).warn_band_pct ?? 90) / 100;
    if (dir === "low") {
      if (value <= sp) return "alarm";
      const warnAt = sp >= 0 ? sp / band : sp * band;      // mirror: e.g. SP 10 -> warning from 11.1 down
      return value <= warnAt ? "warn" : "ok";
    }
    if (value >= sp) return "alarm";
    const warnAt = sp >= 0 ? sp * band : sp / band;
    return value >= warnAt ? "warn" : "ok";
  }

  // ---------- exports ----------
  function exportCsv(filename, rows) {           // rows: array of arrays (first = header)
    const csv = rows.map((r) => r.map((c) => {
      const s = String(c ?? "");
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function tableRows(table) {                     // visible rows of an HTML table -> array of arrays
    const out = [];
    table.querySelectorAll("tr").forEach((tr) => {
      if (tr.hidden || tr.closest("[hidden]")) return;
      const cells = [...tr.querySelectorAll("th, td")].filter((c) => !c.classList.contains("no-export"));
      if (cells.length) out.push(cells.map((c) => (c.dataset.export ?? c.innerText).replace(/\s+/g, " ").trim()));
    });
    return out;
  }
  // print only one element (browser "Save as PDF"); title goes on top of the page
  function printPdf(el, title) {
    document.body.classList.add("v3-printing");
    el.classList.add("v3-print-me");
    const h = document.createElement("div");
    h.className = "v3-print-title";
    h.textContent = `${title} · ${(window.MD_META && MD_META.site && MD_META.site.name) || ""} · printed ${MD.fmtTime(Date.now() / 1000, true)} IST`;
    el.prepend(h);
    const done = () => { document.body.classList.remove("v3-printing"); el.classList.remove("v3-print-me"); h.remove(); window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    window.print();
    setTimeout(done, 1500);
  }

  // ---------- per-user preferences (server side, per signed-in user) ----------
  let prefsCache = null;
  async function prefs() {
    if (prefsCache) return prefsCache;
    try { prefsCache = (await MD.api("/api/client/prefs")).prefs || {}; } catch (_) { prefsCache = {}; }
    return prefsCache;
  }
  async function savePrefs(p) {
    prefsCache = Object.assign(prefsCache || {}, p);
    try { await MD.api("/api/client/prefs", { method: "PUT", body: { prefs: p } }); } catch (e) { MD.toast("Could not save your layout: " + e.message, true); }
  }

  MD.v3 = { CAL, INFO, PEN, SEARCH, historyStart, rangePicker, info, popup, closeTip, tableSearch, level, exportCsv, tableRows, printPdf, prefs, savePrefs };
})();
