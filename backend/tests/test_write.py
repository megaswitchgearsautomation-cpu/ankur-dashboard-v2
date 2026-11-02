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


if __name__ == "__main__":
    unittest.main()
