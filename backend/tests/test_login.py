"""Role / login gate tests: python -m unittest discover -s tests   (from backend/)"""
import http.cookiejar
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import run  # noqa: E402
from app.server import serve  # noqa: E402

PORT = 18099


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


class TestLogin(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        shutil.copytree(os.path.join(os.path.dirname(HERE), "config"), os.path.join(cls.tmp, "config"),
                        ignore=shutil.ignore_patterns("settings.json"))
        cls.app = run.App(os.path.join(cls.tmp, "config"), os.path.join(cls.tmp, "data"),
                          os.path.join(os.path.dirname(os.path.dirname(HERE)), "frontend"))
        cls.httpd = serve(cls.app, "127.0.0.1", PORT)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.app.historian.close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def browser(self):
        jar = http.cookiejar.CookieJar()
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect)

    def get(self, op, path):
        try:
            r = op.open(f"http://127.0.0.1:{PORT}{path}")
            return r.status, r.headers.get("Location"), r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get("Location"), e.read()

    def login(self, op, user, pw):
        req = urllib.request.Request(f"http://127.0.0.1:{PORT}/api/login", data=json.dumps({"username": user, "password": pw}).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        try:
            return json.loads(op.open(req).read())
        except urllib.error.HTTPError as e:
            return {"code": e.code}

    def post(self, op, path, body):
        req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        try:
            return 200, json.loads(op.open(req).read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def test_client_scaling_and_levels(self):
        cli = self.browser()
        self.login(cli, "ankur", "ankur123")
        body = {"id": "LT_01", "source": "plc", "range_min": 0, "range_max": 3600, "decimals": 1,
                "levels": {"hh": 3200, "h": 2400, "l": 900, "ll": 600}}
        self.assertEqual(self.post(cli, "/api/client/scaling", body)[0], 200)
        self.assertEqual(self.app.store.tag_map()["LT_01"]["levels"], {"hh": 3200.0, "h": 2400.0, "l": 900.0, "ll": 600.0})
        bad = dict(body, levels={"hh": 900, "h": 2400, "l": 900, "ll": 600})          # out of order
        self.assertEqual(self.post(cli, "/api/client/scaling", bad)[0], 400)
        self.assertEqual(self.post(cli, "/api/client/scaling", dict(body, id="PT_01"))[0], 400)   # levels: level tags only
        self.assertEqual(self.post(self.browser(), "/api/client/scaling", body)[0], 401)          # login required
        # Tank levels page: set points only (LT-02 range fixed here: the live config may have been re-ranged)
        self.assertEqual(self.post(cli, "/api/client/scaling", {"id": "LT_02", "source": "plc", "range_min": 0, "range_max": 3600})[0], 200)
        ok = self.post(cli, "/api/client/levels", {"id": "LT_02", "levels": {"hh": 3300, "h": 2800, "l": 800, "ll": 400}})
        self.assertEqual(ok[0], 200)
        self.assertEqual(self.app.store.tag_map()["LT_02"]["levels"]["h"], 2800.0)
        self.assertEqual(self.post(cli, "/api/client/levels", {"id": "LT_02", "levels": {"hh": 9000, "h": 2800, "l": 800, "ll": 400}})[0], 400)
        self.assertEqual(self.post(cli, "/api/client/levels", {"id": "T_01", "levels": {"hh": 4, "h": 3, "l": 2, "ll": 1}})[0], 400)

    def test_client_write_set_point(self):
        cli = self.browser()
        self.login(cli, "ankur", "ankur123")
        eng = self.app.engine                       # engine not running in this test: give the set point a current reading
        eng._reload_if_needed()
        eng.states["LT_01_H_DLY"].value = None
        self.assertEqual(self.post(cli, "/api/client/write", {"id": "LT_01_H_DLY", "value": 12})[0], 400)   # never read: refused
        eng.states["LT_01_H_DLY"].value = 5.0
        code, r = self.post(cli, "/api/client/write", {"id": "LT_01_H_DLY", "value": 12})       # demo mode: simulated write
        self.assertEqual((code, r.get("value"), r.get("simulated")), (200, 12.0, True))
        self.assertEqual(self.post(cli, "/api/client/write", {"id": "LT_01", "value": 100})[0], 400)       # not writable
        self.assertEqual(self.post(cli, "/api/client/write", {"id": "LT_01_H_DLY", "value": 99999})[0], 400)  # out of range
        self.assertEqual(self.post(self.browser(), "/api/client/write", {"id": "LT_01_H_DLY", "value": 5})[0], 401)

    def test_anonymous_goes_to_login(self):
        op = self.browser()
        self.assertEqual(self.get(op, "/")[:2], (302, "/login"))            # straight to login (no welcome page)
        self.assertEqual(self.get(op, "/welcome")[:2], (302, "/login"))
        self.assertEqual(self.get(op, "/admin")[:2], (302, "/login"))
        self.assertEqual(self.get(op, "/index.html")[:2], (302, "/login"))
        self.assertEqual(self.get(op, "/login")[0], 200)
        self.assertEqual(self.get(op, "/api/live")[0], 401)
        self.assertEqual(self.get(op, "/api/admin/tags")[0], 401)

    def test_operator_dashboard_no_settings(self):
        op = self.browser()
        self.assertEqual(self.login(op, "ankur", "wrong").get("code"), 401)
        r = self.login(op, "ankur", "ankur123")                         # built-in client login = operator
        self.assertEqual((r["role"], r["home"]), ("operator", "/"))
        self.assertEqual(self.get(op, "/")[0], 200)
        self.assertEqual(self.get(op, "/api/live")[0], 200)
        self.assertEqual(self.get(op, "/admin")[:2], (302, "/"))          # operator cannot open Settings
        self.assertEqual(self.get(op, "/api/admin/tags")[0], 401)
        self.assertEqual(self.get(op, "/login")[:2], (302, "/"))

    def test_admin_dashboard_and_settings(self):
        op = self.browser()
        r = self.login(op, "admin", "admin123")
        self.assertEqual((r["role"], r["home"]), ("admin", "/"))
        self.assertEqual(self.get(op, "/admin")[0], 200)
        self.assertEqual(self.get(op, "/api/admin/tags")[0], 200)
        self.assertEqual(self.get(op, "/")[0], 200)                      # admin also sees the dashboard
        self.assertEqual(self.get(op, "/api/live")[0], 200)

    def test_viewer_is_read_only(self):
        adm = self.browser()
        self.login(adm, "admin", "admin123")
        self.assertEqual(self.post(adm, "/api/admin/users", {"username": "view1", "role": "viewer", "password": "short"})[0], 400)
        self.assertEqual(self.post(adm, "/api/admin/users", {"username": "view1", "role": "viewer", "password": "viewer-pass-1"})[0], 200)
        users = json.loads(self.get(adm, "/api/admin/users")[2])["users"]
        self.assertIn({"username": "view1", "role": "viewer", "builtin": False, "must_change": False}, users)
        self.assertNotIn("password_hash", json.dumps(users))
        settings = self.get(adm, "/api/admin/settings")[2].decode()
        self.assertNotIn("password_hash", settings)                     # hashes never reach the browser
        v = self.browser()
        self.assertEqual(self.login(v, "view1", "viewer-pass-1")["role"], "viewer")
        self.assertEqual(self.get(v, "/")[0], 200)
        self.assertEqual(self.get(v, "/api/live")[0], 200)
        self.assertEqual(self.get(v, "/admin")[:2], (302, "/"))
        self.assertEqual(self.post(v, "/api/client/alarms/ack", {"ids": [1]})[0], 403)
        self.assertEqual(self.post(v, "/api/client/write", {"id": "LT_01_H_DLY", "value": 6})[0], 403)
        self.assertEqual(self.post(v, "/api/client/scaling", {"id": "LT_01"})[0], 403)
        self.assertEqual(self.post(v, "/api/admin/users", {"username": "x2", "role": "viewer", "password": "12345678"})[0], 401)
        self.assertEqual(self.post(adm, "/api/admin/users", {"username": "view1", "delete": True})[0], 200)
        self.assertEqual(self.get(v, "/api/live")[0], 401)               # deleted user is signed out

    def post(self, op, path, body):
        req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        try:
            r = op.open(req)
            return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, None

    def test_alarm_ack_needs_operator_or_admin(self):
        self.assertEqual(self.post(self.browser(), "/api/client/alarms/ack", {"ids": [1]})[0], 401)   # anonymous
        adm = self.browser()
        self.login(adm, "admin", "admin123")
        self.assertEqual(self.post(adm, "/api/client/alarms/ack", {"ids": [999999]})[0], 200)      # admin may acknowledge
        cli = self.browser()
        self.login(cli, "ankur", "ankur123")
        code, body = self.post(cli, "/api/client/alarms/ack", {"ids": [999999]})                    # not an open alarm
        self.assertEqual((code, body["acknowledged"]), (200, []))

    def test_logout_returns_to_login(self):
        op = self.browser()
        self.login(op, "ankur", "ankur123")
        req = urllib.request.Request(f"http://127.0.0.1:{PORT}/api/logout", data=b"{}", headers={"Content-Type": "application/json"}, method="POST")
        op.open(req).read()
        self.assertEqual(self.get(op, "/")[:2], (302, "/login"))
        self.assertEqual(self.get(op, "/api/live")[0], 401)


if __name__ == "__main__":
    unittest.main()
