// Barre de widgets : lanceurs rapides configurables.
// Messages : widgets.list, widgets.save {widgets}, widgets.reset.
// Diffuse widgets.changed après chaque modification.
// Le lancement réutilise les messages existants (launch.start, term.create) sans exécuter de commande côté serveur.

import { SELF_HOST, SELF_LABEL } from "../lib/selfhost.mjs";

const FILE = "widgets";
const MAX_WIDGETS = 40;

const KNOWN_TYPES = new Set(["terminal", "agent", "freebuff", "view", "url"]);
const KNOWN_VIEWS = new Set(["agents", "bureau", "machines", "connexions", "services", "reception"]);
// Anciennes pages fusionnées dans « Agents » : un widget enregistré avec l'une d'elles reste valide et mène à #agents.
const VIEW_ALIASES = { taches: "agents", sessions: "agents", chronologie: "agents", projets: "agents", groupes: "agents", agent: "agents" };
const viewOf = (v) => VIEW_ALIASES[v] || v;
const KNOWN_ICONS = new Set([
  "desk", "tasks", "sessions", "timeline", "machines", "inbox",
  "terminal", "agent", "plus", "send", "grid", "group", "save", "trash",
  "menu", "close", "minimize", "maximize", "restore", "stop", "sun", "moon",
]);

// Les lanceurs visent la machine du poste (SELF_HOST). Les variantes « Oracle » n'existent que si le poste
// tourne ailleurs (sinon elles feraient doublon).
function defaultWidgets() {
  const me = SELF_LABEL;
  const others = SELF_HOST !== "oracle";
  return [
    {
      id: "w-terminal-local", label: `Terminal ${me}`, icon: "terminal", order: 10, hidden: false,
      action: { type: "terminal", host: SELF_HOST },
    },
    ...(others ? [{
      id: "w-terminal-oracle", label: "Terminal Oracle", icon: "terminal", order: 20, hidden: false,
      action: { type: "terminal", host: "oracle" },
    }] : []),
    {
      id: "w-agent-openrouter", label: "Agent OpenRouter", icon: "agent", order: 30, hidden: false,
      action: { type: "agent", host: SELF_HOST, provider: "claude-openrouter/sonnet" },
    },
    {
      id: "w-agent-nvidia", label: "Agent NVIDIA", icon: "agent", order: 40, hidden: false,
      action: { type: "agent", host: SELF_HOST, provider: "claude-nvidia/sonnet" },
    },
    {
      id: "w-freebuff", label: "FreeBuff", icon: "terminal", order: 50, hidden: false,
      action: { type: "freebuff", host: SELF_HOST },
    },
    {
      id: "w-hermes-local", label: `Hermes (${me})`, icon: "agent", order: 55, hidden: false,
      action: { type: "agent", host: SELF_HOST, provider: "hermes" },
    },
    ...(others ? [{
      id: "w-hermes-oracle", label: "Hermes (Oracle)", icon: "agent", order: 60, hidden: false,
      action: { type: "agent", host: "oracle", provider: "hermes" },
    }] : []),
    {
      id: "w-pi-local", label: `Pi (${me})`, icon: "agent", order: 65, hidden: false,
      action: { type: "agent", host: SELF_HOST, provider: "pi" },
    },
    {
      id: "w-taches", label: "Agents", icon: "tasks", order: 70, hidden: false,
      action: { type: "view", view: "agents" },
    },
  ];
}

// ---- Validation ----
const str = (v, max = 200) => typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

function validateWidget(w, knownHosts) {
  if (!w || typeof w !== "object") return "widget invalide (pas un objet)";
  const id = str(w.id, 60);
  if (!id || !/^[\w-]{1,60}$/.test(id)) return `id de widget invalide : ${JSON.stringify(w.id)}`;
  const label = str(w.label, 80);
  if (!label) return `libellé manquant pour le widget ${id}`;
  if (w.icon !== undefined && !KNOWN_ICONS.has(w.icon)) return `icône inconnue : ${w.icon}`;
  if (!Number.isFinite(w.order)) return `order doit être un nombre pour le widget ${id}`;
  if (typeof w.hidden !== "boolean") return `hidden doit être un booléen pour le widget ${id}`;
  return validateAction(w.action, id, knownHosts);
}

function validateAction(action, widgetId, knownHosts) {
  if (!action || typeof action !== "object") return `action manquante pour le widget ${widgetId}`;
  if (!KNOWN_TYPES.has(action.type)) return `type d'action inconnu : ${action.type} (widget ${widgetId})`;
  const type = action.type;
  if (type === "url") {
    const url = str(action.url, 2000);
    if (!url) return `url manquante pour le widget ${widgetId}`;
    try {
      const u = new URL(url);
      if (u.protocol !== "https:") return `seules les URL https:// sont autorisées (widget ${widgetId})`;
      if (u.username || u.password) return `l'URL ne doit pas contenir d'identifiants (widget ${widgetId})`;
    } catch {
      return `url invalide pour le widget ${widgetId}`;
    }
    return null;
  }
  if (type === "view") {
    if (!KNOWN_VIEWS.has(viewOf(action.view))) return `vue inconnue : ${action.view} (widget ${widgetId})`;
    return null;
  }
  // terminal / agent / freebuff : nécessitent un hôte
  const host = str(action.host, 60);
  if (!host) return `hôte manquant pour le widget ${widgetId}`;
  if (knownHosts && !knownHosts.has(host)) return `hôte inconnu : ${host} (widget ${widgetId})`;
  if (action.command !== undefined) {
    // Contrôle sur la valeur brute : un retour à la ligne final ne doit pas être « nettoyé » en silence.
    if (typeof action.command !== "string" || !action.command.trim() || action.command.length > 500) {
      return `command invalide pour le widget ${widgetId}`;
    }
    if (/[\r\n]/.test(action.command)) return `command ne peut pas contenir de retour à la ligne (widget ${widgetId})`;
  }
  if (action.args !== undefined) {
    const ok = Array.isArray(action.args) && action.args.length <= 20 &&
      action.args.every((x) => typeof x === "string" && x.length <= 200 && !/[\r\n]/.test(x));
    if (!ok) return `args doit être une liste de 20 chaînes courtes sans retour à la ligne (widget ${widgetId})`;
  }
  if (type === "agent") {
    const provider = str(action.provider, 200);
    if (!provider) return `provider requis pour le widget agent ${widgetId}`;
  }
  return null;
}

function cleanWidget(w, knownHosts) {
  const error = validateWidget(w, knownHosts);
  if (error) return { error };
  const action = cleanAction(w.action);
  return {
    id: str(w.id, 60),
    label: str(w.label, 80),
    icon: KNOWN_ICONS.has(w.icon) ? w.icon : "terminal",
    order: Number(w.order),
    hidden: Boolean(w.hidden),
    action,
  };
}

function cleanAction(a) {
  const base = { type: a.type };
  if (a.type === "url") return { ...base, url: str(a.url, 2000) };
  if (a.type === "view") return { ...base, view: viewOf(a.view) };
  const result = {
    ...base,
    host: str(a.host, 60),
    ...(a.cwd ? { cwd: str(a.cwd, 1000) } : {}),
  };
  if (a.type === "terminal") {
    if (a.command) result.command = str(a.command, 500);
    if (a.args?.length) result.args = a.args.slice(0, 20);
  }
  if (a.type === "agent") {
    result.provider = str(a.provider, 200);
    if (a.mode) result.mode = str(a.mode, 60);
    if (a.prompt) result.prompt = str(a.prompt, 2000);
  }
  return result;
}

export function register(ctx) {
  const { onMessage, send, broadcast, sendError, store, log } = ctx;

  const load = () => {
    const data = store.read(FILE, null);
    if (!Array.isArray(data?.widgets)) {
      const defaults = defaultWidgets();
      store.write(FILE, { widgets: defaults });
      return defaults;
    }
    return data.widgets;
  };
  load(); // crée data/widgets.json avec les valeurs par défaut s'il est absent

  const knownHosts = () => {
    const set = new Set(ctx.hosts.labels ? ctx.hosts.labels() : []);
    // Une machine retirée de la flotte (ex. « local » / Mini PC) ne doit pas verrouiller toute la barre :
    // on continue d'accepter les hôtes déjà présents dans la configuration enregistrée. Le lancement affiche
    // ensuite « machine non connectée », et l'éditeur permet de réaffecter le widget.
    for (const w of load()) if (w?.action?.host) set.add(w.action.host);
    return set;
  };

  // Migration à la lecture : un widget dont l'hôte n'existe plus (Mini PC retiré) est ignoré, sans toucher au fichier.
  const dropDeadHosts = (widgets) => {
    const live = new Set(ctx.hosts.labels ? ctx.hosts.labels() : []);
    if (!live.size) return widgets;
    return widgets.filter((w) => !w?.action?.host || live.has(w.action.host));
  };

  const summary = (widgets) => {
    const all = dropDeadHosts(widgets).slice().sort((a, b) => a.order - b.order);
    return { widgets: all.filter((w) => !w.hidden), all };
  };

  onMessage("widgets.list", (ws) => {
    send(ws, { type: "widgets.list", ...summary(load()) });
  });

  onMessage("widgets.save", (ws, m) => {
    if (!Array.isArray(m.widgets)) return sendError(ws, "widgets doit être une liste");
    if (m.widgets.length > MAX_WIDGETS) return sendError(ws, `maximum ${MAX_WIDGETS} widgets`);
    const hosts = knownHosts();
    const cleaned = [];
    const ids = new Set();
    for (const w of m.widgets) {
      const result = cleanWidget(w, hosts.size > 0 ? hosts : null);
      if (result.error) return sendError(ws, result.error);
      if (ids.has(result.id)) return sendError(ws, `id de widget dupliqué : ${result.id}`);
      ids.add(result.id);
      cleaned.push(result);
    }
    store.write(FILE, { widgets: cleaned });
    log("widgets", `${cleaned.length} widget(s) enregistrés`);
    send(ws, { type: "widgets.saved", count: cleaned.length });
    broadcast({ type: "widgets.changed", ...summary(cleaned) });
  });

  onMessage("widgets.reset", (ws) => {
    const defaults = defaultWidgets();
    store.write(FILE, { widgets: defaults });
    log("widgets", "remis aux valeurs par défaut");
    send(ws, { type: "widgets.saved", count: defaults.length });
    broadcast({ type: "widgets.changed", ...summary(defaults) });
  });
}
