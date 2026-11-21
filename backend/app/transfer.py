"""Sludge transfer totalizer: how much material went out of the sludge water tank (LT-01).

There is no flow meter on this line, so the amount is CALCULATED from the stored LT-01 level history:
  * every time the level goes DOWN, the drop is ADDED to the total (e.g. 100 % -> 50 % adds 50 %);
    when the level goes up (filling) nothing is subtracted - counting simply continues from the new level
  * transmitter noise is ignored: a drop counts only once the level is at least `deadband_mm` (default 10 mm)
    below its last high point, and a rise must also exceed the deadband before a new high point is taken
  * % of tank = drop / LT-01 range (0-3600 mm);  m3 = drop x tank area (only when the admin entered the tank
    capacity or size - nothing is assumed)
Each continuous fall is listed as one "drop" with its start / end time and which UG sludge pumps ran meanwhile.
"""
from __future__ import annotations

import time

LEVEL_TAG = "LT_01"
PUMPS = ("OP_P1A", "OP_P1B")            # UG sludge pumps to volute press (main / standby) - shown as information
# every tank with a level transmitter; the pumps that empty it are shown next to each drop (information only)
TANKS = [
    {"id": "LT_01", "pumps": ("OP_P1A", "OP_P1B"), "pump_word": "sludge"},     # sludge water tank -> volute press
    {"id": "LT_02", "pumps": ("OP_P5A", "OP_P5B"), "pump_word": "filtrate"},   # filtrate tank
]
MAX_GAP = 900                          # pump state older than this without a sample = unknown
DEFAULT_DEADBAND = 10.0                # mm


def _on_intervals(samples, t0, t1, now):
    """[(start, end)] where a BOOL series is ON, clipped to [t0, t1]; long gaps end an interval."""
    out, start, cap = [], None, min(t1, now)
    for i, (ts, v, _sim) in enumerate(samples):
        nxt = samples[i + 1][0] if i + 1 < len(samples) else cap
        on = v is not None and v >= 0.5
        if on:
            if start is None:
                start = max(ts, t0)
            if nxt - ts > MAX_GAP:
                out.append((start, min(ts + MAX_GAP, cap)))
                start = None
        elif start is not None:
            out.append((start, min(max(ts, t0), cap)))
            start = None
    if start is not None:
        out.append((start, cap))
    return [(a, b) for a, b in out if b > a]


def level_drops(samples, deadband):
    """Walk the level samples with hysteresis. Returns (total_drop, [episode]) where an episode is one continuous
    fall: {start, end, level_start, level_end, drop}. Rises are never subtracted."""
    total, episodes, ref, ref_ts, ep = 0.0, [], None, None, None
    for ts, v, _sim in samples:
        if v is None:
            continue
        if ref is None:
            ref, ref_ts = v, ts
            continue
        if v <= ref - deadband:                          # level went down: add the drop
            total += ref - v
            if ep is None:
                ep = {"start": ref_ts, "level_start": ref}
            ep.update(end=ts, level_end=v)
            ref, ref_ts = v, ts
        elif v >= ref + deadband:                        # level went up (filling): new reference, close the fall
            if ep is not None:
                episodes.append(ep)
                ep = None
            ref, ref_ts = v, ts
    if ep is not None:
        episodes.append(ep)
    for e in episodes:
        e["drop"] = e["level_start"] - e["level_end"]
    return total, episodes


def tank_area(cfg, tank_id):
    """Area (m2) entered for one tank; LT-01 also accepts the older single-tank setting."""
    t = ((cfg.get("tanks") or {}).get(tank_id) or {})
    a = t.get("tank_area_m2")
    if a is None and tank_id == LEVEL_TAG:
        a = cfg.get("tank_area_m2")
    return a


def transfer_report(store, historian, t0, t1, now=None):
    """All LT tanks: {from, to, ..., tanks: [one tank_report per level transmitter]}."""
    now = now or time.time()
    tanks = [tank_report(store, historian, t["id"], t["pumps"], t["pump_word"], t0, t1, now) for t in TANKS
             if t["id"] in store.tag_map()]
    return {"from": t0, "to": t1, "generated": now, "simulated": any(t["simulated"] for t in tanks),
            "deadband_mm": float((store.settings.get("transfer") or {}).get("deadband_mm") or DEFAULT_DEADBAND),
            "tanks": tanks}


def tank_report(store, historian, level_tag, pumps, pump_word, t0, t1, now):
    cfg = store.settings.get("transfer") or {}
    area = tank_area(cfg, level_tag)
    deadband = float(cfg.get("deadband_mm") or DEFAULT_DEADBAND)
    eq = {e["id"]: e for e in store.equipment}
    lvl_tag = store.tag_map().get(level_tag) or {}
    lo, hi = lvl_tag.get("eng_min"), lvl_tag.get("eng_max")
    span = (float(hi) - float(lo)) if lo is not None and hi is not None and float(hi) > float(lo) else None

    def pct(mm):
        return None if mm is None or span is None else round(mm / span * 100.0, 1)

    def m3(mm):
        return None if mm is None or area is None else round(mm / 1000.0 * area, 2)

    level = historian.series(level_tag, t0, t1)
    total, eps = level_drops(level, deadband)
    runs = []
    for pid in pumps:
        e = eq.get(pid)
        if e and e.get("run_tag"):
            runs += [(a, b, pid) for a, b in _on_intervals(historian.series(e["run_tag"], t0, t1), t0, t1, now)]
    drops = []
    for e in eps:
        who = sorted({p for a, b, p in runs if a < e["end"] and b > e["start"]})
        drops.append({
            "start": e["start"], "end": e["end"], "minutes": round((e["end"] - e["start"]) / 60.0, 1),
            "level_start": round(e["level_start"], 1), "level_end": round(e["level_end"], 1),
            "drop_mm": round(e["drop"], 1), "drop_pct": pct(e["drop"]), "volume_m3": m3(e["drop"]),
            "pumps": [eq[p]["name"] for p in who],
            "note": "" if who else f"no {pump_word} pump running",
        })
    valid = [v for _t, v, _s in level if v is not None]
    return {
        "simulated": any(s for _t, _v, s in level), "pump_word": pump_word,
        "level_tag": level_tag, "level_name": lvl_tag.get("name", level_tag), "level_unit": lvl_tag.get("unit", "mm"),
        "level_range": [lo, hi], "deadband_mm": deadband, "tank_area_m2": area,
        "level_first": valid[0] if valid else None, "level_last": valid[-1] if valid else None,
        "samples": len(valid),
        "drops": drops,
        "totals": {
            "drops": len(drops),
            "drop_mm": round(total, 1), "drop_pct": pct(total), "volume_m3": m3(total),
            "pump_hours": round(sum(b - a for a, b, _p in runs) / 3600.0, 2),
        },
    }
