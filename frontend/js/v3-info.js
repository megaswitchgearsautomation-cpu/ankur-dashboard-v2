/* v3-info (18-11-2026): an (i) information icon on every card, on every page (client request: "set all cards, all
   places to information"). Uses MD.v3.info (tooltip below the icon, long text in a pop-up). The pages redraw their
   cards, so the icons are put back whenever a heading is drawn again. Set points already has its own icons. */
(function () {
  "use strict";
  // [heading selector, optional text match, where (after = right after the heading / in = inside it), title, text]
  const RULES = [
    [".ps-sum .ps-k", null, "in", "Panel & safety",
      "Live state of the panel safety devices: E-Stop, SPP / OV / UV relay, earth fault relay, remote E-Stop, tower light, hooter and emergency lamp. ALL SAFE = every safety device is healthy. A device shown in red needs attention before the plant can run."],
    ['.dc[data-card="sludge"] .dc-ttl', null, "after", "Sludge storage tank",
      "Sludge tank level from level transmitter 01-LT-101. The tank picture shows the level with its HH / H / L / LL lines; the arrows on the left are the levels where the plant starts / stops the pumps and opens / closes the valve. Equipment lists the machines that work with this tank. Show more opens the set points, details and the level trend."],
    ['.dc[data-card="filtrate"] .dc-ttl', null, "after", "Filtrate tank",
      "Filtrate tank level from level transmitter 01-LT-102 (water squeezed out of the sludge). HH / H / L / LL lines and the pump start / stop levels are drawn on the tank. Show more opens the set points, details and the level trend."],
    ['.dc[data-card="raw"] .dc-ttl', null, "after", "Raw water & supply pressure",
      "Gauge: supply header pressure 03-PT-301 - amber band = close to the alarm, red = at or above the alarm set point. The small tank shows the raw water tank float switches 03-LS-301 (yellow = water has reached that switch). The supply pumps keep the header above 3.0 bar; the ground water pumps fill the tank."],
    ['.dc[data-card="ph"] .dc-ttl', null, "after", "Process water pH",
      "Process water pH from pH-01. Acid or alkali is dosed automatically to keep the pH between 6.5 and 7.5 (the green band on the gauge). The two dosing pumps must never run together."],
    ['.dc[data-card="degas"] .dc-ttl', null, "after", "De-gasifier",
      "De-gasifier water temperature 07-TT-701 and tank float switches 07-LS-701 (yellow = water has reached that switch). The LP steam valve opens below its open set point and closes above its close set point."],
    ['.dc[data-card="hotwater"] .dc-ttl', null, "after", "Hot water to sludge dryer",
      "Hot water to the sludge dryer: temperature 06-TT-601, pressure 06-PT-601 and the hot water tank float switches 06-LS-603. The hot water pump runs above LL and stops at LL."],
    ['.dc[data-card="ct"] .dc-ttl', null, "after", "Cooling towers",
      "Cooling tower basins with their float switches (yellow = water has reached that switch). The pumps stop at basin LL; each fan runs only while a pump of its tower runs."],
    ['.dc[data-card="gravity"] .dc-ttl', null, "after", "Gravity tank & CTP",
      "Gravity PP tank and CTP raw water tank float switches. Pump 07-P-704 runs while the gravity tank is above LL and the CTP raw water tank is below HH."],
    ["#ovTrendCard .card-head h2", null, "after", "Process trend",
      "Live trend of the main process values. Pick a time range (Custom = your own dates in the calendar), click a coloured chip to hide or show a line, drag across the chart to zoom in. Full screen shows the trend on the whole screen."],
    ['[data-section="overview"] .card-head h2', /^Other process values/, "after", "Other process values",
      "Values that are not shown on a process card above, with their live value and alarm state."],
    [".sp-lv-h h3", /^LT-01/, "in", "LT-01 Sludge water tank level",
      "HH / H / L / LL set points of the sludge water tank level transmitter, in % of its range (mm in brackets). HH and H are reached at or above, L and LL at or below. Reached = the level is past that point now. Set delay = how long it must stay there before the alarm is raised; Delay now counts while it does. Actual = live level. Pencil = change the set point."],
    [".sp-lv-h h3", /^LT-02/, "in", "LT-02 Filtrate tank level",
      "HH / H / L / LL set points of the filtrate tank level transmitter, in % of its range (mm in brackets). HH and H are reached at or above, L and LL at or below. Reached = the level is past that point now. Set delay = how long it must stay there before the alarm is raised; Delay now counts while it does. Actual = live level. Pencil = change the set point."],
    ["#mimicCard .mm-ht h2", null, "in", "Mimic",
      "Plant drawing following the client P&ID. Green machine = running, grey = stopped, red blinking = tripped; moving lines in a pipe = flow. Click a machine or value for its details. Ctrl + scroll or + / − to zoom, drag to move, Full screen for the whole screen. 3D (Overall plant) shows the same plant in 3D."],
    ['[data-section="instruments"] .card-head h2', /^Instruments/, "after", "Instruments",
      "Every measuring instrument with its live value. The bar shows where the value is in the instrument range; the red mark is the alarm set point. Scaling = the min / max of the range; Change alarm opens its set point on the Set points page."],
    ['[data-section="equipment"] .eq-legend', null, "in", "Equipment",
      "Every motor and valve of the plant with its live state, Auto / Manual mode, run hours and starts. Click a card (or a row in List view) to see that machine on the Mimic. Cards / List switch the view; the area buttons and the search filter the list."],
    ['[data-section="trends"] .tr-ctl h2', /^Trends/, "after", "Trends",
      "Pick up to 6 values from the groups below, then a time range (Custom = your own dates). Separate = one chart per value, Combined = all on one chart. Drag across a chart to zoom in. Export CSV / PDF saves what is shown."],
    ["#ioCard .io-head h2", null, "in", "IO list",
      "Every input and output of the panel PLC, live and read-only. TRUE = signal on, FALSE = signal off. Contact NO / NC = normally open / normally closed. Analog inputs show the raw and scaled value."],
    ['[data-section="reports"] .rp-head h2', null, "after", "Reports",
      "Plant report or data log for a period from the stored history. Pick Daily / Weekly / Monthly or Custom dates (calendar), press Show report, then export to Excel, CSV or PDF."],
    ['[data-section="alarms"] .card-head h2', /^Active alarms/, "after", "Active alarms",
      "Alarms that are active now. Acknowledge one to confirm you have seen it, and add a note about the cause or the action taken."],
    ['[data-section="alarms"] .card-head h2', /^Alarm history/, "after", "Alarm history",
      "Every alarm raised in the selected period: when it was raised, cleared and acknowledged, and any note. Use the range or the calendar to change the period."],
  ];

  function place() {
    if (typeof MD === "undefined" || !MD.v3 || !MD.v3.info) return;   // MD is a top-level const (not on window)
    for (const [sel, re, where, title, text] of RULES) {
      document.querySelectorAll(sel).forEach((h) => {
        if (re && !re.test(h.textContent.trim())) return;
        const has = where === "in" ? h.querySelector(":scope > .v3-info") : h.nextElementSibling && h.nextElementSibling.classList.contains("v3-info");
        if (has) return;
        const t = document.createElement("span");
        t.innerHTML = MD.v3.info(text, title);
        const b = t.firstElementChild;
        b.classList.add("v3-info-auto");
        if (where === "in") h.appendChild(b); else h.insertAdjacentElement("afterend", b);
      });
    }
  }
  let pending = false;
  function init() {
    place();
    new MutationObserver(() => { if (!pending) { pending = true; setTimeout(() => { pending = false; place(); }, 80); } })
      .observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
