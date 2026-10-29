"""Report generation tests (synthetic history)."""
import io
import os
import shutil
import sys
import tempfile
import time
import unittest
import xml.etree.ElementTree as ET
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from app import reports  # noqa: E402
from app.config_store import ConfigStore  # noqa: E402
from app.historian import Historian  # noqa: E402


class TestReports(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        shutil.copytree(os.path.join(os.path.dirname(HERE), "config"), os.path.join(cls.tmp, "config"),
                        ignore=shutil.ignore_patterns("settings.json"))
        cls.store = ConfigStore(os.path.join(cls.tmp, "config"))
        cls.hist = Historian(os.path.join(cls.tmp, "h.sqlite3"))
        cls.t1 = time.time()
        cls.t0 = cls.t1 - 6 * 3600
        tags = [t["id"] for t in reports.reportable_tags(cls.store)]
        rows = []
        for k in range(0, 6 * 3600, 60):
            for i, tid in enumerate(tags):
                rows.append((cls.t0 + k, tid, 10.0 * i + (k % 600) / 60, "SIMULATED", 1))
        rows.append((cls.t0 + 30, "DI_Emergency_Sp_Pb", 1.0, "GOOD", 0))   # not reportable
        cls.hist.log_samples(rows)

    @classmethod
    def tearDownClass(cls):
        cls.hist.close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def rep(self, interval=900, ids=()):
        return reports.build(self.store, self.hist, list(ids), self.t0, self.t1, interval)

    def test_build(self):
        r = self.rep()
        self.assertTrue(r["simulated"])
        self.assertEqual(len(r["columns"]), 11)                        # T-01..04, LT-01/02, PH-01, PT-01..04
        self.assertGreaterEqual(len(r["rows"]), 24)
        self.assertEqual([c["id"] for c in r["columns"]][:2], ["LT_01", "LT_02"])
        s = {x["id"]: x for x in r["summary"]}
        self.assertAlmostEqual(s["LT_01"]["min"], 0.0)
        self.assertAlmostEqual(s["LT_01"]["max"], 9.0)

    def test_only_reportable_tags(self):
        r = self.rep(ids=["DI_Emergency_Sp_Pb", "T_01_ALM_SP", "T_01"])
        self.assertEqual([c["id"] for c in r["columns"]], ["T_01"])

    def test_limits(self):
        with self.assertRaises(reports.ReportError):
            reports.build(self.store, self.hist, [], self.t0, self.t0 - 1, 900)
        with self.assertRaises(reports.ReportError):
            reports.build(self.store, self.hist, [], self.t1 - 30 * 86400, self.t1, 60)   # too many rows

    def test_alarm_notes_per_source(self):
        h = self.hist
        h.add_alarm_note("OP_P1A_TRIP", "state", 1, "Over-voltage, SPP relay reset", "ankur", 100.0)
        h.add_alarm_note("OP_P1A_TRIP", "state", 2, "Overload, MPCB reset", "ankur", 200.0)
        h.add_alarm_note("T_01", "hi", 3, "Cooling water low", "ankur", 150.0)
        n = h.alarm_notes([("OP_P1A_TRIP", "state"), ("T_01", "hi"), ("X", "state")])
        self.assertEqual([x["note"] for x in n[("OP_P1A_TRIP", "state")]], ["Overload, MPCB reset", "Over-voltage, SPP relay reset"])
        self.assertEqual(len(n[("T_01", "hi")]), 1)
        self.assertEqual(n[("X", "state")], [])

    def test_xlsx(self):
        data = reports.to_xlsx(self.rep())
        z = zipfile.ZipFile(io.BytesIO(data))
        for name in z.namelist():
            if name.endswith(".xml") or name.endswith(".rels"):
                ET.fromstring(z.read(name))                              # well-formed
        sheet = z.read("xl/worksheets/sheet1.xml")
        self.assertNotIn("xl/worksheets/sheet2.xml", z.namelist())       # data log only
        self.assertIn(b"DEMO DATA", sheet)
        self.assertIn(b"Date / time", sheet)
        self.assertNotIn(b"Minimum", sheet)

    def test_pdf(self):
        data = reports.to_pdf(self.rep(interval=300))
        self.assertTrue(data.startswith(b"%PDF-1.4"))
        try:
            from pypdf import PdfReader
        except ImportError:
            self.skipTest("pypdf not installed")
        rd = PdfReader(io.BytesIO(data))
        self.assertGreaterEqual(len(rd.pages), 2)                         # 72 rows at 5 min -> 2 pages
        txt = rd.pages[0].extract_text()
        self.assertIn("Process Data Report", txt)
        self.assertIn("DEMO DATA", txt)
        self.assertIn("Data log", txt)                                    # data log starts on page 1
        self.assertNotIn("Summary", txt)


if __name__ == "__main__":
    unittest.main()
