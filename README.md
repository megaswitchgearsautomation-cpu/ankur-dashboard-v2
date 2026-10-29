# Medge Controls - Plant Monitoring Dashboard (Phase 1, read-only)

FSTP-200 Muttathara (Trivandrum) Op Panel for Ankur Scientific.
**Delta AHCPU521-EN → Phoenix switch → Teltonika RUT200 (4G/VPN) → Backend → Web dashboard.**

Regenerate tags (overwrites config/tags.json and equipment.json):
`python tools/import_io_list.py --ours "<IO LIST FOR OP PANNEL latest 16_03_2026.xlsx>" --client "<R1. IO LIST 9-2-26 (1).xlsx>" --force`

* **Backend:** Python 3 (standard library only, no `pip install`). It is a Modbus TCP *client* that only reads
  (FC01/02/03/04), with a SQLite historian, an alarm engine and equipment status logic.
* **Client dashboard** (`/`) - **view only, for Ankur Scientific**: process values with alarm set points, equipment
  status and run hours, trends, active alarms and alarm history, plant status and last-update time.
  It never shows (and the client API never sends) PLC model, IP, Modbus addresses, tag IDs, error messages or link
  diagnostics. It has no buttons that change anything and no link to Admin. Data status is shown only as
  DEMO DATA / LIVE / COMMISSIONING / OFFLINE.
* **Admin** (`/admin`, password protected, Medge only - type the URL; it is not linked from the client page): link
  quality and diagnostics, PLC/gateway communication settings, data-source mode, and tag editing.
  Each tag has a Delta device, data type, word order, bit, scaling, unit, poll interval and alarm limits, plus a live
  Modbus address preview (FC, zero- and one-based address) and a **Test read**. Equipment is edited here too.

Values are labelled **SIMULATED** until the mode is switched to Modbus. They are labelled **UNVERIFIED** until
communication and each tag mapping are signed off on site (see `docs/DELTA_MODBUS_MAPPING.md`).

## Client reports (Reports tab)

Pick a period (Today, Yesterday, Last 24 h, Last 7 days, This month or Custom) and an interval (1 min … 1 day).
The report is a **data log only**: one time-stamped row per interval (average), with every process value: all tank
levels, temperatures, pressures and pH (no selection, no summary). **View report** shows it on screen. **Excel**
downloads an .xlsx with one *Data log* sheet (report details on top). **PDF** downloads an A4-landscape data log with
a branded header and page numbers. Limits: 31 days,
5000 rows; the page suggests a longer interval if needed. History is kept for `historian.retention_days`
(default 30) at `log_interval_s` resolution (default 10 s). Simulated data is always labelled DEMO DATA.

## Login and roles

Everyone starts at **http://localhost:8080/login**. Pages cannot be opened directly without signing in, and signing
out or a session timeout returns to the login page.

| Role | Default login | Lands on | Can open |
|---|---|---|---|
| Admin (Medge - tagging) | `admin` / `admin123` | `/admin` - tags, communication, equipment, accounts | admin page only |
| Client (Ankur - view only) | `ankur` / `ankur123` | `/` - view-only dashboard | client dashboard only |

Change both passwords in **Admin → Accounts** before going live. Changing the client login there signs the client out
everywhere. Restarting the server signs everyone out.

## Run

```bat
start_dashboard.bat
```
or `python backend/run.py [--port 8080]`. Then open http://localhost:8080 (dashboard) and http://localhost:8080/admin.

Default admin password: `admin123`. You must change it (Admin → Account) before the dashboard is put on a network.

## Folder layout

```
backend/
  run.py                    entry point
  app/delta_ah500.py        Delta AH500 device -> Modbus address (AH500 Operation Manual App. B.1)
  app/modbus_tcp.py         read-only Modbus TCP client
  app/codec.py              REAL/INT decoding, word order, scaling
  app/engine.py             poller (block reads), simulator, alarms, equipment status, run hours
  app/historian.py          SQLite: samples, alarms journal, events, run hours
  app/server.py             HTTP + JSON API
  config/tags.json          222 tags: AI from our IO list, DI/DO from client R1 list, tags from motor list
  config/equipment.json     25 motors (OP-P1A … OP-P17, OP-F1/F2, OP-M1, PCP, agitator) + 3 valves
  config/settings.json      created on first run (PLC IP 192.168.1.2:502, unit 1, mode = simulation)
  data/history.sqlite3      created on first run
  tools/import_io_list.py   regenerate tags/equipment from the IO-list Excel
  tools/fake_ah500.py       bench-test Modbus server with the AH500 address layout (NOT a PLC)
  tests/                    python -m unittest discover -s tests   (run inside backend/)
frontend/                   index.html (client), admin.html (admin), css, js - no CDN, works offline
docs/DELTA_MODBUS_MAPPING.md   hardware found, address rules, discrepancies, site verification steps
```

## Bench test without the PLC

```bat
cd backend
python tools\fake_ah500.py --port 1502
```
Admin → Communication: host `127.0.0.1`, port `1502`, mode *Modbus TCP* → Save. Switch back to `192.168.1.2:502` afterwards.

## API (read-only for clients)

`GET /api/live`, `GET /api/trend?tags=CT_01,CT_07&minutes=60`, `GET /api/alarms?state=active|history`,
`POST /api/alarms/ack` (dashboard journal only, nothing is written to the PLC). Admin endpoints are under `/api/admin/*`.

## Not in phase 1 (from the Medge scope document)

Batch/golden-batch reports, PDF/Excel export and scheduled e-mail, WhatsApp/SMS notifications and chatbot,
role-based tablet dashboards, operator accountability and ranking, and EMS energy meters. The tag, historian and alarm
layers built here are the foundation for those modules.
