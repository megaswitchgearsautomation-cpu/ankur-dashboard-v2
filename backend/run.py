"""Start the Medge Controls dashboard backend.

    python run.py                 # uses backend/config, backend/data
    python run.py --port 8080 --verbose
"""
import argparse
import os
import signal
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from app.auth import Auth, DEFAULT_ADMIN, DEFAULT_CLIENT  # noqa: E402
from app.config_store import ConfigStore  # noqa: E402
from app.engine import Engine  # noqa: E402
from app.historian import Historian  # noqa: E402
from app.server import serve  # noqa: E402


class App:
    def __init__(self, config_dir, data_dir, frontend_dir, verbose=False):
        os.makedirs(data_dir, exist_ok=True)
        self.store = ConfigStore(config_dir)
        self.historian = Historian(os.path.join(data_dir, "history.sqlite3"))
        self.auth = Auth(self.store)
        self.engine = Engine(self.store, self.historian)
        self.frontend_dir = frontend_dir
        self.verbose = verbose


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config"))
    ap.add_argument("--data", default=os.path.join(HERE, "data"))
    ap.add_argument("--frontend", default=os.path.join(os.path.dirname(HERE), "frontend"))
    ap.add_argument("--host")
    ap.add_argument("--port", type=int)
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args()

    app = App(a.config, a.data, a.frontend, a.verbose)
    host = a.host or app.store.settings["server"]["host"]
    port = a.port or app.store.settings["server"]["port"]
    app.engine.start()
    httpd = serve(app, host, port)

    s = app.store.settings
    print(f"Login     : http://localhost:{port}/login   (admin -> tag configuration, client -> view-only dashboard)")
    print(f"PLC       : {s['plc']['vendor']} {s['plc']['model']} @ {s['plc']['host']}:{s['plc']['port']} "
          f"(unit {s['plc']['unit_id']}) via Modbus TCP")
    print(f"Data mode : {s['source']['mode'].upper()}"
          + ("  <-- values are SIMULATED until switched to 'modbus' in Admin" if s['source']['mode'] == 'simulation' else ""))
    s = app.store.settings
    if s["admin"].get("must_change"):
        print(f"WARNING   : default admin login '{DEFAULT_ADMIN[0]}' / '{DEFAULT_ADMIN[1]}' is active - change it in Admin > Accounts.")
    if s["client"].get("must_change"):
        print(f"WARNING   : default client login '{s['client'].get('username')}' / '{DEFAULT_CLIENT[1]}' is active - change it in Admin > Accounts.")

    stop = threading.Event()

    def _shutdown(*_):
        if not stop.is_set():
            stop.set()
            threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)
    try:
        httpd.serve_forever(poll_interval=0.5)
    finally:
        app.engine.stop()
        app.historian.close()
        print("stopped")


if __name__ == "__main__":
    main()
