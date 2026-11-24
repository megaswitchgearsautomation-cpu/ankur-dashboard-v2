"""Sludge transfer totalizer.   python -m unittest tests.test_transfer -v   (from the backend folder)"""
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from app import transfer  # noqa: E402
from app.config_store import ConfigError, ConfigStore  # noqa: E402
from app.historian import Historian  # noqa: E402

T0 = 1_793_750_400.0          # 2026-11-04 00:00 IST


class TestLevelDrops(unittest.TestCase):
    def pts(self, values):
        return [(i * 10.0, v, 0) for i, v in enumerate(values)]

    def test_user_example_100_to_50(self):
        # 100 % -> 50 % of a 3600 mm tank = 1800 mm out
        total, eps = transfer.level_drops(self.pts([3600, 3000, 2400, 1800]), 10)
        self.assertEqual(total, 1800)
        self.assertEqual(len(eps), 1)

    def test_every_drop_is_added_rises_not_subtracted(self):
        # down 1000, fill up 1500, down 800, up, down 200  -> 2000 out
        total, eps = transfer.level_drops(self.pts([3000, 2500, 2000, 2800, 3500, 3100, 2700, 2900, 2700]), 10)
        self.assertEqual(total, 1000 + 800 + 200)
        self.assertEqual([round(e["drop"]) for e in eps], [1000, 800, 200])

    def test_noise_is_ignored(self):
        jitter = [2000 + (4 if i % 2 else -4) for i in range(200)]       # +-4 mm noise, flat level
        self.assertEqual(transfer.level_drops(self.pts(jitter), 10)[0], 0)
        slow = [2000 - i * 0.5 for i in range(201)]                      # slow real fall of 100 mm in 0.5 mm steps
        total, _ = transfer.level_drops(self.pts(slow), 10)
        self.assertAlmostEqual(total, 100, delta=10)

    def test_missing_values_skipped(self):
        total, _ = transfer.level_drops(self.pts([2000, None, None, 1500]), 10)
        self.assertEqual(total, 500)


class TestTransferReport(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        cfg = os.path.join(self.tmp, "config")
        os.makedirs(cfg)
        for f in ("tags.json", "equipment.json"):
            shutil.copy(os.path.join(os.path.dirname(HERE), "config", f), cfg)
        self.store = ConfigStore(cfg)
        tags = [dict(t) for t in self.store.tags]                  # fixed 0-3600 mm tanks: the live config may be re-ranged
        for t in tags:
            if t["id"] in ("LT_01", "LT_02"):
                t["eng_min"], t["eng_max"] = 0, 3600
        self.store.save_tags(tags)
        self.hist = Historian(os.path.join(self.tmp, "h.db"))
        self.main = {e["id"]: e for e in self.store.equipment}["OP_P1A"]["run_tag"]

    def tearDown(self):
        self.hist.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_report(self):
        # 01:00-01:30 pump runs, level 2400 -> 1800; 03:00 fills to 2600; 05:00 falls to 2400 with no pump
        self.hist.log_samples([(T0 + t, self.main, 1.0 if 3600 <= t < 5400 else 0.0, "GOOD", 0) for t in range(3000, 6000, 60)])
        lvl = [(t, 2400.0) for t in range(0, 3600, 60)] + [(3600 + i * 60, 2400 - i * 20) for i in range(31)]
        lvl += [(t, 1800.0) for t in range(5520, 10800, 60)] + [(t, 2600.0) for t in range(10800, 18000, 60)]
        lvl += [(18000 + i * 60, 2600 - i * 20) for i in range(11)] + [(t, 2400.0) for t in range(18660, 20000, 60)]
        self.hist.log_samples([(T0 + t, "LT_01", v, "GOOD", 0) for t, v in lvl])

        # filtrate tank: 3000 -> 2000 mm (1000 mm) while no filtrate pump ran
        self.hist.log_samples([(T0 + 7200 + i * 60, "LT_02", 3000.0 - i * 50, "GOOD", 0) for i in range(21)])

        full = transfer.transfer_report(self.store, self.hist, T0, T0 + 86400, now=T0 + 86400)
        self.assertEqual([t["level_tag"] for t in full["tanks"]], ["LT_01", "LT_02"])           # every LT tank
        lt2 = full["tanks"][1]
        self.assertAlmostEqual(lt2["totals"]["drop_mm"], 1000, delta=1)
        self.assertEqual(lt2["drops"][0]["note"], "no filtrate pump running")
        r = full["tanks"][0]
        self.assertEqual(r["totals"]["drops"], 2)
        self.assertAlmostEqual(r["totals"]["drop_mm"], 800, delta=1)                 # 600 + 200, the 800 mm fill not subtracted
        self.assertAlmostEqual(r["totals"]["drop_pct"], 22.2, delta=0.1)             # 800 / 3600
        self.assertIsNone(r["totals"]["volume_m3"])                                  # no tank size: no m3 invented
        self.assertEqual(r["drops"][0]["pumps"], ["UG Sludge Pump to Volute Press (Main)"])
        self.assertEqual(r["drops"][1]["note"], "no sludge pump running")
        self.store.save_settings({"transfer": {"tanks": {"LT_01": {"tank_area_m2": 10}, "LT_02": {"tank_area_m2": 5}}}})
        full = transfer.transfer_report(self.store, self.hist, T0, T0 + 86400, now=T0 + 86400)
        self.assertAlmostEqual(full["tanks"][0]["totals"]["volume_m3"], 8.0, delta=0.01)   # 0.8 m x 10 m2
        self.assertAlmostEqual(full["tanks"][1]["totals"]["volume_m3"], 5.0, delta=0.01)   # 1.0 m x 5 m2

    def test_settings_validation(self):
        with self.assertRaises(ConfigError):
            self.store.save_settings({"transfer": {"tank_area_m2": -2}})
        with self.assertRaises(ConfigError):
            self.store.save_settings({"transfer": {"deadband_mm": 0.2}})
        self.store.save_settings({"transfer": {"tank_area_m2": "", "deadband_mm": "15"}})
        self.assertEqual((self.store.settings["transfer"]["tank_area_m2"], self.store.settings["transfer"]["deadband_mm"]), (None, 15.0))


if __name__ == "__main__":
    unittest.main()
