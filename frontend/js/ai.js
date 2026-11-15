/* Plant AI assistant - chat panel. Asks /api/client/ai/ask, which answers from the same live data the dashboard shows
   (alarms + how to fix them, tank levels, pumps, set points). Read-only: it can never change anything in the plant. */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const KEY = "md-ai-chat";
  const SUGGEST = ["What alarms are active and how do I fix them?", "Which tanks are empty or low?", "Give me the full plant status",
    "Why is the sludge pump not running?", "Are pressures and temperatures within their set points?",
    "Show run hours of all machines", "Which machines are in Manual?", "What alarms came in the last 24 hours?"];
  let history = [];
  let busy = false;
  // speech-to-text (browser Web Speech API: Chrome / Edge; needs https or localhost). Words are written straight into the box.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const LANGS = [["en-IN", "EN"], ["hi-IN", "हि"]];
  let lang = "en-IN";
  try { lang = localStorage.getItem("md-ai-lang") || "en-IN"; } catch (_) {}
  let rec = null;
  try { history = JSON.parse(sessionStorage.getItem(KEY) || "[]"); } catch (_) { history = []; }
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(history.slice(-30))); } catch (_) {} };

  // small, safe markdown: escape first, then **bold**, _italic_, `code`, headings and bullet lists
  function md(text) {
    const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|\W)_(.+?)_(?=\W|$)/g, "$1<i>$2</i>").replace(/`([^`]+)`/g, "<code>$1</code>");
    let html = "", list = null;
    const close = () => { if (list) { html += list === "table" ? "</table></div>" : `</${list}>`; list = null; } };
    const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    for (const raw of String(text).split("\n")) {
      const line = raw.trimEnd();
      let m;
      if (/^\s*\|.*\|\s*$/.test(line)) {                         // markdown table row
        if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;           // |---|---| separator
        if (list !== "table") { close(); html += '<div class="ai-tbl"><table>'; list = "table"; html += `<tr>${cells(line).map((c) => `<th>${inline(c)}</th>`).join("")}</tr>`; }
        else html += `<tr>${cells(line).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`;
      }
      else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { if (list !== "ul") { close(); html += "<ul>"; list = "ul"; } html += `<li>${inline(m[1])}</li>`; }
      else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== "ol") { close(); html += "<ol>"; list = "ol"; } html += `<li>${inline(m[1])}</li>`; }
      else if ((m = line.match(/^#{1,4}\s+(.*)/))) { close(); html += `<h4>${inline(m[1])}</h4>`; }
      else if (!line.trim()) { close(); }
      else { close(); html += `<p>${inline(line)}</p>`; }
    }
    close();
    return html;
  }

  // the assistant's mascot: an owl in the plant's olive / lime colours (original drawing).
  // Pupils follow the cursor, eyelids blink (CSS). `cls` sizes it.
  function owl(cls) {
    return `<svg class="owl ${cls}" viewBox="0 0 64 64" aria-hidden="true">
      <path class="owl-tuft" d="M13 21 L15 6 L25 15 Z M51 21 L49 6 L39 15 Z"/>
      <ellipse class="owl-body" cx="32" cy="36" rx="22" ry="24"/>
      <path class="owl-wing" d="M10 36 q-2 14 8 20 q-4-10 -1-22 z M54 36 q2 14 -8 20 q4-10 1-22 z"/>
      <ellipse class="owl-belly" cx="32" cy="46" rx="12.5" ry="11.5"/>
      <path class="owl-feather" d="M26 43 q3 3 6 0 q3 3 6 0 M27.5 49 q2.2 2.4 4.5 0 q2.3 2.4 4.5 0"/>
      <circle class="owl-ring" cx="22" cy="28" r="10.5"/><circle class="owl-ring" cx="42" cy="28" r="10.5"/>
      <circle class="owl-eye" cx="22" cy="28" r="8"/><circle class="owl-eye" cx="42" cy="28" r="8"/>
      <g class="owl-pupils"><circle class="owl-pupil" cx="22" cy="28.5" r="4.4"/><circle class="owl-pupil" cx="42" cy="28.5" r="4.4"/>
        <circle class="owl-glint" cx="23.6" cy="26.8" r="1.4"/><circle class="owl-glint" cx="43.6" cy="26.8" r="1.4"/></g>
      <g class="owl-lids"><rect x="13" y="19" width="18" height="18" rx="9"/><rect x="33" y="19" width="18" height="18" rx="9"/></g>
      <path class="owl-beak" d="M28.6 34 L35.4 34 L32 40.5 Z"/>
      <path class="owl-feet" d="M24 59 v3 M27 59 v3 M37 59 v3 M40 59 v3"/>
    </svg>`;
  }
  // monochrome owl for the icon rail (same stroke style as the other icons)
  const OWL_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M5 8 4 3l4 2.5M19 8l1-5-4 2.5"/><path d="M4.5 9.5C4.5 5.5 8 4 12 4s7.5 1.5 7.5 5.5v5c0 4.2-3.3 7-7.5 7s-7.5-2.8-7.5-7z"/><circle cx="9" cy="10" r="2.2"/><circle cx="15" cy="10" r="2.2"/><path d="m11 13.5 1 1.6 1-1.6z"/></svg>`;

  function build() {
    const fab = document.createElement("button");
    fab.className = "ai-fab owl-fab"; fab.id = "aiFab"; fab.type = "button"; fab.title = "Plant Assistant - ask about the plant";
    fab.setAttribute("aria-label", "Plant Assistant - ask about the plant");
    fab.innerHTML = `${owl("owl-lg")}<span class="owl-bubble">Plant Assistant</span>`;
    const box = document.createElement("section");
    box.className = "ai-box hidden"; box.id = "aiBox"; box.setAttribute("aria-label", "Plant Assistant");
    box.innerHTML = `<header class="ai-h">${owl("owl-sm")}<div><b>Plant Assistant</b><span class="ai-st" id="aiSt">checking…</span></div>
        <button class="ai-x" id="aiNew" type="button" title="New conversation">New</button><button class="ai-x" id="aiClose" type="button" aria-label="Close">✕</button></header>
      <div class="ai-log" id="aiLog" aria-live="polite"></div>
      <div class="ai-sug" id="aiSug">${SUGGEST.map((s) => `<button type="button">${esc(s)}</button>`).join("")}</div>
      <form class="ai-in" id="aiForm"><textarea id="aiQ" rows="2" maxlength="1000" placeholder="Ask about alarms, tanks, pumps, set points… (English / Hindi)"></textarea>
        <div class="ai-mic-wrap${SR ? "" : " hidden"}"><button class="ai-lang" id="aiLang" type="button" title="Speech language"></button>
          <button class="ai-mic" id="aiMic" type="button" aria-label="Speak your question" title="Speak your question"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button></div>
        <button class="ai-send" id="aiSend" type="submit" aria-label="Send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 12l16-8-6 16-2.5-6.5z"/></svg></button></form>
      <div class="ai-foot">Answers come from the live dashboard data. The assistant can't control the plant - always check on site.</div>`;
    document.body.append(fab, box);
    // sidebar entry (labelled like the other pages)
    const foot = document.querySelector(".rail-foot");
    if (foot) {
      const b = document.createElement("button");
      b.className = "rail-btn ai-rail"; b.type = "button"; b.title = "Assistant";
      b.setAttribute("aria-label", "Plant Assistant");
      b.innerHTML = OWL_ICON;
      foot.prepend(b);
      b.onclick = toggle;
    }
    fab.onclick = toggle;
    // the owl watches the cursor: pupils move up to 2.4 units towards it (skipped for reduced motion)
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      let raf = 0;
      document.addEventListener("pointermove", (ev) => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          document.querySelectorAll(".owl .owl-pupils").forEach((g) => {
            const r = g.ownerSVGElement.getBoundingClientRect();
            const dx = ev.clientX - (r.left + r.width / 2), dy = ev.clientY - (r.top + r.height * 0.44);
            const d = Math.hypot(dx, dy) || 1, k = Math.min(2.4, d / 60);
            g.setAttribute("transform", `translate(${((dx / d) * k).toFixed(2)} ${((dy / d) * k).toFixed(2)})`);
          });
        });
      }, { passive: true });
    }
    $("aiClose").onclick = () => box.classList.add("hidden");
    $("aiNew").onclick = () => { history = []; save(); render(); };
    $("aiSug").querySelectorAll("button").forEach((b) => (b.onclick = () => send(b.textContent)));
    $("aiForm").onsubmit = (ev) => { ev.preventDefault(); send($("aiQ").value); };
    $("aiQ").onkeydown = (ev) => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); send($("aiQ").value); } };
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") box.classList.add("hidden"); });
    if (SR) {
      const setLang = () => { $("aiLang").textContent = (LANGS.find((l) => l[0] === lang) || LANGS[0])[1]; $("aiLang").title = `Speech language: ${lang === "hi-IN" ? "Hindi" : "English"} (tap to change)`; };
      setLang();
      $("aiLang").onclick = () => { lang = lang === "hi-IN" ? "en-IN" : "hi-IN"; try { localStorage.setItem("md-ai-lang", lang); } catch (_) {} setLang(); if (rec) rec.stop(); };
      $("aiMic").onclick = () => (rec ? rec.stop() : listen());
    }
    render();
  }

  function listen() {
    if (!SR || rec || busy) return;
    const q = $("aiQ"), base = q.value.trim() ? q.value.trim() + " " : "";
    rec = new SR();
    rec.lang = lang;
    rec.interimResults = true;      // words appear while speaking
    rec.continuous = false;         // stops by itself after a pause
    $("aiMic").classList.add("on");
    q.placeholder = lang === "hi-IN" ? "बोलिए… (सुन रहा हूँ)" : "Listening… speak now";
    rec.onresult = (ev) => {
      let text = "";
      for (let i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript;
      q.value = base + text;
    };
    rec.onerror = (ev) => {
      const msg = { "not-allowed": "Microphone blocked - allow the mic for this site in the browser (lock icon in the address bar).",
        "service-not-allowed": "Microphone blocked - allow the mic for this site in the browser.",
        "no-speech": "Didn't hear anything - tap the mic and speak again.",
        "audio-capture": "No microphone found on this computer.",
        "network": "Speech needs an internet connection." }[ev.error];
      if (msg) q.placeholder = msg;
    };
    rec.onend = () => {
      rec = null;
      $("aiMic").classList.remove("on");
      if (!q.placeholder.startsWith("Microphone") && !q.placeholder.startsWith("No ") && !q.placeholder.startsWith("Didn't") && !q.placeholder.startsWith("Speech"))
        q.placeholder = "Ask about alarms, tanks, pumps, set points… (English / Hindi)";
      q.focus();
    };
    try { rec.start(); } catch (_) { rec = null; $("aiMic").classList.remove("on"); }
  }

  function toggle() {
    const box = $("aiBox");
    box.classList.toggle("hidden");
    if (!box.classList.contains("hidden")) { status(); $("aiQ").focus(); scroll(); }
  }
  const scroll = () => { const l = $("aiLog"); l.scrollTop = l.scrollHeight; };

  function render(pending) {
    const log = $("aiLog");
    if (!history.length && !pending) {
      log.innerHTML = `<div class="ai-hello"><b>Namaste! I'm your Plant Assistant.</b><p>Ask me anything about the plant - what an alarm means and how to fix it, which tanks are empty, why a pump is stopped, or a full status summary.</p></div>`;
    } else {
      log.innerHTML = history.map((m) => m.role === "user"
        ? `<div class="ai-m u">${esc(m.content)}</div>`
        : `<div class="ai-m a${m.error ? " err" : ""}">${md(m.content)}${m.source === "offline" ? '<span class="ai-src">basic mode</span>' : ""}</div>`).join("")
        + (pending ? `<div class="ai-m a typing"><i></i><i></i><i></i></div>` : "");
    }
    $("aiSug").classList.toggle("hidden", history.length > 0 || !!pending);
    scroll();
  }

  async function status() {
    try {
      const r = await (await fetch("/api/client/ai/status", { cache: "no-store" })).json();
      $("aiSt").textContent = r.ai ? "AI connected" : "basic mode";
      $("aiSt").className = `ai-st ${r.ai ? "on" : "off"}`;
    } catch (_) { $("aiSt").textContent = "offline"; $("aiSt").className = "ai-st off"; }
  }

  async function send(text) {
    const q = String(text || "").trim();
    if (!q || busy) return;
    if (rec) rec.stop();
    busy = true;
    $("aiQ").value = "";
    $("aiSend").disabled = true;
    const prior = history.filter((m) => !m.error).map(({ role, content }) => ({ role, content }));
    history.push({ role: "user", content: q });
    render(true);
    try {
      const res = await fetch("/api/client/ai/ask", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, history: prior }) });
      const r = await res.json().catch(() => ({}));
      if (res.status === 401) history.push({ role: "assistant", content: "Your login has expired - please sign in again.", error: true });
      else if (r.ok) history.push({ role: "assistant", content: r.answer, source: r.source });
      else history.push({ role: "assistant", content: r.error || "Something went wrong - please try again.", error: true });
    } catch (_) {
      history.push({ role: "assistant", content: "Cannot reach the dashboard server.", error: true });
    }
    busy = false;
    $("aiSend").disabled = false;
    save();
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build); else build();
})();
