"""Bench-test Modbus TCP server that imitates the AH500 address layout.

NOT a PLC.  Use it to exercise the backend's Modbus path (mode = 'modbus') before
the real AHCPU521-EN is reachable.  Values it serves are fake.

    python tools/fake_ah500.py --port 1502
Then in Admin set host 127.0.0.1, port 1502, mode 'modbus'.
"""
import argparse
import math
import os
import socketserver
import struct
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app import codec  # noqa: E402

HOLD = [0] * 65536      # FC03: D (0000-7FFF), Y words (A000), SR (C000), T/C words ...
INREG = [0] * 65536     # FC04: X words (8000-81FF)
COILS = [False] * 65536  # FC01: M (0000), SM (4000), S (5000), Y bits (A000-BFFF), T/C bits
DISC = [False] * 65536   # FC02: X bits (6000-7FFF)
LOCK = threading.Lock()
VALID = {
    1: [(0x0000, 0x1FFF), (0x4000, 0x47FF), (0x5000, 0x57FF), (0xA000, 0xBFFF), (0xE000, 0xE7FF), (0xF000, 0xF7FF),
        (0xFC00, 0xFC3F)],
    2: [(0x6000, 0x7FFF)],
    3: [(0x0000, 0x7FFF), (0xA000, 0xA1FF), (0xC000, 0xC7FF), (0xE000, 0xE7FF), (0xF000, 0xF7FF), (0xFC00, 0xFC3F),
        (0xFE00, 0xFE1F)],
    4: [(0x8000, 0x81FF)],
}


def put_real(d, value):
    lo, hi = codec.encode_registers(value, "REAL", "low_first")   # Delta: low word at lower D
    HOLD[d], HOLD[d + 1] = lo, hi


def set_x(word, bit, v):
    DISC[0x6000 + word * 16 + bit] = v
    w = INREG[0x8000 + word]
    INREG[0x8000 + word] = (w | (1 << bit)) if v else (w & ~(1 << bit))


def set_y(word, bit, v):
    COILS[0xA000 + word * 16 + bit] = v
    w = HOLD[0xA000 + word]
    HOLD[0xA000 + word] = (w | (1 << bit)) if v else (w & ~(1 << bit))


def updater():
    while True:
        t = time.time()
        with LOCK:
            for i in range(24):                       # analog finals D11008 + 10*i
                put_real(11008 + 10 * i, 60 + 25 * math.sin(t / 60 + i) + i)
                put_real(13000 + 6 * i, 150.0)        # alarm set points
            HOLD[15000] = 0b0000_0000_0000_0010 if int(t / 30) % 2 else 0   # CT-02 alarm bit toggles
            set_x(0, 0, True)                         # E-stop NC healthy
            for k in range(8, 16, 2):                 # run feedbacks
                set_x(0, k, int(t / 20 + k) % 3 != 0)
            set_y(0, 0, True)
            set_y(0, 1, False)
        time.sleep(0.5)


CLIENTS = set()     # open client sockets (closed by stop() to imitate a cable unplug / PLC power-off)


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        s = self.request
        CLIENTS.add(s)
        try:
            self._serve(s)
        finally:
            CLIENTS.discard(s)

    def _serve(self, s):
        while True:
            head = self._recv(7)
            if not head:
                return
            tid, proto, length, unit = struct.unpack(">HHHB", head)
            pdu = self._recv(length - 1)
            if not pdu:
                return
            fc = pdu[0]
            if fc not in (1, 2, 3, 4):
                resp = bytes([fc | 0x80, 1])
            else:
                addr, cnt = struct.unpack(">HH", pdu[1:5])
                ok = any(lo <= addr and addr + cnt - 1 <= hi for lo, hi in VALID[fc])
                if not ok:
                    resp = bytes([fc | 0x80, 2])
                else:
                    with LOCK:
                        if fc in (1, 2):
                            src = COILS if fc == 1 else DISC
                            bits = src[addr:addr + cnt]
                            data = bytearray((cnt + 7) // 8)
                            for i, b in enumerate(bits):
                                if b:
                                    data[i // 8] |= 1 << (i % 8)
                            resp = bytes([fc, len(data)]) + bytes(data)
                        else:
                            src = HOLD if fc == 3 else INREG
                            regs = src[addr:addr + cnt]
                            resp = bytes([fc, cnt * 2]) + struct.pack(f">{cnt}H", *regs)
            s.sendall(struct.pack(">HHHB", tid, 0, len(resp) + 1, unit) + resp)

    def _recv(self, n):
        buf = b""
        while len(buf) < n:
            try:
                c = self.request.recv(n - len(buf))
            except OSError:
                return None
            if not c:
                return None
            buf += c
        return buf


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def start(port=1502, host="127.0.0.1"):
    threading.Thread(target=updater, daemon=True).start()
    srv = Server((host, port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def stop(srv):
    """Stop listening AND drop every open connection - like unplugging the PLC."""
    srv.shutdown()
    srv.server_close()
    for s in list(CLIENTS):
        try:
            s.shutdown(2)
            s.close()
        except OSError:
            pass
    CLIENTS.clear()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=1502)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()
    start(a.port, a.host)
    print(f"Fake AH500 Modbus server on {a.host}:{a.port} (bench test only). Ctrl+C to stop.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
