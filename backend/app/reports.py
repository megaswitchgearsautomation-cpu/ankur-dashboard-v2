"""Client data reports: process values over a time frame, as JSON preview, Excel (.xlsx) or PDF.

Standard library only - the .xlsx (Office Open XML) and the PDF are written directly.
Times are the server's local time.  Simulated (demo) data is always labelled.
"""
from __future__ import annotations

import io
import math
import time
import zipfile
from datetime import datetime
from xml.sax.saxutils import escape as xml_escape

INTERVALS = {60: "1 minute", 300: "5 minutes", 900: "15 minutes", 1800: "30 minutes", 3600: "1 hour",
             21600: "6 hours", 86400: "1 day"}
MAX_ROWS = 5000
MAX_DAYS = 31
PROCESS_GROUPS = ("Level", "Temperature", "Pressure", "Analysis")


class ReportError(ValueError):
    pass


def reportable_tags(store):
    """Tags a client may report on: dashboard-visible analog process values."""
    out = [t for t in store.tags if t.get("show_on_dashboard", True) and t.get("data_type") != "BOOL"
           and t.get("group") in PROCESS_GROUPS]
    order = {g: i for i, g in enumerate(PROCESS_GROUPS)}
    return sorted(out, key=lambda t: (order.get(t.get("group"), 9), t.get("name", "")))


def build(store, historian, tag_ids, t_from, t_to, interval_s):
    allowed = {t["id"]: t for t in reportable_tags(store)}
    tags = [allowed[i] for i in tag_ids if i in allowed] or list(allowed.values())
    if interval_s not in INTERVALS:
        raise ReportError("Invalid interval")
    if t_to <= t_from:
        raise ReportError("'To' must be after 'From'")
    if t_to - t_from > MAX_DAYS * 86400:
        raise ReportError(f"Maximum report period is {MAX_DAYS} days")
    first = math.floor(t_from / interval_s) * interval_s
    n_rows = int(math.ceil((t_to - first) / interval_s))
    if n_rows > MAX_ROWS:
        need = next((s for s in sorted(INTERVALS) if math.ceil((t_to - t_from) / s) <= MAX_ROWS), 86400)
        raise ReportError(f"Too many rows ({n_rows}). Choose an interval of {INTERVALS[need]} or longer.")
    data = historian.report_buckets([t["id"] for t in tags], t_from, t_to, interval_s)

    rows, any_sim = [], False
    for k in range(n_rows):
        b = first + k * interval_s
        vals = []
        for t in tags:
            cell = data[t["id"]].get(float(b))
            if cell:
                any_sim = any_sim or cell[4]
                vals.append(round(cell[0], int(t.get("decimals", 1)) + 1))
            else:
                vals.append(None)
        if any(v is not None for v in vals):
            rows.append({"t": b, "values": vals})

    summary = []
    for t in tags:
        cells = list(data[t["id"]].values())
        n = sum(c[3] for c in cells)
        summary.append({
            "id": t["id"], "name": t["name"], "unit": t.get("unit", ""), "group": t.get("group", ""),
            "decimals": int(t.get("decimals", 1)),
            "min": min((c[1] for c in cells), default=None), "max": max((c[2] for c in cells), default=None),
            "avg": (sum(c[0] * c[3] for c in cells) / n) if n else None, "samples": n,
        })
    site = store.settings["site"]
    return {
        "title": "Process Data Report",
        "site": f"{site.get('name', '')} · {site.get('panel', '')}",
        "client": "Ankur Scientific", "provider": "Medge Controls",
        "from": t_from, "to": t_to, "interval_s": interval_s, "interval": INTERVALS[interval_s],
        "generated": time.time(), "simulated": any_sim,
        "columns": [{"id": t["id"], "name": t["name"], "unit": t.get("unit", ""), "decimals": int(t.get("decimals", 1))} for t in tags],
        "rows": rows, "summary": summary,
    }


def fmt_ts(ts, seconds=False):
    return time.strftime("%d-%m-%Y %H:%M:%S" if seconds else "%d-%m-%Y %H:%M", time.localtime(ts))


def fmt_num(v, d):
    return "-" if v is None else f"{v:.{d}f}"


def filename(rep, ext):
    return f"Process_Report_{time.strftime('%Y%m%d_%H%M', time.localtime(rep['from']))}" \
           f"_to_{time.strftime('%Y%m%d_%H%M', time.localtime(rep['to']))}.{ext}"


# =====================================================================================
# Excel (.xlsx) - minimal SpreadsheetML writer
# =====================================================================================
def _col(n):
    s = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def _xl_date(ts):
    dt = datetime.fromtimestamp(ts)
    return (dt - datetime(1899, 12, 30)).total_seconds() / 86400.0


def _cell(ref, value, style=0):
    if value is None or value == "":
        return f'<c r="{ref}" s="{style}"/>'
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f'<c r="{ref}" s="{style}"><v>{value!r}</v></c>'
    return f'<c r="{ref}" s="{style}" t="inlineStr"><is><t xml:space="preserve">{xml_escape(str(value))}</t></is></c>'


def _sheet(rows, widths, freeze_row=None, merges=()):
    out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
           '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
           'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">']
    if freeze_row:
        out.append(f'<sheetViews><sheetView workbookViewId="0"><pane ySplit="{freeze_row}" topLeftCell="A{freeze_row + 1}" '
                   'activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>')
    out.append("<cols>" + "".join(f'<col min="{i + 1}" max="{i + 1}" width="{w}" customWidth="1"/>' for i, w in enumerate(widths)) + "</cols>")
    out.append("<sheetData>")
    for r, row in enumerate(rows):
        cells = "".join(_cell(f"{_col(c)}{r + 1}", v, s) for c, (v, s) in enumerate(row))
        out.append(f'<row r="{r + 1}">{cells}</row>')
    out.append("</sheetData>")
    if merges:
        out.append(f'<mergeCells count="{len(merges)}">' + "".join(f'<mergeCell ref="{m}"/>' for m in merges) + "</mergeCells>")
    out.append('<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>')
    return "".join(out)


STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="dd-mm-yyyy hh:mm"/></numFmts>
<fonts count="4">
 <font><sz val="10"/><name val="Calibri"/></font>
 <font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
 <font><b/><sz val="15"/><color rgb="FF34178F"/><name val="Calibri"/></font>
 <font><b/><sz val="10"/><color rgb="FFB52A2A"/><name val="Calibri"/></font>
</fonts>
<fills count="4">
 <fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
 <fill><patternFill patternType="solid"><fgColor rgb="FF5B2FD0"/></patternFill></fill>
 <fill><patternFill patternType="solid"><fgColor rgb="FFF3F1FA"/></patternFill></fill>
</fills>
<borders count="2"><border/><border><left style="thin"><color rgb="FFE0DDEB"/></left><right style="thin"><color rgb="FFE0DDEB"/></right>
 <top style="thin"><color rgb="FFE0DDEB"/></top><bottom style="thin"><color rgb="FFE0DDEB"/></bottom></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
 <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
 <xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="center" horizontal="center"/></xf>
 <xf numFmtId="164" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/>
 <xf numFmtId="0" fontId="2" fillId="0" borderId="0" applyFont="1"/>
 <xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1"/>
 <xf numFmtId="4" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/>
 <xf numFmtId="0" fontId="3" fillId="0" borderId="0" applyFont="1"/>
 <xf numFmtId="0" fontId="0" fillId="3" borderId="1" applyFill="1" applyBorder="1"/>
</cellXfs>
</styleSheet>"""
S_HEAD, S_DATE, S_TITLE, S_TEXT, S_NUM, S_WARN, S_LABEL = 1, 2, 3, 4, 5, 6, 7


def to_xlsx(rep) -> bytes:
    cols = rep["columns"]
    meta = [
        [(rep["title"], S_TITLE)],
        [("Site", S_LABEL), (rep["site"], S_TEXT)],
        [("Client", S_LABEL), (rep["client"], S_TEXT)],
        [("Period", S_LABEL), (f"{fmt_ts(rep['from'])}  to  {fmt_ts(rep['to'])}", S_TEXT)],
        [("Interval", S_LABEL), (f"{rep['interval']} (average per interval)", S_TEXT)],
        [("Generated", S_LABEL), (fmt_ts(rep["generated"], True), S_TEXT)],
        [("Powered by", S_LABEL), (rep["provider"], S_TEXT)],
    ]
    if rep["simulated"]:
        meta.append([("DEMO DATA - these values are simulated, not measured plant data.", S_WARN)])
    # one sheet: report details on top, then the data log (header row frozen)
    log = meta + [[]] + [[("Date / time", S_HEAD)] + [(f"{c['name']} ({c['unit']})" if c["unit"] else c["name"], S_HEAD) for c in cols]]
    head_row = len(log)
    for r in rep["rows"]:
        log.append([(_xl_date(r["t"]), S_DATE)] + [(v, S_NUM) for v in r["values"]])
    sheet1 = _sheet(log, [18] + [16] * len(cols), freeze_row=head_row)
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
        "docProps/core.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Process Data Report</dc:title><dc:creator>Medge Controls</dc:creator></cp:coreProperties>',
        "xl/workbook.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data log" sheetId="1" r:id="rId1"/>'
        '</sheets></workbook>',
        "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
        "xl/styles.xml": STYLES,
        "xl/worksheets/sheet1.xml": sheet1,
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, content in files.items():
            z.writestr(name, content)
    return buf.getvalue()


# =====================================================================================
# PDF - minimal writer (A4 landscape, Helvetica, WinAnsi encoding)
# =====================================================================================
PAGE_W, PAGE_H, MARGIN = 842, 595, 34
VIOLET = (0.357, 0.184, 0.816)
INK, MUTED, LINE, BAND = (0.09, 0.08, 0.17), (0.45, 0.43, 0.55), (0.88, 0.87, 0.92), (0.953, 0.945, 0.98)


def _pdf_text(s):
    b = str(s).encode("cp1252", "replace")
    return b.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def _w(s, size):     # approximate Helvetica text width
    return len(str(s)) * size * 0.5


def _fit(s, size, width):
    s = str(s)
    while s and _w(s, size) > width:
        s = s[:-2] + "…" if len(s) > 2 else ""
    return s


def _wrap(s, size, width, max_lines=3):
    words, lines, cur = str(s).split(), [], ""
    for w in words:
        nxt = (cur + " " + w).strip()
        if _w(nxt, size) <= width:
            cur = nxt
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = _fit(lines[-1] + "…", size, width)
    return [_fit(x, size, width) for x in lines]


class _Page:
    def __init__(self):
        self.ops = []

    def rect(self, x, y, w, h, fill=None, stroke=None):
        if fill:
            self.ops.append(f"{fill[0]:.3f} {fill[1]:.3f} {fill[2]:.3f} rg")
        if stroke:
            self.ops.append(f"{stroke[0]:.3f} {stroke[1]:.3f} {stroke[2]:.3f} RG 0.5 w")
        op = "B" if fill and stroke else ("f" if fill else "S")
        self.ops.append(f"{x:.1f} {y:.1f} {w:.1f} {h:.1f} re {op}")

    def line(self, x1, y1, x2, y2, color=LINE):
        self.ops.append(f"{color[0]:.3f} {color[1]:.3f} {color[2]:.3f} RG 0.5 w {x1:.1f} {y1:.1f} m {x2:.1f} {y2:.1f} l S")

    def text(self, x, y, s, size=9, bold=False, color=INK, align="left"):
        if align == "right":
            x -= _w(s, size)
        elif align == "center":
            x -= _w(s, size) / 2
        pre = (f"BT /{'F2' if bold else 'F1'} {size} Tf {color[0]:.3f} {color[1]:.3f} {color[2]:.3f} rg "
               f"{x:.1f} {y:.1f} Td (").encode()
        self.ops.append(pre + _pdf_text(s) + b") Tj ET")

    def stream(self):
        return b"\n".join(op if isinstance(op, bytes) else op.encode() for op in self.ops) + b"\n"


def to_pdf(rep) -> bytes:
    pages = []
    cols = rep["columns"]
    content_w = PAGE_W - 2 * MARGIN

    def new_page():
        p = _Page()
        p.rect(0, PAGE_H - 46, PAGE_W, 46, fill=VIOLET)
        p.text(MARGIN, PAGE_H - 29, rep["title"], 15, True, (1, 1, 1))
        p.text(PAGE_W - MARGIN, PAGE_H - 22, "Ankur Scientific", 10, True, (1, 1, 1), "right")
        p.text(PAGE_W - MARGIN, PAGE_H - 35, "Powered by Medge Controls", 8, False, (0.9, 0.88, 1), "right")
        p.text(MARGIN, PAGE_H - 62, f"{rep['site']}   |   {fmt_ts(rep['from'])}  to  {fmt_ts(rep['to'])}   |   "
               f"Interval: {rep['interval']} (average)", 8.5, False, MUTED)
        if rep["simulated"]:
            p.rect(MARGIN, PAGE_H - 84, content_w, 15, fill=(0.93, 0.91, 0.99))
            p.text(MARGIN + 6, PAGE_H - 79, "DEMO DATA - values in this report are simulated, not measured plant data.", 8.5, True, VIOLET)
        pages.append(p)
        return p, PAGE_H - (96 if rep["simulated"] else 78)

    # ---- data log pages (columns split into groups that fit the page width)
    time_w, min_col = 92, 58
    per_group = max(1, int((content_w - time_w) // min_col))
    groups = [list(range(i, min(i + per_group, len(cols)))) for i in range(0, len(cols), per_group)] or [[]]
    for gi, grp in enumerate(groups):
        col_w = (content_w - time_w) / max(1, len(grp))
        p, y = new_page()
        title = "Data log" + (f" (columns {gi + 1}/{len(groups)})" if len(groups) > 1 else "")
        p.text(MARGIN, y - 4, title, 12, True)
        p.text(PAGE_W - MARGIN, y - 4, f"{len(rep['rows'])} rows  |  Generated {fmt_ts(rep['generated'], True)} (server local time)",
               8, False, MUTED, "right")
        y -= 14

        def header(p, y):
            h = 34
            p.rect(MARGIN, y - h, content_w, h, fill=VIOLET)
            p.text(MARGIN + 6, y - 20, "Date / time", 8, True, (1, 1, 1))
            for k, ci in enumerate(grp):
                c = cols[ci]
                lines = _wrap(c["name"], 7, col_w - 8, 2 if c["unit"] else 3) + ([f"({c['unit']})"] if c["unit"] else [])
                cx = MARGIN + time_w + k * col_w + col_w / 2
                for li, ln in enumerate(lines):
                    p.text(cx, y - 10 - li * 8.5, ln, 7, True, (1, 1, 1), "center")
            return y - h - 11

        y = header(p, y)
        if not rep["rows"]:
            p.text(MARGIN + 6, y, "No data recorded in this period.", 9, False, MUTED)
        for ri, r in enumerate(rep["rows"]):
            if y < MARGIN + 18:
                p, y = new_page()
                y = header(p, y - 4)
            if ri % 2:
                p.rect(MARGIN, y - 3.5, content_w, 11.5, fill=BAND)
            p.text(MARGIN + 6, y, fmt_ts(r["t"]), 7.5)
            for k, ci in enumerate(grp):
                v = r["values"][ci]
                p.text(MARGIN + time_w + (k + 1) * col_w - 6, y, fmt_num(v, cols[ci]["decimals"]), 7.5, False, INK, "right")
            y -= 11.5

    # footers
    for i, pg in enumerate(pages):
        pg.line(MARGIN, 24, PAGE_W - MARGIN, 24)
        pg.text(MARGIN, 13, "Ankur Scientific · Plant monitoring · Powered by Medge Controls", 7.5, False, MUTED)
        pg.text(PAGE_W - MARGIN, 13, f"Page {i + 1} of {len(pages)}", 7.5, False, MUTED, "right")

    # ---- assemble PDF objects
    objs = []

    def add(b):
        objs.append(b)
        return len(objs)

    cat = add(None)
    pages_id = add(None)
    f1 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    f2 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
    kids = []
    for pg in pages:
        data = pg.stream()
        cid = add(b"<< /Length %d >>\nstream\n" % len(data) + data + b"endstream")
        kids.append(add(b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %d %d] /Resources << /Font << /F1 %d 0 R /F2 %d 0 R >> >> /Contents %d 0 R >>"
                        % (pages_id, PAGE_W, PAGE_H, f1, f2, cid)))
    objs[cat - 1] = b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id
    objs[pages_id - 1] = b"<< /Type /Pages /Kids [" + b" ".join(b"%d 0 R" % k for k in kids) + b"] /Count %d >>" % len(kids)
    info = add(b"<< /Title (Process Data Report) /Author (Medge Controls) /Producer (Medge Controls dashboard) >>")

    out = io.BytesIO()
    out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, ob in enumerate(objs, 1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n" % i + ob + b"\nendobj\n")
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1))
    for off in offsets:
        out.write(b"%010d 00000 n \n" % off)
    out.write(b"trailer\n<< /Size %d /Root %d 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, cat, info, xref))
    return out.getvalue()
