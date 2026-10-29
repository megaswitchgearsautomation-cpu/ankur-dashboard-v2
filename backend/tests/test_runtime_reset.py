"""Run-hours reset.   python -m unittest tests.test_runtime_reset -v   (from the backend folder)"""
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from app.config_store import ConfigStore  # noqa: E402
from app.engine import Engine  # noqa: E402
from app.historian import Historian  # noqa: E402

REAL_CONFIG = os.path.join(os.path.dirname(HERE), "config")


class TestRuntimeReset(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        cfg = os.path.join(self.tmp, "config")
        os.makedirs(cfg)
        for f in ("settings.json", "tags.json", "equipment.json"):
            if os.path.exists(os.path.join(REAL_CONFIG, f)):
                shutil.copy(os.path.join(REAL_CONFIG, f), cfg)
        self.store = ConfigStore(cfg)
        self.hist = Historian(os.path.join(self.tmp, "h.db"))
        self.hist.runtime_save({"OP_P1A": {"seconds": 7200.0, "starts": 5, "sim_seconds": 10.0},
                                "OP_P2": {"seconds": 3600.0, "starts": 2, "sim_seconds": 0.0}})
        self.engine = Engine(self.store, self.hist)

    def tearDown(self):
        self.hist.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_reset_one_keeps_others_and_persists(self):
        self.engine.reset_runtime(["OP_P1A"])
        self.assertEqual(self.engine.runtime["OP_P1A"], {"seconds": 0.0, "starts": 0, "sim_seconds": 0.0})
        self.assertEqual(self.engine.runtime["OP_P2"]["seconds"], 3600.0)
        saved = self.hist.runtime_load()                     # written to the database straight away
        self.assertEqual(saved["OP_P1A"]["seconds"], 0.0)
        self.assertEqual(saved["OP_P2"]["starts"], 2)


if __name__ == "__main__":
    unittest.main()
