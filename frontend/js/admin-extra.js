/* Settings additions for the rebuild: user accounts & roles, RTD group (20 slots), shifts.
   Accounts go through /api/admin/users (passwords hashed on the server); the rest through PUT /api/admin/settings. */
(() => {
  const { esc, api, toast } = MD;
  const $ = (id) => document.getElementById(id);
  let loaded = false, tags = [], shifts = [];

  // ---------- accounts ----------
  async function loadUsers() {
    const r = await api("/api/admin/users");
    renderUsers(r.users);
  }
  function renderUsers(users) {
    const ROLE = { admin: "Admin", operator: "Operator", viewer: "Viewer" };
    $("userTable").innerHTML = `<tr><th>Username</th><th>Role</th><th>Type</th><th></th></tr>` + users.map((u) => `<tr>
      <td class="code">${esc(u.username)}</td><td>${ROLE[u.role] || esc(u.role)}</td>
      <td class="muted">${u.builtin ? "built-in" : "added"}${u.must_change ? ' · <b class="err-txt">default password</b>' : ""}</td>
      <td>${u.builtin ? "" : `<button class="btn sm" data-edit="${esc(u.username)}" data-role="${esc(u.role)}">Edit</button>
        <button class="btn sm danger" data-del="${esc(u.username)}">Delete</button>`}</td></tr>`).join("");
    $("userTable").querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => {
      const f = $("userForm");
      f.username.value = b.dataset.edit; f.role.value = b.dataset.role; f.password.value = "";
      f.password.focus();
    }));
    $("userTable").querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
      if (!confirm(`Delete account "${b.dataset.del}"? It is signed out at once.`)) return;
      try { renderUsers((await api("/api/admin/users", { method: "POST", body: { username: b.dataset.del, delete: true } })).users); toast("Account deleted"); }
      catch (e) { toast(e.message, true); }
    }));
  }
  $("userForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    try {
      const r = await api("/api/admin/users", { method: "POST", body: { username: f.username.value.trim(), role: f.role.value, password: f.password.value } });
      renderUsers(r.users);
      f.reset();
      toast("Account saved");
    } catch (e) { toast(e.message, true); }
  };

  // ---------- RTD group + shifts ----------
  async function loadDisplay() {
    const s = await api("/api/admin/settings");
    shifts = (s.settings.shifts || []).map((x) => ({ ...x }));
    $("warnBand").value = ((s.settings.display || {}).warn_band_pct ?? 90);
    renderShifts();
  }

  function renderShifts() {
    $("shiftRows").innerHTML = shifts.map((x, i) => `<div class="row shift-row">
      <label class="field">Name<input data-i="${i}" data-k="name" value="${esc(x.name)}" maxlength="20"></label>
      <label class="field">Start (IST)<input data-i="${i}" data-k="start" type="time" value="${esc(x.start)}"></label>
      <button class="btn sm danger" type="button" data-rm="${i}" ${shifts.length <= 1 ? "disabled" : ""}>Remove</button></div>`).join("");
    $("shiftRows").querySelectorAll("input").forEach((el) => (el.oninput = () => (shifts[+el.dataset.i][el.dataset.k] = el.value)));
    $("shiftRows").querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { shifts.splice(+b.dataset.rm, 1); renderShifts(); }));
  }
  $("addShift").onclick = () => { if (shifts.length >= 6) return toast("At most 6 shifts", true); shifts.push({ name: String.fromCharCode(65 + shifts.length), start: "00:00" }); renderShifts(); };
  $("saveDisplay").onclick = async () => {
    const names = shifts.map((x) => x.name.trim());
    if (names.some((n) => !n) || new Set(names).size !== names.length) return toast("Each shift needs a unique name", true);
    if (new Set(shifts.map((x) => x.start)).size !== shifts.length) return toast("Two shifts start at the same time", true);
    try {
      await api("/api/admin/settings", { method: "PUT", body: { settings: {
        shifts: shifts.map((x) => ({ name: x.name.trim(), start: x.start })).sort((a, b) => a.start.localeCompare(b.start)),
        display: { warn_band_pct: Number($("warnBand").value || 90) } } } });
      $("displayMsg").textContent = "Saved " + MD.fmtTime(Date.now() / 1000) + " IST";
      toast("Display & reports saved");
      loadDisplay();
    } catch (e) { toast(e.message, true); }
  };

  // ---------- Plant Assistant (AI key is write-only: the server only says whether one is saved) ----------
  const MODEL_NAME = { "claude-opus-5-5": "Claude Opus 5.5 (best)", "claude-sonnet-5-5": "Claude Sonnet 5.5 (balanced)", "claude-haiku-5-5": "Claude Haiku 5.5 (cheapest)" };
  function renderAi(s) {
    const f = $("aiForm");
    f.enabled.checked = s.enabled;
    f.model.innerHTML = s.models.map((m) => `<option value="${esc(m)}">${esc(MODEL_NAME[m] || m)}</option>`).join("");
    f.model.value = s.model; f.effort.value = s.effort; f.api_key.value = "";
    const key = s.key_set ? "key saved" : s.env_key ? "key from environment variable" : "<b class=\"err-txt\">no key saved</b>";
    $("aiState").innerHTML = (s.active ? '<b style="color:var(--ok,#16a34a)">● AI active</b>' : "<b>● Basic mode</b>")
      + ` · ${key}` + (s.sdk ? "" : ' · <b class="err-txt">Anthropic Python package not installed</b>');
    $("aiClear").disabled = !s.key_set;
  }
  async function loadAi() { renderAi(await api("/api/admin/ai")); }
  $("aiForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target, body = { enabled: f.enabled.checked, model: f.model.value, effort: f.effort.value };
    if (f.api_key.value.trim()) body.api_key = f.api_key.value.trim();
    try { renderAi(await api("/api/admin/ai", { method: "PUT", body })); toast("Plant Assistant saved"); $("aiMsg").textContent = ""; }
    catch (e) { toast(e.message, true); }
  };
  $("aiClear").onclick = async () => {
    if (!confirm("Remove the saved API key? The assistant goes back to basic mode.")) return;
    try { renderAi(await api("/api/admin/ai", { method: "PUT", body: { clear_key: true } })); toast("Key removed"); }
    catch (e) { toast(e.message, true); }
  };
  $("aiTest").onclick = async () => {
    $("aiMsg").textContent = "Testing…";
    try {
      const r = await api("/api/admin/ai/test", { method: "POST", body: {} });
      $("aiMsg").innerHTML = r.ok ? `<b style="color:var(--ok,#16a34a)">Connected</b> - ${esc(r.name || r.model)} is available for this key.` : `<b class="err-txt">${esc(r.error)}</b>`;
    } catch (e) { $("aiMsg").innerHTML = `<b class="err-txt">${esc(e.message)}</b>`; }
  };

  // ---------- WhatsApp alarm alerts (token is write-only) ----------
  function renderWa(s) {
    const f = $("waForm");
    ["enabled", "send_clear", "send_demo", "only_red"].forEach((k) => (f[k].checked = !!s[k]));
    ["phone_number_id", "api_version", "template", "language", "repeat_min"].forEach((k) => (f[k].value = s[k] ?? ""));
    f.mode.value = s.mode; f.access_token.value = "";
    f.recipients.value = (s.recipients || []).map((n) => "+" + n).join("\n");
    const last = s.last && s.last.time ? ` · last: ${s.last.ok ? "sent" : '<b class="err-txt">failed</b>'} ${MD.fmtTime(s.last.time, true)} IST - ${esc(s.last.detail)}` : "";
    $("waState").innerHTML = (s.enabled ? '<b style="color:var(--ok,#16a34a)">● Alerts ON</b>' : "<b>● Alerts off</b>")
      + ` · ${s.token_set ? "token saved" : '<b class="err-txt">no token</b>'} · ${(s.recipients || []).length} recipient(s) · ${s.sent_count || 0} sent since start${last}`;
    $("waClear").disabled = !s.token_set;
  }
  async function loadWa() { renderWa(await api("/api/admin/whatsapp")); }
  $("waForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target, body = { recipients: f.recipients.value, mode: f.mode.value };
    ["enabled", "send_clear", "send_demo", "only_red"].forEach((k) => (body[k] = f[k].checked));
    ["phone_number_id", "api_version", "template", "language"].forEach((k) => (body[k] = f[k].value.trim()));
    body.repeat_min = Number(f.repeat_min.value || 15);
    if (f.access_token.value.trim()) body.access_token = f.access_token.value.trim();
    try { renderWa(await api("/api/admin/whatsapp", { method: "PUT", body })); toast("WhatsApp alerts saved"); $("waMsg").textContent = ""; }
    catch (e) { toast(e.message, true); }
  };
  $("waClear").onclick = async () => {
    if (!confirm("Remove the saved access token? WhatsApp alerts stop until a new token is saved.")) return;
    try { renderWa(await api("/api/admin/whatsapp", { method: "PUT", body: { clear_token: true, enabled: false } })); toast("Token removed"); }
    catch (e) { toast(e.message, true); }
  };
  $("waTest").onclick = async () => {
    $("waMsg").textContent = "Sending…";
    try {
      const r = await api("/api/admin/whatsapp/test", { method: "POST", body: { number: $("waTestNo").value.trim() } });
      $("waMsg").innerHTML = r.results.map((x) => `${x.ok ? '<b style="color:var(--ok,#16a34a)">✔</b>' : '<b class="err-txt">✖</b>'} ${esc(x.to)} - ${esc(x.detail)}`).join("<br>");
      loadWa().catch(() => {});
    } catch (e) { $("waMsg").innerHTML = `<b class="err-txt">${esc(e.message)}</b>`; }
  };

  window.AdminExtra = {
    show(v) {
      if (v === "wa") loadWa().catch((e) => toast(e.message, true));
      if (v === "ai") loadAi().catch((e) => toast(e.message, true));
      if (v === "account") loadUsers().catch((e) => toast(e.message, true));
      if (v === "display" && !loaded) { loaded = true; loadDisplay().catch((e) => { loaded = false; toast(e.message, true); }); }
    },
  };
  AdminExtra.show((location.hash || "#comm").slice(1));
})();
