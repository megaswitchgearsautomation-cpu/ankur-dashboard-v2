/* SVG charts: one series per chart (small multiples - never a dual axis) or several series that share one unit.
   Smooth (monotone) curves, gradient area, min/max band, alarm set point line + shaded alarm zone,
   draw-in animation, pulsing latest point, crosshair + tooltip. */
const MDChart = (() => {
  const NS = "http://www.w3.org/2000/svg";
  let uid = 0;
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

  function timeLabel(t, span) {
    const d = new Date(t * 1000);
    const p = (n) => String(n).padStart(2, "0");
    if (span > 2 * 86400) return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}h`;
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
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
    if (fixLo && !nt.ticks.includes(nt.lo)) nt.ticks.unshift(nt.lo);
    if (fixHi && !nt.ticks.includes(nt.hi)) nt.ticks.push(nt.hi);
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
    return segs;
  }

  function gradient(svg, color, alpha = 0.28) {
    const id = "mdg" + ++uid;
    const defs = svg.querySelector("defs") || el("defs", {}, svg);
    const g = el("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    el("stop", { offset: "0", style: `stop-color:${color};stop-opacity:${alpha}` }, g);
    el("stop", { offset: "1", style: `stop-color:${color};stop-opacity:0` }, g);
    return `url(#${id})`;
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

  /**
   * render(container, {name, unit, decimals, color, points:[{t,avg,min,max,sim,bad}], from, to,
   *                     isBool, limits:[{v,label}], height, animate})
   */
  function render(box, s) {
    box.innerHTML = "";
    const W = box.clientWidth || 600, H = s.height || 220;
    const m = { l: 52, r: 16, t: 14, b: 26 };
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${s.name} trend` }, box);
    svg.style.height = H + "px";
    const pts = s.points.filter((p) => p.avg !== null && p.avg !== undefined);
    if (!pts.length) {
      const t = el("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "tick" }, svg);
      t.textContent = "No data in this time range yet";
      return;
    }
    let lo = Math.min(...pts.map((p) => p.min ?? p.avg));
    let hi = Math.max(...pts.map((p) => p.max ?? p.avg));
    (s.limits || []).forEach((l) => { lo = Math.min(lo, l.v); hi = Math.max(hi, l.v); });
    if (s.isBool) { lo = 0; hi = 1; }
    const nt = s.isBool ? { lo: 0, hi: 1, ticks: [0, 1] } : axisRange(lo, hi, s.yMin, s.yMax);
    const x = (t) => m.l + ((t - s.from) / (s.to - s.from)) * (W - m.l - m.r);
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
    const span = s.to - s.from;
    const nx = Math.max(2, Math.min(7, Math.floor((W - m.l) / 90)));
    for (let i = 0; i <= nx; i++) {
      const t = s.from + (span * i) / nx;
      const tx = el("text", { x: x(t), y: H - 8, "text-anchor": i === 0 ? "start" : i === nx ? "end" : "middle", class: "tick" }, svg);
      tx.textContent = timeLabel(t, span);
    }

    const fill = gradient(svg, s.color, s.isBool ? 0.18 : 0.3);
    const lines = [];
    splitGaps(pts, span).forEach((seg) => {
      const xy = seg.map((p) => [x(p.t), y(p.avg)]);
      let d;
      if (s.isBool) {
        d = "";
        seg.forEach((p, i) => { if (i) d += `H${x(p.t)}`; d += `${i ? "L" : "M"}${x(p.t)},${y(p.avg)}`; });
      } else {
        if (seg.length > 1) {
          const top = seg.map((p) => `${x(p.t)},${y(p.max ?? p.avg)}`);
          const bot = seg.slice().reverse().map((p) => `${x(p.t)},${y(p.min ?? p.avg)}`);
          el("polygon", { points: top.concat(bot).join(" "), class: "band", fill: s.color }, svg);
        }
        d = smooth(xy);
      }
      if (seg.length > 1) {
        const area = el("path", { d: `${d}L${xy.at(-1)[0]},${H - m.b}L${xy[0][0]},${H - m.b}Z`, fill, class: "area" }, svg);
        if (s.animate) fadeIn(area, 300);
      }
      lines.push(el("path", { d, class: "line", stroke: s.color }, svg));
    });
    if (s.animate) lines.forEach((p) => drawIn(p));

    (s.limits || []).filter((l) => l.v >= nt.lo && l.v <= nt.hi).forEach((l) => {
      el("line", { x1: m.l, x2: W - m.r, y1: y(l.v), y2: y(l.v), class: "limit" }, svg);
      const lab = el("g", { class: "limit-tag" }, svg);
      const tx = el("text", { x: W - m.r - 8, y: y(l.v) - 7, "text-anchor": "end" }, lab);
      tx.textContent = l.label;
      const w = tx.getComputedTextLength ? tx.getComputedTextLength() + 12 : 60;
      el("rect", { x: W - m.r - w - 2, y: y(l.v) - 19, width: w, height: 15, rx: 4 }, lab).after(tx);
    });

    // latest value: pulsing dot
    const last = pts.at(-1);
    if (s.to - last.t < span * 0.08) {
      el("circle", { cx: x(last.t), cy: y(last.avg), r: 9, fill: s.color, class: "pulse" }, svg);
      el("circle", { cx: x(last.t), cy: y(last.avg), r: 4, fill: s.color, stroke: "#fff", "stroke-width": 2 }, svg);
    }

    // hover layer
    const cross = el("line", { y1: m.t, y2: H - m.b, class: "cross", visibility: "hidden" }, svg);
    const dot = el("circle", { r: 5, fill: s.color, stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" }, svg);
    const tip = document.createElement("div");
    tip.className = "tip";
    tip.hidden = true;
    box.appendChild(tip);
    const hit = el("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent" }, svg);
    const fmt = (v) => s.isBool ? (v >= 0.5 ? "ON" : "OFF") + (v > 0 && v < 1 ? ` (${Math.round(v * 100)}% on)` : "")
      : Number(v).toLocaleString(undefined, { minimumFractionDigits: s.decimals ?? 1, maximumFractionDigits: s.decimals ?? 1 });
    function move(ev) {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      let best = pts[0];
      for (const p of pts) if (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
      cross.setAttribute("x1", x(best.t)); cross.setAttribute("x2", x(best.t));
      dot.setAttribute("cx", x(best.t)); dot.setAttribute("cy", y(best.avg));
      cross.setAttribute("visibility", "visible"); dot.setAttribute("visibility", "visible");
      const d = new Date(best.t * 1000);
      tip.innerHTML = `<div class="muted">${d.toLocaleString()}</div><b>${fmt(best.avg)} ${MD.esc(s.unit || "")}</b>` +
        (!s.isBool && best.min !== best.max ? `<div class="muted">min ${fmt(best.min)} / max ${fmt(best.max)}</div>` : "") +
        (sp && !s.isBool && best.avg >= sp.v ? '<div><span class="q BAD">ABOVE SET POINT</span></div>' : "") +
        (best.sim ? '<div><span class="q SIMULATED">DEMO DATA</span></div>' : "") +
        (best.bad ? '<div><span class="q BAD">INCOMPLETE DATA</span></div>' : "");
      tip.hidden = false;
      const bx = (x(best.t) / W) * r.width;
      tip.style.left = (bx > r.width * 0.6 ? Math.max(4, bx - tip.offsetWidth - 14) : Math.min(r.width - tip.offsetWidth - 4, bx + 14)) + "px";
      tip.style.top = "26px";
    }
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerleave", () => {
      tip.hidden = true; cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden");
    });
  }

  /**
   * renderMulti(container, {unit, decimals, from, to, height, animate, series:[{name, color, points}]})
   * Several series that share ONE unit on one axis (e.g. all temperatures in °C).
   */
  function renderMulti(box, o) {
    box.innerHTML = "";
    const W = box.clientWidth || 700, H = o.height || 250;
    const m = { l: 48, r: 14, t: 12, b: 26 };
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Process trend" }, box);
    svg.style.height = H + "px";
    const vis = o.series.filter((s) => !s.hidden);
    const all = vis.flatMap((s) => s.points.filter((p) => p.avg != null));
    if (!all.length) {
      const t = el("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "tick" }, svg);
      t.textContent = vis.length ? "Collecting data…" : "All values hidden - click a value above to show it";
      return;
    }
    let lo = Math.min(...all.map((p) => p.avg)), hi = Math.max(...all.map((p) => p.avg));
    (o.limits || []).forEach((l) => { lo = Math.min(lo, l.v); hi = Math.max(hi, l.v); });
    const nt = axisRange(lo, hi, o.yMin, o.yMax);
    const x = (t) => m.l + ((t - o.from) / (o.to - o.from)) * (W - m.l - m.r);
    const y = (v) => Math.min(H - m.b, Math.max(m.t, H - m.b - ((v - nt.lo) / (nt.hi - nt.lo || 1)) * (H - m.t - m.b)));
    nt.ticks.forEach((v) => {
      el("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: "gridline" }, svg);
      const tx = el("text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end", class: "tick" }, svg);
      tx.textContent = v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    });
    const span = o.to - o.from;
    const nx = Math.max(2, Math.min(8, Math.floor((W - m.l) / 80)));
    for (let i = 0; i <= nx; i++) {
      const t = o.from + (span * i) / nx;
      el("line", { x1: x(t), x2: x(t), y1: m.t, y2: H - m.b, class: "gridline" }, svg);
      const tx = el("text", { x: x(t), y: H - 8, "text-anchor": i === 0 ? "start" : i === nx ? "end" : "middle", class: "tick" }, svg);
      tx.textContent = timeLabel(t, span);
    }
    (o.limits || []).filter((l) => l.v >= nt.lo && l.v <= nt.hi).forEach((l) => {
      if (y(l.v) > m.t) el("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: y(l.v) - m.t, class: "zone" }, svg);
      el("line", { x1: m.l, x2: W - m.r, y1: y(l.v), y2: y(l.v), class: "limit" }, svg);
      const lab = el("g", { class: "limit-tag" }, svg);
      const tx = el("text", { x: W - m.r - 8, y: y(l.v) - 7, "text-anchor": "end" }, lab);
      tx.textContent = l.label;
      const w = tx.getComputedTextLength ? tx.getComputedTextLength() + 12 : 60;
      el("rect", { x: W - m.r - w - 2, y: y(l.v) - 19, width: w, height: 15, rx: 4 }, lab).after(tx);
    });
    o.series.forEach((s, si) => {
      const pts = s.points.filter((p) => p.avg != null);
      if (!pts.length || s.hidden) return;
      const g = el("g", { "data-i": si, class: "series" }, svg);
      splitGaps(pts, span).forEach((seg) => {
        const xy = seg.map((p) => [x(p.t), y(p.avg)]);
        const d = smooth(xy);
        if (o.area && seg.length > 1) {
          const a = el("path", { d: `${d}L${xy.at(-1)[0]},${H - m.b}L${xy[0][0]},${H - m.b}Z`, fill: gradient(svg, s.color, 0.12), class: "area" }, g);
          if (o.animate) fadeIn(a, 300 + si * 120);
        }
        const p = el("path", { d, class: "line", stroke: s.color }, g);
        if (o.animate) drawIn(p, si * 120);
      });
      const step = Math.max(1, Math.round(pts.length / 24));
      pts.forEach((p, i) => {
        if (i % step === 0) {
          const c = el("circle", { cx: x(p.t), cy: y(p.avg), r: 2.6, fill: s.color }, g);
          if (o.animate) fadeIn(c, 900 + si * 120);
        }
      });
      const last = pts.at(-1);
      if (o.to - last.t < span * 0.08) {
        el("circle", { cx: x(last.t), cy: y(last.avg), r: 8, fill: s.color, class: "pulse" }, g);
        el("circle", { cx: x(last.t), cy: y(last.avg), r: 3.6, fill: s.color, stroke: "#fff", "stroke-width": 1.6 }, g);
      }
    });
    const cross = el("line", { y1: m.t, y2: H - m.b, class: "cross", visibility: "hidden" }, svg);
    const dots = o.series.map((s) => el("circle", { r: 4.5, fill: s.color, stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" }, svg));
    const tip = document.createElement("div");
    tip.className = "tip";
    tip.hidden = true;
    box.appendChild(tip);
    const hit = el("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent" }, svg);
    const ref = vis.reduce((a, s) => (s.points.length > a.points.length ? s : a), vis[0]);
    hit.addEventListener("pointermove", (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      let best = ref.points[0];
      for (const p of ref.points) if (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
      cross.setAttribute("x1", x(best.t)); cross.setAttribute("x2", x(best.t)); cross.setAttribute("visibility", "visible");
      let rows = "";
      o.series.forEach((s, i) => {
        if (s.hidden) { dots[i].setAttribute("visibility", "hidden"); return; }
        let p = null;
        for (const q of s.points) if (q.avg != null && (!p || Math.abs(q.t - best.t) < Math.abs(p.t - best.t))) p = q;
        if (p && Math.abs(p.t - best.t) < span / 50) {
          dots[i].setAttribute("cx", x(p.t)); dots[i].setAttribute("cy", y(p.avg)); dots[i].setAttribute("visibility", "visible");
          rows += `<div><i style="background:${s.color}"></i>${MD.esc(s.name)}: <b>${Number(p.avg).toFixed(o.decimals ?? 1)}</b> ${MD.esc(o.unit || "")}</div>`;
        } else dots[i].setAttribute("visibility", "hidden");
      });
      tip.innerHTML = `<div class="muted">${new Date(best.t * 1000).toLocaleTimeString()}</div>${rows}` +
        (best.sim ? '<div><span class="q SIMULATED">DEMO DATA</span></div>' : "");
      tip.hidden = false;
      const bx = (x(best.t) / W) * r.width;
      tip.style.left = (bx > r.width / 2 ? bx - tip.offsetWidth - 14 : bx + 14) + "px";
      tip.style.top = "16px";
    });
    hit.addEventListener("pointerleave", () => {
      tip.hidden = true; cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden"));
    });
  }

  return { render, renderMulti };
})();
