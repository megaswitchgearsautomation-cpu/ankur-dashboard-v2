"""Generate config/tags.json and config/equipment.json from the Op Panel documents.

Sources (decided with the user, 12-10-2026):
  * Digital inputs  : CLIENT "R1. IO LIST 9-2-26 (1).xlsx", sheet "DIGITAL INPUT" (112 DI = hardware X0~X6)
                      including the NC/NO contact type.
  * Digital outputs : CLIENT R1 list, sheet "DIGITAL OUTPUT" (identical to our list).
  * Analog inputs   : OUR "IO LIST FOR OP PANNEL latest 16_03_2026.xlsx", sheet "Analog input"
                      (PLC D registers: final value, alarm set point, alarm bit). Names/ranges match client R1.
  * Instrument & motor tag numbers, ratings: CLIENT "MOTOR LIST_OP (4).xlsx" (hard-coded tables below).

Every generated tag has mapping_verified = false.  Mark a tag verified in Admin only after
a Test Read on site matches the HMI / ISPSoft monitor value.

    python tools/import_io_list.py --ours "<our IO list.xlsx>" --client "<R1 IO list.xlsx>" [--out config] [--force]
"""
import argparse
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}


def read_sheet(path, sheet):
    z = zipfile.ZipFile(path)
    ss = []
    if "xl/sharedStrings.xml" in z.namelist():
        ss = ["".join(t.text or "" for t in si.iter("{%s}t" % NS["m"]))
              for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS)]
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rmap = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    for sh in wb.find("m:sheets", NS):
        if sh.get("name") != sheet:
            continue
        tgt = rmap[sh.get("{%s}id" % NS["r"])].lstrip("/")
        tgt = tgt if tgt.startswith("xl/") else "xl/" + tgt
        rows = []
        for row in ET.fromstring(z.read(tgt)).iter("{%s}row" % NS["m"]):
            d = {}
            for c in row.findall("m:c", NS):
                v = c.find("m:v", NS)
                if v is None:
                    continue
                d[re.sub(r"\d", "", c.get("r"))] = (ss[int(v.text)] if c.get("t") == "s" else v.text).strip()
            rows.append((int(row.get("r")), d))
        return rows
    raise SystemExit(f"sheet '{sheet}' not found in {path}")


def title(s):
    s = re.sub(r"(\w)\(", r"\1 (", s or "")
    s = re.sub(r"\s+", " ", s).strip()
    small = {"to", "of", "for", "and", "in"}
    words = []
    for i, w in enumerate(s.lower().split(" ")):
        if w in ("phe", "wtp", "lp", "dol", "vfd", "ll", "hl", "hh", "spp/ov/uv", "pb", "p.b.", "p.b", "di", "ug"):
            words.append(w.upper())
        elif i and w in small:
            words.append(w)
        else:
            words.append(re.sub(r"[a-z]", lambda m: m.group(0).upper(), w, count=1))
    s = " ".join(words)
    for a, b in (("Phe-2trip", "PHE-2 Trip"), ("Phe-1", "PHE-1"), ("Phe-2", "PHE-2"), ("Phe ", "PHE "), ("Acis", "Acid"),
                 ("Exhust", "Exhaust"), ("Deggasifier", "Degasifier"), ("Degassifier", "Degasifier"),
                 ("Pheumentic", "Pneumatic"), ("On-off", "On-Off"), ("De-gasifier", "De-Gasifier"),
                 ("Ug ", "UG "), ("Vfd", "VFD"), ("Dol", "DOL"), ("Wtp", "WTP"), ("Lp ", "LP "), ("Di ", "DI ")):
        s = s.replace(a, b)
    return s.strip()


def slug(s):
    s = re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_")
    return s[:56]


# Instrument tag numbers from the client motor list (ANALOG INPUT table) keyed by IO-list channel tag.
INSTRUMENTS = {
    "CT-01": "T-01", "CT-02": "T-02", "CT-03": "T-03", "CT-04": "T-04", "CT-05": "T-05", "CT-06": "T-06",
    "CT-07": "LT-01", "CT-08": "LT-02", "CT-09": "PH-01",
    "CT-10": "PT-01", "CT-11": "PT-02", "CT-12": "PT-03", "CT-13": "PT-04",
}


# ---------------------------------------------------------------------------
# Analog inputs: final scaled value (REAL), alarm setpoint (REAL), PLC alarm bit
# ---------------------------------------------------------------------------
def analog(rows):
    tags = []
    spare_no = 0
    for rnum, d in rows:
        chan, fin = d.get("D", ""), d.get("N", "")
        if not re.match(r"^(CT|A-AT)-\d+", chan) or not fin.startswith("D"):
            continue
        name = title(d.get("W") or d.get("T"))
        spec = d.get("Y", "")
        inst = INSTRUMENTS.get(chan)
        spare = inst is None or "spare" in name.lower()
        unit, lo, hi, group = "", 0.0, 100.0, "Spare"
        m = re.match(r"(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(.*)", spec)
        if m:
            lo, hi, u = float(m.group(1)), float(m.group(2)), m.group(3).strip().upper()
            if u.endswith("C"):          # "0-200⁰C"
                unit, group = "°C", "Temperature"
            if "MM" in u:
                unit, group = "mm", "Level"
            if "PH" in u:
                unit, group = "pH", "Analysis"
            if "BAR" in u:
                unit, group = "barg", "Pressure"
        if spare:
            group = "Spare"
            spare_no += 1
        word = {"Temperature": "Temp", "Pressure": "Pressure", "Level": "Level", "Analysis": "", "Spare": ""}[group]
        base = name if not word or word.lower() in name.lower() else f"{name} {word}"
        if name.lower().startswith("ph sensor"):
            base = "Process Water pH"
        disp = f"{inst} {base}" if inst and not spare else base
        tid = inst.replace("-", "_") if inst and not spare else "AI_SPARE_" + re.sub(r"\D+", "_", d.get("F", chan)).strip("_")
        src = f"Our IO list 16_03_2026 / Analog input row {rnum}; client R1 + motor list for tag/range"
        sp_id = f"{tid}_ALM_SP"
        tags.append({
            "id": tid, "name": disp, "group": group, "area": "Process",
            "description": f"{inst or chan} · AI channel {d.get('F', '')} · {spec or 'spare'} 4-20 mA",
            "plc_tag": d.get("X", ""), "device": fin, "data_type": "REAL", "word_order": "default",
            "invert": False, "scaling": {"mode": "none"}, "unit": unit, "decimals": 2 if unit == "pH" else 1,
            "eng_min": lo, "eng_max": hi, "poll_ms": 1000, "show_on_dashboard": not spare, "trend": not spare,
            "log": not spare, "kpi": tid in ("LT_01", "PH_01", "PT_01"), "setpoint_tag": None if spare else sp_id,
            "alarm": {"enabled": False, "hi": None, "lo": None, "hihi": None, "lolo": None, "deadband": 0,
                      "priority": "yellow", "delay_s": 5},
            "mapping_verified": False, "source_ref": src,
            "notes": f"PLC final scaled value (REAL, confirmed). Raw count {d.get('H')}, 4-20mA {d.get('I')}, "
                     f"min {d.get('J')}, max {d.get('K')}, sim value {d.get('L')}, sim bit {d.get('M')}.",
        })
        if spare:
            continue
        tags.append({
            "id": sp_id, "name": f"{disp} - alarm set point", "group": group, "area": "Process",
            "description": f"{inst} alarm set point (HMI)", "plc_tag": "", "device": d.get("O"),
            "data_type": "REAL", "word_order": "default", "invert": False, "scaling": {"mode": "none"},
            "unit": unit, "decimals": 2 if unit == "pH" else 1, "eng_min": lo, "eng_max": hi, "poll_ms": 5000,
            "show_on_dashboard": False, "trend": False, "log": True, "kpi": False, "setpoint_tag": None,
            "alarm": {"enabled": False}, "mapping_verified": False, "source_ref": src,
            "notes": f"ASSUMED REAL (2-word spacing) - verify. Set delay {d.get('P')}, actual delay {d.get('Q')}.",
        })
        if d.get("R"):
            tags.append({
                "id": f"{tid}_ALM", "name": f"{disp} - PLC alarm", "group": "PLC alarms", "area": "Process",
                "description": f"{inst} alarm indication bit from PLC", "plc_tag": f"FB_{d.get('X', '')}_High",
                "device": d["R"], "data_type": "BOOL", "word_order": "default", "invert": False,
                "scaling": {"mode": "none"}, "unit": "", "decimals": 0, "poll_ms": 1000,
                "show_on_dashboard": False, "trend": False, "log": True, "kpi": False,
                "states": {"false": "Normal", "true": "ALARM"},
                "alarm": {"enabled": True, "on": True, "priority": "red",
                          "message": f"{disp}: PLC alarm (above set point)", "delay_s": 0},
                "mapping_verified": False, "source_ref": src, "notes": "Bit of word device (read via FC03).",
            })
    return tags


# ---------------------------------------------------------------------------
# Digital inputs (client R1 list) - NC/NO taken from the client list.
# Convention after optional inversion: TRUE = the condition in the name is present
#   (running / tripped / relay operated / E-stop pressed / level reached).
# ---------------------------------------------------------------------------
def digital_inputs(rows, our_symbols):
    tags = []
    for rnum, d in rows:
        addr = d.get("C", "")
        if not re.match(r"^[Xx]\d+\.\d+$", addr):
            continue
        addr = "X" + addr[1:]
        raw_name = d.get("D", "")
        name = title(raw_name)
        contact = d.get("E", "").upper()
        low = raw_name.lower()
        nc = contact == "NC"
        invert, kind, group = False, "status", "Digital inputs"
        alarm = {"enabled": False}
        states = {"false": "OFF", "true": "ON"}
        notes = [f"Contact type (client R1): {contact or 'n/a'}."]
        if "on feedback" in low:
            kind, group = "run_fb", "Motor feedback"
            states = {"false": "Stopped", "true": "Running"}
            name = name.replace("On Feedback", "Run Feedback")
        elif low.rstrip().endswith("trip"):
            kind, group, invert = "trip", "Motor feedback", nc
            states = {"false": "Healthy", "true": "TRIP"}
            base = re.sub(r"\s*Trip$", "", name)
            alarm = {"enabled": True, "on": True, "priority": "red", "message": f"{base} tripped", "delay_s": 1}
            if nc:
                notes.append("NC trip contact: input ON = healthy, so the value is inverted (TRUE = tripped).")
        elif "emergency stop" in low:
            group, invert = "Safety", nc
            states = {"false": "Healthy", "true": "PRESSED"}
            alarm = {"enabled": True, "on": True, "priority": "red", "message": f"{name} pressed", "delay_s": 0}
            if nc:
                notes.append("NC push button: input ON = healthy, value inverted (TRUE = pressed).")
        elif "relay" in low:
            group, invert = "Safety", nc
            states = {"false": "Healthy", "true": "OPERATED"}
            alarm = {"enabled": True, "on": True, "priority": "red", "message": f"{name} operated", "delay_s": 1}
            if nc:
                notes.append("NC relay contact: input ON = healthy, value inverted (TRUE = operated).")
        elif "float sensor" in low:
            group = "Level switches"
            states = {"false": "OFF", "true": "ON"}
            notes.append("Float switch logic (NC) depends on mounting - check which state means 'level reached'.")
        elif "valve" in low and (low.endswith("open") or low.endswith("close")):
            group = "Valve feedback"
            states = {"false": "-", "true": "Yes"}
        elif "selector" in low or "p.b" in low or "local/remote" in low:
            group = "Panel controls"
        elif "potential free" in low or "pressure switch" in low or "flow switch" in low:
            group = "Interlocks"
        if low.startswith("spare -"):
            group = "Spare"
        sym = our_symbols.get(addr)
        tid = sym or "DI_" + slug(name)
        tags.append({
            "id": tid, "name": name, "group": group, "area": "Panel", "description": f"{addr} · {contact}",
            "plc_tag": sym or "", "device": addr, "data_type": "BOOL", "word_order": "default", "invert": invert,
            "scaling": {"mode": "none"}, "unit": "", "decimals": 0, "poll_ms": 1000,
            "show_on_dashboard": group in ("Safety", "Level switches", "Interlocks"), "trend": False,
            "log": group != "Spare", "kpi": False, "states": states, "alarm": alarm, "mapping_verified": False,
            "source_ref": f"Client R1 IO LIST 9-2-26 / DIGITAL INPUT row {rnum}", "notes": " ".join(notes),
        })
    return tags


def digital_outputs(rows):
    tags = []
    for rnum, d in rows:
        addr = d.get("C", "")
        if not re.match(r"^Y\d+\.\d+$", addr):
            continue
        raw = d.get("D", "")
        name = title(raw)
        low = raw.lower()
        group = "Outputs"
        if "tower light" in low or "lamp" in low or "hooter" in low:
            group = "Panel indication"
        if low.startswith("spare -"):
            group = "Spare"
        tags.append({
            "id": "DO_" + slug(name), "name": f"{name} (cmd)", "group": group, "area": "Panel",
            "description": f"{addr} · {d.get('E', '')}", "plc_tag": "", "device": addr,
            "data_type": "BOOL", "word_order": "default", "invert": False, "scaling": {"mode": "none"},
            "unit": "", "decimals": 0, "poll_ms": 1000, "show_on_dashboard": group == "Panel indication",
            "trend": False, "log": group != "Spare", "kpi": False, "states": {"false": "OFF", "true": "ON"},
            "alarm": {"enabled": False}, "mapping_verified": False,
            "source_ref": f"Client R1 IO LIST 9-2-26 / DIGITAL OUTPUT row {rnum}", "notes": "PLC output coil (read only).",
        })
    return tags


# Motors: (id, tag no., name, area, run X, trip X, cmd Y, kW, starter) - tag/kW/starter from client motor list.
MOTORS = [
    ("OP_P1A", "OP-P1A", "UG Sludge Pump to Volute Press (Main)", "Sludge handling", "X0.8", "X0.9", "Y0.0", 1.5, "DOL"),
    ("OP_P1B", "OP-P1B", "UG Sludge Pump to Volute Press (Standby)", "Sludge handling", "X0.10", "X0.11", "Y0.1", 1.5, "DOL"),
    ("OP_P2", "OP-P2", "Dryer Hot Water Inlet Pump", "Dryer & condenser", "X0.12", "X0.13", "Y0.2", 15, "VFD"),
    ("OP_P3", "OP-P3", "CT Water Pump - Surface Condenser of Dryer", "Dryer & condenser", "X0.14", "X0.15", "Y0.4", 15, "DOL"),
    ("OP_F1", "OP-F1", "CT Fan - Surface Condenser of Dryer & PHE-2", "Dryer & condenser", "X1.0", "X1.1", "Y0.5", 7.5, "DOL"),
    ("OP_P4", "OP-P4", "Centrifugal Pump Surface Condensate to Degas", "Degasifier", "X1.2", "X1.3", "Y0.6", 0.75, "DOL"),
    ("OP_P5A", "OP-P5A", "Filtrate Tank Pump (Main)", "Sludge handling", "X1.4", "X1.5", "Y0.7", 1.5, "DOL"),
    ("OP_P5B", "OP-P5B", "Filtrate Tank Pump (Standby)", "Sludge handling", "X1.6", "X1.7", "Y0.8", 1.5, "DOL"),
    ("OP_P6A", "OP-P6A", "UG Submersible Pump (Main)", "Water", "X1.8", "X1.9", "Y0.9", 9.3, "DOL"),
    ("OP_P6B", "OP-P6B", "UG Submersible Pump (Standby)", "Water", "X1.10", "X1.11", "Y0.10", 9.3, "DOL"),
    ("OP_P7", "OP-P7", "PHE Cooling Tower (Water Circulation) Pump", "Degasifier", "X1.12", "X1.13", "Y0.11", 0.75, "DOL"),
    ("OP_P8", "OP-P8", "Gravity Tank to WTP - PHE Water Pump", "Water", "X1.14", "X1.15", "Y0.12", 0.75, "DOL"),
    ("OP_M1", "OP-M1", "Degasifier Exhaust Blower (Hot Air Blower)", "Degasifier", "X2.0", "X2.1", "Y0.13", 2.2, "Bypass relay"),
    ("OP_P9", "OP-P9", "Degasifier Circulating Water Pump", "Degasifier", "X2.2", "X2.3", "Y0.15", 1.5, "VFD"),
    ("OP_P10", "OP-P10", "Turbine Oil Cooling Centrifugal Pump", "Turbine & boiler", "X2.4", "X2.5", "Y1.1", 0.75, "DOL"),
    ("OP_F2", "OP-F2", "Turbine Oil Cooling Tower Fan", "Turbine & boiler", "X2.6", "X2.7", "Y1.2", 0.75, "DOL"),
    ("OP_P11", "OP-P11", "Boiler Cooling Water Pump", "Turbine & boiler", "X2.8", "X2.9", "Y1.3", 0.75, "DOL"),
    ("OP_P12", "OP-P12", "Acid Dosing Pump", "Dosing", "X2.10", "X2.11", "Y1.4", 0.55, "DOL 1-ph"),
    ("OP_P13", "OP-P13", "Base Dosing Pump", "Dosing", "X2.12", "X2.13", "Y1.5", 0.55, "DOL 1-ph"),
    ("OP_P14", "OP-P14", "Make Up Water Pump (Main)", "Water", "X2.14", "X2.15", "Y1.6", 3.7, "DOL"),
    ("OP_P15", "OP-P15", "Make Up Water Pump (Standby)", "Water", "X3.0", "X3.1", "Y1.7", 3.7, "DOL"),
    ("PCP", "", "Progressive Cavity Pump", "Sludge handling", "X3.2", "X3.3", "Y1.8", None, ""),
    ("AGIT", "", "Agitator Propeller Mixer - Sludge Tank", "Sludge handling", "X3.4", "X3.5", "Y1.9", None, ""),
    ("OP_P16", "OP-P16", "Spare Pump-1 (DOL starter)", "Spare", "X3.6", "X3.7", "Y1.10", 1.5, "DOL"),
    ("OP_P17", "OP-P17", "Spare Pump-2 (DOL starter)", "Spare", "X3.8", "X3.9", "Y1.11", 2.2, "DOL"),
]
# Valves: (id, tag no., name, area, open fb X, close fb X, open cmd Y, close cmd Y)
VALVES = [
    ("MV_01", "MV-01", "Sludge Feed On-Off Valve", "Sludge handling", "X5.12", "X5.13", "Y1.12", "Y1.13"),
    ("OP_SV1", "OP-SV1", "LP Steam On-Off Valve", "Dryer & condenser", "X5.14", "X5.15", "Y1.14", "Y1.15"),
    ("OP_SV2", "OP-SV2", "Process Water On-Off Valve", "Water", "X6.0", "X6.1", "Y2.0", "Y2.1"),
]


def build_equipment(tags):
    by_dev = {t["device"]: t["id"] for t in tags}
    eq = []
    for eid, tagno, name, area, run, trip, cmd, kw, starter in MOTORS:
        e = {"id": eid, "tag_no": tagno, "name": name, "area": area, "type": "motor", "kw": kw, "starter": starter,
             "run_tag": by_dev.get(run), "trip_tag": by_dev.get(trip), "cmd_tag": by_dev.get(cmd), "fb_timeout_s": 5}
        if eid == "OP_M1":
            e["notes"] = "Single blower (motor list OP-M1, bypass relay starter). Y0.14 'standby' is its standby/bypass contactor output, not a second motor."
        if not tagno:
            e["notes"] = "In the IO lists but not in the client motor list - confirm tag number and rating."
        eq.append(e)
    for eid, tagno, name, area, o, c, oc, cc in VALVES:
        eq.append({"id": eid, "tag_no": tagno, "name": name, "area": area, "type": "valve", "starter": "24 VDC SOV",
                   "open_tag": by_dev.get(o), "close_tag": by_dev.get(c), "open_cmd_tag": by_dev.get(oc),
                   "close_cmd_tag": by_dev.get(cc)})
    return eq


def main():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap = argparse.ArgumentParser()
    ap.add_argument("--ours", required=True, help="IO LIST FOR OP PANNEL latest 16_03_2026.xlsx (analog D registers)")
    ap.add_argument("--client", required=True, help="R1. IO LIST 9-2-26 (1).xlsx (client DI/DO list)")
    ap.add_argument("--out", default=os.path.join(here, "config"))
    ap.add_argument("--force", action="store_true", help="overwrite existing tags.json / equipment.json")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    # reuse our ISPSoft symbol names where the address is identical in both lists (X0.0 ~ X3.5)
    ours_di = read_sheet(a.ours, "Digital Input (Modify)")
    client_di = read_sheet(a.client, "DIGITAL INPUT")
    client_names = {("X" + d["C"][1:]): re.sub(r"\W", "", d.get("D", "").lower()) for _, d in client_di if re.match(r"^[Xx]\d+\.\d+$", d.get("C", ""))}
    our_symbols = {}
    for _, d in ours_di:
        addr = d.get("E", "")
        if re.match(r"^[Xx]\d+\.\d+$", addr) and d.get("J"):
            addr = "X" + addr[1:]
            ours_name = re.sub(r"\W", "", (d.get("G") or "").lower())
            if client_names.get(addr) and client_names[addr] == ours_name and not ours_name.startswith("spare"):
                our_symbols[addr] = d["J"]

    tags = analog(read_sheet(a.ours, "Analog input"))
    tags += digital_inputs(client_di, our_symbols)
    tags += digital_outputs(read_sheet(a.client, "DIGITAL OUTPUT"))
    seen = {}
    for t in tags:
        base = t["id"] = re.sub(r"[^A-Za-z0-9_\-]", "_", t["id"])[:60]
        if base in seen:
            seen[base] += 1
            t["id"] = f"{base}_{seen[base]}"
        else:
            seen[base] = 0
    eq = build_equipment(tags)

    os.makedirs(a.out, exist_ok=True)
    for fn, data in (("tags.json", tags), ("equipment.json", eq)):
        p = os.path.join(a.out, fn)
        if os.path.exists(p) and not a.force:
            print(f"skip {p} (exists, use --force)")
            continue
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        print(f"wrote {p} ({len(data)} items)")
    missing = [(e["id"], k) for e in eq for k, v in e.items() if k.endswith("_tag") and v is None]
    if missing:
        print("equipment links not found:", missing)
    print(f"DI symbols reused from our list: {len(our_symbols)}")


if __name__ == "__main__":
    main()
