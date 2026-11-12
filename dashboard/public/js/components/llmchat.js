// Panneau latéral non bloquant de discussion avec un modèle LLM direct.
import { send, on, onConnection } from "../core/socket.js";
import { escapeHtml } from "../core/util.js";

const STORAGE_KEY = "paseo:sidechat-history";

const DEFAULT_LLM_PROVIDERS = [
  {
    id: "openrouter",
    label: "OpenRouter",
    models: [
      { id: "poolside/laguna-s-2.1:free", label: "Laguna S 2.1 (gratuit)" },
      { id: "thinkingmachines/inkling:free", label: "Inkling (gratuit)" },
      { id: "meta-llama/llama-3.3-70b-instruct:free", label: "Llama 3.3 70B (gratuit)" },
      { id: "deepseek/deepseek-r1:free", label: "DeepSeek R1 (gratuit)" },
      { id: "google/gemini-2.0-flash-exp:free", label: "Gemini 2.0 Flash Exp (gratuit)" },
    ],
  },
  {
    id: "nvidia",
    label: "NVIDIA",
    models: [
      { id: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra 550B" },
      { id: "meta/llama-3.1-8b-instruct", label: "Llama 3.1 8B" },
      { id: "meta/llama-3.3-70b-instruct", label: "Llama 3.3 70B" },
    ],
  },
];

let panel = null;
let currentProvider = "openrouter";
let currentModel = "poolside/laguna-s-2.1:free";
let messages = [];
let pendingReqId = null;
let errorText = "";
let modelFavorites = {};
let llmProviders = DEFAULT_LLM_PROVIDERS;
let toggleButton = null;
let returnFocus = null;

function loadSession() {
  try {
    const raw = window.sessionStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveSession() {
  try {
    const data = { messages, provider: currentProvider, model: currentModel };
    window.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // sessionStorage indisponible ou quota dépassé
  }
}

// Initialise l'historique depuis sessionStorage au premier chargement
const restored = loadSession();
if (restored) {
  if (Array.isArray(restored.messages)) messages = restored.messages;
  if (restored.provider) currentProvider = restored.provider;
  if (restored.model) currentModel = restored.model;
}

function getSortedModels(providerId) {
  const p = llmProviders.find((x) => x.id === providerId) || llmProviders[0];
  const raw = p?.models || [];
  const favs = modelFavorites[providerId] || [];
  const list = [...raw];
  list.sort((a, b) => {
    const aFav = favs.includes(a.id);
    const bFav = favs.includes(b.id);
    if (aFav && !bFav) return -1;
    if (!aFav && bFav) return 1;
    return 0;
  });
  return list;
}

function renderMessages(bodyEl) {
  if (!bodyEl) return;
  if (messages.length === 0 && !errorText && !pendingReqId) {
    bodyEl.innerHTML = `
      <div class="llmchat-empty">
        <p>Discussion directe avec <strong>${escapeHtml(currentModel)}</strong> (${escapeHtml(currentProvider)}).</p>
        <p class="llmchat-help">Saisissez un message ci-dessous pour démarrer l'échange.</p>
      </div>`;
    return;
  }

  let html = messages.map((m) => {
    const isUser = m.role === "user";
    const roleClass = isUser ? "llmchat-msg-user" : "llmchat-msg-assistant";
    const roleLabel = isUser ? "Vous" : "Assistant";
    return `
      <div class="llmchat-msg ${roleClass}">
        <span class="llmchat-msg-role">${roleLabel}</span>
        <div class="llmchat-msg-content">${escapeHtml(m.content)}</div>
      </div>`;
  }).join("");

  if (pendingReqId) {
    html += `
      <div class="llmchat-loading" role="status">
        <span>Réponse en cours…</span>
      </div>`;
  }

  if (errorText) {
    html += `
      <div class="llmchat-error" role="alert">
        ${escapeHtml(errorText)}
      </div>`;
  }

  bodyEl.innerHTML = html;
  bodyEl.scrollTop = bodyEl.scrollHeight;
}

async function copyToClipboard(text) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {}
  return false;
}

function updateModelsSelect(panelEl) {
  const p = panelEl || panel;
  if (!p) return;
  const modelSelect = p.querySelector('select[name="sidechat-model"]');
  if (!modelSelect) return;
  const list = getSortedModels(currentProvider);
  const favs = modelFavorites[currentProvider] || [];

  modelSelect.innerHTML = list.map((m) => {
    const star = favs.includes(m.id) ? "★ " : "";
    return `<option value="${escapeHtml(m.id)}">${star}${escapeHtml(m.label || m.id)}</option>`;
  }).join("");

  if (currentModel && list.some((m) => m.id === currentModel)) {
    modelSelect.value = currentModel;
  } else if (list.length > 0) {
    currentModel = list[0].id;
    modelSelect.value = currentModel;
    saveSession();
  }
}

function updateProvidersSelect(panelEl) {
  const p = panelEl || panel;
  if (!p) return;
  const provSelect = p.querySelector('select[name="sidechat-provider"]');
  if (!provSelect) return;
  provSelect.innerHTML = llmProviders.map((x) =>
    `<option value="${escapeHtml(x.id)}">${escapeHtml(x.label || x.id)}</option>`
  ).join("");
  if (currentProvider && llmProviders.some((x) => x.id === currentProvider)) {
    provSelect.value = currentProvider;
  } else if (llmProviders.length > 0) {
    currentProvider = llmProviders[0].id;
    provSelect.value = currentProvider;
  }
  updateModelsSelect(p);
}

function ensurePanel() {
  if (panel) return panel;

  panel = document.getElementById("sidechat");
  if (!panel) {
    panel = document.createElement("aside");
    panel.id = "sidechat";
    panel.className = "sidechat";
    panel.setAttribute("aria-label", "Discussion avec un LLM");
    panel.hidden = true;
    document.body.append(panel);
  }

  panel.innerHTML = `
    <header class="sidechat-head">
      <div class="sidechat-title-group">
        <h2 class="sidechat-title">Discussion LLM</h2>
      </div>
      <button type="button" class="icon-btn" data-close aria-label="Fermer la discussion (Échap)"
              title="Fermer (Échap)">&times;</button>
    </header>
    <div class="sidechat-controls">
      <div class="sidechat-selects-row">
        <label class="sidechat-field">
          <span class="sidechat-field-label">Fournisseur</span>
          <select name="sidechat-provider" class="select-sm" aria-label="Fournisseur"></select>
        </label>
        <label class="sidechat-field">
          <span class="sidechat-field-label">Modèle</span>
          <select name="sidechat-model" class="select-sm" aria-label="Modèle"></select>
        </label>
      </div>
      <div class="sidechat-actions-row">
        <button type="button" class="btn btn-sm" id="sidechat-new"
                title="Effacer la discussion en cours">Nouvelle discussion</button>
        <button type="button" class="btn btn-sm" id="sidechat-copy"
                title="Copier la dernière réponse de l'assistant">Copier la dernière réponse</button>
      </div>
    </div>
    <div class="sidechat-body llmchat-body" id="sidechat-body" role="log" aria-live="polite"></div>
    <form class="sidechat-foot llmchat-foot" id="sidechat-form">
      <div class="llmchat-input-row">
        <textarea name="prompt" class="llmchat-textarea" placeholder="Votre message…" rows="2" required></textarea>
        <button type="submit" class="btn btn-primary btn-sm">Envoyer</button>
      </div>
      <div class="llmchat-actions">
        <span class="llmchat-help">Entrée pour envoyer, Maj+Entrée pour nouvelle ligne</span>
      </div>
    </form>`;

  const form = panel.querySelector("#sidechat-form");
  const bodyEl = panel.querySelector("#sidechat-body");
  const textarea = form.elements.prompt;
  const submitBtn = form.querySelector("button[type='submit']");
  const provSelect = panel.querySelector('select[name="sidechat-provider"]');
  const modelSelect = panel.querySelector('select[name="sidechat-model"]');
  const newBtn = panel.querySelector("#sidechat-new");
  const copyBtn = panel.querySelector("#sidechat-copy");

  panel.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeSideChat()));

  provSelect.addEventListener("change", () => {
    currentProvider = provSelect.value;
    updateModelsSelect(panel);
    saveSession();
    renderMessages(bodyEl);
  });

  modelSelect.addEventListener("change", () => {
    currentModel = modelSelect.value;
    saveSession();
    renderMessages(bodyEl);
  });

  newBtn.addEventListener("click", () => {
    messages = [];
    errorText = "";
    pendingReqId = null;
    submitBtn.disabled = false;
    saveSession();
    renderMessages(bodyEl);
    textarea.focus();
  });

  copyBtn.addEventListener("click", async () => {
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    if (!last?.content) {
      const orig = copyBtn.textContent;
      copyBtn.textContent = "Aucune réponse";
      setTimeout(() => { copyBtn.textContent = orig; }, 1200);
      return;
    }
    const ok = await copyToClipboard(last.content);
    const orig = copyBtn.textContent;
    copyBtn.textContent = ok ? "Copié !" : "Erreur";
    setTimeout(() => { copyBtn.textContent = orig; }, 1200);
  });

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    if (!text || pendingReqId) return;

    messages.push({ role: "user", content: text });
    textarea.value = "";
    errorText = "";
    pendingReqId = `llm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    submitBtn.disabled = true;
    saveSession();
    renderMessages(bodyEl);

    send({
      type: "llm.chat",
      id: pendingReqId,
      provider: currentProvider,
      model: currentModel,
      messages,
    });
  });

  updateProvidersSelect(panel);
  renderMessages(bodyEl);
  return panel;
}

// Écouteurs globaux
on("favorites.list", (data) => {
  modelFavorites = data?.favorites || {};
  if (panel) updateModelsSelect(panel);
});

on("llm.models", (data) => {
  if (Array.isArray(data?.providers) && data.providers.length > 0) {
    llmProviders = data.providers;
    if (panel) updateProvidersSelect(panel);
  }
});

on("llm.reply", (msg) => {
  if (!pendingReqId || msg.id !== pendingReqId) return;
  pendingReqId = null;
  const p = ensurePanel();
  const submitBtn = p.querySelector("button[type='submit']");
  if (submitBtn) submitBtn.disabled = false;

  if (msg.ok) {
    const content = msg.text || msg.reply || "(réponse vide)";
    messages.push({ role: "assistant", content });
    errorText = "";
    saveSession();
  } else {
    errorText = msg.error || "Une erreur est survenue lors de l'appel LLM.";
  }

  const bodyEl = p.querySelector("#sidechat-body");
  renderMessages(bodyEl);
  const textarea = p.querySelector("textarea[name='prompt']");
  if (textarea) textarea.focus();
});

onConnection((connected) => {
  if (connected) {
    send({ type: "favorites.get" });
    send({ type: "llm.models" });
  }
});

window.addEventListener("keydown", (e) => {
  const isCtrlShiftL = (e.code === "KeyL" || e.key.toLowerCase() === "l") &&
    (e.ctrlKey || e.metaKey) && e.shiftKey;
  if (isCtrlShiftL) {
    e.preventDefault();
    toggleSideChat();
    return;
  }

  if (e.key === "Escape" && isSideChatOpen()) {
    if (document.querySelector("dialog[open]")) return;
    e.preventDefault();
    closeSideChat();
  }
});

export function setSideChatButton(button) {
  toggleButton = button;
  if (toggleButton) {
    toggleButton.setAttribute("aria-expanded", String(isSideChatOpen()));
  }
}

export function isSideChatOpen() {
  return Boolean(panel) && !panel.hidden;
}

export function openSideChat({ provider, model } = {}) {
  const p = ensurePanel();
  const jarvis = document.getElementById("jarvis-panel"); // un seul panneau latéral à la fois
  if (jarvis) jarvis.hidden = true;
  if (provider) currentProvider = String(provider).trim();
  if (model) currentModel = String(model).trim();
  updateProvidersSelect(p);
  saveSession();

  p.hidden = false;
  document.body.classList.add("sidechat-open");
  if (toggleButton) toggleButton.setAttribute("aria-expanded", "true");
  returnFocus = document.activeElement;

  const bodyEl = p.querySelector("#sidechat-body");
  renderMessages(bodyEl);
  const textarea = p.querySelector("textarea[name='prompt']");
  if (textarea) textarea.focus();
}

export function closeSideChat() {
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  document.body.classList.remove("sidechat-open");
  if (toggleButton) toggleButton.setAttribute("aria-expanded", "false");
  if (returnFocus && typeof returnFocus.focus === "function" && document.body.contains(returnFocus)) {
    returnFocus.focus();
  }
  returnFocus = null;
}

export function toggleSideChat() {
  if (isSideChatOpen()) {
    closeSideChat();
  } else {
    openSideChat();
  }
}

export function openLLMChat({ provider, model } = {}) {
  openSideChat({ provider, model });
}
