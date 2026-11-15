"""SQLite historian: tag samples, alarm journal."""
from __future__ import annotations

import sqlite3
import threading
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS samples (
    ts   REAL NOT NULL,
    tag  TEXT NOT NULL,
    v    REAL,
    q    TEXT NOT NULL,
    sim  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_samples_tag_ts ON samples(tag, ts);
CREATE TABLE IF NOT EXISTS alarms (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tag         TEXT NOT NULL,
    kind        TEXT NOT NULL,
    priority    TEXT NOT NULL,
    message     TEXT NOT NULL,
    value       REAL,
    limit_value REAL,
    simulated   INTEGER NOT NULL DEFAULT 0,
    raised_at   REAL NOT NULL,
    cleared_at  REAL,
    acked_at    REAL,
    acked_by    TEXT,
    ack_note    TEXT
);
CREATE INDEX IF NOT EXISTS ix_alarms_raised ON alarms(raised_at);
CREATE TABLE IF NOT EXISTS alarm_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tag        TEXT NOT NULL,
    kind       TEXT NOT NULL,
    alarm_id   INTEGER,
    note       TEXT NOT NULL,
    author     TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_alarm_notes_key ON alarm_notes(tag, kind, created_at);
CREATE TABLE IF NOT EXISTS runtime (
    equipment TEXT PRIMARY KEY,
    seconds   REAL NOT NULL DEFAULT 0,
    starts    INTEGER NOT NULL DEFAULT 0,
    sim_seconds REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
    ts      REAL NOT NULL,
    kind    TEXT NOT NULL,
    detail  TEXT NOT NULL
);
"""


class Historian:
    def __init__(self, path: str):
        self.path = path
        self._lock = threading.Lock()
        # wait up to 15 s for a lock (e.g. a backup or second reader) instead of failing after the 5 s default
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None, timeout=15)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=NORMAL")
        self._db.executescript(SCHEMA)
        self._last_logged: dict[str, tuple[float, float | None]] = {}

    def close(self):
        with self._lock:
            self._db.close()

    # -- samples --------------------------------------------------------------
    def log_samples(self, rows):
        """rows: iterable of (ts, tag, value_or_None, quality, simulated)."""
        rows = list(rows)
        if not rows:
            return
        with self._lock:
            self._db.execute("BEGIN")
            self._db.executemany("INSERT INTO samples(ts, tag, v, q, sim) VALUES (?,?,?,?,?)", rows)
            self._db.execute("COMMIT")

    def period_stats(self, tag: str, t_from: float, t_to: float, bucket_s: int = 60):
        """min / max / avg of the valid samples, and how many bucket_s slots of the period have data (gaps)."""
        with self._lock:
            mn, mx, avg, n = self._db.execute(
                "SELECT MIN(v), MAX(v), AVG(v), COUNT(v) FROM samples WHERE tag=? AND ts>=? AND ts<? AND v IS NOT NULL",
                (tag, t_from, t_to)).fetchone()
            slots = self._db.execute(
                "SELECT COUNT(DISTINCT CAST((ts - ?) / ? AS INTEGER)) FROM samples WHERE tag=? AND ts>=? AND ts<? AND v IS NOT NULL",
                (t_from, bucket_s, tag, t_from, t_to)).fetchone()[0]
        return {"min": mn, "max": mx, "avg": avg, "samples": n, "slots_with_data": slots}

    def on_seconds(self, tag: str, t_from: float, t_to: float, max_gap: float = 900):
        """Seconds a logged BOOL tag was ON between t_from and t_to. A stretch longer than max_gap without
        samples is not counted (no data = unknown, not running)."""
        with self._lock:
            prev = self._db.execute("SELECT ts, v FROM samples WHERE tag=? AND ts<? ORDER BY ts DESC LIMIT 1",
                                    (tag, t_from)).fetchone()
            rows = self._db.execute("SELECT ts, v FROM samples WHERE tag=? AND ts>=? AND ts<? ORDER BY ts",
                                    (tag, t_from, t_to)).fetchall()
        pts = ([(t_from, prev[1])] if prev and t_from - prev[0] <= max_gap else []) + rows
        total = 0.0
        for i, (ts, v) in enumerate(pts):
            end = pts[i + 1][0] if i + 1 < len(pts) else min(t_to, time.time())
            if v and v >= 0.5:
                total += max(0.0, min(end, ts + max_gap) - ts)
        return total

    def series(self, tag: str, t_from: float, t_to: float, before_s: float = 900):
        """Raw (ts, value, simulated) samples of one tag in [t_from, t_to], plus the last one before t_from
        (if within before_s) so a state that started earlier is known."""
        with self._lock:
            prev = self._db.execute("SELECT ts, v, sim FROM samples WHERE tag=? AND ts<? ORDER BY ts DESC LIMIT 1",
                                    (tag, t_from)).fetchone()
            rows = self._db.execute("SELECT ts, v, sim FROM samples WHERE tag=? AND ts>=? AND ts<=? ORDER BY ts",
                                    (tag, t_from, t_to)).fetchall()
        return ([tuple(prev)] if prev and t_from - prev[0] <= before_s else []) + [tuple(r) for r in rows]

    def sample_times(self, tag: str, t_from: float, t_to: float):
        """Sorted time stamps of the stored samples of one tag (used to fill only real gaps)."""
        with self._lock:
            cur = self._db.execute("SELECT ts FROM samples WHERE tag=? AND ts>=? AND ts<=? ORDER BY ts", (tag, t_from, t_to))
            return [r[0] for r in cur.fetchall()]

    def trend(self, tag: str, t_from: float, t_to: float, points: int = 300):
        points = max(10, min(2000, int(points)))
        span = max(1.0, t_to - t_from)
        bucket = span / points
        with self._lock:
            cur = self._db.execute(
                """SELECT CAST((ts - ?) / ? AS INTEGER) AS b, AVG(v), MIN(v), MAX(v), MAX(ts), MAX(sim),
                          SUM(CASE WHEN q='GOOD' OR q='SIMULATED' THEN 0 ELSE 1 END)
                   FROM samples WHERE tag=? AND ts>=? AND ts<=?
                   GROUP BY b ORDER BY b""",
                (t_from, bucket, tag, t_from, t_to))
            out = []
            for b, avg, mn, mx, last_ts, sim, bad in cur.fetchall():
                out.append({"t": t_from + (b + 0.5) * bucket, "avg": avg, "min": mn, "max": mx,
                            "sim": bool(sim), "bad": bool(bad)})
            return out

    def report_buckets(self, tags, t_from: float, t_to: float, interval_s: int):
        """Aligned buckets for reports: {tag: {bucket_start: (avg, min, max, n, sim)}}."""
        out = {t: {} for t in tags}
        if not tags:
            return out
        marks = ",".join("?" * len(tags))
        with self._lock:
            cur = self._db.execute(
                f"""SELECT tag, CAST(ts / ? AS INTEGER) * ? AS b, AVG(v), MIN(v), MAX(v), COUNT(v), MAX(sim)
                    FROM samples WHERE tag IN ({marks}) AND ts >= ? AND ts < ? AND v IS NOT NULL
                    GROUP BY tag, b ORDER BY b""",
                (interval_s, interval_s, *tags, t_from, t_to))
            for tag, b, avg, mn, mx, n, sim in cur.fetchall():
                out[tag][float(b)] = (avg, mn, mx, n, bool(sim))
        return out

    def period_buckets(self, tags, t_from: float, t_to: float, interval_s: float):
        """Buckets aligned to t_from (e.g. hours of an IST day): {tag: {index: (avg, min, max, n)}}."""
        out = {t: {} for t in tags}
        if not tags:
            return out
        marks = ",".join("?" * len(tags))
        with self._lock:
            cur = self._db.execute(
                f"""SELECT tag, CAST((ts - ?) / ? AS INTEGER) AS b, AVG(v), MIN(v), MAX(v), COUNT(v)
                    FROM samples WHERE tag IN ({marks}) AND ts >= ? AND ts < ? AND v IS NOT NULL
                    GROUP BY tag, b""", (t_from, interval_s, *tags, t_from, t_to))
            for tag, b, avg, mn, mx, n in cur.fetchall():
                out[tag][int(b)] = (avg, mn, mx, n)
        return out

    def minutes_at_or_above(self, tag: str, t_from: float, t_to: float, limit: float) -> int:
        """Minutes of the period in which the value reached the limit at least once."""
        with self._lock:
            return self._db.execute(
                """SELECT COUNT(*) FROM (SELECT MAX(v) AS m FROM samples WHERE tag=? AND ts>=? AND ts<? AND v IS NOT NULL
                   GROUP BY CAST((ts - ?) / 60 AS INTEGER)) WHERE m >= ?""",
                (tag, t_from, t_to, t_from, limit)).fetchone()[0]

    def rising_edges(self, tag: str, t_from: float, t_to: float) -> int:
        """How many times a BOOL tag went OFF -> ON inside the period (machine starts)."""
        with self._lock:
            return self._db.execute(
                """SELECT COUNT(*) FROM (SELECT v, LAG(v) OVER (ORDER BY ts) AS p FROM samples
                   WHERE tag=? AND ts>=? AND ts<? AND v IS NOT NULL) WHERE v >= 0.5 AND p IS NOT NULL AND p < 0.5""",
                (tag, t_from, t_to)).fetchone()[0]

    def first_sample_ts(self):
        """Oldest stored sample (epoch s) or None - the date pickers never offer history that is not there."""
        with self._lock:
            r = self._db.execute("SELECT MIN(ts) FROM samples").fetchone()
        return r[0] if r and r[0] is not None else None

    def purge(self, retention_days: int):
        cutoff = time.time() - retention_days * 86400
        with self._lock:
            self._db.execute("DELETE FROM samples WHERE ts < ?", (cutoff,))
            self._db.execute("DELETE FROM alarms WHERE raised_at < ? AND cleared_at IS NOT NULL", (cutoff,))
            self._db.execute("DELETE FROM events WHERE ts < ?", (cutoff,))

    # -- alarms ---------------------------------------------------------------
    def alarm_raise(self, tag, kind, priority, message, value, limit_value, simulated, ts):
        with self._lock:
            cur = self._db.execute(
                "INSERT INTO alarms(tag, kind, priority, message, value, limit_value, simulated, raised_at)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (tag, kind, priority, message, value, limit_value, int(simulated), ts))
            return cur.lastrowid

    def alarm_clear(self, alarm_id, ts):
        with self._lock:
            self._db.execute("UPDATE alarms SET cleared_at=? WHERE id=? AND cleared_at IS NULL", (ts, alarm_id))

    def alarm_ack(self, alarm_id, user, note, ts):
        with self._lock:
            cur = self._db.execute(
                "UPDATE alarms SET acked_at=?, acked_by=?, ack_note=? WHERE id=? AND acked_at IS NULL",
                (ts, user, note, alarm_id))
            return cur.rowcount > 0

    def open_alarms(self):
        with self._lock:
            cur = self._db.execute("SELECT * FROM alarms WHERE cleared_at IS NULL")
            cols = [c[0] for c in cur.description]
            return [dict(zip(cols, r)) for r in cur.fetchall()]

    def alarm_rows(self, where="1=1", params=(), limit=200):
        with self._lock:
            cur = self._db.execute(
                f"SELECT * FROM alarms WHERE {where} ORDER BY raised_at DESC LIMIT ?", (*params, int(limit)))
            cols = [c[0] for c in cur.description]
            return [dict(zip(cols, r)) for r in cur.fetchall()]

    # -- alarm notes (operator knowledge: cause / fix, kept per alarm source) ----------
    def add_alarm_note(self, tag, kind, alarm_id, note, author, ts):
        with self._lock:
            self._db.execute("INSERT INTO alarm_notes(tag, kind, alarm_id, note, author, created_at) VALUES (?,?,?,?,?,?)",
                             (tag, kind, alarm_id, note, author, ts))

    def alarm_notes(self, keys, per_key=5):
        """keys: iterable of (tag, kind) -> {(tag, kind): [ {note, author, created_at}, ... newest first ]}"""
        out = {}
        with self._lock:
            for tag, kind in set(keys):
                cur = self._db.execute(
                    "SELECT note, author, created_at FROM alarm_notes WHERE tag=? AND kind=? ORDER BY created_at DESC LIMIT ?",
                    (tag, kind, int(per_key)))
                out[(tag, kind)] = [{"note": n, "author": a, "created_at": t} for n, a, t in cur.fetchall()]
        return out

    # -- equipment run hours -------------------------------------------------------
    def runtime_load(self):
        with self._lock:
            cur = self._db.execute("SELECT equipment, seconds, starts, sim_seconds FROM runtime")
            return {e: {"seconds": s, "starts": n, "sim_seconds": ss} for e, s, n, ss in cur.fetchall()}

    def runtime_save(self, data: dict):
        with self._lock:
            self._db.execute("BEGIN")
            self._db.executemany(
                "INSERT INTO runtime(equipment, seconds, starts, sim_seconds) VALUES (?,?,?,?) "
                "ON CONFLICT(equipment) DO UPDATE SET seconds=excluded.seconds, starts=excluded.starts, "
                "sim_seconds=excluded.sim_seconds",
                [(k, v["seconds"], v["starts"], v["sim_seconds"]) for k, v in data.items()])
            self._db.execute("COMMIT")

    # -- events -----------------------------------------------------------------
    def event(self, kind, detail):
        with self._lock:
            self._db.execute("INSERT INTO events(ts, kind, detail) VALUES (?,?,?)", (time.time(), kind, detail))

    def events(self, limit=100):
        with self._lock:
            cur = self._db.execute("SELECT ts, kind, detail FROM events ORDER BY ts DESC LIMIT ?", (int(limit),))
            return [{"ts": a, "kind": b, "detail": c} for a, b, c in cur.fetchall()]
