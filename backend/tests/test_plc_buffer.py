"""PLC trend buffer backfill.   python -m unittest tests.test_plc_buffer -v   (from the backend folder)"""
import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from app import plc_buffer as pb  # noqa: E402
from app.historian import Historian  # noqa: E402


class FakePlc:
    """D registers as a dict; writes records the way plc/trend_buffer.st does."""

    def __init__(self, cap=1050, interval=2):
        self.mem = {}
        self.cap = cap
        hdr = [pb.MAGIC, interval, cap, 0, 0, 0, pb.REC_LEN, len(pb.CHANNELS), 1]
        for i, w in enumerate(hdr):
            self.mem[pb.HEADER + i] = w
        self.reads = 0

    def log(self, when: datetime, values):
        nxt = self.mem[pb.HEADER + 3]
        base = pb.RECORDS + nxt * pb.REC_LEN
        self.mem[base] = when.day * 2048 + when.hour * 60 + when.minute
        for k, ((_, scale), v) in enumerate(zip(pb.CHANNELS, values)):
            self.mem[base + 1 + k] = 0xFFFF if v is None else int(round(v * scale))
        self.mem[pb.HEADER + 3] = (nxt + 1) % self.cap
        total = (self.mem[pb.HEADER + 4] | (self.mem[pb.HEADER + 5] << 16)) + 1
        self.mem[pb.HEADER + 4], self.mem[pb.HEADER + 5] = total & 0xFFFF, total >> 16

    def read(self, start, count):
        self.reads += 1
        assert count <= 120
        return [self.mem.get(start + i, 0) for i in range(count)]


VALS = [101.5, 102.0, 95.0, 78.2, 2496.3, 1700.0, 7.25, 4.5, 3.2, 3.31, 2.9]


class TestPlcBuffer(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.hist = Historian(os.path.join(self.tmp, "h.db"))

    def tearDown(self):
        self.hist.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_record_time_month_boundary(self):
        now = datetime(2026, 11, 2, 9, 0)
        self.assertEqual(pb.record_time(31 * 2048 + 23 * 60 + 58, now), datetime(2026, 10, 31, 23, 58))
        self.assertEqual(pb.record_time(2 * 2048 + 8 * 60 + 30, now), datetime(2026, 11, 2, 8, 30))
        self.assertIsNone(pb.record_time(0, now))

    def test_backfill_fills_gap_and_skips_existing(self):
        plc = FakePlc()
        now = datetime(2026, 11, 4, 10, 0)
        for m in range(0, 120, 2):                       # 08:00 - 09:58, every 2 minutes
            plc.log(datetime(2026, 11, 4, 8, 0) + timedelta(minutes=m), VALS)
        # the laptop was on 09:00 - 09:58: the historian already has T_01 for that hour
        on = datetime(2026, 11, 4, 9, 0).timestamp()
        self.hist.log_samples([(on + s, "T_01", 100.0, "GOOD", 0) for s in range(0, 3600, 5)])
        bf = pb.Backfiller(self.hist)
        added = bf.run(plc.read, now.timestamp())
        self.assertEqual(bf.info["records"], 60)
        self.assertEqual(bf.info["interval_min"], 2)
        # 60 records x 11 channels, minus the 30 T_01 records of 09:00-09:58 that already exist
        self.assertEqual(added, 60 * 11 - 30)
        pts = self.hist.trend("LT_01", datetime(2026, 11, 4, 8, 0).timestamp() - 30, now.timestamp(), 60)
        self.assertTrue(pts and abs(pts[0]["avg"] - 2496.3) < 0.01)
        ph = self.hist.trend("PH_01", datetime(2026, 11, 4, 8, 0).timestamp() - 30, now.timestamp(), 60)
        self.assertAlmostEqual(ph[0]["avg"], 7.25)
        self.assertEqual(bf.run(plc.read, now.timestamp() + 400), 0)    # second run adds nothing

    def test_ring_wraps_and_no_value(self):
        plc = FakePlc(cap=10)
        start = datetime(2026, 11, 4, 6, 0)
        vals = list(VALS)
        vals[3] = None                                   # T-04 not available
        for i in range(25):                              # 25 records into a 10-slot ring: keeps the newest 10
            plc.log(start.replace(minute=i * 2), vals)
        bf = pb.Backfiller(self.hist)
        bf.run(plc.read, datetime(2026, 11, 4, 7, 0).timestamp())
        self.assertEqual(bf.info["records"], 10)
        self.assertEqual(datetime.fromtimestamp(bf.info["oldest"]), start.replace(minute=30))
        self.assertEqual(self.hist.sample_times("T_04", 0, 2e9), [])

    def test_buffer_missing(self):
        bf = pb.Backfiller(self.hist)
        self.assertEqual(bf.run(lambda s, c: [0] * c, 1793760000.0), 0)
        self.assertEqual(bf.info["state"], "not found")


if __name__ == "__main__":
    unittest.main()
