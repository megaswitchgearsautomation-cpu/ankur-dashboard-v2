"""IoT cloud link: opens the gateway's cloud access key (hostname) as a local TCP port.

The site IoT gateway publishes the PLC under a cloud hostname (the "access key", e.g. xxxx.rs485.in).
comlink.exe (Cloudflare cloudflared) turns that key into 127.0.0.1:<local_port>; the Modbus client then
reads from that local port as if the PLC were on the LAN.  Read-only like the rest of the backend.
"""
from __future__ import annotations

import collections
import os
import re
import shutil
import socket
import ssl
import subprocess
import threading
import time

HOST_RE = re.compile(r"^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9\-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$")
LOCAL_HOST = "127.0.0.1"
HERE = os.path.dirname(os.path.abspath(__file__))


def normalize_key(key: str) -> str:
    """'https://abc.rs485.in/' -> 'abc.rs485.in' (scheme, path, port and spaces dropped)."""
    k = str(key or "").strip()
    k = re.sub(r"^[a-z][a-z0-9+.\-]*://", "", k, flags=re.I)
    return k.split("/")[0].split(":")[0].strip().lower()


def valid_key(key: str) -> bool:
    return bool(HOST_RE.match(key or ""))


def modbus_target(settings: dict):
    """(host, port) the Modbus client must use: the local end of the IoT link when it is enabled."""
    iot = settings.get("iot") or {}
    if iot.get("enabled"):
        return LOCAL_HOST, int(iot.get("local_port") or 10502)
    return settings["plc"]["host"], int(settings["plc"]["port"])


def find_comlink(configured: str = ""):
    cands = [configured] if configured else []
    backend = os.path.dirname(HERE)
    cands += [os.path.join(backend, "bin", "comlink.exe"), os.path.join(backend, "bin", "cloudflared.exe")]
    for c in cands:
        if c and os.path.isfile(c):
            return c
    return shutil.which("comlink") or shutil.which("cloudflared")


def check_key(key: str, timeout: float = 20.0) -> dict:
    """WebSocket handshake to https://<key>/ - tells whether the gateway and its PLC route are up.

    101 = gateway online and route accepted; 502 after a long wait = gateway online but PLC target unreachable;
    530 / 1033 = gateway offline (tunnel not connected); DNS failure = key does not exist.
    """
    key = normalize_key(key)
    if not valid_key(key):
        return {"ok": False, "verdict": "invalid", "message": "Access key must be a host name like abc.rs485.in"}
    t0 = time.perf_counter()
    try:
        socket.getaddrinfo(key, 443)
    except OSError as e:
        return {"ok": False, "verdict": "dns", "message": f"Access key not found in DNS ({e}). Check the key with the IoT provider."}
    req = (f"GET / HTTP/1.1\r\nHost: {key}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
           "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"
           "User-Agent: MedgeDash-IoT-check\r\n\r\n").encode()
    try:
        raw = socket.create_connection((key, 443), timeout=timeout)
        with ssl.create_default_context().wrap_socket(raw, server_hostname=key) as s:
            s.settimeout(timeout)
            s.sendall(req)
            head = s.recv(4096).decode("latin-1", "replace")
    except OSError as e:
        return {"ok": False, "verdict": "network", "message": f"Could not reach the cloud ({type(e).__name__}: {e}). Check the PC's internet."}
    ms = round((time.perf_counter() - t0) * 1000)
    m = re.match(r"HTTP/\d\.\d (\d{3})", head)
    code = int(m.group(1)) if m else 0
    if code == 101:
        return {"ok": True, "verdict": "online", "code": code, "ms": ms, "message": "Gateway online - access key accepted."}
    if code == 502:
        return {"ok": False, "verdict": "plc_unreachable", "code": code, "ms": ms,
                "message": "Gateway online, but it cannot reach the PLC behind this key (PLC off, wrong PLC IP/port on the gateway)."}
    if code == 530 or "1033" in head:
        return {"ok": False, "verdict": "gateway_offline", "code": code, "ms": ms,
                "message": "IoT gateway is offline (no 4G / power, or its cloud service is stopped)."}
    return {"ok": False, "verdict": "unexpected", "code": code, "ms": ms, "message": f"Unexpected cloud reply: HTTP {code or '?'}"}


class IotLink:
    """Keeps one comlink process running for the configured access key; restarts it if it exits."""

    RESTART_S = 5

    def __init__(self):
        self._lock = threading.RLock()
        self._proc = None
        self._key = None            # (exe, access_key, local_port, token_id, token_secret)
        self._log = collections.deque(maxlen=40)
        self.started_at = None
        self.last_error = None
        self.restarts = 0
        self._next_start = 0.0

    # called from the engine loop every tick
    def ensure(self, settings: dict):
        iot = settings.get("iot") or {}
        with self._lock:
            if not iot.get("enabled"):
                self.stop()
                self.last_error = None
                return
            exe = find_comlink(iot.get("comlink_path", ""))
            key = (exe, normalize_key(iot.get("access_key")), int(iot.get("local_port") or 10502),
                   iot.get("service_token_id") or "", iot.get("service_token_secret") or "")
            if key != self._key:
                self.stop()
                self._key = key
                self._next_start = 0.0
            if self._proc and self._proc.poll() is None:
                return
            if self._proc:   # exited by itself
                self.last_error = f"comlink exited (code {self._proc.returncode})"
                self._proc = None
                self.started_at = None
                self._next_start = time.time() + self.RESTART_S
            if time.time() < self._next_start:
                return
            self._start(*key)

    def _start(self, exe, access_key, port, token_id, token_secret):
        self._next_start = time.time() + self.RESTART_S
        if not exe:
            self.last_error = "comlink.exe not found - set its path in Admin > Communication > IoT cloud link"
            return
        if not valid_key(access_key):
            self.last_error = "Access key missing or not a host name"
            return
        cmd = [exe, "access", "tcp", "--hostname", access_key, "--url", f"{LOCAL_HOST}:{port}"]
        if token_id and token_secret:
            cmd += ["--service-token-id", token_id, "--service-token-secret", token_secret]
        try:
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            self._proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                          stderr=subprocess.STDOUT, creationflags=flags)
        except OSError as e:
            self.last_error = f"cannot start comlink: {e}"
            self._proc = None
            return
        self.started_at = time.time()
        self.last_error = None
        self.restarts += 1
        self._log.append(f"{time.strftime('%H:%M:%S')} started: {access_key} -> {LOCAL_HOST}:{port}")
        threading.Thread(target=self._pump, args=(self._proc,), daemon=True).start()

    def _pump(self, proc):
        for line in iter(proc.stdout.readline, b""):
            txt = line.decode("utf-8", "replace").rstrip()
            if txt:
                self._log.append(txt[-300:])

    def stop(self):
        with self._lock:
            p, self._proc = self._proc, None
            self.started_at = None
            if p and p.poll() is None:
                p.terminate()
                try:
                    p.wait(3)
                except subprocess.TimeoutExpired:
                    p.kill()

    def wait_listening(self, port: int, timeout: float = 4.0) -> bool:
        end = time.time() + timeout
        while time.time() < end:
            try:
                socket.create_connection((LOCAL_HOST, port), timeout=0.5).close()
                return True
            except OSError:
                time.sleep(0.2)
        return False

    def status(self, settings: dict) -> dict:
        iot = settings.get("iot") or {}
        with self._lock:
            running = bool(self._proc and self._proc.poll() is None)
            return {"enabled": bool(iot.get("enabled")), "running": running,
                    "access_key": normalize_key(iot.get("access_key")),
                    "local": f"{LOCAL_HOST}:{int(iot.get('local_port') or 10502)}",
                    "comlink": find_comlink(iot.get("comlink_path", "")),
                    "started_at": self.started_at if running else None,
                    "last_error": self.last_error, "log": list(self._log)[-12:]}
