/* Local AI Chat — front-end logic (vanilla JS, no build step). */
(() => {
  "use strict";

  // ───────────────────────── DOM ─────────────────────────
  const $ = (id) => document.getElementById(id);
  const appEl = document.querySelector(".app");
  const messagesEl = $("messages");
  const welcomeEl = $("welcome");
  const chatListEl = $("chat-list");
  const chatListEmptyEl = $("chat-list-empty");
  const chatTitleEl = $("chat-title");
  const inputEl = $("input");
  const sendBtn = $("send");
  const stopBtn = $("stop");
  const composerEl = $("composer");
  const modelSelect = $("model-select");
  const statusEl = $("status");
  const statusText = $("status-text");
  const pullBtn = $("pull-model");
  const template = $("message-template");

  // ───────────────────────── State ─────────────────────────
  const state = {
    chats: [],            // sidebar summaries
    currentId: null,      // active chat id (null = fresh, unsaved chat)
    streaming: false,
    pulling: false,
    abort: null,          // AbortController for the in-flight request
    health: null,
  };

  // ───────────────────────── Markdown ─────────────────────────
  const hasMarked = typeof window.marked !== "undefined";
  const hasPurify = typeof window.DOMPurify !== "undefined";
  const hasHljs = typeof window.hljs !== "undefined";

  if (hasMarked) {
    marked.setOptions({ gfm: true, breaks: true });
  }

  const escapeHtml = (s) =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function renderMarkdown(text) {
    if (!hasMarked) return `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
    let html = marked.parse(text);
    if (hasPurify) {
      html = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    }
    return html;
  }

  function decorateCode(container) {
    container.querySelectorAll("pre").forEach((pre) => {
      const code = pre.querySelector("code");
      if (!code || pre.dataset.decorated) return;
      pre.dataset.decorated = "1";
      const langMatch = /language-([\w+-]+)/.exec(code.className);
      const lang = langMatch ? langMatch[1] : "";
      if (hasHljs) {
        try {
          if (lang && hljs.getLanguage(lang)) {
            code.innerHTML = hljs.highlight(code.textContent, { language: lang }).value;
          } else {
            code.innerHTML = hljs.highlightAuto(code.textContent).value;
          }
          code.classList.add("hljs");
        } catch (_) { /* leave plain */ }
      }
      const header = document.createElement("div");
      header.className = "code-header";
      const label = document.createElement("span");
      label.textContent = lang || "code";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "copy-btn";
      copy.textContent = "Copy";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(code.textContent);
          copy.textContent = "Copied!";
        } catch (_) {
          copy.textContent = "Press Ctrl+C";
        }
        setTimeout(() => (copy.textContent = "Copy"), 1500);
      });
      header.append(label, copy);
      pre.prepend(header);
    });
  }

  // ───────────────────────── Rendering helpers ─────────────────────────
  function isNearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  }
  function scrollToBottom(force = false) {
    if (force || isNearBottom()) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function formatTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function addMessage(role, content, { meta = "", streaming = false, error = false } = {}) {
    welcomeEl.hidden = true;
    const node = template.content.firstElementChild.cloneNode(true);
    node.classList.add(role === "user" ? "user" : "assistant");
    if (error) node.classList.add("error");
    node.querySelector(".avatar").textContent = role === "user" ? "You" : "AI";
    const bubble = node.querySelector(".bubble");
    const contentEl = node.querySelector(".content");
    if (role === "user") {
      contentEl.textContent = content;
    } else {
      contentEl.innerHTML = renderMarkdown(content);
      decorateCode(contentEl);
    }
    if (streaming) bubble.classList.add("streaming");
    node.querySelector(".meta").textContent = meta;
    messagesEl.appendChild(node);
    scrollToBottom(true);
    return { node, bubble, contentEl, metaEl: node.querySelector(".meta") };
  }

  function clearMessages() {
    messagesEl.querySelectorAll(".message").forEach((m) => m.remove());
    welcomeEl.hidden = false;
  }

  // ───────────────────────── API ─────────────────────────
  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail || detail; } catch (_) { /* ignore */ }
      throw new Error(detail);
    }
    return res.status === 204 ? null : res.json();
  }

  async function refreshHealth() {
    try {
      state.health = await api("/api/health");
    } catch (err) {
      state.health = { ok: false, error: `Backend unreachable: ${err.message}`, models: [], model: null };
    }
    const h = state.health;
    statusEl.classList.remove("ok", "warn", "err");
    if (!h.ok) {
      statusEl.classList.add("err");
      statusText.textContent = "Ollama offline";
      statusEl.title = h.error || "Ollama is not reachable";
    } else if (!h.models.length) {
      statusEl.classList.add("warn");
      statusText.textContent = "No models installed";
      statusEl.title = "Run: ollama pull llama3";
    } else {
      statusEl.classList.add("ok");
      statusText.textContent = `Ollama · ${h.model}`;
      statusEl.title = `${h.models.length} model(s) at ${h.host}`;
    }
    // Offer a one-click download when Ollama is up but the preferred model is missing.
    if (!state.pulling) {
      pullBtn.hidden = !(h.ok && !h.preferred_installed);
      pullBtn.textContent = `Download ${h.preferred_model || "llama3"}`;
    }
    // Populate the model picker.
    const previous = modelSelect.value;
    modelSelect.innerHTML = "";
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = h.model ? `Auto (${h.model})` : "Auto";
    modelSelect.appendChild(auto);
    (h.models || []).forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      modelSelect.appendChild(opt);
    });
    if ([...modelSelect.options].some((o) => o.value === previous)) modelSelect.value = previous;
  }

  async function refreshChats() {
    try {
      state.chats = await api("/api/chats");
    } catch (err) {
      console.error("Failed to load chats", err);
      state.chats = [];
    }
    renderChatList();
  }

  function renderChatList() {
    chatListEl.querySelectorAll(".chat-item").forEach((n) => n.remove());
    chatListEmptyEl.hidden = state.chats.length > 0;
    for (const chat of state.chats) {
      const item = document.createElement("div");
      item.className = "chat-item" + (chat.id === state.currentId ? " active" : "");
      item.dataset.id = chat.id;

      const title = document.createElement("button");
      title.type = "button";
      title.className = "chat-item-title";
      title.textContent = chat.title;
      title.title = chat.title;
      title.addEventListener("click", () => openChat(chat.id));

      const actions = document.createElement("div");
      actions.className = "chat-item-actions";

      const rename = document.createElement("button");
      rename.type = "button";
      rename.className = "icon-btn";
      rename.title = "Rename";
      rename.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
      rename.addEventListener("click", (e) => { e.stopPropagation(); renameChat(chat); });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "icon-btn danger";
      del.title = "Delete";
      del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
      del.addEventListener("click", (e) => { e.stopPropagation(); deleteChat(chat); });

      actions.append(rename, del);
      item.append(title, actions);
      chatListEl.appendChild(item);
    }
  }

  // ───────────────────────── Model download ─────────────────────────
  const fmtGB = (b) => (b / 1e9).toFixed(2) + " GB";

  async function pullPreferredModel() {
    if (state.pulling) return;
    const model = state.health?.preferred_model || "llama3";
    state.pulling = true;
    pullBtn.disabled = true;
    pullBtn.textContent = `Downloading ${model}…`;
    let failed = null;
    try {
      const res = await fetch("/api/pull", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, nl).trim();
          pending = pending.slice(nl + 1);
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line); } catch (_) { continue; }
          if (evt.type === "progress") {
            const pct = evt.total ? Math.round((evt.completed / evt.total) * 100) : null;
            pullBtn.textContent = pct !== null
              ? `Downloading ${model}… ${pct}% (${fmtGB(evt.completed)} / ${fmtGB(evt.total)})`
              : `${evt.status || "Working"}…`;
          } else if (evt.type === "error") {
            failed = evt.error;
          }
        }
      }
    } catch (err) {
      failed = err.message;
    } finally {
      state.pulling = false;
      pullBtn.disabled = false;
      if (failed) {
        pullBtn.textContent = `Download failed – retry`;
        pullBtn.title = failed;
        alert(`Model download failed: ${failed}`);
      }
      await refreshHealth();
    }
  }
  pullBtn.addEventListener("click", pullPreferredModel);

  // ───────────────────────── Chat actions ─────────────────────────
  function newChat() {
    if (state.streaming) stopStreaming();
    state.currentId = null;
    chatTitleEl.textContent = "New chat";
    clearMessages();
    renderChatList();
    closeSidebarOnMobile();
    inputEl.focus();
  }

  async function openChat(id) {
    if (state.streaming) stopStreaming();
    try {
      const chat = await api(`/api/chats/${id}`);
      state.currentId = chat.id;
      chatTitleEl.textContent = chat.title;
      clearMessages();
      for (const m of chat.messages) {
        const meta = m.role === "assistant" && m.model ? `${m.model} · ${formatTime(m.created_at)}` : formatTime(m.created_at);
        addMessage(m.role, m.content, { meta });
      }
      if (chat.model && [...modelSelect.options].some((o) => o.value === chat.model)) {
        modelSelect.value = chat.model;
      }
      renderChatList();
      scrollToBottom(true);
      closeSidebarOnMobile();
    } catch (err) {
      console.error(err);
      await refreshChats();
    }
  }

  async function renameChat(chat) {
    const title = window.prompt("Rename chat", chat.title);
    if (!title || !title.trim() || title.trim() === chat.title) return;
    try {
      await api(`/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: title.trim() }) });
      if (chat.id === state.currentId) chatTitleEl.textContent = title.trim();
      await refreshChats();
    } catch (err) { alert(`Rename failed: ${err.message}`); }
  }

  async function deleteChat(chat) {
    if (!window.confirm(`Delete "${chat.title}"?`)) return;
    try {
      await api(`/api/chats/${chat.id}`, { method: "DELETE" });
      if (chat.id === state.currentId) newChat();
      await refreshChats();
    } catch (err) { alert(`Delete failed: ${err.message}`); }
  }

  async function clearAll() {
    if (!state.chats.length || !window.confirm("Delete ALL conversations? This cannot be undone.")) return;
    try {
      await api("/api/chats", { method: "DELETE" });
      newChat();
      await refreshChats();
    } catch (err) { alert(`Clear failed: ${err.message}`); }
  }

  // ───────────────────────── Streaming ─────────────────────────
  function setStreaming(on) {
    state.streaming = on;
    sendBtn.hidden = on;
    stopBtn.hidden = !on;
    inputEl.disabled = false;
    if (!on) sendBtn.disabled = !inputEl.value.trim();
  }

  function stopStreaming() {
    if (state.abort) state.abort.abort();
  }

  async function sendMessage(text) {
    text = text.trim();
    if (!text || state.streaming) return;

    inputEl.value = "";
    autoResize();
    addMessage("user", text, { meta: formatTime(new Date().toISOString()) });

    const reply = addMessage("assistant", "", { streaming: true });
    let buffer = "";
    let model = null;
    let renderScheduled = false;
    const scheduleRender = () => {
      if (renderScheduled) return;
      renderScheduled = true;
      requestAnimationFrame(() => {
        renderScheduled = false;
        reply.contentEl.innerHTML = renderMarkdown(buffer);
        decorateCode(reply.contentEl);
        scrollToBottom();
      });
    };

    setStreaming(true);
    state.abort = new AbortController();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: state.currentId, message: text, model: modelSelect.value || null }),
        signal: state.abort.signal,
      });
      if (!res.ok || !res.body) {
        let detail = res.statusText;
        try { detail = (await res.json()).detail || detail; } catch (_) { /* ignore */ }
        throw new Error(detail || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let finished = false;

      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, nl).trim();
          pending = pending.slice(nl + 1);
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line); } catch (_) { continue; }
          switch (evt.type) {
            case "meta":
              if (evt.chat_id && evt.chat_id !== state.currentId) {
                state.currentId = evt.chat_id;
                refreshChats();
              }
              if (evt.title) chatTitleEl.textContent = evt.title;
              model = evt.model;
              break;
            case "token":
              buffer += evt.content;
              scheduleRender();
              break;
            case "error":
              reply.node.classList.add("error");
              buffer += (buffer ? "\n\n" : "") + `**Error:** ${evt.error}`;
              scheduleRender();
              break;
            case "done":
              finished = true;
              break;
          }
        }
      }
    } catch (err) {
      if (err.name === "AbortError") {
        buffer += (buffer ? "\n\n" : "") + "_Generation stopped._";
      } else {
        reply.node.classList.add("error");
        buffer += (buffer ? "\n\n" : "") + `**Error:** ${err.message}`;
      }
    } finally {
      state.abort = null;
      reply.bubble.classList.remove("streaming");
      reply.contentEl.innerHTML = renderMarkdown(buffer || "_(empty response)_");
      decorateCode(reply.contentEl);
      reply.metaEl.textContent = model ? `${model} · ${formatTime(new Date().toISOString())}` : formatTime(new Date().toISOString());
      setStreaming(false);
      scrollToBottom();
      refreshChats();
      inputEl.focus();
    }
  }

  // ───────────────────────── Composer ─────────────────────────
  function autoResize() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 220) + "px";
    sendBtn.disabled = !inputEl.value.trim() || state.streaming;
  }

  composerEl.addEventListener("submit", (e) => {
    e.preventDefault();
    sendMessage(inputEl.value);
  });
  inputEl.addEventListener("input", autoResize);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage(inputEl.value);
    }
  });
  stopBtn.addEventListener("click", stopStreaming);
  document.querySelectorAll(".suggestion").forEach((btn) =>
    btn.addEventListener("click", () => sendMessage(btn.dataset.prompt))
  );

  // ───────────────────────── Sidebar ─────────────────────────
  const mobile = () => window.matchMedia("(max-width: 800px)").matches;
  function closeSidebarOnMobile() { if (mobile()) appEl.classList.remove("sidebar-open"); }
  $("open-sidebar").addEventListener("click", () => {
    if (mobile()) appEl.classList.add("sidebar-open");
    else appEl.classList.remove("sidebar-collapsed");
  });
  $("close-sidebar").addEventListener("click", () => appEl.classList.remove("sidebar-open"));
  $("sidebar-backdrop").addEventListener("click", () => appEl.classList.remove("sidebar-open"));
  $("new-chat").addEventListener("click", newChat);
  $("clear-all").addEventListener("click", clearAll);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); newChat(); }
    if (e.key === "Escape" && state.streaming) stopStreaming();
  });

  // ───────────────────────── Init ─────────────────────────
  (async () => {
    autoResize();
    await Promise.all([refreshHealth(), refreshChats()]);
    setInterval(refreshHealth, 15000);
    inputEl.focus();
  })();
})();
