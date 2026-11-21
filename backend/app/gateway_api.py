"""Gateway HTTP API data source (settings.source.mode = "gateway_api").

The IoT gateway's API is not documented yet, so no endpoint or JSON layout is assumed. Everything is configured in
settings["gateway_api"] (Settings page):
  url            one GET returns the current readings as JSON
  auth_header /  optional header sent with every request, e.g. "Authorization: Bearer <key>"
  auth_value     (kept on the server, never sent to the browser)
  values_path    dot path to the readings inside the response ("" = the whole response), e.g. "data.tags"
  id_field / value_field / ts_field / quality_field
                 field names inside each reading when the readings are a list of objects
Each dashboard tag is matched by tag["source_id"] (falls back to its plc_tag, then its id).

Accepted reading layouts (see docs/examples/gateway_api_response.example.json):
  list:  [{"id": "T_01", "value": 81.3, "ts": "2026-11-04T10:15:00+05:30", "q": "good"}, ...]
  dict:  {"T_01": 81.3, ...}   or   {"T_01": {"value": 81.3, "ts": 1793770000}, ...}
"""
from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
GOOD_WORDS = {"good", "ok", "valid", "1", "true", "192"}       # 192 = OPC "good"


class ApiError(Exception):
    pass


def fetch(cfg: dict) -> object:
    """GET the readings document. Raises ApiError with a message an operator can act on."""
    url = str(cfg.get("url") or "")
    if not url.startswith(("http://", "https://")):
        raise ApiError("Gateway API URL is not set (Settings > Gateway API)")
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "MedgeDash/1.0"})
    if cfg.get("auth_header") and cfg.get("auth_value"):
        req.add_header(str(cfg["auth_header"]), str(cfg["auth_value"]))
    ctx = None
    if url.startswith("https://") and cfg.get("verify_tls") is False:
        ctx = ssl._create_unverified_context()          # only when the admin turns certificate checks off
    try:
        with urllib.request.urlopen(req, timeout=float(cfg.get("timeout_s") or 10), context=ctx) as r:
            body = r.read(5_000_000)
    except urllib.error.HTTPError as e:
        hint = {401: "API key rejected", 403: "API key has no access", 404: "URL not found on the gateway",
                429: "gateway rate limit", 500: "gateway error"}.get(e.code, "")
        raise ApiError(f"Gateway API answered HTTP {e.code}{' - ' + hint if hint else ''}")
    except urllib.error.URLError as e:
        raise ApiError(f"Gateway API not reachable ({e.reason})")
    except (TimeoutError, OSError) as e:
        raise ApiError(f"Gateway API not reachable ({type(e).__name__})")
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ApiError("Gateway API reply is not JSON")


def _walk(doc, path):
    node = doc
    for part in [p for p in str(path or "").split(".") if p]:
        if isinstance(node, list) and part.isdigit():
            node = node[int(part)] if int(part) < len(node) else None
        elif isinstance(node, dict):
            node = node.get(part)
        else:
            node = None
        if node is None:
            raise ApiError(f"'{path}' not found in the gateway reply")
    return node


def parse_ts(v):
    """Epoch seconds / milliseconds or ISO 8601 -> epoch seconds (None if missing or unreadable).
    An ISO time without a zone is read as Asia/Kolkata (+05:30), the plant's time zone."""
    if v in (None, ""):
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v) / 1000.0 if v > 1e11 else float(v)
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=IST)
    return d.timestamp()


def readings(doc, cfg: dict) -> dict:
    """{source_id: (value, ts_or_None, good_bool)} from the reply, following the configured layout."""
    node = _walk(doc, cfg.get("values_path")) if cfg.get("values_path") else doc
    idf, vf = cfg.get("id_field") or "id", cfg.get("value_field") or "value"
    tsf, qf = cfg.get("ts_field") or "", cfg.get("quality_field") or ""
    out = {}

    def one(v):
        if isinstance(v, dict):
            q = v.get(qf) if qf else None
            return (v.get(vf), parse_ts(v.get(tsf)) if tsf else None,
                    True if q is None else str(q).strip().lower() in GOOD_WORDS)
        return v, None, True

    if isinstance(node, list):
        for item in node:
            if isinstance(item, dict) and item.get(idf) is not None:
                out[str(item[idf])] = one(item)
    elif isinstance(node, dict):
        for k, v in node.items():
            out[str(k)] = one(v)
    else:
        raise ApiError("Gateway reply has no list or object of readings at the configured path")
    return out


def source_id(tag: dict) -> str:
    return str(tag.get("source_id") or tag.get("plc_tag") or tag["id"])
