/* Admin configuration: communication settings, tag mapping, equipment. */
(() => {
  const { esc, api, fmtTime, ago, toast, connPill } = MD;
  const $ = (id) => document.getElementById(id);
  let rows = [];          // [{tag, mapping, warnings}]
  let dataTypes = [];
  let equipment = [];
  let dirty = false;
  let eqDirty = false;
  let settings = null;
  try { const t = localStorage.getItem("md-theme"); if (t) document.documentElement.dataset.theme = t; } catch (_) {}

  // ---------- auth ----------
  // signed in on the shared /login page; a 401 anywhere sends us back there (see MD.api)
  async function boot() {
    const s = await api("/api/admin/session");
    $("clientUser").value = s.client_username || "";
    $("clientWarn").innerHTML = s.client_must_change ? `<div class="banner warn">${MD.ICON.warn}<div><strong>Default client password in use</strong>
      Set a client password before sharing the dashboard with Ankur Scientific.</div></div>` : "";
    showAdmin(s.must_change);
  }
  $("logoutBtn").onclick = MD.logout;
  window.addEventListener("beforeunload", (e) => { if (dirty || eqDirty) { e.preventDefault(); e.returnValue = ""; } });

  function showAdmin(mustChange) {
    $("adminView").classList.remove("hidden");
    $("pwBanner").innerHTML = mustChange ? `<div class="banner warn">${MD.ICON.warn}<div><strong>Default admin password in use</strong>
      Change it under <a href="#account">Accounts</a> before the dashboard is exposed on the plant network.</div></div>` : "";
    route();
    loadSettings().then(loadTags).then(loadEquipment).catch((e) => toast(e.message, true));
    pollConn();
  }

  // ---------- routing ----------
  function route() {
    const v = (location.hash || "#comm").slice(1);
    document.querySelectorAll("[data-section]").forEach((s) => s.classList.toggle("hidden", s.dataset.section !== v));
    document.querySelectorAll("#nav a[data-view]").forEach((a) => a.classList.toggle("active", a.dataset.view === v));
    if (v === "log") loadLog();
  }
  window.addEventListener("hashchange", route);

  // ---------- connection status ----------
  async function pollConn() {
    try {
      const r = await api("/api/admin/status");
      const c = r.connection;
      $("connStrip").innerHTML = `${connPill(c)}<span>Quality <b>${c.quality_pct == null ? "-" : c.quality_pct + "%"}</b></span>
        <span>Last update <b>${fmtTime(c.last_update)}</b></span>`;
      $("connDetail").innerHTML = `<dt>Mode</dt><dd>${c.mode === "simulation" ? '<span class="q SIMULATED">SIMULATION</span>' : "Modbus TCP client"}</dd>
        <dt>Target</dt><dd class="code">${esc(c.plc)}</dd><dt>State</dt><dd>${connPill(c)}</dd>
        <dt>Last good read</dt><dd>${c.last_ok ? fmtTime(c.last_ok, true) + " (" + ago(c.last_ok) + ")" : "-"}</dd>
        <dt>Success rate</dt><dd>${c.quality_pct == null ? "-" : c.quality_pct + " %"}</dd>
        <dt>Avg latency</dt><dd>${c.avg_latency_ms == null ? "-" : c.avg_latency_ms + " ms"}</dd>
        <dt>Requests / errors</dt><dd>${c.requests} / ${c.errors}</dd>
        <dt>Consecutive failures</dt><dd>${c.consecutive_failures}</dd>
        ${c.last_error ? `<dt>Last error</dt><dd class="err-txt">${esc(c.last_error)} (${ago(c.last_error_ts)})</dd>` : ""}
        ${c.iot && c.iot.enabled ? `<dt>IoT link</dt><dd>${c.iot.running ? `<b class="ok">running</b> since ${fmtTime(c.iot.started_at, true)}` : '<b class="err-txt">not running</b>'}
          <div class="code" style="font-size:12px">${esc(c.iot.access_key)} → ${esc(c.iot.local)}</div></dd>
          ${c.iot.last_error ? `<dt>IoT error</dt><dd class="err-txt">${esc(c.iot.last_error)}</dd>` : ""}` : ""}`;
      const bad = r.tags.filter((t) => ["BAD", "CONFIG_ERROR"].includes(t.quality));
      if (bad.length) $("connDetail").innerHTML += `<dt>Tags with errors</dt><dd class="err-txt">${bad.length}: ${bad.slice(0, 5).map((t) => esc(t.id)).join(", ")}${bad.length > 5 ? "…" : ""}</dd>`;
      const now = Date.now();
      r.tags.forEach((t) => {
        const prev = liveById[t.id];
        if (prev && JSON.stringify(prev.value) !== JSON.stringify(t.value)) changedAt[t.id] = now;
      });
      liveById = Object.fromEntries(r.tags.map((t) => [t.id, t]));
      eqLive = Object.fromEntries((r.equipment || []).map((x) => [x.id, x]));
      lastConn = c;
      updateLiveCells();
      updateRhCells();
    } catch (e) {
      if (e.status === 401) location.reload();
    } finally {
      // fast while the Tags table is on screen and the monitor is running
      const hash = location.hash || "#comm";
      const fast = !document.hidden && ((lmOn && hash === "#tags") || hash === "#equipment");
      setTimeout(pollConn, fast ? 1000 : 3000);
    }
  }
  let liveById = {};
  const changedAt = {};        // tag id -> time the value last changed (ms)
  let lmOn = true, lastConn = null;

  // ---------- live monitor in the Tags table ----------
  const isOnVal = (v) => v === true || (typeof v === "number" && v !== 0);
  function liveCellHTML(t, lv) {
    if (!lv) return '<span class="muted">-</span>';
    const q = lv.quality === "GOOD" && !lv.verified ? "UNVERIFIED" : lv.quality;
    const bad = ["BAD", "CONFIG_ERROR", "NODATA", "STALE"].includes(lv.quality);
    const val = esc(MD.fmtValue(lv));
    const main = typeof lv.value === "boolean"
      ? `<span class="lv-bool ${lv.value ? "on" : "off"}">${val}</span>`
      : `<b class="lv-num num">${val}</b>${t.unit ? `<span class="lv-u">${esc(t.unit)}</span>` : ""}`;
    return `<div class="lv ${bad ? "bad" : ""}">${main}<span class="q ${q}" title="Data quality">${esc(lv.quality === "SIMULATED" ? "SIM" : lv.quality)}</span></div>
      <div class="lv-age">${lv.ts ? ago(lv.ts) : "never read"}</div>`;
  }
  function updateLiveCells() {
    const tbl = $("tagTable");
    if (!tbl) return;
    if (lmOn) {
      const now = Date.now();
      tbl.querySelectorAll("td.lv-cell").forEach((td) => {
        const id = td.dataset.lv, lv = liveById[id];
        const r = rows.find((x) => x.tag.id === id);
        if (!r) return;
        const sig = lv ? JSON.stringify([lv.value, lv.quality, Math.round((now / 1000 - (lv.ts || 0)))]) : "";
        if (td._sig === sig) return;
        td._sig = sig;
        td.innerHTML = liveCellHTML(r.tag, lv);
        if (changedAt[id] && now - changedAt[id] < 1500) { td.classList.remove("flash"); void td.offsetWidth; td.classList.add("flash"); }
      });
    }
    // monitor bar
    const all = Object.values(liveById);
    const good = all.filter((t) => ["GOOD", "SIMULATED"].includes(t.quality)).length;
    const bad = all.filter((t) => ["BAD", "CONFIG_ERROR", "NODATA", "STALE"].includes(t.quality)).length;
    const on = all.filter((t) => isOnVal(t.value)).length;
    const c = lastConn || {};
    $("lmConn").innerHTML = c.mode ? `${c.mode === "simulation" ? '<span class="q SIMULATED">DEMO DATA</span>' : `PLC <b class="code">${esc(c.plc || "")}</b>`} ${connPill(c)}` : "";
    $("lmLast").innerHTML = `Last read <b>${c.last_ok ? fmtTime(c.last_ok, true) : "-"}</b>`;
    $("lmCounts").innerHTML = `<b class="ok">${good}</b> good · <b class="${bad ? "bad" : ""}">${bad}</b> errors · <b>${on}</b> ON / non-zero`;
    // live filters: redraw only when the set of matching tags changes (keeps typing in the table undisturbed)
    if ($("tagLive").value && filteredRows().map((r) => r.tag.id).join(",") !== tbl._ids) renderTags();
  }
  $("lmToggle").onclick = () => {
    lmOn = !lmOn;
    $("lmToggle").classList.toggle("on", lmOn);
    $("lmState").textContent = lmOn ? "every 1 s" : "paused";
    if (lmOn) { $("tagTable").querySelectorAll("td.lv-cell").forEach((td) => (td._sig = "")); updateLiveCells(); }
  };
  $("tagLive").onchange = () => renderTags();

  // ---------- settings ----------
  const getPath = (o, p) => p.split(".").reduce((a, k) => (a == null ? a : a[k]), o);
  function setPath(o, p, v) { const ks = p.split("."); let c = o; ks.slice(0, -1).forEach((k) => (c = c[k] = c[k] || {})); c[ks.at(-1)] = v; }

  async function loadSettings() {
    settings = (await api("/api/admin/settings")).settings;
    const f = $("commForm");
    f.querySelectorAll("[name]").forEach((el) => {
      const v = getPath(settings, el.name);
      if (el.type === "checkbox") el.checked = !!v; else el.value = v ?? "";
    });
    $("iotSecret").value = "";
    $("iotSecret").placeholder = settings.iot && settings.iot.has_token_secret ? "•••••••• (stored)" : "";
    const s = settings.source;
    $("verifiedAt").textContent = s.comm_verified ? `Verified ${fmtTime(s.verified_at, true)} by ${s.verified_by}` : "Not verified yet.";
    syncSimple();
  }
  // simple view: the two toggles drive the hidden iot.enabled checkbox and source.mode select
  function syncSimple() {
    const iot = $("iotEnabled").checked;
    document.querySelectorAll("#viaSeg button").forEach((b) => b.classList.toggle("active", (b.dataset.via === "iot") === iot));
    $("viaIot").classList.toggle("hidden", !iot);
    $("viaIp").classList.toggle("hidden", iot);
    $("step2Label").textContent = iot ? "Access key" : "PLC address";
    document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("active", b.dataset.mode === $("modeSel").value));
  }
  $("viaSeg").onclick = (ev) => {
    const b = ev.target.closest("button[data-via]");
    if (!b) return;
    $("iotEnabled").checked = b.dataset.via === "iot";
    syncSimple();
  };
  $("modeSeg").onclick = (ev) => {
    const b = ev.target.closest("button[data-mode]");
    if (!b) return;
    $("modeSel").value = b.dataset.mode;
    syncSimple();
  };
  $("commForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const out = {};
    $("commForm").querySelectorAll("[name]").forEach((el) => {
      if (el.readOnly) return;
      let v = el.type === "checkbox" ? el.checked : el.value;
      if (el.type === "number") v = Number(v);
      setPath(out, el.name, v);
    });
    if (out.source.mode === "modbus" && settings.source.mode !== "modbus" &&
      !confirm("Switch to MODBUS mode?\n\nThe backend will start reading the PLC (read-only: FC01/02/03/04). Simulated values and alarms are cleared.")) return;
    if (out.source.mode === "simulation" && settings.source.mode === "modbus" &&
      !confirm("Switch to SIMULATION? The dashboard will show generated values (labelled SIMULATED).")) return;
    try {
      await api("/api/admin/settings", { method: "PUT", body: { settings: out } });
      $("commMsg").textContent = "Saved " + fmtTime(Date.now() / 1000);
      toast("Settings saved");
      loadSettings();
      loadTags();
    } catch (e) { toast(e.message, true); }
  };
  $("testConnBtn").onclick = async () => {
    const f = $("commForm");
    // the IoT link runs from saved settings, so a changed connection must be saved before it can be tested
    if (settings && (f["iot.enabled"].checked !== !!settings.iot.enabled ||
        (f["iot.enabled"].checked && f["iot.access_key"].value.trim() !== (settings.iot.access_key || ""))))
      return toast("Save first, then Test connection", true);
    const body = { host: f["plc.host"].value, port: +f["plc.port"].value, unit_id: +f["plc.unit_id"].value };
    $("testConnRes").classList.remove("hidden");
    $("testConnRes").textContent = `Connecting to ${body.host}:${body.port} (unit ${body.unit_id}) and reading D0 (FC03 @ 0)…`;
    if (settings && settings.iot && settings.iot.enabled)
      $("testConnRes").textContent = `Opening IoT access key ${settings.iot.access_key} on 127.0.0.1:${settings.iot.local_port} and reading D0 (FC03 @ 0)…`;
    const r = await api("/api/admin/test-connection", { method: "POST", body });
    const iotLog = r.iot && r.iot.log && r.iot.log.length ? "\n\ncomlink log:\n" + r.iot.log.join("\n") : "";
    $("testConnRes").textContent = r.ok
      ? `OK - ${r.target}: TCP connect ${r.tcp_ms} ms, total ${r.total_ms} ms. D0 = ${r.sample.D0}`
      : `FAILED - ${r.error}\n\nCheck: ${settings && settings.iot && settings.iot.enabled
        ? "Check access key (gateway online?), the gateway's PLC IP/port behind the key, unit ID."
        : "gateway/VPN route to the PLC, PLC IP, port 502 open, unit ID, PLC Ethernet Modbus TCP server enabled."}${iotLog}`;
  };
  $("iotCheckBtn").onclick = async () => {
    const key = $("iotKey").value.trim();
    $("iotCheckRes").classList.remove("hidden");
    $("iotCheckRes").textContent = `Checking ${key || "(saved key)"} through the cloud… (up to 20 s)`;
    try {
      const r = await api("/api/admin/iot/check", { method: "POST", body: { access_key: key } });
      $("iotCheckRes").textContent = `${r.ok ? "OK" : "PROBLEM"} - ${r.message}${r.code ? `  (HTTP ${r.code}, ${r.ms} ms)` : ""}`;
    } catch (e) { $("iotCheckRes").textContent = "FAILED - " + e.message; }
  };

  // ---------- tags ----------
  async function loadTags() {
    const r = await api("/api/admin/tags");
    rows = r.tags;
    dataTypes = r.data_types;
    dirty = false;
    const groups = [...new Set(rows.map((x) => x.tag.group || ""))].sort();
    $("tagGroup").innerHTML = `<option value="">All groups (${rows.length})</option>` + groups.map((g) => `<option>${esc(g)}</option>`).join("");
    renderTags();
  }
  function markDirty() { dirty = true; $("dirtyNote").classList.remove("hidden"); }
  ["tagSearch", "tagGroup", "tagVer"].forEach((id) => ($(id).oninput = renderTags));

  function scalingTxt(s) {
    if (!s || s.mode === "none") return "none";
    if (s.mode === "linear") return `${s.raw_min}…${s.raw_max} → ${s.eng_min}…${s.eng_max}`;
    return `×${s.gain} + ${s.offset}`;
  }
  function filteredRows() {
    const q = $("tagSearch").value.toLowerCase();
    const g = $("tagGroup").value;
    const ver = $("tagVer").value;
    const lf = $("tagLive").value;
    const now = Date.now();
    return rows.filter((r) => {
      const t = r.tag, lv = liveById[t.id];
      if (g && t.group !== g) return false;
      if (ver === "yes" && !t.mapping_verified) return false;
      if (ver === "no" && t.mapping_verified) return false;
      if (ver === "warn" && !r.warnings.some((w) => !w.includes("not yet verified"))) return false;
      if (lf === "on" && !(lv && isOnVal(lv.value))) return false;
      if (lf === "chg" && !(changedAt[t.id] && now - changedAt[t.id] < 30000)) return false;
      if (lf === "bad" && !(!lv || ["BAD", "CONFIG_ERROR", "NODATA", "STALE"].includes(lv.quality))) return false;
      return !q || [t.id, t.name, t.device, t.plc_tag].some((x) => String(x || "").toLowerCase().includes(q));
    });
  }
  function renderTags() {
    const wo = settings ? settings.plc.default_word_order : "low_first";
    const list = filteredRows();
    $("tagTable")._ids = list.map((r) => r.tag.id).join(",");
    $("dirtyNote").classList.toggle("hidden", !dirty);
    const fcOpts = (cur) => [1, 2, 3, 4].map((f) => `<option value="${f}" ${Number(cur) === f ? "selected" : ""}>${String(f).padStart(2, "0")}</option>`).join("");
    $("tagTable").innerHTML = `<tr><th title="Mapping verified on site">✓</th><th>Tag ID</th><th>Name</th>
      <th class="lv-h" title="Value read from the PLC right now (updates every second while the monitor is on)">Live value</th><th>Group</th><th>Type</th>
      <th title="Type a Delta device (D11008, X0.8, Y1.4 ...) - the Modbus address is calculated automatically">Delta device</th>
      <th title="AUTO = calculated from the Delta device, CUSTOM = your own Modbus address">Mode</th>
      <th title="Modbus read function code">FC</th><th title="Zero-based protocol address - type to set a custom address">Addr (0-based)</th>
      <th title="One-based reference">Ref (1-based)</th><th title="Bit inside a register (0-15)">Bit</th><th>Word order</th>
      <th>Scaling</th><th>Unit</th><th>Poll</th><th></th></tr>` +
      list.map((r) => {
        const t = r.tag, m = r.mapping || {};
        const lv = liveById[t.id];
        const custom = !!(t.address_override && t.address_override.enabled);
        const is32 = !(t.data_type === "BOOL" || t.data_type.endsWith("16"));
        const warns = r.warnings.filter((w) => !w.includes("not yet verified"));
        const id = esc(t.id);
        return `<tr data-row="${id}" class="${custom ? "is-custom" : ""}"><td>${t.mapping_verified ? '<span class="q GOOD">✓</span>' : '<span class="q UNVERIFIED">?</span>'}</td>
          <td class="code">${id}</td><td>${esc(t.name)}${warns.length ? `<div class="warn-txt">⚠ ${esc(warns.join(" · "))}</div>` : ""}${m.error ? `<div class="err-txt">${esc(m.error)}</div>` : ""}</td>
          <td class="lv-cell" data-lv="${id}">${liveCellHTML(t, lv)}</td>
          <td>${esc(t.group || "")}</td><td>${esc(t.data_type)}</td>
          <td><input class="ie code" data-id="${id}" data-k="device" value="${esc(t.device || "")}" size="9" ${custom ? 'title="Custom Modbus address in use - typing a device switches back to AUTO"' : ""}></td>
          <td>${custom ? `<span class="q UNVERIFIED">CUSTOM</span> <button class="btn sm" data-auto="${id}" title="Back to AUTO (calculated from the Delta device)">↺</button>` : '<span class="q GOOD">AUTO</span>'}</td>
          <td><select class="ie" data-id="${id}" data-k="fc">${fcOpts(m.function_code)}</select></td>
          <td><input class="ie code" type="number" min="0" max="65535" data-id="${id}" data-k="addr" value="${m.address ?? ""}" style="width:78px"> <span class="muted code">${m.hex || ""}</span></td>
          <td class="code">${m.reference || "-"}</td>
          <td><input class="ie code" type="number" min="0" max="15" data-id="${id}" data-k="bit" value="${m.bit ?? ""}" placeholder="-" style="width:46px" ${m.is_bit_table ? "disabled" : ""}></td>
          <td>${is32 ? `<select class="ie" data-id="${id}" data-k="wo">${[["default", `default (${wo})`], ["low_first", "low_first"], ["high_first", "high_first"]]
            .map(([v, l]) => `<option value="${v}" ${(t.word_order || "default") === v ? "selected" : ""}>${l}</option>`).join("")}</select>` : "-"}</td>
          <td>${esc(scalingTxt(t.scaling))}</td><td>${esc(t.unit || "")}</td><td>${t.poll_ms} ms</td>
          <td style="white-space:nowrap"><button class="btn sm" data-edit="${id}">Edit</button></td></tr>`;
      }).join("");
    $("tagTable").querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => editTag(b.dataset.edit)));
    $("tagTable").querySelectorAll(".ie").forEach((el) => (el.onchange = () => inlineEdit(el)));
    $("tagTable").querySelectorAll("[data-auto]").forEach((b) => (b.onclick = () => inlineAuto(b.dataset.auto)));
  }

  // ---------- inline address editing in the table ----------
  async function refreshRow(idx) {
    const r = await resolveRow(rows[idx].tag);
    rows[idx] = { tag: rows[idx].tag, ...r };
    markDirty();
    renderTags();
    if (r.mapping.error) toast(`${rows[idx].tag.id}: ${r.mapping.error}`, true);
  }
  async function inlineEdit(el) {
    const idx = rows.findIndex((r) => r.tag.id === el.dataset.id);
    if (idx < 0) return;
    const t = rows[idx].tag, m = rows[idx].mapping || {};
    const k = el.dataset.k, v = el.value.trim();
    if (k === "device") {
      t.device = v.toUpperCase();
      if (t.address_override) t.address_override.enabled = false;      // device typed -> AUTO address again
    } else if (k === "wo") {
      t.word_order = v;
    } else {
      // FC / address / bit typed -> custom Modbus address, starting from the current one
      const ov = { enabled: true, base: "zero",
        function_code: Number(m.function_code || (t.address_override || {}).function_code || 3),
        address: Number(m.address ?? (t.address_override || {}).address ?? 0),
        bit: m.bit ?? (t.address_override || {}).bit ?? null };
      if (k === "fc") ov.function_code = Number(v);
      if (k === "addr") { if (v === "" || isNaN(Number(v))) { toast("Enter a number 0 - 65535", true); renderTags(); return; } ov.address = Number(v); }
      if (k === "bit") ov.bit = v === "" ? null : Number(v);
      if (ov.function_code === 1 || ov.function_code === 2) ov.bit = null;
      t.address_override = ov;
    }
    await refreshRow(idx);
  }
  async function inlineAuto(id) {
    const idx = rows.findIndex((r) => r.tag.id === id);
    if (idx < 0) return;
    rows[idx].tag.address_override = { ...(rows[idx].tag.address_override || {}), enabled: false };
    await refreshRow(idx);
  }

  $("addTag").onclick = () => editTag(null);
  $("saveTags").onclick = async () => {
    try {
      await api("/api/admin/tags", { method: "PUT", body: { tags: rows.map((r) => r.tag) } });
      toast("Tags saved - poller reloaded");
      await loadTags();
    } catch (e) { toast(e.message, true); }
  };
  $("exportTags").onclick = () => {
    const blob = new Blob([JSON.stringify(rows.map((r) => r.tag), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tags_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
  $("importTags").onchange = async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    try {
      const list = JSON.parse(await f.text());
      if (!Array.isArray(list)) throw new Error("File must contain a JSON array of tags");
      if (!confirm(`Replace ${rows.length} tags with ${list.length} tags from ${f.name}? (not saved until you click Save tags)`)) return;
      rows = await Promise.all(list.map(async (t) => ({ tag: t, ...(await resolveRow(t)) })));
      markDirty();
      renderTags();
    } catch (e) { toast(e.message, true); }
    ev.target.value = "";
  };
  // ---------- import PLC addresses from Excel / CSV ----------
  const STATUS_TXT = { update: ["UPDATE", "UNVERIFIED"], same: ["NO CHANGE", "GOOD"], new: ["NEW TAG", "SIMULATED"], error: ["ERROR", "BAD"] };
  $("importXlsx").onchange = async (ev) => {
    const f = ev.target.files[0];
    ev.target.value = "";
    if (!f) return;
    if (dirty && !confirm("You have unsaved tag changes. Continue? (the import is applied on top of them)")) return;
    if (f.size > 1.4 * 1024 * 1024) { toast("File too large (max 1.4 MB) - export only the symbol table", true); return; }
    try {
      const b64 = await new Promise((ok, bad) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result).split(",")[1] || "");
        r.onerror = () => bad(new Error("Cannot read the file"));
        r.readAsDataURL(f);
      });
      toast("Reading " + f.name + "…");
      const res = await api("/api/admin/tags/import-preview", { method: "POST", body: { filename: f.name, data_b64: b64 } });
      showImport(f.name, res);
    } catch (e) { toast(e.message, true); }
  };

  function showImport(fname, res) {
    const items = res.items;
    const c = res.counts;
    const colTxt = Object.entries(res.columns).map(([k, v]) => `${k} = column ${v}`).join(" · ");
    let showSame = false;
    const draw = () => {
      const list = items.filter((it) => showSame || it.status !== "same");
      $("impBody").innerHTML = list.length ? list.map((it) => {
        const i = items.indexOf(it);
        const [txt, cls] = STATUS_TXT[it.status];
        const can = it.status === "update" || it.status === "new";
        const addr = it.override ? `ref ${it.reference}` : esc(it.device || it.address);
        return `<tr class="imp-${it.status}">
          <td><input type="checkbox" data-imp="${i}" ${can ? "" : "disabled"} ${it.pick ? "checked" : ""}></td>
          <td class="muted">${it.row}</td>
          <td><div class="code">${esc(it.symbol || it.id || "")}</div><div class="muted small">${esc(it.name || "")}</div></td>
          <td class="code">${addr}${it.fc ? `<div class="muted small">FC${String(it.fc).padStart(2, "0")} @ ${it.modbus}</div>` : ""}</td>
          <td>${it.match ? `<div class="code">${esc(it.match)}</div><div class="muted small">by ${esc(it.how)}</div>` : '<span class="muted">-</span>'}</td>
          <td class="code">${it.old_device ? `${esc(it.old_device)} → <b>${addr}</b>` : ""}${it.old_type && it.old_type !== it.data_type ? `<div class="warn-txt small">${esc(it.old_type)} → ${esc(it.data_type)}</div>` : ""}</td>
          <td><span class="q ${cls}">${txt}</span>${it.message ? `<div class="err-txt small">${esc(it.message)}</div>` : ""}${it.warning ? `<div class="warn-txt small">⚠ ${esc(it.warning)}</div>` : ""}</td></tr>`;
      }).join("") : `<tr><td colspan="7" class="muted" style="padding:14px">No rows to show.</td></tr>`;
      $("impBody").querySelectorAll("[data-imp]").forEach((cb) => (cb.onchange = () => { items[+cb.dataset.imp].pick = cb.checked; count(); }));
      count();
    };
    const count = () => {
      const n = items.filter((it) => it.pick).length;
      $("impApply").textContent = n ? `Apply ${n} change${n > 1 ? "s" : ""}` : "Nothing selected";
      $("impApply").disabled = !n;
    };
    items.forEach((it) => (it.pick = it.status === "update"));
    $("drawer").classList.add("wide");
    $("drawer").innerHTML = `
      <div class="row" style="justify-content:space-between"><h2>Import addresses - ${esc(fname)}</h2><button class="btn sm" id="dClose">Close</button></div>
      <p class="muted small" style="margin:0 0 10px">Sheet <b>${esc(res.sheet)}</b>${res.header_row ? `, header row ${res.header_row}` : " (no header row - columns guessed)"} · ${esc(colTxt)}</p>
      <div class="imp-sum">
        <span class="q UNVERIFIED">${c.update} to update</span><span class="q GOOD">${c.same} unchanged</span>
        <span class="q SIMULATED">${c.new} not matched</span><span class="q BAD">${c.error} errors</span>
        <span class="muted small">${res.not_in_file.length} tags not in the file (kept as they are)</span>
      </div>
      <div class="row" style="gap:16px;margin:10px 0">
        <label class="small"><input type="checkbox" id="impNew"> Create new tags for the ${c.new} unmatched rows</label>
        <label class="small"><input type="checkbox" id="impSame"> Show unchanged rows</label>
        <label class="small"><input type="checkbox" id="impAll" checked> Select all updates</label>
      </div>
      <div class="table-wrap" style="max-height:calc(100vh - 290px)"><table class="tag-table imp-table">
        <thead><tr><th></th><th>Row</th><th>Excel symbol / name</th><th>Address</th><th>Matched tag</th><th>Change</th><th>Status</th></tr></thead>
        <tbody id="impBody"></tbody></table></div>
      ${res.not_in_file.length ? `<details class="small" style="margin-top:8px"><summary>${res.not_in_file.length} configured tags were not found in the file</summary>
        <div class="code muted" style="margin-top:6px">${res.not_in_file.map((t) => `${esc(t.id)} (${esc(t.device || "-")})`).join(", ")}</div></details>` : ""}
      <div class="row" style="justify-content:flex-end;margin-top:12px;gap:8px">
        <span class="muted small" style="margin-right:auto">Changes go into the table below - review them, then click <b>Save tags</b>. Imported addresses are marked "not verified" until checked on site.</span>
        <button class="btn" id="impCancel">Cancel</button><button class="btn primary" id="impApply">Apply</button></div>`;
    $("impNew").onchange = (e) => { items.forEach((it) => { if (it.status === "new") it.pick = e.target.checked; }); draw(); };
    $("impSame").onchange = (e) => { showSame = e.target.checked; draw(); };
    $("impAll").onchange = (e) => { items.forEach((it) => { if (it.status === "update") it.pick = e.target.checked; }); draw(); };
    $("impCancel").onclick = closeImport;
    $("impApply").onclick = () => applyImport(fname, items.filter((it) => it.pick));
    draw();
    openDrawer();
    $("dClose").onclick = closeImport;
  }
  const closeImport = () => closeDrawer();

  const slugId = (s) => String(s || "").trim().replace(/[^A-Za-z0-9_\-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "TAG";
  function setAddress(t, it) {
    if (it.override) t.address_override = { ...it.override, enabled: true };
    else { t.device = it.device; t.address_override = { ...(t.address_override || {}), enabled: false }; }
    if (it.data_type) t.data_type = it.data_type;
    t.mapping_verified = false;
  }
  async function applyImport(fname, picks) {
    const changed = [];
    const ids = new Set(rows.map((r) => r.tag.id));
    for (const it of picks) {
      if (it.status === "update") {
        const idx = rows.findIndex((r) => r.tag.id === it.match);
        if (idx < 0) continue;
        const t = rows[idx].tag;
        setAddress(t, it);
        if (it.symbol && !t.plc_tag) t.plc_tag = it.symbol;
        t.source_ref = `Address imported from ${fname} row ${it.row}`;
        changed.push(idx);
      } else if (it.status === "new") {
        const t = blankTag();
        let id = slugId(it.id || it.symbol || it.name), n = 2;
        while (ids.has(id)) id = `${slugId(it.id || it.symbol || it.name).slice(0, 56)}_${n++}`;
        ids.add(id);
        Object.assign(t, { id, name: it.name || it.symbol || id, plc_tag: it.symbol || "", group: it.group || "Imported",
          unit: it.unit || "", show_on_dashboard: false, trend: false, kpi: false,
          source_ref: `Created from ${fname} row ${it.row}` });
        if (it.min !== "" && !isNaN(+it.min)) t.eng_min = +it.min;
        if (it.max !== "" && !isNaN(+it.max)) t.eng_max = +it.max;
        setAddress(t, it);
        if (t.data_type === "BOOL") t.decimals = 0;
        rows.push({ tag: t, mapping: {}, warnings: [] });
        changed.push(rows.length - 1);
      }
    }
    toast(`Applying ${changed.length} change(s)…`);
    for (let i = 0; i < changed.length; i += 12) {        // resolve in small batches
      await Promise.all(changed.slice(i, i + 12).map(async (idx) => {
        rows[idx] = { tag: rows[idx].tag, ...(await resolveRow(rows[idx].tag)) };
      }));
    }
    closeImport();
    markDirty();
    const groups = [...new Set(rows.map((x) => x.tag.group || ""))].sort();
    $("tagGroup").innerHTML = `<option value="">All groups (${rows.length})</option>` + groups.map((g) => `<option>${esc(g)}</option>`).join("");
    renderTags();
    const bad = changed.filter((idx) => rows[idx].mapping && rows[idx].mapping.error).length;
    toast(`${changed.length} tag(s) updated from ${fname}${bad ? ` - ${bad} with errors, check the table` : ""}. Click Save tags to apply.`, !!bad);
  }

  async function resolveRow(tag) {
    const r = await api("/api/admin/resolve", { method: "POST", body: { tag } });
    return r.ok ? { mapping: r.mapping, warnings: r.warnings } : { mapping: { error: r.error }, warnings: [r.error] };
  }

  // ---------- tag editor ----------
  const blankTag = () => ({
    id: "", name: "", group: "", area: "", description: "", plc_tag: "", device: "D0", data_type: "INT16",
    word_order: "default", invert: false, scaling: { mode: "none" }, unit: "", decimals: 1, eng_min: 0, eng_max: 100,
    poll_ms: 1000, show_on_dashboard: true, trend: true, log: true, kpi: false, setpoint_tag: null,
    states: { false: "OFF", true: "ON" }, alarm: { enabled: false, priority: "yellow" },
    address_override: { enabled: false, function_code: 3, address: 0, base: "zero", bit: null },
    mapping_verified: false, source_ref: "", notes: "",
  });

  function editTag(id) {
    const idx = id == null ? -1 : rows.findIndex((r) => r.tag.id === id);
    const t = JSON.parse(JSON.stringify(idx >= 0 ? rows[idx].tag : blankTag()));
    t.scaling = t.scaling || { mode: "none" };
    t.alarm = t.alarm || { enabled: false };
    t.address_override = t.address_override || { enabled: false, function_code: 3, address: 0, base: "zero", bit: null };
    t.states = t.states || { false: "OFF", true: "ON" };
    const opt = (vals, cur) => vals.map((v) => {
      const [val, lab] = Array.isArray(v) ? v : [v, v];
      return `<option value="${esc(val)}" ${String(cur) === String(val) ? "selected" : ""}>${esc(lab)}</option>`;
    }).join("");
    const ov = t.address_override;
    $("drawer").innerHTML = `
      <div class="row" style="justify-content:space-between"><h2>${idx >= 0 ? "Edit tag" : "New tag"}</h2><button class="btn sm" id="dClose">Close</button></div>
      <form id="tagForm">
        <div class="section-title">Identity</div>
        <div class="form-grid">
          <label class="field">Tag ID<input name="id" value="${esc(t.id)}" required pattern="[A-Za-z0-9_\\-]{1,64}"></label>
          <label class="field" style="grid-column:span 2">Display name<input name="name" value="${esc(t.name)}" required></label>
          <label class="field">Group<input name="group" value="${esc(t.group || "")}" list="groupList"><span class="hint">Temperature / Pressure / Level / Analysis show as process values</span></label>
          <label class="field">Area<input name="area" value="${esc(t.area || "")}"></label>
          <label class="field">PLC symbol (ISPSoft)<input name="plc_tag" value="${esc(t.plc_tag || "")}"></label>
        </div>
        <datalist id="groupList">${[...new Set(rows.map((r) => r.tag.group))].map((g) => `<option value="${esc(g)}">`).join("")}</datalist>

        <div class="section-title">Delta PLC address</div>
        <div class="form-grid">
          <label class="field">Delta device<input name="device" value="${esc(t.device || "")}" placeholder="D11008, X0.8, Y1.4, M100, D15000.3">
            <span class="hint">X/Y as word.bit (X0.8). Bit of a word: D15000.3</span></label>
          <label class="field">Data type<select name="data_type">${opt(dataTypes, t.data_type)}</select></label>
          <label class="field">32-bit word order<select name="word_order">${opt([["default", "Use default (" + (settings ? settings.plc.default_word_order : "") + ")"], ["low_first", "Low word first (Delta CDAB)"], ["high_first", "High word first (ABCD)"]], t.word_order || "default")}</select></label>
          <label class="check"><input type="checkbox" name="invert" ${t.invert ? "checked" : ""}> Invert BOOL (NC contact)</label>
        </div>
        <div class="section-title">Modbus address</div>
        <div class="mapbox">
          <div class="row" style="gap:18px">
            <label class="check"><input type="radio" name="ov.mode" value="auto" ${ov.enabled ? "" : "checked"}> <b>Auto</b>&nbsp;- calculated from the Delta device (AH500 manual App. B.1)</label>
            <label class="check"><input type="radio" name="ov.mode" value="custom" ${ov.enabled ? "checked" : ""}> <b>Custom</b>&nbsp;- my own Modbus address</label>
          </div>
          <div class="form-grid ov-fields" style="margin-top:10px">
            <label class="field">Function code<select name="ov.function_code">${opt([[1, "01 Read coils"], [2, "02 Read discrete inputs"], [3, "03 Read holding registers"], [4, "04 Read input registers"]], ov.function_code)}</select></label>
            <label class="field">Address<input name="ov.address" type="number" min="0" max="65536" value="${ov.address}"></label>
            <label class="field">Address is<select name="ov.base">${opt([["zero", "Zero-based (protocol, e.g. 11008)"], ["one", "One-based (reference, e.g. 411009)"]], ov.base)}</select>
              <span class="hint">One-based: type the 4xxxxx/3xxxxx/1xxxxx/0xxxxx reference or address + 1</span></label>
            <label class="field">Bit (FC03/FC04 only)<input name="ov.bit" type="number" min="0" max="15" value="${ov.bit ?? ""}" placeholder="-"></label>
          </div>
          <div id="mapPreview" style="margin-top:10px">…</div>
        </div>

        <div class="section-title">Scaling &amp; display</div>
        <div class="form-grid">
          <label class="field">Scaling<select name="sc.mode">${opt([["none", "None (PLC already scaled)"], ["linear", "Linear raw → engineering"], ["gain_offset", "Gain × raw + offset"]], t.scaling.mode)}</select></label>
          <label class="field sc-lin">Raw min<input name="sc.raw_min" type="number" step="any" value="${t.scaling.raw_min ?? 0}"></label>
          <label class="field sc-lin">Raw max<input name="sc.raw_max" type="number" step="any" value="${t.scaling.raw_max ?? 32000}"></label>
          <label class="field sc-lin">Eng min<input name="sc.eng_min" type="number" step="any" value="${t.scaling.eng_min ?? 0}"></label>
          <label class="field sc-lin">Eng max<input name="sc.eng_max" type="number" step="any" value="${t.scaling.eng_max ?? 100}"></label>
          <label class="field sc-go">Gain<input name="sc.gain" type="number" step="any" value="${t.scaling.gain ?? 1}"></label>
          <label class="field sc-go">Offset<input name="sc.offset" type="number" step="any" value="${t.scaling.offset ?? 0}"></label>
          <label class="field">Unit<input name="unit" value="${esc(t.unit || "")}"></label>
          <label class="field">Decimals<input name="decimals" type="number" min="0" max="6" value="${t.decimals ?? 1}"></label>
          <label class="field">Display range min<input name="eng_min" type="number" step="any" value="${t.eng_min ?? ""}"></label>
          <label class="field">Display range max<input name="eng_max" type="number" step="any" value="${t.eng_max ?? ""}"></label>
          <label class="field" title="Fixed bottom of the trend chart. Leave empty for automatic scaling.">Trend Y-axis min<input name="trend_min" type="number" step="any" placeholder="auto" value="${t.trend_min ?? ""}"></label>
          <label class="field" title="Fixed top of the trend chart. Leave empty for automatic scaling.">Trend Y-axis max<input name="trend_max" type="number" step="any" placeholder="auto" value="${t.trend_max ?? ""}"></label>
          <label class="field">Poll interval (ms)<input name="poll_ms" type="number" min="200" step="100" value="${t.poll_ms ?? 1000}"></label>
          <label class="field bool-only">Text when OFF<input name="st.false" value="${esc(t.states.false ?? "OFF")}"></label>
          <label class="field bool-only">Text when ON<input name="st.true" value="${esc(t.states.true ?? "ON")}"></label>
          <label class="field">Set-point tag (optional)<select name="setpoint_tag"><option value="">-</option>${opt(rows.filter((r) => r.tag.data_type !== "BOOL").map((r) => [r.tag.id, r.tag.id]), t.setpoint_tag || "")}</select></label>
        </div>
        <div class="row" style="margin-top:8px">
          <label class="check"><input type="checkbox" name="show_on_dashboard" ${t.show_on_dashboard !== false ? "checked" : ""}> Show on client dashboard</label>
          <label class="check"><input type="checkbox" name="trend" ${t.trend !== false ? "checked" : ""}> Trendable</label>
          <label class="check"><input type="checkbox" name="log" ${t.log !== false ? "checked" : ""}> Log to history</label>
          <label class="check"><input type="checkbox" name="kpi" ${t.kpi ? "checked" : ""}> KPI tile</label>
        </div>

        <div class="section-title">Alarm</div>
        <div class="form-grid">
          <label class="check"><input type="checkbox" name="al.enabled" ${t.alarm.enabled ? "checked" : ""}> Alarm enabled</label>
          <label class="field">Priority<select name="al.priority">${opt([["red", "Red - critical"], ["yellow", "Yellow - warning"]], t.alarm.priority || "yellow")}</select></label>
          <label class="field">On-delay (s)<input name="al.delay_s" type="number" min="0" step="any" value="${t.alarm.delay_s ?? 0}"></label>
          <label class="field bool-only">Alarm when value is<select name="al.on">${opt([["true", "ON (true)"], ["false", "OFF (false)"]], t.alarm.on === false ? "false" : "true")}</select></label>
          <label class="field bool-only" style="grid-column:span 2">Message<input name="al.message" value="${esc(t.alarm.message || "")}"></label>
          <label class="field num-only">High-High (red)<input name="al.hihi" type="number" step="any" value="${t.alarm.hihi ?? ""}"></label>
          <label class="field num-only">High<input name="al.hi" type="number" step="any" value="${t.alarm.hi ?? ""}"></label>
          <label class="field num-only">Low<input name="al.lo" type="number" step="any" value="${t.alarm.lo ?? ""}"></label>
          <label class="field num-only">Low-Low (red)<input name="al.lolo" type="number" step="any" value="${t.alarm.lolo ?? ""}"></label>
          <label class="field num-only">Deadband<input name="al.deadband" type="number" step="any" min="0" value="${t.alarm.deadband ?? 0}"></label>
        </div>

        <div class="section-title">Verification</div>
        <div class="mapbox">
          <div class="row"><button class="btn" type="button" id="testRead">Test read from PLC</button>
            <span class="muted" style="font-size:12px">Reads this tag once (read-only) with the current form values.</span></div>
          <pre class="res hidden" id="testRes"></pre>
          <label class="check" style="margin-top:10px"><input type="checkbox" name="mapping_verified" ${t.mapping_verified ? "checked" : ""}>
            Mapping verified on site (value matches HMI / ISPSoft monitor)</label>
          <div class="form-grid" style="margin-top:8px">
            <label class="field" style="grid-column:1/-1">Source reference<input name="source_ref" value="${esc(t.source_ref || "")}"></label>
            <label class="field" style="grid-column:1/-1">Notes<textarea name="notes" rows="3">${esc(t.notes || "")}</textarea></label>
          </div>
        </div>
        <div class="row" style="margin-top:16px;justify-content:space-between">
          <div class="row"><button class="btn primary" type="submit">Apply</button><button class="btn" type="button" id="dCancel">Cancel</button></div>
          ${idx >= 0 ? '<button class="btn danger" type="button" id="dDelete">Delete tag</button>' : ""}
        </div>
      </form>`;
    openDrawer();
    const f = $("tagForm");

    function collect() {
      const v = (n) => f.elements[n];
      const num = (n) => (v(n).value === "" ? null : Number(v(n).value));
      const out = JSON.parse(JSON.stringify(t));
      ["id", "name", "group", "area", "plc_tag", "device", "data_type", "word_order", "unit", "source_ref", "notes"].forEach((k) => (out[k] = v(k).value.trim()));
      out.invert = v("invert").checked;
      out.decimals = num("decimals") ?? 1;
      out.eng_min = num("eng_min");
      out.eng_max = num("eng_max");
      out.trend_min = num("trend_min");
      out.trend_max = num("trend_max");
      out.poll_ms = num("poll_ms") ?? 1000;
      out.setpoint_tag = v("setpoint_tag").value || null;
      ["show_on_dashboard", "trend", "log", "kpi", "mapping_verified"].forEach((k) => (out[k] = v(k).checked));
      const custom = f.querySelector('input[name="ov.mode"]:checked').value === "custom";
      out.address_override = { enabled: custom, function_code: Number(v("ov.function_code").value),
        address: num("ov.address") ?? 0, base: v("ov.base").value, bit: num("ov.bit") };
      if ([1, 2].includes(out.address_override.function_code)) out.address_override.bit = null;
      const mode = v("sc.mode").value;
      out.scaling = mode === "linear" ? { mode, raw_min: num("sc.raw_min"), raw_max: num("sc.raw_max"), eng_min: num("sc.eng_min"), eng_max: num("sc.eng_max") }
        : mode === "gain_offset" ? { mode, gain: num("sc.gain"), offset: num("sc.offset") } : { mode: "none" };
      out.states = { false: v("st.false").value, true: v("st.true").value };
      const isBool = out.data_type === "BOOL";
      out.alarm = { enabled: v("al.enabled").checked, priority: v("al.priority").value, delay_s: num("al.delay_s") ?? 0 };
      if (isBool) Object.assign(out.alarm, { on: v("al.on").value === "true", message: v("al.message").value });
      else Object.assign(out.alarm, { hihi: num("al.hihi"), hi: num("al.hi"), lo: num("al.lo"), lolo: num("al.lolo"), deadband: num("al.deadband") ?? 0 });
      return out;
    }
    let lastAuto = null;     // last calculated (auto) mapping - used to pre-fill Custom
    f.querySelectorAll('input[name="ov.mode"]').forEach((rb) => rb.addEventListener("change", () => {
      if (rb.value === "custom" && rb.checked && lastAuto && !lastAuto.error) {
        f.elements["ov.function_code"].value = String(lastAuto.function_code);
        f.elements["ov.address"].value = lastAuto.address;
        f.elements["ov.base"].value = "zero";
        f.elements["ov.bit"].value = lastAuto.bit ?? "";
      }
    }));
    function toggles() {
      const custom = f.querySelector('input[name="ov.mode"]:checked').value === "custom";
      f.querySelector(".ov-fields").classList.toggle("ov-off", !custom);
      f.querySelectorAll(".ov-fields input, .ov-fields select").forEach((e) => (e.disabled = !custom));
      f.elements.device.closest(".field").classList.toggle("ov-off", custom);
      const isBool = f.elements.data_type.value === "BOOL";
      const mode = f.elements["sc.mode"].value;
      f.querySelectorAll(".bool-only").forEach((e) => e.classList.toggle("hidden", !isBool));
      f.querySelectorAll(".num-only").forEach((e) => e.classList.toggle("hidden", isBool));
      f.querySelectorAll(".sc-lin").forEach((e) => e.classList.toggle("hidden", mode !== "linear" || isBool));
      f.querySelectorAll(".sc-go").forEach((e) => e.classList.toggle("hidden", mode !== "gain_offset" || isBool));
    }
    let pt;
    async function preview() {
      toggles();
      clearTimeout(pt);
      pt = setTimeout(async () => {
        const cur = collect();
        const r = await resolveRow(cur);
        const m = r.mapping;
        if (!cur.address_override.enabled) lastAuto = m;
        else if (!lastAuto) lastAuto = (await resolveRow({ ...cur, address_override: { enabled: false } })).mapping;
        $("mapPreview").innerHTML = m.error ? `<span class="err-txt">${esc(m.error)}</span>` : `
          <dl class="kv"><dt>Function code</dt><dd>FC${String(m.function_code).padStart(2, "0")} - ${esc(m.table.replace("_", " "))} (read)</dd>
          <dt>Zero-based address</dt><dd class="code">${m.address} (${m.hex})</dd>
          <dt>One-based reference</dt><dd class="code">${m.reference}</dd>
          <dt>Access</dt><dd>${esc(m.access)}${m.bit != null ? `, bit ${m.bit}` : ""} · ${m.is_bit_table ? "1 bit" : (f.elements.data_type.value.match(/32|REAL/) ? "2 registers" : "1 register")}</dd></dl>
          ${r.warnings.map((w) => `<div class="warn-txt">⚠ ${esc(w)}</div>`).join("")}`;
      }, 200);
    }
    f.addEventListener("input", preview);
    f.addEventListener("change", preview);
    preview();

    $("testRead").onclick = async () => {
      const box = $("testRes");
      box.classList.remove("hidden");
      box.textContent = "Reading…";
      const r = await api("/api/admin/test-read", { method: "POST", body: { tag: collect() } });
      if (!r.ok) { box.textContent = `FAILED: ${r.error}`; return; }
      const m = r.mapping;
      box.textContent = [
        `FC${String(m.function_code).padStart(2, "0")} @ ${m.address} (${m.hex}, ref ${m.reference}) - ${r.latency_ms} ms`,
        `Raw: ${r.raw_hex ? r.raw_hex.join(" ") + "  (" + r.raw.join(", ") + ")" : r.raw.join(", ")}`,
        r.decoded !== undefined ? `Decoded: ${r.decoded}` : "",
        r.decoded_other_word_order !== undefined ? `If word order were swapped: ${r.decoded_other_word_order}` : "",
        r.value !== undefined ? `Engineering value: ${r.value} ${f.elements.unit.value}` : "",
        r.decode_error ? `Decode error: ${r.decode_error}` : "",
        "", "Compare with the HMI / ISPSoft device monitor before ticking 'verified'.",
      ].filter((x) => x !== "").join("\n");
    };
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const nt = collect();
      if (nt.trend_min != null && nt.trend_max != null && nt.trend_min >= nt.trend_max) { toast("Trend Y-axis min must be lower than max", true); return; }
      if (rows.some((r, i) => r.tag.id === nt.id && i !== idx)) { toast(`Tag ID ${nt.id} already exists`, true); return; }
      const r = await resolveRow(nt);
      if (r.mapping.error && !confirm(`Address error: ${r.mapping.error}\nApply anyway? (Save will be rejected until fixed)`)) return;
      if (idx >= 0) rows[idx] = { tag: nt, ...r }; else rows.push({ tag: nt, ...r });
      markDirty();
      closeDrawer();
      renderTags();
    };
    $("dCancel").onclick = closeDrawer;
    if (idx >= 0) $("dDelete").onclick = () => {
      if (!confirm(`Delete tag ${t.id}?`)) return;
      rows.splice(idx, 1);
      markDirty();
      closeDrawer();
      renderTags();
    };
  }

  function openDrawer() {
    $("drawer").classList.remove("hidden"); $("drawerBg").classList.remove("hidden");
    $("drawer").scrollTop = 0;
    const c = $("dClose"); if (c) { c.onclick = closeDrawer; c.focus(); }
  }
  function closeDrawer() { $("drawer").classList.add("hidden"); $("drawer").classList.remove("wide"); $("drawerBg").classList.add("hidden"); }
  $("drawerBg").onclick = closeDrawer;
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeDrawer());

  // ---------- equipment ----------
  async function loadEquipment() {
    equipment = (await api("/api/admin/equipment")).equipment;
    eqDirty = false;
    renderEq();
  }
  function renderEq() {
    const ids = rows.map((r) => r.tag.id);
    const sel = (e, k) => `<select class="inline" data-i="${equipment.indexOf(e)}" data-k="${k}" style="max-width:210px"><option value="">-</option>${ids.filter((i) =>
      rows.find((r) => r.tag.id === i).tag.data_type === "BOOL").map((i) => `<option ${e[k] === i ? "selected" : ""}>${esc(i)}</option>`).join("")}</select>`;
    const inp = (e, k, w = 150) => `<input class="inline" data-i="${equipment.indexOf(e)}" data-k="${k}" value="${esc(e[k] || "")}" style="border:1px solid var(--line);border-radius:8px;padding:5px 7px;background:var(--surface-2);width:${w}px">`;
    $("eqTable").innerHTML = `<tr><th>ID</th><th>Name</th><th>Area</th><th>Type</th>
      <th title="Live status, run hours and number of starts" style="background:#f1fbe6">Status · Run hours · Starts</th>
      <th>Run fb / Open fb</th><th>Trip / Close fb</th><th>Command</th><th></th></tr>` +
      equipment.map((e) => `<tr><td>${inp(e, "id", 110)}</td><td>${inp(e, "name", 240)}</td><td>${inp(e, "area", 140)}</td>
        <td><select class="inline" data-i="${equipment.indexOf(e)}" data-k="type"><option ${e.type === "motor" ? "selected" : ""}>motor</option><option ${e.type === "valve" ? "selected" : ""}>valve</option></select></td>
        <td class="rh-cell" data-eq="${esc(e.id)}" style="white-space:nowrap;background:#fbfdf7">${rhCellHTML(e)}</td>
        <td>${sel(e, e.type === "valve" ? "open_tag" : "run_tag")}</td><td>${sel(e, e.type === "valve" ? "close_tag" : "trip_tag")}</td>
        <td>${sel(e, e.type === "valve" ? "open_cmd_tag" : "cmd_tag")}</td>
        <td><button class="btn sm danger" data-del="${equipment.indexOf(e)}">✕</button></td></tr>`).join("");
    $("eqTable").querySelectorAll("[data-rhreset]").forEach((b) => (b.onclick = () => resetRunHours([b.dataset.rhreset], b.dataset.name)));
    $("eqTable").querySelectorAll("[data-k]").forEach((el) => (el.onchange = () => {
      equipment[+el.dataset.i][el.dataset.k] = el.value || null;
      eqDirty = true;
      if (el.dataset.k === "type") renderEq();
    }));
    $("eqTable").querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => { equipment.splice(+b.dataset.del, 1); eqDirty = true; renderEq(); }));
  }
  // ---------- run hours: live display + reset ----------
  let eqLive = {};
  const fmtRh = (h) => {
    const s = Math.max(0, Math.floor((h || 0) * 3600)), hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return hh ? `${hh.toLocaleString()} h ${String(mm).padStart(2, "0")} m` : `${mm} m ${String(ss).padStart(2, "0")} s`;
  };
  function rhCellHTML(e) {
    const lv = eqLive[e.id];
    if (!lv) return '<span class="muted">-</span>';
    const st = `<span class="q ${lv.status === "RUNNING" || lv.status === "OPEN" ? "GOOD" : lv.status === "TRIP" ? "BAD" : "STALE"}">${esc(lv.status)}</span>`;
    if (e.type === "valve") return st;
    return `${st} <b class="num">${fmtRh(lv.run_hours)}</b> · <b class="num">${lv.starts}</b> starts
      <button class="btn sm" data-rhreset="${esc(e.id)}" data-name="${esc(e.name)}" title="Set run hours and starts back to 0">Reset</button>`;
  }
  function updateRhCells() {
    $("eqTable").querySelectorAll("td.rh-cell").forEach((td) => {
      const e = equipment.find((x) => x.id === td.dataset.eq);
      if (!e) return;
      const h = rhCellHTML(e);
      if (td._h === h) return;
      td._h = h; td.innerHTML = h;
      const b = td.querySelector("[data-rhreset]");
      if (b) b.onclick = () => resetRunHours([b.dataset.rhreset], b.dataset.name);
    });
  }
  async function resetRunHours(ids, name) {
    const all = ids === "all";
    if (!confirm(all ? "Reset run hours and starts of ALL motors to 0?\n\nThis cannot be undone." : `Reset run hours and starts of\n${name}\nto 0?\n\nThis cannot be undone.`)) return;
    try {
      const r = await api("/api/admin/equipment/reset-runtime", { method: "POST", body: { ids } });
      toast(all ? `Run hours reset for ${r.reset.length} motors` : `Run hours reset: ${name}`);
      pollConnNow();
    } catch (e) { toast(e.message, true); }
  }
  $("resetAllRh").onclick = () => resetRunHours("all");
  async function pollConnNow() {           // one extra refresh right after a reset (the regular poll keeps its own timer)
    try {
      const r = await api("/api/admin/status");
      eqLive = Object.fromEntries((r.equipment || []).map((x) => [x.id, x]));
      updateRhCells();
    } catch (_) { /* next regular poll will catch up */ }
  }

  $("addEq").onclick = () => { equipment.push({ id: "EQ_" + (equipment.length + 1), name: "New equipment", area: "", type: "motor", fb_timeout_s: 5 }); eqDirty = true; renderEq(); };
  $("saveEq").onclick = async () => {
    if (dirty) { toast("Save tags first - equipment links are checked against saved tags", true); return; }
    try { await api("/api/admin/equipment", { method: "PUT", body: { equipment } }); eqDirty = false; toast("Equipment saved"); }
    catch (e) { toast(e.message, true); }
  };

  // ---------- log & account ----------
  async function loadLog() {
    const r = await api("/api/admin/events?limit=300");
    $("logTable").innerHTML = "<tr><th>Time</th><th>Type</th><th>Detail</th></tr>" +
      r.events.map((e) => `<tr><td class="num">${fmtTime(e.ts, true)}</td><td>${esc(e.kind)}</td><td>${esc(e.detail)}</td></tr>`).join("");
  }
  $("pwForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    try {
      await api("/api/admin/password", { method: "POST", body: { old: f.old.value, new: f.new.value } });
      alert("Admin password changed. Please sign in again.");
      location.replace("/login");
    } catch (e) { toast(e.message, true); }
  };
  $("clientForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    try {
      const r = await api("/api/admin/client-login", { method: "POST", body: { username: f.username.value, password: f.password.value } });
      f.password.value = "";
      $("clientUser").value = r.client_username;
      $("clientWarn").innerHTML = "";
      toast("Client login saved - the client must sign in again");
    } catch (e) { toast(e.message, true); }
  };

  boot();
})();
