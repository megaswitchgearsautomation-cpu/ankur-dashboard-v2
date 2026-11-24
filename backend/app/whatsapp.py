"""WhatsApp alarm alerts through the Meta WhatsApp Cloud API (graph.facebook.com).

A background watcher compares the engine's active alarm list every few seconds:
- a new alarm  -> "ACTIVE" message to every recipient
- an alarm that cleared -> "CLEARED" message (if enabled)
The same alarm source (tag + kind) is not sent again within `repeat_min` minutes. Alarms already active when the
server starts are not sent (no flood after a restart). Demo (simulated) alarms are sent only when `send_demo` is on.

Business-initiated WhatsApp messages need an APPROVED TEMPLATE (mode "template"). The template body must have
4 variables: {{1}} site, {{2}} state (ACTIVE / CLEARED), {{3}} alarm text, {{4}} time (IST). Mode "text" sends a
plain text message - it is only delivered inside the 24 h window after the recipient last messaged the number.

Settings live in data/whatsapp.json (not in settings.json) - the access token is write-only and never returned to
any browser. Nothing here writes to the PLC.
"""
from __future__ import annotations

import json
import os
import queue
import re
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
GRAPH = "https://graph.facebook.com"
DEFAULTS = {"enabled": False, "phone_number_id": "", "access_token": "", "api_version": "v21.0",
            "recipients": [], "mode": "template", "template": "plant_alarm", "language": "en",
            "send_clear": True, "send_demo": False, "only_red": False, "repeat_min": 15}
POLL_S = 5
MAX_RECIPIENTS = 20


def _now_ist(ts=None):
    t = datetime.fromtimestamp(ts if ts is not None else time.time(), timezone.utc)
    return f"{t.astimezone(IST):%d-%m-%Y %H:%M} IST ({t:%H:%M} UTC)"


def normalize_number(s):
    """'+91 98765-43210' -> '919876543210' (WhatsApp wants the international number, digits only)."""
    d = re.sub(r"\D", "", str(s or ""))
    if d.startswith("00"):
        d = d[2:]
    if len(d) == 10:                     # plain Indian mobile number -> add country code 91
        d = "91" + d
    if not 11 <= len(d) <= 15:
        raise ValueError(f"'{s}' is not a valid WhatsApp number (use the full number with country code, e.g. +91 98765 43210)")
    return d


class WhatsAppNotifier:
    def __init__(self, data_dir, engine=None, historian=None, site_name=lambda: "", opener=None):
        self.path = os.path.join(data_dir, "whatsapp.json")
        self.engine, self.historian, self.site_name = engine, historian, site_name
        self._open = opener or urllib.request.urlopen          # replaceable in tests
        self._lock = threading.Lock()
        self._q = queue.Queue(maxsize=500)
        self._seen = None                                      # alarm id -> alarm (None until the first poll)
        self._last_sent = {}                                   # (tag, kind, state) -> time
        self._stop = threading.Event()
        self.last = {"ok": None, "time": None, "detail": ""}
        self.sent_count = 0

    # -- settings ------------------------------------------------------------------------------
    def config(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                return {**DEFAULTS, **(json.load(f) or {})}
        except (OSError, ValueError):
            return dict(DEFAULTS)

    def public(self):
        c = self.config()
        out = {k: v for k, v in c.items() if k != "access_token"}
        out["token_set"] = bool(c.get("access_token"))
        out["last"], out["sent_count"] = self.last, self.sent_count
        return out

    def save(self, b):
        c = self.config()
        for k in ("enabled", "send_clear", "send_demo", "only_red"):
            if k in b:
                c[k] = bool(b[k])
        if "phone_number_id" in b:
            pid = str(b["phone_number_id"]).strip()
            if pid and not pid.isdigit():
                raise ValueError("Phone number ID is the long number from Meta (digits only), not the phone number itself")
            c["phone_number_id"] = pid
        if "api_version" in b:
            v = str(b["api_version"]).strip() or DEFAULTS["api_version"]
            if not re.fullmatch(r"v\d{1,2}\.\d", v):
                raise ValueError("API version looks like v21.0")
            c["api_version"] = v
        if "mode" in b:
            if b["mode"] not in ("template", "text"):
                raise ValueError("Mode must be template or text")
            c["mode"] = b["mode"]
        if "template" in b:
            t = str(b["template"]).strip()
            if t and not re.fullmatch(r"[a-z0-9_]{1,512}", t):
                raise ValueError("Template name: lower-case letters, digits and _ only (as created in Meta)")
            c["template"] = t
        if "language" in b:
            lang = str(b["language"]).strip() or "en"
            if not re.fullmatch(r"[a-z]{2,3}(_[A-Z]{2})?", lang):
                raise ValueError("Language code like en, en_US or hi")
            c["language"] = lang
        if "repeat_min" in b:
            m = int(b["repeat_min"])
            if not 0 <= m <= 1440:
                raise ValueError("Repeat hold must be 0 - 1440 minutes")
            c["repeat_min"] = m
        if "recipients" in b:
            raw = b["recipients"] if isinstance(b["recipients"], list) else re.split(r"[,;\n]+", str(b["recipients"]))
            nums = list(dict.fromkeys(normalize_number(x) for x in raw if str(x).strip()))
            if len(nums) > MAX_RECIPIENTS:
                raise ValueError(f"At most {MAX_RECIPIENTS} recipients")
            c["recipients"] = nums
        if b.get("clear_token"):
            c["access_token"] = ""
        elif isinstance(b.get("access_token"), str) and b["access_token"].strip():
            tok = b["access_token"].strip()
            if len(tok) < 30 or any(ch.isspace() for ch in tok):
                raise ValueError("That does not look like a Meta access token")
            c["access_token"] = tok
        if c["enabled"] and not (c["phone_number_id"] and c["access_token"] and c["recipients"]):
            raise ValueError("To switch WhatsApp alerts on, fill in the phone number ID, the access token and at least one recipient")
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(c, f, indent=2)
        os.replace(tmp, self.path)
        return self.public()

    # -- message building / sending ------------------------------------------------------------
    def _body(self, c, to, state, text, ts):
        site = self.site_name() or "Plant"
        if c["mode"] == "text":
            icon = "\U0001F534" if state == "ACTIVE" else "\U0001F7E2"
            return {"messaging_product": "whatsapp", "to": to, "type": "text",
                    "text": {"body": f"{icon} {site}\nAlarm {state}: {text}\n{_now_ist(ts)}"}}
        params = [site, state, text, _now_ist(ts)]
        return {"messaging_product": "whatsapp", "to": to, "type": "template",
                "template": {"name": c["template"], "language": {"code": c["language"]},
                             "components": [{"type": "body", "parameters": [{"type": "text", "text": p[:1000]} for p in params]}]}}

    def _post(self, c, body):
        url = f"{GRAPH}/{c['api_version']}/{c['phone_number_id']}/messages"
        req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                     headers={"Authorization": f"Bearer {c['access_token']}", "Content-Type": "application/json"})
        try:
            with self._open(req, timeout=20) as r:
                res = json.loads(r.read().decode() or "{}")
            return True, (res.get("messages") or [{}])[0].get("id", "sent")
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode()).get("error", {})
                msg = err.get("error_user_msg") or err.get("message") or str(e)
                code = err.get("code")
            except Exception:
                msg, code = str(e), None
            hint = {190: " (access token invalid or expired)", 131030: " (recipient not in the allowed test list)",
                    132001: " (template name / language not found or not approved)", 131047: " (24 h window closed - use template mode)",
                    100: " (check the phone number ID)"}.get(code, "")
            return False, f"HTTP {e.code}: {msg}{hint}"
        except (urllib.error.URLError, OSError, ValueError) as e:
            return False, f"No connection to graph.facebook.com: {getattr(e, 'reason', e)}"

    def send(self, state, text, ts=None, recipients=None):
        """Send one alert to all (or the given) recipients now. Returns [(number, ok, detail), ...]."""
        c = self.config()
        if not (c["phone_number_id"] and c["access_token"]):
            raise ValueError("Phone number ID and access token are not set")
        out = []
        for to in recipients or c["recipients"]:
            ok, detail = self._post(c, self._body(c, to, state, text, ts))
            out.append((to, ok, detail))
            with self._lock:
                self.last = {"ok": ok, "time": time.time(), "detail": f"{state} to +{to}: {detail}"}
                self.sent_count += ok
            if self.historian:
                self.historian.event("whatsapp", f"{'sent' if ok else 'FAILED'} {state} to +{to[:4]}…{to[-3:]}: {text[:120]}"
                                     + ("" if ok else f" - {detail[:200]}"))
        return out

    def test(self, number=None):
        rec = [normalize_number(number)] if number else None
        res = self.send("TEST", "This is a test message from the plant dashboard - WhatsApp alerts are working.", recipients=rec)
        if not res:
            raise ValueError("No recipients - add at least one WhatsApp number")
        return [{"to": "+" + to, "ok": ok, "detail": d} for to, ok, d in res]

    # -- alarm watcher ---------------------------------------------------------------------------
    def check(self, now=None):
        """One comparison of the active alarm list with the last one; queues the messages to send."""
        now = now or time.time()
        alarms = {a["id"]: a for a in (self.engine.active_alarms() if self.engine else [])}
        if self._seen is None:                       # first look after start-up: remember, send nothing
            self._seen = alarms
            return []
        c = self.config()
        new = [a for i, a in alarms.items() if i not in self._seen]
        gone = [a for i, a in self._seen.items() if i not in alarms]
        self._seen = alarms
        if not c["enabled"]:
            return []
        queued = []
        for state, items in (("ACTIVE", new), ("CLEARED", gone if c["send_clear"] else [])):
            for a in items:
                if a.get("simulated") and not c["send_demo"]:
                    continue
                if c["only_red"] and a.get("priority") != "red":
                    continue
                key = (a.get("tag"), a.get("kind"), state)
                prev = self._last_sent.get(key)
                if prev is not None and now - prev < c["repeat_min"] * 60:
                    continue
                self._last_sent[key] = now
                text = (("[DEMO] " if a.get("simulated") else "") + ("CRITICAL - " if a.get("priority") == "red" else "")
                        + _clean(a.get("message") or a.get("tag_name") or a.get("tag")))
                item = (state, text, a.get("raised_at") if state == "ACTIVE" else now)
                try:
                    self._q.put_nowait(item)
                    queued.append(item)
                except queue.Full:
                    pass
        return queued

    def _worker(self):
        while not self._stop.is_set():
            try:
                state, text, ts = self._q.get(timeout=1)
            except queue.Empty:
                continue
            try:
                self.send(state, text, ts)
            except Exception as e:                    # never let a send error stop the watcher
                with self._lock:
                    self.last = {"ok": False, "time": time.time(), "detail": str(e)}

    def _loop(self):
        while not self._stop.wait(POLL_S):
            try:
                self.check()
            except Exception as e:
                with self._lock:
                    self.last = {"ok": False, "time": time.time(), "detail": f"watcher: {e}"}

    def start(self):
        threading.Thread(target=self._worker, name="whatsapp-send", daemon=True).start()
        threading.Thread(target=self._loop, name="whatsapp-watch", daemon=True).start()

    def stop(self):
        self._stop.set()


def _clean(s):
    """Client wording: no 'PLC' / 'HMI' in messages."""
    s = str(s or "").replace(" - PLC alarm", " - alarm").replace(": PLC alarm", ": alarm").replace("PLC communication", "Plant communication")
    return re.sub(r"\s*\b(PLC|HMI)\b\s*", " ", s).strip()
