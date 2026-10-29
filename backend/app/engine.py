"""Acquisition engine: polls the Delta PLC (or simulates it), evaluates alarms,
derives equipment status, logs to the historian.  Read-only."""
from __future__ import annotations

import collections
import hashlib
import math
import random
import threading
import time

from . import codec, config_store, delta_ah500
from .iot_link import IotLink, modbus_target
from .modbus_tcp import ModbusError, ModbusException, ModbusTcpClient

Q_GOOD, Q_BAD, Q_STALE, Q_SIM, Q_CFG, Q_INIT = "GOOD", "BAD", "STALE", "SIMULATED", "CONFIG_ERROR", "INIT"


def _phase(key: str) -> float:
    return int(hashlib.md5(key.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


class TagState:
    __slots__ = ("value", "raw", "quality", "ts", "error", "next_due", "last_logged", "last_logged_value")

    def __init__(self):
        self.value = None
        self.raw = None
        self.quality = Q_INIT
        self.ts = None
        self.error = None
        self.next_due = 0.0
        self.last_logged = 0.0
        self.last_logged_value = None


class Engine:
    TICK = 0.2

    def __init__(self, store: config_store.ConfigStore, historian):
        self.store = store
        self.hist = historian
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread = None
        self._client: ModbusTcpClient | None = None
        self._client_key = None
        self._loaded_version = -1
        self.states: dict[str, TagState] = {}
        self.resolved: dict[str, object] = {}      # tag id -> ModbusAddress | str(error)
        self.stats = {
            "state": "STARTING", "last_ok": None, "last_error": None, "last_error_ts": None,
            "consecutive_failures": 0, "reconnects": 0, "requests": 0, "errors": 0,
            "connected_since": None, "next_retry": 0.0,
        }
        self._window = collections.deque(maxlen=200)   # (ok, latency_ms)
        self._open_alarms: dict[tuple, dict] = {}
        self._pending_alarms: dict[tuple, float] = {}
        self._equipment_state: dict[str, dict] = {}
        self.runtime = historian.runtime_load()
        self._last_runtime_save = time.time()
        self._last_purge = 0.0
        self._sim_trip = {}
        self.iot = IotLink()
        for a in historian.open_alarms():
            self._open_alarms[(a["tag"], a["kind"])] = a

    # -- lifecycle --------------------------------------------------------------
    def start(self):
        self._thread = threading.Thread(target=self._run, name="engine", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        if self._client:
            self._client.close()
        self.iot.stop()
        self.hist.runtime_save(self.runtime)

    def _reload_if_needed(self):
        if self._loaded_version == self.store.version:
            return
        with self._lock:
            self._loaded_version = self.store.version
            self.resolved = {}
            for t in self.store.tags:
                try:
                    self.resolved[t["id"]] = config_store.resolve_tag(t)
                except (delta_ah500.AddressError, codec.DecodeError) as e:
                    self.resolved[t["id"]] = str(e)
                self.states.setdefault(t["id"], TagState()).next_due = 0.0
            for tid in list(self.states):
                if tid not in self.resolved:
                    del self.states[tid]
            if getattr(self, "_last_mode", None) not in (None, self.mode):
                # data source changed: close every open alarm so simulated and live alarms never mix
                now = time.time()
                for a in self._open_alarms.values():
                    self.hist.alarm_clear(a["id"], now)
                self._open_alarms.clear()
                self._pending_alarms.clear()
                for st in self.states.values():
                    st.value, st.quality, st.ts, st.error = None, Q_INIT, None, None
                self.hist.event("mode", f"data source -> {self.mode}")
            self._last_mode = self.mode
            plc = self.store.settings["plc"]
            key = (*modbus_target(self.store.settings), int(plc["unit_id"]), int(plc["timeout_ms"]))
            if key != self._client_key:
                if self._client:
                    self._client.close()
                self._client = ModbusTcpClient(*key[:3], timeout=key[3] / 1000.0)
                self._client_key = key
                self.stats["next_retry"] = 0.0

    @property
    def mode(self):
        return self.store.settings["source"]["mode"]

    # -- main loop ----------------------------------------------------------------
    def _run(self):
        self.hist.event("engine", "started")
        while not self._stop.is_set():
            t0 = time.time()
            try:
                self.iot.ensure(self.store.settings)
                self._reload_if_needed()
                self._cycle(t0)
            except Exception as e:  # never let the loop die
                self.hist.event("engine_error", repr(e))
            self._stop.wait(max(0.02, self.TICK - (time.time() - t0)))

    def _cycle(self, now):
        tags = self.store.tags
        due = [t for t in tags if self.states.get(t["id"]) and self.states[t["id"]].next_due <= now]
        if due:
            if self.mode == "simulation":
                self.stats["state"] = "SIMULATION"
                self._simulate(due, now)
            else:
                self._poll(due, now)
            for t in due:
                self.states[t["id"]].next_due = now + t.get("poll_ms", 1000) / 1000.0
        self._mark_stale(now)
        self._derive_equipment(now)
        self._evaluate_alarms(now)
        self._log(now)
        if now - self._last_runtime_save > 60:
            self.hist.runtime_save(self.runtime)
            self._last_runtime_save = now
        if now - self._last_purge > 3600:
            self.hist.purge(self.store.settings["historian"]["retention_days"])
            self._last_purge = now

    # -- Modbus polling -------------------------------------------------------------
    def _plan(self, tags):
        """Group tags into block reads: [(fc, start, count, [(tag, ModbusAddress)])]."""
        plc = self.store.settings["plc"]
        by_fc = collections.defaultdict(list)
        for t in tags:
            ma = self.resolved.get(t["id"])
            if isinstance(ma, str) or ma is None:
                st = self.states[t["id"]]
                st.quality, st.error, st.value = Q_CFG, ma or "unresolved", None
                continue
            n = 1 if ma.is_bit_table else codec.register_count(t["data_type"])
            by_fc[ma.function_code].append((ma.address, n, t, ma))
        blocks = []
        for fc, items in by_fc.items():
            items.sort(key=lambda x: x[0])
            limit = plc["max_bits_per_read"] if fc in (1, 2) else plc["max_regs_per_read"]
            gap = plc["max_gap"] * (16 if fc in (1, 2) else 1)
            cur = None
            for addr, n, t, ma in items:
                end = addr + n
                if cur and addr <= cur[1] + gap and end - cur[0] <= limit:
                    cur[1] = max(cur[1], end)
                    cur[2].append((t, ma))
                else:
                    if cur:
                        blocks.append((fc, cur[0], cur[1] - cur[0], cur[2]))
                    cur = [addr, end, [(t, ma)]]
            if cur:
                blocks.append((fc, cur[0], cur[1] - cur[0], cur[2]))
        return blocks

    def _read(self, fc, start, count):
        plc = self.store.settings["plc"]
        last = None
        for attempt in range(plc["retries"] + 1):
            t0 = time.perf_counter()
            self.stats["requests"] += 1
            try:
                if not self._client.connected:
                    self._client.connect()
                    self.stats["reconnects"] += 1
                    self.stats["connected_since"] = time.time()
                    self.hist.event("comm", f"connected to {self._client.host}:{self._client.port}")
                data = self._client.read(fc, start, count)
                self._window.append((True, (time.perf_counter() - t0) * 1000))
                self.stats["last_ok"] = time.time()
                self.stats["consecutive_failures"] = 0
                self.stats["state"] = "CONNECTED"
                return data
            except ModbusException as e:   # PLC answered -> link is fine, address is not
                self._window.append((True, (time.perf_counter() - t0) * 1000))
                self.stats["errors"] += 1
                raise
            except (OSError, ModbusError) as e:
                last = e
                self.stats["errors"] += 1
                self._window.append((False, None))
        self.stats["consecutive_failures"] += 1
        self.stats["last_error"] = f"{type(last).__name__}: {last}"
        self.stats["last_error_ts"] = time.time()
        if self.stats["state"] != "DISCONNECTED":
            self.hist.event("comm", f"lost: {self.stats['last_error']}")
        self.stats["state"] = "DISCONNECTED"
        self.stats["connected_since"] = None
        self.stats["next_retry"] = time.time() + plc["reconnect_s"]
        raise last

    def _poll(self, due, now):
        if self.stats["state"] == "DISCONNECTED" and now < self.stats["next_retry"]:
            for t in due:
                self._set_bad(t, now, "PLC not reachable, waiting to retry")
            return
        if self.stats["state"] in ("STARTING", "SIMULATION"):
            self.stats["state"] = "CONNECTING"
        for fc, start, count, members in self._plan(due):
            try:
                data = self._read(fc, start, count)
            except ModbusException as e:
                if len(members) > 1:   # isolate which tag has the illegal address
                    for t, ma in members:
                        n = 1 if ma.is_bit_table else codec.register_count(t["data_type"])
                        try:
                            self._apply(t, ma, self._read(fc, ma.address, n), ma.address, now)
                        except ModbusException as e2:
                            self._set_bad(t, now, str(e2), cfg=True)
                        except (OSError, ModbusError) as e2:
                            self._set_bad(t, now, str(e2))
                else:
                    self._set_bad(members[0][0], now, str(e), cfg=True)
                continue
            except (OSError, ModbusError) as e:
                for t, _ in members:
                    self._set_bad(t, now, str(e))
                # link is down: skip remaining blocks this cycle
                remaining = [t for t in due if self.states[t["id"]].ts is None or self.states[t["id"]].ts < now]
                for t in remaining:
                    if self.states[t["id"]].quality != Q_CFG:
                        self._set_bad(t, now, str(e))
                return
            for t, ma in members:
                self._apply(t, ma, data, start, now)

    def _apply(self, t, ma, data, start, now):
        st = self.states[t["id"]]
        off = ma.address - start
        try:
            if ma.is_bit_table:
                raw = bool(data[off])
                val = raw
            else:
                n = codec.register_count(t["data_type"])
                regs = data[off:off + n]
                wo = t.get("word_order") or self.store.settings["plc"]["default_word_order"]
                if wo == "default":
                    wo = self.store.settings["plc"]["default_word_order"]
                raw = codec.decode_registers(regs, t["data_type"], wo, ma.bit)
                val = raw
            if t["data_type"] == "BOOL" or ma.bit is not None:
                val = bool(val) ^ bool(t.get("invert"))
            else:
                val = codec.apply_scaling(raw, t.get("scaling"))
            st.raw, st.value, st.quality, st.ts, st.error = raw, val, Q_GOOD, now, None
        except codec.DecodeError as e:
            self._set_bad(t, now, str(e), cfg=True)

    def _set_bad(self, t, now, err, cfg=False):
        st = self.states[t["id"]]
        st.quality, st.error = (Q_CFG if cfg else Q_BAD), err
        # keep last value for display (marked bad) but do not refresh timestamp

    def _mark_stale(self, now):
        if self.mode == "simulation":
            return
        for t in self.store.tags:
            st = self.states.get(t["id"])
            if st and st.quality == Q_GOOD and st.ts and now - st.ts > max(3 * t.get("poll_ms", 1000) / 1000, 5):
                st.quality = Q_STALE

    # -- simulation ------------------------------------------------------------------
    def _simulate(self, due, now):
        eq_by_tag = {}
        for e in self.store.equipment:
            for k in ("run_tag", "trip_tag", "cmd_tag", "open_tag", "close_tag", "open_cmd_tag", "close_cmd_tag"):
                if e.get(k):
                    eq_by_tag[e[k]] = (e, k)
        for t in due:
            st = self.states[t["id"]]
            ma = self.resolved.get(t["id"])
            if isinstance(ma, str):
                st.quality, st.error, st.value = Q_CFG, ma, None
                continue
            ph = _phase(t["id"])
            if t["data_type"] == "BOOL":
                v = self._sim_bool(t, eq_by_tag.get(t["id"]), now, ph)
            else:
                v = self._sim_analog(t, now, ph)
            st.raw, st.value, st.quality, st.ts, st.error = v, v, Q_SIM, now, None

    def _sim_running(self, eq_id, now):
        ph = _phase(eq_id)
        period = 900 + ph * 1800
        return ((now / period + ph) % 1.0) < (0.55 + 0.4 * ph)

    def _sim_tripped(self, eq_id, now):
        ph = _phase(eq_id + "trip")
        # each equipment trips for ~90 s roughly once every 1-3 h; only a few equipment ever trip
        if ph > 0.25:
            return False
        period = 3600 + ph * 7200
        return ((now / period + ph * 3) % 1.0) < (90 / period)

    def _sim_bool(self, t, eq, now, ph):
        if eq:
            e, role = eq
            running = self._sim_running(e["id"], now)
            tripped = self._sim_tripped(e["id"], now)
            if e.get("type") == "valve":
                eph = _phase(e["id"])
                is_open = ((now / (600 + eph * 600) + eph) % 1.0) < 0.5
                return {"open_tag": is_open, "close_tag": not is_open, "open_cmd_tag": is_open,
                        "close_cmd_tag": not is_open}.get(role, False)
            if role == "trip_tag":
                return tripped
            if role == "run_tag":
                return running and not tripped
            if role == "cmd_tag":
                return running and not tripped
        al = t.get("alarm") or {}
        if al.get("enabled"):
            # rare short alarm pulses so the alarm UI can be exercised
            period = 2400 + ph * 4800
            active = ((now / period + ph) % 1.0) < (45 / period) and ph < 0.3
            return active if al.get("on", True) else not active
        return ((now / (300 + ph * 900) + ph) % 1.0) < 0.6

    def _sim_analog(self, t, now, ph):
        lo = t.get("eng_min")
        hi = t.get("eng_max")
        if lo is None or hi is None:
            lo, hi = 0.0, 100.0
        span = float(hi) - float(lo)
        if t["id"].endswith("_SP"):          # simulated set points sit steady near the top of range
            return float(lo) + span * 0.85
        base =float(lo) + span * (0.45 + 0.2 * ph)
        v = base + span * 0.12 * math.sin(now / (120 + 240 * ph) + ph * 6.28) \
            + span * 0.015 * math.sin(now / 45 + ph * 3) + random.uniform(-0.002, 0.002) * span
        if t["data_type"] in ("INT16", "UINT16", "INT32", "UINT32") and (t.get("scaling") or {}).get("mode", "none") == "none":
            v = round(v)
        return max(float(lo), min(float(hi), v))

    # -- equipment ----------------------------------------------------------------------
    def _tv(self, tag_id):
        if not tag_id:
            return None, None
        st = self.states.get(tag_id)
        if not st:
            return None, Q_CFG
        return st.value, st.quality

    def _derive_equipment(self, now):
        ok_q = (Q_GOOD, Q_SIM)
        for e in self.store.equipment:
            prev = self._equipment_state.get(e["id"], {})
            if e.get("type") == "valve":
                # simple two-state valve: open limit switch ON = OPEN, otherwise CLOSED
                o, qo = self._tv(e.get("open_tag"))
                if qo not in ok_q:
                    status, color = "UNKNOWN", "grey"
                elif o:
                    status, color = "OPEN", "green"
                else:
                    status, color = "CLOSED", "grey"
                self._equipment_state[e["id"]] = {"status": status, "color": color, "since": prev.get("since", now)
                                                  if prev.get("status") == status else now}
                continue
            # simple three-state motor: trip input ON = TRIP; run feedback ON *or* start command output (DO) ON = RUNNING;
            # otherwise STOPPED.  Per equipment "run_source" can be "feedback" or "command" to use only one of them.
            run, qr = self._tv(e.get("run_tag"))
            trip, qt = self._tv(e.get("trip_tag"))
            cmd, qc = self._tv(e.get("cmd_tag"))
            src = e.get("run_source", "either")
            running = bool(run) if src == "feedback" else bool(cmd) if src == "command" else bool(run) or bool(cmd)
            qualities = [q for q in (qr, qt, qc) if q is not None]
            if not qualities or any(q not in ok_q for q in qualities):
                status, color = "UNKNOWN", "grey"
            elif trip:
                status, color = "TRIP", "red"
            elif running:
                status, color = "RUNNING", "green"
            else:
                status, color = "STOPPED", "grey"
            st = {"status": status, "color": color,
                  "since": prev.get("since", now) if prev.get("status") == status else now}
            # run hours
            rt = self.runtime.setdefault(e["id"], {"seconds": 0.0, "starts": 0, "sim_seconds": 0.0})
            last = prev.get("_t")
            if status == "RUNNING" and last:
                dt = min(5.0, now - last)
                rt["sim_seconds" if self.mode == "simulation" else "seconds"] += dt
            if status == "RUNNING" and prev.get("status") not in (None, "RUNNING") and self.mode != "simulation":
                rt["starts"] += 1
            st["_t"] = now
            self._equipment_state[e["id"]] = st

    # -- alarms ---------------------------------------------------------------------------
    def _evaluate_alarms(self, now):
        conds = {}   # (tag, kind) -> (priority, message, value, limit)
        sim = self.mode == "simulation"
        if not sim and self.stats["state"] == "DISCONNECTED":
            conds[("_COMM", "comm_loss")] = ("red", f"PLC communication lost ({self.stats['last_error']})", None, None)
        for t in self.store.tags:
            al = t.get("alarm") or {}
            if not al.get("enabled"):
                continue
            st = self.states.get(t["id"])
            if not st or st.quality not in (Q_GOOD, Q_SIM) or st.value is None:
                continue
            v = st.value
            name = t["name"]
            if t["data_type"] == "BOOL" or isinstance(v, bool):
                if bool(v) == bool(al.get("on", True)):
                    conds[(t["id"], "state")] = (al.get("priority", "red"), al.get("message") or f"{name} active", 1.0 if v else 0.0, None)
                continue
            unit = t.get("unit", "")
            db = float(al.get("deadband", 0) or 0)
            for kind, cmp, prio in (("hihi", "gt", "red"), ("hi", "gt", al.get("priority", "yellow")),
                                    ("lolo", "lt", "red"), ("lo", "lt", al.get("priority", "yellow"))):
                lim = al.get(kind)
                if lim in (None, ""):
                    continue
                lim = float(lim)
                active = (t["id"], kind) in self._open_alarms
                if cmp == "gt":
                    on = v > lim or (active and v > lim - db)
                else:
                    on = v < lim or (active and v < lim + db)
                if on:
                    word = {"hihi": "High-High", "hi": "High", "lolo": "Low-Low", "lo": "Low"}[kind]
                    conds[(t["id"], kind)] = (prio, f"{name} {word}: {v:.{t.get('decimals', 1)}f} {unit} (limit {lim:g})", v, lim)
            # if hihi active, suppress hi (same for lolo/lo)
            if (t["id"], "hihi") in conds:
                conds.pop((t["id"], "hi"), None)
            if (t["id"], "lolo") in conds:
                conds.pop((t["id"], "lo"), None)
        tagmap = self.store.tag_map()
        # raise (with optional on-delay)
        for key, (prio, msg, v, lim) in conds.items():
            if key in self._open_alarms:
                continue
            delay = float((tagmap.get(key[0], {}).get("alarm") or {}).get("delay_s", 0) or 0)
            first = self._pending_alarms.setdefault(key, now)
            if now - first < delay:
                continue
            aid = self.hist.alarm_raise(key[0], key[1], prio, msg, v, lim, sim, now)
            self._open_alarms[key] = {"id": aid, "tag": key[0], "kind": key[1], "priority": prio, "message": msg,
                                      "value": v, "limit_value": lim, "simulated": int(sim), "raised_at": now,
                                      "acked_at": None, "acked_by": None}
        for key in list(self._pending_alarms):
            if key not in conds:
                del self._pending_alarms[key]
        # clear
        for key, a in list(self._open_alarms.items()):
            if key not in conds:
                # do not clear tag alarms just because data went bad; clear when tag is good again
                st = self.states.get(key[0])
                if key[0] != "_COMM" and st and st.quality not in (Q_GOOD, Q_SIM):
                    continue
                self.hist.alarm_clear(a["id"], now)
                del self._open_alarms[key]

    def ack_alarm(self, alarm_id, user, note=""):
        ok = self.hist.alarm_ack(alarm_id, user, note, time.time())
        for a in self._open_alarms.values():
            if a["id"] == alarm_id and ok:
                a["acked_at"], a["acked_by"], a["ack_note"] = time.time(), user, note
        return ok

    # -- logging -------------------------------------------------------------------------------
    def _log(self, now):
        interval = self.store.settings["historian"]["log_interval_s"]
        rows = []
        for t in self.store.tags:
            if not t.get("log", True):
                continue
            st = self.states.get(t["id"])
            if not st or st.quality == Q_INIT:
                continue
            v = st.value
            num = None if v is None else float(v)
            changed_bool = t["data_type"] == "BOOL" and num != st.last_logged_value
            if now - st.last_logged >= interval or changed_bool:
                rows.append((now, t["id"], num if st.quality in (Q_GOOD, Q_SIM, Q_STALE) else None,
                             st.quality, int(st.quality == Q_SIM)))
                st.last_logged, st.last_logged_value = now, num
        self.hist.log_samples(rows)

    # -- snapshots for the API -----------------------------------------------------------------------
    def connection(self):
        s = self.stats
        win = list(self._window)
        oks = [x for x in win if x[0]]
        lat = [x[1] for x in oks if x[1] is not None]
        src = self.store.settings["source"]
        plc = self.store.settings["plc"]
        host, port = modbus_target(self.store.settings)
        iot = self.store.settings.get("iot") or {}
        via = f" via IoT key {iot.get('access_key')}" if iot.get("enabled") else ""
        return {
            "mode": self.mode,
            "state": "SIMULATION" if self.mode == "simulation" else s["state"],
            "comm_verified": bool(src.get("comm_verified")) and self.mode == "modbus",
            "plc": f"{plc['model']} @ {host}:{port} (unit {plc['unit_id']}){via}",
            "iot": self.iot.status(self.store.settings),
            "quality_pct": None if self.mode == "simulation" or not win else round(100 * len(oks) / len(win), 1),
            "avg_latency_ms": round(sum(lat) / len(lat), 1) if lat else None,
            "last_ok": s["last_ok"], "last_error": s["last_error"], "last_error_ts": s["last_error_ts"],
            "consecutive_failures": s["consecutive_failures"], "reconnects": s["reconnects"],
            "requests": s["requests"], "errors": s["errors"], "connected_since": s["connected_since"],
            "last_update": max((st.ts for st in self.states.values() if st.ts), default=None),
        }

    def live(self, include_hidden=False):
        verified = self.mode == "modbus" and bool(self.store.settings["source"].get("comm_verified"))
        out = []
        for t in self.store.tags:
            if not include_hidden and not t.get("show_on_dashboard", True):
                continue
            st = self.states.get(t["id"]) or TagState()
            v = st.value
            sp = self.states.get(t.get("setpoint_tag") or "")
            sp_val = sp.value if sp and sp.quality in (Q_GOOD, Q_SIM, Q_STALE) and not isinstance(sp.value, bool) else None
            out.append({
                "setpoint_value": None if sp_val is None else round(sp_val, 6),
                "id": t["id"], "name": t["name"], "group": t.get("group", ""), "area": t.get("area", ""),
                "unit": t.get("unit", ""), "decimals": t.get("decimals", 1), "data_type": t["data_type"],
                "value": v if not isinstance(v, float) else round(v, 6), "quality": st.quality, "ts": st.ts,
                "error": st.error, "simulated": st.quality == Q_SIM,
                "verified": verified and bool(t.get("mapping_verified")),
                "states": t.get("states"), "eng_min": t.get("eng_min"), "eng_max": t.get("eng_max"),
                "alarm": {k: (t.get("alarm") or {}).get(k) for k in ("hi", "lo", "hihi", "lolo")},
                "setpoint_tag": t.get("setpoint_tag"), "device": t.get("device"), "trend": t.get("trend", True),
                "kpi": t.get("kpi", False),
                "trend_min": t.get("trend_min"), "trend_max": t.get("trend_max"),   # optional fixed trend Y-axis
            })
        return out

    def reset_runtime(self, ids):
        """Set run hours and starts back to zero for the given equipment ids (saved immediately)."""
        done = []
        for i in ids:
            rt = self.runtime.setdefault(i, {"seconds": 0.0, "starts": 0, "sim_seconds": 0.0})
            rt.update(seconds=0.0, starts=0, sim_seconds=0.0)
            done.append(i)
        self.hist.runtime_save(self.runtime)
        return done

    def equipment(self):
        out = []
        for e in self.store.equipment:
            st = self._equipment_state.get(e["id"], {"status": "UNKNOWN", "color": "grey", "since": None})
            rt = self.runtime.get(e["id"], {"seconds": 0, "starts": 0, "sim_seconds": 0})
            sim = self.mode == "simulation"
            out.append({"id": e["id"], "name": e["name"], "area": e.get("area", ""), "type": e.get("type", "motor"),
                        "tag_no": e.get("tag_no", ""), "kw": e.get("kw"), "starter": e.get("starter", ""),
                        "status": st["status"], "color": st["color"], "since": st.get("since"),
                        "run_hours": round((rt["sim_seconds"] if sim else rt["seconds"]) / 3600, 2),
                        "starts": rt["starts"], "simulated": sim})
        return out

    def active_alarms(self):
        rows = sorted(self._open_alarms.values(), key=lambda a: (a["priority"] != "red", -a["raised_at"]))
        tagmap = self.store.tag_map()
        return [dict(a, tag_name=tagmap.get(a["tag"], {}).get("name", "PLC communication" if a["tag"] == "_COMM" else a["tag"])) for a in rows]

    # -- admin: one-shot test read ---------------------------------------------------------------
    def test_read(self, tag: dict):
        """Read a single tag directly from the PLC using current settings (any mode)."""
        plc = self.store.settings["plc"]
        try:
            ma = config_store.resolve_tag(tag)
        except (delta_ah500.AddressError, codec.DecodeError) as e:
            return {"ok": False, "error": str(e)}
        dt = str(tag.get("data_type", "BOOL")).upper()
        n = 1 if ma.is_bit_table else codec.register_count(dt)
        c = ModbusTcpClient(*modbus_target(self.store.settings), plc["unit_id"], plc["timeout_ms"] / 1000.0)
        t0 = time.perf_counter()
        try:
            data = c.read(ma.function_code, ma.address, n)
        except (OSError, ModbusError) as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}", "mapping": ma.to_dict()}
        finally:
            c.close()
        res = {"ok": True, "mapping": ma.to_dict(), "latency_ms": round((time.perf_counter() - t0) * 1000, 1),
               "raw": [int(x) for x in data],
               "raw_hex": [f"0x{int(x):04X}" for x in data] if not ma.is_bit_table else None}
        try:
            if ma.is_bit_table:
                val = bool(data[0]) ^ bool(tag.get("invert"))
            else:
                wo = tag.get("word_order") or plc["default_word_order"]
                wo = plc["default_word_order"] if wo == "default" else wo
                raw = codec.decode_registers(data, dt, wo, ma.bit)
                res["decoded"] = raw
                if dt != "BOOL" and ma.bit is None:
                    res["decoded_other_word_order"] = _safe_decode(data, dt, "high_first" if wo == "low_first" else "low_first")
                val = (bool(raw) ^ bool(tag.get("invert"))) if (dt == "BOOL" or ma.bit is not None) else codec.apply_scaling(raw, tag.get("scaling"))
            res["value"] = val
        except codec.DecodeError as e:
            res["decode_error"] = str(e)
        return res


def _safe_decode(data, dt, wo):
    try:
        return codec.decode_registers(data, dt, wo)
    except codec.DecodeError as e:
        return f"error: {e}"
