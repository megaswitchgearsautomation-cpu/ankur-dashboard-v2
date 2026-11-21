"""Client data reports: process values over a time frame, as JSON preview, Excel (.xlsx) or PDF.

Standard library only - the .xlsx (Office Open XML) and the PDF are written directly.
Times are the server's local time.  Simulated (demo) data is always labelled.
"""
from __future__ import annotations

import csv
import io
import math
import re
import time
import zipfile
from datetime import datetime, timedelta, timezone
from xml.sax.saxutils import escape as xml_escape

INTERVALS = {60: "1 minute", 300: "5 minutes", 900: "15 minutes", 1800: "30 minutes", 3600: "1 hour",
             21600: "6 hours", 86400: "1 day"}
MAX_ROWS = 5000
MAX_DAYS = 31
PROCESS_GROUPS = ("Level", "Temperature", "Pressure", "Analysis")


class ReportError(ValueError):
    pass


IST = timezone(timedelta(hours=5, minutes=30))     # plant time zone (Asia/Kolkata, no daylight saving)
CALCULATED_KINDS = ("hi", "hihi", "lo", "lolo", "comm_loss")


def alarm_source(a):
    """'dashboard' = calculated by this dashboard (analog limits, communication loss);
    'plc' = a digital signal from the PLC / field (trip inputs, PLC alarm bits, safety inputs)."""
    return "dashboard" if a.get("kind") in CALCULATED_KINDS or a.get("tag") == "_COMM" else "plc"
COVERAGE_SLOT_S = 60


def period_window(kind, date_str, shift_name, shifts):
    """(label, t_from, t_to) in epoch seconds. Daily = 00:00-24:00 IST; a shift runs from its start to the next
    shift's start (the last one ends at the first one's start next day)."""
    try:
        day = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=IST)
    except (TypeError, ValueError):
        raise ReportError("Date must be YYYY-MM-DD")
    if kind == "daily":
        return f"Daily report {day:%d-%m-%Y}", day.timestamp(), (day + timedelta(days=1)).timestamp()
    if kind == "weekly":                                   # Monday to Sunday of the week that contains the date
        mon = day - timedelta(days=day.weekday())
        sun = mon + timedelta(days=6)
        return f"Weekly report {mon:%d-%m-%Y} to {sun:%d-%m-%Y}", mon.timestamp(), (mon + timedelta(days=7)).timestamp()
    if kind == "monthly":
        first = day.replace(day=1)
        nxt = first.replace(year=first.year + (first.month == 12), month=first.month % 12 + 1)
        return f"Monthly report {first:%B %Y}", first.timestamp(), nxt.timestamp()
    if kind != "shift":
        raise ReportError("Report kind must be daily, shift, weekly or monthly")
    order = sorted(shifts, key=lambda s: s["start"])
    idx = next((i for i, s in enumerate(order) if s["name"] == shift_name), None)
    if idx is None:
        raise ReportError(f"Unknown shift '{shift_name}'")
    hh, mm = map(int, order[idx]["start"].split(":"))
    start = day + timedelta(hours=hh, minutes=mm)
    nh, nm = map(int, order[(idx + 1) % len(order)]["start"].split(":"))
    end = day + timedelta(hours=nh, minutes=nm)
    if end <= start:
        end += timedelta(days=1)
    return f"Shift {shift_name} report {day:%d-%m-%Y} ({order[idx]['start']}-{order[(idx + 1) % len(order)]['start']})", \
        start.timestamp(), end.timestamp()


def no_hmi_plc(s):
    """Client wording: 'T-01 ...: PLC alarm' -> 'T-01 ...: alarm' (the dashboard does not name the PLC / HMI)."""
    if not isinstance(s, str):
        return s
    s = s.replace(" - PLC alarm", " - alarm").replace(": PLC alarm", ": alarm").replace("PLC communication", "Plant communication")
    return re.sub(r"\s*\b(PLC|HMI)\b\s*", " ", s).strip()


# log sheet step per report kind: hourly for a day / shift, 6-hourly for a week, daily for a month
LOG_STEP = {"daily": 3600, "shift": 3600, "weekly": 21600, "monthly": 86400}
SYSTEM_EQUIPMENT = "OP_M1"        # hot air blower: runs from System Start to System Stop -> "system run hours"
# v3: performance ceiling for one report window (the real limit is also the history kept: retention_days + 1)
PERIOD_MAX_DAYS = 62
RANGE_KINDS = ("daily", "weekly", "monthly", "custom")


def _day(s, what):
    try:
        return datetime.strptime(str(s or ""), "%Y-%m-%d").replace(tzinfo=IST)
    except ValueError:
        raise ReportError(f"{what} must be a date (YYYY-MM-DD)")


def ist_day_start(ts):
    d = datetime.fromtimestamp(ts, IST)
    return d.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()


def range_window(kind, from_str, to_str):
    """v3 Reports: start date .. end date (IST days, end date inclusive) -> (title, t_from, t_to).
    kind (daily / weekly / monthly / custom) only names the report; the window is always the two dates."""
    if kind not in RANGE_KINDS:
        raise ReportError("Report type must be daily, weekly, monthly or custom")
    d0, d1 = _day(from_str, "Start date"), _day(to_str, "End date")
    if d1 < d0:
        raise ReportError("The end date must be on or after the start date")
    days = (d1 - d0).days + 1
    if days == 1:
        title = f"Daily report {d0:%d-%m-%Y}"
    elif kind == "weekly":
        title = f"Weekly report {d0:%d-%m-%Y} to {d1:%d-%m-%Y}"
    elif kind == "monthly" and (d0.year, d0.month) == (d1.year, d1.month):
        title = f"Monthly report {d0:%B %Y}"
    else:
        title = f"Report {d0:%d-%m-%Y} to {d1:%d-%m-%Y}"
    return title, d0.timestamp(), (d1 + timedelta(days=1)).timestamp()


def span_step(span_s):
    """Log sheet step for a window: hourly up to 2 days, 6-hourly up to 14 days, daily beyond."""
    return 3600 if span_s <= 2 * 86400 + 60 else 21600 if span_s <= 14 * 86400 + 60 else 86400


def max_window_days(retention_days=None):
    if retention_days is None:
        return PERIOD_MAX_DAYS
    return max(1, min(PERIOD_MAX_DAYS, int(retention_days) + 1))


def limit_to_history(t0, t1, history_start=None, retention_days=None, now=None):
    """Clamp / refuse a report window against the history actually kept.
    history_start = oldest usable time (max(now - retention, oldest stored sample)).  A window that ends before it is
    refused; one that starts before it begins on that day (00:00 IST) with a note.  Returns (t0, note)."""
    now = time.time() if now is None else now
    if t1 <= t0:
        raise ReportError("The end must be after the start")
    if t0 >= now:
        raise ReportError("That period has not started yet")
    note = None
    keep = f" (history is kept for {int(retention_days)} days)" if retention_days else ""
    if history_start is not None:
        first_day = ist_day_start(history_start)
        if t1 <= history_start:
            raise ReportError(f"No history is stored for this period. The oldest available date is "
                              f"{_ist(history_start, '%d-%m-%Y')}{keep}.")
        if t0 < first_day:
            t0 = first_day
            note = f"History is available from {_ist(history_start, '%d-%m-%Y %H:%M')} IST{keep}: earlier days are not in this report."
    md = max_window_days(retention_days)
    if t1 - t0 > md * 86400 + 60:
        raise ReportError(f"The longest report period is {md} days{keep}. Choose a shorter range.")
    return t0, note


def period_report(store, historian, kind, date_str, shift_name=None, live_values=None, window=None,
                  history_start=None, retention_days=None):
    """Daily / shift / weekly / monthly report from the stored history only:
    - summary KPIs (system run hours, machine run hours, alarms, trips, data coverage)
    - per process value: min / max / average, % of range for levels, current alarm set point and the minutes the
      value was at / above it, data coverage, and a small trend (log-sheet averages)
    - a log sheet (hourly / 6-hourly / daily averages)
    - equipment run hours, starts, trips and utilisation
    - alarm summary (most frequent) and the full alarm log.
    live_values: {tag_id: current value} - used only for the current alarm set points.
    No production / consumption KPIs: there is no source data or definition for them.
    v3: window=(title, t_from, t_to) from range_window() replaces kind/date; history_start / retention_days limit the
    window to the history actually kept (see limit_to_history)."""
    if window:
        title, t0, t1 = window
    else:
        title, t0, t1 = period_window(kind, date_str, shift_name, store.settings.get("shifts") or [])
    now = time.time()
    requested_from = t0
    t0, history_note = limit_to_history(t0, t1, history_start, retention_days, now)
    t_end = min(t1, now)
    elapsed = max(1.0, t_end - t0)
    slots = int(math.ceil(elapsed / COVERAGE_SLOT_S))
    live_values = live_values or {}
    step = max(LOG_STEP.get(kind, 0), span_step(t1 - t0))
    n_steps = int(math.ceil((t1 - t0) / step))
    tags = reportable_tags(store)
    buckets = historian.period_buckets([t["id"] for t in tags], t0, t_end, step)

    values = []
    for t in tags:
        s = historian.period_stats(t["id"], t0, t_end, COVERAGE_SLOT_S)
        d = int(t.get("decimals", 1))
        lo, hi = t.get("eng_min"), t.get("eng_max")
        sp = live_values.get(f"{t['id']}_ALM_SP")
        sp = sp if isinstance(sp, (int, float)) and not isinstance(sp, bool) and math.isfinite(sp) else None
        above = None
        if sp is not None and t.get("group") in ("Temperature", "Pressure") and s["avg"] is not None:
            above = historian.minutes_at_or_above(t["id"], t0, t_end, sp)
        pct = None
        if t.get("group") == "Level" and lo is not None and hi not in (None, lo) and s["avg"] is not None:
            pct = {k: round((s[k] - lo) / (hi - lo) * 100, 1) for k in ("min", "max", "avg")}
        b = buckets.get(t["id"], {})
        values.append({"id": t["id"], "name": t["name"], "group": t.get("group", ""), "unit": t.get("unit", ""),
                       "decimals": d, "min": s["min"], "max": s["max"], "avg": s["avg"], "pct": pct,
                       "eng_min": lo, "eng_max": hi, "set_point": sp, "minutes_above_sp": above,
                       "coverage_pct": round(100 * s["slots_with_data"] / slots, 1) if slots else 0,
                       "log": [None if i not in b else round(b[i][0], d + 1) for i in range(n_steps)]})

    alarms = historian.alarm_rows("raised_at >= ? AND raised_at < ?", (t0, t1), 2000)
    tagmap = store.tag_map()
    equipment, sys_hours = [], None
    for e in store.equipment:
        if e.get("show_on_dashboard") is False or e.get("type", "motor") != "motor" or not e.get("run_tag"):
            continue
        sec = historian.on_seconds(e["run_tag"], t0, t_end)
        trips = sum(1 for a in alarms if e.get("trip_tag") and a["tag"] == e["trip_tag"])
        equipment.append({"id": e["id"], "tag_no": e.get("tag_no", ""), "name": e["name"], "area": e.get("area", ""),
                          "kw": e.get("kw"), "run_hours": round(sec / 3600, 2), "starts": historian.rising_edges(e["run_tag"], t0, t_end),
                          "trips": trips, "utilisation_pct": round(100 * sec / elapsed, 1)})
        if e["id"] == SYSTEM_EQUIPMENT:
            sys_hours = round(sec / 3600, 2)

    al = [{"raised_at": a["raised_at"], "cleared_at": a.get("cleared_at"), "acked_at": a.get("acked_at"),
           "acked_by": a.get("acked_by"), "priority": a["priority"], "source": alarm_source(a), "kind": a.get("kind"),
           "message": "Data connection to plant lost" if a["tag"] == "_COMM" else no_hmi_plc(a["message"]),
           "tag_name": no_hmi_plc(tagmap.get(a["tag"], {}).get("name", "Data connection" if a["tag"] == "_COMM" else a["tag"])),
           "duration_min": round(((a.get("cleared_at") or t_end) - a["raised_at"]) / 60, 1),
           "simulated": bool(a.get("simulated"))} for a in alarms]
    top = {}
    for a in al:
        g = top.setdefault(a["message"], {"message": a["message"], "priority": a["priority"], "count": 0, "minutes": 0.0, "last": 0})
        g["count"] += 1
        g["minutes"] += max(0.0, a["duration_min"])
        g["last"] = max(g["last"], a["raised_at"])
        if a["priority"] == "red":
            g["priority"] = "red"
    top_alarms = sorted(top.values(), key=lambda g: (-g["count"], -g["minutes"]))[:10]
    for g in top_alarms:
        g["minutes"] = round(g["minutes"], 1)

    covs = [v["coverage_pct"] for v in values]
    summary = {
        "system_run_hours": sys_hours,
        "machine_run_hours": round(sum(e["run_hours"] for e in equipment), 2),
        "machines_run": sum(1 for e in equipment if e["run_hours"] > 0), "machines_total": len(equipment),
        "starts": sum(e["starts"] for e in equipment), "trips": sum(e["trips"] for e in equipment),
        "alarms": len(al), "critical": sum(a["priority"] == "red" for a in al),
        "still_active": sum(1 for a in al if not a.get("cleared_at")),
        "values_above_sp": sum(1 for v in values if v["minutes_above_sp"]),
        "data_coverage_pct": round(sum(covs) / len(covs), 1) if covs else 0,
        "period_hours": round(elapsed / 3600, 2),
    }
    site = store.settings.get("site") or {}
    return {"title": title, "kind": kind, "from": t0, "to": t1, "complete": t1 <= now, "generated": now,
            "timezone": "Asia/Kolkata", "simulated": store.settings["source"]["mode"] == "simulation",
            "site": {"name": site.get("name", ""), "panel": site.get("panel", "")},
            "summary": summary, "values": values, "equipment": equipment, "alarms": al, "top_alarms": top_alarms,
            "log_step_s": step, "log_times": [t0 + i * step for i in range(n_steps)],
            "alarm_counts": {"total": len(al), "plc": sum(a["source"] == "plc" for a in al),
                             "dashboard": sum(a["source"] == "dashboard" for a in al),
                             "red": sum(a["priority"] == "red" for a in al)},
            "shifts": store.settings.get("shifts") or [],
            "requested_from": requested_from, "history_note": history_note,
            "history_from": history_start, "max_days": max_window_days(retention_days)}


def _ist(ts, fmt="%d-%m-%Y %H:%M"):
    return datetime.fromtimestamp(ts, IST).strftime(fmt)


def period_xlsx(rep) -> bytes:
    """Excel workbook of a period report: Summary, Process values, Log sheet, Equipment, Alarms."""
    s = rep["summary"]
    head = [[(f"{rep['title']} - {rep['site']['name']}", S_TITLE)],
            [("Period (IST)", S_LABEL), (f"{_ist(rep['from'])} to {_ist(rep['to'])}" + ("" if rep["complete"] else " (still running)"), S_TEXT)],
            [("Generated (IST)", S_LABEL), (_ist(rep["generated"], "%d-%m-%Y %H:%M:%S"), S_TEXT)]]
    if rep.get("history_note"):
        head.append([("Note", S_LABEL), (rep["history_note"], S_TEXT)])
    if rep["simulated"]:
        head.append([("DEMO DATA - simulated values, not measured plant data.", S_WARN)])
    kpi = head + [[], [("Item", S_HEAD), ("Value", S_HEAD)]] + [[(k, S_TEXT), (v, S_NUM if isinstance(v, (int, float)) else S_TEXT)] for k, v in (
        ("System run hours (hot air blower)", s["system_run_hours"] if s["system_run_hours"] is not None else "-"),
        ("Total machine run hours", s["machine_run_hours"]), ("Machines that ran", f"{s['machines_run']} of {s['machines_total']}"),
        ("Machine starts", s["starts"]), ("Trips", s["trips"]), ("Alarms", s["alarms"]), ("Critical alarms", s["critical"]),
        ("Alarms still active", s["still_active"]), ("Values that reached their alarm set point", s["values_above_sp"]),
        ("Average data coverage %", s["data_coverage_pct"]))]
    pv = head + [[], [(h, S_HEAD) for h in ("Group", "Value", "Unit", "Min", "Max", "Average", "Alarm set point (now)",
                                             "Minutes at / above set point", "Data coverage %")]]
    for v in rep["values"]:
        pv.append([(v["group"], S_TEXT), (v["name"], S_TEXT), (v["unit"], S_TEXT), (v["min"], S_NUM), (v["max"], S_NUM),
                   (None if v["avg"] is None else round(v["avg"], v["decimals"] + 1), S_NUM), (v["set_point"], S_NUM),
                   (v["minutes_above_sp"], S_NUM), (v["coverage_pct"], S_NUM)])
    fmt = "%d-%m-%Y" if rep["log_step_s"] >= 86400 else "%d-%m %H:%M"
    lg = head + [[], [("Time (IST)", S_HEAD)] + [(f"{v['name']} ({v['unit']})" if v["unit"] else v["name"], S_HEAD) for v in rep["values"]]]
    for i, ts in enumerate(rep["log_times"]):
        lg.append([(_ist(ts, fmt), S_TEXT)] + [(v["log"][i], S_NUM) for v in rep["values"]])
    eq = head + [[], [(h, S_HEAD) for h in ("Tag", "Equipment", "Area", "kW", "Run hours", "Starts", "Trips", "Utilisation %")]]
    for e in rep["equipment"]:
        eq.append([(e["tag_no"], S_TEXT), (e["name"], S_TEXT), (e["area"], S_TEXT), (e["kw"], S_NUM), (e["run_hours"], S_NUM),
                   (e["starts"], S_NUM), (e["trips"], S_NUM), (e["utilisation_pct"], S_NUM)])
    alm = head + [[], [(h, S_HEAD) for h in ("Raised (IST)", "Severity", "Source", "Device", "Alarm", "Duration (min)",
                                             "Acknowledged by", "Cleared (IST)")]]
    for a in rep["alarms"]:
        alm.append([(_ist(a["raised_at"], "%d-%m-%Y %H:%M:%S"), S_TEXT), ("Critical" if a["priority"] == "red" else "Warning", S_TEXT),
                    ("Dashboard" if a["source"] == "dashboard" else "Plant", S_TEXT), (a["tag_name"], S_TEXT), (a["message"], S_TEXT),
                    (a["duration_min"], S_NUM), (a.get("acked_by") or "", S_TEXT),
                    (_ist(a["cleared_at"], "%d-%m-%Y %H:%M:%S") if a.get("cleared_at") else "ACTIVE", S_TEXT)])
    return _xlsx_pack([("Summary", _sheet(kpi, [42, 22])),
                       ("Process values", _sheet(pv, [13, 46, 8, 11, 11, 11, 14, 14, 12], freeze_row=len(head) + 2)),
                       ("Log sheet", _sheet(lg, [16] + [14] * len(rep["values"]), freeze_row=len(head) + 2)),
                       ("Equipment", _sheet(eq, [12, 46, 20, 7, 11, 9, 8, 13], freeze_row=len(head) + 2)),
                       ("Alarms", _sheet(alm, [19, 10, 11, 34, 50, 13, 16, 19], freeze_row=len(head) + 2))],
                      rep["title"])


def period_filename(rep, ext):
    return re.sub(r"[^\w-]+", "_", f"{rep['title']}").strip("_") + f".{ext}"


def _csv_bytes(rows) -> bytes:
    """UTF-8 with BOM (Excel opens it with the right characters), CRLF line ends."""
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    for r in rows:
        w.writerow(["" if c is None else c for c in r])
    return ("﻿" + buf.getvalue()).encode("utf-8")


def _csv_head(rep, period_text):
    head = [[rep["title"]], ["Site", rep["site"]["name"] if isinstance(rep["site"], dict) else rep["site"]],
            ["Period (IST)", period_text], ["Generated (IST)", _ist(rep["generated"], "%d-%m-%Y %H:%M:%S")]]
    if rep.get("history_note"):
        head.append(["Note", rep["history_note"]])
    if rep.get("simulated"):
        head.append(["DEMO DATA - simulated values, not measured plant data"])
    return head


def period_csv(rep) -> bytes:
    """One CSV with the whole period report: summary, process values, log sheet, equipment, alarms (times in IST)."""
    s = rep["summary"]
    rows = _csv_head(rep, f"{_ist(rep['from'])} to {_ist(rep['to'])}" + ("" if rep["complete"] else " (still running)"))
    rows += [[], ["SUMMARY"], ["Item", "Value"],
             ["System run hours (hot air blower)", s["system_run_hours"]], ["Total machine run hours", s["machine_run_hours"]],
             ["Machines that ran", f"{s['machines_run']} of {s['machines_total']}"], ["Machine starts", s["starts"]],
             ["Trips", s["trips"]], ["Alarms", s["alarms"]], ["Critical alarms", s["critical"]],
             ["Alarms still active", s["still_active"]], ["Values that reached their alarm set point", s["values_above_sp"]],
             ["Average data coverage %", s["data_coverage_pct"]], ["Period hours", s["period_hours"]]]
    rows += [[], ["PROCESS VALUES"], ["Group", "Value", "Unit", "Min", "Max", "Average", "Alarm set point (now)",
                                       "Minutes at / above set point", "Data coverage %"]]
    for v in rep["values"]:
        rows.append([v["group"], v["name"], v["unit"], v["min"], v["max"],
                     None if v["avg"] is None else round(v["avg"], v["decimals"] + 1), v["set_point"],
                     v["minutes_above_sp"], v["coverage_pct"]])
    fmt = "%d-%m-%Y" if rep["log_step_s"] >= 86400 else "%d-%m-%Y %H:%M"
    rows += [[], [f"LOG SHEET (average per {INTERVALS.get(rep['log_step_s'], str(rep['log_step_s']) + ' s')})"],
             ["Time (IST)"] + [f"{v['name']} ({v['unit']})" if v["unit"] else v["name"] for v in rep["values"]]]
    for i, ts in enumerate(rep["log_times"]):
        if ts < rep["generated"]:
            rows.append([_ist(ts, fmt)] + [v["log"][i] for v in rep["values"]])
    rows += [[], ["EQUIPMENT"], ["Tag", "Equipment", "Area", "kW", "Run hours", "Starts", "Trips", "Utilisation %"]]
    for e in rep["equipment"]:
        rows.append([e["tag_no"], e["name"], e["area"], e["kw"], e["run_hours"], e["starts"], e["trips"], e["utilisation_pct"]])
    rows += [[], ["ALARMS"], ["Raised (IST)", "Severity", "Source", "Device", "Alarm", "Duration (min)", "Acknowledged by", "Cleared (IST)"]]
    for a in rep["alarms"]:
        rows.append([_ist(a["raised_at"], "%d-%m-%Y %H:%M:%S"), "Critical" if a["priority"] == "red" else "Warning",
                     "Dashboard" if a["source"] == "dashboard" else "Plant", a["tag_name"], a["message"], a["duration_min"],
                     a.get("acked_by") or "", _ist(a["cleared_at"], "%d-%m-%Y %H:%M:%S") if a.get("cleared_at") else "ACTIVE"])
    return _csv_bytes(rows)


def to_csv(rep) -> bytes:
    """Data log CSV: one row per interval, date and time (IST) in separate columns."""
    cols = rep["columns"]
    rows = _csv_head(rep, f"{fmt_ts(rep['from'])} to {fmt_ts(rep['to'])}")
    rows += [["Interval", f"{rep['interval']} (average per interval)"], [],
             ["Date (IST)", "Time (IST)"] + [f"{c['name']} ({c['unit']})" if c["unit"] else c["name"] for c in cols]]
    for r in rep["rows"]:
        rows.append([_ist(r["t"], "%d-%m-%Y"), _ist(r["t"], "%H:%M")] + list(r["values"]))
    return _csv_bytes(rows)


def reportable_tags(store):
    """Tags a client may report on: dashboard-visible analog process values."""
    out = [t for t in store.tags if t.get("show_on_dashboard", True) and t.get("data_type") != "BOOL"
           and t.get("group") in PROCESS_GROUPS]
    order = {g: i for i, g in enumerate(PROCESS_GROUPS)}
    return sorted(out, key=lambda t: (order.get(t.get("group"), 9), t.get("name", "")))


IST_OFFSET_S = 19800              # +05:30


def build(store, historian, tag_ids, t_from, t_to, interval_s, title=None, history_note=None):
    allowed = {t["id"]: t for t in reportable_tags(store)}
    tags = [allowed[i] for i in tag_ids if i in allowed] or list(allowed.values())
    if interval_s not in INTERVALS:
        raise ReportError("Invalid interval")
    if t_to <= t_from:
        raise ReportError("'To' must be after 'From'")
    if t_to - t_from > MAX_DAYS * 86400 + 60:
        raise ReportError(f"Maximum report period is {MAX_DAYS} days")
    # buckets start on IST clock times (1 h -> 10:00, 11:00 IST, not 10:30)
    first = math.floor((t_from + IST_OFFSET_S) / interval_s) * interval_s - IST_OFFSET_S
    n_rows = int(math.ceil((t_to - first) / interval_s))
    if n_rows > MAX_ROWS:
        need = next((s for s in sorted(INTERVALS) if math.ceil((t_to - t_from) / s) <= MAX_ROWS), 86400)
        raise ReportError(f"Too many rows ({n_rows}). Choose an interval of {INTERVALS[need]} or longer.")
    ids = [t["id"] for t in tags]
    if IST_OFFSET_S % interval_s == 0:            # UTC-aligned buckets are IST-aligned too (1, 5, 15, 30 min)
        data = historian.report_buckets(ids, t_from, t_to, interval_s)
    else:                                         # 1 h / 6 h / 1 day: buckets counted from the IST-aligned start
        sim = store.settings["source"]["mode"] == "simulation"
        raw = historian.period_buckets(ids, first, t_to, interval_s)
        data = {tid: {float(first + k * interval_s): (c[0], c[1], c[2], c[3], sim) for k, c in b.items()}
                for tid, b in raw.items()}

    rows, any_sim = [], False
    for k in range(n_rows):
        b = first + k * interval_s
        vals = []
        for t in tags:
            cell = data[t["id"]].get(float(b))
            if cell:
                any_sim = any_sim or cell[4]
                vals.append(round(cell[0], int(t.get("decimals", 1)) + 1))
            else:
                vals.append(None)
        if any(v is not None for v in vals):
            rows.append({"t": b, "values": vals})

    summary = []
    for t in tags:
        cells = list(data[t["id"]].values())
        n = sum(c[3] for c in cells)
        summary.append({
            "id": t["id"], "name": t["name"], "unit": t.get("unit", ""), "group": t.get("group", ""),
            "decimals": int(t.get("decimals", 1)),
            "min": min((c[1] for c in cells), default=None), "max": max((c[2] for c in cells), default=None),
            "avg": (sum(c[0] * c[3] for c in cells) / n) if n else None, "samples": n,
        })
    site = store.settings["site"]
    return {
        "title": title or "Process Data Report", "history_note": history_note,
        "site": f"{site.get('name', '')} · {site.get('panel', '')}",
        "client": "Ankur Scientific", "provider": "Medge Controls",
        "from": t_from, "to": t_to, "interval_s": interval_s, "interval": INTERVALS[interval_s],
        "generated": time.time(), "simulated": any_sim,
        "columns": [{"id": t["id"], "name": t["name"], "unit": t.get("unit", ""), "decimals": int(t.get("decimals", 1))} for t in tags],
        "rows": rows, "summary": summary,
    }


def fmt_ts(ts, seconds=False):                     # plant time (IST), whatever the server's time zone
    return _ist(ts, "%d-%m-%Y %H:%M:%S" if seconds else "%d-%m-%Y %H:%M")


def fmt_num(v, d):
    return "-" if v is None else f"{v:.{d}f}"


def filename(rep, ext):
    base = "Process_Report" if rep.get("title", "Process Data Report") == "Process Data Report" \
        else re.sub(r"[^\w-]+", "_", rep["title"]).strip("_")
    return f"{base}_{_ist(rep['from'], '%Y%m%d_%H%M')}_to_{_ist(rep['to'], '%Y%m%d_%H%M')}.{ext}"


# =====================================================================================
# Excel (.xlsx) - minimal SpreadsheetML writer
# =====================================================================================
def _col(n):
    s = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def _xl_date(ts):                                  # Excel serial date in IST
    dt = datetime.fromtimestamp(ts, IST).replace(tzinfo=None)
    return (dt - datetime(1899, 12, 30)).total_seconds() / 86400.0


def _cell(ref, value, style=0):
    if value is None or value == "":
        return f'<c r="{ref}" s="{style}"/>'
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f'<c r="{ref}" s="{style}"><v>{value!r}</v></c>'
    return f'<c r="{ref}" s="{style}" t="inlineStr"><is><t xml:space="preserve">{xml_escape(str(value))}</t></is></c>'


def _sheet(rows, widths, freeze_row=None, merges=()):
    out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
           '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
           'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">']
    if freeze_row:
        out.append(f'<sheetViews><sheetView workbookViewId="0"><pane ySplit="{freeze_row}" topLeftCell="A{freeze_row + 1}" '
                   'activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>')
    out.append("<cols>" + "".join(f'<col min="{i + 1}" max="{i + 1}" width="{w}" customWidth="1"/>' for i, w in enumerate(widths)) + "</cols>")
    out.append("<sheetData>")
    for r, row in enumerate(rows):
        cells = "".join(_cell(f"{_col(c)}{r + 1}", v, s) for c, (v, s) in enumerate(row))
        out.append(f'<row r="{r + 1}">{cells}</row>')
    out.append("</sheetData>")
    if merges:
        out.append(f'<mergeCells count="{len(merges)}">' + "".join(f'<mergeCell ref="{m}"/>' for m in merges) + "</mergeCells>")
    out.append('<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>')
    return "".join(out)


STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="dd-mm-yyyy hh:mm"/></numFmts>
<fonts count="4">
 <font><sz val="10"/><name val="Calibri"/></font>
 <font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
 <font><b/><sz val="15"/><color rgb="FF34178F"/><name val="Calibri"/></font>
 <font><b/><sz val="10"/><color rgb="FFB52A2A"/><name val="Calibri"/></font>
</fonts>
<fills count="4">
 <fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
 <fill><patternFill patternType="solid"><fgColor rgb="FF5B2FD0"/></patternFill></fill>
 <fill><patternFill patternType="solid"><fgColor rgb="FFF3F1FA"/></patternFill></fill>
</fills>
<borders count="2"><border/><border><left style="thin"><color rgb="FFE0DDEB"/></left><right style="thin"><color rgb="FFE0DDEB"/></right>
 <top style="thin"><color rgb="FFE0DDEB"/></top><bottom style="thin"><color rgb="FFE0DDEB"/></bottom></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
 <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
 <xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="center" horizontal="center"/></xf>
 <xf numFmtId="164" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/>
 <xf numFmtId="0" fontId="2" fillId="0" borderId="0" applyFont="1"/>
 <xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1"/>
 <xf numFmtId="4" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/>
 <xf numFmtId="0" fontId="3" fillId="0" borderId="0" applyFont="1"/>
 <xf numFmtId="0" fontId="0" fillId="3" borderId="1" applyFill="1" applyBorder="1"/>
</cellXfs>
</styleSheet>"""
S_HEAD, S_DATE, S_TITLE, S_TEXT, S_NUM, S_WARN, S_LABEL = 1, 2, 3, 4, 5, 6, 7


def to_xlsx(rep) -> bytes:
    cols = rep["columns"]
    meta = [
        [(rep["title"], S_TITLE)],
        [("Site", S_LABEL), (rep["site"], S_TEXT)],
        [("Client", S_LABEL), (rep["client"], S_TEXT)],
        [("Period (IST)", S_LABEL), (f"{fmt_ts(rep['from'])}  to  {fmt_ts(rep['to'])}", S_TEXT)],
        [("Interval", S_LABEL), (f"{rep['interval']} (average per interval)", S_TEXT)],
        [("Generated (IST)", S_LABEL), (fmt_ts(rep["generated"], True), S_TEXT)],
        [("Powered by", S_LABEL), (rep["provider"], S_TEXT)],
    ]
    if rep["simulated"]:
        meta.append([("DEMO DATA - these values are simulated, not measured plant data.", S_WARN)])
    # one sheet: report details on top, then the data log (header row frozen)
    if rep.get("history_note"):
        meta.append([("Note", S_LABEL), (rep["history_note"], S_TEXT)])
    log = meta + [[]] + [[("Date / time", S_HEAD)] + [(f"{c['name']} ({c['unit']})" if c["unit"] else c["name"], S_HEAD) for c in cols]]
    head_row = len(log)
    for r in rep["rows"]:
        log.append([(_xl_date(r["t"]), S_DATE)] + [(v, S_NUM) for v in r["values"]])
    sheet1 = _sheet(log, [18] + [16] * len(cols), freeze_row=head_row)
    return _xlsx_pack([("Data log", sheet1)], rep["title"])


def _xlsx_pack(sheets, title) -> bytes:
    """sheets: [(name, sheet_xml), ...] -> .xlsx bytes."""
    n = len(sheets)
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + "".join(f'<Override PartName="/xl/worksheets/sheet{i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
                  for i in range(n)) +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
        "docProps/core.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        f'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>{xml_escape(title)}</dc:title><dc:creator>Medge Controls</dc:creator></cp:coreProperties>',
        "xl/workbook.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
        + "".join(f'<sheet name="{xml_escape(name[:31])}" sheetId="{i + 1}" r:id="rId{i + 1}"/>' for i, (name, _x) in enumerate(sheets)) +
        '</sheets></workbook>',
        "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + "".join(f'<Relationship Id="rId{i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i + 1}.xml"/>'
                  for i in range(n)) +
        f'<Relationship Id="rId{n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
        "xl/styles.xml": STYLES,
    }
    for i, (_name, xml) in enumerate(sheets):
        files[f"xl/worksheets/sheet{i + 1}.xml"] = xml
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, content in files.items():
            z.writestr(name, content)
    return buf.getvalue()


# =====================================================================================
# PDF - minimal writer (A4 landscape, Helvetica, WinAnsi encoding)
# =====================================================================================
PAGE_W, PAGE_H, MARGIN = 842, 595, 34
VIOLET = (0.357, 0.184, 0.816)
INK, MUTED, LINE, BAND = (0.09, 0.08, 0.17), (0.45, 0.43, 0.55), (0.88, 0.87, 0.92), (0.953, 0.945, 0.98)


def _pdf_text(s):
    b = str(s).encode("cp1252", "replace")
    return b.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def _w(s, size):     # approximate Helvetica text width
    return len(str(s)) * size * 0.5


def _fit(s, size, width):
    s = str(s)
    while s and _w(s, size) > width:
        s = s[:-2] + "…" if len(s) > 2 else ""
    return s


def _wrap(s, size, width, max_lines=3):
    words, lines, cur = str(s).split(), [], ""
    for w in words:
        nxt = (cur + " " + w).strip()
        if _w(nxt, size) <= width:
            cur = nxt
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = _fit(lines[-1] + "…", size, width)
    return [_fit(x, size, width) for x in lines]


class _Page:
    def __init__(self):
        self.ops = []

    def rect(self, x, y, w, h, fill=None, stroke=None):
        if fill:
            self.ops.append(f"{fill[0]:.3f} {fill[1]:.3f} {fill[2]:.3f} rg")
        if stroke:
            self.ops.append(f"{stroke[0]:.3f} {stroke[1]:.3f} {stroke[2]:.3f} RG 0.5 w")
        op = "B" if fill and stroke else ("f" if fill else "S")
        self.ops.append(f"{x:.1f} {y:.1f} {w:.1f} {h:.1f} re {op}")

    def line(self, x1, y1, x2, y2, color=LINE):
        self.ops.append(f"{color[0]:.3f} {color[1]:.3f} {color[2]:.3f} RG 0.5 w {x1:.1f} {y1:.1f} m {x2:.1f} {y2:.1f} l S")

    def text(self, x, y, s, size=9, bold=False, color=INK, align="left"):
        if align == "right":
            x -= _w(s, size)
        elif align == "center":
            x -= _w(s, size) / 2
        pre = (f"BT /{'F2' if bold else 'F1'} {size} Tf {color[0]:.3f} {color[1]:.3f} {color[2]:.3f} rg "
               f"{x:.1f} {y:.1f} Td (").encode()
        self.ops.append(pre + _pdf_text(s) + b") Tj ET")

    def stream(self):
        return b"\n".join(op if isinstance(op, bytes) else op.encode() for op in self.ops) + b"\n"


def to_pdf(rep) -> bytes:
    pages = []
    cols = rep["columns"]
    content_w = PAGE_W - 2 * MARGIN

    def new_page():
        p = _Page()
        p.rect(0, PAGE_H - 46, PAGE_W, 46, fill=VIOLET)
        p.text(MARGIN, PAGE_H - 29, rep["title"], 15, True, (1, 1, 1))
        p.text(PAGE_W - MARGIN, PAGE_H - 22, "Ankur Scientific", 10, True, (1, 1, 1), "right")
        p.text(PAGE_W - MARGIN, PAGE_H - 35, "Powered by Medge Controls", 8, False, (0.9, 0.88, 1), "right")
        p.text(MARGIN, PAGE_H - 62, f"{rep['site']}   |   {fmt_ts(rep['from'])}  to  {fmt_ts(rep['to'])} IST   |   "
               f"Interval: {rep['interval']} (average)", 8.5, False, MUTED)
        if rep["simulated"]:
            p.rect(MARGIN, PAGE_H - 84, content_w, 15, fill=(0.93, 0.91, 0.99))
            p.text(MARGIN + 6, PAGE_H - 79, "DEMO DATA - values in this report are simulated, not measured plant data.", 8.5, True, VIOLET)
        pages.append(p)
        return p, PAGE_H - (96 if rep["simulated"] else 78)

    # ---- data log pages (columns split into groups that fit the page width)
    time_w, min_col = 92, 58
    per_group = max(1, int((content_w - time_w) // min_col))
    groups = [list(range(i, min(i + per_group, len(cols)))) for i in range(0, len(cols), per_group)] or [[]]
    for gi, grp in enumerate(groups):
        col_w = (content_w - time_w) / max(1, len(grp))
        p, y = new_page()
        title = "Data log" + (f" (columns {gi + 1}/{len(groups)})" if len(groups) > 1 else "")
        p.text(MARGIN, y - 4, title, 12, True)
        p.text(PAGE_W - MARGIN, y - 4, f"{len(rep['rows'])} rows  |  Generated {fmt_ts(rep['generated'], True)} IST",
               8, False, MUTED, "right")
        y -= 14

        def header(p, y):
            h = 34
            p.rect(MARGIN, y - h, content_w, h, fill=VIOLET)
            p.text(MARGIN + 6, y - 20, "Date / time", 8, True, (1, 1, 1))
            for k, ci in enumerate(grp):
                c = cols[ci]
                lines = _wrap(c["name"], 7, col_w - 8, 2 if c["unit"] else 3) + ([f"({c['unit']})"] if c["unit"] else [])
                cx = MARGIN + time_w + k * col_w + col_w / 2
                for li, ln in enumerate(lines):
                    p.text(cx, y - 10 - li * 8.5, ln, 7, True, (1, 1, 1), "center")
            return y - h - 11

        y = header(p, y)
        if not rep["rows"]:
            p.text(MARGIN + 6, y, "No data recorded in this period.", 9, False, MUTED)
        for ri, r in enumerate(rep["rows"]):
            if y < MARGIN + 18:
                p, y = new_page()
                y = header(p, y - 4)
            if ri % 2:
                p.rect(MARGIN, y - 3.5, content_w, 11.5, fill=BAND)
            p.text(MARGIN + 6, y, fmt_ts(r["t"]), 7.5)
            for k, ci in enumerate(grp):
                v = r["values"][ci]
                p.text(MARGIN + time_w + (k + 1) * col_w - 6, y, fmt_num(v, cols[ci]["decimals"]), 7.5, False, INK, "right")
            y -= 11.5

    # footers
    for i, pg in enumerate(pages):
        pg.line(MARGIN, 24, PAGE_W - MARGIN, 24)
        pg.text(MARGIN, 13, "Ankur Scientific · Plant monitoring · Powered by Medge Controls", 7.5, False, MUTED)
        pg.text(PAGE_W - MARGIN, 13, f"Page {i + 1} of {len(pages)}", 7.5, False, MUTED, "right")

    # ---- assemble PDF objects
    objs = []

    def add(b):
        objs.append(b)
        return len(objs)

    cat = add(None)
    pages_id = add(None)
    f1 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    f2 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
    kids = []
    for pg in pages:
        data = pg.stream()
        cid = add(b"<< /Length %d >>\nstream\n" % len(data) + data + b"endstream")
        kids.append(add(b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %d %d] /Resources << /Font << /F1 %d 0 R /F2 %d 0 R >> >> /Contents %d 0 R >>"
                        % (pages_id, PAGE_W, PAGE_H, f1, f2, cid)))
    objs[cat - 1] = b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id
    objs[pages_id - 1] = b"<< /Type /Pages /Kids [" + b" ".join(b"%d 0 R" % k for k in kids) + b"] /Count %d >>" % len(kids)
    info = add(b"<< /Title (Process Data Report) /Author (Medge Controls) /Producer (Medge Controls dashboard) >>")

    out = io.BytesIO()
    out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, ob in enumerate(objs, 1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n" % i + ob + b"\nendobj\n")
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1))
    for off in offsets:
        out.write(b"%010d 00000 n \n" % off)
    out.write(b"trailer\n<< /Size %d /Root %d 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, cat, info, xref))
    return out.getvalue()
