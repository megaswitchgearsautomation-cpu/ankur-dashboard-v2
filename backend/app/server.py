"""HTTP server: static frontend + JSON API (standard library only)."""
from __future__ import annotations

import base64
import binascii
import json
import math
import mimetypes
import os
import re
import time
import traceback
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from datetime import datetime

from . import auth, codec, config_store, delta_ah500, iot_link, reports, tag_import, transfer
from .modbus_tcp import ModbusError, probe

MAX_BODY = 2 * 1024 * 1024
# the Windows registry can map .mjs / .js to text/plain - browsers refuse ES modules (3D plant, three.js) served that way
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/javascript", ".js")


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        server_version = "MedgeDash/1.0"

        def log_message(self, fmt, *args):  # quieter console
            if app.verbose:
                super().log_message(fmt, *args)

        # -- helpers ------------------------------------------------------------
        def _json(self, obj, status=200, extra_headers=None):
            body = json.dumps(obj, default=str).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            for k, v in (extra_headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _err(self, msg, status=400):
            self._json({"ok": False, "error": msg}, status)

        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                raise ValueError("Request too large")
            raw = self.rfile.read(n) if n else b"{}"
            return json.loads(raw.decode("utf-8") or "{}")

        def _token(self):
            c = cookies.SimpleCookie(self.headers.get("Cookie", ""))
            return c["sid"].value if "sid" in c else None

        def _role(self):
            return app.auth.role(self._token())

        def _is_admin(self):
            return self._role() == "admin"

        def _user(self):
            """Signed-in username - recorded with every acknowledgement / write / config change."""
            return app.auth.session(self._token())[1] or "?"

        def _redirect(self, where):
            self.send_response(302)
            self.send_header("Location", where)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def _same_origin(self):
            # basic CSRF guard for state-changing admin requests
            origin = self.headers.get("Origin")
            if not origin:
                return True
            host = self.headers.get("Host", "")
            return urlparse(origin).netloc == host

        def _static(self, path):
            # page gate: one login page; every role sees the dashboard, only admin the Settings (admin) page
            role = self._role()
            if path in ("/", "", "/index.html"):
                if role not in auth.DASHBOARD_ROLES:
                    return self._redirect("/login")
                path = "/index.html"
            elif path in ("/welcome", "/welcome/", "/welcome.html"):
                return self._redirect("/login")  # welcome screen removed (client request) - straight to login
            elif path in ("/admin", "/admin/", "/admin.html"):
                if role != "admin":
                    return self._redirect("/" if role else "/login")
                path = "/admin.html"
            elif path in ("/login", "/login/", "/login.html"):
                if role:
                    return self._redirect("/")
                path = "/login.html"
            elif path.endswith(".html"):
                return self.send_error(404)
            full = os.path.normpath(os.path.join(app.frontend_dir, path.lstrip("/")))
            if not full.startswith(os.path.normpath(app.frontend_dir)) or not os.path.isfile(full):
                self.send_error(404)
                return
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript",):
                ctype += "; charset=utf-8"
            with open(full, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)

        # -- routing ---------------------------------------------------------------
        def do_GET(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

        def do_PUT(self):
            self._dispatch("PUT")

        def _dispatch(self, method):
            u = urlparse(self.path)
            path, q = u.path, {k: v[-1] for k, v in parse_qs(u.query).items()}
            try:
                if not path.startswith("/api/"):
                    if method == "GET":
                        return self._static(path)
                    return self.send_error(405)
                if method != "GET" and not self._same_origin():
                    return self._err("Cross-origin request refused", 403)
                if path.startswith("/api/admin/"):
                    if not self._is_admin():
                        return self._err("Admin login required", 401)
                elif path.startswith("/api/client/") or path in CLIENT_ROUTES:
                    role = self._role()
                    if role not in auth.DASHBOARD_ROLES:
                        return self._err("Login required", 401)
                    # viewers are read-only: acknowledging, scaling and PLC writes need operator or admin
                    if method != "GET" and (method, path) in OPERATE_ROUTES and role not in auth.OPERATE_ROLES:
                        return self._err("Your account is view-only (viewer). Ask an operator or admin.", 403)
                route = ROUTES.get((method, path))
                if not route:
                    return self._err("Not found", 404)
                return route(self, q)
            except (ValueError, config_store.ConfigError, delta_ah500.AddressError, codec.DecodeError, reports.ReportError) as e:
                return self._err(str(e), 400)
            except Exception as e:
                traceback.print_exc()
                return self._err(f"Server error: {e}", 500)

        # -- public API --------------------------------------------------------------
        # The client (Ankur) dashboard is view-only: it never receives PLC, network, address or tag internals.
        def api_meta(self, q):
            s = app.store.settings
            self._json({"site": {k: s["site"].get(k, "") for k in ("name", "panel")}, "server_time": time.time(),
                        "timezone": s["display"]["timezone"], "rtd_group": s["rtd_group"], "shifts": s["shifts"],
                        "source_mode": s["source"]["mode"],
                        # v3: date pickers / exports are limited to the history actually kept (retention + oldest sample)
                        "history": {"retention_days": s["historian"]["retention_days"],
                                    "log_interval_s": s["historian"].get("log_interval_s"),
                                    "first_ts": app.historian.first_sample_ts()},
                        # v3: live value turns warning colour from this % of a high-limit alarm set point (red at/above it)
                        "warn_band_pct": float((s.get("display") or {}).get("warn_band_pct", 90))})

        # v3: per-user dashboard preferences (e.g. dashboard card order) - kept on the server for that user
        def _prefs_path(self):
            return os.path.join(app.data_dir, "user_prefs.json")

        def _prefs_all(self):
            try:
                with open(self._prefs_path(), encoding="utf-8") as f:
                    d = json.load(f)
                return d if isinstance(d, dict) else {}
            except (OSError, ValueError):
                return {}

        def api_client_prefs_get(self, q):
            self._json({"ok": True, "prefs": self._prefs_all().get(self._user(), {})})

        def api_client_prefs_put(self, q):
            b = self._body()
            prefs = b.get("prefs")
            if not isinstance(prefs, dict) or len(json.dumps(prefs)) > 20000:
                raise ValueError("Invalid preferences")
            allp = self._prefs_all()
            cur = allp.get(self._user(), {})
            cur.update({k: v for k, v in prefs.items() if k in ("card_order",)})
            allp[self._user()] = cur
            tmp = self._prefs_path() + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(allp, f, indent=1)
            os.replace(tmp, self._prefs_path())
            self._json({"ok": True, "prefs": cur})

        def api_live(self, q):
            self._json(live_payload(app))

        def api_client_devices(self, q):
            """Devices page: every measurement / signal with value, unit, time stamp, communication state and quality.
            comm: online | stale (not refreshed) | offline (read failed - value is the last known one) | config | waiting."""
            tmap = app.store.tag_map()
            # demo values are never reported as online
            comm_of = {"GOOD": "online", "SIMULATED": "demo", "STALE": "stale", "BAD": "offline", "CONFIG_ERROR": "config", "INIT": "waiting"}
            out = []
            for t in app.engine.live(include_hidden=True):
                cfg = tmap.get(t["id"]) or {}
                if t.get("group") in ("Scaling", "Level set points", "Alarm delays"):
                    continue                                    # PLC scaling registers / HMI set points have their own pages
                comm = comm_of.get(t.get("quality"), "waiting")
                out.append({"id": t["id"], "name": t["name"], "group": t.get("group", ""), "unit": t.get("unit", ""),
                            "decimals": t.get("decimals", 1), "data_type": t.get("data_type"), "states": t.get("states"),
                            "value": t.get("value") if comm != "waiting" else None, "ts": t.get("ts"),
                            "quality": client_tag(t)["quality"], "comm": comm, "simulated": t.get("simulated"),
                            "error": t.get("error") if comm in ("offline", "config") else None,
                            "address": cfg.get("device") or "", "source_id": cfg.get("source_id") or cfg.get("plc_tag") or "",
                            "description": cfg.get("description") or "", "eng_min": t.get("eng_min"), "eng_max": t.get("eng_max"),
                            "alarm": {k: (cfg.get("alarm") or {}).get(k) for k in ("enabled", "hihi", "hi", "lo", "lolo")},
                            "visible": cfg.get("show_on_dashboard", True), "trend": cfg.get("log", True)})
            self._json({"server_time": time.time(), "status": client_status(app.engine.connection()), "devices": out})

        def api_client_io(self, q):
            """Every PLC input / output, like the HMI IO list screens (IO DI 0-6, IO DO 0-3, IO AI): read-only."""
            tmap = app.store.tag_map()
            out = []
            for t in app.engine.live(include_hidden=True):
                tid, dev = t["id"], str(t.get("device") or "")
                desc = (tmap.get(tid) or {}).get("description") or ""
                m = re.search(r"\bAI (\d+)\.(\d+)", desc)
                if tid.startswith("DI_") and dev[:1] == "X":
                    kind, addr = "di", dev
                elif tid.startswith("DO_") and dev[:1] == "Y":
                    kind, addr = "do", dev
                elif m and t.get("group") in ("Temperature", "Pressure", "Level", "Analysis", "Spare") and not tid.endswith("_SP"):
                    kind, addr = "ai", f"AI {m.group(1)}.{m.group(2)}"
                else:
                    continue
                out.append({"id": tid, "kind": kind, "addr": addr, "name": t["name"], "desc": desc, "value": t.get("value"),
                            "unit": t.get("unit", ""), "decimals": t.get("decimals", 1), "quality": client_tag(t)["quality"],
                            # analog: range + scaling mode, so hidden channels (spares) can be scaled from the IO list too
                            **({"eng_min": t.get("eng_min"), "eng_max": t.get("eng_max"),
                                "scaling_mode": ((tmap.get(tid) or {}).get("scaling") or {}).get("mode", "none")} if kind == "ai" else {})})
            self._json({"server_time": time.time(), "io": out})

        # -- AI assistant (read-only: answers from the same data the client dashboard shows) ---------
        def api_ai_status(self, q):
            self._json(app.assistant.status())

        def api_ai_ask(self, q):
            b = self._body()
            if not app.assistant.rate_ok(self._token() or self.client_address[0]):
                return self._err("Too many questions - please wait a minute.", 429)
            live = live_payload(app)
            # last 24 h of alarms + recent set point / selector changes, so "what happened today" can be answered
            live["recent_alarms"] = [{"message": no_hmi_plc(a.get("message")), "priority": a.get("priority"),
                                      "raised_at": a.get("raised_at"), "cleared_at": a.get("cleared_at"),
                                      "acked_by": a.get("acked_by")}
                                     for a in app.historian.alarm_rows("raised_at >= ?", (time.time() - 86400,), 40)]
            live["recent_changes"] = [{"ts": ev["ts"], "detail": no_hmi_plc(ev["detail"])} for ev in app.historian.events(200)
                                      if ev["kind"] in ("write", "levels", "scaling")][:20]
            res = app.assistant.ask(str(b.get("question") or ""), b.get("history"), live)
            if res.get("ok"):
                app.historian.event("ai", f"question ({res.get('source')}): {str(b.get('question'))[:200]}")
            self._json(res, 200 if res.get("ok") else 502)

        def api_admin_ai_get(self, q):
            self._json(app.assistant.admin_settings())          # never contains the key itself

        def api_admin_ai_put(self, q):
            b = self._body()
            res = app.assistant.save_admin_settings(b)
            app.historian.event("settings", "Plant Assistant settings changed"
                                + (" (API key removed)" if b.get("clear_key") else " (API key updated)" if b.get("api_key") else ""))
            self._json(res)

        def api_admin_ai_test(self, q):
            self._json(app.assistant.test_connection())

        # -- WhatsApp alarm alerts (token write-only: never sent back to the browser) ------------------
        def api_admin_wa_get(self, q):
            self._json(app.whatsapp.public())

        def api_admin_wa_put(self, q):
            b = self._body()
            res = app.whatsapp.save(b)
            app.historian.event("settings", "WhatsApp alert settings changed"
                                + (" (token removed)" if b.get("clear_token") else " (token updated)" if b.get("access_token") else ""))
            self._json(res)

        def api_admin_wa_test(self, q):
            res = app.whatsapp.test(self._body().get("number") or None)
            self._json({"ok": all(r["ok"] for r in res), "results": res})

        def api_trend(self, q):
            ids = [x for x in q.get("tags", "").split(",") if x][:8]
            minutes = max(1, min(60 * 24 * 31, int(q.get("minutes", 60))))
            points = int(q.get("points", 300))
            # optional "to" (epoch seconds): look at a past window, e.g. a whole day two days ago; never in the future
            now = time.time()
            t_to = now
            if q.get("to"):
                t_to = max(now - 400 * 86400, min(now, float(q["to"])))
            t_from = t_to - minutes * 60
            if q.get("from"):                            # custom range (Trends page): from..to, at most 31 days
                t_from = float(q["from"])
                if t_from >= t_to:
                    raise ValueError("'From' must be before 'To'")
                if t_to - t_from > 31 * 86400:
                    raise ValueError("Maximum trend range is 31 days")
            tagmap = app.store.tag_map()
            series = []
            for tid in ids:
                t = tagmap.get(tid)
                # any logged process / signal tag can be trended (Devices page shows them all); internal registers cannot
                if not t or t.get("trend") is False or t.get("log") is False or t.get("group") in ("Scaling", "Level set points", "Alarm delays"):
                    continue
                series.append({"id": tid, "name": t["name"], "unit": t.get("unit", ""), "data_type": t["data_type"],
                               "decimals": t.get("decimals", 1),
                               "points": app.historian.trend(tid, t_from, t_to, points)})
            self._json({"from": t_from, "to": t_to, "series": series})

        def api_alarms(self, q):
            state = q.get("state", "history")
            limit = int(q.get("limit", 200))
            tagmap = app.store.tag_map()
            if state == "active":
                rows = app.engine.active_alarms()
            else:
                hours = float(q.get("hours", 72))
                rows = app.historian.alarm_rows("raised_at >= ?", (time.time() - hours * 3600,), limit)
                for r in rows:
                    r["tag_name"] = tagmap.get(r["tag"], {}).get("name", "Data connection" if r["tag"] == "_COMM" else r["tag"])
            self._json({"alarms": [client_alarm(a) for a in rows]})

        # -- client reports ------------------------------------------------------------------
        def _history_limits(self):
            """(oldest usable time, retention days): history kept = retention setting, and never before the oldest sample."""
            ret = int(app.store.settings["historian"]["retention_days"])
            first = app.historian.first_sample_ts()
            return max(time.time() - ret * 86400, first or 0), ret

        def _report(self, q):
            """Data log (Reports page): from / to (epoch s), interval (s), tags (comma list), optional title."""
            try:
                t_from, t_to = float(q["from"]), float(q["to"])
                interval = int(q.get("interval", 900))
            except (KeyError, ValueError):
                raise reports.ReportError("from, to and interval are required")
            ids = [x for x in q.get("tags", "").split(",") if x]
            hs, ret = self._history_limits()
            t_from, note = reports.limit_to_history(t_from, t_to, hs, ret)
            title = re.sub(r"[^\w &()/.,-]+", "", str(q.get("title") or ""))[:60].strip() or None
            return reports.build(app.store, app.historian, ids, t_from, t_to, interval, title, note)

        def api_report_tags(self, q):
            self._json({"tags": [{"id": t["id"], "name": t["name"], "group": t.get("group", ""), "unit": t.get("unit", "")}
                                 for t in reports.reportable_tags(app.store)],
                        "intervals": [{"s": s, "label": l} for s, l in reports.INTERVALS.items()],
                        "max_days": reports.MAX_DAYS, "max_rows": reports.MAX_ROWS})

        def api_report(self, q):
            self._json(self._report(q))

        def _period(self, q):
            """Reports page (v3): kind=daily|weekly|monthly|custom, from=YYYY-MM-DD, to=YYYY-MM-DD (IST days, 'to' inclusive).
            Legacy: kind=daily|shift|weekly|monthly, date=YYYY-MM-DD, shift=<name> (shift is no longer offered in the UI).
            The window is limited to the history actually kept (retention setting + oldest stored sample)."""
            live = {t["id"]: t.get("value") for t in app.engine.live(include_hidden=True) if t["id"].endswith("_ALM_SP")}
            hs, ret = self._history_limits()
            if q.get("from") or q.get("to"):
                kind = q.get("kind", "custom")
                window = reports.range_window(kind, q.get("from", ""), q.get("to", ""))
                return reports.period_report(app.store, app.historian, kind, None, None, live, window=window,
                                             history_start=hs, retention_days=ret)
            return reports.period_report(app.store, app.historian, q.get("kind", "daily"), q.get("date", ""), q.get("shift"), live,
                                         history_start=hs, retention_days=ret)

        def api_report_period(self, q):
            self._json(self._period(q))

        def api_report_period_xlsx(self, q):
            rep = self._period(q)
            self._download(reports.period_xlsx(rep), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                           reports.period_filename(rep, "xlsx"))

        def api_report_period_csv(self, q):
            rep = self._period(q)
            self._download(reports.period_csv(rep), "text/csv; charset=utf-8", reports.period_filename(rep, "csv"))

        def api_report_csv(self, q):
            rep = self._report(q)
            self._download(reports.to_csv(rep), "text/csv; charset=utf-8", reports.filename(rep, "csv"))

        def api_transfer(self, q):
            """Tank totalizer (all LT tanks): kind=daily|shift (date=YYYY-MM-DD, shift=<name>) or month (date=YYYY-MM), IST."""
            kind = q.get("kind", "daily")
            if kind == "month":
                m = re.match(r"^(\d{4})-(\d{2})$", q.get("date", ""))
                if not m or not 1 <= int(m.group(2)) <= 12:
                    raise ValueError("Month must be YYYY-MM")
                y, mo = int(m.group(1)), int(m.group(2))
                t0 = datetime(y, mo, 1, tzinfo=reports.IST).timestamp()
                t1 = datetime(y + (mo == 12), mo % 12 + 1, 1, tzinfo=reports.IST).timestamp()
                title = f"Tank totalizer {y}-{mo:02d}"
            else:
                title, t0, t1 = reports.period_window(kind, q.get("date", ""), q.get("shift"), app.store.settings.get("shifts") or [])
                title = title.replace("report", "tank totalizer")
            if t0 >= time.time():
                raise ValueError("That period has not started yet")
            r = transfer.transfer_report(app.store, app.historian, t0, t1)
            r["title"], r["complete"] = title, t1 <= time.time()
            self._json(r)

        def _download(self, data, ctype, name):
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Disposition", f'attachment; filename="{name}"')
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def api_report_xlsx(self, q):
            rep = self._report(q)
            self._download(reports.to_xlsx(rep), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                           reports.filename(rep, "xlsx"))

        def api_report_pdf(self, q):
            rep = self._report(q)
            self._download(reports.to_pdf(rep), "application/pdf", reports.filename(rep, "pdf"))

        def api_client_ack(self, q):
            """Client acknowledges the alarm pop-up (recorded in the alarm journal; nothing is written to the PLC)."""
            b = self._body()
            ids = b.get("ids") or []
            raw_notes = b.get("notes") or {}
            if not isinstance(ids, list) or not ids or not isinstance(raw_notes, dict):
                raise ValueError("No alarms to acknowledge")
            active = {a["id"]: a for a in app.engine.active_alarms()}
            user = self._user()
            now = time.time()
            done, saved = [], 0
            for i in ids[:200]:
                i = int(i)
                a = active.get(i)
                if not a:
                    continue
                note = " ".join(str(raw_notes.get(str(i), "")).split())[:500]   # single line, max 500 chars
                if app.engine.ack_alarm(i, user, note):
                    done.append(i)
                    if note:
                        app.historian.add_alarm_note(a["tag"], a["kind"], i, note, user, now)
                        saved += 1
            if done:
                app.historian.event("alarm_ack", f"{user} acknowledged {len(done)} alarm(s), {saved} note(s)")
            self._json({"ok": True, "acknowledged": done, "notes_saved": saved})

        def api_client_scaling(self, q):
            """Change how the dashboard scales one analog input (range + source). Dashboard config only:
            nothing is written to the PLC. 'plc' = use the PLC's scaled value; 'signal' = compute it from 4-20 mA."""
            b = self._body()
            tid = str(b.get("id") or "")
            tags = [dict(t) for t in app.store.tags]
            t = next((x for x in tags if x["id"] == tid and x.get("group") in SCALABLE_GROUPS), None)
            if not t:
                raise ValueError("Unknown instrument")
            try:
                lo, hi = float(b["range_min"]), float(b["range_max"])
                dec = int(b.get("decimals", t.get("decimals", 1)))
            except (KeyError, TypeError, ValueError):
                raise ValueError("Range min and max must be numbers")
            if hi <= lo:
                raise ValueError("Range max must be greater than range min")
            if not 0 <= dec <= 4:
                raise ValueError("Decimals must be 0..4")
            source = b.get("source", "plc")
            if source == "signal" and not any(x["id"] == f"{tid}_MA" for x in tags):
                raise ValueError("This instrument has no 4-20 mA signal tag")
            # optional HH / H / L / LL level set points (dashboard indication only, level instruments)
            if b.get("levels") is not None:
                if t.get("group") != "Level":
                    raise ValueError("HH / H / L / LL can only be set for level instruments")
                t["levels"] = check_levels(b.get("levels"), lo, hi)
            old = (t.get("eng_min"), t.get("eng_max"), (t.get("scaling") or {}).get("mode", "none"))
            t["eng_min"], t["eng_max"], t["decimals"] = lo, hi, dec
            t["scaling"] = {"mode": "signal", "eng_min": lo, "eng_max": hi} if source == "signal" else {"mode": "none"}
            for x in tags:                                  # keep the 4-20 mA companion's display range in step
                if x.get("scale_of") == tid and x.get("scale_role") in ("min", "max"):
                    x["eng_min"], x["eng_max"] = lo, hi
            app.store.save_tags(tags)
            user = self._user()
            app.historian.event("scaling", f"{user} changed {tid} scaling {old} -> ({lo}, {hi}, {t['scaling']['mode']})")
            self._json({"ok": True})

        def api_client_levels(self, q):
            """Save the HH / H / L / LL set points of one level transmitter (Tank levels page). Dashboard only."""
            b = self._body()
            tid = str(b.get("id") or "")
            tags = [dict(t) for t in app.store.tags]
            t = next((x for x in tags if x["id"] == tid and x.get("group") == "Level"), None)
            if not t:
                raise ValueError("Unknown level instrument")
            lo, hi = float(t.get("eng_min") or 0), float(t.get("eng_max") or 100)
            old = t.get("levels")
            t["levels"] = check_levels(b.get("levels"), lo, hi)
            app.store.save_tags(tags)
            user = self._user()
            app.historian.event("levels", f"{user} changed {tid} set points {old} -> {t['levels']}")
            self._json({"ok": True, "levels": t["levels"]})

        def api_client_write(self, q):
            """Write one HMI level set point / set delay to the PLC (Tank levels page). Only tags marked
            "writable"; set points must keep LL < L < H < HH. The value read back from the PLC is returned."""
            b = self._body()
            tid = str(b.get("id") or "")
            tmap = app.store.tag_map()
            t = tmap.get(tid)
            if not t or not t.get("writable"):
                raise ValueError("This value cannot be changed from the dashboard")
            if t.get("data_type") == "BOOL":            # HMI soft selector (M bit): ON / OFF
                if not isinstance(b.get("value"), bool):
                    raise ValueError("Selector value must be true (ON) or false (OFF)")
                cur = next((x.get("value") for x in app.engine.live(include_hidden=True) if x["id"] == tid), None)
                if cur is None:
                    raise ValueError("No state read from the plant yet - cannot switch the selector")
                res = app.engine.write_value(tid, b["value"])
                states = t.get("states") or {}
                txt = lambda v: states.get(str(v).lower(), "ON" if v else "OFF")  # noqa: E731
                app.historian.event("write", f"{self._user()} switched {tid} ({t['name']}): {txt(cur)} -> {txt(res['value'])}"
                                    + (" [demo]" if res.get("simulated") else f" at {t.get('device')}"))
                return self._json({"ok": True, **res})
            try:
                value = float(b["value"])
            except (KeyError, TypeError, ValueError):
                raise ValueError("Enter a number")
            if t.get("level_of"):                       # keep the four set points in order
                cur = {tmap[x["id"]]["level_key"]: x["value"] for x in app.engine.live(include_hidden=True)
                       if tmap.get(x["id"], {}).get("level_of") == t["level_of"] and isinstance(x.get("value"), (int, float))}
                cur[t["level_key"]] = value
                if all(k in cur for k in ("hh", "h", "l", "ll")) and not cur["ll"] < cur["l"] < cur["h"] < cur["hh"]:
                    raise ValueError("Set points must stay in order LL < L < H < HH")
            # pairs that must stay apart, e.g. sludge pump start level above its stop level
            cur_of = {x["id"]: x.get("value") for x in app.engine.live(include_hidden=True)}
            err = implausible_current(t, cur_of.get(tid))
            if err:
                raise ValueError(err)
            for key, ok, word in (("above", lambda o: value > o, "above"), ("below", lambda o: value < o, "below")):
                other = t.get(f"must_be_{key}")
                ov = cur_of.get(other) if other else None
                if isinstance(ov, (int, float)) and not ok(ov):
                    unit = f" {t.get('unit')}" if t.get("unit") else ""
                    raise ValueError(f"Must stay {word} {tmap.get(other, {}).get('name', other)} ({ov:g}{unit})")
            old = cur_of.get(tid)
            res = app.engine.write_value(tid, value)
            user = self._user()
            app.historian.event("write", f"{user} wrote {tid} ({t['name']}): {old} -> {res['value']}"
                                + (" [demo]" if res.get("simulated") else f" to {t.get('device')}"))
            self._json({"ok": True, **res})

        def api_alarm_ack(self, q):   # admin only (client dashboard is view-only)
            b = self._body()
            user = str(b.get("user") or "operator")[:40]
            note = str(b.get("note") or "")[:200]
            ok = app.engine.ack_alarm(int(b["id"]), user, note)
            self._json({"ok": ok})

        # -- login (shared by both roles) ----------------------------------------------------
        def api_login(self, q):
            b = self._body()
            token, role, err = app.auth.login(b.get("username", ""), b.get("password", ""), self.client_address[0])
            if err:
                return self._err(err, 401)
            app.historian.event("login", f"{role} signed in from {self.client_address[0]}")
            c = f"sid={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800"
            self._json({"ok": True, "role": role, "home": "/"}, extra_headers={"Set-Cookie": c})

        def api_logout(self, q):
            role = self._role()
            app.auth.logout(self._token())
            if role:
                app.historian.event("login", f"{role} signed out")
            self._json({"ok": True}, extra_headers={"Set-Cookie": "sid=; Path=/; Max-Age=0"})

        def api_whoami(self, q):
            role, user = app.auth.session(self._token())
            if not role:
                return self._err("Login required", 401)
            builtin = user == app.store.settings["admin"].get("username") or user == (app.store.settings.get("client") or {}).get("username")
            self._json({"ok": True, "role": role, "username": user, "can_operate": role in auth.OPERATE_ROLES,
                        "can_configure": role == "admin", "must_change": app.auth.must_change(role) if builtin else False,
                        "timezone": app.store.settings["display"]["timezone"]})

        def api_users(self, q):
            self._json({"users": app.auth.users()})

        def api_user_save(self, q):
            b = self._body()
            err = (app.auth.delete_user(b.get("username")) if b.get("delete")
                   else app.auth.save_user(b.get("username"), b.get("role"), b.get("password") or None))
            if err:
                return self._err(err)
            app.historian.event("config", f"{self._user()} {'deleted' if b.get('delete') else 'saved'} user {b.get('username')}")
            self._json({"ok": True, "users": app.auth.users()})

        def api_session(self, q):
            self._json({"ok": True, "must_change": app.auth.must_change("admin"),
                        "client_username": app.store.settings["client"].get("username"),
                        "client_must_change": app.auth.must_change("client")})

        def api_password(self, q):
            b = self._body()
            err = app.auth.change_password(b.get("old", ""), b.get("new", ""), "admin")
            if err:
                return self._err(err)
            self._json({"ok": True}, extra_headers={"Set-Cookie": "sid=; Path=/; Max-Age=0"})

        def api_client_login(self, q):
            b = self._body()
            err = app.auth.set_client_login(b.get("username", ""), b.get("password", ""))
            if err:
                return self._err(err)
            app.historian.event("config", "client login changed (client signed out)")
            self._json({"ok": True, "client_username": app.store.settings["client"].get("username")})

        def api_get_settings(self, q):
            self._json({"settings": app.store.public_settings()})

        def api_put_settings(self, q):
            b = self._body().get("settings", {})
            b.pop("admin", None)
            b.pop("client", None)
            b.pop("users", None)                         # accounts only through /api/admin/users
            ga = b.get("gateway_api") or {}
            ga.pop("has_auth_value", None)
            if not ga.get("auth_value"):
                ga.pop("auth_value", None)               # blank field = keep the stored API key
            src = b.get("source") or {}
            cur = app.store.settings["source"]
            if src.get("comm_verified") and not cur.get("comm_verified"):
                src["verified_at"] = time.time()
                if not str(src.get("verified_by", "")).strip():
                    return self._err("Enter who verified the PLC communication")
            if src.get("comm_verified") is False:
                src["verified_at"] = None
            iot = b.get("iot") or {}
            iot.pop("has_token_secret", None)
            if not iot.get("service_token_secret"):
                iot.pop("service_token_secret", None)   # blank field = keep the stored secret
            app.store.save_settings(b)
            app.historian.event("config", "settings saved")
            self._json({"ok": True, "settings": app.store.public_settings()})

        def api_get_tags(self, q):
            s = app.store.settings
            out = []
            for t in app.store.tags:
                try:
                    ma = config_store.resolve_tag(t).to_dict()
                except (delta_ah500.AddressError, codec.DecodeError) as e:
                    ma = {"error": str(e)}
                out.append({"tag": t, "mapping": ma, "warnings": config_store.tag_warnings(t, s)})
            self._json({"tags": out, "data_types": list(codec.DATA_TYPES), "word_orders": list(codec.WORD_ORDERS)})

        def api_put_tags(self, q):
            tags = self._body().get("tags")
            app.store.save_tags(tags)
            app.historian.event("config", f"tags saved ({len(tags)})")
            self._json({"ok": True, "count": len(tags)})

        def api_get_equipment(self, q):
            self._json({"equipment": app.store.equipment})

        def api_put_equipment(self, q):
            eq = self._body().get("equipment")
            app.store.save_equipment(eq)
            app.historian.event("config", f"equipment saved ({len(eq)})")
            self._json({"ok": True})

        def api_resolve(self, q):
            b = self._body()
            tag = b.get("tag") or {}
            try:
                ma = config_store.resolve_tag(tag)
            except (delta_ah500.AddressError, codec.DecodeError) as e:
                return self._json({"ok": False, "error": str(e)})
            self._json({"ok": True, "mapping": ma.to_dict(),
                        "warnings": config_store.tag_warnings(tag, app.store.settings)})

        def api_tags_import_preview(self, q):
            # body: {"filename": "...xlsx", "data_b64": "..."} -> proposed address changes (nothing is saved)
            b = self._body()
            try:
                data = base64.b64decode(b.get("data_b64") or "", validate=True)
            except (binascii.Error, ValueError):
                raise ValueError("File data is not valid base64")
            if not data:
                raise ValueError("Empty file")
            res = tag_import.preview(app.store, str(b.get("filename") or ""), data)
            app.historian.event("config", f"address import preview {b.get('filename')}: {res['counts']}")
            self._json(res)

        def api_tags_template(self, q):
            self._download(tag_import.template_xlsx(app.store),
                           "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                           f"tag_addresses_{time.strftime('%Y-%m-%d')}.xlsx")

        def api_test_read(self, q):
            tag = self._body().get("tag") or {}
            res = app.engine.test_read(tag)
            app.historian.event("test_read", f"{tag.get('id')} {tag.get('device')} ok={res.get('ok')}")
            self._json(res)

        def api_test_connection(self, q):
            s = app.store.settings
            plc = s["plc"]
            b = self._body()
            host = b.get("host") or plc["host"]
            port = int(b.get("port") or plc["port"])
            unit = int(b.get("unit_id") if b.get("unit_id") not in (None, "") else plc["unit_id"])
            if s["iot"].get("enabled"):   # through the saved IoT link: its local end, once comlink listens
                host, port = iot_link.modbus_target(s)
                app.engine.iot.ensure(s)
                if not app.engine.iot.wait_listening(port, 6.0):
                    st = app.engine.iot.status(s)
                    return self._json({"ok": False, "error": f"IoT link not listening on {host}:{port}. "
                                       + (st["last_error"] or "comlink started - see its log below"), "iot": st})
            try:
                res = probe(host, port, unit, plc["timeout_ms"] / 1000.0)
            except (OSError, ModbusError) as e:
                res = {"ok": False, "error": f"{type(e).__name__}: {e}"}
            app.historian.event("test_connection", f"{host}:{port} unit {unit} ok={res.get('ok')}")
            res["target"] = f"{host}:{port}"
            self._json(res)

        def api_iot_check(self, q):
            key = self._body().get("access_key") or app.store.settings["iot"].get("access_key")
            res = iot_link.check_key(key)
            app.historian.event("iot_check", f"{iot_link.normalize_key(key)} -> {res.get('verdict')}")
            self._json(res)

        def api_events(self, q):
            self._json({"events": app.historian.events(int(q.get("limit", 100)))})

        def api_status(self, q):
            e = app.engine
            self._json({"connection": e.connection(), "tags": e.live(include_hidden=True), "equipment": e.equipment()})

        def api_reset_runtime(self, q):
            # body: {"ids": ["OP_P1A", ...]} or {"ids": "all"} -> run hours + starts back to 0
            b = self._body()
            motors = [x["id"] for x in app.store.equipment if x.get("type", "motor") == "motor"]
            ids = motors if b.get("ids") == "all" else [i for i in (b.get("ids") or []) if i in motors]
            if not ids:
                raise ValueError("No motor selected")
            done = app.engine.reset_runtime(ids)
            app.historian.event("config", f"run hours reset: {'all motors' if b.get('ids') == 'all' else ', '.join(done)}")
            self._json({"ok": True, "reset": done})

    ROUTES = {
        ("GET", "/api/meta"): Handler.api_meta,
        ("GET", "/api/live"): Handler.api_live,
        ("GET", "/api/trend"): Handler.api_trend,
        ("GET", "/api/alarms"): Handler.api_alarms,
        ("POST", "/api/client/alarms/ack"): Handler.api_client_ack,
        ("POST", "/api/client/scaling"): Handler.api_client_scaling,
        ("POST", "/api/client/levels"): Handler.api_client_levels,
        ("POST", "/api/client/write"): Handler.api_client_write,
        ("GET", "/api/client/io"): Handler.api_client_io,
        ("GET", "/api/client/devices"): Handler.api_client_devices,
        ("GET", "/api/client/prefs"): Handler.api_client_prefs_get,
        ("PUT", "/api/client/prefs"): Handler.api_client_prefs_put,
        ("GET", "/api/client/ai/status"): Handler.api_ai_status,
        ("POST", "/api/client/ai/ask"): Handler.api_ai_ask,
        ("GET", "/api/report/tags"): Handler.api_report_tags,
        ("GET", "/api/report"): Handler.api_report,
        ("GET", "/api/report/period"): Handler.api_report_period,
        ("GET", "/api/report/period.xlsx"): Handler.api_report_period_xlsx,
        ("GET", "/api/report/period.csv"): Handler.api_report_period_csv,
        ("GET", "/api/transfer"): Handler.api_transfer,
        ("GET", "/api/report.xlsx"): Handler.api_report_xlsx,
        ("GET", "/api/report.csv"): Handler.api_report_csv,
        ("GET", "/api/report.pdf"): Handler.api_report_pdf,
        ("POST", "/api/admin/alarms/ack"): Handler.api_alarm_ack,
        ("POST", "/api/login"): Handler.api_login,
        ("POST", "/api/logout"): Handler.api_logout,
        ("GET", "/api/whoami"): Handler.api_whoami,
        ("GET", "/api/admin/session"): Handler.api_session,
        ("POST", "/api/admin/password"): Handler.api_password,
        ("POST", "/api/admin/client-login"): Handler.api_client_login,
        ("GET", "/api/admin/ai"): Handler.api_admin_ai_get,
        ("PUT", "/api/admin/ai"): Handler.api_admin_ai_put,
        ("POST", "/api/admin/ai/test"): Handler.api_admin_ai_test,
        ("GET", "/api/admin/whatsapp"): Handler.api_admin_wa_get,
        ("PUT", "/api/admin/whatsapp"): Handler.api_admin_wa_put,
        ("POST", "/api/admin/whatsapp/test"): Handler.api_admin_wa_test,
        ("GET", "/api/admin/users"): Handler.api_users,
        ("POST", "/api/admin/users"): Handler.api_user_save,
        ("GET", "/api/admin/settings"): Handler.api_get_settings,
        ("PUT", "/api/admin/settings"): Handler.api_put_settings,
        ("GET", "/api/admin/tags"): Handler.api_get_tags,
        ("PUT", "/api/admin/tags"): Handler.api_put_tags,
        ("GET", "/api/admin/equipment"): Handler.api_get_equipment,
        ("PUT", "/api/admin/equipment"): Handler.api_put_equipment,
        ("POST", "/api/admin/equipment/reset-runtime"): Handler.api_reset_runtime,
        ("POST", "/api/admin/resolve"): Handler.api_resolve,
        ("POST", "/api/admin/tags/import-preview"): Handler.api_tags_import_preview,
        ("GET", "/api/admin/tags/template.xlsx"): Handler.api_tags_template,
        ("POST", "/api/admin/test-read"): Handler.api_test_read,
        ("POST", "/api/admin/test-connection"): Handler.api_test_connection,
        ("POST", "/api/admin/iot/check"): Handler.api_iot_check,
        ("GET", "/api/admin/events"): Handler.api_events,
        ("GET", "/api/admin/status"): Handler.api_status,
    }
    return Handler


# state-changing dashboard calls: operator or admin only (viewers get 403 on the server)
OPERATE_ROUTES = {("POST", "/api/client/alarms/ack"), ("POST", "/api/client/scaling"), ("POST", "/api/client/levels"),
                  ("POST", "/api/client/write")}

# dashboard data feeds - require any dashboard login (admin, operator or viewer)
CLIENT_ROUTES = {"/api/meta", "/api/live", "/api/trend", "/api/alarms", "/api/report/period", "/api/report/period.xlsx", "/api/transfer",
                 "/api/report/tags", "/api/report", "/api/report.xlsx", "/api/report.pdf",
                 "/api/report/period.csv", "/api/report.csv"}


# ---------------------------------------------------------------------------------------------
# Client (view-only) projections - strip PLC / network / address / diagnostic details.
# ---------------------------------------------------------------------------------------------
def live_payload(app):
    """The client dashboard's live view (/api/live) - also the data the AI assistant answers from."""
    e = app.engine
    active = e.active_alarms()
    # previous operator notes for the same alarm source (tag + alarm type) - shown in the pop-up
    notes = app.historian.alarm_notes([(a["tag"], a["kind"]) for a in active if not a.get("acked_at")], per_key=5)
    alarms = []
    for a in active:
        c = client_alarm(a)
        c["previous_notes"] = notes.get((a["tag"], a["kind"]), [])
        alarms.append(c)
    hidden_eq = {q["id"] for q in app.store.equipment if q.get("show_on_dashboard") is False}
    tmap = app.store.tag_map()
    return {"server_time": time.time(), "status": client_status(e.connection()),
            "tags": [client_tag(t) for t in e.live()],
            # equipment with "show_on_dashboard": false (e.g. spare starters) is not sent to the client
            "equipment": [client_equipment(x) for x in e.equipment() if x.get("id") not in hidden_eq],
            "alarms": alarms,
            # plant states for the mimic / instruments pages (level switches, valve limits, air, flow,
            # PLC scaling block) - values only, keyed by tag id
            "aux": {t["id"]: {"value": t["value"], "quality": client_tag(t)["quality"], "name": t["name"],
                              "states": tmap.get(t["id"], {}).get("states"),
                              "group": t["group"], "unit": t.get("unit", ""), "decimals": t.get("decimals", 1),
                              "writable": bool(tmap.get(t["id"], {}).get("writable")),
                              "eng_min": t.get("eng_min"), "eng_max": t.get("eng_max"),
                              "write_min": tmap.get(t["id"], {}).get("write_min", t.get("eng_min")),
                              "write_max": tmap.get(t["id"], {}).get("write_max", t.get("eng_max"))}
                    for t in e.live(include_hidden=True)
                    if t["group"] in CLIENT_AUX_GROUPS or t["id"].endswith("_ALM_SP")}}


def client_status(c):
    if c["mode"] == "simulation":
        state = "demo"
    elif c["state"] == "DISCONNECTED":
        state = "offline"
    elif c["state"] == "CONNECTED":
        state = "live"
    else:
        state = "starting"
    return {"state": state, "validated": bool(c.get("comm_verified")), "last_update": c.get("last_update")}


def implausible_current(t, cur):
    """Safety check before writing a set point: the value now read from the PLC must look sane. A register read
    with the wrong data type (e.g. a DWORD x10 read as REAL) decodes to garbage - a tiny number like 1e-42, NaN or
    far outside the range - and writing in that same wrong type would put a wrong value into the PLC."""
    if cur is None:
        return "No value read from the plant yet - cannot check the set point before writing"
    if isinstance(cur, bool) or not isinstance(cur, (int, float)) or not math.isfinite(cur):
        return f"The value read from the plant ({cur!r}) is not a number - data type probably wrong; not writing"
    if 0 < abs(cur) < 1e-6:
        return (f"The value read from the plant ({cur:.3g}) looks like a wrong data type (e.g. integer read as REAL) - "
                "not writing. Check the type on the HMI and correct it in Settings > Tags.")
    lo, hi = t.get("write_min", t.get("eng_min")), t.get("write_max", t.get("eng_max"))
    span = (float(hi) - float(lo)) if lo is not None and hi is not None else None
    if span and not (float(lo) - span <= cur <= float(hi) + span):
        return (f"The value read from the plant ({cur:g}) is far outside {lo:g}…{hi:g} {t.get('unit', '')} - data type or "
                "address probably wrong; not writing. Check it against the HMI.").replace("  ", " ")
    return None


def check_levels(lv, lo, hi):
    """HH / H / L / LL level set points: all numbers, LL < L < H < HH, inside the instrument range."""
    if not isinstance(lv, dict):
        raise ValueError("HH, H, L and LL are required")
    try:
        lv = {k: float(lv[k]) for k in ("hh", "h", "l", "ll")}
    except (KeyError, TypeError, ValueError):
        raise ValueError("HH, H, L and LL must all be numbers")
    if not lo <= lv["ll"] < lv["l"] < lv["h"] < lv["hh"] <= hi:
        raise ValueError(f"Levels must be in order LL < L < H < HH, between {lo:g} and {hi:g}")
    return lv


CLIENT_AUX_GROUPS = ("Level switches", "Valve feedback", "Interlocks", "Panel controls", "Scaling", "Set values", "Level set points", "Alarm delays",
                     "Motor feedback", "Outputs", "Safety", "Panel indication", "PLC alarms", "Selectors")
# analog inputs whose scaling the client may change on the dashboard (dashboard-side only, never written to the PLC)
SCALABLE_GROUPS = ("Temperature", "Pressure", "Level", "Analysis", "Spare")   # spares: scaled before they are put to use

_TAG_FIELDS = ("id", "name", "group", "unit", "decimals", "data_type", "value", "ts", "simulated", "verified",
               "states", "eng_min", "eng_max", "setpoint_value", "trend", "kpi", "trend_min", "trend_max", "scaling_mode", "levels")


def client_tag(t):
    out = {k: t.get(k) for k in _TAG_FIELDS}
    q = t.get("quality")
    out["quality"] = "SIMULATED" if q == "SIMULATED" else ("GOOD" if q == "GOOD" else ("STALE" if q in ("STALE", "INIT") else "NODATA"))
    out["alarm"] = t.get("alarm")
    return out


def client_equipment(e):
    return {k: e.get(k) for k in ("id", "name", "area", "type", "tag_no", "kw", "status", "color", "since",
                                  "run_hours", "starts", "simulated", "auto", "standby_selected", "pair", "io")}


alarm_source = reports.alarm_source


def client_alarm(a):
    comm = a.get("tag") == "_COMM"
    return {"id": a.get("id"), "tag": a.get("tag"), "priority": a.get("priority"), "source": alarm_source(a),
            "kind": a.get("kind"),
            # older history rows keep the text they were raised with: no "PLC" / "HMI" on the client dashboard
            "message": "Data connection to plant lost" if comm else no_hmi_plc(a.get("message")),
            "tag_name": "Data connection" if comm else no_hmi_plc(a.get("tag_name")),
            "simulated": a.get("simulated"), "raised_at": a.get("raised_at"), "cleared_at": a.get("cleared_at"),
            "acked_at": a.get("acked_at"), "acked_by": a.get("acked_by"), "note": a.get("ack_note") or ""}


no_hmi_plc = reports.no_hmi_plc


def serve(app, host, port):
    httpd = ThreadingHTTPServer((host, port), make_handler(app))
    httpd.daemon_threads = True
    return httpd
