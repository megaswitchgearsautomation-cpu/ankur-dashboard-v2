"""HTTP server: static frontend + JSON API (standard library only)."""
from __future__ import annotations

import base64
import binascii
import json
import mimetypes
import os
import time
import traceback
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import codec, config_store, delta_ah500, iot_link, reports, tag_import
from .modbus_tcp import ModbusError, probe

MAX_BODY = 2 * 1024 * 1024


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
            # page gate: one login page, each role sees only its own page
            home = {"admin": "/admin", "client": "/"}
            role = self._role()
            if path in ("/", "", "/index.html"):
                if role != "client":
                    return self._redirect("/admin" if role == "admin" else "/login")
                path = "/index.html"
            elif path in ("/welcome", "/welcome/", "/welcome.html"):
                return self._redirect("/login")  # welcome screen removed (client request) - straight to login
            elif path in ("/admin", "/admin/", "/admin.html"):
                if role != "admin":
                    return self._redirect("/" if role == "client" else "/login")
                path = "/admin.html"
            elif path in ("/login", "/login/", "/login.html"):
                if role:
                    return self._redirect(home[role])
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
                    if self._role() != "client":
                        return self._err("Login required", 401)
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
            self._json({"site": {k: s["site"].get(k, "") for k in ("name", "panel")}, "server_time": time.time()})

        def api_live(self, q):
            e = app.engine
            active = e.active_alarms()
            # previous operator notes for the same alarm source (tag + alarm type) - shown in the pop-up
            notes = app.historian.alarm_notes([(a["tag"], a["kind"]) for a in active if not a.get("acked_at")], per_key=5)
            alarms = []
            for a in active:
                c = client_alarm(a)
                c["previous_notes"] = notes.get((a["tag"], a["kind"]), [])
                alarms.append(c)
            self._json({"server_time": time.time(), "status": client_status(e.connection()),
                        "tags": [client_tag(t) for t in e.live()],
                        # equipment with "show_on_dashboard": false (e.g. spare starters) is not sent to the client
                        "equipment": [client_equipment(x) for x in e.equipment()
                                      if x.get("id") not in {q["id"] for q in app.store.equipment if q.get("show_on_dashboard") is False}],
                        "alarms": alarms})

        def api_trend(self, q):
            ids = [x for x in q.get("tags", "").split(",") if x][:8]
            minutes = max(1, min(60 * 24 * 31, int(q.get("minutes", 60))))
            points = int(q.get("points", 300))
            t_to = time.time()
            t_from = t_to - minutes * 60
            tagmap = app.store.tag_map()
            series = []
            for tid in ids:
                t = tagmap.get(tid)
                # clients may only trend what is published on their dashboard
                if not t or not (t.get("show_on_dashboard", True) and t.get("trend", True)):
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
        def _report(self, q):
            try:
                t_from, t_to = float(q["from"]), float(q["to"])
                interval = int(q.get("interval", 900))
            except (KeyError, ValueError):
                raise reports.ReportError("from, to and interval are required")
            ids = [x for x in q.get("tags", "").split(",") if x]
            return reports.build(app.store, app.historian, ids, t_from, t_to, interval)

        def api_report_tags(self, q):
            self._json({"tags": [{"id": t["id"], "name": t["name"], "group": t.get("group", ""), "unit": t.get("unit", "")}
                                 for t in reports.reportable_tags(app.store)],
                        "intervals": [{"s": s, "label": l} for s, l in reports.INTERVALS.items()],
                        "max_days": reports.MAX_DAYS, "max_rows": reports.MAX_ROWS})

        def api_report(self, q):
            self._json(self._report(q))

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
            user = app.store.settings["client"].get("username", "client")
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
            self._json({"ok": True, "role": role, "home": "/admin" if role == "admin" else "/"},
                       extra_headers={"Set-Cookie": c})

        def api_logout(self, q):
            role = self._role()
            app.auth.logout(self._token())
            if role:
                app.historian.event("login", f"{role} signed out")
            self._json({"ok": True}, extra_headers={"Set-Cookie": "sid=; Path=/; Max-Age=0"})

        def api_whoami(self, q):
            role = self._role()
            if not role:
                return self._err("Login required", 401)
            acc = app.store.settings["admin" if role == "admin" else "client"]
            self._json({"ok": True, "role": role, "username": acc.get("username"), "must_change": app.auth.must_change(role)})

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
        ("GET", "/api/report/tags"): Handler.api_report_tags,
        ("GET", "/api/report"): Handler.api_report,
        ("GET", "/api/report.xlsx"): Handler.api_report_xlsx,
        ("GET", "/api/report.pdf"): Handler.api_report_pdf,
        ("POST", "/api/admin/alarms/ack"): Handler.api_alarm_ack,
        ("POST", "/api/login"): Handler.api_login,
        ("POST", "/api/logout"): Handler.api_logout,
        ("GET", "/api/whoami"): Handler.api_whoami,
        ("GET", "/api/admin/session"): Handler.api_session,
        ("POST", "/api/admin/password"): Handler.api_password,
        ("POST", "/api/admin/client-login"): Handler.api_client_login,
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


# client (view-only) data feeds - require a client login
CLIENT_ROUTES = {"/api/meta", "/api/live", "/api/trend", "/api/alarms",
                 "/api/report/tags", "/api/report", "/api/report.xlsx", "/api/report.pdf"}


# ---------------------------------------------------------------------------------------------
# Client (view-only) projections - strip PLC / network / address / diagnostic details.
# ---------------------------------------------------------------------------------------------
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


_TAG_FIELDS = ("id", "name", "group", "unit", "decimals", "data_type", "value", "ts", "simulated", "verified",
               "states", "eng_min", "eng_max", "setpoint_value", "trend", "kpi", "trend_min", "trend_max")


def client_tag(t):
    out = {k: t.get(k) for k in _TAG_FIELDS}
    q = t.get("quality")
    out["quality"] = "SIMULATED" if q == "SIMULATED" else ("GOOD" if q == "GOOD" else ("STALE" if q in ("STALE", "INIT") else "NODATA"))
    out["alarm"] = t.get("alarm")
    return out


def client_equipment(e):
    return {k: e.get(k) for k in ("id", "name", "area", "type", "tag_no", "kw", "status", "color", "since",
                                  "run_hours", "starts", "simulated")}


def client_alarm(a):
    comm = a.get("tag") == "_COMM"
    return {"id": a.get("id"), "tag": a.get("tag"), "priority": a.get("priority"),
            "message": "Data connection to plant lost" if comm else a.get("message"),
            "tag_name": "Data connection" if comm else a.get("tag_name"),
            "simulated": a.get("simulated"), "raised_at": a.get("raised_at"), "cleared_at": a.get("cleared_at"),
            "acked_at": a.get("acked_at"), "acked_by": a.get("acked_by"), "note": a.get("ack_note") or ""}


def serve(app, host, port):
    httpd = ThreadingHTTPServer((host, port), make_handler(app))
    httpd.daemon_threads = True
    return httpd
