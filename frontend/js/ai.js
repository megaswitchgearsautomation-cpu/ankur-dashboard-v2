/* Plant AI assistant - chat panel. Asks /api/client/ai/ask, which answers from the same live data the dashboard shows
   (alarms + how to fix them, tank levels, pumps, set points). Read-only: it can never change anything in the plant. */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const KEY = "md-ai-chat";
  const SUGGEST = ["What alarms are active and how do I fix them?", "Which tanks are empty or low?", "Give me a full plant status summary",
    "Why is the sludge pump not running?", "Are pressures and temperatures within their set points?"];
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
    const close = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const raw of String(text).split("\n")) {
      const line = raw.trimEnd();
      let m;
      if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { if (list !== "ul") { close(); html += "<ul>"; list = "ul"; } html += `<li>${inline(m[1])}</li>`; }
      else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== "ol") { close(); html += "<ol>"; list = "ol"; } html += `<li>${inline(m[1])}</li>`; }
      else if ((m = line.match(/^#{1,4}\s+(.*)/))) { close(); html += `<h4>${inline(m[1])}</h4>`; }
      else if (!line.trim()) { close(); }
      else { close(); html += `<p>${inline(line)}</p>`; }
    }
    close();
    return html;
  }

  function build() {
    const fab = document.createElement("button");
    fab.className = "ai-fab"; fab.id = "aiFab"; fab.type = "button"; fab.title = "Ask the plant AI assistant";
    fab.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg><span>Ask AI</span>`;
    const box = document.createElement("section");
    box.className = "ai-box hidden"; box.id = "aiBox"; box.setAttribute("aria-label", "Plant AI assistant");
    box.innerHTML = `<header class="ai-h"><div><b>Plant AI assistant</b><span class="ai-st" id="aiSt">checking…</span></div>
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
      b.className = "rail-btn ai-rail"; b.type = "button"; b.title = "Ask AI";
      b.innerHTML = fab.querySelector("svg").outerHTML;
      foot.prepend(b);
      b.onclick = toggle;
    }
    fab.onclick = toggle;
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
      log.innerHTML = `<div class="ai-hello"><b>Namaste! 👋</b><p>Ask me anything about the plant - what an alarm means and how to fix it, which tanks are empty, why a pump is stopped, or a full status summary.</p></div>`;
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
      $("aiSt").textContent = r.ai ? "AI connected" : "basic mode - no AI key";
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
