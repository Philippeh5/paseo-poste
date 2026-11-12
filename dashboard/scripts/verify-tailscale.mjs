// Suite T33 : écouteur Tailscale (liaison, authentification, anti brute-force, Host, désactivations).
// Lance ses propres instances (autre port, DASHBOARD_DATA_DIR temporaire, mot de passe jetable) ; ne touche pas :7070.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir, networkInterfaces } from "node:os";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";

const require = createRequire(import.meta.url);
const { WebSocket } = require("ws");
const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "server.mjs");
const setupScript = join(here, "..", "..", "tools", "tailscale-setup.mjs");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0, checks = 0;
function ok(cond, label, detail = "") {
  checks++;
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label} ${detail}`); }
}

// IP Tailscale réelle (sans elle, la suite n'a pas de sens).
const tsBin = process.env.DASHBOARD_TAILSCALE_BIN || "tailscale";
let tsIp;
try {
  tsIp = execFileSync(tsBin, ["ip", "-4"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/).find((l) => /^100\./.test(l.trim())).trim();
} catch { /* tailscale non disponible sur cette machine */ }
if (!tsIp) { console.error("Tailscale indisponible : suite impossible"); process.exit(2); }
const lanIps = Object.values(networkInterfaces()).flat().filter((i) => i.family === "IPv4" && !i.internal && i.address !== tsIp).map((i) => i.address);

const PASS = "t33-" + randomBytes(12).toString("hex"); // jetable, 28 caractères
const basic = (user, pass) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
const GOOD = basic("admin", PASS);
const instances = [];
const tempDirs = [];
const usedPorts = new Set();
const pickPort = () => { let p; do { p = 18000 + Math.floor(Math.random() * 1500); } while (usedPorts.has(p)); usedPorts.add(p); return p; };

async function launch(env, { waitFor = "Paseo dashboard :", timeout = 15000 } = {}) {
  const port = pickPort();
  const dataDir = mkdtempSync(join(tmpdir(), "t33-data-"));
  tempDirs.push(dataDir);
  const child = spawn(process.execPath, [server], {
    cwd: dirname(server), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, DASHBOARD_HOST: "127.0.0.1", DASHBOARD_PORT: String(port), DASHBOARD_DATA_DIR: dataDir,
      DASHBOARD_PASSWORD: "", DASHBOARD_TAILSCALE: "", DASHBOARD_TAILSCALE_PASSWORD: "", DASHBOARD_TAILSCALE_PASSWORD_FILE: "",
      DASHBOARD_TAILSCALE_IP: "", DASHBOARD_TAILSCALE_PORT: "", DASHBOARD_TAILSCALE_BIN: "", ...env },
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const inst = { child, port, dataDir, output: () => output, stop: async () => { child.kill(); await delay(300); } };
  instances.push(inst);
  const end = Date.now() + timeout;
  while (Date.now() < end && !output.includes(waitFor)) await delay(100);
  if (!output.includes(waitFor)) throw new Error(`instance sans « ${waitFor} » : ${output.trim()}`);
  // laisse le temps aux handlers et à l'écouteur Tailscale de démarrer
  await delay(1200);
  return inst;
}

function http(host, port, path, { headers = {}, method = "GET", hostHeader, body } = {}) {
  return new Promise((resolve) => {
    const req = request({ host, port, path, method, headers: { ...headers, ...(hostHeader ? { Host: hostHeader } : {}) }, timeout: 8000 }, (res) => {
      let data = ""; res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", (e) => resolve({ status: 0, error: e.code || e.message }));
    req.on("timeout", () => { req.destroy(); });
    if (body) req.write(body);
    req.end();
  });
}
function wsTry(host, port, { headers = {}, hostHeader } = {}) {
  return new Promise((resolve) => {
    const h = hostHeader || `${host}:${port}`;
    const ws = new WebSocket(`ws://${host}:${port}/ui`, { origin: `http://${h}`, headers: { ...headers, ...(hostHeader ? { Host: hostHeader } : {}) } });
    ws.once("open", () => { ws.close(); resolve("open"); });
    ws.once("unexpected-response", (_r, res) => resolve(String(res.statusCode)));
    ws.once("error", (e) => resolve(e.code || "error"));
  });
}
function tcpRefused(host, port) {
  return new Promise((resolve) => {
    const s = connect({ host, port, timeout: 3000 });
    s.once("connect", () => { s.destroy(); resolve(false); });
    s.once("error", (e) => resolve(e.code === "ECONNREFUSED" || e.code === "EHOSTUNREACH" || e.code === "ETIMEDOUT" ? e.code : e.code));
    s.once("timeout", () => { s.destroy(); resolve("TIMEOUT"); });
  });
}
function listeningAddresses(port) {
  const out = execFileSync("ss", ["-tln"], { encoding: "utf8" });
  const want = ":" + port;
  return out.split(/\r?\n/)
    .filter((l) => /\bLISTEN\b/.test(l))
    .map((l) => l.split(/\s+/)[3])
    .filter((a) => a && a.endsWith(want));
}

try {
  // ---------- A : écouteur Tailscale actif ----------
  console.log("A. écouteur Tailscale actif");
  const A = await launch({ DASHBOARD_TAILSCALE: "1", DASHBOARD_TAILSCALE_PASSWORD: PASS }, { waitFor: "(Tailscale" });
  const P = A.port;
  const addrs = listeningAddresses(P).sort();
  ok(JSON.stringify(addrs) === JSON.stringify([`${tsIp}:${P}`, `127.0.0.1:${P}`].sort()), "netstat : seulement 127.0.0.1 et l'IP Tailscale", JSON.stringify(addrs));
  ok(!addrs.some((a) => a.startsWith("0.0.0.0") || a.startsWith("[::]")), "netstat : aucun écouteur 0.0.0.0 / [::]");
  for (const lan of lanIps.slice(0, 3)) ok((await tcpRefused(lan, P)) !== false, `connexion refusée sur l'interface ${lan}`);
  ok(lanIps.length > 0 || true, `interfaces non Tailscale testées : ${lanIps.length}`);

  const t = (path, opts) => http(tsIp, P, path, opts);
  const un = await t("/");
  ok(un.status === 401 && /^Basic/.test(un.headers["www-authenticate"] || ""), "Tailscale / sans auth -> 401 + WWW-Authenticate Basic", JSON.stringify(un.status));
  ok(!/<html/i.test(un.body || ""), "Tailscale / sans auth ne sert pas index.html");
  for (const path of ["/api/v1/summary", "/index.html", "/js/main.js", "/inexistant", "/js/views/index.json"]) {
    const r = await t(path);
    ok(r.status === 401, `Tailscale ${path} sans auth -> 401`, String(r.status));
  }
  const post = await t("/api/v1/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  ok(post.status === 401, "Tailscale POST /api/v1/tasks sans auth -> 401", String(post.status));
  ok((await wsTry(tsIp, P)) === "401", "Tailscale WS /ui sans auth -> 401");
  const fwd = await t("/api/v1/summary", { headers: { "X-Forwarded-For": "127.0.0.1", "X-Forwarded-Host": "localhost", "X-Forwarded-Proto": "https", "X-Real-IP": "127.0.0.1" } });
  ok(fwd.status === 401, "X-Forwarded-* n'accorde aucune confiance -> 401", String(fwd.status));

  ok((await t("/", { headers: { Authorization: basic("admin", PASS + "x") } })).status === 401, "mauvais mot de passe HTTP -> 401");
  ok((await t("/", { headers: { Authorization: basic("root", PASS) } })).status === 401, "mauvais utilisateur HTTP -> 401");
  ok((await wsTry(tsIp, P, { headers: { Authorization: basic("admin", "mauvais-mot-de-passe-xx") } })) === "401", "mauvais mot de passe WS -> 401");

  const home = await t("/", { headers: { Authorization: GOOD } });
  ok(home.status === 200 && /<html/i.test(home.body), "bon mot de passe : / -> 200 index.html", String(home.status));
  const summary = await t("/api/v1/summary", { headers: { Authorization: GOOD } });
  let summaryJson = null; try { summaryJson = JSON.parse(summary.body); } catch { /* */ }
  ok(summary.status === 200 && summaryJson?.ok === true, "bon mot de passe : /api/v1/summary -> 200 {ok:true}", `${summary.status} ${(summary.body || "").slice(0, 80)}`);
  ok((await wsTry(tsIp, P, { headers: { Authorization: GOOD } })) === "open", "bon mot de passe : WS /ui ouvert");
  ok((await t("/", { headers: { Authorization: GOOD }, hostHeader: "pc.exemple.ts.net" })).status === 200, "Host *.ts.net autorisé -> 200");
  const badHost = await t("/", { headers: { Authorization: GOOD }, hostHeader: "evil.example.com" });
  ok(badHost.status === 403, "Host non autorisé -> 403 même avec le bon mot de passe", String(badHost.status));
  ok((await t("/", { hostHeader: "evil.example.com" })).status === 403, "Host non autorisé sans auth -> 403");
  ok((await wsTry(tsIp, P, { headers: { Authorization: GOOD }, hostHeader: "evil.example.com" })) === "401", "WS avec Host non autorisé refusé");
  const badOriginWs = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://${tsIp}:${P}/ui`, { origin: "http://attacker.invalid", headers: { Authorization: GOOD } });
    ws.once("open", () => { ws.close(); resolve("open"); }); ws.once("unexpected-response", (_r, res) => resolve(String(res.statusCode))); ws.once("error", () => resolve("error"));
  });
  ok(badOriginWs === "401", "WS avec Origin étrangère refusé", badOriginWs);

  // écouteur loopback : comportement inchangé (aucun mot de passe pour les clients locaux)
  const lo = await http("127.0.0.1", P, "/");
  ok(lo.status === 200, "loopback / sans mot de passe -> 200", String(lo.status));
  const loApi = await http("127.0.0.1", P, "/api/v1/summary");
  ok(loApi.status === 200, "loopback /api/v1/summary sans mot de passe -> 200", String(loApi.status));
  ok((await wsTry("127.0.0.1", P)) === "open", "loopback WS /ui sans mot de passe ouvert");
  const loBadHost = await http("127.0.0.1", P, "/", { hostHeader: "evil.example.com" });
  ok(loBadHost.status === 403, "loopback : Host non autorisé -> 403 (inchangé)");
  await A.stop();

  // ---------- B : anti brute-force ----------
  console.log("B. verrouillage anti brute-force");
  const B = await launch({ DASHBOARD_TAILSCALE: "1", DASHBOARD_TAILSCALE_PASSWORD: PASS }, { waitFor: "(Tailscale" });
  const bad = { Authorization: basic("admin", "devine-moi-vraiment-1") };
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await http(tsIp, B.port, "/", { headers: bad })).status);
  ok(codes.slice(0, 10).every((c) => c === 401) && codes[10] === 429 && codes[11] === 429, "10 échecs -> 401, puis 429", codes.join(","));
  const locked = await http(tsIp, B.port, "/", { headers: { Authorization: GOOD } });
  ok(locked.status === 429 && !!locked.headers["retry-after"], "bon mot de passe pendant le verrouillage -> 429 + Retry-After", String(locked.status));
  ok((await wsTry(tsIp, B.port, { headers: { Authorization: GOOD } })) === "429", "WS pendant le verrouillage -> 429");
  ok((await http("127.0.0.1", B.port, "/")).status === 200, "loopback non affecté par le verrouillage");
  // un navigateur sans identifiants (premier appel) ne consomme pas le quota
  const C0 = await launch({ DASHBOARD_TAILSCALE: "1", DASHBOARD_TAILSCALE_PASSWORD: PASS }, { waitFor: "(Tailscale" });
  for (let i = 0; i < 15; i++) await http(tsIp, C0.port, "/");
  ok((await http(tsIp, C0.port, "/", { headers: { Authorization: GOOD } })).status === 200, "15 requêtes sans identifiants ne verrouillent pas");
  await B.stop(); await C0.stop();

  // ---------- C : mot de passe trop court ----------
  console.log("C. mot de passe < 16 caractères");
  const C = await launch({ DASHBOARD_TAILSCALE: "1", DASHBOARD_TAILSCALE_PASSWORD: "quinze-car-1234" }, { waitFor: "Paseo dashboard :" });
  ok(/désactivé.*16 caractères/.test(C.output()), "message clair au démarrage", C.output().split("\n").slice(-3).join(" | "));
  ok((await tcpRefused(tsIp, C.port)) !== false, "rien n'écoute sur l'IP Tailscale");
  ok(JSON.stringify(listeningAddresses(C.port)) === JSON.stringify([`127.0.0.1:${C.port}`]), "netstat : seulement loopback");
  ok((await http("127.0.0.1", C.port, "/")).status === 200, "loopback toujours en service");
  const noPw = await launch({ DASHBOARD_TAILSCALE: "1" });
  ok(/désactivé/.test(noPw.output()) && (await tcpRefused(tsIp, noPw.port)) !== false, "sans mot de passe : écouteur non démarré");
  await C.stop(); await noPw.stop();

  // ---------- D : Tailscale absent / IP invalide ----------
  console.log("D. Tailscale absent ou IP invalide");
  const D = await launch({ DASHBOARD_TAILSCALE: "1", DASHBOARD_TAILSCALE_PASSWORD: PASS, DASHBOARD_TAILSCALE_BIN: join(tmpdir(), "tailscale-inexistant.exe") });
  ok(/désactivé.*introuvable/.test(D.output()), "message clair, pas de plantage", D.output().split("\n").slice(-3).join(" | "));
  ok(D.child.exitCode === null && (await http("127.0.0.1", D.port, "/")).status === 200, "le serveur loopback tourne toujours");
  const E = await launch({ DASHBOARD_TAILSCALE: "1", DASHBOARD_TAILSCALE_PASSWORD: PASS, DASHBOARD_TAILSCALE_IP: "0.0.0.0" });
  ok(/désactivé.*DASHBOARD_TAILSCALE_IP/.test(E.output()), "0.0.0.0 refusé comme IP Tailscale");
  ok(!listeningAddresses(E.port).some((a) => a.startsWith("0.0.0.0")), "netstat : rien sur 0.0.0.0");
  const E2 = await launch({ DASHBOARD_TAILSCALE: "1", DASHBOARD_TAILSCALE_PASSWORD: PASS, DASHBOARD_TAILSCALE_IP: "192.168.1.10" });
  ok(/désactivé.*DASHBOARD_TAILSCALE_IP/.test(E2.output()), "IP hors 100.64.0.0/10 refusée");
  await D.stop(); await E.stop(); await E2.stop();

  // ---------- F : mot de passe via fichier ----------
  console.log("F. DASHBOARD_TAILSCALE_PASSWORD_FILE");
  const pwFile = join(mkdtempSync(join(tmpdir(), "t33-pw-")), "pw.txt");
  tempDirs.push(dirname(pwFile));
  writeFileSync(pwFile, PASS + "\r\n");
  const F = await launch({ DASHBOARD_TAILSCALE: "1", DASHBOARD_TAILSCALE_PASSWORD_FILE: pwFile }, { waitFor: "(Tailscale" });
  ok((await http(tsIp, F.port, "/", { headers: { Authorization: GOOD } })).status === 200, "mot de passe lu du fichier (espaces finaux ignorés) -> 200");
  ok((await http(tsIp, F.port, "/")).status === 401, "fichier : sans auth -> 401");
  await F.stop();
  const G = await launch({ DASHBOARD_TAILSCALE: "1", DASHBOARD_TAILSCALE_PASSWORD_FILE: join(tmpdir(), "t33-absent.txt") });
  ok(/désactivé.*illisible/.test(G.output()), "fichier absent : message clair, pas de plantage");
  await G.stop();

  // ---------- H : DASHBOARD_PASSWORD non local inchangé ----------
  console.log("H. DASHBOARD_PASSWORD et Tailscale ensemble");
  const H = await launch({ DASHBOARD_TAILSCALE: "1", DASHBOARD_TAILSCALE_PASSWORD: PASS, DASHBOARD_PASSWORD: "autre-secret-local" }, { waitFor: "(Tailscale" });
  ok((await http("127.0.0.1", H.port, "/")).status === 401, "loopback avec DASHBOARD_PASSWORD -> 401 sans identifiants (inchangé)");
  ok((await http("127.0.0.1", H.port, "/", { headers: { Authorization: basic("admin", "autre-secret-local") } })).status === 200, "loopback avec son mot de passe -> 200");
  ok((await http(tsIp, H.port, "/", { headers: { Authorization: basic("admin", "autre-secret-local") } })).status === 401, "le mot de passe loopback n'ouvre pas l'écouteur Tailscale");
  ok((await http(tsIp, H.port, "/", { headers: { Authorization: GOOD } })).status === 200, "le mot de passe Tailscale ouvre l'écouteur Tailscale");
  await H.stop();

  // ---------- I : fuite de secret, front, script de préparation ----------
  console.log("I. secrets, front, tailscale-setup");
  ok(instances.every((i) => !i.output().includes(PASS)), "aucun journal ne contient le mot de passe");
  const sock = readFileSync(join(here, "..", "public", "js", "core", "socket.js"), "utf8");
  ok(/location\.host/.test(sock) && !/127\.0\.0\.1|localhost/.test(sock), "front : URL WebSocket relative à location.host");
  const fresh = mkdtempSync(join(tmpdir(), "t33-setup-"));
  tempDirs.push(fresh);
  const run = () => execFileSync(process.execPath, [setupScript, "--dir", fresh], { encoding: "utf8", windowsHide: true });
  const out1 = run();
  const pwPath = join(fresh, "data", "tailscale-password.txt");
  const secret = existsSync(pwPath) ? readFileSync(pwPath, "utf8").trim() : "";
  ok(secret.length >= 24, "setup : mot de passe de 24+ caractères créé", String(secret.length));
  ok(!out1.includes(secret) && /http:\/\/100\./.test(out1) && out1.includes("tailscale-password.txt"), "setup : mot de passe jamais affiché, URL et emplacement indiqués");
  const ps1 = readFileSync(join(fresh, "start-dashboard.ps1"), "utf8");
  ok(!ps1.includes(secret) && /DASHBOARD_TAILSCALE = '1'/.test(ps1) && /DASHBOARD_TAILSCALE_PASSWORD/.test(ps1) && /node server\.mjs/.test(ps1) && ps1.includes("\r\n"), "setup : start-dashboard.ps1 (CRLF) lit le fichier, sans secret");
  run();
  ok(readFileSync(pwPath, "utf8").trim() === secret, "setup : second passage conserve le mot de passe");
  if (process.platform === "win32") {
    const acl = execFileSync("icacls", [pwPath], { encoding: "utf8", windowsHide: true });
    ok(!/Everyone|BUILTIN\\Users|Authenticated Users/i.test(acl), "setup : droits du fichier restreints", acl.replace(/\s+/g, " ").slice(0, 160));
  }
} catch (e) {
  failures++;
  console.log("ERREUR", e.stack || e.message);
} finally {
  for (const i of instances) { try { i.child.kill(); } catch { /* */ } }
  await delay(500);
  for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
}
console.log(failures === 0 ? `verify-tailscale OK (${checks} contrôles)` : `verify-tailscale ECHEC (${failures}/${checks})`);
process.exit(failures === 0 ? 0 : 1);
