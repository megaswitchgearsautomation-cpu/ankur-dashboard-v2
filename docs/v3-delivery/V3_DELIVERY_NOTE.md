# Ankur FSTP-200 dashboard – v3 delivery note

Change brief: *Plant SCADA platform changes*, client review 14-11-2026 (SC01–SC07)
Delivered: 15-11-2026, 07:30 UTC / 13:00 IST

## 1. Old and new versions

| | Previous version (v2) | New version (v3) |
|---|---|---|
| URL | http://localhost:8082 | http://localhost:8083 |
| Folder | `10.Dashboard\3.Ankur Dashboard v2 (new design)` | `10.Dashboard\4.Ankur Dashboard v3 (brief 14-11-2026)` |
| Start | `start_dashboard.bat` in that folder | `start_dashboard.bat` in that folder |

- v2 was not changed. v3 is a copy that started with the same settings and history.
- **Compare:** start both versions, then open the two URLs side by side.
- **Roll back:** stop v3 (the `pythonw` process on port 8083) and keep using v2 on 8082. Nothing has to be copied back.
- **Live plant:** connect only one version to the plant at a time. Use the other one for viewing only.
- **Original page:** the v2 `index.html` is also kept inside v3 as `frontend\index.html.v2-original`.

## 2. Completion list

| Item | What changed | Screenshot |
|---|---|---|
| SC01 | Fonts are larger: 12 px minimum, and readable sizes for chart controls, tables and exports. | 01 |
| SC01 | Status bar headings and values are aligned, and the bar shows on the Dashboard only. | 01 |
| SC01 | The owl button and its chat are removed. | 01 |
| SC01 | The Plant areas tiles are removed. | 01 |
| SC01 | Menu order is Dashboard → Mimic → Set points … Tank levels and Data log are no longer in the menu. | 01 |
| SC02 | Dashboard cards show the tank as a picture with pumps and valves. Each card shows **Actual** with units and a short **Set point** summary. | 01 |
| SC02 | Float-switch tanks each get their own card and show only their switch states (no made-up levels). | 01 |
| SC02 | Show more / Show less opens the tank trend: 8 hours, 2 days, 7 days, or Custom with two dates, plus zoom. | 02 |
| SC02 | The pencil on a card opens that tank's section in Set points. | 02 |
| SC02 | Cards can be dragged into a new order, which is saved per user. Light dividers separate the columns. | 01 |
| SC03 | Set points keeps its name. Set point numbers are black. | 05, 06 |
| SC03 | The live value turns amber from 90 % of the set point and red at or above it. All 9 alarm set points are high limits (confirmed). | 05, 06 |
| SC03 | Pencils sit right beside the value they change, and the delay pencil beside Set delay. Edits open a small pop-up with Save / Cancel. | 05, 06 |
| SC03 | The column is renamed **Difference** and has a tooltip explaining it. Info icons sit on the right of headings. | 05, 06 |
| SC03 | All tables are left-aligned. Every list table has a search bar (Set points, IO list, Equipment, Reports, Data log, Alarm history). Open Tank levels links are removed. | 05, 06 |
| SC04 | The mimic opens on Overall plant. The 2D / 3D switch sits beside the heading; the 3D tab is gone. | 03 |
| SC04 | The drawing fits the view when it opens. Zoom −/+, Fit, drag to pan and Full screen work on every mimic. | 03 |
| SC04 | Long pipes have flow arrows. Labels no longer overlap; this was checked on all 8 sheets. | 03, 04 |
| SC04 | The AUTO tag is moved off the mixer. The Chemical dilution tank label is clear of its valves. | 03, 04 |
| SC04 | Tank level and % are larger in the tank centre. Each mimic shows its own alerts strip at the top. | 03, 04 |
| SC05 | Valve colours come from the open/close limit switches: open, closed, commanded (output only, not confirmed) or unknown. | 03 |
| SC05 | Flow animates only when a pump runs and the valves on that path are confirmed open. 2D and 3D use the same rule. | 03 |
| SC05 | The IO list tabs, search and export stay at the top while scrolling. The list is read-only and has CSV and PDF export. | 07 |
| SC05 | Equipment status filters now combine with the selected area. | 10 |
| SC06 | Trends, the dashboard trend and tank trends share one range picker: one calendar icon with start and end dates. | 08 |
| SC06 | Every chart has zoom − / +, ‹ › to move, Full range, and drag-to-zoom. | 08 |
| SC06 | Selection pills are equal width and the dots stay round. Export CSV and Export PDF use the readable button size. | 08 |
| SC07 | The Data log is now a view inside Reports and still shows 15-minute readings by default. Recording continues as before (every 10 s, kept 30 days), and no stored history was removed. | 09 |
| SC07 | Reports offers Daily / Weekly / Monthly / Custom with start and end dates; Shift is removed. | 09 |
| SC07 | Show report has the same height as the inputs. Exports are Excel, CSV and PDF. | 09 |
| SC07 | The date picker is limited to the history actually stored (retention plus oldest sample). Nothing is hard-coded to 7 days. | 09 |
| SC07 | The Alarms page works as before, with a range picker, search and CSV / PDF export added. | 11 |
| Extra | Changing page now opens the new page at its top. Before, it kept the previous page's scroll position. | – |

Checks run on a test copy with simulated data:
- **Screen sizes:** all pages at 1366 px and 375 px, with no sideways scroll or clipped text.
- **Set points:** search, Save / Cancel, and the pencil jump from a dashboard card.
- **Dashboard cards:** expand / collapse and saved card order.
- **Charts:** zoom and pan, and the custom range with two dates.
- **IO list:** the header stays on top while the DI → DO → AI tabs switch.
- **Equipment:** the area + status filters.
- **Reports and Data log:** search on both.
- **Backend:** 86 automated tests pass.

Screenshots are in `docs\v3-delivery\screenshots\`. They were taken on the test copy with demo data, and the Set points pencils are shown for an operator login. View-only logins see no pencils, by design.

## 3. Open dependencies (Mega Automation)

1. **Mimic write controls (Auto / Manual, manual start):** not added. Waiting for confirmation that they are in scope.
2. **Raw water → wash room / general-purpose tank line:** check the branch order of FS-301 and the wash-room line against the P&ID, and whether there is a single NRV after the borewell pumps. Also check for missing valves on the wash-room line and the filtrate return.
3. **IO list issues:**
   - The MV-101 limit switches are marked NC but are not inverted.
   - Y2.0 is used twice (spare pump-1 / spare valve-1).
   - The auto drain valve is Y2.11 in one place and Y2.13 in another.
4. **History retention:** the date picker follows the stored history; it is currently set to 30 days. Confirm the retention you want on site.
5. **Live plant:** none of this was tested against the live plant. All checks used simulated data.
6. **Possible later backend changes:** custom trend ranges are capped at 31 days, and alarm history is filtered by date in the browser.
