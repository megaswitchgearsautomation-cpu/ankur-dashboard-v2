"""AI assistant.   python -m unittest tests.test_ai_assistant -v   (from the backend folder)"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from app import ai_assistant  # noqa: E402
from app.ai_assistant import Assistant, offline_answer, snapshot_text  # noqa: E402

LIVE = {
    "server_time": 1793696000.0,
    "status": {"state": "demo", "validated": False, "last_update": 1793696000.0},
    "tags": [
        {"id": "LT_01", "name": "LT-01 Sludge Water Tank Level", "group": "Level", "unit": "mm", "decimals": 1,
         "value": 120.0, "eng_min": 0, "eng_max": 3600, "quality": "SIMULATED", "alarm": None},
        {"id": "PT_01", "name": "PT-01 Raw Water Header Pressure", "group": "Pressure", "unit": "barg", "decimals": 1,
         "value": 6.7, "eng_min": 0, "eng_max": 10, "quality": "SIMULATED", "alarm": None},
    ],
    "equipment": [
        {"id": "OP_P1A", "tag_no": "OP-P1A", "name": "UG Sludge Pump (Main)", "status": "TRIP", "auto": True,
         "pair": "sludge", "standby_selected": False, "run_hours": 12.5, "starts": 3, "io": {"cmd": True, "run": False, "trip": True}},
        {"id": "OP_P2", "tag_no": "OP-P2", "name": "Dryer Hot Water Pump", "status": "RUNNING", "auto": True, "run_hours": 4.0, "starts": 1},
    ],
    "alarms": [{"priority": "red", "message": "OP-P1A UG Sludge Pump (Main) TRIP", "tag_name": "Sludge pump trip",
                "raised_at": 1793695000.0, "acked_at": None, "note": "", "previous_notes": [{"note": "MPCB reset"}]}],
    "aux": {
        "PT_01_ALM_SP": {"value": 8.5, "quality": "SIMULATED", "name": "PT-01 alarm SP", "group": "Pressure", "unit": "barg", "decimals": 1},
        "LT_01_HH_SP": {"value": 3240, "group": "Level set points", "name": "HH"}, "LT_01_H_SP": {"value": 2700, "group": "Level set points", "name": "H"},
        "LT_01_L_SP": {"value": 900, "group": "Level set points", "name": "L"}, "LT_01_LL_SP": {"value": 360, "group": "Level set points", "name": "LL"},
        "DI_Magnetic_Float_Sensor_Raw_Water_Tank_HL": {"value": False, "quality": "SIMULATED", "name": "Raw Water Tank HL", "group": "Level switches"},
        "DI_Magnetic_Float_Sensor_Raw_Water_Tank_LL": {"value": False, "quality": "SIMULATED", "name": "Raw Water Tank LL", "group": "Level switches"},
        "SP_SLUDGE_PUMP_START": {"value": 2400.0, "quality": "SIMULATED", "name": "Sludge pump start level", "group": "Set values", "unit": "mm", "decimals": 0},
        "SP_STEAM": {"value": 70.0, "quality": "SIMULATED", "name": "LP steam valve open temperature", "group": "Set values", "unit": "°C", "decimals": 1},
    },
}


class FakeClient:
    def __init__(self, text="Pump **01-P-101** tripped."):
        self.calls = []
        self.text = text
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kw):
        self.calls.append(kw)
        return SimpleNamespace(stop_reason="end_turn", model=kw["model"],
                               content=[SimpleNamespace(type="thinking", thinking=""), SimpleNamespace(type="text", text=self.text)])


class TestAiAssistant(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        with open(os.path.join(self.tmp, "ai_knowledge.md"), "w", encoding="utf-8") as f:
            f.write("# plant knowledge\n01-P-101 sludge pump")
        self.saved_env = {k: os.environ.pop(k, None) for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")}
        self.a = Assistant(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        for k, v in self.saved_env.items():
            if v is not None:
                os.environ[k] = v

    def test_snapshot_has_values_set_points_alarms_and_times(self):
        s = snapshot_text(LIVE)
        self.assertIn("DEMO", s)
        self.assertIn("UTC", s)
        self.assertIn("IST", s)
        self.assertIn("LT_01 LT-01 Sludge Water Tank Level = 120.0 mm (3% of range)", s)
        self.assertIn("HMI levels HH 3240 H 2700 L 900 LL 360", s)
        self.assertIn("alarm SP 8.5", s)
        self.assertIn("OP_P1A | OP-P1A | UG Sludge Pump (Main) | TRIP | Auto, main selected", s)
        self.assertIn("Raw Water Tank LL = OFF", s)
        self.assertIn("LP steam valve open temperature = 70.0 °C", s)
        self.assertIn("ACTIVE ALARMS (1)", s)
        self.assertIn("earlier fixes noted: MPCB reset", s)

    def test_offline_answer_tanks_and_alarms(self):
        t = offline_answer("which tanks are empty?", LIVE)
        self.assertIn("**Tanks:** 2 low / empty", t)      # LT-01 at 3% + raw water tank LL off
        self.assertIn("Sludge storage tank", t)
        self.assertIn("Raw water storage tank", t)
        al = offline_answer("what alarms are active and how to fix?", LIVE)
        self.assertIn("1 active alarm", al)
        self.assertIn("MPCB", al)
        self.assertIn("last fix: MPCB reset", al)

    def test_offline_specific_pump_trip_is_brief(self):
        a = offline_answer("why is 01-P-101 stopped?", LIVE)
        self.assertTrue(a.startswith("_Demo data._\n**01-P-101**"))
        self.assertIn("**TRIPPED**", a)
        self.assertIn("1. Check the MPCB", a)
        self.assertIn("start level set point = **2400 mm**", a)
        self.assertLessEqual(len(a.splitlines()), 8)
        h = offline_answer("sludge pump trip kyu hua?", LIVE)        # by name, Hinglish
        self.assertIn("01-P-101", h)

    def test_offline_specific_tank_level(self):
        a = offline_answer("sludge tank level kitna hai?", LIVE)
        self.assertIn("**Sludge storage tank (01-LT-101)**: 120 mm (3%) - **at / below LL**", a)
        self.assertIn("Set points: HH 3240 · H 2700 · L 900 · LL 360", a)
        r = offline_answer("raw water tank status", LIVE)
        self.assertIn("LOW / EMPTY", r)
        self.assertLessEqual(len(a.splitlines()), 6)

    def test_ask_without_key_is_offline(self):
        r = self.a.ask("plant summary", [], LIVE)
        self.assertTrue(r["ok"])
        self.assertEqual(r["source"], "offline")
        self.assertFalse(self.a.status()["ai"])

    def test_ask_with_claude_request_shape(self):
        fake = FakeClient()
        self.a._get_client = lambda: (fake, {"model": "claude-opus-5-5"})
        hist = [{"role": "assistant", "content": "hello"}, {"role": "user", "content": "q1"},
                {"role": "assistant", "content": "a1"}, {"role": "user", "content": "dangling"}]
        r = self.a.ask("why is the sludge pump stopped?", hist, LIVE)
        self.assertEqual(r, {"ok": True, "answer": "Pump **01-P-101** tripped.", "source": "ai", "model": "claude-opus-5-5"})
        kw = fake.calls[0]
        self.assertEqual(kw["model"], "claude-opus-5-5")
        self.assertEqual(kw["system"][0]["cache_control"], {"type": "ephemeral"})
        self.assertIn("plant knowledge", kw["system"][0]["text"])
        self.assertNotIn("ACTIVE ALARMS", kw["system"][0]["text"])         # volatile data stays out of the cached prefix
        self.assertNotIn("120.0 mm", kw["system"][0]["text"])
        self.assertEqual(kw["fallbacks"], "default")
        self.assertIn("server-side-fallback-2026-07-01", kw["betas"])
        roles = [m["role"] for m in kw["messages"]]
        self.assertEqual(roles, ["user", "assistant", "user"])             # history cleaned + alternating
        self.assertIn("LIVE SNAPSHOT", kw["messages"][-1]["content"])
        self.assertTrue(kw["messages"][-1]["content"].endswith("QUESTION: why is the sludge pump stopped?"))

    def test_question_required_and_rate_limit(self):
        with self.assertRaises(ValueError):
            self.a.ask("   ", [], LIVE)
        n, _ = ai_assistant.RATE_LIMIT
        self.assertTrue(all(self.a.rate_ok("s1") for _ in range(n)))
        self.assertFalse(self.a.rate_ok("s1"))
        self.assertTrue(self.a.rate_ok("s2"))

    def test_disabled_in_config(self):
        with open(os.path.join(self.tmp, "ai_config.json"), "w", encoding="utf-8") as f:
            json.dump({"enabled": False, "api_key": "sk-test"}, f)
        self.assertEqual(self.a.ask("alarms?", [], LIVE)["source"], "offline")


if __name__ == "__main__":
    unittest.main()
