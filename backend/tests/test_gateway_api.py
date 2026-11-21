"""Gateway HTTP API data source.   python -m unittest tests.test_gateway_api -v   (from the backend folder)"""
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from app import gateway_api  # noqa: E402
from app.config_store import ConfigStore  # noqa: E402
from app.engine import Engine  # noqa: E402
from app.historian import Historian  # noqa: E402

REAL_CONFIG = os.path.join(os.path.dirname(HERE), "config")
REPLY = {"ok": True}
SEEN = {}


class FakeGateway(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        SEEN["auth"] = self.headers.get("X-Api-Key")
        if REPLY.get("status", 200) != 200:
            self.send_response(REPLY["status"])
            self.end_headers()
            return
        body = json.dumps(REPLY["doc"]).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class TestGatewayApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeGateway)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.srv.server_address[1]}/api/values"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        cfg = os.path.join(self.tmp, "config")
        os.makedirs(cfg)
        for f in ("tags.json", "equipment.json"):
            shutil.copy(os.path.join(REAL_CONFIG, f), cfg)
        self.store = ConfigStore(cfg)
        self.store.save_settings({"source": {"mode": "gateway_api"},
                                  "gateway_api": {"url": self.url, "auth_header": "X-Api-Key", "auth_value": "secret-1",
                                                  "values_path": "data.tags", "id_field": "id", "value_field": "value",
                                                  "ts_field": "ts", "quality_field": "q", "poll_s": 1}})
        self.hist = Historian(os.path.join(self.tmp, "h.db"))
        self.eng = Engine(self.store, self.hist)
        self.eng._reload_if_needed()

    def tearDown(self):
        self.hist.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def state(self, tid):
        return self.eng.states[tid]

    def test_values_quality_and_errors(self):
        now = time.time()
        REPLY.update(status=200, doc={"data": {"tags": [
            {"id": "AI_Dryer_To_Radiator_01", "value": 81.3, "ts": now + 7200, "q": "good"},   # T_01 via plc_tag; clock 2 h ahead
            {"id": "AI_Sludge_Water_Tank", "value": 0, "ts": now, "q": "good"},              # a valid zero
            {"id": "AI_Filtrate_Tank", "value": 1700, "ts": now - 3600, "q": "good"},         # an hour old
            {"id": "AI_Ph_Sensor_For_Process_Water", "value": 7.1, "ts": now, "q": "bad"},   # gateway says invalid
        ]}})
        self.eng._poll_api(now)
        self.assertEqual(SEEN["auth"], "secret-1")                      # key sent by the server only
        self.assertEqual((self.state("T_01").value, self.state("T_01").quality), (81.3, "GOOD"))
        self.assertEqual(self.state("T_01").ts, now)                    # future time stamp capped at now
        self.assertEqual((self.state("LT_01").value, self.state("LT_01").quality), (0.0, "GOOD"))   # zero is a value
        self.assertEqual(self.state("PH_01").quality, "BAD")
        self.assertEqual(self.state("PT_01").quality, "CONFIG_ERROR")   # not in the reply
        self.eng._mark_stale(now)
        self.assertEqual(self.state("LT_02").quality, "STALE")          # old reading never shown as live
        self.assertEqual(self.eng.connection()["state"], "CONNECTED")
        # gateway down: values kept but marked BAD, link DISCONNECTED with the reason
        REPLY.update(status=503)
        self.eng._api_next = 0
        self.eng._poll_api(now + 2)
        self.assertEqual(self.state("T_01").quality, "BAD")
        self.assertEqual(self.state("T_01").ts, now)                    # last good time kept, not refreshed
        con = self.eng.connection()
        self.assertEqual(con["state"], "DISCONNECTED")
        self.assertIn("HTTP 503", con["last_error"])
        self.assertIn("Gateway API 127.0.0.1", con["plc"])
        with self.assertRaises(ValueError):                              # read-only source
            self.eng.write_value("LT_01_H_DLY", 5)

    def test_layouts_and_times(self):
        cfg = {"values_path": "", "value_field": "v", "ts_field": "t"}
        r = gateway_api.readings({"A": 1.5, "B": {"v": 2, "t": 1793770000000}}, cfg)
        self.assertEqual(r["A"], (1.5, None, True))
        self.assertEqual(r["B"], (2, 1793770000.0, True))                    # milliseconds -> seconds
        self.assertEqual(gateway_api.parse_ts("2026-11-04T10:00:00+05:30"), gateway_api.parse_ts("2026-11-04T04:30:00Z"))
        self.assertEqual(gateway_api.parse_ts("2026-11-04T10:00:00"), gateway_api.parse_ts("2026-11-04T04:30:00Z"))  # no zone = IST
        with self.assertRaises(gateway_api.ApiError):
            gateway_api.readings({"x": 1}, {"values_path": "data.tags"})

    def test_secret_not_public(self):
        pub = self.store.public_settings()
        self.assertNotIn("auth_value", pub["gateway_api"])
        self.assertTrue(pub["gateway_api"]["has_auth_value"])


if __name__ == "__main__":
    unittest.main()
