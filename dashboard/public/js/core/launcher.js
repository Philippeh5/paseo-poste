import { send, on, onConnection } from "./socket.js";
import { escapeHtml } from "./util.js";
import { getState } from "./state.js";
import { getSelectedProject } from "./selection.js";
import { visibleWorkspaces, showAllProjects, setShowAllProjects } from "./projects.js";
import { hostLabel, harnessLabel } from "./names.js";
import { openLLMChat } from "../components/llmchat.js";

const TEMPLATE = `
<form id="launch-form" method="dialog" class="dialog-body">
  <header class="dialog-head">
    <h2>Lancer une session</h2>
    <button type="button" class="icon-btn" data-close aria-label="Fermer">&times;</button>
  </header>
  <label class="field">Type
    <select name="kind">
      <option value="terminal">Terminal (ligne de commande)</option>
      <option value="agent">Agent</option>
      <option value="llm">LLM direct</option>
    </select></label>
  <div class="workspace-options">
    <label class="field">Machine<select name="host" required></select></label>
    <label class="field">Projet<select name="workspace"></select></label>
    <label class="check"><input type="checkbox" name="showAll"> Afficher tous les projets</label>
    <label class="field">Chemin du projet
      <input name="cwd" class="mono" placeholder="Dossier sur la machine" autocomplete="off"></label>
  </div>
  <div class="provider-options">
    <label class="check auto-label"><input type="checkbox" name="auto"> Auto : suivre le classement des modèles (vue Modèles)</label>
    <label class="field auto-role" hidden>Rôle du classement
      <select name="autoRole">
        <option value="writer">Écriture</option>
        <option value="reader">Lecture seule</option>
        <option value="planner">Planification</option>
      </select></label>
    <label class="field">Fournisseur<select name="provider"></select></label>
    <div class="field">
      <div class="model-options-head">
        <span>Modèle</span>
        <label class="check pi-fav-only-label" style="font-size: 12px; margin: 0; font-weight: normal;">
          <input type="checkbox" name="piFavOnly"> Favoris seulement
        </label>
        <label class="check pi-free-only-label" style="font-size: 12px; margin: 0; font-weight: normal;" hidden>
          <input type="checkbox" name="freeOnly"> Gratuits seulement
        </label>
      </div>
      <div class="model-row-wrapper">
        <select name="model"></select>
        <button type="button" class="star-btn" name="starBtn" aria-label="Favori"
                aria-pressed="false" title="Ajouter aux favoris">☆</button>
      </div>
    </div>
  </div>
  <div class="agent-detail-options">
    <label class="field">Mode et permissions
      <select name="mode"><option value="">Mode par défaut</option></select></label>
    <label class="field">Titre<input name="title" autocomplete="off"></label>
    <label class="field">Invite de départ<textarea name="prompt" rows="3"></textarea></label>
    <label class="field">Isolation
      <select name="isolation">
        <option value="local">Locale</option>
        <option value="worktree">Arbre de travail (worktree)</option>
      </select></label>
    <label class="field branch-label">Branche<input name="branch" value="paseo-task" class="mono"></label>
  </div>
  <p class="form-error" role="alert"></p>
  <footer class="dialog-foot">
    <button type="button" class="btn" data-close>Annuler</button>
    <button type="submit" class="btn btn-primary">Lancer</button>
  </footer>
</form>`;

const PROVIDER_STATUS = { ready: "Disponible", loading: "Chargement", error: "Erreur", unavailable: "Indisponible" };
const option = (value, label, disabled = false) =>
  `<option value="${escapeHtml(value)}"${disabled ? " disabled" : ""}>${escapeHtml(label)}</option>`;

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

let dialog;
let form;
let optionsByHost = {};
let pendingPrefill = null;
let modelFavorites = {};
let llmProviders = DEFAULT_LLM_PROVIDERS;
let lastProvider = "";

function updateProjects() {
  const hostVal = form.elements.host.value;
  const list = visibleWorkspaces(hostVal, optionsByHost[hostVal]?.workspaces || []);
  form.elements.showAll.checked = showAllProjects();
  form.elements.workspace.innerHTML = option("", "Saisir un chemin…") +
    list.map((w) => option(w.directory || "", `${w.name} · ${w.directory || ""}`)).join("");
  if (pendingPrefill?.cwd) {
    form.elements.cwd.value = pendingPrefill.cwd;
    const match = list.find((w) => w.directory === pendingPrefill.cwd);
    form.elements.workspace.value = match ? match.directory : "";
  } else {
    form.elements.cwd.value = form.elements.workspace.value;
  }
}

function updateFavBtn() {
  const provKey = form.elements.provider.value;
  const modelId = form.elements.model.value;
  const favs = modelFavorites[provKey] || [];
  const isFav = Boolean(modelId && favs.includes(modelId));
  const btn = form.elements.starBtn;
  if (!btn) return;
  btn.setAttribute("aria-pressed", isFav ? "true" : "false");
  btn.textContent = isFav ? "★" : "☆";
  btn.title = isFav ? "Retirer des favoris" : "Ajouter aux favoris";
  btn.disabled = !modelId;
}

function updateModels() {
  const isLLM = form.elements.kind.value === "llm";
  const provKey = form.elements.provider.value;
  const favs = modelFavorites[provKey] || [];
  const isPi = provKey === "pi" || provKey.startsWith("pi/");
  const piFavLabel = form.querySelector(".pi-fav-only-label");
  const freeLabel = form.querySelector(".pi-free-only-label");

  freeLabel.hidden = !isPi;
  if (isPi) {
    piFavLabel.hidden = false;
    if (lastProvider !== provKey) {
      form.elements.piFavOnly.checked = true;
    }
  } else {
    piFavLabel.hidden = true;
  }
  lastProvider = provKey;

  let rawModels = [];
  let rawModes = [];
  if (isLLM) {
    const p = llmProviders.find((x) => x.id === provKey);
    rawModels = p?.models || [];
  } else {
    const providers = optionsByHost[form.elements.host.value]?.providers || [];
    const p = providers.find((x) => x.id === provKey);
    rawModels = p?.models || [];
    rawModes = p?.modes || [];
  }

  // Gratuits : suffixe « :free » d'OpenRouter uniquement (le catalogue NVIDIA ne dit pas quels modèles sont gratuits) ; appliqué AVANT les favoris.
  let filtered = [...rawModels];
  if (isPi && form.elements.freeOnly.checked) filtered = filtered.filter((m) => /:free$/.test(m.id) && !/(^|\/)(auto|free|fusion|pareto)/i.test(m.id.replace(/^openrouter(-free)?\//, "")));
  if (isPi && form.elements.piFavOnly.checked && favs.length > 0) {
    const onlyFavs = filtered.filter((m) => favs.includes(m.id));
    if (onlyFavs.length > 0) filtered = onlyFavs;
  }

  filtered.sort((a, b) => {
    const aFav = favs.includes(a.id);
    const bFav = favs.includes(b.id);
    if (aFav && !bFav) return -1;
    if (!aFav && bFav) return 1;
    return 0;
  });

  const prevModel = form.elements.model.value;
  form.elements.model.innerHTML = filtered.map((x) => {
    const star = favs.includes(x.id) ? "★ " : "";
    return option(x.id, `${star}${x.label || x.id}`);
  }).join("");

  if (prevModel && filtered.some((m) => m.id === prevModel)) {
    form.elements.model.value = prevModel;
  }

  if (form.elements.mode) {
    form.elements.mode.innerHTML = option("", "Mode par défaut") +
      rawModes.map((x) => option(x.id, x.label || x.id)).join("");
  }

  updateFavBtn();
}

function updateLLMProviders() {
  form.elements.provider.innerHTML = llmProviders.map((x) => option(x.id, x.label || x.id)).join("");
  updateModels();
}

function updateProviders() {
  const providers = optionsByHost[form.elements.host.value]?.providers || [];
  form.elements.provider.innerHTML = providers.map((x) => {
    const status = PROVIDER_STATUS[x.status] || x.status;
    const label = harnessLabel(x.id || x.label);
    return option(x.id, `${label} · ${status}${x.available ? "" : " (indisponible)"}`, !x.available);
  }).join("");
  updateModels();
}

function refreshHosts() {
  // Oracle d'abord et par défaut (le Mini PC reste disponible à côté).
  const hosts = getState().hosts.filter((h) => h.status === "connected").sort((a, b) => Number(b.label === "oracle") - Number(a.label === "oracle"));
  const wanted = pendingPrefill?.host;
  form.elements.host.innerHTML = hosts.map((h) => option(h.label, hostLabel(h))).join("");
  if (wanted && hosts.some((h) => h.label === wanted)) form.elements.host.value = wanted;
  if (form.elements.host.value) send({ type: "launch.options", host: form.elements.host.value });
}

function toggleFields() {
  const kind = form.elements.kind.value;
  const isAgent = kind === "agent";
  const isLLM = kind === "llm";
  const isTerminal = kind === "terminal";

  form.querySelector(".workspace-options").hidden = isLLM;
  form.querySelector(".provider-options").hidden = isTerminal;
  form.querySelector(".auto-label").hidden = !isAgent; // le classement ne s'applique qu'aux agents, pas au LLM direct
  const auto = isAgent && form.elements.auto.checked;
  form.querySelector(".auto-role").hidden = !auto;
  form.elements.provider.closest(".field").hidden = auto;
  form.querySelector(".model-options-head").closest(".field").hidden = auto;
  form.querySelector(".agent-detail-options").hidden = !isAgent;
  form.querySelector(".branch-label").hidden = form.elements.isolation.value !== "worktree";
  form.elements.host.required = !isLLM;

  if (isLLM) {
    updateLLMProviders();
  } else if (isAgent) {
    updateProviders();
  }
}

export function openLauncher(prefill = null) {
  // Sans dossier imposé, on propose le projet sélectionné dans le rail.
  const sel = getSelectedProject();
  if (sel && !prefill?.cwd) prefill = { ...prefill, host: prefill?.host || sel.host, cwd: sel.directory };
  pendingPrefill = prefill;
  form.querySelector(".form-error").textContent = "";
  if (prefill?.kind) form.elements.kind.value = prefill.kind;
  toggleFields();
  if (form.elements.kind.value !== "llm") {
    refreshHosts();
  }
  dialog.showModal();
}

export function showLauncherError(message) {
  if (dialog?.open) form.querySelector(".form-error").textContent = message;
}

export function setupLauncher(button) {
  dialog = document.createElement("dialog");
  dialog.className = "dialog";
  dialog.id = "launch-dialog";
  dialog.setAttribute("aria-label", "Lancer une session");
  dialog.innerHTML = TEMPLATE;
  document.body.append(dialog);
  form = dialog.querySelector("form");

  const { host, workspace, provider, model, kind, isolation, starBtn, piFavOnly } = form.elements;

  button.addEventListener("click", () => openLauncher());

  host.addEventListener("change", () => {
    pendingPrefill = null;
    send({ type: "launch.options", host: host.value });
  });

  form.elements.showAll.addEventListener("change", () => {
    setShowAllProjects(form.elements.showAll.checked);
    updateProjects();
  });

  workspace.addEventListener("change", () => {
    pendingPrefill = null;
    if (workspace.value) form.elements.cwd.value = workspace.value;
  });

  provider.addEventListener("change", updateModels);
  form.elements.auto.addEventListener("change", toggleFields);
  model.addEventListener("change", updateFavBtn);
  piFavOnly.addEventListener("change", updateModels);
  form.elements.freeOnly.addEventListener("change", updateModels);

  starBtn.addEventListener("click", () => {
    const provKey = form.elements.provider.value;
    const modelId = form.elements.model.value;
    if (!provKey || !modelId) return;
    send({ type: "favorites.toggle", provider: provKey, modelId });
  });

  kind.addEventListener("change", toggleFields);
  isolation.addEventListener("change", toggleFields);
  toggleFields();

  dialog.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => dialog.close()));

  on("launch.options", (data) => {
    optionsByHost[data.host] = data;
    if (data.host !== host.value) return;
    updateProjects();
    if (form.elements.kind.value === "agent") updateProviders();
  });

  on("favorites.list", (data) => {
    modelFavorites = data.favorites || {};
    updateModels();
  });

  on("llm.models", (data) => {
    if (Array.isArray(data.providers) && data.providers.length > 0) {
      llmProviders = data.providers;
      if (form.elements.kind.value === "llm") updateLLMProviders();
    }
  });

  onConnection((connected) => {
    if (connected) {
      send({ type: "favorites.get" });
      send({ type: "llm.models" });
    }
  });

  on("launch.started", (msg) => {
    if (msg.ref === "launcher" && dialog.open) dialog.close();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    form.querySelector(".form-error").textContent = "";
    const f = form.elements;

    if (f.kind.value === "llm") {
      dialog.close();
      openLLMChat({
        provider: f.provider.value,
        model: f.model.value,
      });
      return;
    }

    const auto = f.kind.value === "agent" && f.auto.checked;
    send({
      type: "launch.start", ref: "launcher", host: f.host.value, cwd: f.cwd.value.trim(), kind: f.kind.value,
      provider: auto ? "auto" : f.provider.value, model: auto ? "auto" : f.model.value, ...(auto ? { role: f.autoRole.value } : {}), mode: f.mode.value, title: f.title.value,
      prompt: f.prompt.value, worktree: f.isolation.value === "worktree", branch: f.branch.value,
    });
  });
}
