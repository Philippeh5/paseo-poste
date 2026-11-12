// dashboard/lib/tguser.mjs — Couche fine et testable sur GramJS (npm « telegram » 2.x) pour le « compte assistant »
// Telegram de Philippe (son propre compte utilisateur). Les bots (Bot API) ne peuvent ni créer de groupe ni créer
// d'autres bots : ce compte fait le travail de mise en place, le dashboard n'utilisera ensuite que les tokens des bots.
//
// Fournit :
//   - chemins des secrets (TG_USER_DIR, sinon ~/.config/paseo) : tg-user.json {apiId,apiHash,phone}, tg-user.session
//     (StringSession), tg-login-pending.json (login en cours, expire en 10 min), telegram-bots.env (tokens). Tous en 600.
//   - connect()            : TelegramClient connecté depuis la session sauvegardée (erreur française sinon)
//   - loginStart/loginFinish : connexion NON interactive en deux temps (auth.SendCode puis auth.SignIn [+ 2FA])
//   - createBots()         : crée les 7 bots via @BotFather, idempotent, crash-safe (adaptateur BotFather injectable)
//   - createProjectGroup() : supergroupe forum + bots admins + photo + 4 topics + dossier de chats, rejouable
//   - archiveGroup()       : déplace le dialogue dans l'archive (folderId 1), ne supprime rien
//
// Constructeurs GramJS utilisés (telegram@2.26.22, vérifiés dans node_modules/telegram/tl/api.d.ts) :
//   login      : Api.auth.SendCode{phoneNumber,apiId,apiHash,settings:Api.CodeSettings}, Api.auth.SignIn{phoneNumber,
//                phoneCodeHash,phoneCode}, Api.account.GetPassword + computeCheck (telegram/Password.js) +
//                Api.auth.CheckPassword{password}, Api.auth.LogOut
//   bots       : client.sendMessage / client.sendFile (photo) vers @BotFather, client.getMessages (polling)
//   groupe     : Api.channels.CreateChannel{megagroup:true,forum:true,title,about}, Api.channels.InviteToChannel{channel,
//                users}, Api.channels.EditAdmin{channel,userId,adminRights:Api.ChatAdminRights,rank},
//                Api.channels.EditPhoto{channel,photo:Api.InputChatUploadedPhoto{file}} (fichier via CustomFile +
//                client.uploadFile), Api.channels.GetForumTopics, Api.channels.CreateForumTopic{channel,title}
//   dossier    : Api.messages.GetDialogFilters, Api.messages.UpdateDialogFilter{id,filter:Api.DialogFilter{id,
//                title:Api.TextWithEntities,pinnedPeers,includePeers,excludePeers}}
//   archive    : Api.folders.EditPeerFolders{folderPeers:[Api.InputFolderPeer{peer,folderId:1}]}
//
// Règle d'or : on n'affiche JAMAIS apiHash, session, code de connexion, mot de passe 2FA ni token de bot.

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, chmodSync, unlinkSync, statSync,
  mkdtempSync, rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";

// ---------------------------------------------------------------------------
// Chemins secrets (tous en 600)
// ---------------------------------------------------------------------------

/** Répertoire de configuration (TG_USER_DIR, sinon ~/.config/paseo). */
export function configDir() {
  return process.env.TG_USER_DIR ? resolve(process.env.TG_USER_DIR) : join(homedir(), ".config", "paseo");
}
const cfgPath = (name) => join(configDir(), name);

export const tgUserJsonPath = () => cfgPath("tg-user.json");        // { apiId, apiHash, phone }
export const tgSessionPath  = () => cfgPath("tg-user.session");     // StringSession GramJS
export const tgBotsEnvPath  = () => cfgPath("telegram-bots.env");   // TG_BOT_<ID>_TOKEN / _USERNAME
export const tgPendingPath  = () => cfgPath("tg-login-pending.json"); // login en cours (expire en 10 min)

/** Durée de validité du fichier de login en attente. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

/** Écrit un fichier secret en mode 600 (création avec le bon mode + chmod si le fichier existait déjà). */
export function writeSecret(p, content) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* système non POSIX */ }
}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
export const sleep = sleepReal;

// ---------------------------------------------------------------------------
// Chargement paresseux de GramJS
// ---------------------------------------------------------------------------

let _gramjs = null;
async function gramjs() {
  if (_gramjs) return _gramjs;
  try {
    const tg = await import("telegram");
    const { Logger, LogLevel } = await import("telegram/extensions/Logger.js");
    const { computeCheck } = await import("telegram/Password.js");
    const { CustomFile } = await import("telegram/client/uploads.js");
    _gramjs = { ...tg, Logger, LogLevel, computeCheck, CustomFile };
  } catch {
    throw new Error("Le paquet « telegram » (GramJS) n'est pas installé — lance : npm i telegram@2.26.22");
  }
  return _gramjs;
}

/** Fabrique un TelegramClient silencieux (aucun log GramJS) à partir d'une session texte éventuellement vide. */
export async function makeClient(apiId, apiHash, sessionStr = "") {
  const { TelegramClient, sessions, Logger, LogLevel } = await gramjs();
  return new TelegramClient(new sessions.StringSession(sessionStr || ""), Number(apiId), String(apiHash), {
    connectionRetries: 3,
    baseLogger: new Logger(LogLevel.NONE),
  });
}

/** Nom d'erreur RPC Telegram (ex. SESSION_PASSWORD_NEEDED) ou message brut. */
export function rpcName(e) {
  return String(e?.errorMessage || e?.message || e || "");
}

// ---------------------------------------------------------------------------
// connect() — session persistante
// ---------------------------------------------------------------------------

const MSG_NON_CONNECTE = "compte assistant non connecté : lance tools/tg-login.mjs";

/** Lit tg-user.json ; null si absent ou illisible. */
export function readUserConfig() {
  try { return JSON.parse(readFileSync(tgUserJsonPath(), "utf8")); } catch { return null; }
}

/**
 * Retourne un TelegramClient connecté depuis la session sauvegardée.
 * @throws Error « compte assistant non connecté : lance tools/tg-login.mjs » si absente ou invalide.
 */
export async function connect() {
  const cfg = readUserConfig();
  let sessionStr = "";
  try { sessionStr = readFileSync(tgSessionPath(), "utf8").trim(); } catch { /* absent */ }
  if (!cfg?.apiId || !cfg?.apiHash || !sessionStr) {
    throw new Error(`${MSG_NON_CONNECTE} (aucune session dans ${configDir()})`);
  }
  const client = await makeClient(cfg.apiId, cfg.apiHash, sessionStr);
  try {
    await client.connect();
    const me = await client.getMe();
    if (!me) throw new Error("getMe vide");
  } catch (e) {
    try { await client.disconnect(); } catch { /* ignore */ }
    throw new Error(`${MSG_NON_CONNECTE} (session invalide ou expirée : ${rpcName(e)})`);
  }
  return client;
}

// ---------------------------------------------------------------------------
// Login non interactif en deux temps
// ---------------------------------------------------------------------------

/**
 * Lit le fichier de login en attente.
 * @returns {{state:"none"}|{state:"expired"}|{state:"ok", pending:object}}
 */
export function readPending(now = Date.now()) {
  let pending;
  try { pending = JSON.parse(readFileSync(tgPendingPath(), "utf8")); } catch { return { state: "none" }; }
  if (!pending || typeof pending.expiresAt !== "number" || now > pending.expiresAt) return { state: "expired" };
  return { state: "ok", pending };
}

/** Supprime le fichier de login en attente. */
export function clearPending() {
  try { unlinkSync(tgPendingPath()); } catch { /* absent */ }
}

/**
 * Étape 1 : enregistre tg-user.json, envoie le code (auth.SendCode) et écrit tg-login-pending.json (600, 10 min).
 * @param {{apiId:number|string, apiHash:string, phone:string}} p
 * @param {{makeClient?:Function, now?:number}} deps  injection pour les tests
 */
export async function loginStart({ apiId, apiHash, phone }, deps = {}) {
  if (!/^\d+$/.test(String(apiId))) throw new Error("--api-id doit être un entier");
  if (!apiHash) throw new Error("--api-hash manquant");
  if (!/^\+\d{6,15}$/.test(String(phone))) throw new Error("--phone doit être au format international, ex. +33612345678");
  const { Api } = await gramjs();
  const mk = deps.makeClient || makeClient;
  const client = await mk(apiId, apiHash, "");
  try {
    await client.connect();
    const sent = await client.invoke(new Api.auth.SendCode({
      phoneNumber: phone, apiId: Number(apiId), apiHash, settings: new Api.CodeSettings({}),
    }));
    if (!sent?.phoneCodeHash) throw new Error("Telegram n'a pas renvoyé de phoneCodeHash (compte déjà connecté ?)");
    writeSecret(tgUserJsonPath(), JSON.stringify({ apiId: Number(apiId), apiHash, phone }, null, 2) + "\n");
    writeSecret(tgPendingPath(), JSON.stringify({
      phone, apiId: Number(apiId), phoneCodeHash: sent.phoneCodeHash, sessionStr: client.session.save(),
      expiresAt: (deps.now ?? Date.now()) + PENDING_TTL_MS,
    }, null, 2) + "\n");
  } finally {
    try { await client.disconnect(); } catch { /* ignore */ }
  }
}

/** Lit le mot de passe 2FA depuis --password-file ou TG_2FA_PASSWORD (jamais argv). null si aucun. */
export function readPassword({ file, env = process.env } = {}) {
  if (file) {
    let txt;
    try { txt = readFileSync(file, "utf8"); } catch { throw new Error(`fichier de mot de passe illisible : ${file}`); }
    return txt.replace(/\r?\n$/, "");
  }
  return env.TG_2FA_PASSWORD ? String(env.TG_2FA_PASSWORD) : null;
}

/**
 * Étape 2 : auth.SignIn avec le code ; si SESSION_PASSWORD_NEEDED → 2FA (account.GetPassword + computeCheck +
 * auth.CheckPassword). Écrit la session (600) et supprime le pending en cas de succès.
 * @returns {Promise<{needs2fa:true}|{me:object}>}
 */
export async function loginFinish({ code, password = null }, deps = {}) {
  const st = readPending(deps.now ?? Date.now());
  if (st.state === "none") throw new Error("aucune connexion en attente : lance d'abord l'étape 1 (--api-id … --api-hash … --phone …)");
  if (st.state === "expired") {
    clearPending();
    throw new Error("le code de connexion a expiré (> 10 min) : relance l'étape 1");
  }
  const { pending } = st;
  const cfg = readUserConfig();
  if (!cfg?.apiHash) throw new Error("tg-user.json manquant : relance l'étape 1");
  const { Api, computeCheck } = await gramjs();
  const client = await (deps.makeClient || makeClient)(pending.apiId, cfg.apiHash, pending.sessionStr);
  try {
    await client.connect();
    let auth;
    try {
      auth = await client.invoke(new Api.auth.SignIn({
        phoneNumber: pending.phone, phoneCodeHash: pending.phoneCodeHash, phoneCode: String(code),
      }));
    } catch (e) {
      const name = rpcName(e);
      if (!name.includes("SESSION_PASSWORD_NEEDED")) {
        if (name.includes("PHONE_CODE_INVALID")) throw new Error("code invalide");
        if (name.includes("PHONE_CODE_EXPIRED")) { clearPending(); throw new Error("code expiré : relance l'étape 1"); }
        throw new Error(name);
      }
      if (password == null || password === "") return { needs2fa: true };
      const pw = await client.invoke(new Api.account.GetPassword());
      const check = await computeCheck(pw, password);
      try {
        auth = await client.invoke(new Api.auth.CheckPassword({ password: check }));
      } catch (e2) {
        if (rpcName(e2).includes("PASSWORD_HASH_INVALID")) throw new Error("mot de passe 2FA incorrect");
        throw new Error(rpcName(e2));
      }
    }
    if (auth?.className === "auth.AuthorizationSignUpRequired") {
      throw new Error("ce numéro n'a pas de compte Telegram");
    }
    const me = auth?.user || (await client.getMe());
    writeSecret(tgSessionPath(), client.session.save());
    clearPending();
    return { me };
  } finally {
    try { await client.disconnect(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Noms d'utilisateur des bots
// ---------------------------------------------------------------------------

/** Minuscules ASCII sans accents, caractères [a-z0-9] seulement. « Bâtisseur » → « batisseur ». */
export function normaliseId(str) {
  return String(str).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/** Comme normaliseId mais conserve le tiret bas (utile pour le préfixe : « poste_ph »). */
export function normaliseUsernamePart(str) {
  return String(str).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9_]/gi, "").toLowerCase()
    .replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Username du bot : `<prefix>_<id>_bot` ; à la tentative n>0 un suffixe numérique est inséré AVANT « _bot »
 * (un username Telegram de bot doit se terminer par « bot ») : `<prefix>_<id>2_bot`.
 */
export function botUsername(prefix, id, attempt = 0) {
  const suffix = attempt > 0 ? String(attempt + 1) : "";
  return `${normaliseUsernamePart(prefix)}_${normaliseId(id)}${suffix}_bot`;
}

// ---------------------------------------------------------------------------
// Analyse des réponses de BotFather
// ---------------------------------------------------------------------------

const TOKEN_RE = /(\d{6,}:[A-Za-z0-9_-]{30,})/;

/**
 * Classe une réponse de BotFather.
 * @returns {{kind:"token", token:string, username:string|null}|{kind:"rate", seconds:number}|
 *           {kind:"taken"}|{kind:"invalid"}|{kind:"success"}|{kind:"other"}}
 */
export function parseBotFatherReply(text) {
  const t = String(text ?? "");
  const tok = TOKEN_RE.exec(t);
  if (tok) {
    const u = /t\.me\/([A-Za-z0-9_]+)/.exec(t);
    return { kind: "token", token: tok[1], username: u ? u[1] : null };
  }
  if (/too many attempts/i.test(t)) {
    const m = /(\d+)\s*(second|sec|minute|min|hour|heure)/i.exec(t);
    let seconds = 3600; // durée inconnue → on considère « trop long »
    if (m) {
      const n = parseInt(m[1], 10);
      seconds = /^min/i.test(m[2]) ? n * 60 : /^(hour|heure)/i.test(m[2]) ? n * 3600 : n;
    }
    return { kind: "rate", seconds };
  }
  if (/already taken|already occupied/i.test(t)) return { kind: "taken" };
  if (/username is invalid|must end in|invalid username|username.{0,20}(not|isn't).{0,20}(valid|available)/i.test(t)) {
    return { kind: "invalid" };
  }
  if (/\bsuccess\b/i.test(t)) return { kind: "success" };
  return { kind: "other" };
}

// ---------------------------------------------------------------------------
// telegram-bots.env — lecture / ajout idempotent
// ---------------------------------------------------------------------------

/** Analyse le contenu de telegram-bots.env → { vigie: {token, username, setup?}, … } (clés en minuscules). */
export function parseBotsEnv(text) {
  const out = {};
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    let m = /^TG_BOT_([A-Z0-9_]+?)_(TOKEN|USERNAME)=(.*)$/.exec(line);
    if (m) {
      const id = m[1].toLowerCase();
      out[id] ??= {};
      out[id][m[2] === "TOKEN" ? "token" : "username"] = m[3].trim();
      continue;
    }
    m = /^#\s*TG_BOT_([A-Z0-9_]+?)_SETUP=(pending|done)$/.exec(line);
    if (m) { const id = m[1].toLowerCase(); out[id] ??= {}; out[id].setup = m[2]; } // dernier marqueur gagne
  }
  return out;
}

/** Lit telegram-bots.env ({} si absent). */
export function readBots() {
  try { return parseBotsEnv(readFileSync(tgBotsEnvPath(), "utf8")); } catch { return {}; }
}

/** Usernames des bots connus, dans l'ordre de AGENTS. */
export async function readBotUsernames() {
  const { AGENTS } = await import("./tgagents.mjs");
  const bots = readBots();
  return AGENTS.map((a) => bots[a.id]?.username).filter(Boolean);
}

/** Ajoute des lignes à telegram-bots.env (600), en garantissant le saut de ligne final précédent. */
function appendBotsEnv(lines) {
  const p = tgBotsEnvPath();
  mkdirSync(dirname(p), { recursive: true });
  let prefix = "";
  try { const cur = readFileSync(p, "utf8"); if (cur && !cur.endsWith("\n")) prefix = "\n"; } catch { /* nouveau fichier */ }
  appendFileSync(p, prefix + lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* non POSIX */ }
}

// ---------------------------------------------------------------------------
// Adaptateur BotFather (réel) — le seul morceau qui parle à Telegram pour createBots
// ---------------------------------------------------------------------------

/**
 * Adaptateur réel : { send(texte), sendPhoto(fichier), recv(timeoutMs) }.
 * recv() sonde le dialogue (1,5 s entre deux lectures) et renvoie le texte des messages ENTRANTS arrivés après le
 * dernier envoi (jamais une vieille réponse), ou null après timeout (20 s par défaut).
 */
export function makeBotFatherAdapter(client, { pollMs = 1500, sleepFn = sleepReal } = {}) {
  let peer = null;
  let since = 0; // id du dernier message présent avant notre envoi
  const getPeer = async () => (peer ??= await client.getInputEntity("@BotFather"));
  const lastId = async () => {
    const m = await client.getMessages(await getPeer(), { limit: 1 });
    return m.length ? Number(m[0].id) : 0;
  };
  return {
    async send(text) {
      since = await lastId();
      await client.sendMessage(await getPeer(), { message: text });
    },
    async sendPhoto(file) {
      since = await lastId();
      await client.sendFile(await getPeer(), { file, forceDocument: false });
    },
    async recv(timeoutMs = 20_000) {
      const end = Date.now() + timeoutMs;
      do {
        await sleepFn(pollMs);
        const msgs = await client.getMessages(await getPeer(), { limit: 10 });
        const fresh = msgs.filter((m) => !m.out && Number(m.id) > since && m.message)
          .sort((a, b) => Number(a.id) - Number(b.id));
        if (fresh.length) return fresh.map((m) => m.message).join("\n");
      } while (Date.now() < end);
      return null;
    },
  };
}

/**
 * Envoie un message (ou une photo) à BotFather et renvoie sa réponse. Gère le rate-limit : « too many attempts »
 * ≤ 120 s → on attend puis on renvoie ; au-delà → erreur claire. 1,5 s de pause après chaque échange.
 */
async function ask(bf, msg, { photo = false, timeout = 20_000, pauseMs = 1500, sleepFn = sleepReal, log = console.log } = {}) {
  for (let essai = 0; essai < 4; essai++) {
    if (photo) await bf.sendPhoto(msg); else await bf.send(msg);
    const reply = await bf.recv(timeout);
    await sleepFn(pauseMs);
    const p = parseBotFatherReply(reply);
    if (p.kind !== "rate") return reply;
    if (p.seconds > 120) {
      throw new Error(`BotFather limite le débit pour ${p.seconds} s (> 120 s) : arrêt, réessaie plus tard`);
    }
    log(`[tguser] BotFather : trop de tentatives, attente de ${p.seconds + 1} s…`);
    await sleepFn((p.seconds + 1) * 1000);
  }
  throw new Error("BotFather limite toujours le débit après 3 attentes : arrêt");
}

// ---------------------------------------------------------------------------
// createBots() — création idempotente des bots via @BotFather
// ---------------------------------------------------------------------------

const MAX_USERNAME_RETRIES = 5;

/**
 * Crée les bots manquants. Idempotent : un agent déjà dans telegram-bots.env est ignoré ; si son token est présent
 * mais que la configuration (photo, description…) n'a pas été terminée, seule la configuration est reprise.
 * Le token est écrit dans le fichier dès qu'il est reçu (crash-safe).
 * @param {{client?:object, prefix?:string, dryRun?:boolean, adapter?:{send:Function,sendPhoto:Function,recv:Function},
 *   avatar?:(agent:object, outFile:string)=>Promise<void>, sleepFn?:Function, pauseMs?:number, log?:Function}} opts
 * @returns {Promise<{created:string[], skipped:string[], resumed:string[]}>}
 */
export async function createBots({
  client, prefix = "poste_ph", dryRun = false, adapter, avatar, sleepFn = sleepReal, pauseMs = 1500, log = console.log,
} = {}) {
  const { AGENTS, avatarPng } = await import("./tgagents.mjs");
  const render = avatar || avatarPng;
  const bots = readBots();
  const result = { created: [], skipped: [], resumed: [] };

  const bf = dryRun ? null : (adapter || makeBotFatherAdapter(client, { pollMs: pauseMs, sleepFn }));
  if (!dryRun && !bf) throw new Error("createBots : client ou adapter requis");
  const opt = { pauseMs, sleepFn, log };

  for (const agent of AGENTS) {
    const known = bots[agent.id];
    // Token déjà là → on ignore, sauf si une configuration était restée « pending » (panne après /newbot).
    if (known?.token && known.setup !== "pending") {
      log(`[tguser] bot ${agent.id} déjà dans telegram-bots.env — ignoré`);
      result.skipped.push(agent.id);
      continue;
    }
    const displayName = `${agent.nom} · Poste`;
    const wantedUsername = botUsername(prefix, agent.id);

    if (dryRun) {
      if (known?.token) {
        log(`[DRY-RUN] ${agent.id} : token déjà enregistré (@${known.username}), reprise de la configuration seule`);
      } else {
        log(`[DRY-RUN] ${agent.id} : /newbot → « ${displayName} » → @${wantedUsername} (repli @${botUsername(prefix, agent.id, 1)}… jusqu'à ${MAX_USERNAME_RETRIES} essais)`);
      }
      log(`[DRY-RUN]   /setuserpic (avatar PNG), /setdescription « ${agent.role} »${agent.id === "orchestrateur" ? ", /setprivacy → Disable" : ""}`);
      continue;
    }

    // Rendu de l'avatar AVANT de toucher à BotFather : s'il échoue, rien n'est créé à moitié.
    const tmpDir = mkdtempSync(join(tmpdir(), "tg-avatar-"));
    try {
      const pngFile = join(tmpDir, `${agent.id}.png`);
      await render(agent, pngFile);

      let username = known?.username;
      if (!known?.token) {
        // /newbot → nom d'affichage → username (avec repli numérique)
        let reply = await ask(bf, "/newbot", opt);
        if (!/name/i.test(reply || "")) {
          throw new Error(`BotFather n'a pas demandé de nom pour /newbot (réponse : « ${String(reply ?? "(aucune)").slice(0, 80)} »)`);
        }
        reply = await ask(bf, displayName, opt);
        let token = null;
        for (let attempt = 0; attempt <= MAX_USERNAME_RETRIES; attempt++) {
          const candidate = botUsername(prefix, agent.id, attempt);
          reply = await ask(bf, candidate, opt);
          const p = parseBotFatherReply(reply);
          if (p.kind === "token") { token = p.token; username = p.username || candidate; break; }
          if (reply == null) throw new Error(`BotFather ne répond pas (timeout) pendant la création de ${agent.id}`);
          log(`[tguser] @${candidate} refusé (${p.kind === "taken" ? "déjà pris" : p.kind === "invalid" ? "invalide" : "réponse inattendue"}) — essai ${attempt + 1}/${MAX_USERNAME_RETRIES + 1}`);
        }
        if (!token) {
          try { await bf.send("/cancel"); } catch { /* ignore */ }
          throw new Error(`impossible de créer le bot ${agent.id} : aucun username disponible après ${MAX_USERNAME_RETRIES} variantes`);
        }
        // Token sauvegardé tout de suite : une panne plus loin ne le perd pas.
        appendBotsEnv([
          `TG_BOT_${agent.id.toUpperCase()}_TOKEN=${token}`, `TG_BOT_${agent.id.toUpperCase()}_USERNAME=${username}`,
          `# TG_BOT_${agent.id.toUpperCase()}_SETUP=pending`,
        ]);
        result.created.push(agent.id);
        log(`[tguser] bot ${agent.id} créé → @${username} (token enregistré, non affiché)`);
      } else {
        result.resumed.push(agent.id);
        log(`[tguser] bot ${agent.id} : token présent, reprise de la configuration de @${username}`);
      }

      // Configuration : photo, description, (orchestrateur) confidentialité désactivée.
      const expectSuccess = (reply, step) => {
        if (parseBotFatherReply(reply).kind !== "success") {
          throw new Error(`/${step} sur @${username} : BotFather n'a pas confirmé (réponse : « ${String(reply ?? "(aucune)").slice(0, 80)} ») — relance la commande pour reprendre`);
        }
      };
      await ask(bf, "/setuserpic", opt);
      await ask(bf, `@${username}`, opt);
      expectSuccess(await ask(bf, pngFile, { ...opt, photo: true }), "setuserpic");

      await ask(bf, "/setdescription", opt);
      await ask(bf, `@${username}`, opt);
      expectSuccess(await ask(bf, agent.role, opt), "setdescription");

      if (agent.id === "orchestrateur") {
        await ask(bf, "/setprivacy", opt);
        await ask(bf, `@${username}`, opt);
        expectSuccess(await ask(bf, "Disable", opt), "setprivacy");
      }
      appendBotsEnv([`# TG_BOT_${agent.id.toUpperCase()}_SETUP=done`]);
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// createProjectGroup() — supergroupe forum + bots + photo + topics + dossier
// ---------------------------------------------------------------------------

export const TOPIC_DEFS = [
  { key: "discussion", title: "💬 Discussion" },
  { key: "fil",        title: "🧠 Fil des agents" },
  { key: "decider",    title: "✋ À décider" },
  { key: "alertes",    title: "🚨 Alertes" },
];

/** Premier Channel des `chats` d'une réponse Updates (CreateChannel). */
export function extractChannel(updates) {
  return (updates?.chats || []).find((c) => c?.className === "Channel") || null;
}

/**
 * Id du topic créé : le message de service MessageActionTopicCreate de l'UpdateNewChannelMessage (l'id du topic
 * = l'id de ce message). Repli : UpdateMessageID. Retourne null si introuvable.
 */
export function extractTopicId(updates) {
  const list = updates?.updates || (updates?.update ? [updates.update] : []);
  for (const u of list) {
    const msg = u?.message;
    if ((u?.className === "UpdateNewChannelMessage" || u?.className === "UpdateNewMessage")
        && msg?.action?.className === "MessageActionTopicCreate") {
      return Number(msg.id);
    }
  }
  const mid = list.find((u) => u?.className === "UpdateMessageID");
  return mid ? Number(mid.id) : null;
}

/** Topics d'un forum → Map titre→id (ForumTopic seulement, pas les ForumTopicDeleted). */
async function listTopics(client, Api, inputChannel) {
  const res = await client.invoke(new Api.channels.GetForumTopics({
    channel: inputChannel, offsetDate: 0, offsetId: 0, offsetTopic: 0, limit: 100,
  }));
  const map = new Map();
  for (const t of res?.topics || []) if (t?.className === "ForumTopic") map.set(t.title, Number(t.id));
  return map;
}

/** Cherche un supergroupe forum de ce titre parmi les dialogues (actifs puis archivés). */
async function findGroupEntity(client, title) {
  for (const folder of [undefined, 1]) {
    let dialogs = [];
    try { dialogs = await client.getDialogs(folder === undefined ? { limit: 300 } : { limit: 300, folder }); }
    catch { continue; }
    const hit = dialogs.map((d) => d.entity).find((e) => e?.className === "Channel" && e.title === title && e.megagroup);
    if (hit) return hit;
  }
  return null;
}

/**
 * Crée (ou retrouve) le supergroupe forum d'un projet. Rejouable : un groupe de même titre déjà complet (4 topics)
 * est renvoyé tel quel ; un groupe partiel (panne en cours de route) est complété au lieu d'être dupliqué.
 * @returns {Promise<{chatId:string, topics:{discussion:number,fil:number,decider:number,alertes:number}}>}
 */
export async function createProjectGroup({
  client, title, about = "", photoPng, bots = [], folderTitle = "Projets", log = console.log, sleepFn = sleepReal,
}) {
  const { Api, CustomFile } = await gramjs();

  let entity = await findGroupEntity(client, title);
  let isNew = false;
  let inputChannel;
  let topicMap = new Map();
  if (entity) {
    inputChannel = await client.getInputEntity(entity);
    topicMap = await listTopics(client, Api, inputChannel);
    if (TOPIC_DEFS.every((t) => topicMap.has(t.title))) {
      log(`[tguser] groupe « ${title} » déjà existant avec ses 4 topics — réutilisé`);
      return { chatId: `-100${entity.id}`, topics: Object.fromEntries(TOPIC_DEFS.map((t) => [t.key, topicMap.get(t.title)])) };
    }
    log(`[tguser] groupe « ${title} » déjà existant mais incomplet — on le complète`);
  } else {
    log(`[tguser] création du supergroupe forum « ${title} »…`);
    const res = await client.invoke(new Api.channels.CreateChannel({ megagroup: true, forum: true, title, about }));
    entity = extractChannel(res);
    isNew = true;
    if (!entity) throw new Error("CreateChannel n'a renvoyé aucun canal");
    inputChannel = await client.getInputEntity(entity);
  }
  const chatId = `-100${entity.id}`;
  const handles = bots.map((u) => String(u).replace(/^@/, ""));

  // Invitation des bots, un par un (l'échec d'un seul ne bloque pas les autres).
  for (const h of handles) {
    try {
      await client.invoke(new Api.channels.InviteToChannel({ channel: inputChannel, users: [`@${h}`] }));
    } catch (e) {
      if (!rpcName(e).includes("USER_ALREADY_PARTICIPANT")) log(`[tguser] invitation de @${h} : ${rpcName(e)}`);
    }
  }
  // Droits admin : publier/éditer/supprimer, épingler, gérer les topics, inviter ; PAS d'ajout d'admins.
  const adminRights = new Api.ChatAdminRights({
    postMessages: true, editMessages: true, deleteMessages: true, pinMessages: true, manageTopics: true, inviteUsers: true,
  });
  for (const h of handles) {
    try {
      await client.invoke(new Api.channels.EditAdmin({
        channel: inputChannel, userId: `@${h}`, adminRights, rank: "",
      }));
    } catch (e) {
      log(`[tguser] promotion admin de @${h} : ${rpcName(e)}`);
    }
  }

  // Photo du groupe
  if (photoPng && isNew) {
    try {
      const file = await client.uploadFile({
        file: new CustomFile(basename(photoPng), statSync(photoPng).size, photoPng), workers: 1,
      });
      await client.invoke(new Api.channels.EditPhoto({
        channel: inputChannel, photo: new Api.InputChatUploadedPhoto({ file }),
      }));
    } catch (e) {
      log(`[tguser] photo du groupe ignorée : ${rpcName(e)}`);
    }
  }

  // Topics, dans l'ordre ; ceux qui existent déjà sont conservés.
  const topics = {};
  for (const { key, title: tTitle } of TOPIC_DEFS) {
    if (topicMap.has(tTitle)) { topics[key] = topicMap.get(tTitle); continue; }
    const res = await client.invoke(new Api.channels.CreateForumTopic({ channel: inputChannel, title: tTitle }));
    let id = extractTopicId(res);
    if (id == null) id = (await listTopics(client, Api, inputChannel)).get(tTitle) ?? null;
    if (id == null) throw new Error(`id du topic « ${tTitle} » introuvable dans la réponse`);
    topics[key] = id;
    await sleepFn(500);
  }

  // Dossier de chats (créé s'il n'existe pas, réutilisé sinon)
  try {
    await addToFolder(client, Api, inputChannel, folderTitle);
  } catch (e) {
    log(`[tguser] ajout au dossier « ${folderTitle} » échoué : ${rpcName(e)}`);
  }
  return { chatId, topics };
}

/** Texte du titre d'un DialogFilter (TextWithEntities en 2.26, string sur d'anciennes couches). */
const filterTitle = (f) => (typeof f?.title === "string" ? f.title : f?.title?.text);

/** Ajoute le canal au dossier `folderTitle` (messages.GetDialogFilters / messages.UpdateDialogFilter). */
export async function addToFolder(client, Api, inputPeer, folderTitle) {
  const res = await client.invoke(new Api.messages.GetDialogFilters());
  const filters = Array.isArray(res) ? res : (res?.filters || []);
  const folder = filters.find((f) => f?.className === "DialogFilter" && filterTitle(f) === folderTitle);
  const chanId = String(inputPeer.channelId);
  if (folder) {
    if ((folder.includePeers || []).some((p) => String(p?.channelId) === chanId)) return "deja-present";
    await client.invoke(new Api.messages.UpdateDialogFilter({
      id: folder.id,
      filter: new Api.DialogFilter({
        contacts: folder.contacts, nonContacts: folder.nonContacts, groups: folder.groups, broadcasts: folder.broadcasts,
        bots: folder.bots, excludeMuted: folder.excludeMuted, excludeRead: folder.excludeRead,
        excludeArchived: folder.excludeArchived, titleNoanimate: folder.titleNoanimate,
        id: folder.id, title: folder.title, emoticon: folder.emoticon, color: folder.color,
        pinnedPeers: folder.pinnedPeers || [], includePeers: [...(folder.includePeers || []), inputPeer],
        excludePeers: folder.excludePeers || [],
      }),
    }));
    return "ajoute";
  }
  // Ids 0 et 1 sont réservés (tous les chats / archive) : on prend max+1, au moins 2.
  const used = filters.map((f) => f?.id).filter((n) => typeof n === "number");
  const newId = Math.max(1, ...used) + 1;
  await client.invoke(new Api.messages.UpdateDialogFilter({
    id: newId,
    filter: new Api.DialogFilter({
      id: newId, title: new Api.TextWithEntities({ text: folderTitle, entities: [] }),
      pinnedPeers: [], includePeers: [inputPeer], excludePeers: [],
    }),
  }));
  return "cree";
}

// ---------------------------------------------------------------------------
// archiveGroup() — archive (folderId 1), ne supprime rien
// ---------------------------------------------------------------------------

/**
 * Déplace le groupe `chatId` ("-100<id>") dans l'archive (folders.EditPeerFolders, folderId 1).
 * @param {string} chatId
 * @param {{client?:object}} [opts]  sans client, se connecte via connect() puis se déconnecte
 */
export async function archiveGroup(chatId, { client } = {}) {
  const own = !client;
  client ??= await connect();
  try {
    const { Api } = await gramjs();
    const wanted = String(chatId).replace(/^-100/, "");
    let entity = null;
    for (const folder of [undefined, 1]) {
      const dialogs = await client.getDialogs(folder === undefined ? { limit: 300 } : { limit: 300, folder });
      entity = dialogs.map((d) => d.entity).find((e) => e?.className === "Channel" && String(e.id) === wanted);
      if (entity) break;
    }
    if (!entity) throw new Error(`groupe ${chatId} introuvable parmi les dialogues du compte`);
    const peer = await client.getInputEntity(entity);
    await client.invoke(new Api.folders.EditPeerFolders({ folderPeers: [new Api.InputFolderPeer({ peer, folderId: 1 })] }));
  } finally {
    if (own) { try { await client.disconnect(); } catch { /* ignore */ } }
  }
}
