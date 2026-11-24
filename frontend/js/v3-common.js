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
  // oldest time a trend range may start: the retention limit only. A range is never shortened to the first logged
  // sample - "7 days" always spans 7 days, and time without data is drawn as empty (no data), not cut off.
  function retentionStart() {
    const h = (window.MD_META || {}).history || {};
    return Date.now() / 1000 - (h.retention_days || 30) * DAY;
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
      <span class="dr-applied dr-open" role="button" tabindex="0" title="Pick start and end dates" aria-label="Pick start and end dates">${CAL}<span class="dr-txt"></span></span>`;
    const q = (s) => host.querySelector(s);
    const from = q(".dr-from"), to = q(".dr-to");
    const now = () => Date.now() / 1000;
    const minIso = MD.istDate(retentionStart()), maxIso = MD.istDate(now());
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
      f = Math.max(f, retentionStart());
      if (t <= f) { MD.toast("The end date must be after the start date", true); return; }
      q(".dr-txt").textContent = label(f, t);
      if (fire && opts.onApply) opts.onApply(f, t, k);
    }
    // Custom / the date text: calendar pop-up (start + end day), the range is applied on Apply only
    function openCal() {
      const n = now(), [f0, t0] = windowOf(key);
      calendar({ anchor: q(".dr-applied"), from: MD.istDate(Math.max(f0, retentionStart())), to: MD.istDate(Math.min(n, t0 - 1)),
        min: MD.istDate(retentionStart()), max: MD.istDate(n),
        onApply: (f, t) => { from.value = f; to.value = t; apply("custom"); } });
    }
    host.querySelectorAll(".dr-presets button").forEach((b) => (b.onclick = () => (b.dataset.k === "custom" ? openCal() : apply(b.dataset.k))));
    q(".dr-applied").onclick = openCal;
    q(".dr-applied").onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openCal(); } };
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

  // ---------- calendar pop-up: pick a start and an end day (client review 17-11-2026, like the "Date Range
  // Component" reference): quick choices on the left, two months side by side (one on phones), Cancel / Apply ----------
  // calendar({anchor, from, to, min, max, presets: [[label, () => [fromIso, toIso]]], onApply(fromIso, toIso), title})
  // all dates are "YYYY-MM-DD" IST days; min / max limit what can be picked (history kept .. today)
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const isoOf = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.toISOString().slice(0, 10); };
  const isoParts = (iso) => iso.split("-").map(Number);
  const isoAdd = (iso, n) => { const [y, m, d] = isoParts(iso); return isoOf(y, m, d + n); };
  const isoDow = (iso) => { const [y, m, d] = isoParts(iso); return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; };   // Mon = 0
  const isoNice = (iso) => { if (!iso) return "–"; const [y, m, d] = isoParts(iso); return `${d} ${MONTHS[m - 1].slice(0, 3)} ${y}`; };
  function calPresets() {                       // the common choices, as start / end days
    const t = MD.istDate(Date.now() / 1000), lo = MD.istDate(retentionStart());
    const mon = isoAdd(t, -isoDow(t)), first = t.slice(0, 8) + "01", [y, m] = isoParts(t);
    const pFirst = isoOf(y, m - 1, 1), pLast = isoOf(y, m, 0);
    return [["Today", () => [t, t]], ["Yesterday", () => [isoAdd(t, -1), isoAdd(t, -1)]], ["This week", () => [mon, t]],
      ["Last week", () => [isoAdd(mon, -7), isoAdd(mon, -1)]], ["Last 7 days", () => [isoAdd(t, -6), t]], ["Last 30 days", () => [isoAdd(t, -29), t]],
      ["This month", () => [first, t]], ["Last month", () => [pFirst, pLast]], ["All kept history", () => [lo, t]]];
  }
  let calOpen = null;
  function calendar(o) {
    if (calOpen) calOpen.close();
    const min = o.min || "0000-01-01", max = o.max || "9999-12-31";
    const clamp = (iso) => (iso < min ? min : iso > max ? max : iso);
    let a = o.from ? clamp(o.from) : null, b = o.to ? clamp(o.to) : null, hover = null;
    const startView = b || a || max; let [vy, vm] = isoParts(startView);
    const twoUp = () => window.matchMedia("(min-width: 900px)").matches;
    if (twoUp()) { vm -= 1; if (vm < 1) { vm = 12; vy -= 1; } }          // show the end month on the right
    const presets = o.presets || [];                   // quick-choice list removed (user 18-11-2026): calendar only; calPresets() kept if wanted again
    const bg = document.createElement("div");
    bg.className = "cal-bg";
    bg.innerHTML = `<div class="cal${presets.length ? "" : " no-side"}" role="dialog" aria-modal="true" aria-label="${esc(o.title || "Pick a date range")}">
      ${presets.length ? `<div class="cal-side" role="group" aria-label="Quick choices">${presets.map(([l], i) => `<button type="button" data-p="${i}">${esc(l)}</button>`).join("")}</div>` : ""}
      <div class="cal-main"><div class="cal-months"></div>
        <div class="cal-foot"><div class="cal-sel"><span class="cal-box" data-w="a"></span><span class="cal-dash">–</span><span class="cal-box" data-w="b"></span></div>
          <div class="cal-btns"><button type="button" class="btn cal-cancel">Cancel</button><button type="button" class="btn primary cal-ok">Apply</button></div></div>
        <p class="cal-hint">Click the first day, then the last day. History kept: ${esc(isoNice(min))} – ${esc(isoNice(max))} (IST).</p></div></div>`;
    document.body.appendChild(bg);
    const box = bg.querySelector(".cal");
    function month(y, m) {
      const first = isoOf(y, m, 1), lead = isoDow(first), days = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const lo = a && (b || hover) ? (a < (b || hover) ? a : (b || hover)) : a, hi = a && (b || hover) ? (a < (b || hover) ? (b || hover) : a) : a;
      let cells = "";
      for (let i = 0; i < lead; i++) cells += `<span class="cal-d out"></span>`;
      for (let d = 1; d <= days; d++) {
        const iso = isoOf(y, m, d), off = iso < min || iso > max;
        const cls = ["cal-d"];
        if (off) cls.push("off");
        if (lo && hi && iso >= lo && iso <= hi) cls.push("in");
        if (iso === lo) cls.push("s");
        if (iso === hi) cls.push("e");
        if (iso === max) cls.push("today");
        cells += `<button type="button" class="${cls.join(" ")}" data-d="${iso}" ${off ? "disabled" : ""} aria-label="${esc(isoNice(iso))}" aria-pressed="${iso === lo || iso === hi}">${d}</button>`;
      }
      return `<div class="cal-m"><div class="cal-mh"><b>${MONTHS[m - 1]} ${y}</b></div>
        <div class="cal-w">${["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((w) => `<span>${w}</span>`).join("")}</div><div class="cal-g">${cells}</div></div>`;
    }
    function draw() {
      const n = twoUp() ? 2 : 1, list = [];
      for (let i = 0; i < n; i++) { const t = new Date(Date.UTC(vy, vm - 1 + i, 1)); list.push([t.getUTCFullYear(), t.getUTCMonth() + 1]); }
      const firstIso = isoOf(list[0][0], list[0][1], 1), lastIso = isoOf(list[n - 1][0], list[n - 1][1] + 1, 0);
      box.querySelector(".cal-months").innerHTML =
        `<button type="button" class="cal-nav prev" aria-label="Previous month" ${firstIso <= min ? "disabled" : ""}>‹</button>` +
        list.map(([y, m]) => month(y, m)).join("") +
        `<button type="button" class="cal-nav next" aria-label="Next month" ${lastIso >= max ? "disabled" : ""}>›</button>`;
      box.querySelector('.cal-box[data-w="a"]').textContent = a ? isoNice(a) : "Start day";
      box.querySelector('.cal-box[data-w="b"]').textContent = b ? isoNice(b) : a ? "End day" : "End day";
      box.querySelector('.cal-box[data-w="a"]').classList.toggle("act", !a || (a && b));
      box.querySelector('.cal-box[data-w="b"]').classList.toggle("act", !!a && !b);
      box.querySelector(".cal-ok").disabled = !a;
      box.querySelectorAll(".cal-side button").forEach((btn) => {
        const [f, t] = presets[+btn.dataset.p][1]();
        btn.classList.toggle("active", !!a && clamp(f) === a && clamp(t) === (b || a));
      });
    }
    const move = (k) => { const t = new Date(Date.UTC(vy, vm - 1 + k, 1)); vy = t.getUTCFullYear(); vm = t.getUTCMonth() + 1; draw(); };
    box.addEventListener("click", (e) => {
      const d = e.target.closest(".cal-d[data-d]");
      if (d && !d.disabled) {
        const iso = d.dataset.d;
        if (!a || b) { a = iso; b = null; } else if (iso < a) { b = a; a = iso; } else b = iso;
        hover = null; draw(); return;
      }
      if (e.target.closest(".cal-nav.prev")) return move(-1);
      if (e.target.closest(".cal-nav.next")) return move(1);
      const p = e.target.closest(".cal-side button");
      if (p) {
        const [f, t] = presets[+p.dataset.p][1]();
        a = clamp(f); b = clamp(t); if (b < a) b = a;
        [vy, vm] = isoParts(b); if (twoUp() && isoParts(a)[1] !== vm) { vm -= 1; if (vm < 1) { vm = 12; vy -= 1; } }
        draw();
      }
    });
    box.addEventListener("mouseover", (e) => {
      const d = e.target.closest(".cal-d[data-d]");
      if (a && !b && d && !d.disabled && hover !== d.dataset.d) { hover = d.dataset.d; draw(); }
    });
    const close = () => { bg.remove(); document.removeEventListener("keydown", onKey); window.removeEventListener("resize", draw); calOpen = null; if (o.anchor && o.anchor.focus) o.anchor.focus(); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", draw);
    bg.addEventListener("mousedown", (e) => { if (e.target === bg) close(); });
    box.querySelector(".cal-cancel").onclick = close;
    box.querySelector(".cal-ok").onclick = () => { if (!a) return; const f = a, t = b || a; close(); if (o.onApply) o.onApply(f, t); };
    draw();                                             // fill first, so the size below is the real one
    // place under the anchor on wide screens (above it when there is no room below); narrow screens get a sheet (CSS)
    if (o.anchor && twoUp()) {
      const r = o.anchor.getBoundingClientRect(), w = box.offsetWidth, h = box.offsetHeight;
      const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left));
      let top = r.bottom + 8;
      if (top + h > window.innerHeight - 8) top = r.top - h - 8 >= 8 ? r.top - h - 8 : Math.max(8, window.innerHeight - h - 8);
      box.style.position = "fixed"; box.style.left = `${left}px`; box.style.top = `${top}px`;
      bg.classList.add("anch");
    }
    const first = box.querySelector(".cal-d.s") || box.querySelector(".cal-side button");
    if (first) first.focus();
    calOpen = { close };
    return calOpen;
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

  // ---------- pager under a long table (Reports, Alarm history, ...) ----------
  // pager(table, {group, after}) - Page [n] of N · a–b of total · « ‹ 1 2 3 … › » · Rows [25/50/100].
  // Rows hidden by a search (tr.hidden) are skipped; rows on other pages get .pg-off (shown again when printing,
  // and still included in CSV exports). Tables of the same group share the rows-per-page choice.
  // Hidden while the table has 25 rows or fewer. Returns {go(page)}; call go(1) after re-rendering / searching.
  const pgSizes = {};
  const pgTables = [];
  function pager(table, opts = {}) {
    const group = opts.group || "default";
    if (!pgSizes[group]) pgSizes[group] = 25;
    const host = document.createElement("div");
    host.className = "rp-pager no-print";
    host.hidden = true;
    (opts.after || table.closest(".rp-scroll") || table).after(host);
    let page = 1;
    const body = () => table.tBodies[0];
    const rowsOf = () => (body() ? [...body().rows].filter((r) => !r.hidden && !r.classList.contains("al-none")) : []);
    const go = (p) => {
      const size = pgSizes[group];
      const rows = rowsOf(), total = rows.length, pages = Math.max(1, Math.ceil(total / size));
      page = Math.min(Math.max(1, p), pages);
      if (body()) [...body().rows].forEach((r) => r.classList.remove("pg-off"));
      rows.forEach((r, i) => r.classList.toggle("pg-off", Math.floor(i / size) + 1 !== page));
      if (total <= 25) { host.hidden = true; host.innerHTML = ""; return; }     // short table: no pager
      host.hidden = false;
      const nums = [];
      for (let k = 1; k <= pages; k++) if (k <= 3 || k > pages - 3 || Math.abs(k - page) <= 1) nums.push(k);
      const btns = nums.map((k, i) => `${i && k - nums[i - 1] > 1 ? '<span class="gap">…</span>' : ""}<button type="button" data-p="${k}" class="${k === page ? "on" : ""}" aria-label="Page ${k}"${k === page ? ' aria-current="page"' : ""}>${k}</button>`).join("");
      const a = (page - 1) * size + 1, b = Math.min(total, page * size);
      host.innerHTML = `<span class="pg-at">Page <input type="number" min="1" max="${pages}" value="${page}" aria-label="Page number"> of ${pages}</span>
        <span class="pg-n">${a}–${b} of ${total}</span>
        <span class="pg-btns"><button type="button" data-p="1" aria-label="First page" ${page === 1 ? "disabled" : ""}>«</button><button type="button" data-p="${page - 1}" aria-label="Previous page" ${page === 1 ? "disabled" : ""}>‹</button>
          ${btns}<button type="button" data-p="${page + 1}" aria-label="Next page" ${page === pages ? "disabled" : ""}>›</button><button type="button" data-p="${pages}" aria-label="Last page" ${page === pages ? "disabled" : ""}>»</button></span>
        <label class="pg-rows">Rows <select aria-label="Rows per page">${[25, 50, 100].map((n) => `<option ${n === size ? "selected" : ""}>${n}</option>`).join("")}</select></label>`;
      host.querySelectorAll("[data-p]").forEach((x) => (x.onclick = () => { go(+x.dataset.p); host.scrollIntoView({ block: "nearest" }); }));
      const inp = host.querySelector("input");
      inp.onchange = () => go(+inp.value || 1);
      host.querySelector("select").onchange = (e) => {
        pgSizes[group] = +e.target.value;
        pgTables.filter((t) => t.group === group && t.table.isConnected).forEach((t) => t.go(1));
      };
    };
    for (let i = pgTables.length - 1; i >= 0; i--) if (!pgTables[i].table.isConnected) pgTables.splice(i, 1);
    pgTables.push({ table, group, go });
    go(1);
    return { go, host, get page() { return page; } };
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

  MD.v3 = { CAL, INFO, PEN, SEARCH, historyStart, retentionStart, rangePicker, calendar, info, popup, closeTip, tableSearch, pager, level, exportCsv, tableRows, printPdf, prefs, savePrefs };
})();
