import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { randomUUID, timingSafeEqual, createHash, createHmac } from "node:crypto";
import { isIP } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { createHosts } from "./lib/hosts.mjs";
import { createStore } from "./lib/store.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const handlersDir = join(root, "handlers");
const dataDir = process.env.DASHBOARD_DATA_DIR || join(root, "data");
const bindHost = process.env.DASHBOARD_HOST || "127.0.0.1";
const port = Number(process.env.DASHBOARD_PORT || 7070);
const dashboardPassword = process.env.DASHBOARD_PASSWORD || "";
const normalizedHost = bindHost.toLowerCase();
const loopback =
  normalizedHost === "localhost" ||
  (isIP(normalizedHost) === 4 && Number(normalizedHost.split(".")[0]) === 127) ||
  ["::1", "0:0:0:0:0:0:0:1"].includes(normalizedHost) ||
  normalizedHost.startsWith("::ffff:127.");
if (!loopback && !dashboardPassword) {
  console.error("DASHBOARD_PASSWORD est obligatoire pour écouter sur une adresse non locale.");
  process.exit(1);
}

// ---------- Écouteur Tailscale (optionnel) ----------
// DASHBOARD_TAILSCALE=1 ouvre un second écouteur lié UNIQUEMENT à l'IP Tailscale (jamais 0.0.0.0), avec
// authentification obligatoire (Basic <DASHBOARD_TAILSCALE_USER> + DASHBOARD_TAILSCALE_PASSWORD[_FILE], >= 16 caractères).
// Choix explicite de Philippe (2026-10-21) : DASHBOARD_TAILSCALE_USER définit l'unique utilisateur accepté du poste de commande.
// DASHBOARD_TAILSCALE_MIN_PASSWORD abaisse le minimum (défaut 16). Sans ces variables, rien ne change.
const TS_MIN_PASSWORD = Math.max(4, Number(process.env.DASHBOARD_TAILSCALE_MIN_PASSWORD) || 16);
const AUTH_USERS = new Set([(process.env.DASHBOARD_TAILSCALE_USER || "").trim()].filter(Boolean));
const TS_MAX_FAILURES = 10;
const TS_WINDOW_MS = 60_000;
function isTailscaleIPv4(ip) {
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
}
function detectTailscaleIp() {
  const explicit = (process.env.DASHBOARD_TAILSCALE_IP || "").trim();
  if (explicit) return isTailscaleIPv4(explicit) ? { ip: explicit } : { error: "DASHBOARD_TAILSCALE_IP doit être une IPv4 Tailscale (100.64.0.0/10)" };
  // DASHBOARD_TAILSCALE_BIN impose l'exécutable (tests, installation non standard) ; sinon PATH puis emplacement Windows habituel.
  const candidates = process.env.DASHBOARD_TAILSCALE_BIN ? [process.env.DASHBOARD_TAILSCALE_BIN] : ["tailscale", "C:\\Program Files\\Tailscale\\tailscale.exe"];
  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, ["ip", "-4"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      const ip = out.split(/\r?\n/).map((l) => l.trim()).find(isTailscaleIPv4);
      if (ip) return { ip };
    } catch { /* essai suivant */ }
  }
  return { error: "IP Tailscale introuvable (commande `tailscale ip -4` indisponible ou Tailscale arrêté)" };
}
function readTailscalePassword() {
  const file = (process.env.DASHBOARD_TAILSCALE_PASSWORD_FILE || "").trim();
  if (file) {
    try { return { password: readFileSync(file, "utf8").trim() }; } catch { return { error: `DASHBOARD_TAILSCALE_PASSWORD_FILE illisible (${file})` }; }
  }
  return { password: (process.env.DASHBOARD_TAILSCALE_PASSWORD || "").trim() };
}
// Anti brute-force : échecs d'identifiants par IP source, fenêtre glissante d'une minute.
const tsFailures = new Map();
function tsPrune(now) {
  for (const [ip, list] of tsFailures) {
    const recent = list.filter((t) => now - t < TS_WINDOW_MS);
    if (recent.length) tsFailures.set(ip, recent); else tsFailures.delete(ip);
  }
}
function tsLocked(ip) {
  const now = Date.now();
  const recent = (tsFailures.get(ip) || []).filter((t) => now - t < TS_WINDOW_MS);
  if (recent.length) tsFailures.set(ip, recent); else tsFailures.delete(ip);
  return recent.length >= TS_MAX_FAILURES;
}
function tsRecordFailure(ip) {
  const now = Date.now();
  if (tsFailures.size > 1000) tsPrune(now);
  const list = tsFailures.get(ip) || [];
  list.push(now);
  tsFailures.set(ip, list);
}

// DASHBOARD_HOSTS_FILE : liste de machines alternative (tests : daemon jetable) ; par défaut hosts.json à côté de server.mjs.
const hosts = createHosts({ hostsFile: process.env.DASHBOARD_HOSTS_FILE || join(root, "hosts.json") });
const store = createStore(dataDir);
const uiSockets = new Set();
const routes = new Map();
const disconnectListeners = new Set();
// Crochets appelés avec le state complet après chaque diffusion (voir handlers/README.md).
const stateChangeListeners = new Set();
// Routes HTTP en lecture seule déclarées par les handlers (voir ctx.onHttp).
const httpRoutes = new Map();
// Préfixes HTTP tous verbes (API de contrôle) : [{ prefix, fn }] (voir ctx.onHttpPrefix).
const httpPrefixes = [];
// Adresses-capacités : [{ prefix, authorize(req, url), fn }] — acceptées SANS authentification du poste quand authorize() est vrai.
const httpCapabilities = [];

// ---------- Messages vers le navigateur ----------
function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}
function broadcast(message) {
  const raw = JSON.stringify(message);
  for (const ws of uiSockets) if (ws.readyState === WebSocket.OPEN) ws.send(raw);
}
async function broadcastState() {
  try {
    const state = await hosts.buildState();
    broadcast({ type: "state", payload: state });
    for (const fn of stateChangeListeners) { try { fn(state); } catch { /* ignoré */ } }
  } catch {
    // le prochain cycle réessaiera
  }
}
const sendError = (ws, message) => send(ws, { type: "error", message: `Erreur : ${message}` });
const log = (scope, ...args) => console.log(`[${new Date().toISOString()}] [${scope}]`, ...args);

// ---------- Registre de messages (point d'extension serveur) ----------
function onMessage(type, handler) {
  if (typeof type !== "string" || typeof handler !== "function") throw new TypeError("onMessage(type, handler)");
  if (!routes.has(type)) routes.set(type, []);
  routes.get(type).push(handler);
}
async function dispatch(ws, message) {
  if (!message || typeof message.type !== "string") return;
  for (const handler of routes.get(message.type) || []) await handler(ws, message);
}

// Exécute les handlers WebSocket de `type` pour un faux client qui collecte ses réponses (ctx.send) ; les
// diffusions (ctx.broadcast) atteignent toujours les vrais navigateurs. Renvoie { replies, error } : `error` est
// le texte du premier message `error` reçu (ou de l'exception du handler), sinon null. Lance si le type est inconnu.
async function invoke(type, payload = {}, { timeoutMs = 15000 } = {}) {
  if (!routes.has(type)) throw new Error(`message inconnu : ${type}`);
  const replies = [];
  const client = {
    _uiId: `invoke:${randomUUID()}`,
    readyState: WebSocket.OPEN,
    send: (raw) => replies.push(JSON.parse(raw)),
  };
  let timer;
  let error = null;
  try {
    await Promise.race([
      dispatch(client, { ...payload, type }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`délai dépassé (${type})`)), timeoutMs);
      }),
    ]);
  } catch (e) {
    error = hosts.safeError(e);
  } finally {
    clearTimeout(timer);
    for (const listener of disconnectListeners) { try { listener(client); } catch { /* ignoré */ } }
  }
  const refused = replies.find((r) => r.type === "error");
  return { replies, error: error ?? (refused ? String(refused.message) : null) };
}

const ctx = {
  onMessage,
  invoke,
  send,
  broadcast,
  broadcastState,
  sendError,
  log,
  dataDir,
  store,
  hosts: hosts.publicHosts,
  safeError: hosts.safeError,
  onDisconnect: (fn) => disconnectListeners.add(fn),
  onHostRemoved: hosts.onHostRemoved,
  // Crochet d'état : fn(state) appelé après chaque broadcastState (voir handlers/README.md).
  onStateChange: (fn) => stateChangeListeners.add(fn),
  // Route HTTP GET protégée par la même authentification que le reste : fn(req, res, url) (voir handlers/README.md).
  onHttp: (path, fn) => httpRoutes.set(path, fn),
  // Comme onHttp, pour tout chemin commençant par `prefix` et tous verbes : fn(req, res, url) gère méthode et corps.
  onHttpPrefix: (prefix, fn) => httpPrefixes.push({ prefix, fn }),
  // Chemin accessible par jeton signé seul (aperçu) : authorize(req, url) doit vérifier le jeton ET limiter le verbe.
  onHttpCapability: (prefix, authorize, fn) => httpCapabilities.push({ prefix, authorize, fn }),
  // Hôte visé par un message ; "local" par défaut, comme dans les versions précédentes.
  hostOf: (m) => ({ label: m.host || "local", entry: hosts.publicHosts.get(m.host || "local") }),
};

// Handlers internes de la flotte : ils passent par ce même registre.
async function loadHandlers() {
  const files = readdirSync(handlersDir).filter((f) => f.endsWith(".mjs") && !f.startsWith("_")).sort();
  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(join(handlersDir, file)).href);
      if (typeof mod.register !== "function") throw new Error("export register(ctx) manquant");
      await mod.register(ctx, { hosts });
      log("handlers", `chargé : ${file}`);
    } catch (e) {
      log("handlers", `échec de ${file} : ${hosts.safeError(e)}`);
    }
  }
}

// ---------- HTTP ----------
function authOkay(header, password = dashboardPassword) {
  if (!password) return true;
  try {
    const [scheme, encoded] = String(header || "").split(" ");
    if (scheme !== "Basic") return false;
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i < 0 || !AUTH_USERS.has(decoded.slice(0, i))) return false;
    const got = createHash("sha256").update(decoded.slice(i + 1)).digest();
    const expected = createHash("sha256").update(password).digest();
    return timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}
function isLoopbackAddress(address = "") {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}
// Hôtes acceptés : boucle locale, réseau Tailscale (100.64.0.0/10, *.ts.net) et DASHBOARD_ALLOWED_HOSTS (liste séparée par des virgules).
function hostAllowed(hostHeader = "") {
  let hostname;
  try { hostname = new URL("http://" + hostHeader).hostname.toLowerCase(); } catch { return false; }
  if (["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname) || hostname.endsWith(".ts.net")) return true;
  const m = hostname.match(/^100\.(\d+)\.\d+\.\d+$/);
  if (m && Number(m[1]) >= 64 && Number(m[1]) <= 127) return true;
  return (process.env.DASHBOARD_ALLOWED_HOSTS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).includes(hostname);
}
function originOkay(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (!hostAllowed(req.headers.host)) return false;
  try {
    const u = new URL(origin);
    return u.host === req.headers.host && ["http:", "https:"].includes(u.protocol);
  } catch {
    return false;
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
// Dossiers dont la liste des modules est publiée pour le chargement automatique côté navigateur.
const MODULE_FOLDERS = new Set(["js/views", "js/ext"]);

function moduleIndex(folder) {
  // Un dossier de modules absent (js/ext n'existe pas dans un clone neuf : git ne versionne pas les dossiers vides) = liste vide,
  // jamais une exception : elle tuait tout le poste à chaque chargement de page.
  let entries = [];
  try { entries = readdirSync(join(publicDir, folder)); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  const names = entries
    .filter((f) => f.endsWith(".js") && f !== "registry.js" && !f.startsWith("_"))
    .sort();
  return JSON.stringify(names);
}

function serveStatic(pathname, res) {
  let rel;
  try {
    rel = decodeURIComponent(pathname === "/" ? "/index.html" : pathname).slice(1);
  } catch {
    rel = "";
  }
  const folder = rel.endsWith("/index.json") ? rel.slice(0, -"/index.json".length) : null;
  if (folder && MODULE_FOLDERS.has(folder)) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(moduleIndex(folder));
    return;
  }
  const file = resolve(publicDir, rel);
  const allowed = rel && !rel.includes("\0") && file.startsWith(publicDir + sep) && MIME[extname(file)];
  const hidden = rel.split("/").some((part) => part.startsWith("."));
  try {
    if (!allowed || hidden || !statSync(file).isFile()) throw new Error("absent");
    res.writeHead(200, { "Content-Type": MIME[extname(file)], "Cache-Control": "no-cache" });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404);
    res.end("Introuvable");
  }
}

// Chaque écouteur a un `kind` et une méthode `check(req)` -> "ok" | "denied" | "locked".
// Les en-têtes X-Forwarded-* ne servent jamais à décider de la confiance : seule l'adresse du socket compte.
const mainListener = {
  kind: "main",
  check: (req) => (authOkay(req.headers.authorization) ? "ok" : "denied"),
};
// Cookie de session (Tailscale seulement) : certains navigateurs (mobile) n'envoient PAS le mot de passe Basic avec la connexion
// WebSocket, ce qui laissait la page vide (401 sur /ui). Après une authentification Basic réussie, on pose un cookie signé
// (HMAC du mot de passe, 30 jours, HttpOnly, SameSite=Strict) que /ui et les routes acceptent à la place de l'en-tête.
const TS_COOKIE = "paseo_ts";
const TS_COOKIE_TTL_S = 30 * 24 * 3600;
const tsCookieKey = (password) => createHash("sha256").update(`paseo-ts-session|${password}`).digest();
const tsSign = (password, exp) => createHmac("sha256", tsCookieKey(password)).update(String(exp)).digest("hex");
function tsCookieValid(header, password) {
  const m = /(?:^|;\s*)paseo_ts=(\d+)\.([0-9a-f]{64})/.exec(String(header || ""));
  if (!m || Number(m[1]) < Date.now() / 1000) return false;
  try {
    return timingSafeEqual(Buffer.from(m[2], "hex"), Buffer.from(tsSign(password, m[1]), "hex"));
  } catch {
    return false;
  }
}
function tsSetCookie(password) {
  const exp = Math.floor(Date.now() / 1000) + TS_COOKIE_TTL_S;
  return `${TS_COOKIE}=${exp}.${tsSign(password, exp)}; Path=/; Max-Age=${TS_COOKIE_TTL_S}; HttpOnly; SameSite=Strict`;
}
function makeTailscaleListener(password) {
  return {
    kind: "tailscale",
    check(req) {
      const ip = req.socket.remoteAddress || "?";
      if (tsLocked(ip)) return "locked";
      const header = req.headers.authorization;
      if (authOkay(header, password)) {
        req.paseoAuthenticated = true; // lu par handlers/agentapi.mjs (contrôle d'hôte local sans DASHBOARD_PASSWORD)
        req.paseoSessionCookie = tsSetCookie(password);
        return "ok";
      }
      if (!header && tsCookieValid(req.headers.cookie, password)) {
        req.paseoAuthenticated = true;
        return "ok";
      }
      // Un navigateur sans identifiants (premier appel) n'est pas une tentative : seules les mauvaises sont comptées.
      if (header) tsRecordFailure(ip);
      return "denied";
    },
  };
}

function handleRequest(listener, req, res) {
  if (!hostAllowed(req.headers.host)) {
    res.writeHead(403);
    res.end("Nom d'hôte non autorisé");
    return;
  }
  {
    const capUrl = new URL(req.url, "http://localhost");
    const cap = httpCapabilities.find((c) => capUrl.pathname.startsWith(c.prefix));
    let granted = false;
    try { granted = !!cap && cap.authorize(req, capUrl) === true; } catch { granted = false; }
    if (granted) {
      Promise.resolve(cap.fn(req, res, capUrl)).catch((e) => { if (!res.headersSent) res.writeHead(500); res.end(hosts.safeError(e)); });
      return;
    }
  }
  const verdict = listener.check(req);
  if (verdict === "locked") {
    res.writeHead(429, { "Retry-After": String(Math.ceil(TS_WINDOW_MS / 1000)) });
    res.end("Trop de tentatives");
    return;
  }
  if (verdict !== "ok") {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Paseo dashboard"' });
    res.end("Authentification requise");
    return;
  }
  if (req.paseoSessionCookie) res.setHeader("Set-Cookie", req.paseoSessionCookie);
  const url = new URL(req.url, "http://localhost");
  const prefixed = httpPrefixes.find((p) => url.pathname.startsWith(p.prefix));
  const route = httpRoutes.get(url.pathname) || prefixed?.fn;
  if (route) {
    if (req.method !== "GET" && !prefixed) {
      res.writeHead(405, { Allow: "GET" });
      res.end("Méthode non autorisée");
    } else if (listener.kind === "main" && !dashboardPassword && !isLoopbackAddress(req.socket.remoteAddress)) {
      res.writeHead(403);
      res.end("Accès local seulement");
    } else {
      Promise.resolve(route(req, res, url)).catch((e) => {
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: hosts.safeError(e) }));
      });
    }
    return;
  }
  serveStatic(url.pathname, res);
}

const uiServer = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
function handleUpgrade(listener, req, socket, head) {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const verdict = pathname === "/ui" && hostAllowed(req.headers.host) ? listener.check(req) : "denied";
  if (verdict === "locked") {
    socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (verdict !== "ok" || !originOkay(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  uiServer.handleUpgrade(req, socket, head, (ws) => uiServer.emit("connection", ws, req));
}
function createListenerServer(listener) {
  const srv = createServer((req, res) => handleRequest(listener, req, res));
  srv.on("upgrade", (req, socket, head) => handleUpgrade(listener, req, socket, head));
  return srv;
}
const server = createListenerServer(mainListener);
let tsServer = null;
uiServer.on("connection", (ws) => {
  ws._uiId = randomUUID();
  uiSockets.add(ws);
  ws.on("message", (raw) => {
    try {
      dispatch(ws, JSON.parse(raw.toString())).catch((e) => sendError(ws, hosts.safeError(e)));
    } catch (e) {
      sendError(ws, hosts.safeError(e));
    }
  });
  ws.on("close", () => {
    uiSockets.delete(ws);
    for (const listener of disconnectListeners) listener(ws);
  });
  broadcastState();
});

await loadHandlers();
hosts.startAll();
const stateTimer = setInterval(broadcastState, 5000);
server.listen(port, bindHost, () => console.log(`Paseo dashboard : http://${bindHost}:${port}`));
startTailscaleListener();

function startTailscaleListener() {
  if (!/^(1|true|yes|on)$/i.test(process.env.DASHBOARD_TAILSCALE || "")) return;
  const pw = readTailscalePassword();
  if (pw.error) return console.error(`Écouteur Tailscale désactivé : ${pw.error}.`);
  if (pw.password.length < TS_MIN_PASSWORD) {
    return console.error(`Écouteur Tailscale désactivé : DASHBOARD_TAILSCALE_PASSWORD (ou _FILE) doit faire au moins ${TS_MIN_PASSWORD} caractères.`);
  }
  const found = detectTailscaleIp();
  if (found.error) return console.error(`Écouteur Tailscale désactivé : ${found.error}.`);
  const tsPort = Number(process.env.DASHBOARD_TAILSCALE_PORT || port);
  if (!Number.isInteger(tsPort) || tsPort < 1 || tsPort > 65535) return console.error("Écouteur Tailscale désactivé : DASHBOARD_TAILSCALE_PORT invalide.");
  if (found.ip === bindHost && tsPort === port) return console.error("Écouteur Tailscale désactivé : même adresse et même port que l'écouteur principal.");
  tsServer = createListenerServer(makeTailscaleListener(pw.password));
  tsServer.on("error", (e) => {
    console.error(`Écouteur Tailscale arrêté : ${e.code || e.message} (${found.ip}:${tsPort}).`);
    tsServer = null;
  });
  tsServer.listen(tsPort, found.ip, () => console.log(`Paseo dashboard (Tailscale, authentification requise) : http://${found.ip}:${tsPort}`));
}

async function shutdown() {
  clearInterval(stateTimer);
  for (const ws of uiSockets) for (const listener of disconnectListeners) listener(ws);
  await hosts.closeAll();
  server.close();
  tsServer?.close();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
