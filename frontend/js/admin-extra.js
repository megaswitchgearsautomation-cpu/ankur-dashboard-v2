/* Settings additions for the rebuild: user accounts & roles.
   Accounts go through /api/admin/users (passwords hashed on the server). */
(() => {
  const { esc, api, toast } = MD;
  const $ = (id) => document.getElementById(id);
  // (Display & reports, Plant Assistant and WhatsApp alerts removed from Admin on request 17-11-2026)

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

  window.AdminExtra = {
    show(v) {
      if (v === "account") loadUsers().catch((e) => toast(e.message, true));
    },
  };
  AdminExtra.show((location.hash || "#comm").slice(1));
})();
