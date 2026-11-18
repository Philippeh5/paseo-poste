// Vue « Connexions » : tout brancher depuis un seul écran — machines (en tête), agents de code, fournisseurs de modèles, applications —
// avec détection de ce qui est déjà installé/connecté, boutons d'installation, saisie de clé d'API (jamais réaffichée)
// et dossier de skills partagé entre agents. Données : handlers/connections.mjs. Textes via el() : aucun innerHTML dynamique.
import { registerView } from "./registry.js";
import { el } from "../core/util.js";
import { send, on, onConnection } from "../core/socket.js";
import { confirmDialog } from "../core/confirm.js";
import { toast } from "../core/toast.js";
import { providerWindows, onQuotaChange } from "../components/quota.js";
import { modelsSection, mountModels } from "../components/modeles.js";
import { mountMachines } from "../components/machines.js";

const ICON = '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v4M13 4v4M5 8h10v3a5 5 0 0 1-10 0V8zM10 16v2"/></svg>';
const STATUS = { connected: ["Connecté", "is-ok"], installed: ["Non connecté", "is-run"], missing: ["Absent", "is-fail"] };
let machinesEl = null; let root; let offs = []; let qs = null; let tg = null; let st = null; let cs = null; const draft = new Map(); let busyId = null; let poll = null; const lastMsg = new Map();

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Commande copiée"); } catch { toast(text); }
}

// Quels fournisseurs de quota (handlers/quota.mjs) correspondent à quelle ligne du catalogue.
const QUOTA_OF = { claude: ["claude", "claude2"], codex: ["codex"], pi: ["pi"], openrouter: ["claude-openrouter"], nvidia: ["claude-nvidia"] };
const quotaFor = (id) => (qs && QUOTA_OF[id] ? qs.providers.filter((p) => QUOTA_OF[id].some((q) => p.id === q || p.id.startsWith(`${q}/`))) : []);

function loginButton(item, label, primary) {
  return el("button", { class: `btn btn-sm${primary ? " btn-primary" : ""}`, type: "button", disabled: busyId === item.id, onclick: async () => {
    if (!(await confirmDialog({ title: `${label} : ${item.label}`, message: "Un terminal s'ouvre sur le Bureau avec la commande de connexion ; terminez la connexion dedans.", confirmLabel: label }))) return;
    busyId = item.id; render(); send({ type: "connections.login", id: item.id, confirm: true });
  } }, busyId === item.id ? "Ouverture…" : label);
}

// Une seule action principale par ligne : Installer, Se connecter, ou Reconnecter une fois connecté.
function actions(item) {
  const connected = item.status === "connected";
  if (item.kind === "key") {
    return [el("button", { class: `btn btn-sm${connected ? "" : " btn-primary"}`, type: "button", onclick: async () => {
      const value = window.prompt(`Clé ${item.envVar}${item.keyUrl ? ` (à créer sur ${item.keyUrl})` : ""} :`);
      if (value && await confirmDialog({ title: "Enregistrer cette clé ?", message: "Stockée en 600 sur le serveur, jamais réaffichée.", confirmLabel: "Enregistrer" })) {
        send({ type: "connections.setKey", id: item.id, value, confirm: true });
      } } }, connected ? "Reconnecter" : "Se connecter")];
  }
  if (item.status === "missing") {
    return item.installable ? [el("button", { class: "btn btn-sm btn-primary", type: "button", disabled: busyId === item.id, onclick: async () => {
      if (await confirmDialog({ title: `Installer ${item.label} ?`, message: "Commande npm globale fixe, exécutée sur cette machine.", confirmLabel: "Installer" })) {
        busyId = item.id; render(); send({ type: "connections.install", id: item.id, confirm: true });
      } } }, busyId === item.id ? "Installation…" : "Installer")] : [];
  }
  if (!item.login) return [];
  return [loginButton(item, connected ? "Reconnecter" : "Se connecter", !connected)];
}

function row(item) {
  const [label, cls] = STATUS[item.status] || STATUS.missing;
  const msg = lastMsg.get(item.id);
  const prov = quotaFor(item.id);
  const manual = item.status === "missing" && !item.installable && item.hint ? `Installation manuelle : ${item.hint}` : null;
  return el("li", { class: "pilot-row" },
    el("span", { class: `pilot-run-status ${cls}` }, label),
    el("div", { class: "pilot-main" }, el("strong", {}, item.label), el("span", { class: "pilot-detail" }, `${item.desc} — ${manual ?? item.detail}`),
      prov.map((p) => providerWindows(p)),
      msg ? el("pre", { class: "pilot-log" }, msg) : null),
    el("div", { class: "pilot-actions" }, actions(item)));
}

function skillsSection() {
  const s = st.skills;
  return el("section", { class: "pilot-group" },
    el("header", { class: "pilot-group-head" }, el("h2", {}, "Skills partagés entre agents"),
      el("div", { class: "pilot-group-actions" },
        el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: async () => {
          if (await confirmDialog({ title: "Relier les skills partagés ?", message: "Crée des liens symboliques dans le dossier de chaque agent. Aucun skill existant n'est écrasé.", confirmLabel: "Relier" }))
            send({ type: "connections.skills.link", confirm: true }); } }, "Relier à tous les agents"))),
    el("p", { class: "pilot-help", style: "padding:10px 14px 0" }, `Déposez un skill (dossier avec SKILL.md) dans ${s.sharedDir} : tous les agents le voient. ${s.shared.length} skill(s) partagé(s).`),
    el("ul", { class: "pilot-list" }, s.targets.map((t) => el("li", { class: "pilot-row" },
      el("span", { class: `pilot-run-status ${t.missing ? "is-run" : "is-ok"}` }, t.missing ? `${t.missing} à relier` : "À jour"),
      el("div", { class: "pilot-main" }, el("strong", {}, t.label), el("span", { class: "pilot-detail" }, `${t.dir} — ${t.linked}/${s.shared.length} relié(s)`)),
      el("div", { class: "pilot-actions" }, t.missing ? el("button", { class: "btn btn-sm", type: "button", onclick: () => send({ type: "connections.skills.link", target: t.id, confirm: true }) }, "Relier") : null)))));
}

function summarySection() {
  const tgLine = !tg ? "Telegram : chargement…" : tg.running ? "Bot Telegram du poste : en marche" : "Bot Telegram du poste : arrêté ou silencieux (le bot Hermes est un autre bot)";
  return el("section", { class: "pilot-group" }, el("header", { class: "pilot-group-head" }, el("h2", {}, "Résumé")),
    el("ul", { class: "pilot-list" },
      el("li", { class: "pilot-row", style: "grid-template-columns:auto 1fr auto" }, el("span", { class: `pilot-run-status ${tg?.running ? "is-ok" : "is-fail"}` }, "Telegram"), el("span", { class: "pilot-detail" }, tgLine), el("button", { class: "btn btn-sm", type: "button", onclick: () => { window.location.hash = "#services"; } }, "Voir"))));
}

const KNOWN_AGENTS = ["claude", "codex", "gemini", "opencode", "pi", "hermes", "freebuff"];
function agentRow(a) {
  const d = draft.get(a.name) || { toolkits: new Set(a.toolkits), writes: a.writes };
  draft.set(a.name, d);
  const apps = [...new Set([...cs.accounts.map((x) => x.toolkit), ...a.toolkits.filter((t) => t !== "*")])];
  const dirty = d.writes !== a.writes || [...d.toolkits].sort().join() !== [...a.toolkits].sort().join();
  const boxes = a.toolkits.includes("*") ? [el("span", { class: "pilot-detail" }, "Toutes les applications (réglé à la main dans le fichier)")]
    : apps.map((t) => el("label", { class: "pilot-field is-check" }, el("input", { type: "checkbox", checked: d.toolkits.has(t),
      onchange: (e) => { e.target.checked ? d.toolkits.add(t) : d.toolkits.delete(t); render(); } }), t));
  return el("li", { class: "pilot-row", style: "grid-template-columns:90px 1fr auto" },
    el("strong", {}, a.name === "*" ? "Tous les autres" : a.name),
    el("div", { class: "pilot-main" }, el("div", { style: "display:flex;flex-wrap:wrap;gap:4px 14px" }, boxes),
      el("label", { class: "pilot-field is-check" }, el("input", { type: "checkbox", checked: d.writes, disabled: a.toolkits.includes("*"), onchange: (e) => { d.writes = e.target.checked; render(); } }),
        "Peut écrire (envoyer, créer, modifier — avec confirmation à chaque action)")),
    el("div", { class: "pilot-actions" },
      el("button", { class: "btn btn-sm btn-primary", type: "button", disabled: !dirty, onclick: async () => {
        if (await confirmDialog({ title: `Accès de « ${a.name} »`, message: `${[...d.toolkits].join(", ") || "aucune application"} · ${d.writes ? "lecture et écriture" : "lecture seule"}`, confirmLabel: "Enregistrer" })) {
          draft.delete(a.name); send({ type: "composio.setAgent", agent: a.name, toolkits: [...d.toolkits], writes: d.writes, confirm: true }); } } }, "Enregistrer"),
      a.name === "*" ? null : el("button", { class: "btn btn-sm", type: "button", onclick: () => { draft.delete(a.name); send({ type: "composio.removeAgent", agent: a.name, confirm: true }); } }, "Retirer")));
}
function composioSection() {
  if (!cs) return el("section", { class: "pilot-group" }, el("header", { class: "pilot-group-head" }, el("h2", {}, "Composio : qui a accès à quoi")), el("p", { class: "pilot-empty", style: "padding:10px 14px" }, "Chargement…"));
  const head = el("header", { class: "pilot-group-head" }, el("h2", {}, "Composio : qui a accès à quoi"),
    el("span", { class: "pilot-sub" }, cs.error ? cs.error : `${cs.accounts.length} application(s) connectée(s)`));
  const chips = el("p", { class: "pilot-help", style: "padding:10px 14px 0" }, cs.accounts.length
    ? `Comptes connectés : ${cs.accounts.map((a) => `${a.toolkit} (${a.active}/${a.count})`).join(", ")}. Un agent ne choisit jamais son compte ; connecter de nouveaux comptes se fait avec « composio link ».`
    : "Aucun compte connecté (ou CLI non connecté : composio login).");
  if (!cs.policy.exists) return el("section", { class: "pilot-group" }, head, chips,
    el("div", { class: "pilot-row", style: "grid-template-columns:1fr auto" }, el("div", { class: "pilot-main" }, el("strong", {}, "Aucune politique active"),
      el("span", { class: "pilot-detail" }, "Sans politique, tous les agents sont refusés. Créer la politique « tout refusé » vous laisse ensuite accorder chaque accès ici.")),
    el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: () => send({ type: "composio.ensurePolicy", confirm: true }) }, "Créer la politique")));
  const addable = KNOWN_AGENTS.filter((n) => !cs.policy.agents.some((a) => a.name === n));
  const add = addable.length ? el("div", { class: "pilot-row", style: "grid-template-columns:1fr auto" }, el("span", { class: "pilot-detail" }, "Donner une règle à un agent (rien n'est accordé tant que vous ne cochez pas)"),
    el("select", { "aria-label": "Ajouter un agent", onchange: (e) => { if (e.target.value) send({ type: "composio.setAgent", agent: e.target.value, toolkits: [], writes: false, confirm: true }); } },
      el("option", { value: "" }, "Ajouter un agent…"), addable.map((n) => el("option", { value: n }, n)))) : null;
  return el("section", { class: "pilot-group" }, head, chips, el("ul", { class: "pilot-list" }, cs.policy.agents.map(agentRow), add));
}

function render() {
  if (!root) return;
  const host = root.firstChild;
  const refresh = el("button", { class: "btn btn-sm", type: "button", onclick: () => send({ type: "connections.get" }) }, "Actualiser");
  if (!st) { host.replaceChildren(el("header", { class: "pilot-head" }, el("h1", {}, "Connexions")), machinesEl, el("p", { class: "pilot-empty" }, "Détection en cours…")); return; }
  const done = st.items.filter((i) => i.status === "connected").length;
  host.replaceChildren(
    el("header", { class: "pilot-head" }, el("h1", {}, "Connexions"),
      el("span", { class: "pilot-summary" }, `${done} / ${st.items.length} connecté(s) sur cette machine`), refresh),
    machinesEl, // machines : état, version, agents, ajout (components/machines.js) ; élément persistant, il se met à jour seul
    summarySection(),
    ...st.groups.map((g) => el("section", { class: "pilot-group" },
      el("header", { class: "pilot-group-head" }, el("h2", {}, g.label)),
      el("ul", { class: "pilot-list" }, st.items.filter((i) => i.group === g.id).map(row)))),
    modelsSection(), composioSection(), skillsSection());
}

const view = {
  id: "connexions", title: "Connexions", short: "Connexions", icon: ICON, order: 17, rail: "none",
  mount(container, ctx) {
    root = container;
    machinesEl = el("div", { class: "machines-block" });
    offs.push(mountMachines(machinesEl));
    root.replaceChildren(el("div", { class: "pilot" }));
    render();
    offs.push(on("connections.state", (m) => { st = m; render(); }));
    offs.push(on("quota.state", (m) => { qs = m; render(); }));
    offs.push(on("telegram.status", (m) => { tg = m; render(); }));
    offs.push(on("composio.state", (m) => { cs = m; render(); }));
    offs.push(mountModels(render));
    offs.push(onQuotaChange(() => { if (qs !== null) render(); }));
    offs.push(on("connections.loginStarted", (m) => {
      busyId = null;
      ctx.desk.openTerminal(m.host, m.terminalId, { cwd: m.cwd });
      toast("Terminal ouvert sur le Bureau : terminez la connexion dedans.");
      // La ligne passe à « Connecté » toute seule : on relit l'état toutes les 4 s pendant 3 minutes.
      clearInterval(poll); let n = 0;
      poll = setInterval(() => { if (++n > 45) clearInterval(poll); else send({ type: "connections.get" }); }, 4000);
      ctx.navigate("bureau");
    }));
    offs.push(on("error", () => { if (busyId) { busyId = null; render(); } }));
    offs.push(on("connections.done", (m) => {
      busyId = null;
      if (m.action === "install") lastMsg.set(m.id, `${m.ok ? "✔" : "✖"} ${m.message}`);
      toast(m.ok ? m.message.split("\n")[0].slice(0, 120) : `Échec : ${m.message.slice(0, 160)}`);
      render();
    }));
    offs.push(onConnection((up) => { if (up) { send({ type: "connections.get" }); send({ type: "composio.get" }); } }));
    send({ type: "connections.get" }); send({ type: "composio.get" }); send({ type: "quota.get" }); send({ type: "telegram.status" });
  },
  unmount() { for (const off of offs) off(); offs = []; root = null; clearInterval(poll); },
};

registerView(view);
export default view;
