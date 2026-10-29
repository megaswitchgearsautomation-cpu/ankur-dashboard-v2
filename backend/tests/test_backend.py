"""Run:  python -m unittest discover -s tests -v   (from the backend folder)"""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from app import codec, delta_ah500 as dm  # noqa: E402
from app.config_store import ConfigStore  # noqa: E402
from app.engine import Engine  # noqa: E402
from app.historian import Historian  # noqa: E402
from app.modbus_tcp import ModbusException, ModbusTcpClient  # noqa: E402
from tools import fake_ah500  # noqa: E402


class TestDeltaMapping(unittest.TestCase):
    """Expected values are the end points printed in AH500 Operation Manual App. B.1."""

    def check(self, dev, dt, fc, addr, ref):
        m = dm.resolve(dev, dt)
        self.assertEqual((m.function_code, m.address, m.reference), (fc, addr, ref), dev)

    def test_manual_table_endpoints(self):
        self.check("X0.0", "BOOL", 2, 0x6000, "124577")
        self.check("X511.15", "BOOL", 2, 0x7FFF, "132768")
        self.check("X0", "UINT16", 4, 0x8000, "332769")
        self.check("X511", "UINT16", 4, 0x81FF, "333280")
        self.check("Y0.0", "BOOL", 1, 0xA000, "040961")
        self.check("Y511.15", "BOOL", 1, 0xBFFF, "049152")
        self.check("Y0", "UINT16", 3, 0xA000, "440961")
        self.check("M0", "BOOL", 1, 0x0000, "000001")
        self.check("M8191", "BOOL", 1, 0x1FFF, "008192")
        self.check("SM0", "BOOL", 1, 0x4000, "016385")
        self.check("SM2047", "BOOL", 1, 0x47FF, "018432")
        self.check("SR0", "INT16", 3, 0xC000, "449153")
        self.check("D0", "INT16", 3, 0x0000, "400001")
        self.check("D32767", "INT16", 3, 0x7FFF, "432768")
        self.check("S0", "BOOL", 1, 0x5000, "020481")
        self.check("T0", "BOOL", 1, 0xE000, "057345")
        self.check("T0", "UINT16", 3, 0xE000, "457345")
        self.check("C2047", "UINT16", 3, 0xF7FF, "463488")
        self.check("HC63", "UINT32", 3, 0xFC3F, "464576")
        self.check("E31", "INT16", 3, 0xFE1F, "465056")

    def test_project_addresses(self):
        self.check("D11008", "REAL", 3, 11008, "411009")       # CT-01 final value
        self.check("X0.8", "BOOL", 2, 0x6008, "124585")        # device number != Modbus address
        self.check("X1.0", "BOOL", 2, 0x6010, "124593")        # word*16 + bit
        self.check("Y1.12", "BOOL", 1, 0xA01C, "040989")
        m = dm.resolve("D15000.3", "BOOL")
        self.assertEqual((m.function_code, m.address, m.bit, m.access), (3, 15000, 3, "word_bit"))

    def test_rejects(self):
        for dev, dt in (("D40000", "REAL"), ("X512.0", "BOOL"), ("X0.16", "BOOL"), ("M8192", "BOOL"),
                        ("D10", "BOOL"), ("M10", "REAL"), ("Q1", "BOOL"), ("X0.1", "REAL")):
            with self.assertRaises(dm.AddressError, msg=dev):
                dm.resolve(dev, dt)

    def test_override(self):
        m = dm.from_override({"function_code": 3, "address": 40001, "base": "one"}, "INT16")
        self.assertEqual(m.address, 40000)
        m = dm.from_override({"function_code": 3, "address": 100, "base": "zero", "bit": 2}, "BOOL")
        self.assertEqual((m.address, m.bit), (100, 2))
        # full 6-digit one-based references: the table digit sets the function code
        m = dm.from_override({"function_code": 1, "address": 411009, "base": "one"}, "REAL")
        self.assertEqual((m.function_code, m.address, m.reference), (3, 11008, "411009"))
        m = dm.from_override({"function_code": 3, "address": 124585, "base": "one"}, "BOOL")
        self.assertEqual((m.function_code, m.address), (2, 0x6008))
        m = dm.from_override({"function_code": 3, "address": 332769, "base": "one"}, "UINT16")
        self.assertEqual((m.function_code, m.address), (4, 0x8000))
        with self.assertRaises(dm.AddressError):
            dm.from_override({"function_code": 3, "address": 211009, "base": "one"}, "REAL")


class TestCodec(unittest.TestCase):
    def test_real_word_orders(self):
        regs = codec.encode_registers(123.5, "REAL", "low_first")
        self.assertEqual(codec.decode_registers(regs, "REAL", "low_first"), 123.5)
        self.assertNotEqual(codec.decode_registers(regs, "REAL", "high_first") if
                            not _nan(regs[::-1]) else 0, 123.5)
        # 1.0f = 0x3F800000 -> Delta low-first registers [0x0000, 0x3F80]
        self.assertEqual(codec.decode_registers([0x0000, 0x3F80], "REAL", "low_first"), 1.0)
        self.assertEqual(codec.decode_registers([0x3F80, 0x0000], "REAL", "high_first"), 1.0)

    def test_ints(self):
        self.assertEqual(codec.decode_registers([0xFFFF], "INT16"), -1)
        self.assertEqual(codec.decode_registers([0xFFFF], "UINT16"), 65535)
        self.assertEqual(codec.decode_registers([0x0001, 0x0002], "UINT32", "low_first"), 0x00020001)
        self.assertEqual(codec.decode_registers([0xFFFE, 0xFFFF], "INT32", "low_first"), -2)
        self.assertTrue(codec.decode_registers([0b1000], "BOOL", bit=3))

    def test_scaling(self):
        sc = {"mode": "linear", "raw_min": 0, "raw_max": 32000, "eng_min": 0, "eng_max": 200}
        self.assertAlmostEqual(codec.apply_scaling(16000, sc), 100.0)
        self.assertAlmostEqual(codec.apply_scaling(10, {"mode": "gain_offset", "gain": 0.1, "offset": -1}), 0.0)


def _nan(regs):
    try:
        codec.decode_registers(regs, "REAL", "low_first")
        return False
    except codec.DecodeError:
        return True


class TestModbusEndToEnd(unittest.TestCase):
    PORT = 15020

    @classmethod
    def setUpClass(cls):
        cls.srv = fake_ah500.start(cls.PORT)
        time.sleep(0.8)

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def test_client_reads(self):
        c = ModbusTcpClient("127.0.0.1", self.PORT, 1, 2)
        regs = c.read(3, 11008, 2)
        v = codec.decode_registers(regs, "REAL", "low_first")
        self.assertTrue(30 < v < 100, v)
        self.assertTrue(c.read(2, 0x6000, 1)[0])       # X0.0
        with self.assertRaises(ModbusException):
            c.read(3, 0x9000, 1)                        # unmapped -> illegal data address
        c.close()

    def test_engine_modbus_mode(self):
        tmp = tempfile.mkdtemp()
        try:
            cfg = os.path.join(tmp, "config")
            os.makedirs(cfg)
            tags = [
                {"id": "CT_01", "name": "T1", "device": "D11008", "data_type": "REAL", "poll_ms": 200,
                 "alarm": {"enabled": True, "hi": 10, "priority": "yellow"}},
                {"id": "ESTOP", "name": "E-stop", "device": "X0.0", "data_type": "BOOL", "poll_ms": 200},
                {"id": "BAD", "name": "bad", "device": "D11008", "data_type": "REAL", "poll_ms": 200,
                 "address_override": {"enabled": True, "function_code": 3, "address": 0x9000, "base": "zero"}},
            ]
            with open(os.path.join(cfg, "tags.json"), "w") as f:
                json.dump(tags, f)
            store = ConfigStore(cfg)
            store.save_settings({"plc": {"host": "127.0.0.1", "port": self.PORT}, "source": {"mode": "modbus"}})
            hist = Historian(os.path.join(tmp, "h.sqlite3"))
            eng = Engine(store, hist)
            eng.start()
            time.sleep(1.5)
            live = {t["id"]: t for t in eng.live()}
            eng.stop()
            self.assertEqual(live["CT_01"]["quality"], "GOOD")
            self.assertIsInstance(live["CT_01"]["value"], float)
            self.assertIs(live["ESTOP"]["value"], True)
            self.assertEqual(live["BAD"]["quality"], "CONFIG_ERROR")   # isolated, others still good
            self.assertTrue(any(a["tag"] == "CT_01" for a in eng.active_alarms()))
            self.assertEqual(eng.connection()["state"], "CONNECTED")
            hist.close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_engine_comm_loss(self):
        tmp = tempfile.mkdtemp()
        try:
            cfg = os.path.join(tmp, "config")
            os.makedirs(cfg)
            with open(os.path.join(cfg, "tags.json"), "w") as f:
                json.dump([{"id": "A", "name": "a", "device": "D0", "data_type": "INT16", "poll_ms": 200}], f)
            store = ConfigStore(cfg)
            store.save_settings({"plc": {"host": "127.0.0.1", "port": 1, "timeout_ms": 300, "retries": 0},
                                 "source": {"mode": "modbus"}})
            hist = Historian(os.path.join(tmp, "h.sqlite3"))
            eng = Engine(store, hist)
            eng.start()
            time.sleep(1.0)
            con = eng.connection()
            alarms = eng.active_alarms()
            eng.stop()
            self.assertEqual(con["state"], "DISCONNECTED")
            self.assertTrue(any(a["tag"] == "_COMM" for a in alarms))
            hist.close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
