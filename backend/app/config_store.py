"""JSON configuration (settings, tags, equipment) with validation and atomic saves."""
from __future__ import annotations

import copy
import json
import os
import re
import threading

from . import codec, delta_ah500, iot_link

DEFAULT_SETTINGS = {
    "site": {"name": "FSTP-200 Muttathara, Trivandrum", "panel": "Op Panel", "client": "Ankur"},
    "plc": {
        "vendor": "Delta",
        "model": "AHCPU521-EN",
        "protocol": "modbus_tcp",
        "host": "192.168.1.2",
        "port": 502,
        "unit_id": 1,
        "timeout_ms": 3000,
        "retries": 1,
        "reconnect_s": 5,
        "max_regs_per_read": 100,
        "max_bits_per_read": 1000,
        "max_gap": 8,
        "default_word_order": "low_first",
        "hw_ranges": {"X": [0, 6], "Y": [0, 3]},
    },
    "gateway": {
        "path": "Delta AHCPU521-EN → Phoenix 8-port switch → Teltonika RUT200 (4G/VPN) → Backend → Web dashboard",
        "type": "ethernet_passthrough",
        "model": "Teltonika RUT200",
        "notes": "Backend acts as Modbus TCP client; the RUT200 VPN routes TCP 502 to the PLC (192.168.1.2). "
                 "Same Ethernet network also has the Delta 12\" HMI.",
    },
    # IoT cloud link: the gateway's cloud access key (hostname) opened by comlink.exe as 127.0.0.1:local_port
    "iot": {"enabled": False, "access_key": "", "local_port": 10502, "comlink_path": "",
            "service_token_id": "", "service_token_secret": ""},
    "source": {"mode": "simulation", "comm_verified": False, "verified_by": "", "verified_at": None,
               "verified_note": ""},
    "historian": {"log_interval_s": 10, "retention_days": 30},
    "server": {"host": "0.0.0.0", "port": 8080},
    "admin": {"username": "admin", "password_hash": "", "salt": "", "must_change": True},
    "client": {"username": "ankur", "password_hash": "", "salt": "", "must_change": True},
}

TAG_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")
PRIORITIES = ("red", "yellow")


class ConfigError(ValueError):
    pass


def _deep_merge(base, extra):
    out = copy.deepcopy(base)
    for k, v in (extra or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def _atomic_write(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


class ConfigStore:
    def __init__(self, config_dir: str):
        self.dir = config_dir
        os.makedirs(config_dir, exist_ok=True)
        self._lock = threading.RLock()
        self.settings = _deep_merge(DEFAULT_SETTINGS, self._load("settings.json", {}))
        self.tags = self._load("tags.json", [])
        self.equipment = self._load("equipment.json", [])
        self.version = 1

    def _path(self, name):
        return os.path.join(self.dir, name)

    def _load(self, name, default):
        p = self._path(name)
        if not os.path.exists(p):
            return copy.deepcopy(default)
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)

    # -- settings -----------------------------------------------------------
    def save_settings(self, new_settings: dict):
        with self._lock:
            merged = _deep_merge(self.settings, new_settings)
            validate_settings(merged)
            self.settings = merged
            _atomic_write(self._path("settings.json"), merged)
            self.version += 1

    def public_settings(self):
        s = copy.deepcopy(self.settings)
        s.pop("admin", None)
        s.pop("client", None)
        # never send the token secret back to the browser; the form only learns whether one is stored
        s["iot"]["has_token_secret"] = bool(s["iot"].pop("service_token_secret", ""))
        return s

    # -- tags ---------------------------------------------------------------
    def save_tags(self, tags: list):
        with self._lock:
            errors = validate_tags(tags, self.settings)
            if errors:
                raise ConfigError("; ".join(errors[:20]))
            self.tags = tags
            _atomic_write(self._path("tags.json"), tags)
            # equipment may reference removed tags; keep them but they will show UNKNOWN
            self.version += 1

    def save_equipment(self, equipment: list):
        with self._lock:
            ids = {t["id"] for t in self.tags}
            errs = []
            seen = set()
            for e in equipment:
                if not TAG_ID_RE.match(str(e.get("id", ""))):
                    errs.append(f"equipment id '{e.get('id')}' invalid")
                if e.get("id") in seen:
                    errs.append(f"duplicate equipment id {e.get('id')}")
                seen.add(e.get("id"))
                for k in ("run_tag", "trip_tag", "cmd_tag", "open_tag", "close_tag"):
                    if e.get(k) and e[k] not in ids:
                        errs.append(f"{e.get('id')}: {k} '{e[k]}' is not a configured tag")
            if errs:
                raise ConfigError("; ".join(errs[:20]))
            self.equipment = equipment
            _atomic_write(self._path("equipment.json"), equipment)
            self.version += 1

    def tag_map(self):
        return {t["id"]: t for t in self.tags}


def validate_settings(s):
    plc = s["plc"]
    if not str(plc.get("host", "")).strip():
        raise ConfigError("PLC host/IP is required")
    for k, lo, hi in (("port", 1, 65535), ("unit_id", 0, 255), ("timeout_ms", 100, 60000),
                      ("retries", 0, 5), ("reconnect_s", 1, 600), ("max_regs_per_read", 1, 125),
                      ("max_bits_per_read", 1, 2000), ("max_gap", 0, 50)):
        try:
            v = int(plc[k])
        except (KeyError, TypeError, ValueError):
            raise ConfigError(f"plc.{k} must be an integer")
        if not lo <= v <= hi:
            raise ConfigError(f"plc.{k} must be within {lo}..{hi}")
        plc[k] = v
    if plc.get("default_word_order") not in codec.WORD_ORDERS:
        raise ConfigError("plc.default_word_order must be low_first or high_first")
    iot = s["iot"]
    iot["enabled"] = bool(iot.get("enabled"))
    iot["access_key"] = iot_link.normalize_key(iot.get("access_key"))
    iot["comlink_path"] = str(iot.get("comlink_path") or "").strip().strip('"')
    iot["service_token_id"] = str(iot.get("service_token_id") or "").strip()
    if not iot["service_token_id"]:
        iot["service_token_secret"] = ""
    try:
        iot["local_port"] = int(iot.get("local_port") or 10502)
    except (TypeError, ValueError):
        raise ConfigError("iot.local_port must be an integer")
    if not 1024 <= iot["local_port"] <= 65535:
        raise ConfigError("iot.local_port must be within 1024..65535")
    if iot["enabled"]:
        if not iot_link.valid_key(iot["access_key"]):
            raise ConfigError("IoT access key must be a host name like abc.rs485.in")
        if iot["comlink_path"] and not os.path.isfile(iot["comlink_path"]):
            raise ConfigError(f"comlink.exe not found at {iot['comlink_path']}")
        if not iot_link.find_comlink(iot["comlink_path"]):
            raise ConfigError("comlink.exe not found - enter its full path")
    if s["source"].get("mode") not in ("simulation", "modbus"):
        raise ConfigError("source.mode must be 'simulation' or 'modbus'")
    h = s["historian"]
    h["log_interval_s"] = max(1, int(h.get("log_interval_s", 10)))
    h["retention_days"] = max(1, int(h.get("retention_days", 30)))


def resolve_tag(tag: dict):
    """Return ModbusAddress for a tag (override wins over device)."""
    ov = tag.get("address_override")
    if ov and ov.get("enabled"):
        return delta_ah500.from_override(ov, tag.get("data_type", "BOOL"))
    return delta_ah500.resolve(tag.get("device", ""), tag.get("data_type", "BOOL"))


def tag_warnings(tag: dict, settings: dict):
    """Non-fatal warnings (shown in admin)."""
    w = []
    try:
        ma = resolve_tag(tag)
    except delta_ah500.AddressError as e:
        return [str(e)]
    rng = settings.get("plc", {}).get("hw_ranges", {})
    if ma.device_type in rng and ma.access in ("bit", "word"):
        lo, hi = rng[ma.device_type]
        if not lo <= ma.index <= hi:
            w.append(f"{ma.device} is outside the HWCONFIG I/O range {ma.device_type}{lo}~{ma.device_type}{hi} "
                     f"(no module mapped there)")
    if ma.is_bit_table and tag.get("data_type", "").upper() != "BOOL":
        w.append("bit table read but data type is not BOOL")
    if not tag.get("mapping_verified"):
        w.append("mapping not yet verified on site")
    return w


def validate_tags(tags, settings):
    errors, seen = [], set()
    if not isinstance(tags, list):
        return ["tags must be a list"]
    for i, t in enumerate(tags):
        tid = str(t.get("id", ""))
        where = f"tag[{i}] {tid or '?'}"
        if not TAG_ID_RE.match(tid):
            errors.append(f"{where}: id must be 1-64 chars of letters, digits, _ or -")
        if tid in seen:
            errors.append(f"{where}: duplicate id")
        seen.add(tid)
        if not str(t.get("name", "")).strip():
            errors.append(f"{where}: name required")
        dt = str(t.get("data_type", "")).upper()
        if dt not in codec.DATA_TYPES:
            errors.append(f"{where}: data_type must be one of {', '.join(codec.DATA_TYPES)}")
            continue
        t["data_type"] = dt
        wo = t.get("word_order")
        if wo not in (None, "", "default", *codec.WORD_ORDERS):
            errors.append(f"{where}: word_order invalid")
        try:
            ma = resolve_tag(t)
            if codec.register_count(dt) == 2 and ma.is_bit_table:
                errors.append(f"{where}: 32-bit type cannot be read from a bit table")
            if ma.access == "word_bit" and dt != "BOOL":
                errors.append(f"{where}: word.bit address needs data type BOOL")
        except (delta_ah500.AddressError, codec.DecodeError) as e:
            errors.append(f"{where}: {e}")
        try:
            pm = int(t.get("poll_ms", 1000))
            if not 200 <= pm <= 3600000:
                raise ValueError
            t["poll_ms"] = pm
        except (TypeError, ValueError):
            errors.append(f"{where}: poll_ms must be 200..3600000")
        sc = t.get("scaling") or {"mode": "none"}
        if sc.get("mode") not in ("none", "linear", "gain_offset"):
            errors.append(f"{where}: scaling.mode invalid")
        elif sc.get("mode") == "linear":
            try:
                if float(sc["raw_max"]) == float(sc["raw_min"]) or float(sc["eng_max"]) == float(sc["eng_min"]):
                    errors.append(f"{where}: linear scaling min and max must differ")
            except (KeyError, TypeError, ValueError):
                errors.append(f"{where}: linear scaling needs raw_min, raw_max, eng_min, eng_max")
        al = t.get("alarm") or {}
        if al.get("enabled") and al.get("priority", "yellow") not in PRIORITIES:
            errors.append(f"{where}: alarm priority must be red or yellow")
    return errors
