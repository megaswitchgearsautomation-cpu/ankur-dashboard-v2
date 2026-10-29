"""Delta AH500 device -> Modbus address mapping.

Source (verified): Delta "AH500 Operation Manual", Appendix B.1 "Device Addresses",
table "Standard Modbus addresses of devices". Relevant rows:

    Device Type  Range              Modbus ref (decimal) AH500 address (hex)
    X      Bit   X0.0~X511.15       124577~132768        6000~7FFF
    X      Word  X0~X511            332769~333280        8000~81FF
    Y      Bit   Y0.0~Y511.15       040961~049152        A000~BFFF
    Y      Word  Y0~Y511            440961~441472        A000~A1FF
    M      Bit   M0~M8191           000001~008192        0000~1FFF
    SM     Bit   SM0~SM2047         016385~018432        4000~47FF
    SR     Word  SR0~SR2047         449153~451200        C000~C7FF
    D      Word  D0~D32767          400001~432768        0000~7FFF
    S      Bit   S0~S2047           020481~022528        5000~57FF
    T      Bit   T0~T2047           057345~059392        E000~E7FF
    T      Word  T0~T2047           457345~459392        E000~E7FF
    C      Bit   C0~C2047           061441~063488        F000~F7FF
    C      Word  C0~C2047           461441~463488        F000~F7FF
    HC     Bit   HC0~HC63           064513~064576        FC00~FC3F
    HC     DWord HC0~HC63           464513~464576        FC00~FC3F
    E      Word  E0~E31             465025~465056        FE00~FE1F

Reading the table:
  * The hex column is the ZERO-BASED protocol (PDU) address sent on the wire.
  * The decimal column is the classic ONE-BASED reference: leading digit = table
    (0 = coil, 1 = discrete input, 3 = input register, 4 = holding register),
    remaining five digits = zero-based address + 1.
    e.g. X0.0 -> 124577 = 1xxxxx table, 0x6000 (24576) + 1.
  * Therefore the PLC device number is NOT the Modbus address for X, Y, SM, SR,
    S, T, C, HC, E (they carry an offset).  Only M and D start at 0.
  * X bits are read with FC02 (discrete inputs); X words with FC04 (input regs).
  * Y/M/SM/S/T/C/HC bits are coils (FC01). Y/D/SR/T/C/HC/E words are holding
    registers (FC03).
  * X/Y bit address = base + word * 16 + bit   (X0.0 = 6000h, X1.0 = 6010h).
  * A bit inside a word device (e.g. D15000.3) is read as holding register
    D15000 (FC03) and bit 3 is extracted in software.

This module is read-only: it only ever produces READ function codes.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, asdict

# table id -> (function code, reference prefix, description)
TABLES = {
    "coil": (1, 0, "Coil (0x)"),
    "discrete_input": (2, 1, "Discrete input (1x)"),
    "input_register": (4, 3, "Input register (3x)"),
    "holding_register": (3, 4, "Holding register (4x)"),
}

# device -> {access: (table, base, max_index)}
# For X/Y bit access max_index is the max WORD number (bits 0..15 each).
DEVICE_MAP = {
    "X": {"bit": ("discrete_input", 0x6000, 511), "word": ("input_register", 0x8000, 511)},
    "Y": {"bit": ("coil", 0xA000, 511), "word": ("holding_register", 0xA000, 511)},
    "M": {"bit": ("coil", 0x0000, 8191)},
    "SM": {"bit": ("coil", 0x4000, 2047)},
    "SR": {"word": ("holding_register", 0xC000, 2047)},
    "D": {"word": ("holding_register", 0x0000, 32767)},
    "S": {"bit": ("coil", 0x5000, 2047)},
    "T": {"bit": ("coil", 0xE000, 2047), "word": ("holding_register", 0xE000, 2047)},
    "C": {"bit": ("coil", 0xF000, 2047), "word": ("holding_register", 0xF000, 2047)},
    "HC": {"bit": ("coil", 0xFC00, 63), "dword": ("holding_register", 0xFC00, 63)},
    "E": {"word": ("holding_register", 0xFE00, 31)},
}

_DEV_RE = re.compile(r"^\s*(SM|SR|HC|X|Y|M|D|S|T|C|E)\s*(\d+)(?:\.(\d+))?\s*$", re.I)


class AddressError(ValueError):
    pass


@dataclass
class ModbusAddress:
    device: str            # normalised device text, e.g. "D11008", "X0.8", "D15000.3"
    device_type: str       # X, Y, M, D ...
    index: int             # device number (word number for X/Y/D-bit)
    bit: int | None        # bit position inside the word (X/Y bit or word-bit), else None
    access: str            # "bit" (native bit device), "word", "dword", "word_bit"
    table: str             # coil / discrete_input / input_register / holding_register
    function_code: int     # 1, 2, 3 or 4  (read only)
    address: int           # ZERO-BASED protocol address (what goes on the wire)
    reference: str         # ONE-BASED 6-digit reference, e.g. "411009"
    hex: str               # zero-based address in hex, e.g. "0x2B00"
    is_bit_table: bool     # True when the read returns bits (FC01/FC02)

    def to_dict(self):
        return asdict(self)


def parse_device(text: str):
    m = _DEV_RE.match(text or "")
    if not m:
        raise AddressError(f"Unrecognised Delta device '{text}'. Use forms like X0.8, Y1.4, M100, D11008, D15000.3")
    dev, idx, bit = m.group(1).upper(), int(m.group(2)), m.group(3)
    return dev, idx, (int(bit) if bit is not None else None)


def resolve(device: str, data_type: str = "BOOL") -> ModbusAddress:
    """Map a Delta AH500 device to its Modbus read address.

    data_type decides bit vs word access for devices that exist in both forms
    (X, Y, T, C, HC).  BOOL -> bit access; anything else -> word access.
    """
    dev, idx, bit = parse_device(device)
    spec = DEVICE_MAP[dev]
    wants_bit = (data_type or "BOOL").upper() == "BOOL"

    if dev in ("X", "Y"):
        if bit is not None:
            if bit > 15:
                raise AddressError(f"{device}: bit must be 0..15")
            table, base, max_word = spec["bit"]
            if idx > max_word:
                raise AddressError(f"{device}: word {idx} outside {dev}0~{dev}{max_word}")
            if not wants_bit:
                raise AddressError(f"{device}: bit device needs data type BOOL")
            addr = base + idx * 16 + bit
            return _build(f"{dev}{idx}.{bit}", dev, idx, bit, "bit", table, addr)
        table, base, max_word = spec["word"]
        if idx > max_word:
            raise AddressError(f"{device}: word {idx} outside {dev}0~{dev}{max_word}")
        if wants_bit:
            raise AddressError(f"{device}: word access needs a word data type, or give a bit e.g. {dev}{idx}.0")
        return _build(f"{dev}{idx}", dev, idx, None, "word", table, base + idx)

    if bit is not None:
        # bit inside a word device, e.g. D15000.3 -> read D15000 and take bit 3
        if "word" not in spec:
            raise AddressError(f"{device}: {dev} is a bit device; '.bit' syntax not allowed")
        if bit > 15:
            raise AddressError(f"{device}: bit must be 0..15")
        table, base, max_idx = spec["word"]
        _check(device, dev, idx, max_idx)
        return _build(f"{dev}{idx}.{bit}", dev, idx, bit, "word_bit", table, base + idx)

    if wants_bit:
        if "bit" not in spec:
            raise AddressError(f"{device}: {dev} is a word device; use BOOL with a bit, e.g. {dev}{idx}.0")
        table, base, max_idx = spec["bit"]
        _check(device, dev, idx, max_idx)
        return _build(f"{dev}{idx}", dev, idx, None, "bit", table, base + idx)

    key = "word" if "word" in spec else ("dword" if "dword" in spec else None)
    if key is None:
        raise AddressError(f"{device}: {dev} is a bit device; data type must be BOOL")
    table, base, max_idx = spec[key]
    _check(device, dev, idx, max_idx)
    return _build(f"{dev}{idx}", dev, idx, None, key, table, base + idx)


def _check(device, dev, idx, max_idx):
    if idx > max_idx:
        raise AddressError(f"{device}: outside documented Modbus range {dev}0~{dev}{max_idx} (AH500 manual App. B.1)")


def _build(norm, dev, idx, bit, access, table, addr) -> ModbusAddress:
    fc, prefix, _ = TABLES[table]
    if not 0 <= addr <= 0xFFFF:
        raise AddressError(f"{norm}: computed address {addr} outside 0..65535")
    return ModbusAddress(
        device=norm, device_type=dev, index=idx, bit=bit, access=access, table=table,
        function_code=fc, address=addr, reference=f"{prefix}{addr + 1:05d}",
        hex=f"0x{addr:04X}", is_bit_table=table in ("coil", "discrete_input"),
    )


def from_override(override: dict, data_type: str) -> ModbusAddress:
    """Manual address (e.g. when an IoT gateway re-maps registers).

    override = {"function_code": 3, "address": 11008, "base": "zero"|"one", "bit": null}
    """
    fc = int(override.get("function_code", 3))
    if fc not in (1, 2, 3, 4):
        raise AddressError("Override function code must be a read code: 1, 2, 3 or 4")
    base = override.get("base", "zero")
    if base not in ("zero", "one"):
        raise AddressError("Override base must be 'zero' or 'one'")
    raw = int(override.get("address", 0))
    if base == "one" and 100000 <= raw <= 465536:
        # full 6-digit reference (e.g. 411009): first digit = table -> function code, rest = address + 1
        prefix, rest = divmod(raw, 100000)
        fc = {0: 1, 1: 2, 3: 4, 4: 3}.get(prefix)
        if fc is None:
            raise AddressError(f"Reference {raw}: first digit must be 0, 1, 3 or 4")
        addr = rest - 1
    else:
        addr = raw - 1 if base == "one" else raw
    if not 0 <= addr <= 0xFFFF:
        raise AddressError(f"Override address {raw} ({base}-based) outside range")
    table = {1: "coil", 2: "discrete_input", 3: "holding_register", 4: "input_register"}[fc]
    bit = override.get("bit")
    bit = int(bit) if bit not in (None, "") else None
    is_bit_table = fc in (1, 2)
    if (data_type or "").upper() == "BOOL" and not is_bit_table and bit is None:
        raise AddressError("BOOL from a register (FC03/04) needs a bit position")
    access = "bit" if is_bit_table else ("word_bit" if bit is not None else "word")
    return _build(f"override:{fc}:{raw}{'' if bit is None else '.' + str(bit)}", "OVR", raw, bit, access, table, addr)
