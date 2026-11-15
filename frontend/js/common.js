/* Shared helpers (no external libraries - plant networks are often offline). */
const MD = (() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function api(path, opts = {}) {
    const init = { method: opts.method || "GET", headers: {}, credentials: "same-origin" };
    if (opts.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    const r = await fetch(path, init);
    if (r.status === 401 && path !== "/api/login") {   // session ended -> back to the login page
      location.replace("/login?expired=1");
      throw new Error("Session ended");
    }
    let data = {};
    try { data = await r.json(); } catch (_) { /* non-json */ }
    if (!r.ok || data.ok === false && opts.throwOnFalse !== false && r.status >= 400) {
      const e = new Error(data.error || `HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return data;
  }

  const pad = (n) => String(n).padStart(2, "0");
  // Plant time = Asia/Kolkata (UTC+05:30, no daylight saving). Every time on the dashboard is shown in IST,
  // whatever the viewer's own computer clock zone is. Timestamps are stored as epoch seconds (UTC).
  const IST_S = 19800;
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  function istParts(ts) {
    const d = new Date((ts + IST_S) * 1000);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(),
      s: d.getUTCSeconds(), wd: d.getUTCDay() };
  }
  function fmtTime(ts, withDate = false) {
    if (!ts) return "-";
    const p = istParts(ts);
    const t = `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
    return withDate ? `${pad(p.d)}-${pad(p.mo)}-${p.y} ${t}` : t;
  }
  const istDate = (ts) => { const p = istParts(ts); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; };            // YYYY-MM-DD
  const istLong = (ts) => { const p = istParts(ts); return `${WD[p.wd]}, ${pad(p.d)} ${MON[p.mo - 1]} ${p.y}`; };
  const istDayStart = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d) / 1000 - IST_S; };
  const istInput = (ts) => { const p = istParts(ts); return `${istDate(ts)}T${pad(p.h)}:${pad(p.mi)}`; };      // datetime-local value
  function parseIstInput(v) {                       // "YYYY-MM-DDTHH:MM" read as IST -> epoch seconds
    const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(v || "");
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000 - IST_S : null;
  }
  function ago(ts) {
    if (!ts) return "never";
    const s = Math.max(0, Date.now() / 1000 - ts);
    if (s < 2) return "just now";
    if (s < 60) return `${Math.round(s)} s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${(s / 3600).toFixed(1)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }
  function dur(s) {
    if (s == null) return "-";
    s = Math.max(0, s);
    if (s < 60) return `${Math.round(s)}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }
  function fmtValue(t) {
    const v = t.value;
    if (v === null || v === undefined) return "--";
    if (typeof v === "boolean") {
      const st = t.states || {};
      return st[String(v)] ?? (v ? "ON" : "OFF");
    }
    const d = t.decimals ?? 1;
    return Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function qualityLabel(t) {
    if (t.quality === "SIMULATED") return "SIMULATED";
    if (t.quality === "GOOD" && !t.verified) return "UNVERIFIED";
    return t.quality;
  }
  const ICON = {
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5M12 18h.01"/></svg>',
    crit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5h.01"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/></svg>',
    flask: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 3h6M10 3v6L4 20h16L14 9V3"/></svg>',
  };
  function prio(p) {
    return p === "red"
      ? `<span class="prio red">${ICON.crit}CRITICAL</span>`
      : `<span class="prio yellow">${ICON.warn}WARNING</span>`;
  }
  let toastTimer;
  function toast(msg, err = false) {
    let el = document.getElementById("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      document.body.appendChild(el);
    }
    el.className = "toast" + (err ? " err" : "");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), err ? 6000 : 3000);
  }
  function connPill(c) {
    if (!c) return '<span class="pill idle"><span class="dot"></span>...</span>';
    if (c.state === "SIMULATION") return `<span class="pill sim"><span class="dot"></span>SIMULATION</span>`;
    if (c.state === "CONNECTED") return c.comm_verified
      ? `<span class="pill good"><span class="dot"></span>ONLINE</span>`
      : `<span class="pill warn"><span class="dot"></span>ONLINE - UNVERIFIED</span>`;
    if (c.state === "DISCONNECTED") return `<span class="pill crit"><span class="dot"></span>OFFLINE</span>`;
    return `<span class="pill idle"><span class="dot"></span>${esc(c.state)}</span>`;
  }
  async function logout() {
    try { await fetch("/api/logout", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" }); } catch (_) {}
    location.replace("/login?bye=1");
  }
  return { esc, api, logout, fmtTime, ago, dur, fmtValue, qualityLabel, ICON, prio, toast, connPill,
    istParts, istDate, istLong, istDayStart, istInput, parseIstInput, MON };
})();
