"""Minimal, read-only Modbus TCP client (standard library only).

Supports FC01 Read Coils, FC02 Read Discrete Inputs, FC03 Read Holding Registers,
FC04 Read Input Registers.  No write function codes are implemented on purpose:
phase 1 is read-only monitoring.
"""
from __future__ import annotations

import socket
import struct
import threading
import time

READ_FCS = (1, 2, 3, 4)
EXCEPTIONS = {
    1: "Illegal function",
    2: "Illegal data address",
    3: "Illegal data value",
    4: "Slave device failure",
    5: "Acknowledge",
    6: "Slave device busy",
    10: "Gateway path unavailable",
    11: "Gateway target device failed to respond",
}


class ModbusError(Exception):
    pass


class ModbusException(ModbusError):
    """The PLC answered with a Modbus exception code."""

    def __init__(self, fc, code):
        self.fc, self.code = fc, code
        super().__init__(f"Modbus exception {code} ({EXCEPTIONS.get(code, 'unknown')}) on FC{fc:02d}")


class ModbusTcpClient:
    def __init__(self, host: str, port: int = 502, unit_id: int = 1, timeout: float = 3.0):
        self.host, self.port, self.unit_id, self.timeout = host, int(port), int(unit_id), float(timeout)
        self._sock: socket.socket | None = None
        self._tid = 0
        self._lock = threading.Lock()

    # -- connection ---------------------------------------------------------
    def connect(self):
        self.close()
        s = socket.create_connection((self.host, self.port), timeout=self.timeout)
        s.settimeout(self.timeout)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self._sock = s

    def close(self):
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
        self._sock = None

    @property
    def connected(self):
        return self._sock is not None

    # -- reads --------------------------------------------------------------
    def read(self, fc: int, address: int, count: int):
        """Return list[bool] for FC01/02 or list[int] (0..65535) for FC03/04."""
        if fc not in READ_FCS:
            raise ModbusError(f"FC{fc} not allowed (read-only client)")
        limit = 2000 if fc in (1, 2) else 125
        if not 1 <= count <= limit:
            raise ModbusError(f"count {count} outside 1..{limit} for FC{fc:02d}")
        if not 0 <= address <= 0xFFFF or address + count - 1 > 0xFFFF:
            raise ModbusError(f"address range {address}+{count} invalid")
        pdu = struct.pack(">BHH", fc, address, count)
        resp = self._transact(pdu)
        rfc = resp[0]
        if rfc == fc | 0x80:
            raise ModbusException(fc, resp[1] if len(resp) > 1 else 0)
        if rfc != fc:
            raise ModbusError(f"Unexpected function code {rfc} in reply to FC{fc}")
        nbytes = resp[1]
        data = resp[2:2 + nbytes]
        if len(data) != nbytes:
            raise ModbusError("Short response")
        if fc in (1, 2):
            if nbytes != (count + 7) // 8:
                raise ModbusError("Bit count mismatch in response")
            return [bool((data[i // 8] >> (i % 8)) & 1) for i in range(count)]
        if nbytes != count * 2:
            raise ModbusError("Register count mismatch in response")
        return list(struct.unpack(f">{count}H", data))

    def _transact(self, pdu: bytes) -> bytes:
        with self._lock:
            if self._sock is None:
                self.connect()
            self._tid = (self._tid + 1) & 0xFFFF
            tid = self._tid
            mbap = struct.pack(">HHHB", tid, 0, len(pdu) + 1, self.unit_id)
            try:
                self._sock.sendall(mbap + pdu)
                while True:
                    head = self._recv_exact(7)
                    rtid, proto, length, _unit = struct.unpack(">HHHB", head)
                    body = self._recv_exact(length - 1)
                    if proto != 0:
                        raise ModbusError("Bad protocol id in response")
                    if rtid == tid:
                        return body
                    # stale reply from an earlier timed-out request: discard and keep reading
            except (OSError, ModbusError):
                self.close()
                raise

    def _recv_exact(self, n: int) -> bytes:
        buf = b""
        while len(buf) < n:
            chunk = self._sock.recv(n - len(buf))
            if not chunk:
                raise ModbusError("Connection closed by peer")
            buf += chunk
        return buf


def probe(host, port, unit_id, timeout=3.0):
    """Quick connectivity check: TCP connect + read D0 (FC03 @ 0)."""
    t0 = time.perf_counter()
    c = ModbusTcpClient(host, port, unit_id, timeout)
    try:
        c.connect()
        t_conn = (time.perf_counter() - t0) * 1000
        regs = c.read(3, 0, 1)
        return {"ok": True, "tcp_ms": round(t_conn, 1), "total_ms": round((time.perf_counter() - t0) * 1000, 1),
                "sample": {"D0": regs[0]}}
    finally:
        c.close()
