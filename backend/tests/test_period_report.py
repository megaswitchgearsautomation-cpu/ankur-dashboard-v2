"""Daily / shift reports and alarm source labels.   python -m unittest tests.test_period_report -v"""
import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from app import reports  # noqa: E402
from app.config_store import ConfigStore  # noqa: E402
from app.historian import Historian  # noqa: E402

REAL_CONFIG = os.path.join(os.path.dirname(HERE), "config")


class TestPeriodReport(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        cfg = os.path.join(self.tmp, "config")
        os.makedirs(cfg)
        for f in ("tags.json", "equipment.json"):
            shutil.copy(os.path.join(REAL_CONFIG, f), cfg)
        self.store = ConfigStore(cfg)
        self.hist = Historian(os.path.join(self.tmp, "h.db"))

    def tearDown(self):
        self.hist.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_windows_in_ist(self):
        shifts = [{"name": "A", "start": "06:00"}, {"name": "B", "start": "14:00"}, {"name": "C", "start": "22:00"}]
        _, t0, t1 = reports.period_window("daily", "2026-11-02", None, shifts)
        self.assertEqual(datetime.fromtimestamp(t0, reports.IST).strftime("%Y-%m-%d %H:%M"), "2026-11-02 00:00")
        self.assertEqual(t1 - t0, 86400)
        _, c0, c1 = reports.period_window("shift", "2026-11-02", "C", shifts)    # night shift runs into the next day
        self.assertEqual(datetime.fromtimestamp(c1, reports.IST).strftime("%Y-%m-%d %H:%M"), "2026-11-03 06:00")
        self.assertEqual(c1 - c0, 8 * 3600)
        with self.assertRaises(reports.ReportError):
            reports.period_window("shift", "2026-11-02", "Z", shifts)

    def test_stats_coverage_runtime_and_alarm_sources(self):
        _, t0, t1 = reports.period_window("shift", "2026-11-02", "A", self.store.settings["shifts"])
        # T_01: data only during the first 2 h of the 8 h shift (gap afterwards); a valid zero included
        self.hist.log_samples([(t0 + s, "T_01", 80.0 + (s % 600) / 100, "GOOD", 0) for s in range(0, 7200, 10)]
                              + [(t0 + 7200, "T_01", 0.0, "GOOD", 0)])
        run = next(e for e in self.store.equipment if e["id"] == "OP_P1A")["run_tag"]
        # logged like the engine does (every minute here): ON 0-30 min, OFF, ON 60-75 min, OFF until 2 h
        self.hist.log_samples([(t0 + s, run, 1.0 if s < 1800 or 3600 <= s < 4500 else 0.0, "GOOD", 0) for s in range(0, 7200, 60)])
        self.hist.alarm_raise("LT_01", "hi", "yellow", "LT-01 High", 3300, 3240, 0, t0 + 100)        # dashboard limit
        self.hist.alarm_raise("DI_Under_Grnd_Slud_Pmp_TO_VP_Mn_Tp", "state", "red", "Sludge pump trip", 1, None, 0, t0 + 200)
        rep = reports.period_report(self.store, self.hist, "shift", "2026-11-02", "A")
        t01 = next(v for v in rep["values"] if v["id"] == "T_01")
        self.assertEqual(t01["min"], 0.0)                                  # valid zero is a value, not missing
        self.assertAlmostEqual(t01["coverage_pct"], 25.2, places=1)       # 2 h + 1 slot of 8 h
        lt2 = next(v for v in rep["values"] if v["id"] == "LT_02")
        self.assertEqual((lt2["avg"], lt2["coverage_pct"]), (None, 0))    # no data at all: shown as missing
        p1a = next(e for e in rep["equipment"] if e["id"] == "OP_P1A")
        self.assertEqual(p1a["run_hours"], 0.75)                           # 30 min + 15 min
        self.assertEqual(rep["alarm_counts"], {"total": 2, "plc": 1, "dashboard": 1, "red": 1})
        self.assertEqual({a["source"] for a in rep["alarms"]}, {"plc", "dashboard"})
        self.assertEqual(reports.alarm_source({"tag": "_COMM", "kind": "comm_loss"}), "dashboard")
        # new: starts (OFF -> ON inside the period), trips from the trip input's alarms, utilisation, summary
        self.assertEqual((p1a["starts"], p1a["trips"]), (1, 1))            # ON at shift start is not a start; 60 min is
        self.assertAlmostEqual(p1a["utilisation_pct"], round(100 * 2700 / (8 * 3600), 1))
        self.assertEqual(rep["summary"]["trips"], 1)
        self.assertEqual(rep["summary"]["alarms"], 2)
        self.assertEqual(rep["top_alarms"][0]["count"], 1)
        # log sheet: hourly averages for an 8 h shift, the first hour has T-01 data, hour 4 has none
        self.assertEqual(len(rep["log_times"]), 8)
        self.assertIsNotNone(t01["log"][0])
        self.assertIsNone(t01["log"][4])

    def test_set_point_minutes_and_level_percent(self):
        _, t0, _t1 = reports.period_window("daily", "2026-11-02", None, self.store.settings["shifts"])
        self.hist.log_samples([(t0 + s, "T_01", 100.0 if s < 600 else 50.0, "GOOD", 0) for s in range(0, 3600, 10)])
        self.hist.log_samples([(t0 + s, "LT_01", 1800.0, "GOOD", 0) for s in range(0, 3600, 60)])
        rep = reports.period_report(self.store, self.hist, "daily", "2026-11-02", None, {"T_01_ALM_SP": 90.0})
        t01 = next(v for v in rep["values"] if v["id"] == "T_01")
        self.assertEqual((t01["set_point"], t01["minutes_above_sp"]), (90.0, 10))   # 10 minutes at 100 C
        self.assertEqual(rep["summary"]["values_above_sp"], 1)
        lt1 = next(v for v in rep["values"] if v["id"] == "LT_01")
        lo, hi = lt1["eng_min"] or 0, lt1["eng_max"]
        self.assertAlmostEqual(lt1["pct"]["avg"], round((1800 - lo) / (hi - lo) * 100, 1))
        x = reports.period_xlsx(rep)
        self.assertTrue(x.startswith(b"PK"))
        import io, zipfile
        names = zipfile.ZipFile(io.BytesIO(x)).namelist()
        self.assertIn("xl/worksheets/sheet5.xml", names)
        self.assertTrue(reports.period_filename(rep, "xlsx").startswith("Daily_report_02-11-2026"))

    def test_weekly_and_monthly_windows(self):
        title, w0, w1 = reports.period_window("weekly", "2026-11-05", None, [])       # Thursday
        self.assertEqual(datetime.fromtimestamp(w0, reports.IST).strftime("%a %Y-%m-%d %H:%M"), "Mon 2026-11-02 00:00")
        self.assertEqual(w1 - w0, 7 * 86400)
        title, m0, m1 = reports.period_window("monthly", "2026-12-15", None, [])
        self.assertEqual(title, "Monthly report December 2026")
        self.assertEqual(datetime.fromtimestamp(m1, reports.IST).strftime("%Y-%m-%d"), "2027-01-01")


    # ---- v3: start / end date window, history limits, CSV ----
    def test_range_window_titles_and_steps(self):
        title, t0, t1 = reports.range_window("daily", "2026-11-02", "2026-11-02")
        self.assertEqual(title, "Daily report 02-11-2026")
        self.assertEqual(datetime.fromtimestamp(t0, reports.IST).strftime("%Y-%m-%d %H:%M"), "2026-11-02 00:00")
        self.assertEqual(t1 - t0, 86400)                                       # end date is inclusive
        title, t0, t1 = reports.range_window("weekly", "2026-11-02", "2026-11-08")
        self.assertEqual((title, t1 - t0), ("Weekly report 02-11-2026 to 08-11-2026", 7 * 86400))
        self.assertEqual(reports.range_window("monthly", "2026-11-01", "2026-11-30")[0], "Monthly report November 2026")
        self.assertEqual(reports.range_window("custom", "2026-11-03", "2026-11-05")[0], "Report 03-11-2026 to 05-11-2026")
        for bad in (("daily", "2026-11-05", "2026-11-04"), ("shift", "2026-11-02", "2026-11-02"), ("custom", "x", "2026-11-02")):
            with self.assertRaises(reports.ReportError):
                reports.range_window(*bad)
        self.assertEqual([reports.span_step(d * 86400) for d in (1, 2, 3, 14, 15, 31)], [3600, 3600, 21600, 21600, 86400, 86400])

    def test_period_report_with_range(self):
        window = reports.range_window("custom", "2026-11-02", "2026-11-04")              # 3 days -> 6-hourly log sheet
        t0 = window[1]
        self.hist.log_samples([(t0 + s, "T_01", 70.0, "GOOD", 0) for s in range(0, 3 * 86400, 600)])
        rep = reports.period_report(self.store, self.hist, "custom", None, None, None, window=window)
        self.assertEqual(rep["title"], "Report 02-11-2026 to 04-11-2026")
        self.assertEqual((rep["log_step_s"], len(rep["log_times"])), (21600, 12))
        t01 = next(v for v in rep["values"] if v["id"] == "T_01")
        self.assertEqual((t01["avg"], t01["log"][11]), (70.0, 70.0))
        # daily kind over a single day keeps the hourly log sheet
        rep = reports.period_report(self.store, self.hist, "daily", None, None, None,
                                    window=reports.range_window("daily", "2026-11-03", "2026-11-03"))
        self.assertEqual((rep["log_step_s"], len(rep["log_times"])), (3600, 24))

    def test_history_limits(self):
        day = 86400
        now = datetime(2026, 11, 15, 12, 0, tzinfo=reports.IST).timestamp()
        hs = now - 30 * day                                                 # 30 days retention
        # starts before the history: begins on the first day that has history (00:00 IST) with a note
        t0, note = reports.limit_to_history(now - 40 * day, now - 20 * day, hs, 30, now)
        self.assertEqual(t0, reports.ist_day_start(hs))
        self.assertIn("History is available from", note)
        # entirely before the history: refused
        with self.assertRaisesRegex(reports.ReportError, "No history"):
            reports.limit_to_history(now - 40 * day, now - 35 * day, hs, 30, now)
        # longer than the history kept (+1 day): refused; within it: fine
        with self.assertRaisesRegex(reports.ReportError, "longest report period is 31 days"):
            reports.limit_to_history(now - 33 * day, now, now - 400 * day, 30, now)
        self.assertEqual(reports.limit_to_history(now - 31 * day, now, now - 400 * day, 30, now)[1], None)
        # retention is not hard-coded: 90 days kept -> capped by the performance ceiling only
        self.assertEqual(reports.max_window_days(90), reports.PERIOD_MAX_DAYS)
        self.assertEqual(reports.max_window_days(7), 8)
        with self.assertRaisesRegex(reports.ReportError, "not started"):
            reports.limit_to_history(now + 10, now + day, hs, 30, now)

    def test_period_csv(self):
        _, t0, _t1 = reports.period_window("daily", "2026-11-02", None, [])
        self.hist.log_samples([(t0 + s, "T_01", 55.5, "GOOD", 0) for s in range(0, 7200, 60)])
        self.hist.alarm_raise("T_01", "hi", "yellow", "T-01 High", 95, 90, 0, t0 + 300)
        rep = reports.period_report(self.store, self.hist, "daily", None, None, None,
                                    window=reports.range_window("daily", "2026-11-02", "2026-11-02"))
        data = reports.period_csv(rep)
        self.assertTrue(data.startswith("﻿".encode("utf-8")))
        import csv, io
        rows = list(csv.reader(io.StringIO(data.decode("utf-8-sig"))))
        self.assertEqual(rows[0], ["Daily report 02-11-2026"])
        flat = [r[0] for r in rows if r]
        for sec in ("SUMMARY", "PROCESS VALUES", "EQUIPMENT", "ALARMS"):
            self.assertIn(sec, flat)
        log_i = next(i for i, r in enumerate(rows) if r and r[0].startswith("LOG SHEET"))
        self.assertEqual(rows[log_i + 1][0], "Time (IST)")
        self.assertEqual(rows[log_i + 2][0], "02-11-2026 00:00")                 # IST, not server time
        self.assertTrue(any(r[:1] == ["02-11-2026 00:05:00"] for r in rows))     # alarm raised 00:05 IST
        self.assertEqual(reports.period_filename(rep, "csv"), "Daily_report_02-11-2026.csv")


if __name__ == "__main__":
    unittest.main()
