/* SVG charts: one series per chart (small multiples - never a dual axis) or several series that share one unit.
   Smooth (monotone) curves, gradient area, min/max band, alarm set point line + shaded alarm zone,
   draw-in animation, pulsing latest point, crosshair + tooltip - and ZOOM / PAN on every chart (brief SC06).

   ===== API =====
   MDChart.render(box, opts)       one series (line, or ON/OFF step line when isBool)
     opts: { name, unit, decimals, color, points:[{t,avg,min,max,sim,bad}], from, to, isBool, limits:[{v,label}],
             height, animate, yMin, yMax, ...ZOOM OPTIONS }
   MDChart.renderMulti(box, opts)  several series that share ONE unit on one axis
     opts: { unit, decimals, from, to, height, animate, area, limits, yMin, yMax,
             series:[{name, color, points, hidden}], ...ZOOM OPTIONS }
   MDChart.renderBars(box, opts)   bars over time (e.g. hourly totals)
     opts: { name, unit, decimals, color, from, to, height, animate, limits, yMin, yMax,
             bars:[{t, v, w (bar width in s, optional), color, label}], ...ZOOM OPTIONS }

   ZOOM OPTIONS (all optional - every chart gets the controls automatically):
     from / to      the FULL selected range ("home"). Zoom never goes outside it; "Full range" returns to it.
     zoomGroup      string key: charts with the same key zoom / pan together and keep their zoom when the caller
                    re-renders them into new elements (e.g. all charts of the Trends page). Without it the zoom state
                    lives on the box element itself.
     view           [from, to] - set the visible window explicitly (e.g. after the caller re-fetched finer data).
     resetZoom      true = start at the full range (use when the user picks a new date range).
     onView(a, b, {reset})  called (debounced 250 ms) after the visible window changed by +/-, pan, drag or wheel.
                    The caller may re-fetch finer data for [a, b] and render again (the zoom state is kept);
                    without it the chart only re-scales the points it already has.
     controls       false = no toolbar (drag / wheel still work). Default true.
     onZoom(a, b)   (legacy) still called after a drag-to-zoom.

   Interaction: toolbar  [-] zoom out  [+] zoom in  [<] [>] move left / right  [Full range]
                drag across the plot = zoom to that window · Shift + drag = pan · Ctrl + wheel = zoom at the cursor ·
                Shift + wheel (or horizontal trackpad scroll) = pan. Hover values / timestamps always come from the
                points inside the visible window.
   MDChart.resetZoom(boxOrGroupKey)   forget the zoom (next render shows the full range)
   MDChart.getView(boxOrGroupKey)     [from, to] currently visible, or null when showing the full range
   MDChart.zoom(boxOrGroupKey, cmd)   cmd = "in" | "out" | "left" | "right" | "reset" (same as the buttons) */
const MDChart = (() => {
  const NS = "http://www.w3.org/2000/svg";
  let uid = 0;
  const MIN_W = 120;                                   // narrowest window: 2 minutes
  const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const el = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  };

  function niceTicks(min, max, count = 5) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const step0 = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || 10 * mag;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
    return { lo, hi, ticks };
  }

  // axis labels in plant time (IST); a window that is not today or crosses midnight also shows the date
  function timeFmt(from, to) {
    const p = (n) => String(n).padStart(2, "0");
    const span = to - from;
    const day = (t) => MD.istDate(t);
    if (span > 1.5 * 86400) return { w: 96, f: (t) => { const d = MD.istParts(t); return `${p(d.d)}/${p(d.mo)} ${p(d.h)}h`; } };
    const withDate = day(from) !== day(to) || day(to) !== day(Date.now() / 1000);
    if (withDate) return { w: 118, f: (t) => { const d = MD.istParts(t); return `${p(d.d)}/${p(d.mo)} ${p(d.h)}:${p(d.mi)}`; } };
    return { w: 80, f: (t) => { const d = MD.istParts(t); return `${p(d.h)}:${p(d.mi)}`; } };
  }

  // monotone cubic (Fritsch-Carlson): smooth, never overshoots the data
  function smooth(xy) {
    const n = xy.length;
    if (n < 3) return xy.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join("");
    const dx = [], dy = [], m = [], t = [];
    for (let i = 0; i < n - 1; i++) { dx[i] = xy[i + 1][0] - xy[i][0]; dy[i] = xy[i + 1][1] - xy[i][1]; m[i] = dx[i] ? dy[i] / dx[i] : 0; }
    t[0] = m[0]; t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (!m[i]) { t[i] = t[i + 1] = 0; continue; }
      const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
      if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
    }
    let d = `M${xy[0][0]},${xy[0][1]}`;
    for (let i = 0; i < n - 1; i++) {
      const h = dx[i] / 3;
      d += `C${xy[i][0] + h},${xy[i][1] + t[i] * h} ${xy[i + 1][0] - h},${xy[i + 1][1] - t[i + 1] * h} ${xy[i + 1][0]},${xy[i + 1][1]}`;
    }
    return d;
  }

  // Y-axis: automatic from the data, or fixed by the tag's "Trend Y-axis min / max" (either end may be fixed)
  function axisRange(lo, hi, yMin, yMax) {
    const fixLo = yMin != null && yMin !== "" && !isNaN(+yMin), fixHi = yMax != null && yMax !== "" && !isNaN(+yMax);
    if (fixLo) lo = +yMin;
    if (fixHi) hi = +yMax;
    if (hi <= lo) hi = lo + 1;
    const nt = niceTicks(lo, hi);
    if (fixLo) nt.lo = +yMin;
    if (fixHi) nt.hi = +yMax;
    nt.ticks = nt.ticks.filter((v) => v >= nt.lo - 1e-9 && v <= nt.hi + 1e-9);
    // a fixed end (e.g. 201) replaces a round tick closer than 40 % of a step (e.g. 200) - the labels would collide
    const step = nt.ticks.length > 1 ? Math.abs(nt.ticks[1] - nt.ticks[0]) : (nt.hi - nt.lo);
    if (fixLo && !nt.ticks.includes(nt.lo)) { nt.ticks = nt.ticks.filter((v) => Math.abs(v - nt.lo) >= 0.4 * step); nt.ticks.unshift(nt.lo); }
    if (fixHi && !nt.ticks.includes(nt.hi)) { nt.ticks = nt.ticks.filter((v) => Math.abs(v - nt.hi) >= 0.4 * step); nt.ticks.push(nt.hi); }
    nt.fixed = fixLo || fixHi;
    return nt;
  }

  function splitGaps(pts, span) {
    // typical (median) spacing between readings - a gap is a break much longer than that, so a slower log interval
    // than the chart bucket does not chop the line into single dots
    const diffs = pts.slice(1).map((p, i) => p.t - pts[i].t).sort((a, b) => a - b);
    const bucket = diffs.length ? diffs[Math.floor(diffs.length / 2)] : span;
    const segs = [];
    let cur = [];
    pts.forEach((p, i) => {
      if (i && p.t - pts[i - 1].t > bucket * 2.5) { segs.push(cur); cur = []; }
      cur.push(p);
    });
    segs.push(cur);
    return segs.filter((s) => s.length);
  }

  function gradient(svg, color, alpha = 0.28) {
    const id = "mdg" + ++uid;
    const defs = svg.querySelector("defs") || el("defs", {}, svg);
    const g = el("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    el("stop", { offset: "0", style: `stop-color:${color};stop-opacity:${alpha}` }, g);
    el("stop", { offset: "1", style: `stop-color:${color};stop-opacity:0` }, g);
    return `url(#${id})`;
  }
  // plot-area clip (lines that continue past the visible window are cut at the axes) + inner group used for pan preview
  function plotLayer(svg, W, H, m) {
    const id = "mdc" + ++uid;
    const defs = svg.querySelector("defs") || el("defs", {}, svg);
    const cp = el("clipPath", { id }, defs);
    el("rect", { x: m.l, y: 0, width: Math.max(0, W - m.l - m.r), height: H }, cp);
    const outer = el("g", { "clip-path": `url(#${id})` }, svg);
    return el("g", { class: "mdc-pan" }, outer);
  }

  function drawIn(path, delay = 0) {
    if (reduce || !path.getTotalLength) return;
    const len = path.getTotalLength();
    path.style.strokeDasharray = `${len}`;
    path.style.strokeDashoffset = `${len}`;
    const a = path.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
      { duration: 1300, delay, easing: "cubic-bezier(.25,.8,.25,1)", fill: "forwards" });
    a.onfinish = () => { path.style.strokeDasharray = ""; path.style.strokeDashoffset = ""; a.cancel(); };
  }
  function fadeIn(node, delay = 0) {
    if (reduce) return;
    node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 900, delay, easing: "ease-out", fill: "backwards" });
  }

  // points of a sorted list inside [a, b] plus one neighbour on each side (so the line reaches the axes)
  function windowPts(pts, a, b) {
    let i0 = pts.findIndex((p) => p.t >= a);
    if (i0 < 0) i0 = pts.length;
    let i1 = i0;
    while (i1 < pts.length && pts[i1].t <= b) i1++;
    return { drawn: pts.slice(Math.max(0, i0 - 1), Math.min(pts.length, i1 + 1)), vis: pts.slice(i0, i1) };
  }
  const byT = (a, b) => a.t - b.t;

  // =====================================================================================================
  // zoom state: per group key (shared) or per box
  // =====================================================================================================
  const groups = new Map();
  function stateFor(box, o) {
    if (o.zoomGroup) {
      if (!groups.has(o.zoomGroup)) groups.set(o.zoomGroup, { home: null, view: null, members: new Set(), onView: null, timer: 0 });
      return groups.get(o.zoomGroup);
    }
    if (!box._mdz) box._mdz = { home: null, view: null, members: new Set(), onView: null, timer: 0 };
    return box._mdz;
  }
  function lookup(k) {
    if (typeof k === "string") return groups.get(k) || null;
    return (k && (k._mdState || k._mdz)) || null;
  }
  function clampView(st) {
    if (!st.view || !st.home) { st.view = null; return; }
    const [h0, h1] = st.home;
    let [a, b] = st.view;
    const w = Math.min(b - a, h1 - h0);
    if (a < h0) { a = h0; b = a + w; }
    if (b > h1) { b = h1; a = b - w; }
    a = Math.max(a, h0);
    st.view = b - a < MIN_W || b - a >= (h1 - h0) - 1 ? null : [a, b];
  }
  function prep(box, kind, o) {
    const st = stateFor(box, o);
    st.home = [o.from, o.to];
    if (o.resetZoom) st.view = null;
    if (Array.isArray(o.view)) st.view = [o.view[0], o.view[1]];
    clampView(st);
    if (o.onView) st.onView = o.onView;
    for (const b of st.members) if (!b.isConnected) st.members.delete(b);
    st.members.add(box);
    box._mdState = st;
    box._mdKind = kind;
    box._mdOpts = o;
    draw(box);
  }
  function draw(box) {
    const st = box._mdState, o = box._mdOpts;
    const [vf, vt] = st.view || st.home;
    if (box._mdKind === "multi") drawMulti(box, o, vf, vt);
    else if (box._mdKind === "bars") drawBars(box, o, vf, vt);
    else drawLine(box, o, vf, vt);
    o.animate = false;                                 // re-draws after a zoom do not replay the draw-in
  }
  function redraw(st) { for (const b of st.members) { if (b.isConnected) draw(b); else st.members.delete(b); } }
  function setView(st, a, b) {
    const was = st.view ? st.view.join() : "";
    st.view = [a, b];
    clampView(st);
    if ((st.view ? st.view.join() : "") === was) return;
    redraw(st);
    if (st.onView) {
      clearTimeout(st.timer);
      st.timer = setTimeout(() => {
        const [x, y] = st.view || st.home;
        st.onView(x, y, { reset: !st.view });
      }, 250);
    }
  }
  function act(st, cmd, anchor) {
    if (!st || !st.home) return;
    const [h0, h1] = st.home;
    let [a, b] = st.view || st.home;
    const w = b - a;
    if (cmd === "in") {
      const c = anchor ?? (a + b) / 2, nw = Math.max(MIN_W, w / 2), k = (c - a) / (w || 1);
      a = c - nw * k; b = a + nw;
    } else if (cmd === "out") {
      const c = anchor ?? (a + b) / 2, nw = Math.min(h1 - h0, w * 2), k = (c - a) / (w || 1);
      a = c - nw * k; b = a + nw;
    } else if (cmd === "left" || cmd === "right") {
      const d = (cmd === "left" ? -1 : 1) * w * 0.5;
      a += d; b += d;
    } else if (cmd === "reset") { a = h0; b = h1; }
    if (a < h0) { b += h0 - a; a = h0; }
    if (b > h1) { a -= b - h1; b = h1; }
    setView(st, Math.max(a, h0), b);
  }
  function panBy(st, dt) {
    if (!st || !st.view) return;
    const [h0, h1] = st.home;
    let [a, b] = st.view;
    a += dt; b += dt;
    if (a < h0) { b += h0 - a; a = h0; }
    if (b > h1) { a -= b - h1; b = h1; }
    setView(st, a, b);
  }

  // toolbar above the plot: window label + - + < > Full range
  function toolbar(box, o, vf, vt) {
    const st = box._mdState;
    if (o.controls === false) return null;
    const [h0, h1] = st.home;
    const bar = document.createElement("div");
    bar.className = "mdc-bar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Chart zoom");
    const z = !!st.view;
    const lbl = (t) => MD.fmtTime(t, true).slice(0, 16);
    bar.innerHTML = `<span class="mdc-win">${z ? `<b>Zoomed</b> ${lbl(vf)} – ${lbl(vt)} IST` : '<span class="mdc-hint">Drag across the chart to zoom</span>'}</span>
      <span class="mdc-btns">
        <button type="button" data-z="out" title="Zoom out" aria-label="Zoom out"${z ? "" : " disabled"}>−</button>
        <button type="button" data-z="in" title="Zoom in" aria-label="Zoom in"${vt - vf <= MIN_W * 1.01 ? " disabled" : ""}>+</button>
        <button type="button" data-z="left" title="Move left (earlier)" aria-label="Move left"${z && vf > h0 + 1 ? "" : " disabled"}>‹</button>
        <button type="button" data-z="right" title="Move right (later)" aria-label="Move right"${z && vt < h1 - 1 ? "" : " disabled"}>›</button>
        <button type="button" data-z="reset" class="mdc-reset" title="Show the full selected range"${z ? "" : " disabled"}>Full range</button>
      </span>`;
    bar.querySelectorAll("button").forEach((b) => (b.onclick = () => {
      const cmd = b.dataset.z;
      act(st, cmd);
      // keep keyboard focus on the same button of the re-drawn toolbar
      const nb = box.querySelector(`.mdc-bar [data-z="${cmd}"]`);
      if (nb && !nb.disabled) nb.focus(); else { const r = box.querySelector('.mdc-bar [data-z="in"]'); if (r) r.focus(); }
    }));
    box.appendChild(bar);
    return bar;
  }

  // common frame: clears the box, toolbar, svg; wheel handler is attached once per box
  function frame(box, o, vf, vt, defH, label) {
    box.innerHTML = "";
    box.classList.add("mdc");
    const bar = toolbar(box, o, vf, vt);
    const W = box.clientWidth || 600, H = o.height || defH;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": label }, box);
    svg.style.height = H + "px";
    if (!box._mdWheel) {
      box._mdWheel = true;
      let lastW = 0;
      box.addEventListener("wheel", (ev) => {
        const st = box._mdState;
        if (!st || !ev.target.closest || !ev.target.closest("svg")) return;
        const horiz = Math.abs(ev.deltaX) > Math.abs(ev.deltaY);
        if (!ev.ctrlKey && !ev.shiftKey && !horiz) return;          // plain wheel scrolls the page
        ev.preventDefault();
        const now = performance.now();
        if (now - lastW < 90) return;
        lastW = now;
        const [a, b] = st.view || st.home;
        if (ev.ctrlKey) {
          const s = box.querySelector("svg"), r = s.getBoundingClientRect(), mm = box._mdM || { l: 0, r: 0 };
          const Wd = +s.getAttribute("viewBox").split(" ")[2];
          const px = ((ev.clientX - r.left) / r.width) * Wd;
          const t = a + ((px - mm.l) / (Wd - mm.l - mm.r)) * (b - a);
          act(st, ev.deltaY < 0 ? "in" : "out", Math.max(a, Math.min(b, t)));
        } else {
          const d = horiz ? ev.deltaX : ev.deltaY;
          panBy(st, (d > 0 ? 1 : -1) * (b - a) * 0.15);
        }
      }, { passive: false });
    }
    return { W, H, svg, bar };
  }

  function xAxis(svg, x, vf, vt, W, H, m, grid) {
    const span = vt - vf, tf = timeFmt(vf, vt);
    const nx = Math.max(2, Math.min(8, Math.floor((W - m.l) / tf.w)));
    for (let i = 0; i <= nx; i++) {
      const t = vf + (span * i) / nx;
      if (grid) el("line", { x1: x(t), x2: x(t), y1: m.t, y2: H - m.b, class: "gridline" }, svg);
      const tx = el("text", { x: x(t), y: H - 8, "text-anchor": i === 0 ? "start" : i === nx ? "end" : "middle", class: "tick" }, svg);
      tx.textContent = tf.f(t);
    }
  }
  function limitTags(svg, limits, nt, y, W, m) {
    (limits || []).filter((l) => l.v >= nt.lo && l.v <= nt.hi).forEach((l) => {
      el("line", { x1: m.l, x2: W - m.r, y1: y(l.v), y2: y(l.v), class: "limit" }, svg);
      const lab = el("g", { class: "limit-tag" }, svg);
      const tx = el("text", { x: W - m.r - 8, y: y(l.v) - 8, "text-anchor": "end" }, lab);
      tx.textContent = l.label;
      const w = tx.getComputedTextLength ? tx.getComputedTextLength() + 12 : 60;
      el("rect", { x: W - m.r - w - 2, y: y(l.v) - 22, width: w, height: 18, rx: 4 }, lab).after(tx);
    });
  }
  function tipTop(bar) { return ((bar && bar.offsetHeight) || 0) + 12 + "px"; }
  const placeTip = (tip, bx, rw, right) => {
    tip.style.left = (bx > rw * (right ?? 0.6) ? Math.max(4, bx - tip.offsetWidth - 14) : Math.max(4, Math.min(rw - tip.offsetWidth - 4, bx + 14))) + "px";
  };
  function emptyMsg(svg, W, H, txt) {
    const t = el("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "tick" }, svg);
    t.textContent = txt;
  }

  // =====================================================================================================
  // single series
  // =====================================================================================================
  function render(box, s) { prep(box, "line", s); }
  function drawLine(box, s, vf, vt) {
    const m = { l: 56, r: 16, t: 14, b: 28 };
    box._mdM = m;
    const { W, H, svg, bar } = frame(box, s, vf, vt, 220, `${s.name} trend`);
    const all = (s.points || []).filter((p) => p.avg !== null && p.avg !== undefined).sort(byT);
    const { drawn, vis } = windowPts(all, vf, vt);
    if (!drawn.length) { emptyMsg(svg, W, H, all.length ? "No data in this part of the range - zoom out or move" : "No data in this time range yet"); return; }
    const sc = vis.length ? vis : drawn;
    let lo = Math.min(...sc.map((p) => p.min ?? p.avg));
    let hi = Math.max(...sc.map((p) => p.max ?? p.avg));
    (s.limits || []).forEach((l) => { lo = Math.min(lo, l.v); hi = Math.max(hi, l.v); });
    const nt = s.isBool ? { lo: 0, hi: 1, ticks: [0, 1] } : axisRange(lo, hi, s.yMin, s.yMax);
    const x = (t) => m.l + ((t - vf) / (vt - vf)) * (W - m.l - m.r);
    const y = (v) => Math.min(H - m.b, Math.max(m.t, H - m.b - ((v - nt.lo) / (nt.hi - nt.lo || 1)) * (H - m.t - m.b)));

    // alarm zone above the first (set point) limit
    const sp = (s.limits || []).filter((l) => l.v >= nt.lo && l.v <= nt.hi)[0];
    if (sp && !s.isBool && y(sp.v) > m.t) el("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: y(sp.v) - m.t, class: "zone" }, svg);
    nt.ticks.forEach((v) => {
      el("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: "gridline" }, svg);
      const tx = el("text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end", class: "tick" }, svg);
      tx.textContent = s.isBool ? (v ? "ON" : "OFF") : v.toLocaleString(undefined, { maximumFractionDigits: 3 });
    });
    el("line", { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: "axis" }, svg);
    const span = vt - vf;
    xAxis(svg, x, vf, vt, W, H, m, false);

    const layer = plotLayer(svg, W, H, m);
    const fill = gradient(svg, s.color, s.isBool ? 0.18 : 0.3);
    const lines = [];
    splitGaps(drawn, span).forEach((seg) => {
      const xy = seg.map((p) => [x(p.t), y(p.avg)]);
      let d;
      if (s.isBool) {
        d = "";
        seg.forEach((p, i) => { if (i) d += `H${x(p.t)}`; d += `${i ? "L" : "M"}${x(p.t)},${y(p.avg)}`; });
      } else {
        if (seg.length > 1) {
          const top = seg.map((p) => `${x(p.t)},${y(p.max ?? p.avg)}`);
          const bot = seg.slice().reverse().map((p) => `${x(p.t)},${y(p.min ?? p.avg)}`);
          el("polygon", { points: top.concat(bot).join(" "), class: "band", fill: s.color }, layer);
        }
        d = smooth(xy);
      }
      if (seg.length > 1) {
        const area = el("path", { d: `${d}L${xy.at(-1)[0]},${H - m.b}L${xy[0][0]},${H - m.b}Z`, fill, class: "area" }, layer);
        if (s.animate) fadeIn(area, 300);
      } else el("circle", { cx: xy[0][0], cy: xy[0][1], r: 3, fill: s.color }, layer);
      lines.push(el("path", { d, class: "line", stroke: s.color }, layer));
    });
    if (s.animate) lines.forEach((p) => drawIn(p));

    limitTags(svg, s.limits, nt, y, W, m);

    // latest value: pulsing dot (only when the newest reading is at the right edge of the visible window)
    const last = all.at(-1);
    if (last.t <= vt + 1 && vt - last.t < span * 0.08) {
      el("circle", { cx: x(last.t), cy: y(last.avg), r: 9, fill: s.color, class: "pulse" }, layer);
      el("circle", { cx: x(last.t), cy: y(last.avg), r: 4, fill: s.color, stroke: "#fff", "stroke-width": 2 }, layer);
    }

    // hover layer (only the points inside the visible window)
    const hov = vis.length ? vis : drawn;
    const cross = el("line", { y1: m.t, y2: H - m.b, class: "cross", visibility: "hidden" }, svg);
    const dot = el("circle", { r: 5, fill: s.color, stroke: "var(--surface, #fff)", "stroke-width": 2, visibility: "hidden" }, svg);
    const tip = document.createElement("div");
    tip.className = "tip";
    tip.hidden = true;
    box.appendChild(tip);
    const hit = el("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent" }, svg);
    const fmt = (v) => s.isBool ? (v >= 0.5 ? "ON" : "OFF") + (v > 0 && v < 1 ? ` (${Math.round(v * 100)}% on)` : "")
      : Number(v).toLocaleString(undefined, { minimumFractionDigits: s.decimals ?? 1, maximumFractionDigits: s.decimals ?? 1 });
    function move(ev) {
      if (box._mdDrag) return;
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      let best = hov[0];
      for (const p of hov) if (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
      cross.setAttribute("x1", x(best.t)); cross.setAttribute("x2", x(best.t));
      dot.setAttribute("cx", x(best.t)); dot.setAttribute("cy", y(best.avg));
      cross.setAttribute("visibility", "visible"); dot.setAttribute("visibility", "visible");
      tip.innerHTML = `<div class="muted">${MD.fmtTime(best.t, true)} IST</div><b>${fmt(best.avg)} ${MD.esc(s.unit || "")}</b>` +
        (!s.isBool && best.min != null && best.min !== best.max ? `<div class="muted">min ${fmt(best.min)} / max ${fmt(best.max)}</div>` : "") +
        (sp && !s.isBool && best.avg >= sp.v ? '<div><span class="q BAD">ABOVE SET POINT</span></div>' : "") +
        (best.sim ? '<div><span class="q SIMULATED">DEMO DATA</span></div>' : "") +
        (best.bad ? '<div><span class="q BAD">INCOMPLETE DATA</span></div>' : "");
      tip.hidden = false;
      placeTip(tip, (x(best.t) / W) * r.width, r.width);
      tip.style.top = tipTop(bar);
    }
    const hide = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerleave", hide);
    attachZoom(box, svg, hit, W, H, m, vf, vt, s.onZoom, hide);
  }

  // drag across a chart = zoom into that window (minimum 2 minutes); Shift + drag = pan (preview while dragging)
  function attachZoom(box, svg, hit, W, H, m, from, to, onZoom, hideHover) {
    const st = box._mdState;
    const sel = el("rect", { y: m.t, height: H - m.t - m.b, class: "zoom-sel", visibility: "hidden" }, svg);
    const pan = svg.querySelector(".mdc-pan");
    const scale = () => { const r = svg.getBoundingClientRect(); return r.width ? W / r.width : 1; };
    const toX = (ev) => { const r = svg.getBoundingClientRect(); return Math.max(m.l, Math.min(W - m.r, ((ev.clientX - r.left) / r.width) * W)); };
    const toT = (px) => from + ((px - m.l) / (W - m.l - m.r)) * (to - from);
    let x0 = null, mode = null, cx0 = 0;
    hit.style.cursor = "crosshair";
    hit.style.touchAction = "pan-y";
    hit.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      mode = ev.shiftKey && st.view ? "pan" : "zoom";
      x0 = toX(ev); cx0 = ev.clientX;
      box._mdDrag = true;
      if (hideHover) hideHover();
      if (mode === "pan") hit.style.cursor = "grabbing";
      try { hit.setPointerCapture(ev.pointerId); } catch (_) { /* ignore */ }
    });
    hit.addEventListener("pointermove", (ev) => {
      if (x0 == null) return;
      if (mode === "pan") { if (pan) pan.setAttribute("transform", `translate(${(ev.clientX - cx0) * scale()},0)`); return; }
      const x1 = toX(ev);
      sel.setAttribute("x", Math.min(x0, x1)); sel.setAttribute("width", Math.abs(x1 - x0)); sel.setAttribute("visibility", "visible");
    });
    const end = (ev, cancel) => {
      if (x0 == null) return;
      const m0 = mode, sx = x0;
      x0 = null; mode = null; box._mdDrag = false;
      sel.setAttribute("visibility", "hidden");
      if (cancel) { if (pan) pan.removeAttribute("transform"); return; }
      if (m0 === "pan") {
        const dpx = (ev.clientX - cx0) * scale();
        if (Math.abs(dpx) < 2) { if (pan) pan.removeAttribute("transform"); return; }
        panBy(st, -(dpx / (W - m.l - m.r)) * (to - from));
        return;
      }
      const x1 = toX(ev), a = toT(Math.min(sx, x1)), b = toT(Math.max(sx, x1));
      if (b - a >= MIN_W && Math.abs(x1 - sx) > 4) {
        setView(st, a, b);
        if (onZoom) onZoom(a, b);
      }
    };
    hit.addEventListener("pointerup", (ev) => end(ev, false));
    hit.addEventListener("pointercancel", (ev) => end(ev, true));
  }

  // =====================================================================================================
  // several series, one unit
  // =====================================================================================================
  function renderMulti(box, o) { prep(box, "multi", o); }
  function drawMulti(box, o, vf, vt) {
    const m = { l: 52, r: 14, t: 12, b: 28 };
    box._mdM = m;
    const { W, H, svg, bar } = frame(box, o, vf, vt, 250, "Process trend");
    const series = o.series.map((s) => {
      const all = (s.points || []).filter((p) => p.avg != null).sort(byT);
      return { s, all, ...windowPts(all, vf, vt) };
    });
    const vis = series.filter((x) => !x.s.hidden);
    const scPts = vis.flatMap((x) => (x.vis.length ? x.vis : x.drawn));
    if (!scPts.length) {
      emptyMsg(svg, W, H, !vis.length ? "All values hidden - click a value above to show it"
        : vis.some((x) => x.all.length) ? "No data in this part of the range - zoom out or move" : "Collecting data…");
      return;
    }
    let lo = Math.min(...scPts.map((p) => p.avg)), hi = Math.max(...scPts.map((p) => p.avg));
    (o.limits || []).forEach((l) => { lo = Math.min(lo, l.v); hi = Math.max(hi, l.v); });
    const nt = axisRange(lo, hi, o.yMin, o.yMax);
    const x = (t) => m.l + ((t - vf) / (vt - vf)) * (W - m.l - m.r);
    const y = (v) => Math.min(H - m.b, Math.max(m.t, H - m.b - ((v - nt.lo) / (nt.hi - nt.lo || 1)) * (H - m.t - m.b)));
    nt.ticks.forEach((v) => {
      el("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: "gridline" }, svg);
      const tx = el("text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end", class: "tick" }, svg);
      tx.textContent = v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    });
    const span = vt - vf;
    xAxis(svg, x, vf, vt, W, H, m, true);
    (o.limits || []).filter((l) => l.v >= nt.lo && l.v <= nt.hi).forEach((l) => {
      if (y(l.v) > m.t) el("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: y(l.v) - m.t, class: "zone" }, svg);
    });
    limitTags(svg, o.limits, nt, y, W, m);
    const layer = plotLayer(svg, W, H, m);
    series.forEach(({ s, all, drawn, vis: inWin }, si) => {
      if (!drawn.length || s.hidden) return;
      const g = el("g", { "data-i": si, class: "series" }, layer);
      splitGaps(drawn, span).forEach((seg) => {
        const xy = seg.map((p) => [x(p.t), y(p.avg)]);
        const d = smooth(xy);
        if (o.area && seg.length > 1) {
          const a = el("path", { d: `${d}L${xy.at(-1)[0]},${H - m.b}L${xy[0][0]},${H - m.b}Z`, fill: gradient(svg, s.color, 0.12), class: "area" }, g);
          if (o.animate) fadeIn(a, 300 + si * 120);
        }
        const p = el("path", { d, class: "line", stroke: s.color }, g);
        if (o.animate) drawIn(p, si * 120);
      });
      const step = Math.max(1, Math.round(inWin.length / 24));
      inWin.forEach((p, i) => {
        if (i % step === 0) {
          const c = el("circle", { cx: x(p.t), cy: y(p.avg), r: 2.6, fill: s.color }, g);
          if (o.animate) fadeIn(c, 900 + si * 120);
        }
      });
      const last = all.at(-1);
      if (last.t <= vt + 1 && vt - last.t < span * 0.08) {
        el("circle", { cx: x(last.t), cy: y(last.avg), r: 8, fill: s.color, class: "pulse" }, g);
        el("circle", { cx: x(last.t), cy: y(last.avg), r: 3.6, fill: s.color, stroke: "#fff", "stroke-width": 1.6 }, g);
      }
    });
    const cross = el("line", { y1: m.t, y2: H - m.b, class: "cross", visibility: "hidden" }, svg);
    const dots = series.map(({ s }) => el("circle", { r: 4.5, fill: s.color, stroke: "var(--surface, #fff)", "stroke-width": 2, visibility: "hidden" }, svg));
    const tip = document.createElement("div");
    tip.className = "tip";
    tip.hidden = true;
    box.appendChild(tip);
    const hit = el("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent" }, svg);
    const hovOf = (x0) => (x0.vis.length ? x0.vis : x0.drawn);
    const ref = vis.reduce((a, x0) => (hovOf(x0).length > hovOf(a).length ? x0 : a), vis[0]);
    const refPts = hovOf(ref);
    const hide = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); };
    hit.addEventListener("pointermove", (ev) => {
      if (box._mdDrag || !refPts.length) return;
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      let best = refPts[0];
      for (const p of refPts) if (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
      cross.setAttribute("x1", x(best.t)); cross.setAttribute("x2", x(best.t)); cross.setAttribute("visibility", "visible");
      let rows = "";
      series.forEach((x0, i) => {
        if (x0.s.hidden) { dots[i].setAttribute("visibility", "hidden"); return; }
        let p = null;
        for (const q of hovOf(x0)) if (!p || Math.abs(q.t - best.t) < Math.abs(p.t - best.t)) p = q;
        if (p && Math.abs(p.t - best.t) < span / 50) {
          dots[i].setAttribute("cx", x(p.t)); dots[i].setAttribute("cy", y(p.avg)); dots[i].setAttribute("visibility", "visible");
          rows += `<div><i style="background:${x0.s.color}"></i>${MD.esc(x0.s.name)}: <b>${Number(p.avg).toFixed(o.decimals ?? 1)}</b> ${MD.esc(o.unit || "")}</div>`;
        } else dots[i].setAttribute("visibility", "hidden");
      });
      // past days / long ranges: show the date too, not only the time
      const stamp = `${MD.fmtTime(best.t, span > 20 * 3600 || Date.now() - best.t * 1000 > 20 * 3600 * 1000)} IST`;
      tip.innerHTML = `<div class="muted">${stamp}</div>${rows}` +
        (best.sim ? '<div><span class="q SIMULATED">DEMO DATA</span></div>' : "");
      tip.hidden = false;
      placeTip(tip, (x(best.t) / W) * r.width, r.width, 0.5);
      tip.style.top = tipTop(bar);
    });
    hit.addEventListener("pointerleave", hide);
    attachZoom(box, svg, hit, W, H, m, vf, vt, o.onZoom, hide);
  }

  // =====================================================================================================
  // bars over time
  // =====================================================================================================
  function renderBars(box, o) { prep(box, "bars", o); }
  function drawBars(box, o, vf, vt) {
    const m = { l: 56, r: 16, t: 14, b: 28 };
    box._mdM = m;
    const { W, H, svg, bar } = frame(box, o, vf, vt, 220, `${o.name || "Values"} bar chart`);
    const all = (o.bars || []).filter((b) => b.v != null && !isNaN(b.v)).sort(byT);
    const diffs = all.slice(1).map((b, i) => b.t - all[i].t).sort((a, b) => a - b);
    const bw0 = diffs.length ? diffs[Math.floor(diffs.length / 2)] : (o.to - o.from) / 24;
    const wOf = (b) => b.w || bw0;
    const vis = all.filter((b) => b.t + wOf(b) / 2 >= vf && b.t - wOf(b) / 2 <= vt);
    if (!vis.length) { emptyMsg(svg, W, H, all.length ? "No data in this part of the range - zoom out or move" : "No data in this time range yet"); return; }
    let lo = Math.min(0, ...vis.map((b) => b.v)), hi = Math.max(0, ...vis.map((b) => b.v));
    (o.limits || []).forEach((l) => { lo = Math.min(lo, l.v); hi = Math.max(hi, l.v); });
    const nt = axisRange(lo, hi, o.yMin, o.yMax);
    const x = (t) => m.l + ((t - vf) / (vt - vf)) * (W - m.l - m.r);
    const y = (v) => Math.min(H - m.b, Math.max(m.t, H - m.b - ((v - nt.lo) / (nt.hi - nt.lo || 1)) * (H - m.t - m.b)));
    nt.ticks.forEach((v) => {
      el("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: "gridline" }, svg);
      const tx = el("text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end", class: "tick" }, svg);
      tx.textContent = v.toLocaleString(undefined, { maximumFractionDigits: 3 });
    });
    el("line", { x1: m.l, x2: W - m.r, y1: y(Math.max(nt.lo, 0)), y2: y(Math.max(nt.lo, 0)), class: "axis" }, svg);
    xAxis(svg, x, vf, vt, W, H, m, false);
    const layer = plotLayer(svg, W, H, m);
    const y0 = y(Math.max(nt.lo, Math.min(nt.hi, 0)));
    const rects = vis.map((b, i) => {
      const pxw = Math.max(2, (wOf(b) / (vt - vf)) * (W - m.l - m.r) * 0.78);
      const r = el("rect", { x: x(b.t) - pxw / 2, y: Math.min(y0, y(b.v)), width: pxw, height: Math.max(1, Math.abs(y(b.v) - y0)), rx: Math.min(3, pxw / 4),
        fill: b.color || o.color || "var(--s1)", class: "mdc-barr" }, layer);
      if (o.animate) fadeIn(r, i * 20);
      return r;
    });
    limitTags(svg, o.limits, nt, y, W, m);
    const tip = document.createElement("div");
    tip.className = "tip";
    tip.hidden = true;
    box.appendChild(tip);
    const hit = el("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent" }, svg);
    const fmt = (v) => Number(v).toLocaleString(undefined, { minimumFractionDigits: o.decimals ?? 1, maximumFractionDigits: o.decimals ?? 1 });
    const hide = () => { tip.hidden = true; rects.forEach((r) => r.classList.remove("hl")); };
    hit.addEventListener("pointermove", (ev) => {
      if (box._mdDrag) return;
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      let bi = 0;
      vis.forEach((b, i) => { if (Math.abs(x(b.t) - px) < Math.abs(x(vis[bi].t) - px)) bi = i; });
      const b = vis[bi];
      rects.forEach((rc, i) => rc.classList.toggle("hl", i === bi));
      const half = wOf(b) / 2;
      tip.innerHTML = `<div class="muted">${b.label ? MD.esc(b.label) : `${MD.fmtTime(b.t - half, true).slice(0, 16)} – ${MD.fmtTime(b.t + half, true).slice(11, 16)} IST`}</div>
        <b>${fmt(b.v)} ${MD.esc(o.unit || "")}</b>`;
      tip.hidden = false;
      placeTip(tip, (x(b.t) / W) * r.width, r.width);
      tip.style.top = tipTop(bar);
    });
    hit.addEventListener("pointerleave", hide);
    attachZoom(box, svg, hit, W, H, m, vf, vt, o.onZoom, hide);
  }

  // =====================================================================================================
  function resetZoom(k) {
    const st = lookup(k);
    if (st) { st.view = null; clearTimeout(st.timer); }
  }
  function getView(k) { const st = lookup(k); return st && st.view ? st.view.slice() : null; }
  function zoom(k, cmd) { act(lookup(k), cmd); }

  return { render, renderMulti, renderBars, resetZoom, getView, zoom };
})();
