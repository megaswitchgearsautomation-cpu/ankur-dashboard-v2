/* 3D plant (Mimic tab "3D plant") - real 3D with three.js r160 (vendor/three, MIT licence, works offline).
   Indicative layout following the client P&ID areas (not to scale). Live data from /api/live:
   - machines: motor colour + status lamp = state (green running, grey stopped, red blinking tripped), AUTO / MAN label
   - fans turn and the sludge-tank agitator stirs while running; pipes show moving flow dots only while an IO-list pump
     on that line runs; package equipment (no signal to the panel) is drawn faded and never animated
   - tanks fill to LT-01 / LT-02 (float-switch tanks: indicative fill), transmitters show their live value,
     float switches light up when ON
   Mouse: left-drag rotate, wheel zoom, right-drag move, click a machine for details. */
import * as THREE from "three";
import { OrbitControls } from "three/addons/OrbitControls.js";

const W2 = (x, y, z = 0) => new THREE.Vector3(x, z, -y);          // plan coords (x east, y north, z up) -> three.js
const C = {
  run: 0x46a414, stop: 0x9a9c94, trip: 0xd93a3f, warn: 0xe09a12, unk: 0xd9d9d2,
  steel: 0xb9c0c6, steelDk: 0x7d848a, concrete: 0xcfd1c8, pad: 0xdfe2d6, ground: 0xe7ebdf,
  water: 0x3f8fd8, sludge: 0x8f6420, chem: 0x8e44c9, hot: 0xe8731a, pkg: 0xcfc8b8, tower: 0xa9b8b2,
};
const FLUID = { water: C.water, sludge: C.sludge, chem: C.chem, hot: C.hot };

// ------------------------------------------------------------------ plant layout (metres)
const AREAS = [
  { x: -27, y: -2, w: 27, d: 24, name: "Sludge & filtrate · volute press" },
  { x: 2, y: 9, w: 17, d: 15, name: "Raw water" },
  { x: 17, y: -7, w: 23, d: 15, name: "Cooling towers" },
  { x: 21, y: 9, w: 21, d: 15, name: "Hot water & dryer" },
  { x: -2, y: -21, w: 31, d: 15, name: "De-gasifier · dosing · gravity tank" },
];
const OPEN_TANKS = [   // concrete open-top tanks with a fill
  { id: "sludgeT", x: -19, y: 3, w: 8, d: 6, h: 3.6, lt: "LT_01", fluid: "sludge", name: "Sludge storage tank", tag: "01-LT-101" },
  { id: "filtT", x: -8, y: 3, w: 6, d: 5, h: 3.6, lt: "LT_02", fluid: "water", name: "Filtrate tank", tag: "01-LT-102" },
  { id: "rawT", x: 5, y: 14, w: 7, d: 5, h: 3, sw: ["LS301_HL", "LS301_LL"], fluid: "water", name: "Raw water tank", tag: "03-LS-301" },
  { id: "gravT", x: 18, y: -17, w: 5, d: 4, h: 2.5, sw: ["LS702_HL", "LS702_LL"], fluid: "water", name: "Gravity tank", tag: "07-LS-702" },
  { id: "screen", x: -25.5, y: 4, w: 3.5, d: 3, h: 2.2, fluid: "sludge", fill: 0.45, name: "Screening chamber" },
  { id: "collect", x: -12.5, y: 15, w: 3, d: 2.5, h: 2, fluid: "sludge", fill: 0.55, name: "Sludge collecting tank", pk: true },
];
const VESSELS = [      // steel vessels (see-through shell so the level is visible)
  { id: "floc", x: -18, y: 16.5, r: 2, h: 3, fluid: "sludge", fill: 0.7, name: "Flocculation tank", pk: true },
  { id: "chemT", x: -23.5, y: 16.5, r: 1.2, h: 2.6, fluid: "chem", fill: 0.6, name: "Chemical dilution tank", pk: true },
  { id: "hotT", x: 27, y: 15, r: 1.8, h: 3.2, sw: ["LS603_HL", "LS603_LL"], fluid: "hot", name: "Hot water tank", tag: "06-LS-603" },
  { id: "degas", x: 5, y: -13, r: 1.5, h: 7, sw: ["LS701_H", "LS701_LL"], fluid: "water", name: "De-gasifier", tag: "07-LS-701", closed: true },
  { id: "acidT", x: 11, y: -15.5, r: 0.7, h: 1.6, fluid: "chem", fill: 0.6, name: "Acid", small: true },
  { id: "alkT", x: 13.5, y: -15.5, r: 0.7, h: 1.6, fluid: "chem", fill: 0.6, name: "Alkali", small: true },
];
const TOWERS = [
  { id: "ct1", x: 20, y: 1.5, w: 5, d: 5, h: 4, fan: "OP_F1", sw: ["LS601_HL", "LS601_LL"], name: "Cooling tower 1", tag: "06-F-601" },
  { id: "ct2", x: 30, y: 1.5, w: 4.2, d: 4.2, h: 3.6, fan: "OP_F2", sw: ["LS602_HL", "LS602_LL"], name: "Cooling tower 2", tag: "06-F-602" },
];
const PACKAGES = [     // package equipment without a panel signal: faded, static
  { x: -6.5, y: 15, w: 6.5, d: 2.6, h: 2.2, name: "Volute press (screw 1 / 2)", kind: "press" },
  { x: 34, y: 17, w: 6.5, d: 4.2, h: 3.2, name: "Sludge dryer", kind: "box" },
  { x: 35, y: 10.5, w: 3.2, d: 1.1, h: 2.4, name: "Radiator", kind: "radiator" },
  { x: 37, y: -3, w: 3.2, d: 3.2, h: 3.4, name: "Boiler / turbine PHE", kind: "box" },
  { x: 25.5, y: -17, w: 4, d: 3, h: 2.8, name: "WTP / CTP", kind: "box" },
];
const PUMPS = [        // [IO equipment id, x, y, heading deg]
  ["OP_P1A", -17, 0.4, 0], ["OP_P1B", -14.5, 0.4, 0], ["OP_P5A", -7, 0.4, 0], ["OP_P5B", -4.5, 0.4, 0],
  ["OP_P6A", 3.5, 21.6, 0], ["OP_P6B", 6, 21.6, 0], ["OP_P14", 6, 10.6, 0], ["OP_P15", 8.5, 10.6, 0],
  ["OP_P7", 19, -3, 0], ["OP_P3", 21.5, -3, 0], ["OP_P11", 24, -3, 0], ["OP_P10", 31, -3, 0],
  ["OP_P2", 24, 12.5, 90], ["OP_P9", 2.5, -17, 0], ["OP_P4", 7.5, -17, 0], ["OP_P12", 11, -18, 0],
  ["OP_P13", 13.5, -18, 0], ["OP_P8", 18.5, -19.5, 0], ["PCP", -11, 12, 0],
];
const VALVES = [["MV_01", -21.6, 5.5, 0.7], ["OP_SV1", 3, -10, 0.7], ["OP_SV2", 9.6, -12.4, 0.7]];
const TRANSMITTERS = [ // [tag id, label, x, y, z]
  ["LT_01", "01-LT-101", -15, 9.4, 4.2], ["LT_02", "01-LT-102", -5, 8.4, 4.2],
  ["PT_01", "03-PT-301", 11.5, 10.6, 1.2], ["T_04", "07-TT-701", 3.6, -10.2, 6.5], ["PH_01", "pH", 8.6, -11.6, 1.6],
  ["T_02", "06-TT-601", 29.5, 18, 1.8], ["PT_03", "06-PT-601", 31.5, 18, 1.8],
  ["T_01", "TT dryer → radiator", 35.5, 9.4, 3], ["PT_02", "06-PT-602", 37.8, 9.4, 3],
  ["T_03", "TT radiator → condenser", 33, 7, 1.8], ["PT_04", "06-PT-603", 35.5, 7, 1.8],
];
const SWITCHES = [     // [switch key, x, y, z, label]
  ["LS301_HL", 12.1, 16.5, 2.6, "HL"], ["LS301_LL", 12.1, 16.5, 0.6, "LL"], ["LS702_HL", 23.1, -15, 2.1, "HL"], ["LS702_LL", 23.1, -15, 0.5, "LL"],
  ["LS603_HL", 28.9, 15, 2.8, "HL"], ["LS603_LL", 28.9, 15, 0.6, "LL"], ["LS601_HL", 25.1, 4, 0.7, "HL"], ["LS601_LL", 25.1, 4, 0.2, "LL"],
  ["LS602_HL", 34.3, 3.6, 0.7, "HL"], ["LS602_LL", 34.3, 3.6, 0.2, "LL"],
  ["LS701_HH", 6.6, -13, 6.2, "HH"], ["LS701_H", 6.6, -13, 5.2, "H"], ["LS701_L", 6.6, -13, 2.2, "L"], ["LS701_LL", 6.6, -13, 1.2, "LL"],
];
const PIPES = [        // [fluid, IO pumps that make it flow ([] = never animated), points [x, y, z]]
  // v3 (SC05): raw sludge in flows through 01-MV-101 - animated only while that valve is confirmed open
  ["sludge", ["MV_01"], [[-27, 5.5, 0.7], [-25.5, 5.5, 0.7]]],
  ["sludge", ["MV_01"], [[-22, 5.5, 0.7], [-19, 5.5, 0.7]]],
  ["sludge", ["OP_P1A", "OP_P1B"], [[-17.4, 2.9, 0.5], [-17.4, 1, 0.5]]],
  ["sludge", ["OP_P1A", "OP_P1B"], [[-14.9, 2.9, 0.5], [-14.9, 1, 0.5]]],
  ["sludge", ["OP_P1A", "OP_P1B"], [[-16.6, 0.4, 0.75], [-16.6, -0.9, 0.75], [-10, -0.9, 0.75], [-10, -0.9, 4.6], [-10, 10.5, 4.6], [-18, 10.5, 4.6], [-18, 14.5, 3.4]]],
  ["sludge", ["OP_P1A", "OP_P1B"], [[-14.1, 0.4, 0.75], [-14.1, -0.9, 0.75]]],
  ["sludge", ["PCP"], [[-12.5, 15.5, 0.4], [-11.6, 12, 0.4]]],
  ["sludge", ["PCP"], [[-10, 12, 0.4], [-6.5, 12, 0.4], [-6.5, 15, 1.4]]],
  ["water", [], [[-3, 15, 0.5], [-3, 10, 0.5], [-5, 10, 0.5], [-5, 8.1, 3]]],   // filtrate from the press package: no signal, static (as 2D)
  ["water", ["OP_P5A", "OP_P5B"], [[-6.6, 0.4, 0.75], [-6.6, -0.9, 0.75], [0.8, -0.9, 0.75], [0.8, -0.9, 2.4]]],
  ["water", ["OP_P5A", "OP_P5B"], [[-4.1, 0.4, 0.75], [-4.1, -0.9, 0.75]]],
  ["water", ["OP_P6A", "OP_P6B"], [[3.9, 21.6, 0.75], [3.9, 20.2, 0.75], [7, 20.2, 0.75], [7, 19.1, 3.3]]],
  ["water", ["OP_P6A", "OP_P6B"], [[6.4, 21.6, 0.75], [6.4, 20.2, 0.75]]],
  ["water", ["OP_P14", "OP_P15"], [[6, 14, 0.4], [6, 11.5, 0.4], [8.5, 11.5, 0.4]]],
  ["water", ["OP_P14", "OP_P15"], [[8.9, 10.6, 0.75], [14, 10.6, 0.75], [14, 7, 4.8], [22.5, 7, 4.8], [22.5, 6.5, 4.4]]],
  ["water", ["OP_P14", "OP_P15"], [[14, 7, 4.8], [14, -6, 4.8], [5, -6, 4.8], [5, -11.5, 7]]],
  ["water", ["OP_P7", "OP_P3", "OP_P11"], [[22.5, 1.5, 0.4], [22.5, -1.2, 0.4], [19, -1.2, 0.4], [19, -2.6, 0.4]]],
  ["water", ["OP_P3", "OP_P11"], [[21.5, -1.2, 0.4], [21.5, -2.6, 0.4]]],
  ["water", ["OP_P11"], [[24, -1.2, 0.4], [24, -2.6, 0.4]]],
  ["water", ["OP_P7"], [[19.4, -3, 0.75], [19.4, -5.6, 0.75], [6.5, -5.6, 0.75], [6.5, -11.6, 1.6]]],
  ["water", ["OP_P11"], [[24.4, -3, 0.75], [24.4, -5, 0.75], [38.6, -5, 0.75], [38.6, -3, 1.2]]],
  ["water", ["OP_P10"], [[32, 1.5, 0.4], [32, -2.6, 0.4]]],
  ["water", ["OP_P10"], [[31.4, -3, 0.75], [31.4, -4.2, 0.75], [37.4, -4.2, 0.75], [37.4, -3, 1.4]]],
  ["hot", ["OP_P2"], [[27, 13.2, 0.5], [24, 13.2, 0.5], [24, 12.9, 0.5]]],
  ["hot", ["OP_P2"], [[24, 12.1, 0.75], [24, 18, 0.75], [34, 18, 1.6]]],
  ["hot", ["OP_P2"], [[36.5, 17, 0.8], [36.5, 11.6, 0.8]]],
  ["hot", ["OP_P2"], [[35, 11, 0.8], [28.8, 15, 0.8]]],
  ["water", ["OP_P9"], [[5, -14.5, 0.5], [2.5, -15.8, 0.5]]],
  ["water", ["OP_P9"], [[2.9, -17, 0.75], [2.9, -18.6, 0.75], [1.4, -18.6, 0.75], [1.4, -11, 6.2], [3.6, -11.5, 6.2]]],
  ["water", ["OP_P4"], [[7.9, -17, 0.75], [7.9, -14, 2.6], [6.4, -13.4, 2.6]]],
  ["chem", ["OP_P12"], [[11, -15.5, 0.3], [11, -17.6, 0.3]]],
  ["chem", ["OP_P12"], [[11.4, -18, 0.6], [11.4, -12.8, 0.6], [6.5, -12.8, 1]]],
  ["chem", ["OP_P13"], [[13.5, -15.5, 0.3], [13.5, -17.6, 0.3]]],
  ["chem", ["OP_P13"], [[13.9, -18, 0.6], [13.9, -13.2, 0.6], [6.5, -13.2, 1.2]]],
  ["water", ["OP_P8"], [[19, -17, 0.4], [18.5, -19.1, 0.4]]],
  ["water", ["OP_P8"], [[18.9, -19.5, 0.75], [27.5, -19.5, 0.75], [27.5, -17, 1.5]]],
  ["chem", [], [[-23.5, 16.5, 2.6], [-20, 16.5, 2.6]]],
];

// ------------------------------------------------------------------ state
let renderer, scene, camera, controls, wrap, labelBox, raf = 0, clock, live = null, helpers = null, onPick = null;
let pickables = [], machines = {}, tanks = [], switches = [], flows = [], labels = [], animated = [];
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
const HOME = { pos: W2(5, -50, 40), target: W2(6, 1, 0) };

// ------------------------------------------------------------------ materials
const matCache = {};
function mat(color, o = {}) {
  const k = `${color}|${o.metal ?? 0.1}|${o.rough ?? 0.75}|${o.opacity ?? 1}|${o.emissive ?? 0}`;
  if (o.unique || !matCache[k]) {
    const m = new THREE.MeshStandardMaterial({ color, metalness: o.metal ?? 0.1, roughness: o.rough ?? 0.75,
      transparent: (o.opacity ?? 1) < 1, opacity: o.opacity ?? 1, emissive: o.emissive ?? 0, depthWrite: (o.opacity ?? 1) > 0.6 });
    if (o.unique) return m;
    matCache[k] = m;
  }
  return matCache[k];
}
const STEEL = () => mat(C.steel, { metal: 0.55, rough: 0.38 });
const STEEL_DK = () => mat(C.steelDk, { metal: 0.5, rough: 0.45 });
const CONCRETE = () => mat(C.concrete, { rough: 0.95 });
function add(mesh, parent = scene, shadow = true) { mesh.castShadow = shadow; mesh.receiveShadow = true; parent.add(mesh); return mesh; }
function boxM(w, h, d, m) { return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); }
function cylM(rt, rb, h, m, seg = 28, open = false) { return new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg, 1, open), m); }
function edges(mesh, color = 0x5d6358, opacity = 0.55) {
  const l = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 25), new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
  mesh.add(l);
  return l;
}

// ------------------------------------------------------------------ labels (HTML overlay)
function label(pos, html, cls = "", eq = null) {
  const el = document.createElement("div");
  el.className = `p3-lb ${cls}`;
  el.innerHTML = html;
  if (eq) { el.dataset.eq = eq; el.style.pointerEvents = "auto"; el.onclick = (e) => onPick && onPick(eq, e.clientX, e.clientY); }
  labelBox.appendChild(el);
  const l = { pos: pos.clone(), el, cls };
  labels.push(l);
  return l;
}

// ------------------------------------------------------------------ builders
function buildGround() {
  const g = add(new THREE.Mesh(new THREE.PlaneGeometry(220, 220), mat(C.ground, { rough: 1 })), scene, false);
  g.rotation.x = -Math.PI / 2;
  const grid = new THREE.GridHelper(120, 60, 0xc9cfbf, 0xd8ddcf);
  grid.position.y = 0.002;
  scene.add(grid);
  for (const a of AREAS) {
    const pad = add(boxM(a.w, 0.18, a.d, mat(C.pad, { rough: 0.95 })), scene, false);
    pad.position.copy(W2(a.x + a.w / 2, a.y + a.d / 2, 0.09));
    edges(pad, 0xa9ad9f, 0.6);
    label(W2(a.x + 0.4, a.y + 0.6, 0.25), a.name, "area");
  }
}
function buildOpenTank(t) {
  const g = new THREE.Group();
  const th = 0.2, m = t.pk ? mat(C.pkg, { rough: 0.9, opacity: 0.55 }) : CONCRETE();
  const wall = (w, d, x, y) => { const b = add(boxM(w, t.h, d, m), g); b.position.copy(W2(x, y, t.h / 2)); };
  wall(t.w, th, t.x + t.w / 2, t.y + th / 2);                         // south
  wall(t.w, th, t.x + t.w / 2, t.y + t.d - th / 2);                   // north
  wall(th, t.d, t.x + th / 2, t.y + t.d / 2);                         // west
  wall(th, t.d, t.x + t.w - th / 2, t.y + t.d / 2);                   // east
  const floor = add(boxM(t.w, 0.12, t.d, m), g); floor.position.copy(W2(t.x + t.w / 2, t.y + t.d / 2, 0.06));
  // fill: a liquid block scaled in height by the level
  const liquid = add(boxM(t.w - 2 * th - 0.04, 1, t.d - 2 * th - 0.04, mat(FLUID[t.fluid], { rough: 0.25, metal: 0.05, opacity: 0.9 })), g, false);
  liquid.position.copy(W2(t.x + t.w / 2, t.y + t.d / 2, 0.5));
  scene.add(g);
  const lb = label(W2(t.x + t.w / 2, t.y + t.d / 2, t.h + 0.7), `<b>${t.name}</b><span class="sub"></span>`, t.pk ? "pk" : "strong");
  tanks.push({ t, liquid, h: t.h - 0.15, lb });
}
function buildVessel(v) {
  const g = new THREE.Group();
  const shell = add(cylM(v.r, v.r, v.h, mat(v.pk ? C.pkg : C.steel, { metal: 0.45, rough: 0.35, opacity: v.small ? 0.85 : 0.32 }), 36, !v.closed && !v.small), g, false);
  shell.position.copy(W2(v.x, v.y, v.h / 2));
  edges(shell, 0x6b7268, 0.35);
  for (const z of [0.05, v.h]) {                      // stiffener rings
    const ring = add(new THREE.Mesh(new THREE.TorusGeometry(v.r + 0.02, 0.05, 8, 36), STEEL_DK()), g);
    ring.rotation.x = Math.PI / 2; ring.position.copy(W2(v.x, v.y, z));
  }
  if (v.closed) {                                     // dished head
    const head = add(new THREE.Mesh(new THREE.SphereGeometry(v.r, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), STEEL()), g);
    head.scale.y = 0.35; head.position.copy(W2(v.x, v.y, v.h));
  }
  const liquid = add(cylM(v.r - 0.06, v.r - 0.06, 1, mat(FLUID[v.fluid], { rough: 0.25, opacity: 0.88 }), 32), g, false);
  liquid.position.copy(W2(v.x, v.y, 0.5));
  for (let i = 0; i < 3; i++) {                       // legs
    const a = (i / 3) * Math.PI * 2, leg = add(cylM(0.07, 0.07, 0.3, STEEL_DK(), 8), g);
    leg.position.copy(W2(v.x + Math.cos(a) * v.r * 0.8, v.y + Math.sin(a) * v.r * 0.8, 0.15));
  }
  scene.add(g);
  const lb = v.small ? null : label(W2(v.x, v.y, v.h + (v.closed ? 1.2 : 0.7)), `<b>${v.name}</b><span class="sub"></span>`, v.pk ? "pk" : "strong");
  tanks.push({ t: v, liquid, h: v.h - 0.1, lb, cyl: true });
}
function buildTower(c) {
  const g = new THREE.Group(), cx = c.x + c.w / 2, cy = c.y + c.d / 2;
  const basin = add(boxM(c.w + 0.4, 0.8, c.d + 0.4, CONCRETE()), g); basin.position.copy(W2(cx, cy, 0.4));
  const water = add(boxM(c.w, 0.1, c.d, mat(C.water, { rough: 0.2, opacity: 0.85 })), g, false); water.position.copy(W2(cx, cy, 0.78));
  const body = add(boxM(c.w, c.h - 0.8, c.d, mat(C.tower, { rough: 0.7 })), g); body.position.copy(W2(cx, cy, 0.8 + (c.h - 0.8) / 2));
  for (let z = 1.1; z < c.h - 0.3; z += 0.32) {        // louvers on the four sides
    for (const [w, d, dx, dy] of [[c.w + 0.06, 0.06, 0, -c.d / 2], [c.w + 0.06, 0.06, 0, c.d / 2], [0.06, c.d + 0.06, -c.w / 2, 0], [0.06, c.d + 0.06, c.w / 2, 0]]) {
      const l = add(boxM(w, 0.06, d, STEEL_DK()), g, false); l.position.copy(W2(cx + dx, cy + dy, z));
    }
  }
  const deck = add(boxM(c.w + 0.1, 0.12, c.d + 0.1, STEEL_DK()), g); deck.position.copy(W2(cx, cy, c.h));
  const rr = Math.min(c.w, c.d) * 0.4;
  const stack = add(cylM(rr, rr * 0.92, 0.9, STEEL(), 36, true), g); stack.position.copy(W2(cx, cy, c.h + 0.45));
  stack.material = mat(C.steel, { metal: 0.55, rough: 0.38 }); stack.material.side = THREE.DoubleSide;
  // fan: hub + 6 blades, coloured by the fan motor state, turns while running
  const fan = new THREE.Group(); fan.position.copy(W2(cx, cy, c.h + 0.55));
  const fanMat = mat(C.unk, { unique: true, metal: 0.3, rough: 0.5 });
  const hub = add(cylM(0.22, 0.22, 0.25, fanMat, 16), fan);
  for (let i = 0; i < 6; i++) {
    const b = add(boxM(rr * 0.9, 0.04, 0.32, fanMat), fan);
    b.position.set(Math.cos((i / 6) * Math.PI * 2) * rr * 0.5, 0, Math.sin((i / 6) * Math.PI * 2) * rr * 0.5);
    b.rotation.y = -(i / 6) * Math.PI * 2; b.rotation.x = 0.35;
  }
  g.add(fan);
  scene.add(g);
  [body, stack, hub].forEach((m) => { m.userData.eq = c.fan; pickables.push(m); });
  const lb = label(W2(cx, cy, c.h + 1.7), `<b>${c.name}</b><span class="sub"></span>`, "strong", c.fan);
  machines[c.fan] = { mats: [fanMat], lamp: null, rot: { obj: fan, axis: "y", speed: 4.5 }, lb, kind: "fan" };
}
function buildPackage(p) {
  const g = new THREE.Group(), cx = p.x + p.w / 2, cy = p.y + p.d / 2, m = mat(C.pkg, { rough: 0.8, opacity: 0.8 });
  const b = add(boxM(p.w, p.h, p.d, m), g); b.position.copy(W2(cx, cy, p.h / 2));
  edges(b, 0x8f8a7d, 0.5);
  if (p.kind === "press") {
    for (const dy of [-0.55, 0.55]) {
      const s = add(cylM(0.35, 0.35, p.w * 0.9, STEEL(), 20), g); s.rotation.z = Math.PI / 2; s.position.copy(W2(cx, cy + dy, p.h + 0.35));
    }
  }
  if (p.kind === "radiator") {
    const ring = add(new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.08, 8, 30), STEEL_DK()), g); ring.position.copy(W2(cx, p.y - 0.05, p.h / 2));
  }
  scene.add(g);
  label(W2(cx, cy, p.h + (p.kind === "press" ? 1.1 : 0.6)), `<b>${p.name}</b><span class="sub">package</span>`, "pk");
}
function buildPump(id, x, y, heading) {
  const g = new THREE.Group(); g.position.copy(W2(x, y, 0.18)); g.rotation.y = (heading * Math.PI) / 180;
  const motorMat = mat(C.unk, { unique: true, metal: 0.25, rough: 0.45 });
  const base = add(boxM(1.5, 0.12, 0.62, STEEL_DK()), g); base.position.y = 0.06;
  const motor = add(cylM(0.27, 0.27, 0.72, motorMat, 24), g); motor.rotation.z = Math.PI / 2; motor.position.set(-0.35, 0.42, 0);
  for (let i = -3; i <= 3; i++) { const f = add(new THREE.Mesh(new THREE.TorusGeometry(0.275, 0.022, 6, 24), motorMat), g, false); f.rotation.y = Math.PI / 2; f.position.set(-0.35 + i * 0.09, 0.42, 0); }
  const fanCover = add(cylM(0.24, 0.27, 0.12, STEEL_DK(), 24), g); fanCover.rotation.z = Math.PI / 2; fanCover.position.set(-0.77, 0.42, 0);
  const tb = add(boxM(0.2, 0.12, 0.18, motorMat), g); tb.position.set(-0.35, 0.72, 0);
  const coupling = add(cylM(0.1, 0.1, 0.14, STEEL(), 12), g); coupling.rotation.z = Math.PI / 2; coupling.position.set(0.08, 0.42, 0);
  const volute = add(cylM(0.34, 0.34, 0.26, STEEL(), 28), g); volute.rotation.x = Math.PI / 2; volute.position.set(0.38, 0.42, 0);
  const suction = add(cylM(0.1, 0.1, 0.3, STEEL(), 12), g); suction.rotation.z = Math.PI / 2; suction.position.set(0.66, 0.42, 0);
  const disch = add(cylM(0.09, 0.09, 0.35, STEEL(), 12), g); disch.position.set(0.38, 0.86, 0);
  const lamp = add(new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), new THREE.MeshStandardMaterial({ color: C.unk, emissive: 0x000000 })), g);
  lamp.position.set(-0.35, 0.86, 0);
  scene.add(g);
  [base, motor, volute, tb, lamp].forEach((m) => { m.userData.eq = id; pickables.push(m); });
  const lb = label(W2(x, y, 1.6), "", "eq", id);
  machines[id] = { mats: [motorMat], lamp, lb, kind: "pump" };
}
function buildAgitator(id, x, y, z) {
  const g = new THREE.Group(), motorMat = mat(C.unk, { unique: true, metal: 0.25, rough: 0.45 });
  const bridge = add(boxM(0.6, 0.15, 6.4, STEEL_DK()), g); bridge.position.copy(W2(x, y, z + 0.08));
  const motor = add(cylM(0.3, 0.3, 0.7, motorMat, 24), g); motor.position.copy(W2(x, y, z + 0.55));
  const gb = add(boxM(0.5, 0.25, 0.5, STEEL()), g); gb.position.copy(W2(x, y, z + 0.18));
  const rot = new THREE.Group(); rot.position.copy(W2(x, y, 0));
  const shaft = add(cylM(0.05, 0.05, z - 0.4, STEEL(), 10), rot); shaft.position.y = z / 2 + 0.2;
  for (let i = 0; i < 3; i++) { const b = add(boxM(1.1, 0.05, 0.25, STEEL()), rot); b.position.set(Math.cos((i / 3) * 6.283) * 0.5, 0.6, Math.sin((i / 3) * 6.283) * 0.5); b.rotation.y = -(i / 3) * 6.283; b.rotation.x = 0.4; }
  const lamp = add(new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), new THREE.MeshStandardMaterial({ color: C.unk })), g); lamp.position.copy(W2(x, y, z + 1));
  g.add(rot); scene.add(g);
  [motor, gb, lamp].forEach((m) => { m.userData.eq = id; pickables.push(m); });
  const lb = label(W2(x, y, z + 1.7), "", "eq", id);
  machines[id] = { mats: [motorMat], lamp, lb, rot: { obj: rot, axis: "y", speed: 1.6 }, kind: "agit" };
}
function buildBlower(id, x, y) {
  const g = new THREE.Group(), motorMat = mat(C.unk, { unique: true, metal: 0.25, rough: 0.45 });
  const base = add(boxM(1.6, 0.12, 0.9, STEEL_DK()), g); base.position.copy(W2(x, y, 0.24));
  const scroll = add(cylM(0.6, 0.6, 0.45, STEEL(), 30), g); scroll.rotation.x = Math.PI / 2; scroll.position.copy(W2(x + 0.3, y, 0.95));
  const outlet = add(boxM(0.45, 0.9, 0.4, STEEL()), g); outlet.position.copy(W2(x + 0.65, y, 1.5));
  const motor = add(cylM(0.28, 0.28, 0.65, motorMat, 24), g); motor.rotation.z = Math.PI / 2; motor.position.copy(W2(x - 0.45, y, 0.62));
  const lamp = add(new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), new THREE.MeshStandardMaterial({ color: C.unk })), g); lamp.position.copy(W2(x - 0.45, y, 1.02));
  scene.add(g);
  [base, scroll, motor, lamp].forEach((m) => { m.userData.eq = id; pickables.push(m); });
  const lb = label(W2(x, y, 2.4), "", "eq", id);
  machines[id] = { mats: [motorMat], lamp, lb, kind: "blower" };
}
function buildValve(id, x, y, z) {
  const g = new THREE.Group(), actMat = mat(C.unk, { unique: true, metal: 0.2, rough: 0.5 });
  const body = add(new THREE.Mesh(new THREE.SphereGeometry(0.24, 18, 14), STEEL()), g); body.position.copy(W2(x, y, z));
  const fl = add(cylM(0.18, 0.18, 0.62, STEEL_DK(), 16), g); fl.rotation.z = Math.PI / 2; fl.position.copy(W2(x, y, z));
  const stem = add(cylM(0.04, 0.04, 0.3, STEEL(), 8), g); stem.position.copy(W2(x, y, z + 0.38));
  const act = add(boxM(0.42, 0.3, 0.34, actMat), g); act.position.copy(W2(x, y, z + 0.66));
  scene.add(g);
  [body, act].forEach((m) => { m.userData.eq = id; pickables.push(m); });
  const lb = label(W2(x, y, z + 1.35), "", "eq", id);
  machines[id] = { mats: [actMat], lamp: null, lb, kind: "valve" };
}
function buildTransmitter(tid, name, x, y, z) {
  const g = new THREE.Group();
  const pole = add(cylM(0.03, 0.03, z, STEEL_DK(), 8), g); pole.position.copy(W2(x, y, z / 2));
  const head = add(cylM(0.17, 0.17, 0.22, mat(0x2f6fb5, { metal: 0.3, rough: 0.4 }), 18), g); head.rotation.x = Math.PI / 2; head.position.copy(W2(x, y, z + 0.1));
  scene.add(g);
  head.userData.tag = tid; pickables.push(head);
  const lb = label(W2(x, y, z + 0.55), "", "tx");
  lb.tid = tid; lb.name = name;
}
function buildSwitch(key, x, y, z, txt) {
  const m = new THREE.MeshStandardMaterial({ color: 0xbdbdb5, emissive: 0x000000 });
  const s = add(new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 10), m), scene, false); s.position.copy(W2(x, y, z));
  switches.push({ key, m, txt });
}
function buildPipe(fluid, by, pts) {
  const color = FLUID[fluid] || C.water, m = mat(color, { metal: 0.35, rough: 0.4 });
  const v = pts.map(([x, y, z]) => W2(x, y, z));
  const r = fluid === "chem" ? 0.06 : 0.1;
  let length = 0;
  for (let i = 0; i < v.length - 1; i++) {
    const a = v[i], b = v[i + 1], len = a.distanceTo(b);
    if (len < 0.01) continue;
    const seg = add(cylM(r, r, len, m, 12), scene, false);
    seg.position.copy(a).add(b).multiplyScalar(0.5);
    seg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    length += len;
  }
  for (let i = 1; i < v.length - 1; i++) { const e = add(new THREE.Mesh(new THREE.SphereGeometry(r * 1.25, 12, 10), m), scene, false); e.position.copy(v[i]); }
  if (!by.length) return;
  // flow dots: small bright spheres travelling along the line while one of its IO pumps runs
  const n = Math.max(2, Math.round(length / 1.4)), dots = [];
  const dm = new THREE.MeshBasicMaterial({ color: 0xffffff });
  for (let i = 0; i < n; i++) { const d = new THREE.Mesh(new THREE.SphereGeometry(r * 0.75, 10, 8), dm); d.visible = false; scene.add(d); dots.push(d); }
  flows.push({ by, v, length, dots });
}

// ------------------------------------------------------------------ live state
const RUNS = ["RUNNING", "STARTING", "OPEN"];
const eqOf = (id) => (live && live.equipment || []).find((e) => e.id === id);
function stateColor(e) {
  if (!e) return C.unk;
  if (["TRIP", "FAULT"].includes(e.status)) return C.trip;
  if (RUNS.includes(e.status)) return C.run;
  if (["NO FEEDBACK", "TRAVEL"].includes(e.status)) return C.warn;
  if (["STOPPED", "CLOSED"].includes(e.status)) return C.stop;
  return C.unk;
}
function fillOf(t) {
  if (t.fill != null) return t.fill;
  if (t.lt) { const p = helpers.pct(t.lt); return p == null ? null : p / 100; }
  if (t.sw) { const hl = helpers.sw(t.sw[0]), ll = helpers.sw(t.sw[1]); if (hl == null && ll == null) return null; return hl ? 0.9 : ll === false ? 0.1 : 0.5; }
  return null;
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function applyLive() {
  if (!scene || !helpers) return;
  for (const [id, m] of Object.entries(machines)) {
    const e = eqOf(id);
    // v3 (SC05): valves coloured from the limit switches only (helpers.valve, same rule as the 2D sheets)
    const vk = m.kind === "valve" && helpers.valve ? helpers.valve(e) : null;
    const col = vk ? ({ open: C.run, closed: C.stop, conf: C.warn }[vk] ?? C.unk) : stateColor(e);
    m.mats.forEach((mm) => { mm.color.setHex(col); mm.emissive.setHex((vk ? vk === "open" : RUNS.includes(e && e.status)) ? 0x0f2a00 : 0x000000); });
    m.running = vk ? false : !!e && RUNS.includes(e.status);
    m.trip = !!e && ["TRIP", "FAULT"].includes(e.status);
    if (m.lamp) { m.lamp.material.color.setHex(col); m.lamp.material.emissive.setHex(m.running ? 0x2f8a00 : m.trip ? 0x8a0000 : 0x000000); }
    const mode = e && e.auto != null ? `<i class="${e.auto ? "au" : "ma"}">${e.auto ? "AUTO" : "MAN"}</i>` : "";
    const st = e ? helpers.stateTxt(e) : "no data";
    if (m.kind === "fan") {
      const c = TOWERS.find((t) => t.fan === id);
      m.lb.el.innerHTML = `<b>${esc(c.name)}</b><span class="sub"><em class="dot" style="background:#${col.toString(16).padStart(6, "0")}"></em>${esc(c.tag)} · ${esc(st)} ${mode}</span>`
        + `<span class="nm">${esc(e ? e.name : "")}${e && e.kw ? ` · ${esc(e.kw)} kW` : ""}</span>`;
    } else {
      // tag + state + AUTO / MAN on the first line, the full equipment name (description) and rating under it
      m.lb.el.innerHTML = `<span class="l1"><em class="dot" style="background:#${col.toString(16).padStart(6, "0")}"></em><b>${esc(helpers.pid(id))}</b>`
        + `<span class="st">${esc(st)}</span>${mode}</span><span class="nm">${esc(e ? e.name : id)}${e && e.kw ? ` · ${esc(e.kw)} kW` : ""}</span>`;
      m.lb.el.title = `${e ? e.name : id} - ${st}`;
    }
  }
  for (const k of tanks) {
    const f = fillOf(k.t);
    k.liquid.visible = f != null && f > 0.005;
    if (k.liquid.visible) { const h = Math.max(0.05, k.h * Math.min(1, f)); k.liquid.scale.y = h; k.liquid.position.y = 0.12 + h / 2; }
    if (k.lb) {
      const sub = k.lb.el.querySelector(".sub");
      if (k.t.lt) sub.textContent = helpers.tagTxt(k.t.lt) || "no data";
      else if (k.t.pk) sub.textContent = "package";
      else if (k.t.sw) sub.textContent = f == null ? "no data" : `${f >= 0.9 ? "high" : f <= 0.1 ? "low" : "normal"} (float switches)`;
      else sub.textContent = "";
    }
  }
  for (const s of switches) {
    const v = helpers.sw(s.key);
    s.m.color.setHex(v == null ? 0xbdbdb5 : v ? 0xffc21a : 0x8d8d86);
    s.m.emissive.setHex(v ? 0x8a6000 : 0x000000);
  }
  for (const l of labels) {
    if (!l.tid) continue;
    const t = helpers.val(l.tid);
    // tag no + live value, the instrument's description (e.g. "PT-01 Raw Water Tank Distribution Line Pressure") under it
    const desc = helpers.tagName ? helpers.tagName(l.tid) : "";
    l.el.innerHTML = `<span class="tn">${esc(l.name)}</span><b>${esc(t ?? "--")}</b>${desc ? `<span class="nm">${esc(desc)}</span>` : ""}`;
    l.el.classList.toggle("over", helpers.over(l.tid));
  }
  // v3 (SC05): flow = IO machine running and valves confirmed open (helpers.flowOn from the 2D page)
  for (const f of flows) f.on = helpers.flowOn ? helpers.flowOn(f.by) : f.by.some((id) => { const e = eqOf(id); return !!e && RUNS.includes(e.status); });
  labels.forEach((l) => (l.dirty = true));            // text changed: measure again for the overlap check
}

// ------------------------------------------------------------------ loop
function frame() {
  raf = 0;
  if (!renderer || !wrap.isConnected) return;
  raf = requestAnimationFrame(frame);
  if (document.hidden || wrap.offsetParent === null) return;
  const dt = Math.min(0.05, clock.getDelta()), t = clock.elapsedTime;
  resize();
  controls.update();
  for (const m of Object.values(machines)) {
    if (m.rot && m.running) m.rot.obj.rotation[m.rot.axis] += m.rot.speed * dt;
    if (m.trip && m.lamp) m.lamp.visible = Math.floor(t * 2.5) % 2 === 0; else if (m.lamp) m.lamp.visible = true;
  }
  for (const f of flows) {
    f.dots.forEach((d, i) => {
      d.visible = !!f.on;
      if (!f.on) return;
      let s = ((t * 1.6 + (i / f.dots.length) * f.length) % f.length);
      for (let k = 0; k < f.v.length - 1; k++) {
        const len = f.v[k].distanceTo(f.v[k + 1]);
        if (s <= len || k === f.v.length - 2) { d.position.lerpVectors(f.v[k], f.v[k + 1], len ? Math.min(1, s / len) : 0); break; }
        s -= len;
      }
    });
  }
  renderer.render(scene, camera);
  placeLabels();
}
// label priority when two would overlap: area > tanks / towers > alarmed transmitter > transmitter > machine > package
const PRIO = (l) => (l.cls.includes("area") ? 0 : l.cls.includes("strong") ? 1 : l.el.classList.contains("over") ? 2 : l.cls.includes("tx") ? 3 : l.cls.includes("eq") ? 4 : 5);
function placeLabels() {
  const w = wrap.clientWidth, h = wrap.clientHeight, v = new THREE.Vector3(), placed = [];
  const order = labels.slice().sort((a, b) => PRIO(a) - PRIO(b));
  for (const l of order) {
    v.copy(l.pos).project(camera);
    let vis = v.z < 1 && v.x > -1.05 && v.x < 1.05 && v.y > -1.05 && v.y < 1.05;
    const x = ((v.x + 1) / 2) * w, y = ((1 - v.y) / 2) * h;
    if (vis && PRIO(l) > 0) {                           // keep labels readable: skip one that would cover a more important one
      if (!l.size || l.dirty) { l.el.style.display = ""; l.size = [l.el.offsetWidth || 60, l.el.offsetHeight || 18]; l.dirty = false; }
      const r = { x0: x - l.size[0] / 2, x1: x + l.size[0] / 2, y0: y - l.size[1], y1: y };
      if (placed.some((o) => !(o.x1 < r.x0 || o.x0 > r.x1 || o.y1 < r.y0 || o.y0 > r.y1))) vis = false;
      else placed.push(r);
    }
    l.el.style.display = vis ? "" : "none";
    if (vis) l.el.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px)`;
  }
}
function resize() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (!w || !h) return;
  const c = renderer.domElement;
  if (c.width !== Math.round(w * renderer.getPixelRatio()) || c.height !== Math.round(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
}
function pickAt(cx, cy) {
  const r = renderer.domElement.getBoundingClientRect();
  mouse.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const hit = ray.intersectObjects(pickables, false)[0];
  return hit ? hit.object.userData : null;
}

// ------------------------------------------------------------------ public API (same as before)
function build(container) {
  container.innerHTML = `<div class="p3-wrap"><div class="p3-labels"></div>
    <div class="p3-tools"><button class="btn sm" data-p3="reset" type="button">Reset view</button>
      <button class="btn sm" data-p3="auto" type="button">Auto-rotate</button>
      <button class="btn sm" data-p3="top" type="button">Top view</button>
      <button class="btn sm" data-p3="lbl" type="button">Labels</button></div>
    <div class="p3-help">Left-drag = rotate · wheel = zoom · right-drag = move · click a machine for details</div></div>`;
  wrap = container.querySelector(".p3-wrap");
  labelBox = container.querySelector(".p3-labels");
  pickables = []; machines = {}; tanks = []; switches = []; flows = []; labels = []; animated = [];
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.className = "p3-cv";
  wrap.prepend(renderer.domElement);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xeef2e8);
  scene.fog = new THREE.Fog(0xeef2e8, 90, 170);
  camera = new THREE.PerspectiveCamera(38, 1, 0.5, 400);
  camera.position.copy(HOME.pos);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb9c2a8, 1.25));
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.1);
  sun.position.set(-30, 55, 25); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -50, right: 50, top: 45, bottom: -45, near: 1, far: 160 });
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(HOME.target);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minDistance = 8; controls.maxDistance = 140; controls.maxPolarAngle = Math.PI * 0.47;
  controls.autoRotateSpeed = 0.6;
  buildGround();
  OPEN_TANKS.forEach(buildOpenTank);
  VESSELS.forEach(buildVessel);
  TOWERS.forEach(buildTower);
  PACKAGES.forEach(buildPackage);
  PUMPS.forEach((p) => buildPump(...p));
  buildAgitator("AGIT", -15, 6, 3.6);
  buildBlower("OP_M1", 8.6, -10.2);
  VALVES.forEach((v) => buildValve(...v));
  TRANSMITTERS.forEach((t) => buildTransmitter(...t));
  SWITCHES.forEach((s) => buildSwitch(...s));
  PIPES.forEach((p) => buildPipe(...p));
  clock = new THREE.Clock();
  // input
  let down = null;
  const cv = renderer.domElement;
  cv.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; });
  cv.addEventListener("pointerup", (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) {
      const u = pickAt(e.clientX, e.clientY);
      if (u && u.eq && onPick) onPick(u.eq, e.clientX, e.clientY);
      else if (u && u.tag && window.MD && MD.openTag) MD.openTag(u.tag);
    }
    down = null;
  });
  cv.addEventListener("pointermove", (e) => { if (!down) { const u = pickAt(e.clientX, e.clientY); cv.style.cursor = u ? "pointer" : "grab"; } });
  wrap.querySelectorAll("[data-p3]").forEach((b) => (b.onclick = () => {
    const a = b.dataset.p3;
    if (a === "reset") { camera.position.copy(HOME.pos); controls.target.copy(HOME.target); }
    if (a === "top") { const tg = controls.target; camera.position.set(tg.x + 0.01, 75, tg.z + 0.01); }
    if (a === "auto") { controls.autoRotate = !controls.autoRotate; b.classList.toggle("primary", controls.autoRotate); }
    if (a === "lbl") { labelBox.classList.toggle("off"); b.classList.toggle("primary", labelBox.classList.contains("off")); }
  }));
}

window.Plant3D = {
  /** h = { pct(tagId), sw(key), tagTxt(tagId), val(tagId), over(tagId), pid(eqId), stateTxt(e) }; pick(eqId, x, y) */
  mount(container, h, pickCb) {
    helpers = h; onPick = pickCb;
    if (wrap && wrap.isConnected && container.contains(wrap)) return;
    build(container);
    applyLive();
    if (!raf) raf = requestAnimationFrame(frame);
  },
  update(l) { live = l; applyLive(); if (renderer && !raf) raf = requestAnimationFrame(frame); },
  unmount() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (renderer) { renderer.dispose(); renderer.forceContextLoss && renderer.forceContextLoss(); }
    renderer = null; scene = null; wrap = null;
  },
  /** clickable machines in screen pixels (tests / diagnostics) */
  targets() {
    if (!renderer) return [];
    const r = renderer.domElement.getBoundingClientRect(), v = new THREE.Vector3(), out = {};
    for (const m of pickables) {
      if (!m.userData.eq || out[m.userData.eq]) continue;
      m.getWorldPosition(v); v.project(camera);
      out[m.userData.eq] = { id: m.userData.eq, x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    }
    return Object.values(out);
  },
  ready: true,
};
window.dispatchEvent(new Event("plant3d-ready"));
