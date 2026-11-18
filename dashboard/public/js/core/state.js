// État de la flotte reçu du serveur, plus des extensions locales (ex. followedProjects).
import { on } from "./socket.js";

const EMPTY = { hosts: [], workspaces: [], agents: [], terminals: [], usage: {} };
let payload = EMPTY;
let extras = {};
let current = EMPTY;
let ready = false;
const listeners = new Set();

function rebuild() {
  current = { ...payload, ...extras };
  for (const fn of listeners) fn(current);
}

on("state", (message) => {
  payload = { ...EMPTY, ...message.payload };
  ready = true;
  rebuild();
});

export const getState = () => current;
export const isReady = () => ready;
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
// Une autre équipe peut poser ici des données qui survivent aux mises à jour du serveur.
export function setStateExtra(key, value) {
  extras = { ...extras, [key]: value };
  rebuild();
}

const normDir = (d) => String(d || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
export const sameDir = (a, b) => Boolean(a && b) && normDir(a) === normDir(b);
const insideDir = (child, dir) => Boolean(child && dir) && `${normDir(child)}/`.startsWith(`${normDir(dir)}/`);

// Racines des projets par machine (mêmes valeurs que le lanceur de widgets). Sert à distinguer un vrai
// dossier de projet des espaces de travail parasites créés par les outils : dossier personnel, racine des
// projets elle-même, arbres de travail Paseo, dossiers temporaires, node_modules…
export const PROJECT_ROOTS = ["/home/USERNAME/Projets", "D:\\Projets", "D:/Projets"];
const parentDir = (dir) => {
  const n = normDir(dir);
  const i = n.lastIndexOf("/");
  return i > 0 ? n.slice(0, i) : "";
};
export function isProjectFolder(dir) {
  const n = normDir(dir);
  if (!n) return false;
  if (n.includes("/.paseo/worktrees/") || n.includes("/node_modules/")) return false;
  if (n.startsWith("/tmp/") || n.includes("/scratchpad/")) return false;
  // Un projet = un dossier DIRECTEMENT sous une racine de projets. Cela écarte /home/USERNAME, /home/USERNAME/Projets,
  // les sous-dossiers de test et les worktrees, tout en gardant les projets suivis (traités à part).
  return PROJECT_ROOTS.some((root) => parentDir(n) === normDir(root));
}

// Un dossier = un projet (par machine). Nom = nom du dossier.
// Les projets SUIVIS (state.followedProjects) sont inclus : sans ca, un projet sans session ouverte
// n'apparaissait nulle part (pas dans les favoris du tableau de bord, pas dans le lanceur).
export function allProjects(state) {
  const byKey = new Map();
  for (const w of state.workspaces || []) {
    if (!w.directory || !isProjectFolder(w.directory)) continue;
    const key = `${w.host}|${normDir(w.directory)}`;
    if (!byKey.has(key)) byKey.set(key, { host: w.host, directory: w.directory, name: w.name, workspaceIds: [] });
    byKey.get(key).workspaceIds.push(w.workspaceId);
  }
  for (const f of state.followedProjects || []) {
    if (!f.directory) continue;
    const host = f.host || defaultHost();
    const key = `${host}|${normDir(f.directory)}`;
    if (byKey.has(key)) {
      // Le nom choisi par Philippe gagne sur celui devine par le daemon.
      if (f.name) byKey.get(key).name = f.name;
      continue;
    }
    byKey.set(key, { host, directory: f.directory, name: f.name, workspaceIds: [] });
  }
  return [...byKey.values()].sort((p, q) => p.host.localeCompare(q.host) || p.name.localeCompare(q.name));
}

// Un projet présent sur Oracle ET sur le Mini PC (même nom) n'est montré qu'une fois : sur Oracle. L'ordre reçu (favoris d'abord) est conservé.
export function dedupeProjects(projects) {
  const key = (p) => String(p.name ?? "").trim().toLowerCase();
  const onOracle = new Set(projects.filter((p) => p.host === "oracle").map(key));
  return projects.filter((p) => p.host === "oracle" || !onOracle.has(key(p)));
}

// Projets suivis : state.followedProjects (liste de { host?, directory } ou de chemins) s'il existe, sinon tous.
// « Afficher tous les projets » (state.showAllProjects) garde les projets suivis en tête puis ajoute les autres
// vrais dossiers de projet : avant, ce mode repartait des seuls workspaces du daemon et faisait donc disparaître
// les projets suivis sans session ouverte (AI-OS, VentureOS…).
export function followedProjects(state) {
  const all = allProjects(state);
  const followed = Array.isArray(state.followedProjects) ? state.followedProjects : null;
  const showAll = state.showAllProjects === true;
  const wanted = (followed || []).map((f) => (typeof f === "string" ? { directory: f } : f)).map((f) => {
    const found = all.find((p) => sameDir(f.directory, p.directory) && (!f.host || f.host === p.host));
    if (found) return f.name ? { ...found, name: f.name } : found;
    return f.host && f.directory
      ? { host: f.host, directory: f.directory, name: f.name || String(f.directory).split(/[\\/]/).filter(Boolean).pop(), workspaceIds: [] }
      : null;
  }).filter(Boolean);
  if (!wanted.length) return { projects: dedupeProjects(all), filtered: false };
  if (!showAll) return { projects: dedupeProjects(wanted), filtered: true };
  const isWanted = (p) => wanted.some((w) => w.host === p.host && sameDir(w.directory, p.directory));
  const rest = all.filter((p) => !isWanted(p)).sort((a, b) => a.name.localeCompare(b.name));
  return { projects: dedupeProjects([...wanted, ...rest]), filtered: false };
}

export function agentsOfProject(state, project) {
  return (state.agents || []).filter((a) => {
    if (a.host !== project.host) return false;
    return project.workspaceIds.includes(a.workspaceId) || insideDir(a.cwd, project.directory);
  });
}
export function terminalsOfProject(state, project) {
  return (state.terminals || []).filter((t) => {
    if (t.host !== project.host) return false;
    return project.workspaceIds.includes(t.workspaceId) || sameDir(t.cwd, project.directory);
  });
}

export const findAgent = (state, host, agentId) =>
  (state.agents || []).find((a) => a.host === host && a.agentId === agentId);
export const findTerminal = (state, host, terminalId) =>
  (state.terminals || []).find((t) => t.host === host && t.terminalId === terminalId);
// Machine par défaut côté interface : la première machine connectée (sinon la première configurée, sinon Oracle).
export const defaultHost = (state = current) => {
  const hosts = state?.hosts || [];
  return (hosts.find((h) => h.status === "connected") || hosts[0])?.label || "oracle";
};
export const findHost = (state, label) => (state.hosts || []).find((h) => h.label === label);
export const pendingAgents = (state) => (state.agents || []).filter((a) => a.status === "waiting-permission");
