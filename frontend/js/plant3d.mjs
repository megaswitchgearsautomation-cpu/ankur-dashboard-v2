/* 3D plant - Muttathara FSTP 200 KLD (rebuild 20-11-2026 from the indicative P&ID R1, 12-12-2025, 15 sheets).
   Placement and sizes are illustrative (indicative drawing); connectivity follows the P&ID.
   - bounded plant floor, grouped process areas with names, service aisles
   - every machine has its own industrial shape; motor colour + status lamp = live state, TRIP shown as text too
   - pipes: one diameter per run, bent elbows, flanges, supports / racks, tees marked, colours = service legend
   - click an area name -> zoom to that area; click a machine -> highlight + side panel (tag, service, status, readings)
   - Reset view = whole plant; Top view; Labels on / off; orbit / pan / zoom
   Data: /api/live through the helpers given by plant.js (same bindings as before); simulated values marked DEMO. */
import * as THREE from "three";
import { OrbitControls } from "three/addons/OrbitControls.js";

const W2 = (x, y, z = 0) => new THREE.Vector3(x, z, -y);          // plan (x east, y north, z up) -> three.js

// ------------------------------------------------------------------ plant definition (metres, plan x east / y north)
// Process flow west -> east. South row: sludge receiving -> dewatering -> dryer. North row: raw water -> cooling towers /
// hot water -> degasifier / CTP. East: boiler & turbine (PAR scope). Service aisle + pipe rack between the rows (y 19-23).
const PLANT = {
  bounds: { x: 0, y: 0, w: 98, d: 44 },
  fitH: 7,
  areas: [
    { id: "a1", name: "Sludge receiving · tanks", x: 1.5, y: 1.5, w: 21, d: 17, tint: 0xd3d6cc, h: 5 },
    { id: "a2", name: "Dewatering · Norsen", x: 25.5, y: 1.5, w: 22, d: 17, tint: 0xd6d3cb, h: 5 },
    { id: "a3", name: "Paddle dryer · VAPCO", x: 51.5, y: 1.5, w: 23, d: 17, tint: 0xd1d4d8, h: 6 },
    { id: "a4", name: "Raw water", x: 1.5, y: 24.5, w: 19, d: 18, tint: 0xcdd6dc, h: 5 },
    { id: "a5", name: "Cooling towers · hot water", x: 23.5, y: 24.5, w: 24, d: 18, tint: 0xccd5da, h: 6 },
    { id: "a6", name: "Degasifier · CTP", x: 50.5, y: 24.5, w: 24, d: 18, tint: 0xd0d6d0, h: 7 },
    { id: "a7", name: "Boiler · turbine · PAR", x: 77.5, y: 1.5, w: 19, d: 41, tint: 0xd8d4cd, h: 9 },
  ],
  aisles: [
    { x: 0.5, y: 19, w: 76.5, d: 5 }, { x: 22.5, y: 0.5, w: 3, d: 18.5 }, { x: 47.5, y: 0.5, w: 4, d: 18.5 },
    { x: 20.5, y: 24, w: 3, d: 19 }, { x: 47.5, y: 24, w: 3, d: 19 }, { x: 74.5, y: 0.5, w: 3, d: 43 },
  ],
  // service colours (from the P&ID legend: SL sludge, CW water, HW hot water, air) + process services
  services: {
    sludge: { name: "Sludge (SL)", color: 0x9c5a2a, r: 0.09 },
    filtrate: { name: "Filtrate (CW line)", color: 0x1f9e8f, r: 0.08 },
    water: { name: "Raw / service water (CW)", color: 0xc2188f, r: 0.07 },
    cw: { name: "Cooling water", color: 0x1e7fd8, r: 0.09 },
    hot: { name: "Hot water (HW)", color: 0xf0a20a, r: 0.11 },
    cond: { name: "Process condensate", color: 0x86b4dc, r: 0.05 },
    steam: { name: "Steam", color: 0xd84315, r: 0.06 },
    chem: { name: "Chemical / polymer", color: 0x7e57c2, r: 0.04 },
    air: { name: "Air / vapour duct", color: 0x9ea7b0, r: 0.16 },
    cake: { name: "Dried product (conveyor)", color: 0xb79a6a, r: 0.12 },
  },
  pipes: [
    // ---- SLUDGE path: inlet -> 01-MV-101 -> screening -> sludge storage tank -> 01-P-101/102 -> flocculation tank
    { s: "sludge", by: ["MV_01"], pts: [[0.3, 11, 1.0], [4, 11, 1.0]] },
    { s: "sludge", by: ["MV_01"], pts: [[8, 11, 1.0], [9, 11, 1.0]], noSup: true },
    { s: "sludge", by: ["OP_P1A", "OP_P1B"], pts: [[10.2, 9.25, 3.65], [10.2, 7.6, 3.65], [24, 7.6, 3.65], [24, 12.2, 3.65], [36.4, 12.2, 3.65], [36.4, 12.2, 2.9]] },
    { s: "sludge", by: ["OP_P1A", "OP_P1B"], pts: [[11.6, 9.25, 3.65], [11.6, 7.6, 3.65]], tee1: true },
    // flocculation tank -> sludge collecting tank -> progressive cavity pump -> volute press screws
    { s: "sludge", by: ["PCP"], pts: [[37, 10.7, 0.9], [37, 8.3, 0.9]] },
    { s: "sludge", by: ["PCP"], pts: [[36.2, 7.5, 0.6], [32, 7.5, 0.6], [32, 5.5, 0.6]] },
    { s: "sludge", by: ["PCP"], pts: [[33.6, 5.5, 0.75], [38.7, 5.5, 0.75], [38.7, 4, 0.75], [38.7, 4, 1.75], [39.2, 4, 1.75]] },
    // dewatered cake: screw discharge chute -> sludge storage hopper
    { s: "sludge", by: ["PCP"], pts: [[43.6, 4, 2.3], [45.4, 4, 2.3], [45.4, 4, 2.1]], noSup: true },
    // ---- FILTRATE path (separate, south edge): screw filtrate + collecting-tank side line -> filtrate tank -> 01-P-103/104 -> to client
    { s: "filtrate", by: ["PCP"], pts: [[38.6, 3.4, 0.4], [38.6, 1.2, 0.4], [38.6, 1.2, 4.2], [21, 1.2, 4.2], [21, 3.3, 4.2], [21, 3.3, 3.5]] },
    { s: "filtrate", by: ["PCP"], pts: [[37.7, 6.9, 0.4], [38.0, 6.9, 0.4], [38.0, 3.4, 0.4], [38.6, 3.4, 0.4]], tee1: true },
    { s: "filtrate", by: [], pts: [[67, 33.4, 0.8], [67, 22.2, 0.8], [67, 22.2, 4.6], [24.6, 22.2, 4.6], [24.6, 5.6, 4.6], [21.8, 5.6, 4.6], [21.8, 5.6, 3.5]] },   // CTP RO reject
    { s: "filtrate", by: ["OP_P5A", "OP_P5B"], pts: [[17.4, 3.65, 3.4], [15.6, 3.65, 3.4], [15.6, 0.3, 3.4]] },
    { s: "filtrate", by: ["OP_P5A", "OP_P5B"], pts: [[18.8, 3.65, 3.4], [17.4, 3.65, 3.4]], tee1: true },
    // ---- chemical preparation: dilution tank -> dosing pump -> flocculation tank
    { s: "chem", by: [], pts: [[33.6, 13, 0.5], [34.2, 13, 0.5], [34.2, 14.6, 0.5]] },
    { s: "chem", by: [], pts: [[35.1, 14.6, 0.95], [37, 14.6, 0.95], [37, 14.6, 3.0], [37, 13.1, 3.0]] },
    // ---- RAW WATER: ground water pumps -> raw water tank (+ wash room tank); tank -> 03-P-303/304 -> service header
    { s: "water", by: ["OP_P6A", "OP_P6B"], pts: [[4.2, 37.25, 2.4], [4.2, 41.2, 2.4], [11.5, 41.2, 2.4], [11.5, 41.2, 3.8], [11.5, 38.3, 3.8], [11.5, 38.3, 3.4]] },
    { s: "water", by: ["OP_P6A", "OP_P6B"], pts: [[5.6, 37.25, 2.4], [5.6, 41.2, 2.4]], tee1: true },
    { s: "water", by: ["OP_P6A", "OP_P6B"], pts: [[11.5, 41.2, 2.4], [17, 41.2, 2.4], [17, 38.5, 2.4], [17, 38.5, 1.9]], tee0: true },
    { s: "water", by: ["OP_P14", "OP_P15"], pts: [[11.5, 34.3, 0.63], [11.5, 31.2, 0.63], [10, 31.2, 0.63], [10, 29.75, 0.63]] },
    { s: "water", by: ["OP_P14", "OP_P15"], pts: [[11.5, 31.2, 0.63], [13, 31.2, 0.63], [13, 29.75, 0.63]], tee0: true },
    { s: "water", by: ["OP_P14", "OP_P15"], pts: [[10, 29.36, 1.05], [10, 29.36, 1.6], [10, 27.2, 1.6], [16, 27.2, 1.6], [21.4, 27.2, 1.6], [21.4, 27.2, 3.8], [21.4, 21, 3.8], [88, 21, 3.8], [88, 33.7, 3.8], [88, 33.7, 1.6]] },   // header -> boiler DM make-up (WTP)
    { s: "water", by: ["OP_P14", "OP_P15"], pts: [[13, 29.36, 1.05], [13, 29.36, 1.6], [13, 27.2, 1.6]], tee1: true },
    { s: "water", by: ["OP_P14", "OP_P15"], pts: [[21.4, 21, 3.8], [6, 21, 3.8], [6, 13.4, 3.8], [6, 13.4, 2.1]], tee0: true },          // sludge screen wash
    { s: "water", by: ["OP_P14", "OP_P15"], pts: [[30.2, 21, 3.8], [30.2, 13.6, 3.8], [30.2, 13.6, 2.1]], tee0: true },                  // dosing make-up
    { s: "water", by: ["OP_P14", "OP_P15"], pts: [[40.2, 21, 3.8], [40.2, 5.3, 3.8], [40.2, 5.3, 2.6]], tee0: true },                     // screw spray bars
    { s: "water", by: ["OP_P14", "OP_P15"], pts: [[28, 21, 3.8], [28, 33.6, 3.8], [28, 33.6, 0.95]], tee0: true },                       // CT-1 make-up
    { s: "water", by: ["OP_P14", "OP_P15"], pts: [[35, 21, 3.8], [35, 34.6, 3.8], [35, 34.6, 0.95]], tee0: true },                       // CT-2 make-up
    { s: "water", by: ["OP_P14", "OP_P15"], pts: [[45.4, 21, 3.8], [45.4, 37, 3.8], [43.5, 37, 3.8], [43.5, 37, 3.4]], tee0: true },      // hot water tank make-up
    { s: "water", by: ["OP_P14", "OP_P15"], pts: [[70.5, 21, 3.8], [70.5, 15.2, 3.8], [70.5, 15.2, 1.6]], tee0: true },                  // vacuum pump / KO drum
    // ---- COOLING WATER: CT-1 -> 06-P-601 (degasifier PHE-2), 06-P-602 (dryer condenser SC-101), 06-P-603 (boiler); CT-2 -> 06-P-604 (turbine)
    { s: "cw", by: ["OP_P7"], pts: [[27, 33.7, 0.55], [27, 30.75, 0.55]], noSup: true },
    { s: "cw", by: ["OP_P3"], pts: [[29.5, 33.7, 0.55], [29.5, 30.75, 0.55]], noSup: true },
    { s: "cw", by: ["OP_P11"], pts: [[32, 33.7, 0.55], [32, 30.75, 0.55]], noSup: true },
    { s: "cw", by: ["OP_P7"], pts: [[27, 29.36, 1.05], [27, 29.36, 2.6], [27, 26.2, 2.6], [62, 26.2, 2.6], [62, 29.5, 2.6], [62, 29.5, 1.2]] },
    { s: "cw", by: ["OP_P3"], pts: [[29.5, 29.36, 1.05], [29.5, 29.36, 3.0], [29.5, 22.8, 3.0], [64, 22.8, 3.0], [64, 14.2, 3.0], [64, 14.2, 2.4]], r: 0.11 },
    { s: "cw", by: ["OP_P11"], pts: [[32, 29.36, 1.05], [32, 29.36, 2.2], [32, 25.4, 2.2], [85, 25.4, 2.2], [85, 12.3, 2.2]] },
    { s: "cw", by: ["OP_P10"], pts: [[36, 34.7, 0.55], [36, 31.25, 0.55]], noSup: true },
    { s: "cw", by: ["OP_P10"], pts: [[36, 30.14, 1.05], [36, 30.14, 1.8], [36, 24.6, 1.8], [83.6, 24.6, 1.8]] },
    // ---- HOT WATER loop: tank -> 06-P-605 -> dryer PD-101 -> radiator -> turbine surface condenser -> tank
    { s: "hot", by: ["OP_P2"], pts: [[42, 35.3, 0.55], [42, 31.75, 0.55]], noSup: true },
    { s: "hot", by: ["OP_P2"], pts: [[42, 30.64, 1.05], [42, 30.64, 4.4], [42, 23.6, 4.4], [58, 23.6, 4.4], [58, 8.9, 4.4], [58, 8.9, 2.2]] },
    { s: "hot", by: ["OP_P2"], pts: [[62.5, 8.9, 2.2], [62.5, 8.9, 5.0], [62.5, 24.2, 5.0], [40.8, 24.2, 5.0], [40.8, 26.2, 5.0], [40.8, 26.2, 2.3]] },
    { s: "hot", by: ["OP_P2"], pts: [[38.2, 26.2, 1.0], [38.2, 27.9, 1.0], [46.6, 27.9, 1.0], [46.6, 27.9, 5.4], [84, 27.9, 5.4], [84, 30, 5.4], [84, 30, 1.5]] },
    { s: "hot", by: ["OP_P2"], pts: [[87.4, 30, 1.0], [87.4, 32.6, 1.0], [87.4, 32.6, 5.8], [44.4, 32.6, 5.8], [44.4, 37.4, 5.8], [43.1, 37.4, 5.8], [43.1, 37.4, 3.4]] },
    // ---- DRYER package: vapour -> bag filter BF-101 -> surface condenser SC-101; condensate -> T-101 -> 05-P-501 -> degasifier
    { s: "air", by: [], pts: [[61, 8, 2.4], [61, 8, 4.0], [61, 12.8, 4.0], [60.4, 12.8, 4.0]] },
    { s: "air", by: [], pts: [[60.6, 13.5, 4.3], [63.7, 13.5, 4.3]], noSup: true },
    { s: "cond", by: [], pts: [[64, 13.2, 0.5], [64, 11, 0.5], [66.4, 11, 0.5]] },
    { s: "cond", by: ["OP_P4"], pts: [[67.9, 11, 0.7], [68.3, 11, 0.7], [68.3, 10.5, 0.65]], noSup: true },
    { s: "cond", by: ["OP_P4"], pts: [[68.64, 10.5, 1.05], [68.64, 10.5, 3.4], [68.64, 23.4, 3.4], [52.6, 23.4, 3.4], [52.6, 36.2, 3.4], [52.6, 36.2, 6.3], [54.3, 36.2, 6.3]] },
    // dried product: discharge conveyor F-102 -> bucket elevator BE-01 (PAR)
    { s: "cake", by: [], pts: [[65.2, 8, 0.7], [67.2, 8, 1.6], [79.4, 8, 1.6]] },
    // ---- DEGASIFIER: column -> 07-P-701 -> PHE-1 -> column top; dosing; column -> 07-XV-702 -> gravity tank -> 07-P-704 -> PHE-2 -> CTP
    { s: "cond", by: ["OP_P9"], pts: [[56, 34.95, 0.5], [56, 31.25, 0.5]], noSup: true },
    { s: "cond", by: ["OP_P9"], pts: [[56, 30.86, 1.05], [56, 30.86, 1.3], [58.85, 30.86, 1.3], [58.85, 30.2, 1.3]] },
    { s: "cond", by: ["OP_P9"], pts: [[60.2, 29.8, 1.5], [60.7, 29.8, 1.5], [60.7, 33.8, 1.5], [60.7, 33.8, 6.3], [55.6, 33.8, 6.3], [55.6, 35.3, 6.3], [55.6, 35.3, 5.9]] },
    { s: "chem", by: ["OP_P12"], pts: [[52.4, 27.6, 0.55], [57.5, 27.6, 0.55], [57.5, 30.86, 0.55], [57.5, 30.86, 1.3]], tee1: true },
    { s: "chem", by: ["OP_P13"], pts: [[52.4, 25.6, 0.55], [57.8, 25.6, 0.55], [57.8, 30.86, 0.55], [57.8, 30.86, 1.3]], tee1: true },
    { s: "steam", by: ["OP_SV1"], pts: [[86, 12.3, 3.0], [86, 19.6, 3.0], [59.4, 19.6, 3.0], [59.4, 32.2, 3.0], [59.4, 32.2, 1.0], [59.4, 30.6, 1.0]] },
    { s: "cond", by: ["OP_SV2"], pts: [[56.15, 36.6, 0.6], [62.1, 36.6, 0.6]] },
    { s: "cond", by: ["OP_P8"], pts: [[63, 35.2, 0.55], [63, 33.75, 0.55]], noSup: true },
    { s: "cond", by: ["OP_P8"], pts: [[63, 33.36, 1.05], [63, 33.36, 1.5], [63.8, 33.36, 1.5], [63.8, 30.2, 1.5]] },
    { s: "cond", by: ["OP_P8"], pts: [[63.7, 29.8, 1.1], [66.8, 29.8, 1.1]] },
    { s: "air", by: ["OP_M1"], pts: [[52.5, 38.4, 1.6], [52.5, 36.6, 1.6], [53.9, 36.6, 1.6]], noSup: true },
    { s: "air", by: ["OP_M1"], pts: [[55.3, 36.4, 6.0], [55.3, 39, 6.0], [59.3, 39, 6.0], [59.3, 39, 1.7]] },
  ],
};

function buildPlant() {
  const A = (a) => a;
  // ---- a1 sludge receiving
  bValve({ id: "MV_01", x: 2.6, y: 11, z: 1.0, area: "a1", service: "Raw faecal sludge inlet valve (opens at LL, closes at HL)", readings: ["LT_01"] });
  bBasin({ x: 4, y: 9, w: 4, d: 4, h: 1.6, fluid: "sludge", fill: 0.4, name: "Screening chamber", tag: "Screening chamber" });
  for (const [x, t] of [[5.3, 0.45], [6.7, 0.3]]) { const s = add(boxM(0.06, 1.5, 3.4, GRATE())); at(s, x, 11, FLOOR_Z + 0.85); s.rotation.z = t; }   // coarse + fine screens
  bBasin({ x: 9, y: 8, w: 7, d: 8, h: 3.2, fluid: "sludge", lt: "LT_01", cover: true, name: "Sludge storage tank", tag: "Sludge storage tank" });
  bAgitator({ id: "AGIT", x: 14.4, y: 13.6, z: FLOOR_Z + 3.2, area: "a1", service: "Mixer F1 - keeps the sludge mixed while the sludge pumps run", readings: ["LT_01"] });
  bSubPump({ id: "OP_P1A", x: 10.2, y: 9.0, zt: FLOOR_Z + 3.2, area: "a1", service: "Sludge pump P-1 (working) - sludge tank to flocculation tank", readings: ["LT_01"] });
  bSubPump({ id: "OP_P1B", x: 11.6, y: 9.0, zt: FLOOR_Z + 3.2, area: "a1", service: "Sludge pump P-2 (STANDBY) - sludge tank to flocculation tank", readings: ["LT_01"] });
  bTx({ tid: "LT_01", name: "01-LT-101", x: 16.6, y: 9.0, z: 3.8 });
  bBasin({ x: 16.5, y: 2.5, w: 5, d: 4.5, h: 3.0, fluid: "filtrate", lt: "LT_02", cover: true, name: "Filtrate tank", tag: "Filtrate tank" });
  bSubPump({ id: "OP_P5A", x: 17.4, y: 3.4, zt: FLOOR_Z + 3.0, area: "a1", service: "Filtrate pump P-3 (working) - filtrate tank to client", readings: ["LT_02"] });
  bSubPump({ id: "OP_P5B", x: 18.8, y: 3.4, zt: FLOOR_Z + 3.0, area: "a1", service: "Filtrate pump P-4 (standby) - filtrate tank to client", readings: ["LT_02"] });
  bTx({ tid: "LT_02", name: "01-LT-102", x: 22.1, y: 6.4, z: 3.6 });
  label(W2(15.6, 0.6, FLOOR_Z + 3.6), "<b>To client</b>", "nm", { prio: 4 });
  // ---- a2 dewatering (Norsen scope)
  bTank({ x: 28, y: 15, r: 0.7, h: 1.2, cone: 0.8, legs: 1.2, mat: "paint", color: 0xdfe3e6, fluid: "chem", fill: 0.5, name: "Polymer powder hopper", tag: "Polymer hopper" });
  member([28.4, 14.6, FLOOR_Z + 1.0], [29.8, 13.2, FLOOR_Z + 1.9], 0.1, PAINT(0x9aa6b2), true);                 // screw feeder
  bBasin({ x: 29, y: 11, w: 4.6, d: 2.6, h: 1.6, mat: 0xdfe3e6, fluid: "chem", fill: 0.7, rail: false, name: "Chemical dilution tank (3 compartments)", tag: "Dilution tank" });
  for (const x of [29.8, 31.3, 32.8]) { at(add(cylM(0.14, 0.14, 0.35, PAINT(0x2257b5), 14)), x, 12.3, FLOOR_Z + 1.85); }
  bSkidPump({ x: 34.6, y: 14.6, size: 0.55, name: "Chemical dosing pump", vendor: true });
  bTank({ x: 37, y: 12, r: 1.3, h: 2.4, mat: "steel", fluid: "sludge", fill: 0.7, name: "Flocculation tank", tag: "Flocculation tank" });
  at(add(cylM(0.2, 0.2, 0.5, PAINT(0x2257b5), 16)), 37, 12, FLOOR_Z + 2.8);
  bTank({ x: 37, y: 7.5, r: 0.75, h: 1.4, mat: "steel", fluid: "sludge", fill: 0.5, name: "Sludge collecting tank", tag: "Collecting tank" });
  bPCP({ id: "PCP", x: 32.6, y: 5.5, area: "a2", service: "Progressive cavity pump - flocculated sludge to the volute press screws", readings: ["LT_01"] });
  bVolute({ x: 39.2, y: 4, len: 4.2, tilt: 12, name: "Volute press · Screw 1 + Screw 2" });
  bTank({ x: 45.4, y: 4, r: 0.95, h: 1.3, cone: 0.9, legs: 0.6, mat: "paint", color: 0xb8c2cc, fluid: "sludge", fill: 0.5, name: "Sludge storage hopper (dewatered cake)", tag: "Cake hopper" });
  vendorOutline(26.6, 9.8, 12.4, 6.4);
  // ---- a3 paddle dryer package (VAPCO)
  bDryer({ x: 56, y: 8, len: 8, name: "PD-101 vacuum paddle dryer" });
  bBox({ x: 53.8, y: 10.4, w: 1.6, d: 1.4, h: 2.2, name: "F-101 feeder", vendor: false, color: 0xc8ccd0 });
  bTank({ x: 60, y: 13.5, r: 0.6, h: 3.0, cone: 0.7, legs: 1.4, mat: "steel", fluid: "air", fill: 0, noLabel: false, name: "BF-101 bag filter", tag: "BF-101" });
  bTank({ x: 64, y: 13.5, r: 0.32, h: 4.2, mat: "steel", fluid: "cw", fill: 0, name: "SC-101 surface condenser", tag: "SC-101" });
  bTank({ x: 66.2, y: 14.2, r: 0.25, h: 0.8, cone: 0.3, legs: 0.8, mat: "steel", fluid: "cond", fill: 0.4, name: "VS-101 separator", tag: "VS-101", noLabel: true });
  bCondenser({ x: 66.4, y: 11, len: 1.4, name: "T-101 condensate tank" });
  bSkidPump({ id: "OP_P4", x: 69, y: 10.5, heading: 180, size: 0.8, area: "a3", service: "Process condensate pump 05-P-501 - condensate tank T-101 to the degasifier" });
  bSkidPump({ x: 68.6, y: 14.8, size: 0.85, name: "VP-101 vacuum pump", vendor: true });
  bTank({ x: 70.5, y: 14.5, r: 0.5, h: 1.2, mat: "paint", color: 0x8ea0b4, fluid: "water", fill: 0.5, name: "D-601 knock-out drum", tag: "D-601" });
  bPHE({ x: 71.4, y: 11.6, len: 0.7, name: "HE-101" });
  vendorOutline(52.4, 2.2, 21.4, 16);
  // ---- a4 raw water
  bBasin({ x: 3, y: 36, w: 4, d: 4, h: 2.0, fluid: "water", fill: 0.6, cover: true, name: "Ground water sump", tag: "Ground water sump" });
  bSubPump({ id: "OP_P6A", x: 4.2, y: 37, zt: FLOOR_Z + 2.0, area: "a4", service: "Ground water pump 03-P-301 - fills the raw water tank (LL -> HL)" });
  bSubPump({ id: "OP_P6B", x: 5.6, y: 37, zt: FLOOR_Z + 2.0, area: "a4", service: "Standby ground water pump 03-P-302" });
  bTank({ x: 11.5, y: 36.5, r: 2.2, h: 3.2, mat: "frp", color: 0x5f8fa8, fluid: "water", sw: ["LS301_HL", "LS301_LL"], name: "Raw water storage tank", tag: "Raw water tank" });
  bSwitch("LS301_HL", 13.8, 35.4, FLOOR_Z + 2.9); bSwitch("LS301_LL", 13.8, 35.4, FLOOR_Z + 0.6);
  bTank({ x: 17, y: 38, r: 0.8, h: 1.6, mat: "hdpe", color: 0x2b2f33, fluid: "water", fill: 0.5, name: "Wash room & general purpose tank", tag: "Wash room tank" });
  bSkidPump({ id: "OP_P14", x: 10, y: 29, heading: 90, area: "a4", service: "Raw water distribution pump 03-P-303 (VFD, keeps the header above 3 bar)", readings: ["PT_01"] });
  bSkidPump({ id: "OP_P15", x: 13, y: 29, heading: 90, area: "a4", service: "Raw water distribution pump 03-P-304 (VFD, standby)", readings: ["PT_01"] });
  bTx({ tid: "PT_01", name: "03-PT-301", x: 16.4, y: 27.8, z: 1.7 });
  // ---- a5 cooling towers + hot water
  bCT({ x: 25.5, y: 34, w: 5, d: 5, h: 4.2, fan: "OP_F1", name: "Cooling tower 1", area: "a5", service: "Cooling tower 1 fan 06-F-601 (dryer condenser, degasifier PHE, boiler)" });
  bSwitch("LS601_HL", 30.9, 35.2, FLOOR_Z + 0.65); bSwitch("LS601_LL", 30.9, 35.2, FLOOR_Z + 0.3);
  bSkidPump({ id: "OP_P7", x: 27, y: 30, heading: 90, size: 0.85, area: "a5", service: "06-P-601 - cooling water to degasifier PHE-2" });
  bSkidPump({ id: "OP_P3", x: 29.5, y: 30, heading: 90, area: "a5", service: "06-P-602 - cooling water to dryer surface condenser SC-101" });
  bSkidPump({ id: "OP_P11", x: 32, y: 30, heading: 90, size: 0.85, area: "a5", service: "06-P-603 - cooling water to the boiler" });
  bCT({ x: 33.6, y: 35, w: 4.2, d: 4.2, h: 3.6, fan: "OP_F2", name: "Cooling tower 2", area: "a5", service: "Cooling tower 2 fan 06-F-602 (turbine heat exchanger)" });
  bSwitch("LS602_HL", 38.1, 36, FLOOR_Z + 0.65); bSwitch("LS602_LL", 38.1, 36, FLOOR_Z + 0.3);
  bSkidPump({ id: "OP_P10", x: 36, y: 30.5, heading: 90, size: 0.85, area: "a5", service: "06-P-604 - cooling water to the turbine heat exchanger" });
  bTank({ x: 42, y: 37, r: 1.6, h: 3.0, mat: "paint", color: 0xd8c9a6, fluid: "hot", sw: ["LS603_HL", "LS603_LL"], name: "Hot water tank", tag: "Hot water tank" });
  bSwitch("LS603_HL", 43.7, 36, FLOOR_Z + 2.8); bSwitch("LS603_LL", 43.7, 36, FLOOR_Z + 0.6);
  bSkidPump({ id: "OP_P2", x: 42, y: 31, heading: 90, area: "a5", service: "06-P-605 - hot water to the paddle dryer (83 m³/h, 90 °C)", readings: ["T_02", "PT_03", "T_01", "PT_02", "T_03", "PT_04"] });
  bTx({ tid: "T_02", name: "06-TT-601", x: 43.2, y: 29.4, z: 1.7 }); bTx({ tid: "PT_03", name: "06-PT-601", x: 44.4, y: 29.4, z: 1.7 });
  bBox({ x: 38, y: 25.6, w: 2.8, d: 1.2, h: 2.2, name: "Radiator", color: 0x7d8790 });
  bTx({ tid: "T_01", name: "TT dryer → radiator", x: 41.6, y: 25.4, z: 2.6 }); bTx({ tid: "PT_02", name: "06-PT-602", x: 42.8, y: 25.4, z: 2.6 });
  bTx({ tid: "T_03", name: "TT radiator → condenser", x: 36.8, y: 27.2, z: 1.6 }); bTx({ tid: "PT_04", name: "06-PT-603", x: 35.6, y: 27.2, z: 1.6 });
  // ---- a6 degasifier + CTP
  bColumn({ x: 55, y: 36, r: 1.1, h: 5.5, mat: "steel", fluid: "cond", sw: ["LS701_HH", "LS701_H", "LS701_L", "LS701_LL"], name: "Degasifier column", tag: "Degasifier", platforms: [FLOOR_Z + 3.0, FLOOR_Z + 5.4] });
  [["LS701_HH", 5.0], ["LS701_H", 4.2], ["LS701_L", 1.8], ["LS701_LL", 1.0]].forEach(([k, z]) => bSwitch(k, 56.2, 35.2, FLOOR_Z + z));
  bTank({ x: 52.5, y: 39, r: 0.35, h: 1.4, mat: "paint", color: 0xb8c2cc, fluid: "air", fill: 0, name: "Plated air filter", tag: "Air filter", noLabel: true });
  bBlower({ id: "OP_M1", x: 59.5, y: 39, area: "a6", service: "Hot air blower - draws air up through the degasifier column", readings: ["T_04"] });
  bSkidPump({ id: "OP_P9", x: 56, y: 30.5, heading: 90, size: 0.8, area: "a6", service: "07-P-701 - degasifier re-circulation through PHE-1", readings: ["T_04", "PH_01"] });
  bPHE({ x: 59, y: 30, len: 1.1, name: "PHE-1 (steam)" });
  bPHE({ x: 62.5, y: 30, len: 1.1, name: "PHE-2 (cooling)" });
  bTx({ tid: "T_04", name: "07-TT-701", x: 61.2, y: 33.0, z: 2.0 });
  bTx({ tid: "PH_01", name: "pH", x: 58.2, y: 32.0, z: 1.5 });
  bValve({ id: "OP_SV1", x: 59.4, y: 31.6, z: 1.0, axis: "y", area: "a6", service: "LP steam valve 07-XV-701 - steam to PHE-1", readings: ["T_04"] });
  bValve({ id: "OP_SV2", x: 59.2, y: 36.6, z: 0.6, area: "a6", service: "Process water valve 07-XV-702 - degasifier to the gravity tank" });
  bDosing({ id: "OP_P12", x: 51.6, y: 27.6, tankName: "Acid tank 80 L", tankTag: "Acid", area: "a6", service: "Acid dosing pump 07-P-702 (pH control)", readings: ["PH_01"] });
  bDosing({ id: "OP_P13", x: 51.6, y: 25.6, tankName: "Alkali tank 80 L", tankTag: "Alkali", area: "a6", service: "Alkali dosing pump 07-P-703 (pH control)", readings: ["PH_01"] });
  bTank({ x: 63, y: 36, r: 0.8, h: 1.6, mat: "hdpe", color: 0x3a3f45, fluid: "cond", sw: ["LS702_HL", "LS702_LL"], name: "Gravity PP tank 2000 L", tag: "Gravity tank" });
  bSwitch("LS702_HL", 63.9, 35.4, FLOOR_Z + 1.5); bSwitch("LS702_LL", 63.9, 35.4, FLOOR_Z + 0.4);
  bSkidPump({ id: "OP_P8", x: 63, y: 33, heading: 90, size: 0.75, area: "a6", service: "07-P-704 - gravity tank through PHE-2 to the CTP / WT plant" });
  bTank({ x: 67.5, y: 30, r: 0.7, h: 1.6, mat: "hdpe", color: 0x3a3f45, fluid: "water", sw: ["LS801", "LS802"], name: "CTP raw water tank", tag: "CTP raw water" });
  bTank({ x: 71.5, y: 30, r: 0.7, h: 1.6, mat: "hdpe", color: 0x3a3f45, fluid: "water", sw: ["LS803", "LS804"], name: "Pure water tank", tag: "Pure water" });
  bBox({ x: 66, y: 34.4, w: 7.4, d: 6.4, h: 2.6, name: "CTP / RO plant (sheet 8)", vendor: true });
  // ---- a7 boiler / turbine (PAR scope, reference only)
  bBox({ x: 79, y: 6.8, w: 1.2, d: 1.2, h: 7, name: "BE-01 bucket elevator", vendor: true });
  bBox({ x: 80.8, y: 9.6, w: 2.2, d: 2.2, h: 3.2, name: "FB-01 fuel bunker", vendor: true });
  bBox({ x: 84, y: 3.5, w: 6, d: 8.8, h: 6, name: "Boiler · furnace · drum · economiser", vendor: true });
  bBox({ x: 91, y: 4.5, w: 3.6, d: 4, h: 4, name: "Dry scrubber · ESP · ID fan", vendor: true });
  const ch = add(cylM(0.55, 0.7, 10, CONCRETE(), 24)); at(ch, 95.2, 13, FLOOR_Z + 5);
  label(W2(95.2, 13, FLOOR_Z + 10.6), "<b>C-01 chimney</b>", "nm", { prio: 4 });
  bBox({ x: 82.5, y: 21.6, w: 7.5, d: 4.4, h: 2.3, name: "Steam turbine + gearbox + alternator", vendor: true });
  bCondenser({ x: 84, y: 30, len: 3.4, name: "SC-01 turbine surface condenser" });
  bBox({ x: 86, y: 34.2, w: 7, d: 6, h: 3, name: "WTP · deaerator · boiler feed (sheet 12)", vendor: true });
  void A;
}


// ------------------------------------------------------------------ state
let renderer, scene, camera, controls, wrap, labelBox, panel, raf = 0, clock, live = null, helpers = null, onPick = null;
let pickables = [], machines = {}, levels = [], switches = [], flows = [], labels = [], selected = null, fly = null, framed = null;
let pipeMeshes = [], isoSvc = null, faintMat = null;
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();

// ------------------------------------------------------------------ materials
const matCache = {};
function mat(color, o = {}) {
  const k = `${color}|${o.metal ?? 0.1}|${o.rough ?? 0.75}|${o.opacity ?? 1}`;
  if (o.unique || !matCache[k]) {
    const m = new THREE.MeshStandardMaterial({ color, metalness: o.metal ?? 0.1, roughness: o.rough ?? 0.75,
      transparent: (o.opacity ?? 1) < 1, opacity: o.opacity ?? 1, depthWrite: (o.opacity ?? 1) > 0.6, side: o.side ?? THREE.FrontSide });
    if (o.unique) return m;
    matCache[k] = m;
  }
  return matCache[k];
}
const STEEL = () => mat(0xd5dade, { metal: 0.88, rough: 0.3 });          // brushed stainless
const STEEL_DK = () => mat(0x6b737b, { metal: 0.6, rough: 0.42 });
const CONCRETE = () => mat(0xc2c4bd, { rough: 0.95 });
const PAINT = (c) => mat(c, { metal: 0.15, rough: 0.6 });               // painted steel (matte)
const FRAME = () => mat(0x1f4f9e, { metal: 0.35, rough: 0.5 });          // structural steel, blue
const RAIL = () => mat(0xf2b400, { metal: 0.25, rough: 0.5 });           // handrails, yellow
const GRATE = () => mat(0x50565c, { metal: 0.5, rough: 0.6 });
const HDPE = (c = 0x2b2f33) => mat(c, { metal: 0.05, rough: 0.55 });     // plastic tanks
const liquidMat = (c) => mat(c, { metal: 0.05, rough: 0.18, opacity: 0.86 });
const motorMat = () => mat(ST.unk, { unique: true, metal: 0.15, rough: 0.55 });
const ST = { run: 0x46a414, stop: 0x9a9c94, trip: 0xd93a3f, warn: 0xe09a12, unk: 0xd9d9d2, open: 0x46a414, closed: 0x9a9c94 };

function add(mesh, parent = scene, shadow = true) { mesh.castShadow = shadow; mesh.receiveShadow = true; parent.add(mesh); return mesh; }
const boxM = (w, h, d, m) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
const cylM = (rt, rb, h, m, seg = 28, open = false) => new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg, 1, open), m);
function at(mesh, x, y, z) { mesh.position.copy(W2(x, y, z)); return mesh; }
function horiz(mesh, axis = "x") { if (axis === "x") mesh.rotation.z = Math.PI / 2; else mesh.rotation.x = Math.PI / 2; return mesh; }
const mark = (id, ...meshes) => meshes.forEach((m) => { m.userData.eq = id; pickables.push(m); });

// soft contact shadow decal
let blobTex = null;
function blob(x, y, w, d, op = 0.4, z = null) {
  if (!blobTex) {
    const cv = document.createElement("canvas"); cv.width = cv.height = 128;
    const c = cv.getContext("2d"), g = c.createRadialGradient(64, 64, 6, 64, 64, 64);
    g.addColorStop(0, "rgba(0,0,0,.8)"); g.addColorStop(0.5, "rgba(0,0,0,.4)"); g.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = g; c.fillRect(0, 0, 128, 128); blobTex = new THREE.CanvasTexture(cv);
  }
  const s = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, opacity: op, depthWrite: false, color: 0 }));
  s.rotation.x = -Math.PI / 2; s.renderOrder = 1; s.userData.blob = true; s.position.copy(W2(x, y, (z ?? FLOOR_Z) + 0.004)); scene.add(s);
}

// ------------------------------------------------------------------ labels (HTML overlay)
function label(pos, html, cls = "", o = {}) {
  const el = document.createElement("div");
  el.className = `p3-lb ${cls}`;
  el.innerHTML = html;
  if (o.eq) { el.dataset.eq = o.eq; el.onclick = (e) => { e.stopPropagation(); select(o.eq); }; }
  if (o.area) { el.dataset.area = o.area; el.onclick = (e) => { e.stopPropagation(); zoomArea(o.area); }; el.title = "Zoom to this area"; }
  labelBox.appendChild(el);
  const l = { pos: pos.clone(), el, cls, prio: o.prio ?? 3, ...o };
  labels.push(l);
  return l;
}

// ------------------------------------------------------------------ floor
const FLOOR_Z = 0.15;
function buildFloor() {
  const b = PLANT.bounds;
  const g = add(new THREE.Mesh(new THREE.PlaneGeometry(400, 400), mat(0xd9dcd6, { rough: 1 })), scene, false);
  g.rotation.x = -Math.PI / 2; g.position.y = -0.01;
  // plant slab with kerb (bounded floor)
  const slab = add(boxM(b.w, FLOOR_Z, b.d, mat(0xc9ccc5, { rough: 0.95 })), scene, false);
  at(slab, b.x + b.w / 2, b.y + b.d / 2, FLOOR_Z / 2);
  const kerb = mat(0xa8aba4, { rough: 0.9 });
  for (const [w, d, x, y] of [[b.w, 0.25, b.x + b.w / 2, b.y], [b.w, 0.25, b.x + b.w / 2, b.y + b.d], [0.25, b.d, b.x, b.y + b.d / 2], [0.25, b.d, b.x + b.w, b.y + b.d / 2]]) {
    at(add(boxM(w, 0.35, d, kerb), scene, false), x, y, 0.175);
  }
  // process areas: tinted pads with a painted boundary line; service aisles between them (bare slab + walkway arrows)
  for (const a of PLANT.areas) {
    const pad = add(boxM(a.w, 0.02, a.d, mat(a.tint, { rough: 0.95 })), scene, false);
    at(pad, a.x + a.w / 2, a.y + a.d / 2, FLOOR_Z + 0.01);
    const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([W2(a.x, a.y, FLOOR_Z + 0.025), W2(a.x + a.w, a.y, FLOOR_Z + 0.025), W2(a.x + a.w, a.y + a.d, FLOOR_Z + 0.025), W2(a.x, a.y + a.d, FLOOR_Z + 0.025)]),
      new THREE.LineBasicMaterial({ color: 0xd9a400 }));
    scene.add(line);
    label(W2(a.x + 0.6, a.y + a.d - 0.6, FLOOR_Z + 0.05), `<b>${esc(a.name)}</b>`, "area", { area: a.id, prio: 0, anchor: "left" });
  }
  for (const s of PLANT.aisles || []) {
    const st = add(boxM(s.w, 0.015, s.d, mat(0xb9bcb5, { rough: 1 })), scene, false); at(st, s.x + s.w / 2, s.y + s.d / 2, FLOOR_Z + 0.008);
  }
}

// ------------------------------------------------------------------ shared machine parts
function lampOn(g, x, y, z) {
  const l = add(new THREE.Mesh(new THREE.SphereGeometry(0.09, 14, 10), new THREE.MeshStandardMaterial({ color: ST.unk, emissive: 0 })), g);
  return at(l, x, y, z);
}
function haloRing(r, x, y, z = FLOOR_Z) {
  const m = new THREE.MeshBasicMaterial({ color: 0x46c21b, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.RingGeometry(r * 0.8, r, 48), m);
  ring.rotation.x = -Math.PI / 2; ring.position.copy(W2(x, y, z + 0.02)); ring.visible = false; scene.add(ring);
  return ring;
}
function selRing(r, x, y, z) {                       // selection highlight: blue ring, hidden until selected
  const ring = new THREE.Mesh(new THREE.RingGeometry(r * 0.9, r, 56), new THREE.MeshBasicMaterial({ color: 0x2f7ff5, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.copy(W2(x, y, z + 0.03)); ring.visible = false; ring.renderOrder = 4; scene.add(ring);
  return ring;
}
function motorCyl(g, m, len, r, x, y, z, axis = "x") {   // finned motor body + fan cover
  const body = horiz(add(cylM(r, r, len, m, 24), g), axis); at(body, x, y, z);
  const n = Math.round(len / 0.09);
  for (let i = 0; i < n; i++) {
    const f = add(new THREE.Mesh(new THREE.TorusGeometry(r + 0.01, 0.016, 6, 22), m), g, false);
    if (axis === "x") f.rotation.y = Math.PI / 2; else f.rotation.x = 0;
    const o = -len / 2 + (i + 0.5) * (len / n);
    at(f, axis === "x" ? x + o : x, axis === "x" ? y : y + o, z);
  }
  const fc = horiz(add(cylM(r * 0.88, r, 0.1, STEEL_DK(), 20), g), axis);
  at(fc, axis === "x" ? x - len / 2 - 0.05 : x, axis === "x" ? y : y - len / 2 - 0.05, z);
  return body;
}
function register(id, o) {                           // a machine bound to live data
  machines[id] = { id, mats: o.mats || [], lamp: o.lamp || null, rot: o.rot || null, halo: o.halo || null, sel: o.sel || null,
    lb: o.lb || null, kind: o.kind || "pump", at: o.at, readings: o.readings || [], area: o.area, service: o.service || "", vendor: !!o.vendor };
}

// ------------------------------------------------------------------ steel details
function member(a, b, size, m, round = false) {
  const A = W2(...a), B = W2(...b), len = A.distanceTo(B);
  if (len < 0.01) return null;
  const mesh = add(round ? cylM(size, size, len, m, 8) : boxM(size, len, size, m), scene, !round);
  mesh.position.copy(A).add(B).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  return mesh;
}
function railing(pts, z, closed = true) {
  const P = closed ? [...pts, pts[0]] : pts, m = RAIL();
  for (let i = 0; i < P.length - 1; i++) {
    const [x0, y0] = P[i], [x1, y1] = P[i + 1], n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 1.4));
    for (let k = 0; k < n; k++) { const x = x0 + ((x1 - x0) * k) / n, y = y0 + ((y1 - y0) * k) / n; member([x, y, z], [x, y, z + 1.0], 0.026, m, true); }
    member([x0, y0, z + 1.0], [x1, y1, z + 1.0], 0.03, m, true);
    member([x0, y0, z + 0.5], [x1, y1, z + 0.5], 0.02, m, true);
  }
}
function ladder(x, y, z0, z1, dx, dy) {
  const m = RAIL(), px = -dy * 0.22, py = dx * 0.22, ox = x + dx * 0.16, oy = y + dy * 0.16;
  for (const s of [1, -1]) member([ox + px * s, oy + py * s, z0], [ox + px * s, oy + py * s, z1 + 1.0], 0.028, m, true);
  for (let z = z0 + 0.3; z < z1; z += 0.3) member([ox + px, oy + py, z], [ox - px, oy - py, z], 0.016, m, true);
}
const ring4 = (x, y, w, d) => [[x, y], [x + w, y], [x + w, y + d], [x, y + d]];

// ------------------------------------------------------------------ level helpers (live)
function levelOf(o) {                                // 0..1 or null
  if (o.lt) { const p = helpers.pct(o.lt); return p == null ? null : Math.max(0, Math.min(1, p / 100)); }
  if (o.sw) { const hi = helpers.sw(o.sw[0]), lo = helpers.sw(o.sw[o.sw.length - 1]); if (hi == null && lo == null) return null; return hi ? 0.88 : lo === false ? 0.1 : 0.55; }
  return o.fill ?? 0.6;
}
function levelText(o, f) {
  if (o.lt) return helpers.tagTxt(o.lt) || "no data";
  if (o.sw) return f == null ? "no data" : f >= 0.85 ? "high (float sw.)" : f <= 0.15 ? "low (float sw.)" : "normal (float sw.)";
  return "";
}
function nameLabel(o, z) {                           // vessel / basin name + level text
  const lb = label(W2(o.x + (o.w ? o.w / 2 : 0), o.y + (o.d ? o.d / 2 : 0), z), `<b>${esc(o.tag || o.name)}</b><span class="sub"></span>`, "nm", { prio: 2 });
  lb.el.title = o.name;
  return lb;
}

// ------------------------------------------------------------------ basins, tanks, hoppers
// open RCC basin (screening chamber, sludge / filtrate tank, raw water sump ...): walls, liquid surface, handrail
function bBasin(o) {
  const g = new THREE.Group(), th = o.mat ? 0.08 : 0.22, top = FLOOR_Z + o.h, m = o.mat ? PAINT(o.mat) : CONCRETE();
  const wall = (w, d, x, y) => at(add(boxM(w, o.h, d, m), g), x, y, FLOOR_Z + o.h / 2);
  wall(o.w, th, o.x + o.w / 2, o.y + th / 2); wall(o.w, th, o.x + o.w / 2, o.y + o.d - th / 2);
  wall(th, o.d, o.x + th / 2, o.y + o.d / 2); wall(th, o.d, o.x + o.w - th / 2, o.y + o.d / 2);
  const liq = add(boxM(o.w - 2 * th, 1, o.d - 2 * th, liquidMat(PLANT.services[o.fluid].color)), g, false);
  at(liq, o.x + o.w / 2, o.y + o.d / 2, FLOOR_Z);
  if (o.cover) { const c = add(boxM(o.w, 0.05, o.d * 0.35, GRATE()), g); at(c, o.x + o.w / 2, o.y + o.d * 0.18, top + 0.03); }
  scene.add(g);
  blob(o.x + o.w / 2, o.y + o.d / 2, o.w + 1, o.d + 1, 0.35);
  if (o.rail !== false) railing(ring4(o.x, o.y, o.w, o.d), top);
  const lb = nameLabel(o, top + 1.4);
  levels.push({ update() { const f = levelOf(o), h = Math.max(0.04, (o.h - 0.3) * (f ?? 0)); liq.visible = f != null && f > 0.01; liq.scale.y = h; liq.position.y = FLOOR_Z + 0.02 + h / 2; lb.el.querySelector(".sub").textContent = levelText(o, f); } });
}
// vertical tank: steel / HDPE / FRP shell, dished / cone / flat top, flat or cone bottom on legs, sight gauge = live level
function bTank(o) {
  const g = new THREE.Group(), r = o.r, z0 = FLOOR_Z + (o.cone ? o.legs ?? 1.2 : 0.05), shellH = o.h;
  const m = o.mat === "hdpe" ? HDPE(o.color ?? 0x2b2f33) : o.mat === "frp" ? mat(o.color ?? 0x6f8f7a, { rough: 0.5, metal: 0.05 }) : o.mat === "paint" ? PAINT(o.color ?? 0x8ea0b4) : STEEL();
  const shell = at(add(cylM(r, r, shellH, m, 40), g), o.x, o.y, z0 + shellH / 2);
  if (o.cone) {                                       // cone bottom (hopper) + legs
    const cone = at(add(cylM(r, 0.18, o.cone, m, 40), g), o.x, o.y, z0 - o.cone / 2);
    for (let i = 0; i < 4; i++) { const a = Math.PI / 4 + (i * Math.PI) / 2; member([o.x + Math.cos(a) * r * 0.92, o.y + Math.sin(a) * r * 0.92, FLOOR_Z], [o.x + Math.cos(a) * r * 0.92, o.y + Math.sin(a) * r * 0.92, z0 + 0.3], 0.1, STEEL_DK()); }
    void cone;
  } else at(add(cylM(r + 0.12, r + 0.12, 0.1, CONCRETE(), 32), g), o.x, o.y, FLOOR_Z + 0.05);   // plinth
  if (o.top === "dish") { const h = add(new THREE.Mesh(new THREE.SphereGeometry(r, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), m), g); h.scale.y = 0.3; at(h, o.x, o.y, z0 + shellH); }
  else if (o.top === "cone") at(add(cylM(0.15, r, r * 0.45, m, 36), g), o.x, o.y, z0 + shellH + r * 0.225);
  else if (o.top !== "open") at(add(cylM(r, r, 0.05, m, 36), g), o.x, o.y, z0 + shellH);
  for (const z of [z0 + 0.05, z0 + shellH - 0.05]) { const ring = add(new THREE.Mesh(new THREE.TorusGeometry(r + 0.015, 0.03, 6, 40), STEEL_DK()), g, false); ring.rotation.x = Math.PI / 2; at(ring, o.x, o.y, z); }
  // sight gauge on the front (south) side: transparent tube, coloured fill = level
  const gx = o.x, gy = o.y - r - 0.06;
  at(add(cylM(0.045, 0.045, shellH * 0.9, mat(0xffffff, { opacity: 0.35, rough: 0.1 }), 10), g, false), gx, gy, z0 + shellH / 2);
  const fill = at(add(cylM(0.035, 0.035, 1, mat(PLANT.services[o.fluid].color, { rough: 0.3 }), 10), g, false), gx, gy, z0);
  scene.add(g);
  blob(o.x, o.y, r * 2.8, r * 2.8, 0.38);
  if (o.pick) mark(o.pick, shell);
  const lb = o.noLabel ? null : nameLabel({ ...o, w: 0, d: 0 }, z0 + shellH + (o.top === "dish" || o.top === "cone" ? r * 0.5 : 0) + 0.9);
  levels.push({ update() { const f = levelOf(o), h = Math.max(0.02, shellH * 0.9 * (f ?? 0)); fill.visible = f != null; fill.scale.y = h; fill.position.y = z0 + shellH * 0.05 + h / 2; if (lb) lb.el.querySelector(".sub").textContent = levelText(o, f); } });
  return { top: z0 + shellH, z0 };
}
// generic package / building block (panel room, boiler, turbine ...): vendor scope = dashed outline on the floor
function bBox(o) {
  const g = new THREE.Group();
  const b = at(add(boxM(o.w, o.h, o.d, o.vendor ? mat(o.color ?? 0xc9c3b4, { rough: 0.8 }) : PAINT(o.color ?? 0x9aa6b2)), g), o.x + o.w / 2, o.y + o.d / 2, FLOOR_Z + o.h / 2);
  void b;
  scene.add(g);
  if (o.vendor) vendorOutline(o.x - 0.3, o.y - 0.3, o.w + 0.6, o.d + 0.6);
  blob(o.x + o.w / 2, o.y + o.d / 2, o.w + 1, o.d + 1, 0.3);
  label(W2(o.x + o.w / 2, o.y + o.d / 2, FLOOR_Z + o.h + 0.8), `<b>${esc(o.name)}</b>${o.vendor ? '<span class="sub">vendor</span>' : ""}`, "nm", { prio: 3 });
}
function vendorOutline(x, y, w, d) {                // vendor scope marking: dashed grey boundary on the floor (separate from pipe colours)
  const pts = [W2(x, y, FLOOR_Z + 0.03), W2(x + w, y, FLOOR_Z + 0.03), W2(x + w, y + d, FLOOR_Z + 0.03), W2(x, y + d, FLOOR_Z + 0.03), W2(x, y, FLOOR_Z + 0.03)];
  const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: 0x50565e, dashSize: 0.35, gapSize: 0.22 }));
  l.computeLineDistances(); scene.add(l);
}

// ------------------------------------------------------------------ pumps
// horizontal centrifugal pump on a skid: concrete plinth, baseplate, finned motor (state colour), coupling guard, volute
function bSkidPump(o) {
  const g = new THREE.Group(), s = o.size ?? 1, mm = motorMat();
  g.position.copy(W2(o.x, o.y, FLOOR_Z)); g.rotation.y = ((o.heading ?? 0) * Math.PI) / 180; g.scale.setScalar(s);
  const plinth = add(boxM(1.7, 0.1, 0.8, CONCRETE()), g); plinth.position.y = 0.05;
  const base = add(boxM(1.5, 0.1, 0.6, STEEL_DK()), g); base.position.y = 0.15;
  const motor = add(cylM(0.25, 0.25, 0.66, mm, 24), g); motor.rotation.z = Math.PI / 2; motor.position.set(-0.36, 0.48, 0);
  for (let i = -3; i <= 3; i++) { const f = add(new THREE.Mesh(new THREE.TorusGeometry(0.255, 0.018, 6, 22), mm), g, false); f.rotation.y = Math.PI / 2; f.position.set(-0.36 + i * 0.085, 0.48, 0); }
  const fc = add(cylM(0.22, 0.25, 0.1, STEEL_DK(), 20), g); fc.rotation.z = Math.PI / 2; fc.position.set(-0.74, 0.48, 0);
  const tb = add(boxM(0.18, 0.12, 0.16, mm), g); tb.position.set(-0.36, 0.77, 0);
  const spin = new THREE.Group(); spin.position.set(0.06, 0.48, 0);
  for (let i = 0; i < 3; i++) { const k = add(boxM(0.04, 0.3, 0.05, RAIL()), spin, false); k.rotation.x = (i * Math.PI) / 3; }
  g.add(spin);
  const vol = add(cylM(0.3, 0.3, 0.24, PAINT(0x2257b5), 26), g); vol.rotation.x = Math.PI / 2; vol.position.set(0.36, 0.48, 0);
  const ped = add(boxM(0.18, 0.28, 0.26, PAINT(0x1f4ea6)), g); ped.position.set(0.17, 0.34, 0);
  const suc = add(cylM(0.09, 0.09, 0.26, PAINT(0x2257b5), 12), g); suc.rotation.z = Math.PI / 2; suc.position.set(0.62, 0.48, 0);
  const dis = add(cylM(0.08, 0.08, 0.3, PAINT(0x2257b5), 12), g); dis.position.set(0.36, 0.88, 0);
  const lamp = add(new THREE.Mesh(new THREE.SphereGeometry(0.08, 14, 10), new THREE.MeshStandardMaterial({ color: ST.unk })), g); lamp.position.set(-0.36, 0.92, 0);
  scene.add(g);
  blob(o.x, o.y, 2.2 * s, 1.2 * s, 0.42);
  if (!o.id) {                                       // pump without a panel signal (vendor): fixed grey motor, name tag
    mm.color.setHex(0x8f969c);
    label(W2(o.x, o.y, FLOOR_Z + 1.3 * s), `<b>${esc(o.name)}</b>${o.vendor ? '<span class="sub">vendor</span>' : ""}`, "nm", { prio: 3 });
    return;
  }
  mark(o.id, plinth, base, motor, vol, tb, lamp);
  const lb = label(W2(o.x, o.y, FLOOR_Z + 1.3 * s), "", "eq", { eq: o.id, prio: 2 });
  register(o.id, { mats: [mm], lamp, lb, rot: { obj: spin, axis: "x", speed: 14 }, halo: haloRing(1.1 * s, o.x, o.y), sel: selRing(1.25 * s, o.x, o.y, FLOOR_Z), area: o.area, service: o.service, readings: o.readings, at: [o.x, o.y] });
}
// submersible pump in a sump / tank: guide rails + discharge column up to a hatch on the cover; motor pod at the bottom
// (seen through the liquid), status lamp + tag on the hatch - clearly different from a skid pump
function bSubPump(o) {
  const g = new THREE.Group(), mm = motorMat(), zb = o.zb ?? FLOOR_Z + 0.1, zt = o.zt;
  const pod = at(add(cylM(0.2, 0.2, 0.6, mm, 20), g), o.x, o.y, zb + 0.45);
  at(add(cylM(0.26, 0.26, 0.16, PAINT(0x2257b5), 20), g), o.x, o.y, zb + 0.08);
  for (const dx of [-0.16, 0.16]) member([o.x + dx, o.y + 0.28, zb], [o.x + dx, o.y + 0.28, zt], 0.022, STEEL(), true);   // guide rails
  member([o.x, o.y + 0.25, zb + 0.2], [o.x, o.y + 0.25, zt + 0.25], 0.07, STEEL(), true);                                    // riser
  const hatch = at(add(boxM(0.8, 0.06, 0.8, GRATE()), g), o.x, o.y, zt + 0.03);
  const lamp = at(add(new THREE.Mesh(new THREE.SphereGeometry(0.08, 14, 10), new THREE.MeshStandardMaterial({ color: ST.unk })), g), o.x - 0.28, o.y - 0.28, zt + 0.12);
  scene.add(g);
  mark(o.id, pod, hatch, lamp);
  const lb = label(W2(o.x, o.y, zt + 0.7), "", "eq", { eq: o.id, prio: 2 });
  register(o.id, { mats: [mm], lamp, lb, halo: haloRing(0.6, o.x, o.y, zt), sel: selRing(0.75, o.x, o.y, zt), area: o.area, service: o.service, readings: o.readings, at: [o.x, o.y], kind: "sub" });
}
// dosing skid: small chemical tank (HDPE) + dosing pump on a bracket
function bDosing(o) {
  bTank({ x: o.x, y: o.y, r: 0.45, h: 1.1, mat: "hdpe", color: o.color ?? 0xd9dde2, fluid: "chem", fill: 0.6, name: o.tankName, tag: o.tankTag, top: "flat" });
  if (!o.id) return;
  const g = new THREE.Group(), mm = motorMat(), px = o.x + 0.75, py = o.y;
  at(add(boxM(0.5, 0.3, 0.4, STEEL_DK()), g), px, py, FLOOR_Z + 0.15);
  const head = at(add(cylM(0.12, 0.12, 0.14, PAINT(0x2257b5), 16), g), px + 0.1, py, FLOOR_Z + 0.42); head.rotation.x = Math.PI / 2;
  const mot = at(add(cylM(0.11, 0.11, 0.3, mm, 16), g), px - 0.1, py, FLOOR_Z + 0.42); mot.rotation.z = Math.PI / 2;
  const lamp = at(add(new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), new THREE.MeshStandardMaterial({ color: ST.unk })), g), px - 0.1, py, FLOOR_Z + 0.6);
  scene.add(g);
  mark(o.id, head, mot, lamp);
  const lb = label(W2(px, py, FLOOR_Z + 0.95), "", "eq", { eq: o.id, prio: 2 });
  register(o.id, { mats: [mm], lamp, lb, halo: haloRing(0.5, px, py), sel: selRing(0.6, px, py, FLOOR_Z), area: o.area, service: o.service, readings: o.readings, at: [px, py] });
}
// progressive cavity pump: dark rubber stator + tie rods, suction housing with inlet on top, gearbox + motor in line
function bPCP(o) {
  const g = new THREE.Group(), mm = motorMat(), ax = 0.5;
  g.position.copy(W2(o.x, o.y, FLOOR_Z)); g.rotation.y = ((o.heading ?? 0) * Math.PI) / 180;
  const plinth = add(boxM(3.0, 0.1, 0.8, CONCRETE()), g); plinth.position.set(-0.35, 0.05, 0);
  const base = add(boxM(2.8, 0.1, 0.6, STEEL_DK()), g); base.position.set(-0.35, 0.15, 0);
  const motor = add(cylM(0.24, 0.24, 0.55, mm, 22), g); motor.rotation.z = Math.PI / 2; motor.position.set(-1.38, ax, 0);
  const gb = add(boxM(0.24, 0.4, 0.36, PAINT(0x1f4ea6)), g); gb.position.set(-0.98, ax, 0);
  const sh = add(cylM(0.04, 0.04, 0.24, STEEL(), 10), g); sh.rotation.z = Math.PI / 2; sh.position.set(-0.76, ax, 0);
  const spin = new THREE.Group(); spin.position.set(-0.76, ax, 0);
  for (let i = 0; i < 3; i++) { const k = add(boxM(0.04, 0.3, 0.05, RAIL()), spin, false); k.rotation.x = (i * Math.PI) / 3; }
  g.add(spin);
  const house = add(boxM(0.32, 0.48, 0.46, PAINT(0x2257b5)), g); house.position.set(-0.5, ax, 0);
  const inl = add(cylM(0.1, 0.1, 0.3, PAINT(0x2257b5), 12), g); inl.position.set(-0.5, ax + 0.38, 0);
  const st = add(cylM(0.2, 0.2, 1.24, mat(0x3f454d, { rough: 0.7 }), 26), g); st.rotation.z = Math.PI / 2; st.position.set(0.3, ax, 0);
  for (const bx of [-0.32, 0.92]) { const f = add(cylM(0.27, 0.27, 0.07, STEEL(), 22), g); f.rotation.z = Math.PI / 2; f.position.set(bx, ax, 0); }
  for (const [dy, dz] of [[0.2, 0.2], [0.2, -0.2], [-0.2, 0.2], [-0.2, -0.2]]) { const rd = add(cylM(0.018, 0.018, 1.26, STEEL_DK(), 8), g, false); rd.rotation.z = Math.PI / 2; rd.position.set(0.3, ax + dy, dz); }
  const lamp = add(new THREE.Mesh(new THREE.SphereGeometry(0.08, 14, 10), new THREE.MeshStandardMaterial({ color: ST.unk })), g); lamp.position.set(-1.38, 0.88, 0);
  scene.add(g);
  blob(o.x - 0.35, o.y, 3.4, 1.2, 0.42);
  mark(o.id, plinth, base, motor, gb, house, st, lamp);
  const lb = label(W2(o.x - 0.3, o.y, FLOOR_Z + 1.3), "", "eq", { eq: o.id, prio: 2 });
  register(o.id, { mats: [mm], lamp, lb, rot: { obj: spin, axis: "x", speed: 5 }, halo: haloRing(1.7, o.x - 0.35, o.y), sel: selRing(1.9, o.x - 0.35, o.y, FLOOR_Z), area: o.area, service: o.service, readings: o.readings, at: [o.x, o.y] });
}
// centrifugal blower: scroll casing + outlet duct + motor
function bBlower(o) {
  const g = new THREE.Group(), mm = motorMat();
  at(add(boxM(1.6, 0.14, 0.9, STEEL_DK()), g), o.x, o.y, FLOOR_Z + 0.07);
  const scr = at(add(cylM(0.55, 0.55, 0.42, PAINT(0x2257b5), 28), g), o.x + 0.3, o.y, FLOOR_Z + 0.75); scr.rotation.x = Math.PI / 2;
  at(add(boxM(0.42, 0.9, 0.38, PAINT(0x2257b5)), g), o.x + 0.65, o.y, FLOOR_Z + 1.3);
  const mot = at(add(cylM(0.24, 0.24, 0.6, mm, 22), g), o.x - 0.45, o.y, FLOOR_Z + 0.45); mot.rotation.z = Math.PI / 2;
  const lamp = at(add(new THREE.Mesh(new THREE.SphereGeometry(0.08, 14, 10), new THREE.MeshStandardMaterial({ color: ST.unk })), g), o.x - 0.45, o.y, FLOOR_Z + 0.8);
  scene.add(g);
  blob(o.x, o.y, 2.1, 1.3, 0.4);
  mark(o.id, scr, mot, lamp);
  const lb = label(W2(o.x, o.y, FLOOR_Z + 2.2), "", "eq", { eq: o.id, prio: 2 });
  register(o.id, { mats: [mm], lamp, lb, halo: haloRing(1.1, o.x, o.y), sel: selRing(1.25, o.x, o.y, FLOOR_Z), area: o.area, service: o.service, readings: o.readings, at: [o.x, o.y] });
}
// top-entry agitator on a tank / basin: bridge + motor + gearbox, shaft with blades turning while running
function bAgitator(o) {
  const g = new THREE.Group(), mm = motorMat(), z = o.z;
  at(add(boxM(o.span ?? 0.6, 0.14, 0.5, STEEL_DK()), g), o.x, o.y, z + 0.07);
  const mot = at(add(cylM(0.26, 0.26, 0.6, mm, 22), g), o.x, o.y, z + 0.6);
  at(add(boxM(0.44, 0.24, 0.44, PAINT(0x1f4ea6)), g), o.x, o.y, z + 0.26);
  const rot = new THREE.Group(); rot.position.copy(W2(o.x, o.y, 0));
  const sh = add(cylM(0.04, 0.04, z - FLOOR_Z - 0.3, STEEL(), 8), rot); sh.position.y = (z + FLOOR_Z + 0.3) / 2;
  for (let i = 0; i < 3; i++) { const b = add(boxM(0.9, 0.04, 0.2, STEEL()), rot); b.position.set(Math.cos((i / 3) * 6.283) * 0.4, FLOOR_Z + 0.6, Math.sin((i / 3) * 6.283) * 0.4); b.rotation.y = -(i / 3) * 6.283; b.rotation.x = 0.4; }
  g.add(rot); scene.add(g);
  const lamp = at(add(new THREE.Mesh(new THREE.SphereGeometry(0.08, 14, 10), new THREE.MeshStandardMaterial({ color: ST.unk })), scene), o.x, o.y, z + 1.0);
  mark(o.id, mot, lamp);
  const lb = label(W2(o.x, o.y, z + 1.5), "", "eq", { eq: o.id, prio: 2 });
  register(o.id, { mats: [mm], lamp, lb, rot: { obj: rot, axis: "y", speed: 1.6 }, sel: selRing(0.7, o.x, o.y, z + 0.15), area: o.area, service: o.service, readings: o.readings, at: [o.x, o.y], kind: "agit" });
}
// motorised on-off valve: body + actuator (colour = limit-switch state)
function bValve(o) {
  const g = new THREE.Group(), am = motorMat(), a = o.axis === "y";
  const body = at(add(new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), STEEL()), g), o.x, o.y, o.z);
  const fl = at(add(cylM(0.15, 0.15, 0.55, STEEL_DK(), 14), g), o.x, o.y, o.z); if (a) fl.rotation.x = Math.PI / 2; else fl.rotation.z = Math.PI / 2;
  member([o.x, o.y, o.z + 0.2], [o.x, o.y, o.z + 0.45], 0.03, STEEL(), true);
  const act = at(add(boxM(0.38, 0.28, 0.3, am), g), o.x, o.y, o.z + 0.6);
  scene.add(g);
  mark(o.id, body, act);
  const lb = label(W2(o.x, o.y, o.z + 1.2), "", "eq", { eq: o.id, prio: 2 });
  register(o.id, { mats: [am], lb, sel: selRing(0.45, o.x, o.y, FLOOR_Z), area: o.area, service: o.service, readings: o.readings, at: [o.x, o.y], kind: "valve" });
}
// transmitter on a stand (LT / PT / TT / pH): blue head, live value tag
function bTx(o) {
  member([o.x, o.y, FLOOR_Z], [o.x, o.y, o.z], 0.03, STEEL_DK(), true);
  const head = at(add(cylM(0.14, 0.14, 0.2, PAINT(0x2f6fb5), 16)), o.x, o.y, o.z + 0.08); head.rotation.x = Math.PI / 2;
  head.userData.tag = o.tid; pickables.push(head);
  const lb = label(W2(o.x, o.y, o.z + 0.45), "", "tx", { prio: 1 });
  lb.tid = o.tid; lb.name = o.name;
  lb.el.onclick = (e) => { e.stopPropagation(); if (window.MD && MD.openTag) MD.openTag(o.tid); };
}
// float switch: small ball on the tank wall, lights up when ON
function bSwitch(key, x, y, z) {
  const m = new THREE.MeshStandardMaterial({ color: 0xbdbdb5, emissive: 0 });
  at(add(new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 8), m), scene, false), x, y, z);
  switches.push({ key, m });
}

// ------------------------------------------------------------------ process packages
// volute press: skid frame with TWO inclined screw housings (dewatering drums with ring bands), drive at the upper end,
// filtrate trough underneath, cake chute at the discharge end
function bVolute(o) {
  const g = new THREE.Group(), L = o.len ?? 4.2, tilt = THREE.MathUtils.degToRad(o.tilt ?? 12);
  at(add(boxM(L + 0.6, 0.12, 2.2, STEEL_DK()), g), o.x + L / 2, o.y, FLOOR_Z + 0.06);
  for (const [dx, dy] of [[0, -0.9], [0, 0.9], [L, -0.9], [L, 0.9]]) member([o.x + dx, o.y + dy, FLOOR_Z], [o.x + dx, o.y + dy, FLOOR_Z + 0.9 + (dx ? L * Math.tan(tilt) : 0)], 0.12, FRAME());
  const trough = at(add(boxM(L, 0.3, 2.0, PAINT(0x9aa6b2)), g), o.x + L / 2, o.y, FLOOR_Z + 0.45);
  void trough;
  const drums = [];
  for (const dy of [-0.48, 0.48]) {
    const z0 = FLOOR_Z + 1.05, zc = z0 + (L / 2) * Math.tan(tilt);
    const d = add(cylM(0.36, 0.36, L, STEEL(), 30), g); d.rotation.z = Math.PI / 2 - tilt; d.rotation.order = "ZYX";
    at(d, o.x + L / 2, o.y + dy, zc);
    for (let i = 0; i <= 8; i++) { const t = i / 8, band = add(new THREE.Mesh(new THREE.TorusGeometry(0.37, 0.025, 6, 26), STEEL_DK()), g, false); band.rotation.y = Math.PI / 2; band.rotation.x = 0; band.rotation.z = -tilt; at(band, o.x + t * L, o.y + dy, z0 + t * L * Math.tan(tilt)); }
    const mot = at(add(cylM(0.18, 0.18, 0.5, motorMat(), 18), g), o.x + L + 0.35, o.y + dy, z0 + L * Math.tan(tilt)); mot.rotation.z = Math.PI / 2;
    drums.push(d);
  }
  // cake chute under the high (discharge) end; filtrate outlet box at the low (feed) end
  at(add(boxM(0.5, 0.8, 1.5, PAINT(0x9aa6b2)), g), o.x + L - 0.15, o.y, FLOOR_Z + 0.75 + L * Math.tan(tilt));
  at(add(boxM(0.4, 0.3, 0.5, PAINT(0x9aa6b2)), g), o.x - 0.15, o.y - 0.6, FLOOR_Z + 0.45);
  for (const dy of [-0.48, 0.48]) at(add(boxM(0.5, 0.5, 0.5, PAINT(0x9aa6b2)), g), o.x + 0.15, o.y + dy, FLOOR_Z + 1.75);   // feed funnels
  scene.add(g);
  vendorOutline(o.x - 0.7, o.y - 1.4, L + 1.6, 2.8);
  blob(o.x + L / 2, o.y, L + 1.4, 2.8, 0.35);
  label(W2(o.x + L / 2, o.y, FLOOR_Z + 1.9 + L * Math.tan(tilt)), `<b>${esc(o.name)}</b><span class="sub">vendor</span>`, "nm", { prio: 2 });
}
// vacuum paddle dryer: horizontal jacketed trough body on saddles, vapour dome, feed inlet, discharge, drive end
function bDryer(o) {
  const g = new THREE.Group(), L = o.len ?? 5.5, z = FLOOR_Z + 1.2;
  const body = at(add(cylM(0.75, 0.75, L, PAINT(0xc8ccd0), 36), g), o.x + L / 2, o.y, z); body.rotation.z = Math.PI / 2;
  for (const e of [0, L]) { const cap = at(add(cylM(0.8, 0.8, 0.12, STEEL_DK(), 36), g), o.x + e, o.y, z); cap.rotation.z = Math.PI / 2; }
  for (const t of [0.15, 0.5, 0.85]) at(add(boxM(0.25, z - FLOOR_Z - 0.4, 1.2, FRAME()), g), o.x + t * L, o.y, FLOOR_Z + (z - FLOOR_Z - 0.4) / 2);
  at(add(cylM(0.35, 0.35, 0.6, PAINT(0xc8ccd0), 24), g), o.x + L * 0.62, o.y, z + 0.95);   // vapour dome
  at(add(boxM(0.6, 0.5, 0.6, PAINT(0xc8ccd0)), g), o.x + L * 0.2, o.y, z + 0.95);          // feed inlet
  at(add(boxM(0.5, 0.6, 0.5, PAINT(0xc8ccd0)), g), o.x + L * 0.9, o.y, z - 1.0);           // discharge
  // drive end: gearbox + motor
  at(add(boxM(0.7, 0.8, 0.8, PAINT(0x1f4ea6)), g), o.x - 0.55, o.y, FLOOR_Z + 0.8);
  const mot = at(add(cylM(0.28, 0.28, 0.8, PAINT(0x2257b5), 22), g), o.x - 1.35, o.y, FLOOR_Z + 0.8); mot.rotation.z = Math.PI / 2;
  scene.add(g);
  vendorOutline(o.x - 2, o.y - 1.3, L + 2.5, 2.6);
  blob(o.x + L / 2 - 0.5, o.y, L + 3, 2.6, 0.38);
  label(W2(o.x + L / 2, o.y, z + 1.9), `<b>${esc(o.name)}</b><span class="sub">vendor</span>`, "nm", { prio: 2 });
}
// cooling tower: concrete basin with water, louvred casing, fan deck with handrail, fan stack, fan (turns with its motor)
function bCT(o) {
  const g = new THREE.Group(), cx = o.x + o.w / 2, cy = o.y + o.d / 2, H = o.h;
  at(add(boxM(o.w + 0.5, 0.7, o.d + 0.5, CONCRETE()), g), cx, cy, FLOOR_Z + 0.35);
  at(add(boxM(o.w, 0.06, o.d, liquidMat(0x3f8fd8)), g, false), cx, cy, FLOOR_Z + 0.66);
  const body = at(add(boxM(o.w, H - 0.7, o.d, mat(0x9db3ad, { rough: 0.7 })), g), cx, cy, FLOOR_Z + 0.7 + (H - 0.7) / 2);
  for (let z = FLOOR_Z + 1.0; z < FLOOR_Z + H - 0.3; z += 0.26) {
    for (const [w, d, dx, dy] of [[o.w + 0.05, 0.05, 0, -o.d / 2], [o.w + 0.05, 0.05, 0, o.d / 2], [0.05, o.d + 0.05, -o.w / 2, 0], [0.05, o.d + 0.05, o.w / 2, 0]]) {
      const l = add(boxM(w, 0.05, d, STEEL_DK()), g, false); at(l, cx + dx, cy + dy, z); l.rotation.x = dy ? 0.5 * Math.sign(dy) : 0; l.rotation.z = dx ? -0.5 * Math.sign(dx) : 0;
    }
  }
  at(add(boxM(o.w + 0.1, 0.1, o.d + 0.1, GRATE()), g), cx, cy, FLOOR_Z + H);
  const rr = Math.min(o.w, o.d) * 0.36;
  const stack = at(add(cylM(rr, rr * 0.92, 0.9, mat(0xc9ced2, { metal: 0.5, rough: 0.4, side: THREE.DoubleSide }), 36, true), g), cx, cy, FLOOR_Z + H + 0.45);
  const fan = new THREE.Group(); fan.position.copy(W2(cx, cy, FLOOR_Z + H + 0.55));
  const fm = motorMat();
  const hub = add(cylM(0.2, 0.2, 0.22, fm, 16), fan);
  for (let i = 0; i < 6; i++) { const b = add(boxM(rr * 0.9, 0.04, 0.28, fm), fan); b.position.set(Math.cos((i / 6) * 6.283) * rr * 0.5, 0, Math.sin((i / 6) * 6.283) * rr * 0.5); b.rotation.y = -(i / 6) * 6.283; b.rotation.x = 0.35; }
  g.add(fan); scene.add(g);
  railing(ring4(o.x, o.y, o.w, o.d), FLOOR_Z + H);
  ladder(o.x + o.w + 0.25, cy, FLOOR_Z, FLOOR_Z + H, 1, 0);
  blob(cx, cy, o.w + 1.4, o.d + 1.4, 0.35);
  mark(o.fan, body, stack, hub);
  label(W2(o.x + 0.2, cy, FLOOR_Z + H + 1.9), `<b>${esc(o.name)}</b>`, "nm", { prio: 1 });
  const lb = label(W2(cx, cy, FLOOR_Z + H + 1.3), "", "eq", { eq: o.fan, prio: 2 });
  register(o.fan, { mats: [fm], lb, rot: { obj: fan, axis: "y", speed: 4.5 }, halo: haloRing(rr * 1.6, cx, cy, FLOOR_Z + H), sel: selRing(Math.max(o.w, o.d) * 0.78, cx, cy, FLOOR_Z), area: o.area, service: o.service, readings: o.readings, at: [cx, cy], kind: "fan" });
}
// plate heat exchanger: fixed + pressure plate, plate pack, tie bolts, nozzles
function bPHE(o) {
  const g = new THREE.Group(), L = o.len ?? 1.1;
  for (const e of [0, L]) at(add(boxM(0.1, 1.3, 0.7, PAINT(0x2257b5)), g), o.x + e, o.y, FLOOR_Z + 0.75);
  at(add(boxM(L - 0.1, 1.1, 0.6, STEEL()), g), o.x + L / 2, o.y, FLOOR_Z + 0.75);
  for (const dz of [0.6, -0.4]) member([o.x, o.y, FLOOR_Z + 0.75 + dz], [o.x + L, o.y, FLOOR_Z + 0.75 + dz], 0.025, STEEL_DK(), true);
  for (const [dy, dz] of [[-0.18, 0.4], [0.18, 0.4], [-0.18, -0.3], [0.18, -0.3]]) { const n = at(add(cylM(0.06, 0.06, 0.2, STEEL(), 10), g), o.x - 0.12, o.y + dy, FLOOR_Z + 0.75 + dz); n.rotation.z = Math.PI / 2; }
  scene.add(g);
  blob(o.x + L / 2, o.y, L + 0.9, 1.1, 0.38);
  label(W2(o.x + L / 2, o.y, FLOOR_Z + 1.9), `<b>${esc(o.name)}</b>`, "nm", { prio: 3 });
}
// horizontal shell-and-tube condenser on saddles
function bCondenser(o) {
  const g = new THREE.Group(), L = o.len ?? 2.4, z = FLOOR_Z + 1.0;
  const s = at(add(cylM(0.42, 0.42, L, STEEL(), 28), g), o.x + L / 2, o.y, z); s.rotation.z = Math.PI / 2;
  for (const e of [0, L]) { const h = at(add(new THREE.Mesh(new THREE.SphereGeometry(0.42, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), STEEL()), g), o.x + e, o.y, z); h.rotation.z = e ? -Math.PI / 2 : Math.PI / 2; h.scale.y = 0.4; }
  for (const t of [0.2, 0.8]) at(add(boxM(0.2, z - FLOOR_Z - 0.2, 0.8, FRAME()), g), o.x + t * L, o.y, FLOOR_Z + (z - FLOOR_Z - 0.2) / 2);
  scene.add(g);
  blob(o.x + L / 2, o.y, L + 0.8, 1.2, 0.38);
  label(W2(o.x + L / 2, o.y, z + 1.0), `<b>${esc(o.name)}</b>`, "nm", { prio: 3 });
}
// degasifier: tall vessel inside a blue steel structure with platforms, handrails and a ladder
function bColumn(o) {
  const t = bTank({ ...o, top: "dish" });
  const x0 = o.x - o.r - 0.9, x1 = o.x + o.r + 0.9, y0 = o.y - o.r - 0.9, y1 = o.y + o.r + 0.9, fm = FRAME();
  const lv = o.platforms ?? [FLOOR_Z + 3.2, t.top - 0.2];
  for (const [x, y] of ring4(x0, y0, x1 - x0, y1 - y0)) { member([x, y, FLOOR_Z], [x, y, lv[lv.length - 1] + 1.1], 0.18, fm); blob(x, y, 0.8, 0.8, 0.38); }
  lv.forEach((z, i) => {
    const P = ring4(x0, y0, x1 - x0, y1 - y0);
    for (let k = 0; k < 4; k++) member([...P[k], z - 0.08], [...P[(k + 1) % 4], z - 0.08], 0.16, fm);
    const gr = GRATE(), w = 0.8;
    for (const [ax, ay, bx, by] of [[x0, y0, x1, y0 + w], [x0, y1 - w, x1, y1], [x0, y0 + w, x0 + w, y1 - w], [x1 - w, y0 + w, x1, y1 - w]]) at(add(boxM(Math.abs(bx - ax), 0.05, Math.abs(by - ay), gr), scene, false), (ax + bx) / 2, (ay + by) / 2, z);
    railing(P, z);
    ladder(x1, i % 2 ? y1 - 0.8 : y0 + 0.8, i ? lv[i - 1] : FLOOR_Z, z, 1, 0);
  });
  return t;
}


// ------------------------------------------------------------------ pipes
function runPath(v, bend) {
  const path = new THREE.CurvePath();
  let prev = v[0].clone();
  for (let i = 1; i < v.length; i++) {
    const cur = v[i];
    if (i < v.length - 1) {
      const nxt = v[i + 1], d1 = cur.clone().sub(prev), d2 = nxt.clone().sub(cur);
      const rr = Math.min(bend, d1.length() / 2, d2.length() / 2);
      const a = cur.clone().sub(d1.normalize().multiplyScalar(rr)), b = cur.clone().add(d2.normalize().multiplyScalar(rr));
      if (prev.distanceTo(a) > 1e-3) path.add(new THREE.LineCurve3(prev.clone(), a));
      if (rr > 1e-3) path.add(new THREE.QuadraticBezierCurve3(a, cur.clone(), b));
      prev = b;
    } else path.add(new THREE.LineCurve3(prev.clone(), cur.clone()));
  }
  return path;
}
let flowTex = null;
function flowTexture() {
  if (flowTex) return flowTex;
  const cv = document.createElement("canvas"); cv.width = 64; cv.height = 4;
  const c = cv.getContext("2d"), g = c.createLinearGradient(0, 0, 64, 0);
  g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.55, "rgba(255,255,255,0)"); g.addColorStop(0.8, "rgba(255,255,255,.95)"); g.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = g; c.fillRect(0, 0, 64, 4); flowTex = new THREE.CanvasTexture(cv);
  return flowTex;
}
function collar(p, dir, r, m, len = 0.06, k = 1.6) {
  const f = add(cylM(r * k, r * k, len, m, 18), scene); f.position.copy(p); f.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
}
function supports(v, r) {                           // low runs: post + saddle every ~2.5 m; high runs: portal frame every ~5 m
  for (let i = 0; i < v.length - 1; i++) {
    const a = v[i], b = v[i + 1];
    if (Math.abs(a.y - b.y) > 0.01) continue;                       // horizontal segments only
    const len = a.distanceTo(b), high = a.y > 2.2, step = high ? 5 : 2.5, n = Math.floor(len / step);
    for (let k = 1; k <= n; k++) {
      const p = a.clone().lerp(b, k / (n + 1)), h = p.y - r - FLOOR_Z;
      if (h < 0.1) continue;
      const post = add(boxM(high ? 0.14 : 0.08, h, high ? 0.14 : 0.08, high ? FRAME() : STEEL_DK()), scene);
      post.position.set(p.x, FLOOR_Z + h / 2, p.z);
      const sad = add(boxM(high ? 0.5 : 0.26, 0.05, high ? 0.5 : 0.12, high ? FRAME() : STEEL_DK()), scene); sad.position.set(p.x, FLOOR_Z + h, p.z);
      blob(p.x, -p.z, high ? 0.8 : 0.5, high ? 0.8 : 0.5, 0.32);
    }
  }
}
function buildPipe(p) {
  const sv = PLANT.services[p.s] || PLANT.services.water, r = p.r ?? sv.r ?? 0.08;
  const m = mat(sv.color, { metal: 0.25, rough: 0.5, unique: !!(p.by && p.by.length) });
  const v = p.pts.map(([x, y, z]) => W2(x, y, z)).filter((q, i, a) => !i || q.distanceTo(a[i - 1]) > 0.01);
  if (v.length < 2) return;
  let length = 0; for (let i = 0; i < v.length - 1; i++) length += v[i].distanceTo(v[i + 1]);
  const tube = add(new THREE.Mesh(new THREE.TubeGeometry(runPath(v, r * 3), Math.max(16, Math.round(length * 8)), r, 12, false), m), scene, true);
  tube.userData.pipe = p.s; pipeMeshes.push(tube);
  const n0 = scene.children.length;
  const fl = STEEL_DK();
  collar(v[0], v[1].clone().sub(v[0]), r, fl); collar(v[v.length - 1], v[v.length - 1].clone().sub(v[v.length - 2]), r, fl);
  // a run that starts / ends ON another run is a tee: a short bigger branch fitting marks the connection
  if (p.tee0) collar(v[0], v[1].clone().sub(v[0]), r, mat(sv.color, { metal: 0.25, rough: 0.5 }), 0.22, 1.35);
  if (p.tee1) collar(v[v.length - 1], v[v.length - 1].clone().sub(v[v.length - 2]), r, mat(sv.color, { metal: 0.25, rough: 0.5 }), 0.22, 1.35);
  if (!p.noSup) supports(v, r);
  // supports / fittings of this run fade with it when another line is being traced
  for (let i = n0; i < scene.children.length; i++) scene.children[i].traverse((o) => { if (o.isMesh) { o.userData.pipe = p.s; pipeMeshes.push(o); } });
  if (!p.by || !p.by.length) return;
  m.emissive = new THREE.Color(sv.color); m.emissiveIntensity = 0;
  const tex = flowTexture().clone(); tex.needsUpdate = true; tex.wrapS = THREE.RepeatWrapping; tex.repeat.set(Math.max(1, Math.round(length / 0.9)), 1);
  const sleeve = new THREE.Mesh(new THREE.TubeGeometry(runPath(v, r * 3), Math.max(16, Math.round(length * 8)), r * 1.07, 12, false),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  sleeve.visible = false; sleeve.renderOrder = 3; scene.add(sleeve);
  flows.push({ by: p.by, s: p.s, length, mat: m, sleeve, tex });
}

// ------------------------------------------------------------------ sky / light
function buildSky() {
  const cv = document.createElement("canvas"); cv.width = 4; cv.height = 256;
  const c = cv.getContext("2d"), g = c.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, "#9fb8d4"); g.addColorStop(0.6, "#d3dde8"); g.addColorStop(1, "#e9edf1");
  c.fillStyle = g; c.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; scene.background = tex;
  const env = new THREE.Scene(), geo = new THREE.SphereGeometry(50, 32, 16), col = [], top = new THREE.Color(0x6f95c6), hz = new THREE.Color(0xdfe7ef), gd = new THREE.Color(0x707370);
  const pa = geo.attributes.position;
  for (let i = 0; i < pa.count; i++) { const y = pa.getY(i) / 50, cc = y > 0 ? hz.clone().lerp(top, Math.pow(y, 0.6)) : gd; col.push(cc.r, cc.g, cc.b); }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  env.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const box = new THREE.Mesh(new THREE.PlaneGeometry(12, 44), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
  box.position.set(-34, 18, 22); box.lookAt(0, 0, 0); env.add(box);
  const pm = new THREE.PMREMGenerator(renderer); scene.environment = pm.fromScene(env, 0.02).texture; pm.dispose();
}

// ------------------------------------------------------------------ live state
const RUNS = ["RUNNING", "STARTING", "OPEN"];
const eqOf = (id) => (live && live.equipment || []).find((e) => e.id === id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const hex = (c) => `#${c.toString(16).padStart(6, "0")}`;
function stateOf(m, e) {
  if (!e) return { k: "unk", col: ST.unk, txt: "No data" };
  if (m.kind === "valve") { const vk = helpers.valve ? helpers.valve(e) : (e.status === "OPEN" ? "open" : "closed"); return { k: vk, col: vk === "open" ? ST.open : vk === "conf" ? ST.warn : vk === "closed" ? ST.closed : ST.unk, txt: helpers.stateTxt(e) }; }
  if (["TRIP", "FAULT"].includes(e.status)) return { k: "trip", col: ST.trip, txt: "TRIPPED" };
  if (RUNS.includes(e.status)) return { k: "run", col: ST.run, txt: helpers.stateTxt(e) };
  return { k: "stop", col: ST.stop, txt: helpers.stateTxt(e) };
}
function applyLive() {
  if (!scene || !helpers) return;
  for (const m of Object.values(machines)) {
    const e = eqOf(m.id), s = stateOf(m, e);
    m.state = s; m.running = s.k === "run"; m.trip = s.k === "trip";
    m.mats.forEach((mm) => { mm.color.setHex(s.col); mm.emissive.setHex(m.running ? 0x0f2a00 : m.trip ? 0x2a0000 : 0); });
    if (m.lamp) { m.lamp.material.color.setHex(s.col); m.lamp.material.emissive.setHex(m.running ? 0x2f8a00 : m.trip ? 0x8a0000 : 0); }
    if (m.lb) {
      const tag = helpers.pid(m.id) || m.id;
      m.lb.el.className = `p3-lb eq st-${s.k}${m.vendor ? " vendor" : ""}${selected === m.id ? " sel" : ""}`;
      m.lb.el.innerHTML = `<em class="dot" style="background:${hex(s.col)}"></em><b>${esc(tag)}</b>${s.k === "trip" ? '<span class="trip">TRIP</span>' : ""}${e && e.auto === false ? '<span class="man">MAN</span>' : ""}`;
      m.lb.el.title = `${e ? e.name : tag} - ${s.txt}`;
      m.lb.dirty = true;
    }
  }
  for (const t of levels) t.update();
  for (const s of switches) { const v = helpers.sw(s.key); s.m.color.setHex(v == null ? 0xbdbdb5 : v ? 0xffc21a : 0x8d8d86); s.m.emissive.setHex(v ? 0x8a6000 : 0); }
  for (const l of labels) {
    if (!l.tid) continue;
    const v = helpers.val(l.tid);
    l.el.innerHTML = `<span class="tn">${esc(l.name)}</span><b>${esc(v ?? "--")}</b>`;
    l.el.classList.toggle("over", helpers.over(l.tid));
    l.dirty = true;
  }
  for (const f of flows) f.on = helpers.flowOn ? helpers.flowOn(f.by) : f.by.some((id) => { const e = eqOf(id); return !!e && RUNS.includes(e.status); });
  if (selected) fillPanel(selected);
}

// ------------------------------------------------------------------ selection + side panel
function select(id) {
  if (selected && machines[selected] && machines[selected].sel) machines[selected].sel.visible = false;
  selected = id;
  const m = machines[id];
  if (!m) { panel.hidden = true; panelOffset(); return; }
  if (m.sel) m.sel.visible = true;
  panel.hidden = false;
  fillPanel(id);
  panelOffset();
  // bring the machine's area into view (once - not again while that area is already framed)
  if (m.area && framed !== m.area) zoomArea(m.area);
  applyLive();
}
// with the side panel open, shift the picture left so the plant is not hidden under the panel
function panelOffset() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (!w || !h) return;
  const px = !panel.hidden && w > 760 ? Math.round((panel.offsetWidth + 10) / 2) : 0;
  if (px) camera.setViewOffset(w, h, px, 0, w, h); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
function fillPanel(id) {
  const m = machines[id], e = eqOf(id);
  if (!m || !panel) return;
  const s = m.state || stateOf(m, e), tag = helpers.pid(id) || id;
  const demo = e && e.simulated;
  const rows = [];
  if (e && e.auto != null) rows.push(["Mode", e.auto ? "Auto" : "Manual"]);
  if (e && e.kw != null) rows.push(["Rating", `${e.kw} kW`]);
  if (e && e.type === "motor" && e.run_hours != null) rows.push(["Run hours", `${Number(e.run_hours).toFixed(1)} h`]);
  if (e && e.starts != null) rows.push(["Starts", String(e.starts)]);
  if (e && e.pair && e.standby_selected != null) rows.push(["Selected", e.standby_selected ? "Standby" : "Main"]);
  const io = e && e.io ? Object.entries(e.io).map(([k, v]) => `<span class="sig ${v ? "on" : ""}">${esc(k.replace("_", " ").toUpperCase())}</span>`).join("") : "";
  const rd = m.readings.map((t) => { const v = helpers.val(t); return v == null ? "" : `<tr><td>${esc(helpers.tagName(t) || t)}</td><td><b>${esc(v)}</b></td></tr>`; }).join("");
  panel.innerHTML = `<div class="p3-ph"><div><b>${esc(tag)}</b>${demo ? '<span class="demo">DEMO DATA</span>' : ""}</div><button type="button" class="p3-x" aria-label="Close">×</button></div>
    <div class="p3-pn">${esc(e ? e.name : m.service)}</div>
    <div class="p3-ps st-${s.k}"><i></i>${esc(s.k === "trip" ? "TRIPPED - check the motor / overload" : s.txt)}</div>
    <dl class="p3-pd"><dt>Service</dt><dd>${esc(m.service || "-")}</dd><dt>Area</dt><dd>${esc((PLANT.areas.find((a) => a.id === m.area) || {}).name || "-")}</dd>
      ${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    ${io ? `<div class="p3-io">${io}</div>` : ""}
    ${rd ? `<table class="p3-rd"><caption>Readings</caption>${rd}</table>` : ""}
    ${m.vendor ? '<p class="p3-vn">Vendor package - shown for reference</p>' : ""}`;
  panel.querySelector(".p3-x").onclick = () => { select(null); };
}

// ------------------------------------------------------------------ camera
function fitBox(box3, dir = new THREE.Vector3(-0.28, 0.66, 0.70), pad = 1.06, animate = true) {
  const c = box3.getCenter(new THREE.Vector3()), size = box3.getSize(new THREE.Vector3());
  const d = dir.clone().normalize();
  framed = null;
  // visible width excludes the side panel when it is open
  const vis = camera.view && camera.view.enabled ? Math.max(0.3, 1 - (2 * camera.view.offsetX) / camera.view.fullWidth) : 1;
  const vf = THREE.MathUtils.degToRad(camera.fov), hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect * vis);
  // fit every box corner inside both view angles
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), d).normalize(), up = new THREE.Vector3().crossVectors(d, right).normalize();
  let dist = 1;
  for (const sx of [-0.5, 0.5]) for (const sy of [-0.5, 0.5]) for (const sz of [-0.5, 0.5]) {
    const p = new THREE.Vector3(sx * size.x, sy * size.y, sz * size.z);
    const along = p.dot(d), h = Math.abs(p.dot(right)), v = Math.abs(p.dot(up));
    dist = Math.max(dist, along + h / Math.tan(hf / 2), along + v / Math.tan(vf / 2));
  }
  const pos = c.clone().add(d.multiplyScalar(dist * pad));
  if (!animate) { camera.position.copy(pos); controls.target.copy(c); controls.update(); return; }
  flyTo(pos, c);
}
// camera move: target slides, view direction turns on a sphere (like SolidWorks view changes), distance eases
function flyTo(pos, tgt, remember = true) {
  if (remember) pushView();
  const t0 = controls.target.clone(), o0 = camera.position.clone().sub(t0), o1 = pos.clone().sub(tgt);
  const d0 = o0.clone().normalize(), d1 = o1.clone().normalize();
  fly = { t0, t1: tgt.clone(), d0, r0: o0.length(), r1: o1.length(), q: new THREE.Quaternion().setFromUnitVectors(d0, d1), s: 0 };
}
// previous view (SolidWorks "Previous View"): remember camera states before each change
const history = [];
function pushView() {
  if (!camera || !controls) return;
  const v = { p: camera.position.clone(), t: controls.target.clone() }, last = history[history.length - 1];
  if (last && last.p.distanceTo(v.p) < 0.05 && last.t.distanceTo(v.t) < 0.05) return;
  history.push(v); if (history.length > 30) history.shift();
}
function prevView() { const v = history.pop(); if (v) flyTo(v.p, v.t, false); }
// standard orientation about the current centre, same distance (Front / Back / Left / Right / Top / Isometric)
const VIEWS = {
  front: new THREE.Vector3(0, 0, 1), back: new THREE.Vector3(0, 0, -1), left: new THREE.Vector3(-1, 0, 0), right: new THREE.Vector3(1, 0, 0),
  top: new THREE.Vector3(0.0001, 1, 0.012), iso: new THREE.Vector3(1, 1, 1), plant: new THREE.Vector3(-0.28, 0.66, 0.70),
};
// standard views turn to the orientation and fit the whole plant (SolidWorks "zoom to fit on view change")
function setView(name) {
  const d = VIEWS[name]; if (!d) return;
  controls.autoRotate = false; syncTools();
  fitBox(plantBox(), d.clone(), name === "top" ? 1.0 : 1.02);
}
// where the camera is heading (end of a running move), so quick key presses add up correctly
function dest() {
  if (!fly) return { t: controls.target.clone(), p: camera.position.clone() };
  return { t: fly.t1.clone(), p: fly.t1.clone().add(fly.d0.clone().applyQuaternion(fly.q).multiplyScalar(fly.r1)) };
}
function zoomBy(f) {                                  // f < 1 = zoom in
  const { t, p } = dest(), o = p.sub(t);
  const r = THREE.MathUtils.clamp(o.length() * f, controls.minDistance, controls.maxDistance);
  flyTo(t.clone().add(o.normalize().multiplyScalar(r)), t);
}
function orbitBy(dTheta, dPhi) {                      // arrow keys: rotate about the centre
  const { t, p } = dest(), s = new THREE.Spherical().setFromVector3(p.sub(t));
  s.theta += dTheta; s.phi = THREE.MathUtils.clamp(s.phi - dPhi, 0.001, controls.maxPolarAngle); s.makeSafe();
  flyTo(t.clone().add(new THREE.Vector3().setFromSpherical(s)), t);
}
function panBy(dx, dy) {                              // Ctrl + arrow keys: move the view
  const { t, p } = dest(), r = p.distanceTo(t), right = new THREE.Vector3(), up = new THREE.Vector3();
  camera.matrixWorld.extractBasis(right, up, new THREE.Vector3());
  const m = right.multiplyScalar(dx * r * 0.12).add(up.multiplyScalar(dy * r * 0.12));
  flyTo(p.add(m), t.add(m));
}
// point of the plant under a screen position (null = sky)
function hitPoint(cx, cy, floorOk = true) {
  const r = renderer.domElement.getBoundingClientRect();
  mouse.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const hit = ray.intersectObjects(scene.children, true).find((h) => h.object.visible && h.object.isMesh && !h.object.userData.blob);
  if (hit) return hit.point;
  const p = new THREE.Vector3();
  return floorOk && ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p) ? p : null;
}
// double tap / double click: zoom in on the tapped point; on empty sky (or Shift) zoom out
function zoomAt(cx, cy, zoomIn) {
  const p = zoomIn ? hitPoint(cx, cy, false) : null;
  if (!p) { zoomBy(2); return; }
  const { t, p: cp } = dest(), dir = cp.clone().sub(t).normalize();
  const dist = THREE.MathUtils.clamp(cp.distanceTo(p) * 0.5, controls.minDistance, controls.maxDistance);
  flyTo(p.clone().add(dir.multiplyScalar(dist)), p);
}
// zoom to area: the dragged rectangle fills the view
function zoomToRect(x0, y0, x1, y1) {
  const r = renderer.domElement.getBoundingClientRect(), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const p = hitPoint(cx, cy);
  if (!p) return;
  const k = Math.max(Math.abs(x1 - x0) / r.width, Math.abs(y1 - y0) / r.height, 0.04);
  const o = camera.position.clone().sub(p), dist = THREE.MathUtils.clamp(camera.position.distanceTo(p) * k, controls.minDistance, controls.maxDistance);
  flyTo(p.clone().add(o.normalize().multiplyScalar(dist)), p);
}
// display style: shaded / shaded with edges / wireframe
let dispStyle = "shaded", edgeMat = null, allMats = null;
function setStyle(st) {
  dispStyle = st;
  if (!allMats) { allMats = new Set(); scene.traverse((o) => { if (o.isMesh && !o.userData.blob && !o.userData.edgeLine) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => allMats.add(m)); }); if (faintMat) allMats.add(faintMat); }
  allMats.forEach((m) => { if (m.wireframe !== (st === "wire")) { m.wireframe = st === "wire"; m.needsUpdate = true; } });
  scene.traverse((o) => { if (o.userData.blob) o.visible = st !== "wire"; });
  if (st === "edges" && !edgeMat) {                     // built once, on first use
    edgeMat = new THREE.LineBasicMaterial({ color: 0x1b2430, transparent: true, opacity: 0.45 });
    const list = []; scene.traverse((o) => { if (o.isMesh && !o.userData.blob && o.geometry && !(o.geometry.parameters && o.geometry.parameters.width > 30)) list.push(o); });
    for (const o of list) { const e = new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 35), edgeMat); e.userData.edgeLine = true; e.raycast = () => {}; o.add(e); }
  }
  if (edgeMat) edgeMat.visible = st === "edges";
  renderer.shadowMap.enabled = st !== "wire"; scene.traverse((o) => { if (o.material && o.isMesh) o.material.needsUpdate = true; });
  syncTools();
}
const boxOf = (x0, y0, x1, y1, z0, z1) => new THREE.Box3().setFromPoints([W2(x0, y0, z0), W2(x1, y1, z1), W2(x0, y1, z0), W2(x1, y0, z1)]);
function plantBox() { const b = PLANT.bounds; return boxOf(b.x, b.y, b.x + b.w, b.y + b.d, 0, PLANT.fitH || 5); }
function zoomArea(id) {
  const a = PLANT.areas.find((q) => q.id === id);
  if (!a) return;
  fitBox(boxOf(a.x, a.y, a.x + a.w, a.y + a.d, 0, a.h || 4), undefined, 1.04);
  framed = id;
}

// ------------------------------------------------------------------ loop
function frame() {
  raf = 0;
  if (!renderer || !wrap.isConnected) return;
  raf = requestAnimationFrame(frame);
  if (document.hidden || wrap.offsetParent === null) return;
  const dt = Math.min(0.05, clock.getDelta()), t = clock.elapsedTime;
  resize();
  if (fly) {
    fly.s = Math.min(1, fly.s + dt / 0.7); const k = 1 - Math.pow(1 - fly.s, 3);
    controls.target.lerpVectors(fly.t0, fly.t1, k);
    const dir = fly.d0.clone().applyQuaternion(new THREE.Quaternion().slerp(fly.q, k));
    camera.position.copy(controls.target).add(dir.multiplyScalar(fly.r0 + (fly.r1 - fly.r0) * k));
    if (fly.s >= 1) fly = null;
  }
  controls.update();
  for (const m of Object.values(machines)) {
    if (m.rot && m.running) m.rot.obj.rotation[m.rot.axis] += m.rot.speed * dt;
    if (m.lamp) m.lamp.visible = !m.trip || Math.floor(t * 2.5) % 2 === 0;
    if (m.halo) {
      const on = m.running || m.trip; m.halo.visible = on;
      if (on) { const p = 0.5 + 0.5 * Math.sin(t * (m.trip ? 7 : 3.2)); m.halo.material.color.setHex(m.trip ? 0xe5484d : 0x46c21b); m.halo.material.opacity = 0.3 + 0.4 * p; }
    }
    if (m.sel && m.sel.visible) m.sel.material.opacity = 0.6 + 0.35 * Math.sin(t * 4);
  }
  for (const f of flows) {
    f.mat.emissiveIntensity = f.on ? 0.25 + 0.1 * Math.sin(t * 3) : 0;
    f.sleeve.visible = !!f.on && (!isoSvc || f.s === isoSvc);
    if (f.on) f.tex.offset.x -= (dt * 2 / f.length) * f.tex.repeat.x;
  }
  renderer.render(scene, camera);
  updateCube();
  placeLabels();
}
function placeLabels() {
  const w = wrap.clientWidth, h = wrap.clientHeight, v = new THREE.Vector3(), placed = [];
  const off = labelBox.classList.contains("off");
  const rank = (l) => (selected && l.el.dataset.eq === selected ? -1 : l.prio);
  const order = labels.slice().sort((a, b) => rank(a) - rank(b));
  // overlays (toolbar, side panel, legend, help line) are no-go zones for tags
  const wr = wrap.getBoundingClientRect();
  for (const o of wrap.querySelectorAll(".p3-tools, .p3-panel, .p3-legend, .p3-help, .p3-cube, .p3-triad, .p3-menu")) {
    if (o.hidden || !o.offsetWidth) continue;
    const r = o.getBoundingClientRect();
    placed.push({ x0: r.left - wr.left, x1: r.right - wr.left, y0: r.top - wr.top, y1: r.bottom - wr.top });
  }
  for (const l of order) {
    v.copy(l.pos).project(camera);
    let vis = v.z < 1 && v.x > -1 && v.x < 1 && v.y > -1 && v.y < 1 && !(off && l.prio > 0 && l.el.dataset.eq !== selected);
    const x = ((v.x + 1) / 2) * w, y = ((1 - v.y) / 2) * h;
    if (vis && (!l.size || l.dirty)) { l.el.style.display = ""; l.size = [l.el.offsetWidth || 50, l.el.offsetHeight || 16]; l.dirty = false; }
    let x0 = l.anchor === "left" ? x : x - (l.size ? l.size[0] / 2 : 0), y0 = y - (l.size ? l.size[1] : 0) - (l.anchor === "left" ? 0 : 6);
    if (vis) {
      const r = { x0: x0 - 2, x1: x0 + l.size[0] + 2, y0: y0 - 2, y1: y0 + l.size[1] + 2 };
      if (r.x0 < 0 || r.x1 > w || r.y0 < 0 || r.y1 > h) vis = false;                     // never cut off at the edge
      else if (placed.some((o) => !(o.x1 < r.x0 || o.x0 > r.x1 || o.y1 < r.y0 || o.y0 > r.y1))) vis = false;   // never overlap
      else placed.push(r);
    }
    l.el.style.display = vis ? "" : "none";
    if (vis) l.el.style.transform = `translate(${Math.round(x0)}px, ${Math.round(y0)}px)`;
  }
}
function resize() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (!w || !h) return;
  const c = renderer.domElement;
  if (c.width !== Math.round(w * renderer.getPixelRatio()) || c.height !== Math.round(h * renderer.getPixelRatio())) {
    const first = !camera.userData.fitted;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); panelOffset();
    if (first) { camera.userData.fitted = true; fitBox(plantBox(), undefined, 1.02, false); }
  }
}
function pickAt(cx, cy) {
  const r = renderer.domElement.getBoundingClientRect();
  mouse.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const hit = ray.intersectObjects(pickables, false)[0];
  return hit ? hit.object.userData : null;
}

// ------------------------------------------------------------------ build + public API
function legendHTML() {
  return Object.entries(PLANT.services).filter(([, s]) => !s.hide).map(([k, s]) => `<span data-s="${k}" title="Show only this line (click again for all)"><i style="background:${hex(s.color)}"></i>${esc(s.name)}</span>`).join("")
    + '<span class="vd"><i></i>Vendor package (scope)</span>';
}
// legend click: show only one service line (e.g. filtrate) so it can be traced end to end; others fade
function isolate(k) {
  isoSvc = !k || isoSvc === k ? null : k;
  if (!faintMat) faintMat = new THREE.MeshStandardMaterial({ color: 0xb9c0c8, transparent: true, opacity: 0.18, depthWrite: false });
  for (const t of pipeMeshes) {
    if (!t.userData.m0) t.userData.m0 = t.material;
    t.material = !isoSvc || t.userData.pipe === isoSvc ? t.userData.m0 : faintMat;
  }
  for (const f of flows) f.iso = !!isoSvc;
  if (isoSvc) {                                     // frame the whole traced line
    const bb = new THREE.Box3();
    for (const t of pipeMeshes) if (t.userData.pipe === isoSvc) bb.expandByObject(t);
    if (!bb.isEmpty()) { bb.min.y = 0; fitBox(bb, undefined, 1.1); }
  }
  wrap.querySelectorAll(".p3-legend [data-s]").forEach((s) => { s.classList.toggle("on", s.dataset.s === isoSvc); s.classList.toggle("dim", !!isoSvc && s.dataset.s !== isoSvc); });
}
function build(container) {
  container.innerHTML = `<div class="p3-wrap p3n"><div class="p3-labels"></div>
    ${toolsHTML()}
    <div class="p3-cube" title="View cube - click a face"><div class="p3-cube-in">
      <div class="f" data-v="front">FRONT</div><div class="f" data-v="back">BACK</div><div class="f" data-v="right">RIGHT</div>
      <div class="f" data-v="left">LEFT</div><div class="f" data-v="top">TOP</div><div class="f bot">BOTTOM</div></div></div>
    <svg class="p3-triad" viewBox="0 0 70 70" aria-hidden="true"><g class="ax"></g></svg>
    <div class="p3-rect" hidden></div>
    <aside class="p3-panel" hidden aria-live="polite"></aside>
    <div class="p3-legend">${legendHTML()}</div>
    <div class="p3-help">Drag or middle-drag = rotate · right-drag or Ctrl+middle-drag = move · wheel = zoom at cursor · double-tap = zoom in (sky / Shift = out) · F = fit · Space = views</div></div>`;
  wrap = container.querySelector(".p3-wrap"); labelBox = wrap.querySelector(".p3-labels"); panel = wrap.querySelector(".p3-panel");
  pickables = []; machines = {}; levels = []; switches = []; flows = []; labels = []; selected = null; fly = null;
  pipeMeshes = []; isoSvc = null; framed = null;
  wrap.querySelectorAll(".p3-legend [data-s]").forEach((s) => { s.onclick = () => isolate(s.dataset.s); });
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.className = "p3-cv"; wrap.prepend(renderer.domElement);
  scene = new THREE.Scene(); buildSky();
  camera = new THREE.PerspectiveCamera(34, 1.6, 0.5, 600);
  scene.add(new THREE.HemisphereLight(0xeef3f8, 0x8f928a, 1.0));
  const sun = new THREE.DirectionalLight(0xfff4e4, 2.3);
  const b = PLANT.bounds, cx = b.x + b.w / 2, cy = b.y + b.d / 2;
  sun.position.copy(W2(cx - 40, cy + 25, 60)); sun.target.position.copy(W2(cx, cy, 0)); scene.add(sun.target);
  sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096);
  const R = Math.max(b.w, b.d) * 0.62;
  Object.assign(sun.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 1, far: 220 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02; scene.add(sun);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08; controls.minDistance = 4; controls.maxDistance = 260; controls.maxPolarAngle = Math.PI / 2; controls.autoRotateSpeed = 0.5;
  controls.zoomToCursor = true;                          // wheel zooms about the point under the mouse (as in SolidWorks)
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
  controls.addEventListener("start", () => { fly = null; pushView(); });
  history.length = 0; dispStyle = "shaded"; edgeMat = null; allMats = null; leftMode = "rotate"; areaMode = false;
  buildFloor();
  buildPlant();
  PLANT.pipes.forEach(buildPipe);
  fitBox(plantBox(), undefined, 1.02, false);
  clock = new THREE.Clock();
  let down = null;
  const cv = renderer.domElement;
  // taps: single = pick, double = zoom in at the point (Shift / sky = zoom out), two-finger tap = zoom out
  const act = new Map(); let multi = null, lastTap = null;
  cv.addEventListener("pointerdown", (e) => {
    act.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (act.size === 1) down = { x: e.clientX, y: e.clientY, t: performance.now() };
    if (act.size === 2) multi = { t: performance.now(), moved: false, start: new Map(act) };
    if (act.size > 2) multi = null;
  });
  cv.addEventListener("pointermove", (e) => {
    if (multi && multi.start.has(e.pointerId)) { const s = multi.start.get(e.pointerId); if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > 12) multi.moved = true; }
  });
  const lift = (e) => { act.delete(e.pointerId); };
  cv.addEventListener("pointercancel", (e) => { lift(e); multi = null; down = null; });
  cv.addEventListener("pointerup", (e) => {
    lift(e);
    if (multi) {                                       // two-finger gesture: wait for both fingers
      if (act.size === 0) { if (!multi.moved && performance.now() - multi.t < 400) zoomBy(2); multi = null; }
      down = null; lastTap = null; return;
    }
    if (areaMode || e.button !== 0) { down = null; return; }
    const tol = e.pointerType === "touch" ? 12 : 5;
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < tol) {
      const now = performance.now();
      if (lastTap && now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
        lastTap = null; down = null;
        zoomAt(e.clientX, e.clientY, !e.shiftKey);
        return;
      }
      lastTap = { t: now, x: e.clientX, y: e.clientY };
      const u = pickAt(e.clientX, e.clientY);
      if (u && u.eq) select(u.eq);
      else if (u && u.tag && window.MD && MD.openTag) MD.openTag(u.tag);
      else select(null);
    } else lastTap = null;
    down = null;
  });
  cv.addEventListener("pointermove", (e) => { if (!down && !areaMode) { const u = pickAt(e.clientX, e.clientY); cv.style.cursor = u ? "pointer" : "grab"; } });
  wireControls(cv);
}

// ------------------------------------------------------------------ SolidWorks-style view tools
let leftMode = "rotate", areaMode = false, winH = null;
const ICON = {
  fit: '<rect x="8" y="8" width="8" height="8"/><path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5"/>',
  area: '<circle cx="10" cy="10" r="6.5"/><path d="M15 15l6 6"/><rect x="7" y="7" width="6" height="6" stroke-dasharray="2 1.6"/>',
  zin: '<circle cx="10" cy="10" r="6.5"/><path d="M15 15l6 6M7 10h6M10 7v6"/>',
  zout: '<circle cx="10" cy="10" r="6.5"/><path d="M15 15l6 6M7 10h6"/>',
  prev: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
  views: '<path d="M12 2L3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>',
  style: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 010 17z" fill="currentColor"/>',
  rot: '<path d="M20 12a8 8 0 11-2.3-5.6"/><path d="M20 3.5v5h-5"/>',
  pan: '<path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  auto: '<circle cx="12" cy="12" r="9"/><path d="M10 8l6 4-6 4z" fill="currentColor"/>',
  lbl: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="7.5" r="1.6"/>',
};
const ib = (a, title, extra = "") => `<button type="button" class="p3-ib" data-p3="${a}" title="${title}" aria-label="${title}" ${extra}><svg viewBox="0 0 24 24">${ICON[a]}</svg></button>`;
function toolsHTML() {
  const views = [["front", "Front", "1"], ["back", "Back", "2"], ["left", "Left", "3"], ["right", "Right", "4"], ["top", "Top", "5"], ["iso", "Isometric", "7"], ["plant", "Plant view (3/4)", "0"]];
  return `<div class="p3-tools" role="toolbar" aria-label="View tools">
    ${ib("fit", "Zoom to fit (F)")}${ib("area", "Zoom to area - drag a box")}${ib("zin", "Zoom in (Shift+Z)")}${ib("zout", "Zoom out (Z)")}${ib("prev", "Previous view (Ctrl+Shift+Z)")}
    <span class="sep"></span>
    <div class="p3-dd">${ib("views", "View orientation (Space)", 'aria-haspopup="true"')}<div class="p3-menu" data-menu="views" hidden>
      ${views.map(([k, n, s]) => `<button type="button" data-view="${k}"><span>${n}</span><kbd>${s}</kbd></button>`).join("")}</div></div>
    <div class="p3-dd">${ib("style", "Display style", 'aria-haspopup="true"')}<div class="p3-menu" data-menu="style" hidden>
      <button type="button" data-style="shaded"><span>Shaded</span></button><button type="button" data-style="edges"><span>Shaded with edges</span></button>
      <button type="button" data-style="wire"><span>Wireframe</span></button></div></div>
    <span class="sep"></span>
    ${ib("rot", "Rotate - left-drag turns the view")}${ib("pan", "Pan - left-drag moves the view")}
    <span class="sep"></span>
    ${ib("auto", "Auto-rotate")}${ib("lbl", "Hide / show tags")}
    <div class="p3-dd"><button type="button" class="p3-ib q" data-p3="keys" title="Mouse and keyboard" aria-haspopup="true">?</button><div class="p3-menu keys" data-menu="keys" hidden>
      <b>Mouse (SolidWorks style)</b>
      <p><kbd>Left / middle drag</kbd> rotate</p><p><kbd>Right drag</kbd> or <kbd>Ctrl + middle drag</kbd> pan</p>
      <p><kbd>Shift + middle drag</kbd> zoom</p><p><kbd>Wheel</kbd> zoom at the cursor</p><p><kbd>Middle double-click</kbd> zoom to fit</p>
      <p><kbd>Double-click / double-tap</kbd> zoom in on that spot</p><p><kbd>Shift + double-click</kbd>, double-tap the sky or <kbd>two-finger tap</kbd> zoom out</p>
      <b>Keyboard (click the 3D view first)</b>
      <p><kbd>F</kbd> zoom to fit · <kbd>Z</kbd> / <kbd>Shift+Z</kbd> zoom out / in</p><p><kbd>Arrows</kbd> rotate 15° · <kbd>Shift+Arrows</kbd> 90°</p>
      <p><kbd>Ctrl+Arrows</kbd> pan · <kbd>Space</kbd> view menu</p><p><kbd>1</kbd> Front <kbd>2</kbd> Back <kbd>3</kbd> Left <kbd>4</kbd> Right <kbd>5</kbd> Top <kbd>7</kbd> Iso <kbd>0</kbd> Plant</p>
      <p><kbd>Ctrl+Shift+Z</kbd> previous view · <kbd>Esc</kbd> close / clear</p></div></div>
  </div>`;
}
function syncTools() {
  if (!wrap) return;
  const on = (a, v) => { const b = wrap.querySelector(`[data-p3="${a}"]`); if (b) { b.classList.toggle("on", !!v); b.setAttribute("aria-pressed", String(!!v)); } };
  on("auto", controls && controls.autoRotate); on("lbl", labelBox && !labelBox.classList.contains("off"));
  on("rot", leftMode === "rotate" && !areaMode); on("pan", leftMode === "pan" && !areaMode); on("area", areaMode);
  wrap.querySelectorAll("[data-style]").forEach((b) => b.classList.toggle("on", b.dataset.style === dispStyle));
}
function closeMenus(except) { wrap.querySelectorAll(".p3-menu").forEach((m) => { if (m !== except) m.hidden = true; }); }
function toggleMenu(name) { const m = wrap.querySelector(`[data-menu="${name}"]`); if (!m) return; closeMenus(m); m.hidden = !m.hidden; }
function setLeft(mode) {
  leftMode = mode;
  controls.mouseButtons.LEFT = mode === "pan" ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
  controls.touches.ONE = mode === "pan" ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
  syncTools();
}
function setArea(on) { areaMode = on; controls.enabled = !on; renderer.domElement.style.cursor = on ? "crosshair" : ""; syncTools(); }
function fitAll() {                                    // zoom to fit: whole plant, keep the current direction
  const { t, p } = dest(), d = p.sub(t).normalize();
  fitBox(plantBox(), d.y > 0.999 ? VIEWS.top.clone() : d, 1.02);
}
function wireControls(cv) {
  wrap.tabIndex = 0;
  wrap.querySelectorAll("[data-p3]").forEach((btn) => (btn.onclick = (e) => {
    e.stopPropagation();
    const a = btn.dataset.p3;
    if (a === "fit") fitAll();
    if (a === "area") setArea(!areaMode);
    if (a === "zin") zoomBy(0.75);
    if (a === "zout") zoomBy(1.33);
    if (a === "prev") prevView();
    if (a === "views" || a === "style" || a === "keys") { toggleMenu(a); return; }
    if (a === "rot") { setArea(false); setLeft("rotate"); }
    if (a === "pan") { setArea(false); setLeft("pan"); }
    if (a === "auto") { controls.autoRotate = !controls.autoRotate; }
    if (a === "lbl") labelBox.classList.toggle("off");
    closeMenus(); syncTools();
  }));
  wrap.querySelectorAll("[data-view]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); setView(b.dataset.view); closeMenus(); }));
  wrap.querySelectorAll("[data-style]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); setStyle(b.dataset.style); closeMenus(); }));
  wrap.querySelectorAll(".p3-cube [data-v]").forEach((f) => (f.onclick = () => setView(f.dataset.v)));
  wrap.querySelectorAll(".p3-menu").forEach((m) => m.addEventListener("click", (e) => e.stopPropagation()));
  wrap.addEventListener("click", () => closeMenus());
  // middle button like SolidWorks: drag = rotate, Ctrl = pan, Shift = zoom; double-click = zoom to fit
  wrap.addEventListener("pointerdown", (e) => {
    if (e.target === cv) wrap.focus({ preventScroll: true });
    if (e.button === 1) { e.preventDefault(); controls.mouseButtons.MIDDLE = e.ctrlKey ? THREE.MOUSE.PAN : e.shiftKey ? THREE.MOUSE.DOLLY : THREE.MOUSE.ROTATE; }
  }, true);
  cv.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });     // no browser auto-scroll
  let midClick = 0;
  cv.addEventListener("auxclick", (e) => { if (e.button !== 1) return; const n = performance.now(); if (n - midClick < 400) fitAll(); midClick = n; });
  // zoom to area: drag a box
  const box = wrap.querySelector(".p3-rect"); let a0 = null;
  wrap.addEventListener("pointerdown", (e) => {
    if (!areaMode || e.button !== 0 || e.target.closest(".p3-tools, .p3-menu, .p3-panel, .p3-cube, .p3-legend")) return;
    e.preventDefault(); e.stopPropagation();                 // no text selection / no orbit while drawing the box
    a0 = { x: e.clientX, y: e.clientY };
  }, true);
  const aMove = (e) => {
    if (!a0) return;
    e.preventDefault();
    const r = wrap.getBoundingClientRect();
    Object.assign(box.style, { left: `${Math.min(a0.x, e.clientX) - r.left}px`, top: `${Math.min(a0.y, e.clientY) - r.top}px`, width: `${Math.abs(e.clientX - a0.x)}px`, height: `${Math.abs(e.clientY - a0.y)}px` });
    box.hidden = false;
  };
  const aUp = (e) => {
    if (!a0) return;
    const s = a0; a0 = null; box.hidden = true;
    if (e.type === "pointerup" && Math.abs(e.clientX - s.x) > 8 && Math.abs(e.clientY - s.y) > 8) zoomToRect(s.x, s.y, e.clientX, e.clientY);
    setArea(false);
  };
  if (winH) { window.removeEventListener("pointermove", winH.m); window.removeEventListener("pointerup", winH.u); window.removeEventListener("pointercancel", winH.u); }
  winH = { m: aMove, u: aUp };
  window.addEventListener("pointermove", aMove); window.addEventListener("pointerup", aUp); window.addEventListener("pointercancel", aUp);
  wrap.addEventListener("selectstart", (e) => { if (areaMode) e.preventDefault(); });
  // keyboard (SolidWorks shortcuts) while the 3D view has focus
  wrap.addEventListener("keydown", (e) => {
    const k = e.key, step = e.shiftKey ? Math.PI / 2 : Math.PI / 12;
    let done = true;
    if (k === "Escape") { closeMenus(); if (areaMode) setArea(false); else if (isoSvc) isolate(null); else select(null); }
    else if (k === "f" || k === "F") fitAll();
    else if (k === "z" || k === "Z") { if (e.ctrlKey && e.shiftKey) prevView(); else zoomBy(e.shiftKey ? 0.75 : 1.33); }
    else if (k === " ") toggleMenu("views");
    else if (k.startsWith("Arrow")) {
      const dx = k === "ArrowLeft" ? -1 : k === "ArrowRight" ? 1 : 0, dy = k === "ArrowUp" ? 1 : k === "ArrowDown" ? -1 : 0;
      if (e.ctrlKey) panBy(-dx, -dy); else orbitBy(-dx * step, dy * step);
    }
    else if ({ 1: "front", 2: "back", 3: "left", 4: "right", 5: "top", 7: "iso", 0: "plant" }[k]) setView({ 1: "front", 2: "back", 3: "left", 4: "right", 5: "top", 7: "iso", 0: "plant" }[k]);
    else done = false;
    if (done) { e.preventDefault(); e.stopPropagation(); }
  });
  syncTools();
}
// view cube + axis triad follow the camera
const SGN = [1, -1, 1, 0, -1, 1, -1, 0, 1, -1, 1, 0];
function updateCube() {
  const cube = wrap.querySelector(".p3-cube-in"), ax = wrap.querySelector(".p3-triad .ax");
  if (!cube) return;
  const e = camera.matrixWorldInverse.elements, m = [];
  for (let i = 0; i < 12; i++) m.push(i % 4 === 3 ? 0 : (e[i] * SGN[i]).toFixed(5));
  cube.style.transform = `matrix3d(${m.join(",")},0,0,0,1)`;
  const axes = [["X", new THREE.Vector3(1, 0, 0), "#d93a3f"], ["Y", new THREE.Vector3(0, 0, -1), "#2f9e44"], ["Z", new THREE.Vector3(0, 1, 0), "#2f6fd8"]];
  ax.innerHTML = axes.map(([n, v, c]) => {
    const p = v.transformDirection(camera.matrixWorldInverse), x = 35 + p.x * 24, y = 35 - p.y * 24;
    return `<line x1="35" y1="35" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/><text x="${(35 + p.x * 31).toFixed(1)}" y="${(35 - p.y * 31 + 4).toFixed(1)}" fill="${c}">${n}</text>`;
  }).join("");
}

window.Plant3D = {
  mount(container, h, pickCb) {
    helpers = h; onPick = pickCb;
    if (wrap && wrap.isConnected && container.contains(wrap)) return;
    build(container); applyLive();
    if (!raf) raf = requestAnimationFrame(frame);
  },
  update(l) { live = l; applyLive(); if (renderer && !raf) raf = requestAnimationFrame(frame); },
  unmount() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (renderer) { renderer.dispose(); renderer.forceContextLoss && renderer.forceContextLoss(); }
    renderer = null; scene = null; wrap = null;
  },
  /** test hooks: clickable machines in screen pixels, select / zoom by id, label boxes */
  targets() {
    if (!renderer) return [];
    const r = renderer.domElement.getBoundingClientRect(), v = new THREE.Vector3(), out = {};
    for (const m of pickables) {
      if (!m.userData.eq || out[m.userData.eq]) continue;
      m.getWorldPosition(v); v.project(camera);
      out[m.userData.eq] = { id: m.userData.eq, x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height, inView: Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 };
    }
    return Object.values(out);
  },
  select, zoomArea, isolate, setView, setStyle, zoomBy, prevView, fitAll, reset: () => fitBox(plantBox(), undefined, 1.02),
  ready: true,
};
window.dispatchEvent(new Event("plant3d-ready"));
