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
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
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
