"""Modbus FC16 write (HMI level set points).   python -m unittest tests.test_write -v   (from the backend folder)"""
import os
import socket
import struct
import sys
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from app import codec  # noqa: E402
from app.modbus_tcp import ModbusTcpClient, ModbusException  # noqa: E402


class FakePlc(threading.Thread):
    """Holding registers only: FC03 read, FC16 write (address 13030 refused with exception 2)."""
    def __init__(self):
        super().__init__(daemon=True)
        self.regs = {}
        self.srv = socket.socket()
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(1)
        self.port = self.srv.getsockname()[1]

    def run(self):
        conn, _ = self.srv.accept()
        while True:
            head = conn.recv(7)
            if len(head) < 7:
                return
            tid, _, length, unit = struct.unpack(">HHHB", head)
            pdu = conn.recv(length - 1)
            fc = pdu[0]
            if fc == 16:
                addr, count, _nb = struct.unpack(">HHB", pdu[1:6])
                if addr == 13030:
                    resp = bytes([0x90, 2])
                else:
                    for i, v in enumerate(struct.unpack(f">{count}H", pdu[6:6 + 2 * count])):
                        self.regs[addr + i] = v
                    resp = struct.pack(">BHH", 16, addr, count)
            else:
                addr, count = struct.unpack(">HH", pdu[1:5])
                vals = [self.regs.get(addr + i, 0) for i in range(count)]
                resp = struct.pack(f">BB{count}H", 3, count * 2, *vals)
            conn.sendall(struct.pack(">HHHB", tid, 0, len(resp) + 1, unit) + resp)


class TestWrite(unittest.TestCase):
    def test_fc16_round_trip(self):
        plc = FakePlc()
        plc.start()
        c = ModbusTcpClient("127.0.0.1", plc.port, 1, 2.0)
        regs = codec.encode_registers(27000, "UINT32", "low_first")       # 2700.0 mm, stored x10
        c.write_registers(13036, regs)
        back = c.read(3, 13036, 2)
        self.assertEqual(back, regs)
        self.assertAlmostEqual(codec.apply_scaling(codec.decode_registers(back, "UINT32", "low_first"),
                                                   {"mode": "gain_offset", "gain": 0.1, "offset": 0}), 2700.0)
        with self.assertRaises(ModbusException):
            c.write_registers(13030, [1, 0])
        c.close()

    def test_implausible_current_value_blocks_write(self):
        """A set point read with the wrong data type decodes to garbage: never write on top of it."""
        from app.server import implausible_current
        t = {"eng_min": 0, "eng_max": 100, "unit": "%"}
        self.assertIsNone(implausible_current(t, 66.7))
        self.assertIsNone(implausible_current(t, 0.0))                       # a real zero is fine
        dword_as_real = codec.decode_registers([667, 0], "REAL", "low_first")  # 66.7 % stored x10, read as REAL
        self.assertIn("wrong data type", implausible_current(t, dword_as_real))
        self.assertIn("far outside", implausible_current(t, 1.2e9))
        self.assertIn("No value", implausible_current(t, None))
        rng = {"eng_min": 0, "eng_max": 600, "write_min": -6000, "write_max": 6600}   # range register: display 0-600
        self.assertIsNone(implausible_current(rng, 3600.0))                            # PLC holds 3600: still sane
        self.assertIn("not a number", implausible_current(t, float("nan")))

    def test_alarm_setpoint_write_through_engine(self):
        """Real tags.json, Modbus mode against the bench PLC: T-01 alarm SP written as DWORD x10 and read back."""
        import shutil
        import tempfile
        import time
        from app.config_store import ConfigStore
        from app.engine import Engine
        from app.historian import Historian
        from tools import fake_ah500
        port = 15077
        srv = fake_ah500.start(port)
        tmp = tempfile.mkdtemp()
        try:
            cfg = os.path.join(tmp, "config")
            os.makedirs(cfg)
            for f in ("tags.json", "equipment.json"):
                shutil.copy(os.path.join(os.path.dirname(HERE), "config", f), cfg)
            store = ConfigStore(cfg)
            store.save_settings({"plc": {"host": "127.0.0.1", "port": port, "timeout_ms": 1000, "retries": 0},
                                 "source": {"mode": "modbus"}})
            hist = Historian(os.path.join(tmp, "h.sqlite3"))
            eng = Engine(store, hist)
            eng.start()
            try:
                for _ in range(80):
                    st = eng.states.get("T_01_ALM_SP")
                    if st is not None and st.value is not None and eng.connection()["state"] == "CONNECTED":
                        break
                    time.sleep(0.1)
                self.assertAlmostEqual(eng.states["T_01_ALM_SP"].value, 150.0)          # 1500 raw -> 150.0 °C
                res = eng.write_value("T_01_ALM_SP", 165.5)
                self.assertEqual((res["value"], res["simulated"]), (165.5, False))       # read back from the PLC
                self.assertEqual(fake_ah500.HOLD[13000:13002], [1655, 0])               # DWORD x10, low word first
                with self.assertRaises(ValueError):
                    eng.write_value("T_01_ALM_SP", 250)                                   # outside 0..200 °C
                with self.assertRaises(ValueError):
                    eng.write_value("T_01", 10)                                           # a measurement is never writable
                # PLC scaling range of LT-01 (Instruments page "Edit range"): REAL at D11062 / D11060, read back
                self.assertEqual(eng.write_value("LT_01_RMAX", 3000.0)["value"], 3000.0)
                self.assertEqual(eng.write_value("LT_01_RMIN", 100.0)["value"], 100.0)
                self.assertEqual(codec.decode_registers(fake_ah500.HOLD[11062:11064], "REAL", "low_first"), 3000.0)
                self.assertEqual(codec.decode_registers(fake_ah500.HOLD[11060:11062], "REAL", "low_first"), 100.0)
                # HMI soft selector M6000 (sludge pumps Auto/Manual): FC05, read back with FC01
                self.assertEqual(eng.write_value("SEL_AM_SLUDGE", True)["value"], True)
                self.assertTrue(fake_ah500.COILS[6000])
                self.assertEqual(eng.write_value("SEL_AM_SLUDGE", False)["value"], False)
                self.assertFalse(fake_ah500.COILS[6000])
                with self.assertRaises(ValueError):
                    eng.write_value("SEL_AM_SLUDGE", 1.0)                                 # ON / OFF only
                with self.assertRaises(ValueError):
                    eng.write_value("DI_Under_Grnd_Slud_Pmp_TO_VP_Mn_Rn", True)          # a field input is never writable
            finally:
                eng.stop()
                hist.close()
        finally:
            fake_ah500.stop(srv)
            shutil.rmtree(tmp, ignore_errors=True)

    def test_demo_set_points_survive_restart(self):
        """Demo mode: a set point / selector written from the dashboard is still there after a restart."""
        import shutil
        import tempfile
        from app.config_store import ConfigStore
        from app.engine import Engine
        from app.historian import Historian
        tmp = tempfile.mkdtemp()
        try:
            cfg = os.path.join(tmp, "config")
            os.makedirs(cfg)
            for f in ("tags.json", "equipment.json"):
                shutil.copy(os.path.join(os.path.dirname(HERE), "config", f), cfg)
            store = ConfigStore(cfg)
            store.save_settings({"source": {"mode": "simulation"}})
            hist = Historian(os.path.join(tmp, "h.sqlite3"))
            try:
                eng = Engine(store, hist)
                self.assertEqual(eng.write_value("T_01_ALM_SP", 17.0)["value"], 17.0)
                eng.write_value("SEL_AM_SLUDGE", True)
                t01 = store.tag_map()["T_01_ALM_SP"]
                again = Engine(ConfigStore(cfg), hist)                              # dashboard restarted
                self.assertEqual(again._sim_analog(t01, 0.0, 0.0), 17.0)            # not the 170 default
                self.assertIs(again._sim_override.get("SEL_AM_SLUDGE"), True)
            finally:
                hist.close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
