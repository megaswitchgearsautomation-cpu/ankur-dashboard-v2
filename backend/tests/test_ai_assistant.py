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
        self.assertIn("Level set points HH 3240 H 2700 L 900 LL 360", s)
        self.assertIn("alarm SP 8.5", s)
        self.assertIn("OP_P1A | 01-P-101 / OP-P1A | UG Sludge Pump (Main) | - | TRIP | Auto, main selected", s)
        self.assertNotIn("PLC", s.split("ANALOG VALUES")[0])          # header says "plant", not PLC
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

    def test_offline_process_values_vs_set_points(self):
        """'Are pressures and temperatures within their set points?' (a suggestion button) must answer that -
        not fall back to the alarm / tank summary."""
        live = json.loads(json.dumps(LIVE))
        live["tags"].append({"id": "T_01", "name": "T-01 Dryer to Radiator Temp", "group": "Temperature", "unit": "°C",
                             "decimals": 1, "value": 175.0, "quality": "SIMULATED"})
        live["aux"]["T_01_ALM_SP"] = {"value": 170.0}
        a = offline_answer("Are pressures and temperatures within their set points?", live)
        self.assertNotIn("active alarm", a)
        self.assertIn("PT-01 Raw Water Header Pressure: **6.7 barg** / set point 8.5 barg - within", a)
        self.assertIn("T-01 Dryer to Radiator Temp: **175.0 °C** / set point 170.0 °C - **ABOVE set point**", a)
        self.assertTrue(a.startswith("_Demo data._\n**1 above the alarm set point:** T-01"))
        p = offline_answer("क्या प्रेशर सेट पॉइंट के अंदर है?", live)       # Hindi / mic
        self.assertIn("All pressures are within their alarm set points", p)
        self.assertNotIn("Dryer to Radiator Temp", p)                       # only pressures were asked

    def test_offline_specific_pump_trip_is_brief(self):
        a = offline_answer("why is 01-P-101 stopped?", LIVE)
        self.assertTrue(a.startswith("_Demo data._\n**01-P-101**"))
        self.assertIn("**TRIPPED**", a)
        self.assertIn("1. Check the MPCB", a)
        self.assertIn("start level set point = **2400 mm**", a)
        self.assertLessEqual(len(a.splitlines()), 8)
        h = offline_answer("sludge pump trip kyu hua?", LIVE)        # by name, Hinglish
        self.assertIn("01-P-101", h)

    def test_level_set_points_in_percent(self):
        live = json.loads(json.dumps(LIVE))
        for k, v in (("HH", 90), ("H", 75), ("L", 25), ("LL", 10)):
            live["aux"][f"LT_01_{k}_SP"] = {"value": v, "unit": "%", "group": "Level set points", "name": k}
        s = snapshot_text(live)
        self.assertIn("Level set points HH 90% (3240 mm) H 75% (2700 mm) L 25% (900 mm) LL 10% (360 mm)", s)
        a = offline_answer("sludge tank level?", live)
        self.assertIn("120 mm (3%) - **at / below LL**", a)          # 120 mm compared with LL = 360 mm, not with "10"
        self.assertIn("LL 10% (360 mm)", a)

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

    def test_snapshot_has_selectors_delays_history(self):
        live = json.loads(json.dumps(LIVE))
        live["aux"]["SEL_AM_SLUDGE"] = {"value": False, "group": "Selectors", "name": "UG sludge pumps - Auto/Manual selector"}
        live["aux"]["PT_01_ALM_DLY"] = {"value": 5, "group": "Alarm delays"}
        live["aux"]["PT_01_ALM_ACT"] = {"value": 2, "group": "Alarm delays"}
        live["recent_alarms"] = [{"message": "PT-01 high", "priority": "amber", "raised_at": 1793690000.0, "cleared_at": 1793690600.0}]
        live["recent_changes"] = [{"ts": 1793691000.0, "detail": "admin wrote PT_01_ALM_SP: 8 -> 8.5"}]
        s = snapshot_text(live)
        self.assertIn("UG sludge pumps = MANUAL", s)
        self.assertIn("alarm delay 5 s (running 2 s)", s)
        self.assertIn("ALARM HISTORY - LAST 24 H (1", s)
        self.assertIn("PT-01 high - cleared", s)
        self.assertIn("admin wrote PT_01_ALM_SP", s)

    def test_offline_new_intents(self):
        live = json.loads(json.dumps(LIVE))
        live["equipment"][1]["auto"] = False
        live["aux"]["PT_01_ALM_DLY"] = {"value": 5}
        live["recent_alarms"] = []
        rh = offline_answer("show run hours of all machines", live)
        self.assertIn("highest: **01-P-101**", rh)
        self.assertIn("| Machine | Name | Run hours |", rh)
        m = offline_answer("which machines are in manual?", live)
        self.assertIn("**1 of 2 machines in Manual**", m)
        self.assertIn("Dryer Hot Water Pump - Manual", m)
        live["tags"][1]["alarm"] = {"hi": None, "lo": None, "hihi": None, "lolo": None}      # no limit active
        pt = offline_answer("PT-01 kitna hai?", live)
        self.assertNotIn("ALARM", pt)
        self.assertNotIn("ALARM", snapshot_text(live).split("PT_01")[1].split("\n")[0])
        self.assertIn("**PT-01 Raw Water Header Pressure** = **6.7 barg**", pt)
        self.assertIn("Alarm set point 8.5 barg - below", pt)
        self.assertIn("Alarm delay 5 s", pt)
        self.assertNotIn("T-01", offline_answer("pt01 value", live).replace("PT-01", ""))
        self.assertIn("No alarms in the last 24 hours", offline_answer("what alarms came in the last 24 hours?", live))
        sp = offline_answer("show all set points", live)
        self.assertIn("LP steam valve open temperature: **70.0 °C**", sp)
        full = offline_answer("give me the full plant status", live)
        self.assertIn("active alarm", full)
        self.assertIn("pressures", full)
        self.assertIn("in Manual", full)
        self.assertIn("Basic mode", offline_answer("help", live))

    def test_admin_settings_never_return_key(self):
        s = self.a.save_admin_settings({"api_key": "sk-ant-test-0123456789abcdefghij", "model": "claude-sonnet-5-5", "effort": "high", "enabled": True})
        self.assertTrue(s["key_set"])
        self.assertNotIn("sk-ant-test", json.dumps(s))
        self.assertEqual((s["model"], s["effort"]), ("claude-sonnet-5-5", "high"))
        with self.assertRaises(ValueError):
            self.a.save_admin_settings({"model": "gpt-4"})
        with self.assertRaises(ValueError):
            self.a.save_admin_settings({"api_key": "short"})
        s = self.a.save_admin_settings({"model": "claude-opus-5-5"})          # key kept when not sent
        self.assertTrue(s["key_set"])
        self.assertFalse(self.a.save_admin_settings({"clear_key": True})["key_set"])
        self.assertFalse(self.a.test_connection()["ok"])

    def test_haiku_has_no_fallback_param(self):
        fake = FakeClient()
        self.a._get_client = lambda: (fake, {"model": "claude-haiku-5-5"})
        self.a.ask("alarms?", [], LIVE)
        self.assertNotIn("fallbacks", fake.calls[0])

    def test_disabled_in_config(self):
        with open(os.path.join(self.tmp, "ai_config.json"), "w", encoding="utf-8") as f:
            json.dump({"enabled": False, "api_key": "sk-test"}, f)
        self.assertEqual(self.a.ask("alarms?", [], LIVE)["source"], "offline")


if __name__ == "__main__":
    unittest.main()
