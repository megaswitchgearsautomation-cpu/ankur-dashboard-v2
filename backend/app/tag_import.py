"""Import PLC addresses from an Excel / CSV export and match them to the configured tags.

Accepts the ISPSoft / DIADesigner symbol-table export (Identifier, Address, Type, Comment), the
Excel template produced by ``template_xlsx`` (Tag ID, PLC symbol, Name, Delta device, ...), or any
sheet with an address column and a symbol / name column.  Nothing is saved here: ``preview``
returns proposed changes which the admin page applies to its working copy (then "Save tags").
"""
from __future__ import annotations

import csv
import io
import re
import zipfile
import xml.etree.ElementTree as ET

from . import codec, config_store, delta_ah500, reports

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
MAX_ROWS = 5000


class ImportError_(ValueError):
    pass


# ---------------------------------------------------------------------------- reading
def _col_index(ref):
    letters = re.sub(r"\d", "", ref or "")
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch.upper()) - 64)
    return n - 1


def read_xlsx(data: bytes):
    """-> [(sheet_name, [[cell text, ...], ...]), ...]"""
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ImportError_("Not a valid .xlsx file (old .xls is not supported - save as .xlsx or .csv)")
    names = z.namelist()
    ss = []
    if "xl/sharedStrings.xml" in names:
        ss = ["".join(t.text or "" for t in si.iter("{%s}t" % NS["m"]))
              for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS)]
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rmap = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    out = []
    for sh in wb.find("m:sheets", NS):
        tgt = rmap.get(sh.get("{%s}id" % NS["r"]), "").lstrip("/")
        tgt = tgt if tgt.startswith("xl/") else "xl/" + tgt
        if tgt not in names:
            continue
        rows = []
        for row in ET.fromstring(z.read(tgt)).iter("{%s}row" % NS["m"]):
            cells = {}
            for c in row.findall("m:c", NS):
                t = c.get("t")
                if t == "inlineStr":
                    v = "".join(x.text or "" for x in c.iter("{%s}t" % NS["m"]))
                else:
                    ve = c.find("m:v", NS)
                    if ve is None or ve.text is None:
                        continue
                    v = ss[int(ve.text)] if t == "s" else ve.text
                    if t not in ("s", "str") and re.fullmatch(r"-?\d+\.0", v):
                        v = v[:-2]
                cells[_col_index(c.get("r"))] = str(v).strip()
            if cells:
                rows.append([cells.get(i, "") for i in range(max(cells) + 1)])
            if len(rows) > MAX_ROWS:
                break
        out.append((sh.get("name"), rows))
    return out


def read_csv(data: bytes):
    for enc in ("utf-8-sig", "utf-16", "cp1252"):
        try:
            text = data.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise ImportError_("Cannot read the CSV text encoding")
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    rows = [[c.strip() for c in r] for r in csv.reader(io.StringIO(text), dialect) if any(c.strip() for c in r)]
    return [("CSV", rows[:MAX_ROWS])]


# ---------------------------------------------------------------------------- columns
HEADERS = {
    "id": ("tag id", "tagid", "id", "dashboard tag", "dashboard id"),
    "symbol": ("plc symbol", "plc tag", "symbol", "identifier", "identifiers", "variable", "variable name",
               "tag name", "tagname", "label", "tag"),
    "address": ("delta device", "device", "address", "plc address", "addr", "register", "device address",
                "modbus address", "modbus reference", "reference"),
    "type": ("data type", "datatype", "type"),
    "name": ("name", "description", "comment", "comments", "remark", "remarks"),
    "unit": ("unit", "units", "eng unit"),
    "min": ("min", "eng min", "range min", "low"),
    "max": ("max", "eng max", "range max", "high"),
    "group": ("group", "category"),
}
TYPE_MAP = {
    "BOOL": "BOOL", "BIT": "BOOL", "BOOLEAN": "BOOL",
    "INT": "INT16", "INT16": "INT16", "SINT": "INT16",
    "WORD": "UINT16", "UINT": "UINT16", "UINT16": "UINT16",
    "DINT": "INT32", "INT32": "INT32",
    "DWORD": "UINT32", "UDINT": "UINT32", "UINT32": "UINT32",
    "REAL": "REAL", "FLOAT": "REAL", "FLOAT32": "REAL",
}
ADDR_RE = re.compile(r"^%?\s*([A-Z]{1,2})\s*(\d+)(?:\.(\d+))?$", re.I)


def _norm_head(s):
    return re.sub(r"[^a-z0-9 ]", "", re.sub(r"[_\-/]", " ", str(s).lower())).strip()


def _find_header(rows):
    """Return (row_index, {field: col}) for the first row that names an address column."""
    for ri, row in enumerate(rows[:40]):
        heads = [_norm_head(c) for c in row]
        cols = {}
        for field, names in HEADERS.items():
            for name in names:                       # exact match first, in priority order
                if name in heads and heads.index(name) not in cols.values():
                    cols[field] = heads.index(name)
                    break
        if "address" in cols and len(cols) >= 2:
            return ri, cols
    return None, None


def _guess_columns(rows):
    """No header row: pick the column that mostly looks like Delta devices, plus a text column."""
    width = max((len(r) for r in rows), default=0)
    best, score = None, 0
    for c in range(width):
        vals = [r[c] for r in rows if c < len(r) and r[c]]
        hits = sum(1 for v in vals if ADDR_RE.match(v))
        if vals and hits > score and hits >= 0.6 * len(vals):
            best, score = c, hits
    if best is None:
        return None
    cols = {"address": best}
    for c in range(width):
        if c != best and any(c < len(r) and re.search(r"[A-Za-z]{3}", r[c] or "") and not ADDR_RE.match(r[c]) for r in rows):
            cols["symbol"] = c
            break
    return cols


def table_from_file(filename: str, data: bytes):
    """-> (sheet name, header row number (1-based) or None, column map, data rows)"""
    fn = (filename or "").lower()
    sheets = read_csv(data) if fn.endswith((".csv", ".txt")) else read_xlsx(data)
    candidates = []
    for name, rows in sheets:
        hi, cols = _find_header(rows)
        if cols:
            candidates.append((len(cols), name, hi + 1, cols, rows[hi + 1:]))
    if candidates:
        candidates.sort(key=lambda c: -c[0])
        _, name, hrow, cols, body = candidates[0]
        return name, hrow, cols, body
    for name, rows in sheets:
        cols = _guess_columns(rows)
        if cols:
            return name, None, cols, rows
    raise ImportError_("No address column found. Use a header like 'Address' / 'Delta device' "
                       "next to 'Identifier' / 'PLC symbol' / 'Tag ID' / 'Name'.")


# ---------------------------------------------------------------------------- matching
def _key(s):
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


def parse_address(text: str, data_type: str):
    """-> (device, address_override or None, ModbusAddress)  - raises AddressError."""
    t = re.sub(r"\s+", "", str(text or "")).lstrip("%").upper()
    if not t:
        raise delta_ah500.AddressError("empty address")
    if re.fullmatch(r"\d{5,6}", t):                     # Modbus reference 40001 / 411009
        raw = int(t)
        if len(t) == 5:                                 # 5-digit style: 4xxxx -> 40xxxx
            raw = int(t[0]) * 100000 + int(t[1:])
        ov = {"enabled": True, "base": "one", "function_code": 3, "address": raw, "bit": None}
        return "", ov, delta_ah500.from_override(ov, data_type)
    m = ADDR_RE.match(t)
    if m:
        t = m.group(1) + m.group(2) + (f".{m.group(3)}" if m.group(3) is not None else "")
    ma = delta_ah500.resolve(t, data_type)
    return ma.device, None, ma


def _bit(it):
    return it.get("bitpos")


def preview(store, filename: str, data: bytes):
    sheet, hrow, cols, body = table_from_file(filename, data)
    tags = store.tags
    by_id = {_key(t["id"]): t for t in tags}
    by_sym = {}
    by_name = {}
    for t in tags:
        if t.get("plc_tag"):
            by_sym.setdefault(_key(t["plc_tag"]), []).append(t)
        by_name.setdefault(_key(t.get("name")), []).append(t)

    def cell(row, f):
        c = cols.get(f)
        return row[c].strip() if c is not None and c < len(row) and row[c] else ""

    items, seen = [], {}
    first = (hrow or 0) + 1
    for i, row in enumerate(body):
        addr = cell(row, "address")
        if not addr:
            continue
        ident, sym, name = cell(row, "id"), cell(row, "symbol"), cell(row, "name")
        rtype = cell(row, "type").upper()
        it = {"row": first + i, "id": ident, "symbol": sym, "name": name, "address": addr,
              "type_in": rtype, "unit": cell(row, "unit"), "min": cell(row, "min"), "max": cell(row, "max"),
              "group": cell(row, "group")}
        # match: tag id -> PLC symbol -> symbol/id text against tag id -> name/comment
        match, how = None, ""
        for val, table, label in ((ident, by_id, "tag id"), (sym, None, "PLC symbol"), (sym, by_id, "tag id"),
                                  (name, None, "name")):
            k = _key(val)
            if not k:
                continue
            if table is by_id:
                if k in by_id:
                    match, how = by_id[k], label
            else:
                hits = (by_sym if label == "PLC symbol" else by_name).get(k, [])
                if len(hits) == 1:
                    match, how = hits[0], label
                elif len(hits) > 1:
                    it["warning"] = f"{len(hits)} tags share this {label}"
            if match:
                break
        dt_new = TYPE_MAP.get(rtype) if rtype else None
        if rtype and not dt_new:
            it["warning"] = f"data type '{rtype}' not supported - kept existing / BOOL"
        dt = dt_new or (match or {}).get("data_type") or ("BOOL" if "." in addr or addr[:1].upper() in "XYMS" else "INT16")
        it["data_type"] = dt
        try:
            dev, ov, ma = parse_address(addr, dt)
            it.update(device=dev, override=ov, fc=ma.function_code, modbus=ma.address, reference=ma.reference, bitpos=ma.bit)
        except (delta_ah500.AddressError, codec.DecodeError, ValueError) as e:
            it.update(status="error", message=str(e), match=match["id"] if match else None, how=how)
            items.append(it)
            continue
        if match:
            tid = match["id"]
            if tid in seen:
                it.update(status="error", match=tid, how=how,
                          message=f"tag {tid} already matched by row {seen[tid]} - duplicate in the file")
                items.append(it)
                continue
            seen[tid] = it["row"]
            old = match.get("device") or ""
            old_ov = match.get("address_override") or {}
            same_addr = (ov is None and not old_ov.get("enabled") and old.upper() == dev.upper()) or \
                        (ov is not None and old_ov.get("enabled") and int(old_ov.get("address", -1)) == ov["address"])
            same_type = dt == match.get("data_type")
            it.update(match=tid, how=how, tag_name=match.get("name"), old_device=old if not old_ov.get("enabled")
                      else f"custom {old_ov.get('function_code')}:{old_ov.get('address')}",
                      old_type=match.get("data_type"),
                      status="same" if same_addr and same_type else "update")
        else:
            it.update(status="new", match=None)
        items.append(it)
    # address clashes: same FC + address (+ bit) as another tag that this file does not move away
    final = {}
    for t in tags:
        try:
            ma = config_store.resolve_tag(t)
            final[t["id"]] = (ma.function_code, ma.address, ma.bit)
        except Exception:
            pass
    for it in items:
        if it["status"] in ("update", "same") and it.get("fc"):
            final[it["match"]] = (it["fc"], it["modbus"], _bit(it))
    users = {}
    for tid, a in final.items():
        users.setdefault(a, []).append(tid)
    for it in items:
        if it["status"] in ("update", "new") and it.get("fc"):
            others = [x for x in users.get((it["fc"], it["modbus"], _bit(it)), []) if x != it.get("match")]
            if others:
                it["warning"] = "same PLC address as " + ", ".join(others[:3]) + (" …" if len(others) > 3 else "")
    matched = {it["match"] for it in items if it.get("match")}
    missing = [{"id": t["id"], "name": t.get("name"), "device": t.get("device")} for t in tags if t["id"] not in matched]
    counts = {s: sum(1 for it in items if it["status"] == s) for s in ("update", "same", "new", "error")}
    return {"ok": True, "sheet": sheet, "header_row": hrow,
            "columns": {k: reports._col(v) for k, v in cols.items()}, "items": items,
            "counts": counts, "not_in_file": missing}


# ---------------------------------------------------------------------------- template
def template_xlsx(store) -> bytes:
    S_HEAD, S_TEXT = reports.S_HEAD, reports.S_TEXT
    head = ["Tag ID", "PLC symbol", "Name", "Group", "Delta device", "Data type", "Unit", "Min", "Max",
            "Modbus FC", "Modbus address (0-based)", "Reference (1-based)"]
    rows = [[(h, S_HEAD) for h in head]]
    for t in store.tags:
        try:
            ma = config_store.resolve_tag(t)
            fc, addr, ref = ma.function_code, ma.address, ma.reference
        except Exception:
            fc = addr = ref = ""
        rows.append([(v, S_TEXT) for v in (t["id"], t.get("plc_tag", ""), t.get("name", ""), t.get("group", ""),
                                            t.get("device", ""), t.get("data_type", ""), t.get("unit", ""),
                                            t.get("eng_min", ""), t.get("eng_max", ""), fc, addr, ref)])
    help_rows = [[(x, S_TEXT)] for x in (
        "How to use",
        "1. Fill or correct the 'Delta device' column (e.g. D11008, X0.8, Y1.4, M100, D15000.3).",
        "   Or paste a Modbus reference such as 411009 for a custom address.",
        "2. Keep 'Tag ID' (or 'PLC symbol') so each row matches its dashboard tag. Rows with a new Tag ID become new tags.",
        "3. Data type: BOOL, INT16, UINT16, INT32, UINT32, REAL (ISPSoft names WORD, DINT, DWORD... are also accepted).",
        "4. Admin > Tags > Import addresses (Excel) > check the preview > Apply > Save tags.",
        "The FC / address / reference columns are for information only; they are recalculated on import.")]
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Tags" sheetId="1" r:id="rId1"/>'
        '<sheet name="How to use" sheetId="2" r:id="rId2"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
        "xl/styles.xml": reports.STYLES,
        "xl/worksheets/sheet1.xml": reports._sheet(rows, [16, 34, 40, 13, 14, 11, 8, 8, 8, 10, 14, 14], freeze_row=1),
        "xl/worksheets/sheet2.xml": reports._sheet(help_rows, [120]),
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, content in files.items():
            z.writestr(name, content)
    return buf.getvalue()
