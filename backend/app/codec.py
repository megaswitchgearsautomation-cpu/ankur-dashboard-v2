"""Decode raw Modbus data into engineering values.

Byte / word order
-----------------
Modbus transmits every 16-bit register big-endian (high byte first).  Delta PLCs
store 32-bit values (DINT / REAL, e.g. DMOV into D11008) with the LOW word in the
lower device number (D11008 = low word, D11009 = high word).  That is the default
here ("low_first", sometimes written CDAB).  "high_first" (ABCD) is available for
gateways that re-order words.  Verify per tag with the admin Test Read button.
"""
from __future__ import annotations

import math
import struct

DATA_TYPES = {
    # name: registers used
    "BOOL": 1,
    "INT16": 1,
    "UINT16": 1,
    "INT32": 2,
    "UINT32": 2,
    "REAL": 2,
}
WORD_ORDERS = ("low_first", "high_first")


class DecodeError(ValueError):
    pass


def register_count(data_type: str) -> int:
    dt = (data_type or "").upper()
    if dt not in DATA_TYPES:
        raise DecodeError(f"Unknown data type '{data_type}'. Use one of {', '.join(DATA_TYPES)}")
    return DATA_TYPES[dt]


def decode_registers(regs, data_type: str, word_order: str = "low_first", bit: int | None = None):
    """regs: list of 16-bit ints as received (each already big-endian decoded)."""
    dt = data_type.upper()
    if bit is not None:
        return bool((regs[0] >> bit) & 1)
    if dt == "BOOL":
        return bool(regs[0])
    if dt == "UINT16":
        return regs[0] & 0xFFFF
    if dt == "INT16":
        return struct.unpack(">h", struct.pack(">H", regs[0] & 0xFFFF))[0]
    if len(regs) < 2:
        raise DecodeError(f"{dt} needs 2 registers")
    if word_order not in WORD_ORDERS:
        raise DecodeError(f"word order must be one of {WORD_ORDERS}")
    lo, hi = (regs[0], regs[1]) if word_order == "low_first" else (regs[1], regs[0])
    raw = struct.pack(">HH", hi & 0xFFFF, lo & 0xFFFF)
    if dt == "UINT32":
        return struct.unpack(">I", raw)[0]
    if dt == "INT32":
        return struct.unpack(">i", raw)[0]
    if dt == "REAL":
        v = struct.unpack(">f", raw)[0]
        if math.isnan(v) or math.isinf(v):
            raise DecodeError("REAL decoded to NaN/Inf - check word order / data type")
        return v
    raise DecodeError(f"Unsupported data type {dt}")


def encode_registers(value, data_type: str, word_order: str = "low_first"):
    """Inverse of decode_registers (used by the simulator & tests only)."""
    dt = data_type.upper()
    if dt in ("BOOL", "UINT16"):
        return [int(value) & 0xFFFF]
    if dt == "INT16":
        return [struct.unpack(">H", struct.pack(">h", int(value)))[0]]
    fmt = {"UINT32": ">I", "INT32": ">i", "REAL": ">f"}[dt]
    hi, lo = struct.unpack(">HH", struct.pack(fmt, value if dt == "REAL" else int(value)))
    return [lo, hi] if word_order == "low_first" else [hi, lo]


def apply_scaling(raw, scaling: dict | None):
    """Return engineering value from raw numeric value."""
    if isinstance(raw, bool) or not scaling:
        return raw
    mode = scaling.get("mode", "none")
    if mode == "none":
        return raw
    if mode == "linear":
        r0, r1 = float(scaling["raw_min"]), float(scaling["raw_max"])
        e0, e1 = float(scaling["eng_min"]), float(scaling["eng_max"])
        if r1 == r0:
            raise DecodeError("linear scaling: raw_min == raw_max")
        v = e0 + (float(raw) - r0) * (e1 - e0) / (r1 - r0)
        if scaling.get("clamp"):
            v = max(min(e0, e1), min(max(e0, e1), v))
        return v
    if mode == "gain_offset":
        return float(raw) * float(scaling.get("gain", 1)) + float(scaling.get("offset", 0))
    raise DecodeError(f"Unknown scaling mode '{mode}'")


def unscale(eng, scaling: dict | None):
    """Inverse scaling (simulator only)."""
    if not scaling or scaling.get("mode", "none") == "none":
        return eng
    if scaling["mode"] == "linear":
        r0, r1 = float(scaling["raw_min"]), float(scaling["raw_max"])
        e0, e1 = float(scaling["eng_min"]), float(scaling["eng_max"])
        return r0 + (eng - e0) * (r1 - r0) / (e1 - e0)
    return (eng - float(scaling.get("offset", 0))) / float(scaling.get("gain", 1) or 1)
