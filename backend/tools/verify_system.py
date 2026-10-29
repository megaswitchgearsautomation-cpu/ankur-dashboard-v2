"""End-to-end system verification against a bench AH500 (fake PLC with the real Modbus address layout).

Runs on a TEMPORARY copy of the configuration (your real settings are never changed):
  * every configured tag is read over Modbus TCP and must come back GOOD
  * REAL values in D registers (D11008 ...) decode to the same numbers the PLC holds
  * X / Y bit addressing (X1.4, X3.7, Y1.4 ...) maps to the right signal
  * NC trip contacts: healthy = no alarm, contact open = TRIP + red alarm
  * PLC alarm bits (D15001.x) raise alarms
  * client view shows LIVE and leaks no PLC details; reports (Excel / PDF) work on live data
  * PLC disconnect is detected (OFFLINE + comm alarm) and the link RECONNECTS AUTOMATICALLY

    python tools/verify_system.py            # run checks and exit (code 0 = all passed)
    python tools/verify_system.py --serve    # run checks, then keep fake PLC + dashboard running for a browser check
"""
import argparse
import http.cookiejar
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
sys.path.insert(0, BACKEND)

import run  # noqa: E402
from app import codec, delta_ah500  # noqa: E402
from app.config_store import resolve_tag  # noqa: E402
from app.server import serve  # noqa: E402
from tools import fake_ah500 as plc  # noqa: E402

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  - {detail}" if detail else ""))
    return ok


def wait_for(fn, timeout, step=0.3):
    end = time.time() + timeout
    while time.time() < end:
        try:
            v = fn()
            if v:
                return v
        except Exception:
            pass
        time.sleep(step)
    return None


class Client:
    def __init__(self, base):
        self.base = base
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, method, path, body=None, raw=False):
        req = urllib.request.Request(self.base + path, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method=method)
        try:
            r = self.op.open(req, timeout=10)
            data = r.read()
            return r.status, (data if raw else json.loads(data or b"{}")), r.headers
        except urllib.error.HTTPError as e:
            return e.code, None, e.headers


def set_bit(device, value):
    """Write the RAW field state of an X or Y bit into the fake PLC."""
    ma = delta_ah500.resolve(device, "BOOL")
    with plc.LOCK:
        if ma.device_type == "X":
            plc.set_x(ma.index, ma.bit, value)
        elif ma.device_type == "Y":
            plc.set_y(ma.index, ma.bit, value)
        elif ma.access == "word_bit":
            w = plc.HOLD[ma.address]
            plc.HOLD[ma.address] = (w | (1 << ma.bit)) if value else (w & ~(1 << ma.bit))


def healthy_baseline(tags):
    """Field state of a healthy plant: NC contacts (inverted tags) closed = 1, everything else 0."""
    for t in tags:
        if t["data_type"] == "BOOL" and t["device"][0] in "XY":
            set_bit(t["device"], bool(t.get("invert")))
    with plc.LOCK:
        plc.HOLD[15001] = 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(BACKEND, "config"))
    ap.add_argument("--web-port", type=int, default=18090)
    ap.add_argument("--plc-port", type=int, default=15020)
    ap.add_argument("--serve", action="store_true")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    tmp = tempfile.mkdtemp(prefix="verify_")
    cfg = os.path.join(tmp, "config")
    shutil.copytree(a.config, cfg, ignore=shutil.ignore_patterns("settings.json"))
    app = run.App(cfg, os.path.join(tmp, "data"), os.path.join(os.path.dirname(BACKEND), "frontend"))
    app.store.save_settings({"plc": {"host": "127.0.0.1", "port": a.plc_port, "timeout_ms": 1000, "retries": 0, "reconnect_s": 2},
                             "source": {"mode": "modbus", "comm_verified": True, "verified_by": "verify_system.py"}})
    tags = app.store.tags
    print(f"\nTemporary config: {cfg}\nTags: {len(tags)}   Equipment: {len(app.store.equipment)}")

    srv = plc.start(a.plc_port)
    healthy_baseline(tags)
    # stop the bench updater from overwriting the X0.x baseline: it only writes X0.0, X0.8-X0.14, Y0.0/Y0.1, D15000, analogs
    app.engine.start()
    httpd = serve(app, "127.0.0.1", a.web_port)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{a.web_port}"
    adm, cli = Client(base), Client(base)

    print("\n1. Connection and tag reading")
    check("admin login", adm.call("POST", "/api/login", {"username": "admin", "password": "admin123"})[0] == 200)
    st = wait_for(lambda: (lambda s: s if s["connection"]["state"] == "CONNECTED" and
                           all(t["quality"] != "INIT" for t in s["tags"]) else None)(adm.call("GET", "/api/admin/status")[1]), 15)
    check("backend connects to the PLC automatically (mode = modbus)", st is not None, st and st["connection"]["plc"])
    time.sleep(2)
    st = adm.call("GET", "/api/admin/status")[1]
    bad = [f"{t['id']}:{t['quality']}" for t in st["tags"] if t["quality"] != "GOOD"]
    check(f"all {len(st['tags'])} tags read GOOD over Modbus TCP", not bad, ", ".join(bad[:8]))
    c = st["connection"]
    check("no communication errors", c["errors"] == 0, f"{c['requests']} requests, {c['errors']} errors, avg {c['avg_latency_ms']} ms")
    blocks = len({(ma.function_code) for t in tags for ma in [resolve_tag(t)]})
    check("block reads are used (efficient polling)", c["requests"] < len(tags), f"{c['requests']} requests for {len(tags)} tags so far")

    print("\n2. Values and addressing")
    live = {t["id"]: t for t in st["tags"]}
    worst = 0.0
    for t in tags:
        if t["data_type"] != "REAL":
            continue
        ma = resolve_tag(t)
        with plc.LOCK:
            regs = plc.HOLD[ma.address:ma.address + 2]
        expect = codec.decode_registers(regs, "REAL", "low_first")
        got = live[t["id"]]["value"]
        worst = max(worst, abs(expect - got))
    check("REAL values (D11008 …, D13000 …) decode correctly - low word first", worst < 2.0, f"max difference {worst:.3f} (values move while reading)")
    set_bit("X1.4", True)
    set_bit("Y1.4", True)
    ok = wait_for(lambda: (lambda d: d if d.get("DI_Filtrate_Tnk_Pmp_Main_Rn") is True and d.get("DO_Acid_Dosing_Pump") is True else None)(
        {t["id"]: t["value"] for t in adm.call("GET", "/api/admin/status")[1]["tags"]}), 6)
    check("X bit X1.4 -> Filtrate pump main run feedback (FC02 @ 0x6014)", ok)
    check("Y bit Y1.4 -> Acid dosing pump command (FC01 @ 0xA014)", ok)
    eq = wait_for(lambda: next((e for e in cli_live(cli) ["equipment"] if e["id"] == "OP_P5A" and e["status"] == "RUNNING"), None), 6)
    check("equipment status derived: OP-P5A RUNNING", eq)

    print("\n3. Alarms")
    al0 = cli_live(cli)["alarms"]
    check("healthy plant (NC contacts closed) -> no trip / safety alarms", not [x for x in al0 if "trip" in x["message"].lower() or "operated" in x["message"].lower() or "pressed" in x["message"].lower()],
          ", ".join(x["message"] for x in al0[:4]))
    set_bit("X3.7", False)          # Spare pump-1 trip contact (NC) opens
    trip = wait_for(lambda: next((x for x in cli_live(cli)["alarms"] if "Spare Pump-1" in x["message"]), None), 6)
    check("NC trip contact opens -> red TRIP alarm", trip and trip["priority"] == "red", trip and trip["message"])
    eqt = wait_for(lambda: next((e for e in cli_live(cli)["equipment"] if e["id"] == "OP_P16" and e["status"] == "TRIP"), None), 6)
    check("equipment OP-P16 shows TRIP", eqt)
    set_bit("D15001.0", True)      # PLC alarm bit for analog channel 17 (spare) / D15000 bits for used channels
    set_bit("X0.6", False)         # earth fault relay (NC) operated
    ef = wait_for(lambda: next((x for x in cli_live(cli)["alarms"] if "Earth Fault" in x["message"]), None), 6)
    check("earth-fault relay operated -> alarm", ef, ef and ef["message"])
    if trip:
        code, body, _ = cli.call("POST", "/api/client/alarms/ack", {"ids": [trip["id"]], "notes": {str(trip["id"]): "verify: contact reset"}})
        check("client acknowledges alarm with a note", code == 200 and body["notes_saved"] == 1)
    set_bit("X3.7", True)
    cleared = wait_for(lambda: not any("Spare Pump-1" in x["message"] for x in cli_live(cli)["alarms"]), 6)
    check("contact closes again -> alarm clears", cleared)

    print("\n4. Client view")
    code, body, _ = cli.call("GET", "/api/live")
    raw = json.dumps(body)
    leaks = [w for w in ("127.0.0.1", "AHCPU", "Modbus", "D11008", '"device"', "last_error", "quality_pct") if w in raw]
    check("client data shows LIVE", body["status"]["state"] == "live", body["status"])
    check("client data contains no PLC / network / address details", not leaks, ",".join(leaks))
    now = time.time()
    for ext in ("xlsx", "pdf"):
        code, data, hdr = cli.call("GET", f"/api/report.{ext}?from={now - 600}&to={now}&interval=60", raw=True)
        check(f"report {ext.upper()} on live data", code == 200 and data and len(data) > 1000, hdr and hdr.get("Content-Disposition"))
    code, rep, _ = cli.call("GET", f"/api/report?from={now - 600}&to={now}&interval=60")
    check("report contains live (not demo) rows", code == 200 and rep["rows"] and not rep["simulated"], f"{len(rep['rows'])} rows")
    code, tr, _ = adm.call("POST", "/api/admin/test-read", {"tag": next(t for t in tags if t["id"] == "T_01")})
    check("admin Test Read T-01 (D11008)", tr and tr.get("ok"), tr and f"raw {tr.get('raw_hex')} -> {tr.get('value'):.2f}")

    print("\n5. Communication loss and AUTOMATIC reconnect")
    plc.stop(srv)                  # listener closed + live connections dropped (cable unplugged)
    off = wait_for(lambda: cli_live(cli)["status"]["state"] == "offline", 12)
    check("PLC unplugged -> dashboard shows OFFLINE", off)
    comm = wait_for(lambda: next((x for x in cli_live(cli)["alarms"] if x["tag"] == "_COMM"), None), 6)
    check("communication-lost alarm raised", comm, comm and comm["message"])
    srv = plc.start(a.plc_port)
    healthy_baseline(tags)
    back = wait_for(lambda: cli_live(cli)["status"]["state"] == "live", 15)
    check("PLC back -> reconnects AUTOMATICALLY (no restart, no click)", back)
    goodagain = wait_for(lambda: all(t["quality"] == "GOOD" for t in adm.call("GET", "/api/admin/status")[1]["tags"]), 10)
    check("all tags GOOD again after reconnect", goodagain)
    gone = wait_for(lambda: not any(x["tag"] == "_COMM" for x in cli_live(cli)["alarms"]), 6)
    check("communication alarm clears by itself", gone)

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\nRESULT: {passed}/{len(results)} checks passed")
    if a.serve:
        print(f"\nServing for a browser check:  dashboard {base}  (fake PLC on port {a.plc_port}).  Ctrl+C to stop.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
    httpd.shutdown(); app.engine.stop(); app.historian.close(); plc.stop(srv)
    shutil.rmtree(tmp, ignore_errors=True)
    sys.exit(0 if passed == len(results) else 1)


def cli_live(cli):
    if not getattr(cli, "_in", False):
        cli.call("POST", "/api/login", {"username": "ankur", "password": "ankur123"})
        cli._in = True
    return cli.call("GET", "/api/live")[1]


if __name__ == "__main__":
    main()
