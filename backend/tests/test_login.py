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
        # Tank levels page: set points only
        ok = self.post(cli, "/api/client/levels", {"id": "LT_02", "levels": {"hh": 3300, "h": 2800, "l": 800, "ll": 400}})
        self.assertEqual(ok[0], 200)
        self.assertEqual(self.app.store.tag_map()["LT_02"]["levels"]["h"], 2800.0)
        self.assertEqual(self.post(cli, "/api/client/levels", {"id": "LT_02", "levels": {"hh": 9000, "h": 2800, "l": 800, "ll": 400}})[0], 400)
        self.assertEqual(self.post(cli, "/api/client/levels", {"id": "T_01", "levels": {"hh": 4, "h": 3, "l": 2, "ll": 1}})[0], 400)

    def test_client_write_set_point(self):
        cli = self.browser()
        self.login(cli, "ankur", "ankur123")
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

    def test_client_view_only(self):
        op = self.browser()
        self.assertEqual(self.login(op, "ankur", "wrong").get("code"), 401)
        r = self.login(op, "ankur", "ankur123")
        self.assertEqual((r["role"], r["home"]), ("client", "/"))
        self.assertEqual(self.get(op, "/")[0], 200)
        self.assertEqual(self.get(op, "/api/live")[0], 200)
        self.assertEqual(self.get(op, "/admin")[:2], (302, "/"))          # client cannot open admin
        self.assertEqual(self.get(op, "/api/admin/tags")[0], 401)
        self.assertEqual(self.get(op, "/login")[:2], (302, "/"))

    def test_admin_tag_page_only(self):
        op = self.browser()
        r = self.login(op, "admin", "admin123")
        self.assertEqual((r["role"], r["home"]), ("admin", "/admin"))
        self.assertEqual(self.get(op, "/admin")[0], 200)
        self.assertEqual(self.get(op, "/api/admin/tags")[0], 200)
        self.assertEqual(self.get(op, "/")[:2], (302, "/admin"))         # admin does not get the client view
        self.assertEqual(self.get(op, "/api/live")[0], 401)

    def post(self, op, path, body):
        req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        try:
            r = op.open(req)
            return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, None

    def test_alarm_popup_ack_is_client_only(self):
        self.assertEqual(self.post(self.browser(), "/api/client/alarms/ack", {"ids": [1]})[0], 401)   # anonymous
        adm = self.browser()
        self.login(adm, "admin", "admin123")
        self.assertEqual(self.post(adm, "/api/client/alarms/ack", {"ids": [1]})[0], 401)           # admin role
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
