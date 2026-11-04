"""PLC trend buffer backfill.

The PLC keeps logging while no dashboard PC is connected: every LOG_HDR[1] minutes it writes one record
(time stamp + the 11 analog values) into a ring buffer in D registers (routine: plc/trend_buffer.st).
When the dashboard is connected it reads that buffer and adds the records it does not have yet to the
historian, so the trends show the whole period - also the hours the laptop was switched off.

Layout (all 16-bit words, Modbus holding register address = D number on the AH500):
  D20000  magic 0x4C47 ("LG")          D20001  interval, minutes (1..60, default 2)
  D20002  capacity (records, 1050)      D20003  next write index (0..capacity-1)
  D20004  records written, low word     D20005  records written, high word
  D20006  words per record (12)         D20007  channels (11)          D20008  layout version (1)
  D20020+ records, 12 words each:
          w0  = day_of_month * 2048 + minute_of_day   (PLC real-time clock, local time)
          w1..w11 = value x scale, 0..65534 (65535 = no value), channel order = CHANNELS
"""
from __future__ import annotations

import bisect
import time
from datetime import datetime, timedelta

HEADER = 20000
RECORDS = 20020
MAGIC = 0x4C47
NO_VALUE = 0xFFFF
# dashboard tag id, scale used by the PLC when packing the value into one word
CHANNELS = [("T_01", 10), ("T_02", 10), ("T_03", 10), ("T_04", 10), ("LT_01", 10), ("LT_02", 10),
            ("PH_01", 100), ("PT_01", 100), ("PT_02", 100), ("PT_03", 100), ("PT_04", 100)]
REC_LEN = 1 + len(CHANNELS)
EVERY_S = 300            # re-read the buffer every 5 minutes while connected


def parse_header(w):
    if len(w) < 9 or w[0] != MAGIC or w[6] != REC_LEN or w[7] != len(CHANNELS):
        return None
    cap, nxt, total = w[2], w[3], w[4] | (w[5] << 16)
    if not (0 < cap <= 5000) or nxt >= cap:
        return None
    return {"interval_min": max(1, w[1]), "capacity": cap, "next": nxt, "total": total, "version": w[8]}


def record_time(w0, now: datetime):
    """Local datetime of a record: the most recent date (<= now) whose day-of-month matches."""
    day, minute = w0 >> 11, w0 & 0x7FF
    if not 1 <= day <= 31 or minute >= 1440:
        return None
    d = now.date()
    for back in range(0, 62):
        cand = d - timedelta(days=back)
        if cand.day == day:
            t = datetime(cand.year, cand.month, cand.day) + timedelta(minutes=minute)
            if t <= now + timedelta(minutes=2):
                return t
    return None


def decode_records(hdr, words, now: datetime | None = None):
    """words: the whole record area (capacity x REC_LEN). Returns [(ts, tag, value)] oldest first."""
    now = now or datetime.now()
    cap = hdr["capacity"]
    n = min(hdr["total"], cap)
    first = hdr["next"] if hdr["total"] >= cap else 0
    out = []
    for k in range(n):
        i = (first + k) % cap
        rec = words[i * REC_LEN:(i + 1) * REC_LEN]
        if len(rec) < REC_LEN:
            continue
        t = record_time(rec[0], now)
        if t is None:
            continue
        ts = t.timestamp()
        for (tag, scale), raw in zip(CHANNELS, rec[1:]):
            if raw != NO_VALUE:
                out.append((ts, tag, raw / scale))
    out.sort(key=lambda x: x[0])
    return out


class Backfiller:
    """Reads the PLC buffer through `read(start, count) -> list[int]` and fills gaps in the historian."""

    def __init__(self, hist, max_regs=120):
        self.hist = hist
        self.max_regs = max_regs
        self.last_run = 0.0
        self.disabled = None        # reason, when the buffer is not in the PLC program
        self.info = {}

    def due(self, now):
        return self.disabled is None and now - self.last_run >= EVERY_S

    def run(self, read, now=None):
        now = now or time.time()
        self.last_run = now
        hdr = parse_header(read(HEADER, 9))
        if not hdr:
            self.info = {"state": "not found", "checked": now}
            return 0
        need = hdr["capacity"] * REC_LEN
        words = []
        for a in range(0, need, self.max_regs):
            words += read(RECORDS + a, min(self.max_regs, need - a))
        rows = decode_records(hdr, words, datetime.fromtimestamp(now))
        added = self.fill(rows, hdr["interval_min"] * 60)
        self.info = {"state": "ok", "checked": now, "records": min(hdr["total"], hdr["capacity"]),
                     "interval_min": hdr["interval_min"], "added": added,
                     "oldest": rows[0][0] if rows else None}
        if added:
            self.hist.event("plc_buffer", f"backfilled {added} samples from the PLC trend buffer")
        return added

    def fill(self, rows, interval_s):
        """Insert rows only where the historian has no sample of that tag within half an interval."""
        if not rows:
            return 0
        tol = interval_s / 2
        t0, t1 = rows[0][0] - tol, rows[-1][0] + tol
        have = {tag: self.hist.sample_times(tag, t0, t1) for tag, _ in CHANNELS}
        new = []
        for ts, tag, v in rows:
            times = have.get(tag) or []
            j = bisect.bisect_left(times, ts - tol)
            if j < len(times) and times[j] <= ts + tol:
                continue
            new.append((ts, tag, v, "GOOD", 0))
        self.hist.log_samples(new)
        return len(new)
