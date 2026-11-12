// Client de la coordination entre sessions (T36), partagé par tools/coord.mjs (CLI) et tools/paseo-coord-mcp.mjs (serveur MCP).
// Sans dépendance. Parle à l'API REST /api/v1/coord/* du poste de commande.
// Identité d'une session (jamais d'un autre) : variables d'environnement INJECTÉES PAR LE POSTE au lancement de la session
//   PASEO_COORD_URL (défaut POSTECTL_URL puis http://127.0.0.1:7070), PASEO_SESSION_ID ("hôte:identifiant"), PASEO_COORD_TOKEN ;
//   à défaut : PASEO_AGENT_ID (posé par le daemon Paseo) + `hello` (le poste recoupe dossier de travail + horodatage et remet un jeton).
// Mot de passe du poste, s'il y en a un : POSTECTL_PASSWORD (utilisateur admin) — jamais écrit sur le disque.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class CoordError extends Error {
  constructor(message, code = "error", status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const homeDir = (env = process.env) => env.PASEO_COORD_HOME || join(homedir(), ".paseo-coord");

function splitSession(value) {
  const v = String(value || "").trim();
  const i = v.indexOf(":");
  return i > 0 ? { host: v.slice(0, i), agentId: v.slice(i + 1) } : { host: "", agentId: v };
}

// Deux fichiers privés : par identifiant de session (si le harnais le fournit) et par dossier de travail (sinon).
const idFile = (env, agentId) => join(homeDir(env), `identity-${agentId ? "id" : "cwd"}-${createHash("sha1").update(agentId ? String(agentId) : process.cwd()).digest("hex").slice(0, 16)}.json`);

// Demande d'identification en attente (coord hello) : le secret n'est connu que de ce poste de travail (même dossier de travail).
const pendingFile = (env) => join(homeDir(env), `hello-pending-${createHash("sha1").update(process.cwd()).digest("hex").slice(0, 16)}.json`);
function loadPending(env) {
  try {
    const p = JSON.parse(readFileSync(pendingFile(env), "utf8"));
    return typeof p?.requestSecret === "string" && Date.now() - Number(p.at || 0) < 15 * 60000 ? p.requestSecret : "";
  } catch { return ""; }
}
function savePending(env, requestSecret) {
  try {
    mkdirSync(homeDir(env), { recursive: true });
    const file = pendingFile(env);
    writeFileSync(file, JSON.stringify({ requestSecret, at: Date.now() }), { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* Windows */ }
  } catch { /* la demande devra être refaite */ }
}
const clearPending = (env) => { try { rmSync(pendingFile(env), { force: true }); } catch { /* absent */ } };

// → { url, host, agentId, token, password, source }
export function loadIdentity(env = process.env) {
  const url = String(env.PASEO_COORD_URL || env.POSTECTL_URL || "http://127.0.0.1:7070").replace(/\/+$/, "");
  const fromSession = splitSession(env.PASEO_SESSION_ID);
  const agentId = fromSession.agentId || String(env.PASEO_AGENT_ID || "");
  const host = String(env.PASEO_COORD_HOST || fromSession.host || "local");
  const id = { url, host, agentId, token: String(env.PASEO_COORD_TOKEN || ""), password: String(env.POSTECTL_PASSWORD || ""), source: "env" };
  if (!id.token) {
    try {
      const saved = JSON.parse(readFileSync(idFile(env, ""), "utf8"));
      if (saved?.token && saved.agentId && (!agentId || saved.agentId === agentId)) {
        return { ...id, agentId: saved.agentId, host: saved.host || host, token: saved.token, source: "hello" };
      }
    } catch { /* pas d'identité enregistrée */ }
  }
  return id;
}
export function saveIdentity(id, env = process.env) {
  try {
    mkdirSync(homeDir(env), { recursive: true });
    for (const file of [idFile(env, "")]) { // clé = dossier de travail seulement : un identifiant fourni par l'environnement ne doit jamais permettre de relire le jeton d'une autre session
      writeFileSync(file, JSON.stringify({ host: id.host, agentId: id.agentId, token: id.token }), { mode: 0o600 });
      try { chmodSync(file, 0o600); } catch { /* Windows */ }
    }
  } catch { /* le jeton reste en mémoire */ }
}

const NO_IDENTITY = "identité de session absente : ce harnais n'a pas reçu PASEO_COORD_TOKEN du poste. Appelez d'abord « coord_hello » (CLI : « coord hello <nom> ») ; le poste vous donnera un code que Philippe doit confirmer dans la vue Agent (« Équipe »), puis rappelez la même commande.";

export async function call(id, method, path, body, { identity = true, actor = "coord" } = {}) {
  const headers = { "X-Agent-Name": actor };
  if (identity) {
    if (!id.agentId || !id.token) throw new CoordError(NO_IDENTITY, "identity_required", 401);
    headers["X-Coord-Host"] = id.host;
    headers["X-Coord-Agent"] = id.agentId;
    headers["X-Coord-Token"] = id.token;
  } else if (id.agentId && id.token) {
    headers["X-Coord-Host"] = id.host;
    headers["X-Coord-Agent"] = id.agentId;
    headers["X-Coord-Token"] = id.token;
  }
  if (id.password) headers.Authorization = `Basic ${Buffer.from(`admin:${id.password}`).toString("base64")}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(`${id.url}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new CoordError(`poste injoignable (${id.url}) : ${e.cause?.code || e.message}`, "unreachable", 0);
  }
  if (response.status === 404 && id.source === "hello") {
    const gone = await response.clone().json().catch(() => null);
    if (gone?.error?.code === "unknown_session") {
      throw new CoordError("l'identité enregistrée par un ancien coord_hello ne correspond plus à une session du poste (session terminée ?) : rappelez coord_hello pour cette nouvelle session", "identity_required", 404);
    }
  }
  if (response.status === 401 && !(await response.clone().json().catch(() => null))?.error) {
    throw new CoordError("accès refusé : définissez POSTECTL_PASSWORD (mot de passe du poste)", "auth", 401);
  }
  let payload = null;
  try { payload = await response.json(); } catch { /* corps non JSON */ }
  if (!payload) throw new CoordError(`réponse inattendue du poste (HTTP ${response.status})`, "bad_response", response.status);
  if (!payload.ok) throw new CoordError(payload.error?.message || "erreur", payload.error?.code || "error", response.status);
  return payload.data;
}

const qs = (o) => { const q = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") q.set(k, String(v)); return q.size ? `?${q}` : ""; };

// Actions communes (mêmes noms côté CLI et MCP).
export function createClient(env = process.env, actor = "coord") {
  let id = loadIdentity(env);
  const c = (method, path, body, opts) => call(id, method, path, body, { actor, ...opts });
  return {
    identity: () => ({ host: id.host, agentId: id.agentId, source: id.source, hasToken: Boolean(id.token) }),
    async hello(name) {
      const requestSecret = loadPending(env);
      const d = await call({ ...id, token: "", source: "env" }, "POST", "/coord/hello",
        { name, cwd: process.cwd(), agentId: envAgentId(env) || undefined, host: id.host, ...(requestSecret ? { requestSecret } : {}) }, { identity: false, actor });
      if (d.pending) { // le poste attend la confirmation de Philippe : ni jeton ni secret ne sont renvoyés au modèle
        if (d.requestSecret) savePending(env, d.requestSecret);
        const { requestSecret: _secret, ...waiting } = d;
        return waiting;
      }
      clearPending(env);
      id = { ...id, host: d.host, agentId: d.agentId, token: d.token, source: "hello" };
      saveIdentity(id, env);
      const { token, ...rest } = d; // le jeton n'est jamais renvoyé à l'affichage
      return rest;
    },
    // Sans identité, la lecture seule reste possible : tableau du projet qui contient le dossier courant.
    who: () => (id.token && id.agentId ? c("GET", "/coord/who") : c("GET", `/coord/who${qs({ project: process.cwd() })}`, undefined, { identity: false })),
    status: (text, files) => c("POST", "/coord/status", { ...(text !== undefined ? { text } : {}), ...(files !== undefined ? { files } : {}) }),
    claim: (paths, mode, ttl) => c("POST", "/coord/claim", { paths, ...(mode ? { mode } : {}), ...(ttl !== undefined ? { ttl } : {}) }),
    release: (paths) => c("POST", "/coord/release", paths === undefined ? {} : { paths }),
    check: (path) => c("GET", `/coord/check${qs({ path })}`),
    // Message typé (T38) : opts = { kind, replyTo, mentions, needsReply, by } ; sans opts : ancienne forme, toujours valide.
    // `to` peut être omis quand replyTo est donné (réponse à l'expéditeur du message).
    send: (to, text, opts = {}) => {
      const body = { text };
      if (to !== undefined && to !== "") body.to = to;
      for (const k of ["kind", "replyTo", "mentions", "needsReply", "by"]) if (opts[k] !== undefined) body[k] = opts[k];
      return c("POST", "/coord/send", body);
    },
    inbox: () => c("GET", "/coord/inbox"),
    // Résumé roulant du projet (≤ 3 000 caractères) + fiche projet en un seul appel : à lire en arrivant.
    digest: () => c("GET", "/coord/digest"),
    threads: () => c("GET", "/coord/threads"),
    role: () => c("GET", "/coord/role"),
    // Fiche projet (T37) : lecture (donnée, ≤ 12 000 caractères) et proposition d'un ajout (le poste ou Philippe
    // l'applique).
    project: () => c("GET", "/coord/project"),
    projectPropose: (section, text, why) =>
      c("POST", "/coord/project/propose", { section, text, ...(why !== undefined ? { why } : {}) }),
  };
}

// Identifiant de session fourni par l'environnement du harnais (jamais celui d'une identité enregistrée).
function envAgentId(env) {
  return splitSession(env.PASEO_SESSION_ID).agentId || String(env.PASEO_AGENT_ID || "");
}
