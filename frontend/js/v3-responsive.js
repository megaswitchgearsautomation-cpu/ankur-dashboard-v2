/* v3-responsive (17-11-2026): phone Menu button + table-to-card labels. CSS is in css/v3-responsive.css. */
(function () {
  "use strict";
  const PHONE = window.matchMedia("(max-width: 760px)");

  /* ---------- phone Menu button: opens / closes the page list in the top bar ---------- */
  function initMenu() {
    const rail = document.querySelector(".rail");
    const nav = document.getElementById("nav");
    if (!rail || !nav || document.getElementById("railMenuBtn")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "railMenuBtn";
    btn.className = "rail-menu";
    btn.setAttribute("aria-controls", "nav");
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>' +
      '<span class="rm-txt">Menu</span><span class="rm-badge" hidden></span>';
    rail.insertBefore(btn, nav);

    const setOpen = (open) => {
      rail.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", String(open));
      btn.querySelector("svg").innerHTML = open ? '<path d="M6 6l12 12M18 6 6 18"/>' : '<path d="M4 6h16M4 12h16M4 18h16"/>';
    };
    btn.addEventListener("click", (e) => { e.stopPropagation(); setOpen(!rail.classList.contains("open")); });
    nav.addEventListener("click", (e) => { if (e.target.closest("a")) setOpen(false); });
    document.addEventListener("click", (e) => { if (rail.classList.contains("open") && !rail.contains(e.target)) setOpen(false); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && rail.classList.contains("open")) { setOpen(false); btn.focus(); } });
    PHONE.addEventListener("change", () => setOpen(false));

    // alarm count on the Menu button (the side-bar badge is hidden while the menu is closed)
    const src = document.getElementById("navAlarmCount"), dst = btn.querySelector(".rm-badge");
    if (src) {
      const sync = () => { dst.textContent = src.textContent; dst.hidden = src.classList.contains("hidden") || !src.textContent.trim(); };
      new MutationObserver(sync).observe(src, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });
      sync();
    }
  }

  /* ---------- tables: every cell gets its column name, so on a phone each row reads as a card ---------- */
  const CARD_TABLES = "table.sp-t, table.io-t, table.al-table";
  function labelTable(t) {
    const heads = [...t.querySelectorAll("thead th")].map((th) => th.textContent.replace(/\s+/g, " ").trim());
    if (!heads.length) return;
    t.classList.add("rt-cards");
    t.querySelectorAll("tbody tr").forEach((tr) => {
      let i = 0;
      for (const td of tr.children) {
        const span = td.colSpan || 1;
        if (span === 1 && heads[i] && td.dataset.label !== heads[i]) td.dataset.label = heads[i];
        i += span;
      }
    });
  }
  function labelAll() { document.querySelectorAll(CARD_TABLES).forEach(labelTable); }

  /* ---------- cards side by side: the parts with a variable number of lines (a name on 1, 2 or 3 lines) get the
     height of the tallest one in the same visual row, so values, bars and buttons below them line up at every
     window width (client 20-11-2026: "when I squeeze the screen the alignment must not be disturbed") ---------- */
  const ROW_PARTS = [
    [".inst-grid", ".inst", [".in-n"]],                       // Instruments
    [".eqg", ".eqc", [".eqc-top", ".eqc-name", ".eqc-meta", ".eqc-stats"]],   // Equipment cards
    [".charts", ".tr-card", [".tr-head"]],                    // Trends charts
  ];
  function alignParts() {
    for (const [gridSel, cardSel, parts] of ROW_PARTS) {
      document.querySelectorAll(gridSel).forEach((grid) => {
        if (!grid.offsetParent) return;
        const cards = [...grid.querySelectorAll(`:scope > ${cardSel}`)].filter((c) => c.offsetParent);
        parts.forEach((p) => cards.forEach((c) => { const el = c.querySelector(p); if (el && el.style.minHeight) el.style.minHeight = ""; }));
        const rows = new Map();
        cards.forEach((c) => { const k = Math.round(c.offsetTop); if (!rows.has(k)) rows.set(k, []); rows.get(k).push(c); });
        rows.forEach((row) => {
          if (row.length < 2) return;
          parts.forEach((p) => {
            const els = row.map((c) => c.querySelector(p)).filter(Boolean);
            const max = Math.max(...els.map((el) => el.getBoundingClientRect().height));
            els.forEach((el) => { if (max - el.getBoundingClientRect().height > 0.5) el.style.minHeight = `${Math.ceil(max)}px`; });
          });
        });
      });
    }
  }
  let alignT = 0;
  const alignSoon = () => { clearTimeout(alignT); alignT = setTimeout(alignParts, 60); };

  function init() {
    initMenu();
    labelAll();
    alignSoon();
    window.addEventListener("resize", alignSoon);
    window.addEventListener("hashchange", () => setTimeout(alignParts, 300));
    // re-drawn cards are aligned at once, inside the observer (it runs before the browser paints) - a delayed
    // alignment let the unaligned layout show for a moment on every live update: flicker (client 20-11-2026)
    new MutationObserver((recs) => { if (recs.some((r) => r.addedNodes.length && !(r.target.closest && r.target.closest("svg")))) alignParts(); })
      .observe(document.body, { childList: true, subtree: true });
    // observer callbacks run before the next paint, so a re-drawn table never shows without its labels
    new MutationObserver((recs) => { if (recs.some((r) => r.addedNodes.length)) labelAll(); }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
