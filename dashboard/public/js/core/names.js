// Module pur et testable de nommage des machines, harnais, projets, sessions et tâches.
// Sans dépendance au DOM, importable par le navigateur (ES module) et par Node.js.

const DEFAULT_HOST_NAMES = {
  local: "Mini PC",
  oracle: "Oracle",
};

/**
 * Libellé lisible d'un hôte.
 * @param {string|object} host - Identifiant d'hôte ou objet hôte { label, displayName }
 * @param {object|Array} [overrides] - Dictionnaire { hostId: label } ou liste d'hôtes avec displayName
 * @returns {string} Libellé affiché (ex: "Mini PC", "Oracle", "Serveur-1")
 */
export function hostLabel(host, overrides) {
  if (!host && host !== 0) return "";
  let id = "";
  if (typeof host === "object" && host !== null) {
    if (typeof host.displayName === "string" && host.displayName.trim()) {
      return host.displayName.trim();
    }
    id = host.label || host.host || host.id || "";
  } else {
    id = String(host);
  }
  id = id.trim();
  if (!id) return "";

  if (overrides) {
    if (Array.isArray(overrides)) {
      const match = overrides.find((h) => h?.label === id || h?.id === id);
      if (match?.displayName) return match.displayName;
    } else if (typeof overrides === "object" && overrides[id]) {
      return overrides[id];
    }
  }

  const key = id.toLowerCase();
  if (key in DEFAULT_HOST_NAMES) {
    return DEFAULT_HOST_NAMES[key];
  }
  return id.charAt(0).toUpperCase() + id.slice(1);
}

// Modèle réel derrière chaque alias des passerelles (« claude-openrouter » : sonnet -> nvidia/nemotron-…), rempli par core/gatewaymodels.js.
let gatewayModels = {};
let gatewayVersion = 0;
export function setGatewayModels(map) { gatewayModels = map && typeof map === "object" ? map : {}; gatewayVersion += 1; }
export const gatewayModelsVersion = () => gatewayVersion;

/**
 * « Sonnet (nemotron-3.5-super-vl) » pour un alias de passerelle, sinon le modèle tel quel (ou "").
 * @param {string} provider - ex. "claude-openrouter"
 * @param {string} model - alias ("sonnet") ou identifiant de modèle
 */
export function modelDisplay(provider, model) {
  if (!model) return "";
  const id = String(provider || "").toLowerCase().split("/")[0];
  const real = gatewayModels[id]?.[String(model).toLowerCase()];
  if (!real) return String(model);
  const alias = String(model)[0].toUpperCase() + String(model).slice(1).toLowerCase();
  const short = String(real).split("/").pop().replace(/:free$/, "");
  return `${alias} (${short})`;
}

/**
 * Libellé lisible d'un harnais ou fournisseur.
 * @param {string} provider - Nom ou identifiant du harnais / moteur
 * @returns {string} Libellé affiché (ex: "Claude", "Claude (OpenRouter)", "Pi", "agy")
 */
export function harnessLabel(provider) {
  if (!provider) return "Inconnu";
  if (typeof provider !== "string") provider = String(provider);
  const raw = provider.trim();
  if (!raw) return "Inconnu";
  const lower = raw.toLowerCase();

  if (lower === "claude-openrouter" || lower.startsWith("claude-openrouter/")) {
    return "Claude (OpenRouter)";
  }
  if (lower === "claude-nvidia" || lower.startsWith("claude-nvidia/")) {
    return "Claude (NVIDIA)";
  }
  if (lower === "claude" || lower.startsWith("claude/")) {
    return "Claude";
  }
  if (lower === "codex" || lower.startsWith("codex/")) {
    return "Codex";
  }
  if (lower === "pi" || lower.startsWith("pi/")) {
    return "Pi";
  }
  if (lower === "hermes" || lower.startsWith("hermes/")) {
    return "Hermes";
  }
  if (lower === "antigravity" || lower === "agy" || lower.startsWith("antigravity/") || lower.startsWith("agy/")) {
    return "agy";
  }
  if (lower === "opencode" || lower.startsWith("opencode/")) {
    return "OpenCode";
  }
  if (lower === "copilot" || lower.startsWith("copilot/")) {
    return "Copilot";
  }
  if (lower === "freebuff" || lower.startsWith("freebuff/")) {
    return "FreeBuff";
  }
  if (lower === "terminal" || lower.startsWith("terminal/")) {
    return "Terminal";
  }

  const part = raw.split("/")[0].trim();
  if (!part) return "Inconnu";
  return part.charAt(0).toUpperCase() + part.slice(1);
}

/**
 * Nom du projet extrait du chemin de dossier.
 * @param {string|object} dir - Chemin du dossier (Windows ou Linux) ou objet { directory, name }
 * @returns {string} Nom du dernier segment
 */
export function projectLabel(dir) {
  if (!dir && dir !== 0) return "";
  if (typeof dir === "object") {
    dir = dir.name || dir.directory || dir.project || dir.projectName || "";
  }
  if (typeof dir !== "string") return "";
  const trimmed = dir.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  const segment = trimmed.split(/[\\/]/).pop();
  return segment || "";
}

/**
 * Détecte si un titre ressemble à un identifiant technique automatique.
 * @param {string} str
 * @returns {boolean}
 */
export function isIdentifier(str) {
  if (!str || typeof str !== "string") return true;
  const s = str.trim();
  if (!s) return true;
  if (/^(agent|session|task|tâche)[\s\-_]?[0-9a-f]{4,}/i.test(s)) return true;
  if (/^[0-9a-f]{8,}(-[0-9a-f]{4,})*$/i.test(s)) return true;
  if (/^[0-9a-f]{6,}$/i.test(s)) return true;
  return false;
}

/**
 * Formate et tronque un titre (48 caractères max avec « … »).
 * @param {string} title
 * @param {string} [id]
 * @param {string} [fallbackPrefix="Session sans titre"]
 * @returns {string}
 */
export function formatTitle(title, id, fallbackPrefix = "Session sans titre") {
  if (isIdentifier(title)) {
    const idStr = id ? String(id).replace(/^(agent|task|tâche|session)[\s\-_]/i, "").trim() : "";
    const id4 = idStr ? idStr.slice(0, 4) : "";
    return id4 ? `${fallbackPrefix} ${id4}` : fallbackPrefix;
  }
  const clean = String(title).replace(/\s+/g, " ").trim();
  return clean.length > 48 ? `${clean.slice(0, 48)}…` : clean;
}

/**
 * Nom complet d'une session : Projet · Machine · Harnais · titre (ou Projet · Machine · Terminal).
 * @param {object} session
 * @param {string} [session.project]
 * @param {string} [session.host]
 * @param {string} [session.provider]
 * @param {string} [session.title]
 * @param {string} [session.kind]
 * @param {string} [session.id]
 * @returns {string}
 */
export function sessionName({ project, host, provider, title, kind, id, model } = {}) {
  const p = projectLabel(project) || "Sans projet";
  const m = hostLabel(host);
  if (kind === "terminal" || provider === "terminal") {
    return `${p} · ${m} · Terminal`;
  }
  const shown = modelDisplay(provider, model);
  const h = harnessLabel(provider) + (shown && shown !== model ? ` · ${shown}` : "");
  const t = formatTitle(title, id, "Session sans titre");
  return `${p} · ${m} · ${h} · ${t}`;
}

/**
 * Nom complet d'une tâche : Projet · Machine · Harnais · titre.
 * @param {object} task
 * @returns {string}
 */
export function taskName(task = {}) {
  const p = projectLabel(task.project || task.projectName) || "Sans projet";
  const m = hostLabel(task.host);
  const h = harnessLabel(task.provider || task.engine);
  const t = formatTitle(task.title, task.id, "Tâche sans titre");
  return `${p} · ${m} · ${h} · ${t}`;
}

/**
 * Outil lancé dans un terminal, déduit de la commande saisie (« freebuff », « hermes --yolo », « D:\bin\pi.cmd »).
 * @param {string} [command]
 * @returns {string} Libellé de l'outil, « Terminal » si aucune commande
 */
export function toolFromCommand(command) {
  if (typeof command !== "string") return "Terminal";
  const match = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const first = match ? match[1] || match[2] || match[3] : "";
  const base = first.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1|sh)$/i, "");
  return base ? harnessLabel(base) : "Terminal";
}

/**
 * Titre d'une fenêtre du Bureau : « Outil · Projet · Machine » (ex. « FreeBuff · sandbox-repo · Mini PC »).
 * @param {object} win
 * @param {string} [win.tool] - Outil (terminal) ; « Terminal » par défaut
 * @param {string} [win.provider] - Harnais (agent)
 * @param {string} [win.project] - Dossier ou nom de projet
 * @param {string} [win.host]
 * @param {string} [win.kind] - « agent » ou « terminal »
 * @returns {string}
 */
export function windowName({ tool, provider, project, host, kind } = {}) {
  const what = kind === "agent" ? (provider ? harnessLabel(provider) : "Agent") : (tool || "Terminal");
  return `${what} · ${projectLabel(project) || "Sans projet"} · ${hostLabel(host) || "Machine inconnue"}`;
}

/**
 * Numérote uniquement les doublons : [A, B, A, A] devient [A, B, A (2), A (3)].
 * @param {string[]} names
 * @returns {string[]}
 */
export function numberDuplicates(names) {
  const seen = new Map();
  return names.map((name) => {
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} (${n})`;
  });
}

/**
 * Détecte un nom de terminal automatique du démon (« sandbox-repo terminal 5 », « Terminal 3 »).
 * @param {string} str
 * @returns {boolean}
 */
export function isAutoTerminalName(str) {
  return typeof str === "string" && /(^|\s)terminal\s*\d*$/i.test(str.trim());
}
