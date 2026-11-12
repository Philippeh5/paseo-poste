// dashboard/scripts/verify-freebuff.mjs
// Vérification du ticket T46 : Jarvis lance FreeBuff sur un projet suivi (POST /api/v1/freebuff, postectl freebuff,
// outil MCP post_freebuff, consigne de l'orchestrateur). Instance ISOLÉE (port 7084, dossier de données jetable) :
// ne touche ni au serveur :7070 ni à dashboard/data. Faux lanceur injecté par FREEBUFF_RUN_BIN (lu seulement hors du dossier
// de données réel) : AUCUN Freebuck n'est dépensé, sauf avec VERIFY_REAL=1 (UNE vraie session FreeBuff, prompt « PONG »,
// dossier jetable sandbox-repo, terminal supprimé ensuite).
// Usage : node dashboard/scripts/verify-freebuff.mjs        (VERIFY_REAL=1 pour la vraie session ; VERIFY_PORT pour le port)
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { buildBrief } from "../handlers/agentmode.mjs";
import { pickLauncher, REAL_LAUNCHER } from "../handlers/freebuff.mjs";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = join(dashboardDir, "..");
const scratch = join(rootDir, ".foreman", "scratch", `t46-freebuff-${process.pid}`);
const PORT = Number(process.env.VERIFY_PORT || 7084);
const BASE = `http://127.0.0.1:${PORT}`;
const REAL = process.env.VERIFY_REAL === "1";
const slash = (p) => p.replace(/\\/g, "/");

let passed = 0;
let failed = 0;
const ok = (label) => { passed++; console.log(`OK   ${label}`); };
const fail = (label, detail = "") => { failed++; console.error(`FAIL ${label}${detail ? ` -> ${detail}` : ""}`); };
const expect = (cond, label, detail = "") => (cond ? ok(label) : fail(label, detail));
const section = (name) => console.log(`\n=== ${name} ===`);
const children = [];

rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

// ---------- Faux lanceur : mêmes arguments et même sortie JSON que tools/freebuff-run.mjs ----------
const unguard = (value) => String(value).replace(/^REGLES DU MANDAT \(obligatoires\) : .*? TACHE : /s, "");
const FAKE = join(scratch, "fake-freebuff-run.mjs");
const CALLS = join(scratch, "calls.jsonl");
writeFileSync(FAKE, `import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ argv, env: Object.keys(process.env).filter((k) => /PASSWORD/i.test(k)) }) + "\\n");
const prompt = argv[argv.indexOf("--prompt") + 1] ?? "";
const out = { terminalId: "term-fake-0001", ready: true, completed: true, killed: false, reply: "PONG", screen: "", error: null };
const lines = Array.from({ length: 60 }, (_, i) => "L" + String(i + 1).padStart(2, "0") + " ligne d'écran");
out.screen = lines.join("\\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (prompt.includes("HANG")) await sleep(120000);
if (prompt.includes("SLOW")) await sleep(3000);
if (prompt.includes("CRASH")) { console.error("boom: password=hunter2-crash"); process.exit(2); }
if (prompt.includes("NOFREEBUFF")) { Object.assign(out, { terminalId: null, ready: false, completed: false, error: "daemon injoignable" }); }
if (prompt.includes("UNFINISHED")) { Object.assign(out, { completed: false, reply: "", error: "reponse non terminee apres 90s" }); }
if (prompt.includes("SECRETS")) {
  out.reply = "voici: token ghp_AbCdEfGhIj1234567890abcdef et password=hunter2-reply";
  out.screen = lines.slice(0, 50).concat([
    "Authorization: Bearer abcdefghijklmnop1234567890QRSTUVWXYZ",
    "password=hunter2-secret", "DB_PASS=s3cr3tvalue", "key sk-abcdefghijklmnopqrstuv",
    "-----BEGIN PRIVATE KEY-----", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7", "-----END PRIVATE KEY-----",
    "L58", "L59", "L60 fin",
  ]).join("\\n");
}
console.log(JSON.stringify(out, null, 2));
process.exit(out.completed ? 0 : 1);
`);
const calls = () => (existsSync(CALLS) ? readFileSync(CALLS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// ---------- Décor : deux projets suivis (A = mandat, B = hors mandat), un dossier non suivi ----------
const dirA = join(scratch, "projA");
const dirSub = join(dirA, "sub");
const dirB = join(scratch, "projB");
const dirC = join(scratch, "projC-non-suivi");
for (const d of [dirA, dirSub, dirB, dirC]) mkdirSync(d, { recursive: true });

// ---------- Serveur isolé ----------
async function boot({ fake, seedMandate }) {
  const dataDir = join(scratch, fake ? "data-fake" : "data-real");
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  if (seedMandate) {
    writeFileSync(join(dataDir, "agent-mode.json"), JSON.stringify({
      enabled: true, project: "projA", brief: null, since: new Date().toISOString(), forbidden: [], runId: "run-t46",
      projectDir: slash(dirA), projectHost: "local", autoPermissions: true,
    }));
  }
  const env = { ...process.env, DASHBOARD_PORT: String(PORT), DASHBOARD_DATA_DIR: dataDir, DASHBOARD_HOST: "127.0.0.1" };
  for (const k of Object.keys(env)) if (/PASSWORD/i.test(k)) delete env[k]; // aucune variable de mot de passe héritée de la machine
  // Sans DASHBOARD_HOSTS_FILE le serveur lit un hosts.json absent sur Oracle -> « Machine inconnue : local ». Fichier jetable avec une machine « local ».
  if (!process.env.DASHBOARD_HOSTS_FILE) {
    const hostsFile = join(dataDir, "hosts-test.json");
    writeFileSync(hostsFile, JSON.stringify({ hosts: [{ label: "local", url: "ws://127.0.0.1:6767/ws" }] }));
    env.DASHBOARD_HOSTS_FILE = hostsFile;
  }
  env.DASHBOARD_SELF_HOST = "local"; // le test suit des projets « local » : indépendant de la machine qui l'exécute (Oracle = « oracle »)
  delete env.FREEBUFF_RUN_BIN;
  if (fake) env.FREEBUFF_RUN_BIN = FAKE;
  const child = spawn(process.execPath, [join(dashboardDir, "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  children.push(child);
  const server = { child, dataDir, log: "" };
  child.stdout.on("data", (d) => { server.log += d; });
  child.stderr.on("data", (d) => { server.log += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/v1/mandate`)).status === 200) return server; } catch { /* pas prêt */ }
    await sleep(250);
  }
  throw new Error(`le serveur ${PORT} ne démarre pas\n${server.log.slice(-800)}`);
}
const isDead = (c) => c.exitCode !== null || c.signalCode !== null;
async function stop(server) {
  if (isDead(server.child)) return;
  const gone = new Promise((r) => server.child.once("exit", r));
  server.child.kill();
  await gone;
}
async function api(method, path, body, headers = {}) {
  const response = await fetch(`${BASE}/api/v1${path}`, {
    method, headers: { "X-Agent-Name": "verify-t46", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  let json = null;
  try { json = await response.json(); } catch { /* corps non JSON */ }
  return { status: response.status, json, data: json?.data, code: json?.error?.code, message: json?.error?.message };
}
const follow = (dir, name) => api("POST", "/projects/follow", { host: "local", dir: slash(dir), ...(name ? { name } : {}) });
const run = (cmd, args, env = {}) => new Promise((done) => {
  execFile(process.execPath, [cmd, ...args], { env: { ...process.env, ...env }, windowsHide: true, timeout: 90000 }, (error, stdout, stderr) => {
    done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
  });
});

try {
  const { default: net } = await import("node:net");
  const busyPort = await new Promise((res) => {
    const s = net.createServer().once("error", () => res(true)).once("listening", () => s.close(() => res(false)));
    s.listen(PORT, "127.0.0.1");
  });
  if (busyPort) throw new Error(`le port ${PORT} est déjà utilisé : arrêt (ce script ne touche jamais un serveur existant)`);

  // =========================================================================================================
  section("0. Unités : choix du lanceur, consigne de l'orchestrateur");
  const realData = join(dashboardDir, "data");
  const fakePath = "D:/ailleurs/fake.mjs";
  expect(pickLauncher(realData, fakePath) === REAL_LAUNCHER, "dossier de données RÉEL : FREEBUFF_RUN_BIN ignoré");
  expect(pickLauncher(`${realData}/`, fakePath) === REAL_LAUNCHER, "dossier réel avec / final : ignoré");
  expect(pickLauncher(realData.toUpperCase(), fakePath) === REAL_LAUNCHER || process.platform !== "win32", "dossier réel en MAJUSCULES (Windows) : ignoré");
  expect(pickLauncher(undefined, fakePath) === REAL_LAUNCHER, "dossier inconnu : ignoré");
  expect(pickLauncher(scratch, fakePath) === resolve(fakePath), "dossier de test : faux lanceur utilisé");
  expect(pickLauncher(scratch, undefined) === REAL_LAUNCHER, "sans variable : vrai lanceur");
  expect(slash(REAL_LAUNCHER).endsWith("/tools/freebuff-run.mjs"), "vrai lanceur = tools/freebuff-run.mjs");
  // Le brief a été réécrit (JARVIS délègue via claude-foreman, plus de section FreeBuff dédiée) : on vérifie le contrat actuel.
  const brief = buildBrief({ project: "P", dir: "D:/Projets/P", brief: "x", forbidden: [], engine: "a/b", workerEngine: "freebuff/code" });
  for (const [needle, label] of [
    ["claude-foreman", "délégation via claude-foreman"], ["engine freebuff/code", "moteur des tâches filles"], ["une tache = un sujet", "un seul sujet par tâche"],
    ["Verifie toi-meme chaque resultat", "vérification obligatoire"], ["Aucun git commit", "pas de git"], ["AskUserQuestion", "question en cas de blocage"],
    ["compte-rendu court", "compte rendu"], ["Tu ne modifies que des fichiers dans D:/Projets/P", "périmètre d'écriture"],
  ]) expect(brief.includes(needle), `buildBrief : ${label}`);
  expect(!/\\/.test(brief), "buildBrief : aucun antislash");

  // =========================================================================================================
  section("1. Serveur isolé (faux lanceur, mandat actif sur projA)");
  const server = await boot({ fake: true, seedMandate: true });
  ok(`instance isolée démarrée sur :${PORT} (données ${slash(server.dataDir).slice(-40)})`);
  const mandate = await api("GET", "/mandate");
  expect(mandate.data?.enabled === true, "mandat de test actif (projA)");
  if (process.env.DASHBOARD_HOSTS_FILE) { // vrai daemon : la connexion prend quelques secondes après le démarrage
    for (let i = 0; i < 40; i++) {
      if ((await api("GET", "/summary")).data?.machines?.some((m) => m.label === "local" && m.status === "connected")) break;
      await sleep(250);
    }
  }
  const fa = await follow(dirA, "Proj Alpha");
  const fsub = await follow(dirSub);
  const fb = await follow(dirB, "Proj Beta");
  expect(fa.data?.added?.length === 1 && fsub.data?.added?.length === 1 && fb.data?.added?.length === 1, "projA, projA/sub et projB suivis", JSON.stringify([fa.json, fsub.json, fb.json]).slice(0, 400));
  const projects = (await api("GET", "/projects")).data.projects;
  const dirOf = (name) => projects.find((p) => p.name === name)?.dir;
  const alphaDir = dirOf("Proj Alpha");

  section("2. Validation (aucun lancement ne doit partir)");
  const before = calls().length;
  const bads = [
    ["projet absent", { prompt: "x" }, "bad_request"],
    ["projet vide", { project: "  ", prompt: "x" }, "bad_request"],
    ["projet non texte", { project: 42, prompt: "x" }, "bad_request"],
    ["projet inconnu", { project: "N-existe-pas", prompt: "x" }, "unknown_project"],
    ["dossier existant mais NON suivi", { project: slash(dirC), prompt: "x" }, "unknown_project"],
    ["prompt absent", { project: "Proj Alpha" }, "bad_request"],
    ["prompt vide", { project: "Proj Alpha", prompt: "" }, "bad_request"],
    ["prompt d'espaces", { project: "Proj Alpha", prompt: "   \n\t " }, "bad_request"],
    ["prompt non texte", { project: "Proj Alpha", prompt: 12 }, "bad_request"],
    ["prompt de 4001 caractères", { project: "Proj Alpha", prompt: "a".repeat(4001) }, "bad_request"],
    ["prompt avec caractère de contrôle", { project: "Proj Alpha", prompt: "a\u0007b" }, "bad_request"],
    ["waitSeconds 9", { project: "Proj Alpha", prompt: "x", waitSeconds: 9 }, "bad_request"],
    ["waitSeconds 601", { project: "Proj Alpha", prompt: "x", waitSeconds: 601 }, "bad_request"],
    ["waitSeconds 0", { project: "Proj Alpha", prompt: "x", waitSeconds: 0 }, "bad_request"],
    ["waitSeconds négatif", { project: "Proj Alpha", prompt: "x", waitSeconds: -5 }, "bad_request"],
    ["waitSeconds 12.5", { project: "Proj Alpha", prompt: "x", waitSeconds: 12.5 }, "bad_request"],
    ["waitSeconds « abc »", { project: "Proj Alpha", prompt: "x", waitSeconds: "abc" }, "bad_request"],
  ];
  for (const [label, body, code] of bads) {
    const r = await api("POST", "/freebuff", body);
    expect(r.status === 400 && r.code === code, `refusé : ${label}`, `${r.status} ${r.code} ${r.message}`);
  }
  const rJson = await api("POST", "/freebuff", "{pas du json");
  expect(rJson.status === 400, "corps JSON invalide : 400");
  const rGet = await api("GET", "/freebuff");
  expect(rGet.status === 200 && Array.isArray(rGet.data?.jobs), "GET /freebuff : liste des lancements asynchrones (200)", `${rGet.status}`);
  const rPut = await api("PUT", "/freebuff", {});
  expect(rPut.status === 405, "PUT /freebuff : 405");
  const rOrigin = await api("POST", "/freebuff", { project: "Proj Alpha", prompt: "x" }, { Origin: "http://evil.example" });
  expect(rOrigin.status === 403 && rOrigin.code === "foreign_origin", "Origin étranger : 403 (mêmes gardes que les autres routes)");
  expect(calls().length === before, "aucun lancement du faux lanceur pendant les refus", `${calls().length - before} lancement(s)`);

  section("3. Mandat : seul le projet du mandat (ou un sous-dossier) est permis");
  const rOut = await api("POST", "/freebuff", { project: "Proj Beta", prompt: "x" });
  expect(rOut.status === 403 && rOut.code === "forbidden_by_mandate", "projB hors du mandat : 403 forbidden_by_mandate", `${rOut.status} ${rOut.code}`);
  expect(calls().length === before, "aucun lancement pour le projet hors mandat");

  section("4. Lancement nominal");
  const r1 = await api("POST", "/freebuff", { project: "Proj Alpha", prompt: "Add a Hello button" });
  expect(r1.status === 200 && r1.json?.ok === true, "projet par NOM affiché : 200", JSON.stringify(r1.json)?.slice(0, 300));
  expect(Object.keys(r1.data || {}).sort().join(",") === "completed,reply,ready,screenTail,terminalId".split(",").sort().join(","),
    "réponse = {terminalId, ready, completed, reply, screenTail}", Object.keys(r1.data || {}).join(","));
  expect(r1.data?.terminalId === "term-fake-0001" && r1.data.ready === true && r1.data.completed === true && r1.data.reply === "PONG", "valeurs du lanceur reprises");
  const c1 = calls().at(-1);
  expect((c1?.argv || []).map((a, i) => (i === 3 ? unguard(a) : a)).join("|") === ["--cwd", alphaDir, "--prompt", "Add a Hello button", "--json", "--keep", "--wait-seconds", "180"].join("|"),
    "arguments : --cwd <dossier suivi> --prompt … --json --keep --wait-seconds 180 (défaut)", c1?.argv.join("|"));
  expect(c1.env.length === 0, "aucune variable *PASSWORD* transmise au lanceur", c1.env.join(","));
  const r2 = await api("POST", "/freebuff", { project: alphaDir, prompt: "Second", waitSeconds: 20 });
  expect(r2.status === 200, "projet par CHEMIN complet : 200");
  expect(calls().at(-1).argv.at(-1) === "20", "waitSeconds 20 transmis");
  const rsub = await api("POST", "/freebuff", { project: slash(dirSub), prompt: "Sub", waitSeconds: "30" });
  expect(rsub.status === 200 && calls().at(-1).argv.at(-1) === "30", "sous-dossier du mandat suivi : 200 ; waitSeconds « 30 » (texte numérique) accepté");
  // Suite dans le FreeBuff déjà ouvert (terminalId) : seul le terminal laissé par le dernier lancement de ce poste est accepté.
  const rbadT = await api("POST", "/freebuff", { project: "Proj Alpha", prompt: "Suite", terminalId: "term-etranger-9999" });
  expect(rbadT.status === 400 && rbadT.json?.error?.code === "unknown_terminal", "suite : terminal étranger refusé (400 unknown_terminal)", JSON.stringify(rbadT.json)?.slice(0, 200));
  const rbadF = await api("POST", "/freebuff", { project: "Proj Alpha", prompt: "Suite", terminalId: "../etc" });
  expect(rbadF.status === 400, "suite : terminalId mal formé refusé (400)");
  const nBefore = calls().length;
  const rfu = await api("POST", "/freebuff", { project: "Proj Alpha", prompt: "Question de suite", terminalId: "term-fake-0001" });
  const cfu = calls().at(-1);
  expect(rfu.status === 200 && calls().length === nBefore + 1, "suite : terminal du dernier lancement accepté (1 appel)", JSON.stringify(rfu.json)?.slice(0, 200));
  expect((cfu?.argv || []).join("|").endsWith("--terminal-id|term-fake-0001"), "suite : --terminal-id transmis au lanceur", cfu?.argv.join("|"));
  const rlines = await api("POST", "/freebuff", { project: "Proj Alpha", prompt: "ligne1\nligne2\r\n\tligne3" });
  expect(rlines.status === 200 && unguard(calls().at(-1).argv[3]) === "ligne1 ligne2 ligne3", "retours à la ligne ramenés à des espaces (une seule ligne)", calls().at(-1).argv[3]);
  const r4000 = await api("POST", "/freebuff", { project: "Proj Alpha", prompt: "b".repeat(4000) });
  expect(r4000.status === 200 && unguard(calls().at(-1).argv[3]).length === 4000, "prompt de 4000 caractères accepté");

  section("5. Aucun shell : le prompt arrive tel quel, en UN seul argument");
  const marker = join(scratch, "PWNED.txt");
  const evil = [
    '"; calc.exe & "',
    `x" & echo pwned > "${slash(marker)}" & "`,
    `'; node -e "require('fs').writeFileSync('${slash(marker)}','x')"; '`,
    "$(calc) `calc` %COMSPEC% ^& | > < ; && ||",
    `--cwd ${slash(dirB)} --prompt autre`,
  ];
  for (const text of evil) {
    const n = calls().length;
    const r = await api("POST", "/freebuff", { project: "Proj Alpha", prompt: text });
    const call = calls()[n];
    expect(r.status === 200 && calls().length === n + 1, `injection acceptée comme texte : ${text.slice(0, 40)}`, `${r.status} ${r.message}`);
    expect(call?.argv.length === 8 && unguard(call.argv[3]) === text, "  → exactement 8 arguments, prompt identique octet pour octet", JSON.stringify(call?.argv));
    expect(call?.argv[1] === alphaDir, "  → --cwd inchangé (pas d'injection d'option)");
  }
  expect(!existsSync(marker), "aucune commande injectée n'a été exécutée (fichier PWNED absent)");

  section("6. Un seul FreeBuff à la fois");
  const n0 = calls().length;
  const slow = api("POST", "/freebuff", { project: "Proj Alpha", prompt: "SLOW run" });
  await sleep(900);
  const second = await api("POST", "/freebuff", { project: "Proj Alpha", prompt: "second pendant le premier" });
  expect(second.status === 409 && second.code === "busy" && /FreeBuff est déjà en cours/.test(second.message), "second lancement refusé : 409 « FreeBuff est déjà en cours »", `${second.status} ${second.message}`);
  const first = await slow;
  expect(first.status === 200 && first.data?.completed === true, "le premier se termine normalement");
  expect(calls().length === n0 + 1, "le faux lanceur n'a été appelé qu'UNE fois", `${calls().length - n0}`);
  const burst = await Promise.all([1, 2, 3, 4].map((i) => api("POST", "/freebuff", { project: "Proj Alpha", prompt: `SLOW burst ${i}` })));
  const okCount = burst.filter((r) => r.status === 200).length;
  expect(okCount === 1 && burst.filter((r) => r.status === 409).length === 3, "4 requêtes simultanées : 1 accepté, 3 refusés", burst.map((r) => r.status).join(","));
  const after = await api("POST", "/freebuff", { project: "Proj Alpha", prompt: "après" });
  expect(after.status === 200, "verrou libéré après la fin : nouveau lancement accepté");

  section("6b. Mode asynchrone : l'agent n'attend pas FreeBuff");
  const t0 = Date.now();
  const job = await api("POST", "/freebuff", { project: "Proj Alpha", prompt: "SLOW async", async: true });
  expect(job.status === 200 && /^fb-/.test(job.data?.jobId || "") && job.data.status === "running" && Date.now() - t0 < 2000, "async : jobId renvoyé tout de suite, état running", `${job.status} ${Date.now() - t0} ms`);
  const during = await api("GET", `/freebuff/${job.data.jobId}`);
  expect(during.status === 200 && during.data.running === true && !during.data.result, "GET pendant le travail : running, pas encore de résultat");
  const busyAsync = await api("POST", "/freebuff", { project: "Proj Alpha", prompt: "second", async: true });
  expect(busyAsync.status === 409 && busyAsync.code === "busy", "second lancement async pendant le premier : 409 busy", `${busyAsync.status}`);
  await sleep(3800);
  const done = await api("GET", `/freebuff/${job.data.jobId}`);
  expect(done.data?.status === "done" && done.data.result?.completed === true && done.data.result.reply === "PONG", "GET après la fin : done + résultat (reply PONG)", JSON.stringify(done.json)?.slice(0, 200));
  const refused = await api("POST", "/freebuff", { project: "Proj inconnu", prompt: "x", async: true });
  expect(refused.status === 400 && refused.code === "unknown_project", "async : projet inconnu refusé tout de suite (400)", `${refused.status} ${refused.code}`);
  const nojob = await api("GET", "/freebuff/fb-nope");
  expect(nojob.status === 404 && nojob.code === "unknown_job", "jobId inconnu : 404");
  const hangJob = await api("POST", "/freebuff", { project: "Proj Alpha", prompt: "HANG async", async: true });
  expect(hangJob.status === 200 && hangJob.data?.status === "running", "async HANG : lancement accepté");
  const t1 = Date.now();
  const cancelled = await api("POST", `/freebuff/${hangJob.data?.jobId}/cancel`, {});
  expect(cancelled.status === 200 && cancelled.data?.cancelled === true, "annulation d'un lancement en cours : acceptée", `${cancelled.status} ${JSON.stringify(cancelled.json)}`);
  let after1;
  for (let i = 0; i < 20; i++) { await sleep(250); after1 = (await api("GET", `/freebuff/${hangJob.data?.jobId}`)).data; if (after1?.status !== "running") break; }
  expect(after1?.status === "failed" && after1.error === "annulé" && Date.now() - t1 < 6000, "lancement annulé : failed « annulé » en moins de 6 s (lanceur arrêté)", JSON.stringify(after1)?.slice(0, 200));
  const again = await api("POST", `/freebuff/${hangJob.data?.jobId}/cancel`, {});
  expect(again.status === 200 && again.data?.cancelled === false, "annuler deux fois : sans effet");
  expect((await api("POST", "/freebuff/fb-nope/cancel", {})).status === 404, "annuler un identifiant inconnu : 404");
  const free = await api("POST", "/freebuff", { project: "Proj Alpha", prompt: "après annulation", async: true });
  expect(free.status === 200, "verrou libéré après l'annulation : nouveau lancement accepté", `${free.status} ${free.message}`);
  await sleep(1500);
  const failJob = await api("POST", "/freebuff", { project: "Proj Alpha", prompt: "CRASH async", async: true });
  await sleep(1500);
  const failed = await api("GET", `/freebuff/${failJob.data?.jobId}`);
  expect(failed.data?.status === "failed" && !/hunter2-crash/.test(JSON.stringify(failed.json)), "async en échec : failed, secret masqué", JSON.stringify(failed.json)?.slice(0, 200));
  const listed = await api("GET", "/freebuff");
  expect(listed.data?.jobs?.some((j) => j.jobId === job.data.jobId && j.status === "done" && j.reply === "PONG"), "GET /freebuff : le job terminé figure dans la liste", JSON.stringify(listed.data)?.slice(0, 200));
  const saved = JSON.parse(readFileSync(join(scratch, "data-fake", "freebuff-jobs.json"), "utf8"));
  expect(saved.jobs?.some((j) => j.jobId === job.data.jobId && j.status === "done"), "historique écrit dans data/freebuff-jobs.json");
  const PT = join(rootDir, "tools", "postectl.mjs");
  const cliAsync = await run(PT, ["--url", BASE, "freebuff", "--project", "Proj Alpha", "--prompt", "SLOW cli", "--async"]);
  const cliId = /fb-[\w-]+/.exec(cliAsync.stdout)?.[0];
  expect(cliAsync.code === 0 && cliId, "postectl freebuff --async : code 0 + jobId", `${cliAsync.code} ${cliAsync.stdout}`);
  const cliRunning = await run(PT, ["--url", BASE, "freebuff-status", cliId || "x"]);
  expect(cliRunning.code === 2 && /running/.test(cliRunning.stdout), "postectl freebuff-status : code 2 tant que ça travaille", `${cliRunning.code} ${cliRunning.stdout}`);
  await sleep(3800);
  const cliDone = await run(PT, ["--url", BASE, "freebuff-status", cliId || "x"]);
  expect(cliDone.code === 0 && /PONG/.test(cliDone.stdout), "postectl freebuff-status : code 0 + réponse à la fin", `${cliDone.code} ${cliDone.stdout}`);

  section("6c. Tâche classée sur FreeBuff (moteur freebuff/code)");
  // Démarrer une tâche exige une machine connectée : le bac à sable de run-tests n'en a pas (daemon factice). Exécution complète :
  // DASHBOARD_HOSTS_FILE=<fichier où « local » pointe un vrai daemon> node dashboard/scripts/verify-freebuff.mjs
  const connected = (await api("GET", "/summary")).data?.machines?.some((m) => m.label === "local" && m.status === "connected");
  if (!connected) console.log("(6c ignorée : aucune machine « local » connectée dans ce bac à sable)");
  else {
  const mk = await api("POST", "/tasks", { title: "Tâche FreeBuff", description: "SLOW écrire un fichier", project: slash(dirA), host: "local", engine: "freebuff/code" });
  expect(mk.status === 200 && mk.data?.task?.id, "tâche créée avec le moteur freebuff/code", `${mk.status} ${mk.message}`);
  const tid = mk.data?.task?.id;
  const st = await api("POST", `/tasks/${tid}/start`, {});
  expect(st.status === 200, "démarrage accepté", `${st.status} ${st.code} ${st.message}`);
  const doing = (await api("GET", `/tasks?status=doing`)).data?.tasks?.find((t) => t.id === tid);
  expect(doing?.runEngine === "freebuff/code" && !doing.agentId && /FreeBuff : fb-/.test(doing.reason || ""), "tâche « En cours » sans session, raison = identifiant du lancement", JSON.stringify(doing)?.slice(0, 220));
  await sleep(3800);
  const review = (await api("GET", `/tasks?status=review`)).data?.tasks?.find((t) => t.id === tid);
  expect(review && /PONG/.test(review.summary || ""), "fin du lancement : tâche « À valider » avec la réponse en résumé", JSON.stringify(review)?.slice(0, 220));
  const mk2 = await api("POST", "/tasks", { title: "Tâche FreeBuff en échec", description: "CRASH", project: slash(dirA), host: "local", engine: "freebuff/code" });
  await api("POST", `/tasks/${mk2.data?.task?.id}/start`, {});
  await sleep(2500);
  const blocked = (await api("GET", `/tasks?status=blocked`)).data?.tasks?.find((t) => t.id === mk2.data?.task?.id);
  expect(blocked && /FreeBuff/.test(blocked.error || "") && !/hunter2-crash/.test(JSON.stringify(blocked)), "échec du lancement : tâche « Bloquée », secret masqué", JSON.stringify(blocked)?.slice(0, 220));
  const mk3 = await api("POST", "/tasks", { title: "Tâche FreeBuff arrêtée", description: "SLOW arrêt", project: slash(dirA), host: "local", engine: "freebuff/code" });
  await api("POST", `/tasks/${mk3.data?.task?.id}/start`, {});
  const stopped = await api("POST", `/tasks/${mk3.data?.task?.id}/stop`, {});
  expect(stopped.status === 200, "arrêt d'une tâche FreeBuff accepté", `${stopped.status} ${stopped.message}`);
  const afterStop = (await api("GET", `/tasks?status=blocked`)).data?.tasks?.find((t) => t.id === mk3.data?.task?.id);
  expect(afterStop && /Arrêtée manuellement/.test(afterStop.reason || ""), "tâche arrêtée : « Bloquée » (Arrêtée manuellement)", JSON.stringify(afterStop)?.slice(0, 200));
  await sleep(3500);
  const stillBlocked = (await api("GET", `/tasks?status=blocked`)).data?.tasks?.find((t) => t.id === mk3.data?.task?.id);
  expect(stillBlocked, "la fin du lancement ne ressuscite pas une tâche arrêtée");
  }

  section("7. Secrets masqués, 40 dernières lignes, cas d'échec");
  const sec = await api("POST", "/freebuff", { project: "Proj Alpha", prompt: "SECRETS" });
  const body = JSON.stringify(sec.json);
  for (const s of ["abcdefghijklmnop1234567890QRSTUVWXYZ", "hunter2-secret", "hunter2-reply", "s3cr3tvalue", "ghp_AbCdEfGhIj", "sk-abcdefghijklmnop", "MIIEvQIBADANBgkqhkiG9w0"]) {
    expect(!body.includes(s), `secret masqué dans la réponse : ${s.slice(0, 14)}…`);
  }
  expect(sec.data?.screenTail.includes("[masqué]") || sec.data?.screenTail.includes("[bloc de clé masqué]"), "marqueur de masquage présent");
  const tail = (sec.data?.screenTail || "").split("\n");
  expect(tail.length === 40, "screenTail = 40 lignes", `${tail.length}`);
  expect(tail.at(-1).startsWith("L60") && !tail.some((l) => l.startsWith("L05 ") || l.startsWith("L10 ")), "screenTail = les 40 DERNIÈRES lignes");
  const plain = await api("POST", "/freebuff", { project: "Proj Alpha", prompt: "normal" });
  const plainTail = plain.data.screenTail.split("\n");
  expect(plainTail.length === 40 && plainTail[0].startsWith("L21") && plainTail.at(-1).startsWith("L60"), "écran de 60 lignes : L21…L60", plainTail[0]);
  const unf = await api("POST", "/freebuff", { project: "Proj Alpha", prompt: "UNFINISHED" });
  expect(unf.status === 200 && unf.data.completed === false && /non terminee/.test(unf.data.error), "non terminé : 200, completed:false + error");
  const dead = await api("POST", "/freebuff", { project: "Proj Alpha", prompt: "NOFREEBUFF" });
  expect(dead.status === 502 && dead.code === "freebuff_failed", "FreeBuff injoignable : 502 freebuff_failed", `${dead.status} ${dead.code}`);
  const crash = await api("POST", "/freebuff", { project: "Proj Alpha", prompt: "CRASH" });
  expect(crash.status === 502 && !JSON.stringify(crash.json).includes("hunter2-crash"), "lanceur planté : 502, secret de stderr masqué", `${crash.status} ${crash.message}`);
  const ok2 = await api("POST", "/freebuff", { project: "Proj Alpha", prompt: "encore" });
  expect(ok2.status === 200, "verrou libéré après un échec");
  console.log("  (attente du délai de sécurité : lanceur bloqué, waitSeconds 10 + 30 s)");
  const hang = await api("POST", "/freebuff", { project: "Proj Alpha", prompt: "HANG", waitSeconds: 10 });
  expect(hang.status === 504 && hang.code === "freebuff_timeout", "lanceur bloqué : 504 freebuff_timeout au bout de waitSeconds + 30 s", `${hang.status} ${hang.code}`);
  const afterHang = await api("POST", "/freebuff", { project: "Proj Alpha", prompt: "apres blocage" });
  expect(afterHang.status === 200, "verrou libéré après le délai");

  section("8. Journal d'activité et journal d'audit");
  await sleep(500);
  const activity = JSON.parse(readFileSync(join(server.dataDir, "agent-activity.json"), "utf8")).filter((e) => e.route === "/freebuff");
  const mine = activity.filter((e) => /^FreeBuff (lancé|impossible)/.test(e.summary));
  expect(activity.length >= 10, `entrées d'activité /freebuff : ${activity.length}`);
  expect(mine.some((e) => /FreeBuff lancé sur Proj Alpha : terminé \(terminal term-fak\)/.test(e.summary) && e.ok), "entrée « FreeBuff lancé sur Proj Alpha : terminé »");
  expect(mine.some((e) => /non terminé/.test(e.summary)), "entrée « non terminé »");
  expect(mine.some((e) => !e.ok && /impossible/.test(e.summary)), "entrée d'échec (ok:false)");
  expect(activity.some((e) => e.status === 409), "refus « déjà en cours » journalisé (409)");
  expect(activity.some((e) => e.status === 403 && /mandat/.test(e.summary)), "refus du mandat journalisé");
  expect(activity.every((e) => e.mandateActive === true), "mandateActive vrai (mandat de test)");
  const actText = JSON.stringify(activity);
  expect(!/calc\.exe|hunter2|ghp_|Add a Hello|SECRETS/.test(actText), "aucun texte de consigne ni secret dans le journal d'activité");
  const audit = readFileSync(join(server.dataDir, "agent-audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.route === "/freebuff");
  expect(audit.length >= 10 && audit.every((e) => e.method === "POST"), `journal d'audit : ${audit.length} entrées /freebuff`);
  expect(!/calc\.exe|hunter2|ghp_|Add a Hello|SECRETS/.test(JSON.stringify(audit)), "journal d'audit : aucun texte de consigne ni secret");

  section("9. postectl freebuff");
  const POSTECTL = join(rootDir, "tools", "postectl.mjs");
  const ctl = (args) => run(POSTECTL, ["--url", BASE, ...args]);
  const help = await run(POSTECTL, ["--help"]);
  expect(/freebuff --project DOSSIER --prompt "TEXTE" \[--wait N\]/.test(help.stdout) && /heures de session/.test(help.stdout), "--help documente freebuff et le coût en heures de session");
  const c0 = await ctl(["freebuff", "--project", "Proj Alpha", "--prompt", "Via postectl"]);
  expect(c0.code === 0 && /FreeBuff terminé/.test(c0.stdout) && /PONG/.test(c0.stdout), "freebuff : code 0, « FreeBuff terminé », réponse affichée", `${c0.code} ${c0.stderr}`);
  const cj = await ctl(["freebuff", "--project", "Proj Alpha", "--prompt", "Via postectl json", "--wait", "45", "--json"]);
  const cjson = JSON.parse(cj.stdout || "{}");
  expect(cj.code === 0 && cjson.completed === true && cjson.terminalId === "term-fake-0001", "--json : objet complet", cj.stdout.slice(0, 120));
  expect(calls().at(-1).argv.at(-1) === "45", "--wait 45 transmis au poste");
  const cu = await ctl(["freebuff", "--project", "Proj Alpha", "--prompt", "UNFINISHED"]);
  expect(cu.code === 1 && /NON terminé/.test(cu.stdout), "non terminé : code 1 et avertissement", `${cu.code}`);
  const cq = await ctl(["freebuff", "--project", "Proj Alpha", "--prompt", '"; calc.exe & "']);
  expect(cq.code === 0 && unguard(calls().at(-1).argv[3]) === '"; calc.exe & "', "postectl : prompt piégé transmis intact au poste");
  for (const [label, args, code] of [
    ["sans --prompt", ["freebuff", "--project", "Proj Alpha"], 2],
    ["sans --project", ["freebuff", "--prompt", "x"], 2],
    ["--wait 5", ["freebuff", "--project", "Proj Alpha", "--prompt", "x", "--wait", "5"], 2],
    ["--wait 241", ["freebuff", "--project", "Proj Alpha", "--prompt", "x", "--wait", "241"], 2],
    ["--wait abc", ["freebuff", "--project", "Proj Alpha", "--prompt", "x", "--wait", "abc"], 2],
    ["argument en trop", ["freebuff", "now", "--project", "Proj Alpha", "--prompt", "x"], 2],
    ["projet inconnu (refus du poste)", ["freebuff", "--project", "Nope", "--prompt", "x"], 1],
    ["projet hors mandat (403 du poste = code 3, comme les autres refus d'accès)", ["freebuff", "--project", "Proj Beta", "--prompt", "x"], 3],
  ]) {
    const n = calls().length;
    const r = await ctl(args);
    expect(r.code === code && calls().length === n, `${label} : code ${code}, aucun lancement`, `${r.code} ${r.stderr.trim()}`);
  }
  const slow2 = ctl(["freebuff", "--project", "Proj Alpha", "--prompt", "SLOW cli"]);
  await sleep(900);
  const busyCli = await ctl(["freebuff", "--project", "Proj Alpha", "--prompt", "pendant"]);
  expect(busyCli.code === 1 && /déjà en cours/.test(busyCli.stderr), "second postectl pendant un lancement : code 1 « déjà en cours »", busyCli.stderr.trim());
  expect((await slow2).code === 0, "le premier postectl se termine (code 0)");

  section("10. Outil MCP post_freebuff");
  const mcp = spawn(process.execPath, [join(rootDir, "tools", "postectl-mcp.mjs")], {
    env: { ...process.env, POSTECTL_URL: BASE }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  children.push(mcp);
  const pending = new Map();
  let buf = "";
  mcp.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(line); pending.get(m.id)?.(m); } catch { /* ligne non JSON */ }
    }
  });
  let rpcId = 0;
  const rpc = (method, params) => new Promise((res, rej) => {
    const id = ++rpcId;
    pending.set(id, res);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => rej(new Error(`MCP ${method} : délai dépassé`)), 60000).unref();
  });
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "verify-t46", version: "1" } });
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const tools = (await rpc("tools/list", {})).result.tools;
  const tool = tools.find((t) => t.name === "post_freebuff");
  expect(Boolean(tool), "outil post_freebuff listé");
  expect(tool?.inputSchema.required.join() === "project,prompt" && tool.inputSchema.properties.waitSeconds.maximum === 240, "schéma : project et prompt requis, waitSeconds 10–240");
  expect(/heures de session/.test(tool?.description || "") && /take over/.test(tool?.description || ""), "description : coût en heures de session et interdiction du take over");
  const call = await rpc("tools/call", { name: "post_freebuff", arguments: { project: "Proj Alpha", prompt: "Via MCP", waitSeconds: 15 } });
  const payload = JSON.parse(call.result.content[0].text);
  expect(!call.result.isError && payload.completed === true && calls().at(-1).argv.at(-1) === "15", "appel MCP : résultat complet, waitSeconds 15 transmis");
  const badCall = await rpc("tools/call", { name: "post_freebuff", arguments: { project: "Proj Alpha" } });
  expect(badCall.result.isError === true, "MCP sans prompt : erreur");
  const badWait = await rpc("tools/call", { name: "post_freebuff", arguments: { project: "Proj Alpha", prompt: "x", waitSeconds: 5 } });
  expect(badWait.result.isError === true, "MCP waitSeconds 5 : erreur");
  const badExtra = await rpc("tools/call", { name: "post_freebuff", arguments: { project: "Proj Alpha", prompt: "x", cwd: "C:/" } });
  expect(badExtra.result.isError === true, "MCP paramètre inconnu : erreur");
  mcp.kill();

  await stop(server);
  const portFree = await fetch(`${BASE}/api/v1/mandate`).then(() => false, () => true);
  expect(isDead(server.child) && portFree, "instance de test arrêtée (son PID uniquement), port libéré");

  // =========================================================================================================
  if (REAL) {
    section("11. UNE vraie session FreeBuff (VERIFY_REAL=1) sur sandbox-repo");
    const sandbox = join(rootDir, "sandbox-repo");
    const live = await boot({ fake: false, seedMandate: false });
    const f = await follow(sandbox, "sandbox-repo");
    expect(f.status === 200, "sandbox-repo suivi dans l'instance de test");
    const t0 = Date.now();
    const real = await api("POST", "/freebuff", { project: "sandbox-repo", prompt: "Reply with the single word PONG and do nothing else.", waitSeconds: 150 });
    console.log(`  >> ${Date.now() - t0} ms, HTTP ${real.status}`);
    console.log(`  >> ${JSON.stringify(real.json).slice(0, 1500)}`);
    expect(real.status === 200 && Boolean(real.data?.terminalId) && real.data.ready === true, "vraie session : terminal créé et FreeBuff prêt");
    expect(real.data?.completed === true, "vraie session : réponse terminée détectée");
    expect(/PONG/i.test(`${real.data?.reply}\n${real.data?.screenTail}`), "vraie session : « PONG » dans la réponse ou l'écran");
    expect(real.data?.screenTail.split("\n").length <= 40, "screenTail ≤ 40 lignes");
    if (real.data?.terminalId) {
      const { createPaseoClient } = await import("@getpaseo/client");
      const client = createPaseoClient({ url: "ws://127.0.0.1:6767/ws", reconnect: { enabled: false } });
      try {
        await client.connect();
        await client.terminals.ref(real.data.terminalId).kill();
        ok(`terminal de test ${real.data.terminalId} supprimé`);
      } catch (e) {
        fail("suppression du terminal de test", `${e.message} : SUPPRIMER ${real.data.terminalId} À LA MAIN`);
      } finally {
        await client.close().catch(() => {});
      }
    }
    await stop(live);
  } else {
    console.log("\n(vraie session FreeBuff non lancée : VERIFY_REAL=1 pour la faire — elle consomme des heures de session)");
  }
} catch (e) {
  fail("exception", e.stack || e.message);
} finally {
  for (const c of children) { try { if (!isDead(c)) c.kill(); } catch { /* déjà arrêté */ } }
  await sleep(300);
  if (failed === 0) {
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* nettoyage partiel */ }
  } else console.error(`(traces conservées : ${scratch})`);
}
console.log(`\n=== BILAN : ${passed} OK, ${failed} FAIL ===`);
if (failed) process.exit(1);
console.log("VERIFY_FREEBUFF_PASS");
