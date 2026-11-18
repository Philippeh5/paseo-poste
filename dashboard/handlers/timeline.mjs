// Chronologie : enregistre les épisodes de travail de chaque agent sur chaque machine.
// Messages : timeline.list {since?, until?} → { type: "timeline.list", episodes } ; diffusion timeline.changed.
// Structure d'un épisode :
//   { id, host, agentId, title, provider, model, project, start, end|null, status,
//     markers:[{t, type:"permission"|"erreur"|"reprise"|"fin", label}] }
// Source : crochet ctx.onStateChange (state complet après chaque broadcastState, toutes les 5 s au plus), plus les terminaux
// d'agents de ctx.agentsOverview (agentId « term-<id> » ; « en cours » tant que leur écran bouge).
// Un épisode ouvert porte aussi `lastSeen` (dernier instant où l'agent a été vu actif), utilisé pour le fermer
// au redémarrage du serveur.

import { randomUUID } from "node:crypto";

const FILE = "timeline";
export const MAX_EPISODES = 2000;
const FLUSH_MS = 15000; // écriture périodique de lastSeen tant qu'un épisode est ouvert
const HOST_LOST_MS = 120000; // une machine injoignable plus longtemps ferme ses épisodes ouverts

// Statuts qui indiquent qu'un agent travaille (épisode ouvert).
const ACTIVE = new Set(["running", "working", "initializing", "waiting-permission", "waiting_permission"]);
const isPermission = (status) => status === "waiting-permission" || status === "waiting_permission";

// Nom du dossier terminal d'un chemin (ex: "/a/b/c" → "c").
function folderName(directory) {
  return directory ? String(directory).replace(/[/\\]+$/, "").split(/[/\\]/).pop() || "" : "";
}

export function register(ctx) {
  const { onMessage, send, broadcast, store, log, safeError } = ctx;

  const normalize = (data) => (Array.isArray(data?.episodes) ? data.episodes.filter((e) => e && e.id && e.start) : []);
  let episodes = normalize(store.read(FILE, {}));
  const open = new Map(); // "host\0agentId" → épisode ouvert
  const lostSince = new Map(); // host → premier instant où la machine a été vue injoignable
  let lastFlush = 0;

  // Au plus MAX_EPISODES : on supprime les plus anciens épisodes terminés.
  function trim() {
    let excess = episodes.length - MAX_EPISODES;
    if (excess <= 0) return;
    episodes = episodes.filter((ep) => {
      if (excess > 0 && ep.end) {
        excess -= 1;
        return false;
      }
      return true;
    });
  }
  function save() {
    trim();
    store.write(FILE, { episodes });
    lastFlush = Date.now();
  }
  const mark = (ep, type, label, t) => ep.markers.push({ t, type, label });

  // Épisodes restés ouverts (arrêt brutal du serveur) : fin = dernier instant connu, marqueur « interrompu ».
  (function closeOrphans() {
    let changed = false;
    for (const ep of episodes) {
      if (ep.end) continue;
      ep.end = ep.lastSeen || ep.start;
      ep.status = "interrupted";
      ep.markers = [...(ep.markers || []), { t: ep.end, type: "fin", label: "Interrompu (redémarrage du serveur)" }];
      delete ep.lastSeen;
      changed = true;
    }
    if (changed || episodes.length > MAX_EPISODES) {
      save(); // save() applique aussi le plafond de MAX_EPISODES
      if (changed) log("timeline", "épisodes orphelins fermés au démarrage");
    }
  })();

  const closeEpisode = (key, ep, now, status, type, label) => {
    ep.end = now;
    ep.status = status;
    mark(ep, type, label, now);
    delete ep.lastSeen;
    open.delete(key);
  };

  // Crochet d'état : state = { hosts, agents, ... } (même format que hosts.buildState()).
  function onStateChange(state) {
    const now = new Date().toISOString();
    const nowMs = Date.now();
    const connected = new Set((state.hosts || []).filter((h) => h.status === "connected").map((h) => h.label));
    const present = new Set();
    let dirty = false;

    // Agents du daemon ET terminaux d'agents (Claude Code, FreeBuff… lancés dans un terminal : agentsoverview.mjs) ; sans ces
    // derniers, la frise restait vide alors que les agents travaillaient.
    const terminalAgents = ctx.agentsOverview?.asAgents?.() || [];
    for (const agent of [...(state.agents || []), ...terminalAgents]) {
      const key = `${agent.host}\0${agent.agentId}`;
      present.add(key);
      const active = ACTIVE.has(agent.status);
      const ep = open.get(key);
      if (active && !ep) {
        const created = {
          id: randomUUID(), host: agent.host, agentId: agent.agentId, title: agent.title || null,
          provider: agent.provider || "inconnu", model: agent.model || null, project: folderName(agent.cwd),
          start: now, end: null, status: agent.status, markers: [], lastSeen: now,
        };
        if (isPermission(agent.status)) mark(created, "permission", "Permission requise", now);
        episodes.push(created);
        open.set(key, created);
        dirty = true;
      } else if (active && ep) {
        if (ep.status !== agent.status) {
          if (isPermission(agent.status)) mark(ep, "permission", "Permission requise", now);
          else if (isPermission(ep.status)) mark(ep, "reprise", "Reprise", now);
          ep.status = agent.status;
          dirty = true;
        }
        if (!ep.title && agent.title) { ep.title = agent.title; dirty = true; }
        if (!ep.model && agent.model) { ep.model = agent.model; dirty = true; }
        ep.lastSeen = now;
      } else if (!active && ep) {
        const failed = agent.status === "error";
        if (failed) closeEpisode(key, ep, now, "error", "erreur", "Erreur");
        else closeEpisode(key, ep, now, "closed", "fin", "Terminé");
        dirty = true;
      }
    }

    // Épisodes dont l'agent a disparu : machine injoignable (on attend) ou agent supprimé (on ferme).
    for (const [key, ep] of [...open]) {
      if (present.has(key)) continue;
      if (!connected.has(ep.host)) {
        const since = lostSince.get(ep.host) ?? nowMs;
        lostSince.set(ep.host, since);
        if (nowMs - since < HOST_LOST_MS) continue;
        closeEpisode(key, ep, now, "interrupted", "fin", "Machine injoignable");
      } else {
        closeEpisode(key, ep, now, "interrupted", "fin", "Agent disparu");
      }
      dirty = true;
    }
    for (const host of connected) lostSince.delete(host);

    if (!dirty && !(open.size && nowMs - lastFlush > FLUSH_MS)) return;
    try {
      save();
      if (dirty) broadcast({ type: "timeline.changed" });
    } catch (e) {
      log("timeline", `erreur de sauvegarde : ${safeError(e)}`);
    }
  }

  onMessage("timeline.list", (ws, m) => {
    const since = m.since ? new Date(m.since).getTime() : NaN;
    const until = m.until ? new Date(m.until).getTime() : NaN;
    const list = episodes.filter((ep) => {
      const start = new Date(ep.start).getTime();
      const end = ep.end ? new Date(ep.end).getTime() : Date.now();
      return !(end < since) && !(start > until);
    });
    send(ws, { type: "timeline.list", episodes: list });
  });

  ctx.onStateChange(onStateChange);
}
