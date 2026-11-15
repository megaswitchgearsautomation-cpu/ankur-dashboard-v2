"""Dashboard AI assistant: answers operator questions about the live plant (alarms and how to fix them,
tank levels, pumps, set points) from the same view-only data the client dashboard shows.

- With Claude credentials (data/ai_config.json "api_key", or ANTHROPIC_API_KEY) it asks Claude, with the plant
  knowledge file (data/ai_knowledge.md: P&ID + control philosophy) as a cached system prompt and a fresh live
  snapshot in every question.
- Without credentials, or if the Anthropic SDK is not installed, it answers the common questions itself
  (active alarms, empty / low / full tanks, tripped or stopped machines, plant summary) so the panel still works.
Read-only: the assistant has no tools and can never write to the PLC.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone

DEFAULT_MODEL = "claude-opus-5-5"
MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]   # best / balanced / cheapest
EFFORTS = ["low", "medium", "high"]
NO_FALLBACK = {"claude-haiku-5-5"}       # server-side refusal fallback not offered for Haiku
MAX_QUESTION = 1000          # characters
MAX_HISTORY = 8              # previous turns (user + assistant messages) sent back for follow-up questions
RATE_LIMIT = (10, 60)        # questions per session per window (seconds)
IST = timezone(timedelta(hours=5, minutes=30))

SYSTEM_RULES = """You are the AI assistant built into the plant monitoring dashboard of the FSTP-200 faecal sludge treatment plant at Muttathara, Trivandrum (OP panel, Delta AH500 PLC).
Operators and engineers ask you about the live plant: active alarms and how to fix them, which tanks are empty / low / full, why a pump is or is not running, set points, pressures, temperatures and pH.

How to answer:
- Base every statement about the current plant state on the LIVE SNAPSHOT in the user's message. Quote the actual values, units and tag numbers (P&ID numbers such as 01-P-101, 03-LS-301).
- Use the plant knowledge below (P&ID, control philosophy, alarm list, troubleshooting) to explain causes and what to check. Give practical, ordered checks an operator can do. Say when something must be done by an electrician or the Ankur / Medge engineer, and remind about lock-out / tag-out before touching motors.
- If the snapshot says the data is DEMO / simulated, say the values are simulated (not the real plant).
- A float switch ON means liquid has reached it. For a tank with only HL / LL switches: HL ON = full/high, LL OFF = low/empty, between = normal. Level transmitter tanks (LT-01, LT-02) have a value in mm and HH/H/L/LL set points.
- The snapshot contains everything the dashboard shows: analog values with ranges, alarm set points and alarm delays, tank level set points, process set values, every machine with state, Auto/Manual mode, run hours and starts, float / pressure / flow switches, valve feedback, interlocks, active alarms and the recent alarm / event history. Use all of it - for "full status", "run hours", "which are in manual", "what changed" and similar questions, go through the relevant sections and list every item that matters.
- You yourself cannot start, stop, open, close or change anything. Operators / admins change set points on the dashboard's **Set points** page; Auto / Manual is switched on the panel (the dashboard only shows it), and machines are started / stopped from the panel. Explain this when asked.
- If the snapshot does not contain what is needed, say what is missing instead of guessing.
- You may also answer general questions (process engineering, pumps, motors, VFDs, instruments, water / sludge treatment, maintenance, safety, units and calculations) from your own knowledge, like a senior plant engineer - relate the answer to this plant when it helps.
- Answer in the user's language (English, Hindi or Hinglish as they write; Devanagari if they write Devanagari).
- Fit the length to the question: a direct one-line answer first. Simple questions get a short answer; "why", "how", troubleshooting, "full details" or "explain" questions get a complete, well-ordered answer with every relevant value and check. No introductions and no repeating the question.
- Use **bold** for tag numbers, values and states that matter. Short markdown tables are fine for lists of many values (e.g. all run hours, all set points).
- On this client dashboard say "plant" / "panel" / "control system" - do not use the words "PLC" or "HMI" in answers.
"""


def _now_txt(ts=None):
    t = datetime.fromtimestamp(ts if ts is not None else time.time(), timezone.utc)
    return f"{t.strftime('%Y-%m-%d %H:%M:%S')} UTC / {t.astimezone(IST).strftime('%H:%M:%S')} IST"


def _fmt(v, dec=1):
    if v is None:
        return "no data"
    if isinstance(v, bool):
        return "ON" if v else "OFF"
    if isinstance(v, (int, float)):
        return f"{v:.{dec}f}" if isinstance(v, float) else str(v)
    return str(v)


def _levels_mm(t, aux):
    """HH/H/L/LL set points of a level transmitter as {key: (value_in_tank_units, text)}.
    The HMI set points are in % of the range (client philosophy: '% settable') when their unit is '%'."""
    lo, hi = t.get("eng_min") or 0, t.get("eng_max")
    out = {}
    for k in ("HH", "H", "L", "LL"):
        a = aux.get(f"{t['id']}_{k}_SP") or {}
        v = a.get("value")
        if v is None:
            return {}
        if a.get("unit") == "%" and hi not in (None, lo):
            mm = lo + v / 100 * (hi - lo)
            out[k] = (mm, f"{v:g}% ({mm:.0f} {t.get('unit') or ''})".strip())
        else:
            out[k] = (v, f"{v:g}")
    return out


def _alarm_txt(a):
    """A tag's 'alarm' field: a dict of limit flags {'hi': ..., 'lo': ...} or a text; None when nothing is active."""
    if isinstance(a, dict):
        on = [k.upper() for k, v in a.items() if v]
        return ", ".join(on) or None
    return str(a) if a else None


def _on(v):
    return v is True or v == 1 or (isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0.5)


# ---------------------------------------------------------------------------------------------
# live snapshot (plain text) from the client /api/live payload
# ---------------------------------------------------------------------------------------------
def snapshot_text(live: dict) -> str:
    st = live.get("status") or {}
    mode = {"demo": "DEMO - values are SIMULATED, not the real plant", "live": "LIVE from the plant",
            "offline": "OFFLINE - connection to the plant lost, values may be old"}.get(st.get("state"), st.get("state") or "unknown")
    lines = [f"LIVE SNAPSHOT at {_now_txt(live.get('server_time'))}", f"Data: {mode}"
             + (f" (last update {_now_txt(st['last_update'])})" if st.get("last_update") else "")]
    aux = live.get("aux") or {}

    def sp(tag_id):
        a = aux.get(f"{tag_id}_ALM_SP")
        return None if not a or a.get("value") is None else a["value"]

    lines.append("\nANALOG VALUES (name = value unit [range] {alarm set point / level set points})")
    for t in live.get("tags") or []:
        if t.get("group") not in ("Temperature", "Pressure", "Level", "Analysis"):
            continue
        extra = []
        if t.get("eng_min") is not None and t.get("eng_max") is not None:
            extra.append(f"range {t['eng_min']:g}-{t['eng_max']:g}")
        s = sp(t["id"])
        if s is not None:
            extra.append(f"alarm SP {_fmt(s, t.get('decimals', 1))}")
        dly, act = aux.get(f"{t['id']}_ALM_DLY") or {}, aux.get(f"{t['id']}_ALM_ACT") or {}
        if dly.get("value") is not None:
            extra.append(f"alarm delay {_fmt(dly['value'], 0)} s (running {_fmt(act.get('value'), 0)} s)")
        lv = _levels_mm(t, aux)
        if lv:
            extra.append("Level set points " + " ".join(f"{k} {txt}" for k, (_mm, txt) in lv.items()))
        elif t.get("levels"):
            extra.append("levels " + " ".join(f"{k.upper()} {v:g}" for k, v in t["levels"].items()))
        pct = ""
        if isinstance(t.get("value"), (int, float)) and t.get("eng_max") not in (None, t.get("eng_min")):
            pct = f" ({(t['value'] - (t.get('eng_min') or 0)) / (t['eng_max'] - (t.get('eng_min') or 0)) * 100:.0f}% of range)"
        q = "" if t.get("quality") in ("GOOD", "SIMULATED") else f" quality {t.get('quality')}"
        al = f" ALARM {_alarm_txt(t.get('alarm'))}" if _alarm_txt(t.get("alarm")) else ""
        lines.append(f"- {t['id']} {t.get('name')} = {_fmt(t.get('value'), t.get('decimals', 1))} {t.get('unit') or ''}{pct}"
                     f" [{', '.join(extra)}]{q}{al}")

    eql = live.get("equipment") or []
    n_run = sum(1 for e in eql if e.get("status") in ("RUNNING", "OPEN"))
    n_trip = sum(1 for e in eql if e.get("status") in ("TRIP", "FAULT"))
    n_man = sum(1 for e in eql if e.get("auto") is False)
    lines.append(f"\nEQUIPMENT ({len(eql)} items: {n_run} running/open, {n_trip} tripped, {n_man} in Manual)"
                 " (id | P&ID / tag | name | kW | state | mode | run hours | starts)")
    for e in eql:
        mode_txt = "-" if e.get("auto") is None else ("Auto" if e["auto"] else "Manual")
        if e.get("pair") and e.get("standby_selected") is not None:
            mode_txt += ", standby selected" if e["standby_selected"] else ", main selected"
        io = e.get("io") or {}
        io_txt = " ".join(f"{k}={'1' if _on(v) else '0'}" for k, v in io.items() if v is not None)
        pid = EQUIP.get(e["id"], (None,))[0]
        tag_txt = f"{pid} / {e.get('tag_no')}" if pid else e.get("tag_no")
        kw = f"{e['kw']:g} kW" if isinstance(e.get("kw"), (int, float)) else "-"
        lines.append(f"- {e['id']} | {tag_txt} | {e.get('name')} | {kw} | {e.get('status')} | {mode_txt} | "
                     f"{_fmt(e.get('run_hours'))} h | {e.get('starts', '-')}" + (f" | signals {io_txt}" if io_txt else ""))

    groups = {}
    for k, a in aux.items():
        if k.endswith("_ALM_SP") or k.endswith("_HH_SP") or k.endswith("_H_SP") or k.endswith("_L_SP") or k.endswith("_LL_SP"):
            continue
        groups.setdefault(a.get("group") or "Other", []).append((k, a))
    titles = {"PLC alarms": "PANEL ALARM SIGNALS", "Selectors": "AUTO / MANUAL SELECTORS (ON = Auto)"}
    for g in ("Level switches", "Safety", "Interlocks", "Set values", "Selectors", "Panel controls", "Panel indication",
              "PLC alarms", "Valve feedback"):
        items = groups.get(g)
        if not items:
            continue
        lines.append(f"\n{titles.get(g, g.upper())}")
        for k, a in sorted(items, key=lambda x: x[1].get("name") or x[0]):
            v = a.get("value")
            if v is None or a.get("quality") == "NODATA":
                val = "no data"
            elif g == "Selectors":
                val = "AUTO" if _on(v) else "MANUAL"
            elif isinstance(v, bool) or g != "Set values":
                val = "ON" if _on(v) else "OFF"
            else:
                val = f"{_fmt(v, a.get('decimals', 1))} {a.get('unit') or ''}".strip()
                if a.get("unit") == "%":                       # level set points in % of the sludge tank range
                    lt = _tag(live, "LT_01")
                    if lt and lt.get("eng_max") not in (None, lt.get("eng_min")):
                        lo = lt.get("eng_min") or 0
                        val += f" ({lo + v / 100 * (lt['eng_max'] - lo):.0f} {lt.get('unit') or ''} of LT-01)"
            name = (a.get("name") or k).replace(" - Auto/Manual selector", "")
            lines.append(f"- {name} = {val}")

    al = live.get("alarms") or []
    lines.append(f"\nACTIVE ALARMS ({len(al)})")
    for a in al:
        since = _now_txt(a["raised_at"]) if a.get("raised_at") else "?"
        ack = f", acknowledged by {a.get('acked_by') or '?'}" if a.get("acked_at") else ", NOT acknowledged"
        note = f", operator note: {a['note']}" if a.get("note") else ""
        prev = "; ".join(n.get("note", "") for n in (a.get("previous_notes") or [])[:3] if n.get("note"))
        lines.append(f"- [{a.get('priority')}] {a.get('message')} ({a.get('tag_name')}) since {since}{ack}{note}"
                     + (f"; earlier fixes noted: {prev}" if prev else ""))
    if not al:
        lines.append("- none")

    ra = live.get("recent_alarms")
    if ra is not None:
        lines.append(f"\nALARM HISTORY - LAST 24 H ({len(ra)}, newest first)")
        for a in ra[:40]:
            end = f"cleared {_now_txt(a['cleared_at'])}" if a.get("cleared_at") else "still active"
            lines.append(f"- {_now_txt(a.get('raised_at'))}: [{a.get('priority')}] {a.get('message')} - {end}"
                         + (f", acknowledged by {a['acked_by']}" if a.get("acked_by") else ""))
        if not ra:
            lines.append("- none")
    rc = live.get("recent_changes")
    if rc:
        lines.append("\nRECENT SET POINT / SELECTOR CHANGES MADE ON THE DASHBOARD (newest first)")
        lines += [f"- {_now_txt(c.get('ts'))}: {c.get('detail')}" for c in rc[:20]]
    return "\n".join(lines)


# ---------------------------------------------------------------------------------------------
# offline answers (no Claude credentials): specific answers from the live data + the control philosophy
# ---------------------------------------------------------------------------------------------
SWT = {   # float / pressure / flow switches (aux ids)
    "RAW_LL": "DI_Magnetic_Float_Sensor_Raw_Water_Tank_LL", "RAW_HL": "DI_Magnetic_Float_Sensor_Raw_Water_Tank_HL",
    "CT1_LL": "DI_Float_Sensor_Cooling_Tower_1_LL", "CT1_HL": "DI_Float_Sensor_Cooling_Tower_1_HL",
    "CT2_LL": "DI_Float_Sensor_Cooling_Tower_2_LL", "CT2_HL": "DI_Float_Sensor_Cooling_Tower_2_HL",
    "HW_LL": "DI_Magnetic_Float_Sensor_Hot_Water_Tank_LL", "HW_HL": "DI_Magnetic_Float_Sensor_Hot_Water_Tank_HL",
    "DG_HH": "DI_Magnetic_Float_Sensor_De_Gasifier_HH", "DG_H": "DI_Magnetic_Float_Sensor_De_Gasifier_H",
    "DG_L": "DI_Magnetic_Float_Sensor_De_Gasifier_L", "DG_LL": "DI_Magnetic_Float_Sensor_De_Gasifier_LL",
    "GT_LL": "DI_Magnetic_Float_Sensor_Gravity_Tank_LL", "GT_HL": "DI_Magnetic_Float_Sensor_Gravity_Tank_HL",
    "CTP_HL": "DI_Float_Sensor_Raw_Water_Tank_1_HL", "CTP_LL": "DI_Float_Sensor_Raw_Water_Tank_1_LL",
    "PW_HL": "DI_Float_Sensor_Pure_Water_Tank_2_HL", "PW_LL": "DI_Float_Sensor_Pure_Water_Tank_2_LL",
    "AIR": "DI_Pressure_Switch_for_Pneumatic_Air_Line", "FLOW": "DI_Flow_Switch_for_Ground_Water_Pump_to_Raw_Water_Storage_T",
}

# equipment: P&ID tag, words that identify it in a question, the PLC rule, and the live signals behind the rule
EQUIP = {
    "OP_P1A": ("01-P-101", "sludge pump main", "Starts at sludge tank NL, stops at VLL (dry-run protection); main/standby selector; mixer OP-A1 must start 60 s before.",
               [("tag", "LT_01"), ("sp", "SP_SLUDGE_PUMP_START", "start level"), ("sp", "SP_SLUDGE_PUMP_STOP", "stop level"), ("eq", "AGIT")]),
    "OP_P1B": ("01-P-102", "sludge pump standby", "Standby of 01-P-101: same NL start / VLL stop, runs when standby is selected.",
               [("tag", "LT_01"), ("sp", "SP_SLUDGE_PUMP_START", "start level"), ("sp", "SP_SLUDGE_PUMP_STOP", "stop level"), ("eq", "AGIT")]),
    "AGIT": ("OP-A1", "mixer agitator propeller", "Starts 60 s before the selected sludge pump, stops 60 s after it.", [("eq", "OP_P1A"), ("eq", "OP_P1B")]),
    "PCP": ("OP-P201", "progressive cavity pc pump volute", "Runs with the sludge pump and mixer; stops at sludge tank VLL.", [("tag", "LT_01"), ("eq", "OP_P1A"), ("eq", "AGIT")]),
    "MV_01": ("01-MV-101", "sludge feed valve inlet", "Opens at sludge tank LL, closes at HH; needs instrument air; closes on air low / E-stop / LT-101 fault.",
              [("tag", "LT_01"), ("sp", "SP_SLUDGE_VALVE_OPEN", "open level"), ("sp", "SP_SLUDGE_VALVE_CLOSE", "close level"), ("sw", "AIR", "instrument air")]),
    "OP_P5A": ("01-P-103", "filtrate pump main", "Starts at filtrate tank NL, stops at VLL.", [("tag", "LT_02")]),
    "OP_P5B": ("01-P-104", "filtrate pump standby", "Standby of 01-P-103: NL start, VLL stop.", [("tag", "LT_02")]),
    "OP_P6A": ("03-P-301", "borewell ground water underground submersible pump main", "Starts at raw water tank LL, stops at HL.",
               [("sw", "RAW_LL", "raw water tank LL"), ("sw", "RAW_HL", "raw water tank HL"), ("sw", "FLOW", "flow switch 03-FS-301")]),
    "OP_P6B": ("03-P-302", "borewell ground water underground submersible pump standby", "Standby of 03-P-301: LL start, HL stop.",
               [("sw", "RAW_LL", "raw water tank LL"), ("sw", "RAW_HL", "raw water tank HL"), ("sw", "FLOW", "flow switch 03-FS-301")]),
    "OP_P14": ("03-P-303", "make-up makeup transfer supply pump main vfd", "Runs above raw water tank LL, stops at LL; VFD holds header >= 3 kg/cm2 from PT-301.",
               [("sw", "RAW_LL", "raw water tank LL"), ("tag", "PT_01")]),
    "OP_P15": ("03-P-304", "make-up makeup transfer supply pump standby vfd", "Standby of 03-P-303: same rule.", [("sw", "RAW_LL", "raw water tank LL"), ("tag", "PT_01")]),
    "OP_P7": ("06-P-601", "cooling tower 1 ct1 degasifier de-gasifier phe pump", "Runs when 06-LS-601 is above low, stops at LL.", [("sw", "CT1_LL", "CT-1 basin LL"), ("sw", "CT1_HL", "CT-1 basin HL")]),
    "OP_P3": ("06-P-602", "cooling tower 1 ct1 dryer surface condenser pump", "Runs when 06-LS-601 is above low, stops at LL.", [("sw", "CT1_LL", "CT-1 basin LL"), ("sw", "CT1_HL", "CT-1 basin HL")]),
    "OP_P11": ("06-P-603", "cooling tower 1 ct1 boiler cooling pump", "Runs when 06-LS-601 is above low, stops at LL.", [("sw", "CT1_LL", "CT-1 basin LL"), ("sw", "CT1_HL", "CT-1 basin HL")]),
    "OP_F1": ("06-F-601", "cooling tower 1 ct1 fan", "Runs only while a CT-1 pump runs; stops at basin LL.", [("eq", "OP_P7"), ("eq", "OP_P3"), ("eq", "OP_P11"), ("sw", "CT1_LL", "CT-1 basin LL")]),
    "OP_P10": ("06-P-604", "cooling tower 2 ct2 turbine oil cooling pump", "Runs when 06-LS-602 is above low, stops at LL.", [("sw", "CT2_LL", "CT-2 basin LL"), ("sw", "CT2_HL", "CT-2 basin HL")]),
    "OP_F2": ("06-F-602", "cooling tower 2 ct2 fan", "Runs only with pump 06-P-604; stops at basin LL.", [("eq", "OP_P10"), ("sw", "CT2_LL", "CT-2 basin LL")]),
    "OP_P2": ("06-P-605", "hot water pump dryer", "Runs above hot water tank LL (dryer available), stops at LL (and HH per interlock list).",
              [("sw", "HW_LL", "hot water tank LL"), ("sw", "HW_HL", "hot water tank HL"), ("tag", "T_02"), ("tag", "PT_03")]),
    "OP_P4": ("05-P-501", "condensate degasifier de-gasifier pump", "Starts when T-101 is above low AND 07-LS-701 at H; stops at 07-LS-701 HH or T-101 low.",
              [("sw", "DG_H", "de-gasifier H"), ("sw", "DG_HH", "de-gasifier HH")]),
    "OP_P9": ("07-P-701", "recirculation recirculating degasifier circulating pump", "Runs at 07-LS-701 L or above, stops at LL.", [("sw", "DG_L", "de-gasifier L"), ("sw", "DG_LL", "de-gasifier LL")]),
    "OP_P12": ("07-P-702", "acid dosing pump", "On at pH <= 6.5, off at pH >= 7.0; never with the alkali pump; stops on pH sensor fault.", [("tag", "PH_01"), ("eq", "OP_P13")]),
    "OP_P13": ("07-P-703", "alkali base dosing pump", "On at pH >= 7.5, off at pH <= 7.0; never with the acid pump; stops on pH sensor fault.", [("tag", "PH_01"), ("eq", "OP_P12")]),
    "OP_P8": ("07-P-704", "gravity tank pump wtp", "Runs while 07-LS-702 > LL and the CTP raw water tank < HH.", [("sw", "GT_LL", "gravity tank LL"), ("sw", "CTP_HL", "CTP raw water tank HL")]),
    "OP_M1": ("OP-M1", "hot air blower exhaust degasifier", "Starts / stops with the System Start / Stop push buttons.", []),
    "OP_SV1": ("07-XV-701", "lp steam valve phe", "Opens at 07-TT-701 <= 70 C, closes at >= 90 C; closes on TT fault, air low, E-stop.",
               [("tag", "T_04"), ("sp", "SP_LP_STEAM_OPEN", "open temp"), ("sp", "SP_LP_STEAM_CLOSE", "close temp"), ("sw", "AIR", "instrument air")]),
    "OP_SV2": ("07-XV-702", "outlet process water valve degasifier", "Opens at 07-LS-701 HH, closes at H; closes on air failure / E-stop.",
               [("sw", "DG_HH", "de-gasifier HH"), ("sw", "DG_H", "de-gasifier H"), ("sw", "AIR", "instrument air")]),
}

# tanks: words in a question, level transmitter or switches, and who acts on the level
TANKS = [
    ("Sludge storage tank (01-LT-101)", "sludge storage", ("lt", "LT_01"), "Feed valve 01-MV-101 opens at LL / closes at HH; sludge pumps 01-P-101/102 start at NL, stop at VLL.",
     ["MV_01", "OP_P1A", "OP_P1B", "AGIT"]),
    ("Filtrate tank (01-LT-102)", "filtrate", ("lt", "LT_02"), "Filtrate pumps 01-P-103/104 start at NL, stop at VLL.", ["OP_P5A", "OP_P5B"]),
    ("Raw water storage tank (03-LS-301)", "raw storage", ("sw", ["RAW_HL", "RAW_LL"]), "Borewell pumps start at LL, stop at HL; make-up pumps stop at LL.",
     ["OP_P6A", "OP_P6B", "OP_P14", "OP_P15"]),
    ("Cooling tower-1 basin (06-LS-601)", "cooling 1 ct1 ct-1", ("sw", ["CT1_HL", "CT1_LL"]), "CT-1 pumps stop at LL; fan only with a pump.", ["OP_P7", "OP_P3", "OP_P11", "OP_F1"]),
    ("Cooling tower-2 basin (06-LS-602)", "cooling 2 ct2 ct-2", ("sw", ["CT2_HL", "CT2_LL"]), "06-P-604 stops at LL; fan only with the pump.", ["OP_P10", "OP_F2"]),
    ("Hot water tank (06-LS-603)", "hot water", ("sw", ["HW_HL", "HW_LL"]), "Hot water pump 06-P-605 runs above LL, stops at LL.", ["OP_P2"]),
    ("De-gasifier (07-LS-701)", "degasifier de-gasifier degas", ("sw", ["DG_HH", "DG_H", "DG_L", "DG_LL"]),
     "05-P-501 fills at H, stops at HH; 07-P-701 runs above L, stops at LL; outlet 07-XV-702 opens at HH, closes at H.", ["OP_P4", "OP_P9", "OP_SV2"]),
    ("Gravity PP tank (07-LS-702)", "gravity", ("sw", ["GT_HL", "GT_LL"]), "07-P-704 runs while above LL and the CTP tank is below HH.", ["OP_P8"]),
    ("CTP raw water tank (08-LS-801/802)", "ctp wtp", ("sw", ["CTP_HL", "CTP_LL"]), "07-P-704 stops when this tank is at HH.", ["OP_P8"]),
    ("Pure water tank (08-LS-803/804)", "pure drinking", ("sw", ["PW_HL", "PW_LL"]), "Packaged WTP (no pumps on this panel).", []),
]

TRIP_STEPS = ["Check the MPCB / overload (or VFD fault code) for this motor in the MCC - note why it tripped before resetting.",
              "Look for the cause: jammed or dry-running pump, closed valve, high motor current, loose / burnt cable or terminal.",
              "Lock-out / tag-out before touching the motor or pump.",
              "Reset the MPCB / VFD fault, then restart from the HMI (no auto restart after a trip).",
              "If it trips again, call the electrician / Ankur engineer - do not keep resetting."]
NOTRUN_STEPS = ["The PLC gave the START command but no RUN feedback came back.",
                "Check the MCC selector is in AUTO / REMOTE and the E-stop is released (SYSTEM START active).",
                "Check the MPCB is ON and the contactor actually pulls in.",
                "Check the run-feedback auxiliary contact and its wiring to the PLC input.",
                "For VFD motors: check the drive is ready (no fault, enable present)."]

_HI = {"pump": "पंप", "tank": "टैंक", "trip": "ट्रिप", "level": "लेवल", "alarm": "अलार्म", "empty": "खाली", "full": "भरा",
       "pressure": "प्रेशर", "temperature": "टेम्परेचर", "temp": "तापमान", "set point": "सेट पॉइंट", "ph": "पीएच"}


def _words(q):
    q = q.lower()
    for en, hi in _HI.items():
        q = q.replace(hi, f" {en} ")
    return q


def _pid_hits(q, pid):
    """'01-P-101', 'p-101', 'p101', 'op-p1a' style references."""
    p = pid.lower()
    tail = p.split("-", 1)[-1] if p.count("-") >= 2 else p        # 01-p-101 -> p-101
    return p in q or tail in q or tail.replace("-", "") in q.replace("-", "").replace(" ", "")


def _match_equipment(q):
    hits = []
    for eid, (pid, words, *_r) in EQUIP.items():
        if _pid_hits(q, pid) or eid.lower() in q.replace(" ", "_"):
            hits.append((100, eid))
            continue
        ws = words.split()
        score = sum(1 for w in ws if w in q)
        kind = "valve" if "valve" in ws else "fan" if "fan" in ws else "blower" if "blower" in ws else "mixer" if "mixer" in ws else "pump"
        if score >= 2 and (kind in q or kind == "pump" and "motor" in q):
            hits.append((score, eid))
    if not hits:
        return []
    best = max(s for s, _ in hits)
    return [e for s, e in hits if s == best]


_GENERIC = {"tank", "water", "level", "basin", "tower"}


def _match_tank(q):
    """Tanks named in the question by a distinctive word (sludge, filtrate, raw, cooling 1/2, hot, gravity, ctp, pure...)."""
    scored = []
    for t in TANKS:
        hits = [w for w in t[1].split() if w not in _GENERIC and re.search(rf"(?<![\w-]){re.escape(w)}(?![\w-])", q)]
        if hits:
            scored.append((len(hits), t))
    if not scored:
        return []
    best = max(s for s, _ in scored)
    return [t for s, t in scored if s == best]


def _sw(live, key):
    a = (live.get("aux") or {}).get(SWT.get(key, key))
    return None if not a or a.get("value") is None or a.get("quality") == "NODATA" else _on(a["value"])


def _tag(live, tid):
    return next((t for t in live.get("tags") or [] if t["id"] == tid), None)


def _eq(live, eid):
    return next((e for e in live.get("equipment") or [] if e["id"] == eid), None)


def _sig_txt(live, sig):
    kind = sig[0]
    if kind == "tag":
        t = _tag(live, sig[1])
        return f"{t.get('name')} = **{_fmt(t.get('value'), t.get('decimals', 1))} {t.get('unit') or ''}**" if t else None
    if kind == "sp":
        a = (live.get("aux") or {}).get(sig[1])
        return f"{sig[2]} set point = **{_fmt(a['value'], a.get('decimals', 1))} {a.get('unit') or ''}**" if a and a.get("value") is not None else None
    if kind == "sw":
        v = _sw(live, sig[1])
        return f"{sig[2]} = **{'no data' if v is None else 'ON' if v else 'OFF'}**"
    if kind == "eq":
        e = _eq(live, sig[1])
        return f"{EQUIP.get(sig[1], (e and e.get('tag_no'),))[0]} {e.get('name')} = **{e.get('status')}**" if e else None
    return None


def _equipment_answer(live, eid):
    pid, _w, rule, sigs = EQUIP[eid]
    e = _eq(live, eid)
    if not e:
        return f"**{pid}**: no data on the dashboard."
    st = e.get("status") or "?"
    io = e.get("io") or {}
    mode = "-" if e.get("auto") is None else ("Auto" if e["auto"] else "Manual")
    if e.get("pair") and e.get("standby_selected") is not None:
        mode += ", " + ("standby selected" if e["standby_selected"] else "main selected")
    cmd, run, trip = _on(io.get("cmd")), _on(io.get("run")), _on(io.get("trip"))
    # one-line verdict first, then only what helps
    if st in ("TRIP", "FAULT") or trip:
        why, steps = "**TRIPPED**", TRIP_STEPS[:3]
    elif io and cmd and not run and e.get("type") == "motor":
        why, steps = "**NOT RUN** - start command ON but no run feedback", NOTRUN_STEPS[1:4]
    elif st in ("STOPPED", "CLOSED"):
        steps = []
        if e.get("auto") is False:
            why = f"{st.lower()} - in **Manual** (runs only when started from the panel)"
        elif e.get("pair") and e.get("standby_selected") is not None and (("standby" in (e.get("name") or "").lower()) != bool(e["standby_selected"])):
            why = f"{st.lower()} - **not the selected** pump of its main / standby pair"
        else:
            why = f"{st.lower()} in Auto - held off **by the control rule** below"
    else:
        why, steps = f"**{st.lower()}** normally", []
    out = [f"**{pid}** {e.get('name')}: {why} ({mode})."]
    live_sigs = [s for s in (_sig_txt(live, s) for s in sigs[:3]) if s]
    out.append(f"- Rule: {rule}")
    if live_sigs:
        out.append("- Now: " + " · ".join(live_sigs))
    out += [f"{i}. {s}" for i, s in enumerate(steps, 1)]
    return "\n".join(out)


def _tank_answer(live, t):
    name, _w, src, rule, eids = t
    aux = live.get("aux") or {}
    if src[0] == "lt":
        tg = _tag(live, src[1])
        if tg and isinstance(tg.get("value"), (int, float)):
            lo, hi = tg.get("eng_min") or 0, tg.get("eng_max") or 100
            p = (tg["value"] - lo) / (hi - lo) * 100 if hi != lo else 0
            lvt = _levels_mm(tg, aux)                       # HMI % set points converted to mm for the comparison
            lv = {k: mm for k, (mm, _t) in lvt.items()}
            where = ""
            if lv:
                v = tg["value"]
                where = (" - **above HH**" if v >= lv["HH"] else " - high (H-HH)" if v >= lv["H"] else " - normal" if v > lv["L"]
                         else " - low (LL-L)" if v > lv["LL"] else " - **at / below LL**")
            head = f"**{name}**: {tg['value']:.0f} {tg.get('unit') or ''} ({p:.0f}%){where}."
            sp = ("- Set points: " + " · ".join(f"{k} {txt}" for k, (_mm, txt) in lvt.items())) if lvt else ""
        else:
            head, sp = f"**{name}**: no level value.", ""
    else:
        sw = {k.split("_")[-1]: _sw(live, k) for k in src[1]}
        hi = sw.get("HH") if "HH" in sw else sw.get("HL")
        lo = sw.get("LL")
        state = ("FULL / HIGH" if hi else "LOW / EMPTY" if lo is False else "normal" if lo else "unknown")
        if hi and lo is False:
            state += " (HL ON but LL OFF - check the float switches)"
        head = f"**{name}**: **{state}**."
        sp = "- Switches: " + ", ".join(f"{k} {'-' if v is None else 'ON' if v else 'OFF'}" for k, v in sw.items())
    eqs = ", ".join(f"{EQUIP[e][0]} {(_eq(live, e) or {}).get('status', '-').lower()}" for e in eids if e in EQUIP)
    return "\n".join(x for x in (head, sp, f"- Rule: {rule}", f"- Equipment: {eqs}" if eqs else "") if x)


def _tank_report(live):
    rows = []
    for t in TANKS:
        name, _w, src, *_r = t
        if src[0] == "lt":
            tg = _tag(live, src[1])
            if not tg or not isinstance(tg.get("value"), (int, float)) or tg.get("eng_max") in (None, tg.get("eng_min")):
                continue
            p = (tg["value"] - (tg.get("eng_min") or 0)) / (tg["eng_max"] - (tg.get("eng_min") or 0)) * 100
            state = "EMPTY" if p < 5 else "LOW" if p < 25 else "HIGH" if p > 85 else "normal"
            rows.append((state, f"**{name}**: {tg['value']:.0f} {tg.get('unit') or ''} ({p:.0f}%) - {state}"))
        else:
            sw = {k.split("_")[-1]: _sw(live, k) for k in src[1]}
            if all(v is None for v in sw.values()):
                continue
            hi = sw.get("HH") if "HH" in sw else sw.get("HL")
            lo = sw.get("LL")
            order = [v for v in sw.values() if v is not None]          # top switch first: ON above OFF is impossible
            bad = any(order[i] and not order[j] for i in range(len(order)) for j in range(i + 1, len(order)))
            state = "CHECK" if bad else "HIGH" if hi else "EMPTY" if lo is False else "normal"
            label = {"CHECK": "switches disagree - check the float switches", "HIGH": "FULL / HIGH", "EMPTY": "LOW / EMPTY"}.get(state, "normal")
            rows.append((state, f"**{name}**: " + ", ".join(f"{k} {'ON' if v else 'OFF'}" for k, v in sw.items() if v is not None) + f" - {label}"))
    return rows


PROCESS_GROUPS = {"Temperature": ("temperature", "temp", "garam", "tapman"), "Pressure": ("pressure", "dabav", "dabaav"),
                  "Analysis": ("ph",)}


def _process_groups(q):
    """Which process values a question is about: temperature / pressure / pH, or all of them for
    'process values', 'set point', 'within', 'limit'."""
    want = [g for g, ws in PROCESS_GROUPS.items() if any(re.search(rf"\b{w}s?\b", q) for w in ws)]
    if not want and re.search(r"\b(process values?|set ?points?|within|limits?|readings?)\b", q) and not re.search(r"\b(tank|level)\b", q):
        want = list(PROCESS_GROUPS)
    return want


def _process_answer(live, groups):
    """Each temperature / pressure / pH value against its alarm set point: within, close (>= 90 %), above."""
    aux = live.get("aux") or {}
    rows, above, close, nodata = [], [], [], []
    for t in live.get("tags") or []:
        if t.get("group") not in groups:
            continue
        v, d, u = t.get("value"), t.get("decimals", 1), t.get("unit") or ""
        spa, bit = aux.get(f"{t['id']}_ALM_SP"), aux.get(f"{t['id']}_ALM")
        sp = None if not spa or spa.get("value") is None or spa.get("quality") == "NODATA" else spa["value"]
        alarm_on = bool(bit) and bit.get("value") is not None and _on(bit["value"])
        name = t.get("name") or t["id"]
        if not isinstance(v, (int, float)) or t.get("quality") in ("NODATA", "BAD", "CONFIG_ERROR"):
            nodata.append(name)
            rows.append(f"- {name}: **no data**")
            continue
        if sp is None:
            rows.append(f"- {name}: **{_fmt(v, d)} {u}** (no alarm set point)" + (" - **alarm active**" if alarm_on else ""))
            continue
        if t.get("group") == "Analysis":              # pH: alarm direction not known - show value, set point and alarm bit
            state = "**alarm active**" if alarm_on else "no alarm"
        elif v >= sp:
            state = "**ABOVE set point**"
            above.append(name)
        elif sp > 0 and v >= 0.9 * sp:
            state = f"close to the set point ({v / sp * 100:.0f} %)"
            close.append(name)
        else:
            state = "within"
        if alarm_on and "alarm" not in state:
            state += " - **alarm active**"
        rows.append(f"- {name}: **{_fmt(v, d)} {u}** / set point {_fmt(sp, d)} {u} - {state}")
    what = " and ".join({"Temperature": "temperatures", "Pressure": "pressures", "Analysis": "pH values"}[g] for g in groups)
    if not rows:
        return f"No {what} values on this dashboard."
    head = (f"**{len(above)} above the alarm set point:** {', '.join(above)}." if above else
            f"**All {what} are within their alarm set points.**" if not nodata else
            f"**No {what} above the alarm set point** ({len(nodata)} without data).")
    if close:
        head += f" Close to it: {', '.join(close)}."
    return head + "\n" + "\n".join(rows)


def _pid_of(e):
    return EQUIP.get(e["id"], (e.get("tag_no"),))[0] or e.get("tag_no") or e["id"]


def _run_hours_answer(live):
    eq = sorted(live.get("equipment") or [], key=lambda e: -(e.get("run_hours") or 0))
    if not eq:
        return "No equipment data."
    rows = [f"| {_pid_of(e)} | {e.get('name')} | {_fmt(e.get('run_hours'))} h | {e.get('starts', '-')} | {e.get('status', '-')} |" for e in eq]
    top = eq[0]
    return (f"**Run hours** - highest: **{_pid_of(top)}** {top.get('name')} with **{_fmt(top.get('run_hours'))} h**.\n"
            "| Machine | Name | Run hours | Starts | Now |\n|---|---|---|---|---|\n" + "\n".join(rows))


def _mode_answer(live, want_manual_only):
    eq = [e for e in live.get("equipment") or [] if e.get("auto") is not None]
    man = [e for e in eq if e["auto"] is False]
    out = [f"**{len(man)} of {len(eq)} machines in Manual**" + (":" if man else " - everything is in Auto.")]
    out += [f"- **{_pid_of(e)}** {e.get('name')} - Manual ({(e.get('status') or '-').lower()})" for e in man]
    if not want_manual_only:
        out += [f"- {_pid_of(e)} {e.get('name')} - Auto ({(e.get('status') or '-').lower()})" for e in eq if e["auto"]]
    out.append("_Auto / Manual is switched on the panel._")
    return "\n".join(out)


def _setpoint_list(live):
    aux = live.get("aux") or {}
    out = ["**Set points now:**", "", "**Alarm set points (temperature / pressure / pH):**"]
    for t in live.get("tags") or []:
        a = aux.get(f"{t['id']}_ALM_SP")
        if a and a.get("value") is not None:
            d = (aux.get(f"{t['id']}_ALM_DLY") or {}).get("value")
            out.append(f"- {t.get('name')}: **{_fmt(a['value'], t.get('decimals', 1))} {t.get('unit') or ''}**"
                       + (f", delay {_fmt(d, 0)} s" if d is not None else ""))
    for t in live.get("tags") or []:
        lv = _levels_mm(t, aux)
        if lv:
            out += ["", f"**{t.get('name')} level set points:** " + " · ".join(f"{k} {txt}" for k, (_mm, txt) in lv.items())]
    sv = [a for a in aux.values() if a.get("group") == "Set values" and a.get("value") is not None]
    if sv:
        out += ["", "**Process set values:**"] + [f"- {a.get('name')}: **{_fmt(a['value'], a.get('decimals', 1))} {a.get('unit') or ''}**" for a in sv]
    out.append("_Change them on the **Set points** page (operator / admin)._")
    return "\n".join(out)


def _match_instrument(q):
    """'PT-01', 'pt01', 't-2', 'lt 01', 'ph' -> tag ids (PT_01 ...). PT-01 must not also match T-01."""
    hits = []
    for m in re.finditer(r"(?<![a-z])(pt|lt|ph|t)[\s_-]?0?(\d)(?!\d)", q):
        hits.append(f"{m.group(1).upper()}_0{m.group(2)}")
    if not hits and re.search(r"(?<![a-z])ph(?![a-z])", q):
        hits.append("PH_01")
    return list(dict.fromkeys(hits))


def _instrument_answer(live, tid):
    t = _tag(live, tid)
    if not t:
        return f"**{tid.replace('_', '-')}**: not on this dashboard."
    aux = live.get("aux") or {}
    v, d, u = t.get("value"), t.get("decimals", 1), t.get("unit") or ""
    at = _alarm_txt(t.get("alarm"))
    out = [f"**{t.get('name')}** = **{_fmt(v, d)} {u}**" + (f" - **ALARM {at}**" if at else "") + "."]
    if t.get("eng_min") is not None and t.get("eng_max") is not None:
        out.append(f"- Range {t['eng_min']:g} - {t['eng_max']:g} {u}")
    sp = (aux.get(f"{tid}_ALM_SP") or {}).get("value")
    if sp is not None:
        state = ("**above the alarm set point**" if isinstance(v, (int, float)) and v >= sp and t.get("group") != "Analysis"
                 else "below the alarm set point" if isinstance(v, (int, float)) and t.get("group") != "Analysis" else "")
        out.append(f"- Alarm set point {_fmt(sp, d)} {u}" + (f" - {state}" if state else ""))
    dly = (aux.get(f"{tid}_ALM_DLY") or {}).get("value")
    if dly is not None:
        out.append(f"- Alarm delay {_fmt(dly, 0)} s (running {_fmt((aux.get(f'{tid}_ALM_ACT') or {}).get('value'), 0)} s)")
    lv = _levels_mm(t, aux)
    if lv:
        out.append("- Level set points: " + " · ".join(f"{k} {txt}" for k, (_mm, txt) in lv.items()))
    if t.get("quality") not in ("GOOD", "SIMULATED"):
        out.append(f"- Data quality: **{t.get('quality')}** - check the instrument / cable")
    return "\n".join(out)


HELP = ("I can answer from the live plant data: **alarms** and how to fix them, **tank levels**, any **pump / valve / fan** "
        "(e.g. *why is 01-P-101 stopped?*), any **instrument** (*PT-01*, *T-02*, *pH*), **set points**, **run hours**, "
        "**Auto / Manual**, **alarm history (24 h)** and the **full plant status**.\n"
        "_Basic mode: an admin can add an Anthropic API key in Settings › Plant Assistant to let me answer any question in detail._")


def _history_answer(live):
    ra = live.get("recent_alarms")
    if ra is None:
        return "Alarm history is not available here - see the **Alarms** page."
    if not ra:
        return "**No alarms in the last 24 hours.**"
    out = [f"**{len(ra)} alarm(s) in the last 24 h** (newest first):"]
    out += [f"- {_now_txt(a.get('raised_at'))}: {a.get('message')} - {'cleared' if a.get('cleared_at') else '**still active**'}" for a in ra[:12]]
    if len(ra) > 12:
        out.append(f"- ... and {len(ra) - 12} more (Alarms page)")
    return "\n".join(out)


def offline_answer(question: str, live: dict) -> str:
    q = _words(question)
    demo = (live.get("status") or {}).get("state") == "demo"
    head = "_Demo data._\n" if demo else ""
    al = live.get("alarms") or []
    eq = live.get("equipment") or []
    parts = []

    if re.search(r"\b(help|what can you|kya puch|what to ask)\b", q) or q.strip() in ("hi", "hello", "namaste", "?"):
        return HELP
    if re.search(r"run ?(ning)? ?hours?|ghante|रन आवर|चलने के घंटे", q):
        return head + _run_hours_answer(live)
    if re.search(r"\b(history|today|last 24|yesterday|aaj|kal|happened)\b|आज|हिस्ट्री", q):
        return head + _history_answer(live)
    if re.search(r"\bmanual\b|\bauto\b|selector|मैनुअल|ऑटो", q) and not _match_equipment(q):
        return head + _mode_answer(live, "manual" in q or "मैनुअल" in q)
    if re.search(r"\b(set values?|all set ?points?|set ?points? list|list of set ?points?|show set ?points?)\b", q):
        return head + _setpoint_list(live)
    if re.search(r"\b(full|complete|overall|whole|entire)\b.*\b(status|details?|report|plant)\b|sab ?kuch|poora|पूरा|सारी", q):
        status = offline_answer("plant summary", live)
        proc = _process_answer(live, list(PROCESS_GROUPS))
        return status + "\n\n" + proc + "\n\n" + _mode_answer(live, True)

    inst = [] if _match_equipment(q) else _match_instrument(q)
    if inst and not _match_tank(q):
        return head + "\n\n".join(_instrument_answer(live, t) for t in inst[:3])

    groups = _process_groups(q)                          # temperatures / pressures / pH vs their set points
    if groups and not _match_equipment(q):
        return head + _process_answer(live, groups)

    eqs = _match_equipment(q)
    tanks = [] if eqs else _match_tank(q)
    if eqs:                                              # a specific pump / valve / fan
        parts += [_equipment_answer(live, e) for e in eqs[:2]]
    if tanks:                                            # a specific tank
        parts += [_tank_answer(live, t) for t in tanks[:2]]
    if parts:
        return head + "\n\n".join(parts)

    wants_alarm = any(w in q for w in ("alarm", "trip", "fault", "problem", "issue", "error", "dikkat", "kharab"))
    wants_tank = any(w in q for w in ("tank", "level", "empty", "full", "khali", "bhara"))
    wants_eq = any(w in q for w in ("pump", "motor", "running", "stopped", "fan", "blower", "valve", "chal"))
    summary = not (wants_alarm or wants_tank or wants_eq)
    tripped = [e for e in eq if e.get("status") in ("TRIP", "FAULT")]
    if wants_alarm or summary:
        if al:
            parts.append(f"**{len(al)} active alarm(s):**")
            for a in al[:6]:
                m = (a.get("message") or "").lower()
                hint = ("check MPCB / overload / VFD fault, reset, restart from the panel" if "trip" in m else
                        "start given, no run feedback - check MCC Auto/Remote, contactor, feedback contact" if "not run" in m else
                        "check the instrument / switch")
                prev = next((n.get("note") for n in (a.get("previous_notes") or []) if n.get("note")), "")
                parts.append(f"- **{a.get('message')}** - {hint}" + (f" (last fix: {prev})" if prev else ""))
            if len(al) > 6:
                parts.append(f"- ... and {len(al) - 6} more (Alarms page)")
        else:
            parts.append("**No active alarms.**")
        if tripped and not summary:
            parts += ["", *[_equipment_answer(live, e["id"]) for e in tripped[:2] if e["id"] in EQUIP]]
        elif not tripped and not summary:
            parts.append("**No equipment is tripped.**")
    if wants_tank or summary:
        rep = _tank_report(live)
        low = [r for s, r in rep if s in ("EMPTY", "LOW")]
        high = [r for s, r in rep if s == "HIGH"]
        check = [r for s, r in rep if s == "CHECK"]
        parts.append(f"**Tanks:** {len(low)} low / empty, {len(high)} high, {len(rep) - len(low) - len(high) - len(check)} normal"
                     + (f", {len(check)} switch fault" if check else "") + ".")
        want_low = any(w in q for w in ("empty", "low", "khali"))
        want_high = any(w in q for w in ("full", "high", "bhara", "overflow"))
        show = low if want_low and not want_high else high if want_high and not want_low else low + high
        parts += [f"- {r}" for r in show + check]              # only the ones that need attention
    if wants_eq or summary:
        run = [e for e in eq if e.get("status") in ("RUNNING", "OPEN")]
        parts.append(f"**Equipment:** {len(run)} running / open, {len(tripped)} tripped, {len(eq) - len(run) - len(tripped)} stopped.")
        parts += [f"- **{EQUIP.get(e['id'], (e.get('tag_no'),))[0]}** {e.get('name')}: TRIPPED" for e in tripped]
    return head + "\n".join(parts)


# ---------------------------------------------------------------------------------------------
class Assistant:
    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self._client = None
        self._client_key = None
        self._lock = threading.Lock()
        self._hits = {}

    # -- configuration ----------------------------------------------------------------------
    def _config(self):
        try:
            with open(os.path.join(self.data_dir, "ai_config.json"), encoding="utf-8") as f:
                return json.load(f) or {}
        except (OSError, ValueError):
            return {}

    def knowledge(self) -> str:
        try:
            with open(os.path.join(self.data_dir, "ai_knowledge.md"), encoding="utf-8") as f:
                return f.read()
        except OSError:
            return ""

    def _get_client(self):
        """Anthropic client, or None when the SDK or credentials are missing (then offline answers are used)."""
        cfg = self._config()
        if cfg.get("enabled") is False:
            return None, cfg
        try:
            import anthropic
        except ImportError:
            return None, cfg
        key = (cfg.get("api_key") or "").strip() or os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
        if not key:
            return None, cfg
        with self._lock:
            if self._client is None or self._client_key != key:
                kwargs = {"timeout": 90.0, "max_retries": 2}
                if cfg.get("api_key"):
                    kwargs["api_key"] = cfg["api_key"].strip()
                self._client = anthropic.Anthropic(**kwargs)
                self._client_key = key
        return self._client, cfg

    def status(self):
        client, cfg = self._get_client()
        return {"ai": client is not None, "model": (cfg.get("model") or DEFAULT_MODEL) if client else None}

    # -- admin settings (the key is write-only: never returned to the browser) ----------------
    def admin_settings(self):
        cfg = self._config()
        try:
            import anthropic  # noqa: F401
            sdk = True
        except ImportError:
            sdk = False
        env = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
        return {"enabled": cfg.get("enabled", True) is not False, "model": cfg.get("model") or DEFAULT_MODEL,
                "effort": cfg.get("effort") or "medium", "key_set": bool((cfg.get("api_key") or "").strip()),
                "env_key": env, "sdk": sdk, "models": MODELS, "efforts": EFFORTS,
                "active": self.status()["ai"]}

    def save_admin_settings(self, b: dict):
        cfg = self._config()
        if "enabled" in b:
            cfg["enabled"] = bool(b["enabled"])
        if b.get("model"):
            if b["model"] not in MODELS:
                raise ValueError("Unknown model")
            cfg["model"] = b["model"]
        if b.get("effort"):
            if b["effort"] not in EFFORTS:
                raise ValueError("Unknown effort level")
            cfg["effort"] = b["effort"]
        if b.get("clear_key"):
            cfg["api_key"] = ""
        elif isinstance(b.get("api_key"), str) and b["api_key"].strip():
            key = b["api_key"].strip()
            if len(key) < 20 or len(key) > 400 or any(c.isspace() for c in key):
                raise ValueError("That does not look like an Anthropic API key")
            cfg["api_key"] = key
        path = os.path.join(self.data_dir, "ai_config.json")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
        os.replace(tmp, path)
        with self._lock:
            self._client = None                      # rebuilt with the new key on the next question
        return self.admin_settings()

    def test_connection(self):
        """Checks the key and model access without spending tokens (models.retrieve)."""
        client, cfg = self._get_client()
        if client is None:
            s = self.admin_settings()
            why = ("the assistant is switched off" if not s["enabled"] else "the Anthropic SDK is not installed" if not s["sdk"]
                   else "no API key is saved")
            return {"ok": False, "error": f"Not connected: {why}."}
        import anthropic
        model = cfg.get("model") or DEFAULT_MODEL
        try:
            m = client.models.retrieve(model)
        except anthropic.AuthenticationError:
            return {"ok": False, "error": "The API key is not valid."}
        except anthropic.PermissionDeniedError:
            return {"ok": False, "error": f"The key has no access to {model}."}
        except anthropic.NotFoundError:
            return {"ok": False, "error": f"Model {model} not found for this key."}
        except anthropic.APIConnectionError:
            return {"ok": False, "error": "No internet connection to api.anthropic.com from this PC."}
        except anthropic.APIStatusError as e:
            return {"ok": False, "error": f"AI service error ({e.status_code})."}
        return {"ok": True, "model": getattr(m, "id", model), "name": getattr(m, "display_name", model)}

    def rate_ok(self, session: str) -> bool:
        n, win = RATE_LIMIT
        now = time.time()
        with self._lock:
            hits = [t for t in self._hits.get(session, []) if now - t < win]
            if len(hits) >= n:
                self._hits[session] = hits
                return False
            hits.append(now)
            self._hits[session] = hits
        return True

    # -- answer -------------------------------------------------------------------------------
    @staticmethod
    def clean_history(history):
        out = []
        for m in (history or [])[-MAX_HISTORY:]:
            if not isinstance(m, dict) or m.get("role") not in ("user", "assistant"):
                continue
            text = str(m.get("content") or "")[:4000].strip()
            if text:
                out.append({"role": m["role"], "content": text})
        while out and out[0]["role"] != "user":        # the conversation must start with a user turn
            out.pop(0)
        merged = []                                      # keep roles alternating
        for m in out:
            if merged and merged[-1]["role"] == m["role"]:
                merged[-1]["content"] += "\n\n" + m["content"]
            else:
                merged.append(m)
        if merged and merged[-1]["role"] == "user":     # the new question is appended as the last user turn
            merged.pop()
        return merged

    def ask(self, question: str, history, live: dict) -> dict:
        question = (question or "").strip()[:MAX_QUESTION]
        if not question:
            raise ValueError("Please type a question")
        client, cfg = self._get_client()
        if client is None:
            return {"ok": True, "answer": offline_answer(question, live), "source": "offline"}

        import anthropic
        model = cfg.get("model") or DEFAULT_MODEL
        system = [{"type": "text", "text": SYSTEM_RULES + "\n\n# PLANT KNOWLEDGE\n\n" + self.knowledge(),
                   "cache_control": {"type": "ephemeral"}}]     # stable prefix - cached across questions
        messages = self.clean_history(history) + [
            {"role": "user", "content": f"{snapshot_text(live)}\n\nQUESTION: {question}"}]   # volatile part last
        kw = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"} if model not in NO_FALLBACK else {}
        try:
            resp = client.beta.messages.create(
                model=model, max_tokens=8000, system=system, messages=messages,
                output_config={"effort": cfg.get("effort") or "medium"}, **kw)
        except anthropic.AuthenticationError:
            return {"ok": False, "error": "The AI key is not valid - an admin can check it in Settings › Plant Assistant."}
        except anthropic.PermissionDeniedError:
            return {"ok": False, "error": "The AI key has no permission for this model."}
        except anthropic.RateLimitError:
            return {"ok": False, "error": "The AI service is busy - please ask again in a minute."}
        except anthropic.APIConnectionError:
            return {"ok": True, "answer": "_No internet connection to the AI service._\n\n" + offline_answer(question, live),
                    "source": "offline"}
        except anthropic.APIStatusError as e:
            return {"ok": False, "error": f"AI service error ({e.status_code}) - please try again."}
        if resp.stop_reason == "refusal":
            return {"ok": True, "answer": "Sorry, I can't help with that question. Please ask about the plant.", "source": "ai"}
        text = "\n".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip()
        if resp.stop_reason == "max_tokens":
            text += "\n\n_(answer cut short - ask a narrower question for the rest)_"
        return {"ok": True, "answer": text or "No answer.", "source": "ai", "model": getattr(resp, "model", model)}
