"""WhatsApp alarm alerts (no network: the HTTP call is replaced).   python -m unittest tests.test_whatsapp -v"""
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from app.whatsapp import WhatsAppNotifier, normalize_number  # noqa: E402

TOKEN = "EAAG" + "x" * 60          # fake test token


class FakeEngine:
    def __init__(self):
        self.alarms = []

    def active_alarms(self):
        return list(self.alarms)


class FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class TestWhatsApp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.eng = FakeEngine()
        self.calls = []

        def opener(req, timeout=0):
            self.calls.append((req.full_url, dict(req.headers), json.loads(req.data)))
            return FakeResp(json.dumps({"messages": [{"id": "wamid.TEST"}]}).encode())
        self.wa = WhatsAppNotifier(self.tmp, self.eng, None, site_name=lambda: "FSTP-200 Muttathara", opener=opener)
        self.wa.save({"phone_number_id": "1234567890", "access_token": TOKEN, "recipients": "+91 98765 43210\n9123456789",
                      "enabled": True})

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def drain(self):
        while not self.wa._q.empty():
            state, text, ts = self.wa._q.get_nowait()
            self.wa.send(state, text, ts)

    def test_numbers_and_token_never_returned(self):
        self.assertEqual(normalize_number("+91 98765-43210"), "919876543210")
        self.assertEqual(normalize_number("9876543210"), "919876543210")
        with self.assertRaises(ValueError):
            normalize_number("12345")
        pub = self.wa.public()
        self.assertTrue(pub["token_set"])
        self.assertNotIn(TOKEN, json.dumps(pub))
        self.assertEqual(pub["recipients"], ["919876543210", "919123456789"])
        with self.assertRaises(ValueError):                       # cannot enable without a token
            WhatsAppNotifier(tempfile.mkdtemp()).save({"enabled": True, "recipients": "9876543210"})

    def test_new_alarm_then_clear_sends_template_messages(self):
        self.eng.alarms = [{"id": 1, "tag": "OLD", "kind": "state", "priority": "red", "message": "already active", "raised_at": 1}]
        self.assertEqual(self.wa.check(now=1000), [])              # first look after start: nothing sent
        a = {"id": 2, "tag": "DI_TRIP", "kind": "state", "priority": "red", "message": "Sludge pump: PLC alarm", "raised_at": 1793690000.0}
        self.eng.alarms.append(a)
        q = self.wa.check(now=1010)
        self.assertEqual([x[0] for x in q], ["ACTIVE"])
        self.drain()
        self.assertEqual(len(self.calls), 2)                       # both recipients
        url, headers, body = self.calls[0]
        self.assertTrue(url.endswith("/v21.0/1234567890/messages"))
        self.assertEqual(headers["Authorization"], f"Bearer {TOKEN}")
        self.assertEqual(body["type"], "template")
        self.assertEqual(body["template"]["name"], "plant_alarm")
        params = [p["text"] for p in body["template"]["components"][0]["parameters"]]
        self.assertEqual(params[:3], ["FSTP-200 Muttathara", "ACTIVE", "CRITICAL - Sludge pump: alarm"])   # no 'PLC'
        self.assertIn("IST", params[3])
        self.assertIn("UTC", params[3])
        self.eng.alarms = [x for x in self.eng.alarms if x["id"] != 2]
        q = self.wa.check(now=1020)
        self.assertEqual([x[0] for x in q], ["CLEARED"])

    def test_repeat_hold_demo_and_disabled(self):
        self.wa.check(now=0)
        a = {"id": 5, "tag": "T_01", "kind": "hi", "priority": "yellow", "message": "T-01 High", "raised_at": 10}
        self.eng.alarms = [a]
        self.assertEqual(len(self.wa.check(now=100)), 1)
        self.eng.alarms = []
        self.wa.check(now=110)                                      # cleared (sent)
        self.eng.alarms = [dict(a, id=6)]                           # same source again 2 minutes later
        self.assertEqual(self.wa.check(now=220), [])                # held back (15 min)
        self.eng.alarms = [dict(a, id=7, tag="T_02", simulated=1)]
        self.assertEqual(self.wa.check(now=230), [])                # demo alarm not sent by default
        self.wa.save({"enabled": False})
        self.eng.alarms = [dict(a, id=8, tag="T_03")]
        self.assertEqual(self.wa.check(now=240), [])

    def test_text_mode_and_error_hint(self):
        self.wa.save({"mode": "text"})
        self.wa.send("ACTIVE", "LT-01 High-High", 1793690000.0)
        body = self.calls[-1][2]
        self.assertEqual(body["type"], "text")
        self.assertIn("Alarm ACTIVE: LT-01 High-High", body["text"]["body"])

        def bad(req, timeout=0):
            raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {},
                                         io.BytesIO(json.dumps({"error": {"message": "Invalid OAuth access token", "code": 190}}).encode()))
        self.wa._open = bad
        res = self.wa.test("9876543210")
        self.assertFalse(res[0]["ok"])
        self.assertIn("access token invalid or expired", res[0]["detail"])


if __name__ == "__main__":
    unittest.main()
