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

  function init() {
    initMenu();
    labelAll();
    // observer callbacks run before the next paint, so a re-drawn table never shows without its labels
    new MutationObserver((recs) => { if (recs.some((r) => r.addedNodes.length)) labelAll(); }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
