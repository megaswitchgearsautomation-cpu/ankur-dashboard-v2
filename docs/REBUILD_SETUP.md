# Ankur FSTP-200 dashboard: rebuild (Nov 2026) setup and status

This file covers the rebuild requested in *Scope By Medge Controls*. The older parts of `README.md` (Reports tab,
login table) describe v1 and are out of date where they differ from this file.

## 1. Run it

* Python 3.10+ (standard library only). From `backend/`:
  `pythonw run.py --port 8082` (no console) or `python run.py --port 8082`.
* Open `http://localhost:8082/login`.
* Run the tests: `python -m unittest discover -s tests` (from `backend/`).
* All data stays on this PC: `backend/data/` (SQLite history, settings with password hashes and the gateway API key).
  This folder is never uploaded to GitHub.

## 2. Pages

| Page | What it shows |
|---|---|
| Overview | Summary strip (devices/tags total, online, stale, offline/error, active alarms), the plant key points, process trend (1 h … 7 d, past day), and the other process values |
| Devices | Searchable list of every signal: value, unit, last update (IST), comm state and quality. RTD group (20 slots), group tabs, "not online only" filter, and a detail drawer with the last 8 h trend |
| Tank levels / Mimic / Instruments / Equipment / Data log / IO list | As before (HMI parity) |
| Trends | Up to 6 values; 15 min, 1 h, 8 h, 24 h, 7 d or **Custom** from/to (IST, ≤ 31 days); drag across a chart to zoom; gaps = no data; tooltips, legend, units, CSV (IST times) |
| Reports | **Daily** (00:00–24:00 IST) or **Shift** report: min/max/average and data coverage per value, run hours per motor, alarms with PLC/DASHBOARD source. CSV and print/PDF |
| Alarms | Active alarms and history: severity, source (PLC or DASHBOARD-calculated), device, raised, acknowledged (who/when, separate from cleared), cleared |
| Settings (`/admin`, admin only) | Communication (Demo / Modbus TCP / **Gateway API**), Tags (incl. gateway Source ID), Equipment, **Display & reports** (RTD group, shifts), Activity log, **Accounts & roles** |

## 3. Roles (enforced on the server)

| Role | Dashboard | Acknowledge alarms, edit set points / scaling | Settings |
|---|---|---|---|
| Admin | yes | yes | yes |
| Operator | yes | yes | no (403) |
| Viewer | yes | no (403, "view-only") | no |

The built-in `admin` and the shared client login (operator) stay. Add more operator / viewer accounts under
Settings › Accounts. Sessions are kept in memory, so restarting the server signs everyone out.

The dashboard sends **no equipment commands** (start/stop/open/close). Set-point and scaling writes that existed
before are limited to operator/admin. More commands only on an explicit request, with an interlock design.

## 4. Data honesty rules

* A value is shown as live only when its last read succeeded in the current cycle (`Online`).
* `Stale`: not refreshed for 3 read cycles. `Offline`: last read failed; the last value is kept but greyed, with its
  time stamp. `Config error`: mapping problem (address / source id). `Waiting`: no read yet since start.
* A valid `0` is shown as `0`; missing data is shown as `--` / "no data", never as 0.
* Demo mode labels everything **DEMO DATA**.
* Report figures leave out minutes without data and show the **data coverage %**.
* Times are Asia/Kolkata (IST, UTC+05:30) everywhere; storage is UTC epoch.

## 5. Gateway API mode

The IoT gateway's HTTP API is **not documented yet**, so no endpoint is assumed. In Settings › Communication choose
**Gateway API** and enter the readings URL, the auth header and key (stored on the server only), the readings path
and the field names. See `docs/examples/gateway_api_response.example.json` (an **example**, not the real API).
Each tag is matched by its **Source ID** (Tags page), falling back to its PLC symbol, then its tag ID.
MQTT is not implemented: there is no broker/topic information yet.

## 6. Verified so far, and not verified

* Verified on this PC: tests (roles, gateway parsing, period reports, …) and the pages in demo mode, plus the
  offline/stale states with an unreachable gateway URL.
* **Not tested: live communication with the PLC or with the IoT gateway API.** Tag addresses come from the IO list
  and are `mapping_verified: false` until they are compared with the HMI on site.

## 7. Information still needed

1. Gateway API documentation: base URL, readings endpoint, auth method (header name / token / OAuth), JSON layout,
   time stamp format and time zone, quality flags, rate limit. Or, for MQTT: broker, port, TLS, topics, payload.
2. The ids the gateway uses for each signal (to fill each tag's Source ID).
3. Whether the gateway exposes the multifunction meter (MFM) and VFD (Hz / A) data. Today the HMI reads them
   directly, so they are not available through the PLC.
4. Which 20 RTD channels form the RTD group. Today only 4 temperature transmitters (T-01 … T-04) plus 2 spare AI
   are in the IO list.
5. Shift timings (now A 06:00, B 14:00, C 22:00 as a placeholder).
6. Alarm limits per value for dashboard-calculated alarms (HH / H / L / LL), if wanted besides the PLC alarms.
7. User list and roles for the client (operators / viewers).
8. Production / consumption figures for reports (flow totaliser, energy meter): source and definition.
9. Site sign-off: date, person and the HMI comparison for every tag.
