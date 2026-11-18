// Section « Équipe » de la vue Agent (T36) : qui travaille sur quoi en direct, fichiers réservés, rôles, messages.
// Données : handlers/coord.mjs (diffusion coord.board). Tous les textes (statuts, noms, messages envoyés par les sessions)
// passent par el() donc par des nœuds texte : aucun innerHTML, aucun lien, aucun HTML interprété.
import { el, led } from "../core/util.js";
import { on, send, onConnection } from "../core/socket.js";
import { relativeTime } from "./agentactivity.js";
import { hostLabel } from "../core/names.js";
import { dedupeProjects, defaultHost } from "../core/state.js";

const ROLE_LABEL = { writer: "Rédacteur", reader: "Lecture seule", planner: "Planificateur" };
const ROLE_TITLE = {
  writer: "Peut modifier les fichiers qu'elle réserve",
  reader: "Le poste refuse toute modification de fichier",
  planner: "Écrit seulement dans le dossier de notes",
};

let boards = [];
const listeners = new Set();
const notify = () => { for (const fn of listeners) { try { fn(boards); } catch { /* ignoré */ } } };
const list = (v) => (Array.isArray(v) ? v : []);

// Messages non lus par groupe : « vu jusqu'à » est gardé dans ce navigateur seulement (aucune donnée sensible : une date par projet).
const SEEN_KEY = "coord.seen";
let seen = {};
try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}") || {}; } catch { seen = {}; }
const saveSeen = () => { try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch { /* stockage indisponible : les non lus se réinitialisent */ } };
on("coord.board", (m) => {
  boards = list(m.boards);
  let fresh = false;
  for (const b of boards) if (!seen[b.project.key]) { seen[b.project.key] = new Date().toISOString(); fresh = true; } // l'existant n'est pas « non lu »
  if (fresh) saveSeen();
  notify();
});
export const dirKey = (dir) => String(dir ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
export const projectNameOf = (dir) => String(dir ?? "").replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop();
export const unreadOf = (b) => {
  const s = seen[b.project.key];
  return s ? list(b.messages).filter((m) => !m.system && m.from !== "Philippe" && m.at > s).length : 0;
};
export const unreadGroups = (all = boards) => all.filter((b) => unreadOf(b) > 0).length;
export function markSeen(key, at) {
  const t = at || new Date().toISOString();
  if (!seen[key] || t > seen[key]) { seen[key] = t; saveSeen(); notify(); }
}
let projects = []; // projets suivis (menu « Parler à un projet »)
on("project.list", (m) => {
  // Mêmes projets que le rail, sur TOUTES les machines (Oracle d'abord, un seul par nom).
  projects = dedupeProjects(list(m.projects).filter((p) => p && p.dir).map((p) => ({ ...p, host: p.host || defaultHost(), name: p.name || projectNameOf(p.dir) })));
  notify();
});
const threads = new Map(); // projet → fil complet (100 derniers) demandé par « Voir toute la conversation »
const threadsByDir = new Map();
on("coord.thread", (m) => { threads.set(m.project, list(m.messages)); if (m.dir) threadsByDir.set(dirKey(m.dir), list(m.messages)); notify(); });
export const getProjects = () => projects;
export const getThread = (g) => (g.board?.project.key && threads.get(g.board.project.key)) || threadsByDir.get(dirKey(g.dir)) || null;
export const requestThread = (g) => send({ type: "coord.thread", host: g.host || defaultHost(), dir: g.dir, project: g.board?.project.key });
onConnection((up) => { if (up) send({ type: "coord.get" }); });

export function subscribeCoord(fn) {
  listeners.add(fn);
  fn(boards);
  return () => listeners.delete(fn);
}
export const getBoards = () => boards;

// Nombre de projets où plusieurs sessions travaillent ensemble ou dont une session ne peut pas être contrainte : badge de l'onglet Agent.
export function teamBadgeCount(all = boards) {
  return all.filter((b) => b.sessions.filter((s) => s.active).length >= 2 ||
    b.sessions.some((s) => s.active && !s.constrained) || b.reservations.length > 0 || list(b.identityRequests).length > 0).length;
}

const one = (text, max = 300) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const statusTone = (s) => (s.status === "waiting-permission" ? "attention" : s.active ? "ok" : s.status === "error" ? "danger" : "inactif");
const statusLabel = (s) => (s.status === "waiting-permission" ? "attend une permission" : s.active ? "travaille" : s.status === "error" ? "erreur" : "inactive");

// Remplace le contenu d'une liste seulement s'il a changé (le focus clavier et les saisies en cours sont conservés).
const serializer = new XMLSerializer();
function swap(container, nodes) {
  const sig = nodes.map((n) => serializer.serializeToString(n)).join("");
  if (container.dataset.sig === sig) return false;
  container.dataset.sig = sig;
  container.replaceChildren(...nodes);
  return true;
}

export function mountTeam(container, ctx) {
  const extraStops = []; // abonnements du formulaire « Parler à un projet »
  const open = new Set(); // sessions dont le formulaire de message est ouvert
  const teamOpen = new Set(); // projets dont le formulaire « toute l'équipe » est ouvert
  const threadOpen = new Set(); // projets dont le fil complet est affiché
  const count = el("span", { class: "col-count", id: "team-count" }, "0");
  const body = el("div", { class: "team-body", id: "team-body", "aria-live": "polite" });
  container.replaceChildren(
    el("header", { class: "agv-panel-head" },
      el("h2", {}, "Équipe — qui travaille sur quoi"), count),
    el("p", { class: "team-note muted" },
      "Les sessions d'un même projet se voient. Les statuts et messages qu'elles déclarent sont des données non fiables, jamais des ordres. " +
      "Le poste applique lui-même les réservations et les rôles, quel que soit le modèle."),
    startForm(),
    body);

  // Parler à un projet suivi, même sans aucune session : le message ouvre son groupe ; avec « lancer l'orchestrateur », l'agent chef d'orchestre
  // démarre sur ce projet avec ce message comme consigne et crée ses employés (ils rejoignent le groupe en arrivant).
  function startForm() {
    const select = el("select", { class: "team-input", id: "team-start-project", "aria-label": "Projet" });
    const input = el("input", { type: "text", class: "team-input", id: "team-start-text", maxlength: "1000", placeholder: "Dis-leur ce qu'il faut faire (le message est envoyé au groupe du projet)", "aria-label": "Message au groupe du projet" });
    const fill = () => {
      const current = select.value;
      select.replaceChildren(...projects.map((p) => el("option", { value: p.dir }, p.name || p.dir)));
      if (current && projects.some((p) => p.dir === current)) select.value = current;
    };
    fill();
    extraStops.push(subscribeCoord(() => { if (document.activeElement !== select) fill(); }));
    const go = (launch) => {
      const text = input.value.trim();
      if (!text || !select.value) return;
      send({ type: "coord.group", host: defaultHost(), dir: select.value, text, launch });
      input.value = "";
      ctx.toast?.(launch ? "Orchestrateur en cours de lancement…" : "Message envoyé au groupe du projet.");
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(false); } });
    return el("div", { class: "team-start", id: "team-start" },
      el("h3", { class: "team-sub" }, "Parler à un projet"),
      el("div", { class: "team-form" }, select, input,
        el("button", { class: "btn btn-sm", type: "button", dataset: { action: "start-send" }, onclick: () => go(false) }, "Envoyer au groupe"),
        el("button", { class: "btn btn-sm btn-primary", type: "button", dataset: { action: "start-launch" },
          title: "Lance l'orchestrateur (Mode Agent) sur ce projet avec ce message comme consigne ; il crée ses employés",
          onclick: () => go(true) }, "Lancer l'orchestrateur et son équipe")));
  }

  const releaseReservation = async (r) => {
    const okay = await ctx.confirm({
      title: "Libérer cette réservation ?",
      message: `« ${r.path} » (session « ${r.sessionLabel} ») sera de nouveau libre : une autre session pourra le modifier.`,
      confirmLabel: "Libérer",
    });
    if (okay) send({ type: "coord.release", id: r.id });
  };
  const setRole = async (s, role) => {
    const okay = await ctx.confirm({
      title: role === "reader" ? "Passer cette session en lecture seule ?" : "Redonner l'écriture à cette session ?",
      message: role === "reader"
        ? `Le poste refusera toute modification de fichier par « ${s.label} » et libérera ses réservations d'écriture.`
        : `« ${s.label} » pourra de nouveau modifier les fichiers qu'elle réserve.`,
      confirmLabel: role === "reader" ? "Passer en lecture seule" : "Redonner l'écriture",
    });
    if (okay) send({ type: "coord.role", session: s.key, role });
  };

  const setObserver = async (s, on) => {
    const okay = await ctx.confirm({
      title: on ? "Désigner cette session observateur ?" : "Retirer l'observateur ?",
      message: on
        ? `« ${s.label} » pourra lire les conversations de tous les projets, sans être réveillée par les messages. Elle ne recevra plus les messages de groupe.`
        : `« ${s.label} » ne pourra plus lire les conversations des autres projets.`,
      confirmLabel: on ? "Désigner" : "Retirer",
    });
    if (okay) send({ type: "coord.observer", session: on ? s.key : null });
  };

  // Demande d'identification (coord hello) : Philippe confirme en comparant le CODE que l'agent lui a donné.
  const decideHello = async (r, approve) => {
    const okay = approve ? await ctx.confirm({
      title: "Confirmer cette identification ?",
      message: `La session « ${one(r.sessionLabel, 60)} » (dossier ${one(r.cwd, 80)}) demande à s'appeler « ${one(r.name, 60)} ». ` +
        `Vérifiez que le code ${r.code} est bien celui que l'agent vous a donné : sinon refusez.`,
      confirmLabel: "Confirmer",
    }) : true;
    if (okay) send({ type: "coord.hello.decide", id: r.id, approve });
  };
  function helloRow(r) {
    return el("li", { class: "team-res", dataset: { hello: r.id } },
      el("div", { class: "team-res-main" },
        el("strong", { class: "mono team-res-path" }, `Code ${r.code}`),
        el("span", { class: "muted" }, `la session « ${one(r.sessionLabel, 60)} » demande à s'appeler « ${one(r.name, 60)} » · il y a ${r.minutesAgo} min`)),
      el("div", { class: "team-actions" },
        el("button", { class: "btn btn-sm btn-primary", type: "button", dataset: { action: "hello-approve" }, onclick: () => decideHello(r, true) }, "Confirmer"),
        el("button", { class: "btn btn-sm", type: "button", dataset: { action: "hello-refuse" }, onclick: () => decideHello(r, false) }, "Refuser")));
  }

  function sessionRow(s) {
    const form = open.has(s.key) ? messageForm(s) : null;
    const warn = !s.active || s.constrained ? null : el("p", { class: "team-warn", dataset: { warn: s.key } },
      `⚠ Ne peut pas être contrainte par le poste : ${one(s.constrainedWhy, 200)}. `,
      s.isolation ? `Elle travaille dans une copie de travail séparée (${one(s.isolation.reason, 140)}).`
        : "Elle écrit dans le même dossier que les autres : le poste ne peut que le signaler.");
    return el("li", { class: `team-session${s.active ? "" : " is-idle"}`, dataset: { session: s.key, role: s.role } },
      el("div", { class: "team-session-top" },
        led(statusTone(s), { pulse: s.active, label: statusLabel(s) }),
        el("strong", { class: "team-session-name" }, s.label),
        el("span", { class: `tag team-role is-${s.role}`, title: ROLE_TITLE[s.role] || "" }, ROLE_LABEL[s.role] || s.role),
        s.roleSource === "human" ? el("span", { class: "tag", title: "Rôle choisi dans l'interface" }, "choisi par vous") : null,
        s.observer ? el("span", { class: "tag", title: "Lit toutes les conversations, jamais réveillée" }, "observateur") : null,
        el("span", { class: "muted team-engine mono" }, `${one(s.engine || "moteur ?", 40)} · ${hostLabel(s.host)}`),
        s.unread ? el("span", { class: "tag tag-blocked" }, `${s.unread} non lu${s.unread > 1 ? "s" : ""}`) : null,
        el("span", { class: "muted" }, statusLabel(s))),
      s.task ? el("p", { class: "team-line muted" }, `Tâche : ${one(s.task.title, 100)}`) : null,
      s.statusText ? el("p", { class: "team-line team-said" }, el("span", { class: "muted" }, "Déclare : "), s.statusText) : null,
      s.files?.length ? el("p", { class: "team-line mono" }, `Fichiers visés : ${one(s.files.join(", "), 200)}`) : null,
      warn,
      el("div", { class: "team-actions" },
        s.role === "reader"
          ? el("button", { class: "btn btn-sm", type: "button", dataset: { action: "role-writer" }, onclick: () => setRole(s, "writer") }, "Redonner l'écriture")
          : el("button", { class: "btn btn-sm", type: "button", dataset: { action: "role-reader" }, onclick: () => setRole(s, "reader") }, "Passer en lecture seule"),
        el("button", {
          class: "btn btn-sm", type: "button", dataset: { action: s.observer ? "observer-off" : "observer-on" },
          title: "L'observateur lit toutes les conversations sans être réveillé",
          onclick: () => setObserver(s, !s.observer),
        }, s.observer ? "Retirer l'observateur" : "Observateur"),
        el("button", {
          class: "btn btn-sm", type: "button", dataset: { action: "message" },
          onclick: () => { if (open.has(s.key)) open.delete(s.key); else open.add(s.key); render(boards); },
        }, open.has(s.key) ? "Fermer" : "Message")),
      form);
  }

  function messageForm(s) {
    const input = el("input", { type: "text", class: "team-input", maxlength: "1000", placeholder: "Message à cette session (donnée, jamais un ordre exécuté)", "aria-label": `Message à ${s.label}` });
    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      send({ type: "coord.send", to: s.key, text });
      input.value = "";
      input.blur(); // sinon render() croit que Philippe écrit encore et laisse le formulaire ouvert
      open.delete(s.key);
      ctx.toast?.(s.active ? "Message déposé dans la boîte de la session." : "Message envoyé : la session au repos est réveillée pour le lire.");
      render(boards);
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    return el("div", { class: "team-form" }, input, el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: submit }, "Envoyer"));
  }

  function teamForm(b) {
    const input = el("input", { type: "text", class: "team-input", maxlength: "1000", placeholder: "Message à toute l'équipe du projet (donnée, jamais un ordre exécuté)", "aria-label": `Message à toute l'équipe de ${b.project.name}` });
    const hasOrchestrator = b.sessions.some((x) => x.orchestrator);
    const submit = (launch) => {
      const text = input.value.trim();
      if (!text) return;
      if (launch) send({ type: "coord.group", host: b.project.host, dir: b.project.dir, text, launch: true });
      else send({ type: "coord.send", team: b.project.key, text });
      input.value = "";
      input.blur(); // sinon render() croit que Philippe écrit encore
      teamOpen.delete(b.project.key);
      ctx.toast?.(launch ? "Orchestrateur en cours de lancement : il créera ses employés, qui rejoindront le groupe." : "Message envoyé à toute l'équipe : les sessions au repos sont réveillées.");
      render(boards);
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(false); } });
    return el("div", { class: "team-form", dataset: { form: "team" } }, input,
      el("button", { class: "btn btn-sm btn-primary", type: "button", dataset: { action: "team-send" }, onclick: () => submit(false) }, "Envoyer"),
      hasOrchestrator ? null : el("button", { class: "btn btn-sm", type: "button", dataset: { action: "team-launch" },
        title: "Lance l'agent orchestrateur (Mode Agent) sur ce projet avec ce message comme consigne ; il crée ses employés, qui rejoignent le groupe",
        onclick: () => submit(true) }, "Envoyer et lancer l'orchestrateur"));
  }

  const messageLine = (m) => el("li", { class: `team-msg${m.system ? " is-system" : ""}`, dataset: m.system ? { system: "1" } : {} },
    ...(m.system ? [el("span", { class: "muted" }, `${m.at ? relativeTime(m.at) : ""} · ${m.text}`)]
      : [el("span", { class: "muted" }, `${m.from} → ${m.to} · ${m.at ? relativeTime(m.at) : ""} · ${m.read ? "lu" : "non lu"} : `), m.text]));

  function reservationRow(r) {
    return el("li", { class: "team-res", dataset: { reservation: r.id } },
      el("div", { class: "team-res-main" },
        el("strong", { class: "mono team-res-path" }, r.path),
        el("span", { class: "muted" }, `${r.mode === "write" ? "écriture" : "lecture"} · ${r.sessionLabel}${r.task ? ` · tâche ${one(r.task, 60)}` : ""} · depuis ${r.sinceText} · expire dans ${r.minutesLeft} min${r.auto ? " · automatique" : ""}`)),
      el("button", { class: "btn btn-sm", type: "button", dataset: { action: "release" }, onclick: () => releaseReservation(r) }, "Libérer"));
  }

  function projectCard(b) {
    const active = b.sessions.filter((s) => s.active).length;
    const toggle = el("input", { type: "checkbox", dataset: { action: "board-toggle" }, checked: b.project.boardEnabled });
    toggle.addEventListener("change", () => send({ type: "coord.setting", project: b.project.key, boardEnabled: toggle.checked }));
    return el("section", { class: "team-project", dataset: { project: b.project.name } },
      el("header", { class: "team-project-head" },
        el("h3", {}, b.project.name),
        el("span", { class: "muted" }, `${hostLabel(b.project.host)} · ${active} session${active > 1 ? "s" : ""} active${active > 1 ? "s" : ""} · ${b.reservations.length} réservation${b.reservations.length > 1 ? "s" : ""}`),
        el("label", { class: "check team-toggle", title: "Écrit PASEO-BOARD.md dans le dossier du projet quand au moins deux sessions travaillent ensemble (jamais versionné)" }, toggle, " Tableau PASEO-BOARD.md")),
      el("ul", { class: "team-list" }, ...(b.sessions.length ? b.sessions.map(sessionRow) : [el("li", { class: "agv-none" }, "Aucune session.")])),
      list(b.identityRequests).length ? el("div", { class: "team-hello" },
        el("h4", { class: "team-sub" }, "Demandes d'identification"),
        el("p", { class: "team-note muted" }, "Une session sans identité injectée demande à s'identifier : confirmez seulement si le code correspond à celui que l'agent vous a donné."),
        el("ul", { class: "team-list" }, ...b.identityRequests.map(helloRow))) : null,
      el("h4", { class: "team-sub" }, "Fichiers réservés"),
      el("ul", { class: "team-list" }, ...(b.reservations.length ? b.reservations.map(reservationRow) : [el("li", { class: "agv-none" }, "Aucune réservation.")])),
      b.observed?.files?.length ? el("div", { class: "team-observed" },
        el("h4", { class: "team-sub" }, "Fichiers réellement modifiés (git)"),
        el("ul", { class: "team-files" }, ...b.observed.files.slice(0, 20).map((f) => el("li", {},
          el("span", { class: "mono" }, f.path),
          f.reservedBy ? el("span", { class: "muted" }, ` — réservé par ${f.reservedBy}`) : el("span", { class: "tag tag-blocked" }, "non réservé"))))) : null,
      el("div", { class: "team-messages", dataset: { thread: b.project.name } },
        el("h4", { class: "team-sub" }, `Conversation du projet (${threadOpen.has(b.project.key) ? "100 derniers" : "10 derniers"}, le plus récent en haut)`),
        el("div", { class: "team-actions" },
          el("button", {
            class: "btn btn-sm", type: "button", dataset: { action: "team-message" },
            onclick: () => { if (teamOpen.has(b.project.key)) teamOpen.delete(b.project.key); else teamOpen.add(b.project.key); render(boards); },
          }, teamOpen.has(b.project.key) ? "Fermer" : "Écrire à toute l'équipe"),
          el("button", {
            class: "btn btn-sm", type: "button", dataset: { action: "thread-toggle" },
            onclick: () => {
              if (threadOpen.has(b.project.key)) threadOpen.delete(b.project.key);
              else { threadOpen.add(b.project.key); send({ type: "coord.thread", project: b.project.key }); }
              render(boards);
            },
          }, threadOpen.has(b.project.key) ? "Réduire" : "Voir toute la conversation")),
        teamOpen.has(b.project.key) ? teamForm(b) : null,
        el("ul", { class: "team-list" }, ...((threadOpen.has(b.project.key) && threads.get(b.project.key)) || b.messages || []).slice(threadOpen.has(b.project.key) ? -100 : -10).reverse().map(messageLine)
          .concat((b.messages || []).length || threads.get(b.project.key)?.length ? [] : [el("li", { class: "agv-none" }, "Aucun message pour l'instant.")]))));
  }

  function render(all) {
    const shown = all.filter((b) => b.sessions.length || b.reservations.length);
    count.textContent = String(shown.reduce((n, b) => n + b.sessions.filter((s) => s.active).length, 0));
    const typing = document.activeElement?.classList?.contains("team-input");
    if (typing) return; // ne pas effacer ce que Philippe est en train d'écrire
    swap(body, shown.length ? shown.map(projectCard) : [el("p", { class: "agv-none", id: "team-empty" }, "Aucune session suivie pour l'instant : l'équipe apparaît dès qu'une session travaille sur un projet.")]);
  }

  const stops = [
    subscribeCoord(render),
    on("coord.groupSent", (m) => ctx.toast?.(m.launched ? "Orchestrateur lancé." : `Message envoyé (${m.recipients} session${m.recipients > 1 ? "s" : ""}).`)),
    on("coord.released", () => ctx.toast?.("Réservation libérée.")),
    on("coord.hello.decided", (m) => ctx.toast?.(m.approved ? "Identification confirmée." : "Identification refusée.")),
    on("coord.roleChanged", (m) => ctx.toast?.(m.role === "reader" ? "Session passée en lecture seule." : "Rôle mis à jour.")),
  ];
  send({ type: "coord.get" });
  send({ type: "project.list" });
  render(boards);
  const timer = setInterval(() => render(boards), 5000);
  return () => { clearInterval(timer); stops.forEach((fn) => fn()); extraStops.forEach((fn) => fn()); };
}
