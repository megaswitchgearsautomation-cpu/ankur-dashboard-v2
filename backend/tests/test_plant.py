"""Plant pages data: PLC scaling companion tags.   python -m unittest tests.test_plant -v   (from the backend folder)"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from app import codec  # noqa: E402
from app.config_store import DEFAULT_SETTINGS, validate_tags  # noqa: E402
from app.server import CLIENT_AUX_GROUPS  # noqa: E402

TAGS = os.path.join(os.path.dirname(HERE), "config", "tags.json")


class TestScalingTags(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(TAGS, encoding="utf-8") as f:
            cls.tags = json.load(f)
        cls.by_id = {t["id"]: t for t in cls.tags}

    def test_config_valid(self):
        self.assertEqual(validate_tags(json.loads(json.dumps(self.tags)), DEFAULT_SETTINGS), [])

    def test_each_analog_has_signal_and_range(self):
        for aid in ("T_01", "T_02", "T_03", "T_04", "LT_01", "LT_02", "PH_01", "PT_01", "PT_02", "PT_03", "PT_04"):
            for suffix, role in (("_MA", "ma"), ("_RMIN", "min"), ("_RMAX", "max")):
                t = self.by_id.get(aid + suffix)
                self.assertIsNotNone(t, aid + suffix)
                self.assertEqual((t["group"], t["scale_of"], t["scale_role"]), ("Scaling", aid, role))
                self.assertFalse(t["show_on_dashboard"])      # sent to the client only through the "aux" block
                self.assertFalse(t.get("log", True))

    def test_addresses_follow_plc_block(self):
        # PLC block per analog input: min +0, max +2, mA +4, final value +8 (REAL, 2 words each)
        for aid in ("T_01", "LT_01", "PT_04"):
            base = int(self.by_id[aid]["device"][1:]) - 8
            self.assertEqual(self.by_id[aid + "_RMIN"]["device"], f"D{base}")
            self.assertEqual(self.by_id[aid + "_RMAX"]["device"], f"D{base + 2}")
            self.assertEqual(self.by_id[aid + "_MA"]["device"], f"D{base + 4}")

    def test_aux_groups(self):
        self.assertIn("Scaling", CLIENT_AUX_GROUPS)
        self.assertIn("Level switches", CLIENT_AUX_GROUPS)
        self.assertIn("Set values", CLIENT_AUX_GROUPS)

    def test_signal_scaling_mode(self):
        t = json.loads(json.dumps(self.by_id["LT_01"]))
        t["scaling"] = {"mode": "signal", "eng_min": 0, "eng_max": 3000}
        self.assertEqual(validate_tags([t], DEFAULT_SETTINGS), [])
        self.assertEqual(codec.apply_scaling(1234.5, t["scaling"]), 1234.5)   # engine recomputes from mA
        t["scaling"] = {"mode": "signal", "eng_min": 5, "eng_max": 5}
        self.assertTrue(validate_tags([t], DEFAULT_SETTINGS))

    def test_selectors_linked(self):
        with open(os.path.join(os.path.dirname(TAGS), "equipment.json"), encoding="utf-8") as f:
            eq = {e["id"]: e for e in json.load(f)}
        # verified on the HMI: sludge pair M6000/M7000, filtrate pair M6006/M7006, sludge feed valve M6029
        self.assertEqual(self.by_id[eq["OP_P1B"]["am_tag"]]["device"], "M6000")
        self.assertEqual(self.by_id[eq["OP_P5A"]["ms_tag"]]["device"], "M7006")
        self.assertEqual(self.by_id[eq["MV_01"]["am_tag"]]["device"], "M6029")
        self.assertTrue(all(e.get("am_tag") in self.by_id for e in eq.values()))


class TestFromSignal(unittest.TestCase):
    def test_formula(self):
        from app.engine import Engine
        class S:  # minimal tag state
            def __init__(self, v, q="GOOD"):
                self.value, self.quality = v, q
        e = Engine.__new__(Engine)
        e.states = {"LT_01_MA": S(12.0)}
        sc = {"mode": "signal", "eng_min": 0, "eng_max": 3600}
        self.assertAlmostEqual(e._from_signal({"id": "LT_01"}, sc, -1), 1800.0)
        e.states = {"LT_01_MA": S(None, "NODATA")}
        self.assertEqual(e._from_signal({"id": "LT_01"}, sc, -1), -1)          # no signal: keep PLC value


if __name__ == "__main__":
    unittest.main()
