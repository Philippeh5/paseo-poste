// dashboard/scripts/verify-decide-von.mjs
// Vérification du ticket T47 : second moteur de décision « Von » dans handlers/decide.mjs (+ route REST).
// Usage : node dashboard/scripts/verify-decide-von.mjs        (REAL_VON=1 ajoute UN test avec le vrai Von)
// Tout est isolé : ports 18771..18776 et 7083, dossier de données temporaire, jamais le :7070 ni le Laya/Von de Philippe.
//   A. choix du moteur (faux Laya et faux Von = deux serveurs HTTP locaux), modèle envoyé, défauts, liste blanche d'`engine`
//   B. exclusion mutuelle + démarrage paresseux + arrêt sur inactivité (faux exécutables lancés pour de vrai par decide.mjs) :
//      jamais deux processus lancés par le tableau de bord en même temps, y compris sous appels simultanés
//   C. serveur déjà présent (pas lancé par le tableau de bord) laissé en place ; exécutable absent / non local / qui plante
//   D. route REST POST /api/v1/decide (instance isolée sur :7083) : `engine` facultatif, 400 si inconnu ; arrêt brutal du
//      tableau de bord -> la sentinelle arrête Von
//   E. (REAL_VON=1) vrai Von lancé paresseusement, question `noul`, arrêt sur inactivité ; sauté si la RAM libre < 3 Go
// Le faux Von est `node serve --host H --port P` (fichier « serve » du dossier courant) : mêmes arguments que le vrai von.exe.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { freemem } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = join(dashboardDir, "..");
const scratch = join(rootDir, ".foreman", "scratch", `t47-von-${process.pid}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const startCwd = process.cwd();
const USER_VON_BIN = process.env.VON_BIN; // avant que les scénarios ne modifient process.env
process.setMaxListeners(60); // un decide.mjs enregistré par scénario

const PORT = Number(process.env.VERIFY_PORT || 7083);
if (PORT === 7070) throw new Error("VERIFY_PORT ne doit jamais être 7070 (serveur réel)");
const LAYA_EXT = 18771; // faux Laya « déjà présent » (serveur HTTP de ce processus)
const VON_EXT = 18772; // faux Von « déjà présent »
const LAYA_LAZY = 18773; // port que decide.mjs donne au faux exécutable Laya
const VON_LAZY = 18774; // idem pour Von
const CLOSED = 18775;
const REAL_PORT = 18776;
const url = (port) => `http://127.0.0.1:${port}/v1/systemone`;
const IDLE = "2500";

let passed = 0;
let failed = 0;
const ok = (label) => { passed += 1; console.log(`OK   ${label}`); };
const fail = (label, detail = "") => { failed += 1; console.error(`FAIL ${label}${detail ? ` -> ${detail}` : ""}`); };
const expect = (cond, label, detail = "") => (cond ? ok(label) : fail(label, String(detail)));
const section = (name) => console.log(`\n=== ${name} ===`);
const dump = (v) => JSON.stringify(v);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const portOpen = (port) => new Promise((resolve) => {
  const s = connect({ host: "127.0.0.1", port });
  s.setTimeout(500, () => { s.destroy(); resolve(false); });
  s.once("connect", () => { s.destroy(); resolve(true); });
  s.once("error", () => resolve(false));
});
async function waitUntil(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(100); }
  return false;
}

// ---------------------------------------------------------------- faux moteurs déjà présents (dans ce processus)
const seen = { laya: [], von: [] };
const external = (name) => createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", () => {
    let body = null;
    try { body = JSON.parse(raw); } catch { /* ignoré */ }
    seen[name].push({ url: req.url, method: req.method, body });
    const answers = Object.fromEntries(Object.keys(body?.questions || {}).map((q) => [q, { noul: name === "von" ? 0.81 : 0.5, engine: name, model: body.model }]));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ answers }));
  });
});
const extLaya = external("laya");
const extVon = external("von");
await new Promise((r) => extLaya.listen(LAYA_EXT, "127.0.0.1", r));
await new Promise((r) => extVon.listen(VON_EXT, "127.0.0.1", r));

// ---------------------------------------------------------------- faux exécutables (lancés par decide.mjs)
// fake-engine.cjs : serveur HTTP + une ligne dans launches.log (pid, arguments, moteur voisin déjà vivant ?, secrets reçus ?).
// Laya : `node` + NODE_OPTIONS=--import boot (actif seulement si decide.mjs a posé LAYA_MODELS) ; Von : `node serve ...`.
writeFileSync(join(scratch, "package.json"), '{"type":"commonjs"}');
writeFileSync(join(scratch, "fake-engine.cjs"), `
const http = require("node:http"); const net = require("node:net"); const fs = require("node:fs"); const path = require("node:path");
exports.start = (name, host, port) => {
  const server = http.createServer((req, res) => {
    let raw = ""; req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      let body = {}; try { body = JSON.parse(raw); } catch {}
      const answers = {}; for (const q of Object.keys(body.questions || {})) answers[q] = { noul: name === "von" ? 0.81 : 0.5, engine: name, model: body.model };
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ answers }));
    });
  });
  server.listen(port, host, () => {
    const probe = net.connect({ host: "127.0.0.1", port: Number(process.env["FAKE_" + name.toUpperCase() + "_OTHER"]) });
    let done = false;
    const finish = (otherAlive) => {
      if (done) return; done = true; probe.destroy();
      const leaks = Object.keys(process.env).filter((k) => /PASSWORD|SECRET|TOKEN|API_?KEY|CREDENTIAL/i.test(k));
      fs.appendFileSync(path.join(process.env.FAKE_DIR, "launches.log"), JSON.stringify({ name, pid: process.pid, host, port, argv: process.argv.slice(1),
        otherAlive, leaks, layaHost: process.env.LAYA_HOST ?? null, layaModels: process.env.LAYA_MODELS ?? null }) + "\\n");
    };
    probe.setTimeout(500, () => finish(false)); probe.once("connect", () => finish(true)); probe.once("error", () => finish(false));
  });
};
`);
writeFileSync(join(scratch, "fake-laya-boot.mjs"), `
import { createRequire } from "node:module";
if (process.env.LAYA_MODELS && process.env.FAKE_DIR) {
  createRequire(import.meta.url)(${dump(join(scratch, "fake-engine.cjs"))}).start("laya", process.env.LAYA_HOST, Number(process.env.LAYA_PORT));
}
`);
writeFileSync(join(scratch, "serve"), `
const a = process.argv.slice(2); // serve --host H --port P
require(${dump(join(scratch, "fake-engine.cjs"))}).start("von", a[a.indexOf("--host") + 1], Number(a[a.indexOf("--port") + 1]));
`);
const bootOptions = `--import ${pathToFileURL(join(scratch, "fake-laya-boot.mjs")).href}`;
const emptyDir = join(scratch, "vide");
mkdirSync(emptyDir);
let launchDirCount = 0;
const newLaunchDir = () => { const d = join(scratch, `launch-${++launchDirCount}`); mkdirSync(d); return d; };
const launchesOf = (dir) => (existsSync(join(dir, "launches.log"))
  ? readFileSync(join(dir, "launches.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// ---------------------------------------------------------------- harnais : vrai decide.mjs, faux ctx
const decideUrl = pathToFileURL(join(dashboardDir, "handlers", "decide.mjs")).href;
const { validateDecide, ENGINE_NAMES } = await import(decideUrl);
async function harness(env) {
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const logs = [];
  const ctx = { log: (scope, message) => logs.push(message), safeError: (e) => String(e?.message ?? e) };
  (await import(`${decideUrl}?h=${Math.random()}`)).register(ctx);
  return { ctx, logs, run: (body, opts) => ctx.decide.run(body, opts) };
}
const reject = async (promise) => { try { await promise; return null; } catch (e) { return e; } };
const valid = { state: "Le compte-rendu dit que tout est terminé", questions: { ok: { type: "noul", instructions: "Tâche réussie ?" } } };

const baseEnv = {
  LAYA_URL: url(LAYA_EXT), VON_URL: url(VON_EXT), LAYA_BIN: join(scratch, "absent-laya.exe"), VON_BIN: join(scratch, "absent-von.exe"),
  DECIDE_IDLE_MS: undefined, VON_MODEL: undefined, LAYA_MODEL: undefined, NODE_OPTIONS: undefined, FAKE_DIR: undefined,
  LAYA_START_TIMEOUT_MS: "20000", VON_START_TIMEOUT_MS: "20000",
};
const lazyEnv = (dir, extra = {}) => ({
  ...baseEnv, LAYA_URL: url(LAYA_LAZY), VON_URL: url(VON_LAZY), LAYA_BIN: process.execPath, VON_BIN: process.execPath, NODE_OPTIONS: bootOptions,
  FAKE_DIR: dir, FAKE_LAYA_OTHER: String(VON_LAZY), FAKE_VON_OTHER: String(LAYA_LAZY), ...extra,
});

let srv = null;
const children = new Set(); // pids lancés par les faux exécutables : nettoyage de sécurité
const killChildren = () => { for (const pid of children) if (alive(pid)) { try { process.kill(pid); } catch { /* déjà parti */ } } };
try {
  // =====================================================================================
  section("A. choix du moteur, modèle, défauts, liste blanche d'engine");
  let h = await harness({ ...baseEnv, LAYA_URL: undefined, VON_URL: undefined });
  expect(dump(ENGINE_NAMES) === dump(["laya", "von"]), "moteurs connus : laya, von", dump(ENGINE_NAMES));
  expect(h.logs.some((l) => l.includes("http://127.0.0.1:8765") && l.includes("http://127.0.0.1:8766")),
    "défauts : Laya http://127.0.0.1:8765, Von http://127.0.0.1:8766 (LAYA_URL / VON_URL absents)", h.logs.join(" | "));
  h = await harness(baseEnv);
  let r = await h.run(valid);
  expect(r.engine === "laya" && r.answers.ok.engine === "laya" && seen.laya.at(-1)?.body.model === "multilingual",
    "sans engine : Laya (défaut inchangé), modèle multilingual", dump(r));
  expect(seen.von.length === 0, "sans engine : Von n'est pas touché");
  r = await h.run(valid, { engine: "laya" });
  expect(r.engine === "laya" && seen.von.length === 0, "engine laya explicite : Laya");
  r = await h.run(valid, { engine: "von" });
  const vs = seen.von.at(-1);
  expect(r.engine === "von" && r.answers.ok.engine === "von" && vs?.body.model === "von" && vs.url === "/v1/systemone" && vs.method === "POST",
    "engine von : POST /v1/systemone du faux Von, modèle « von »", dump([r, vs?.body.model]));
  expect(dump(vs?.body.questions) === dump(validateDecide(valid).questions) && vs.body.state === valid.state,
    "engine von : même corps (state, questions) que pour Laya");
  expect(seen.laya.length === 2, "engine von : Laya n'a pas été interrogé de plus", String(seen.laya.length));
  const layaBefore = seen.laya.length;
  r = await h.run({ ...valid, engine: "von" });
  expect(r.engine === "von" && seen.laya.length === layaBefore, "engine dans le corps (route REST) : Von");
  r = await h.run({ ...valid, engine: "von" }, { engine: "laya" });
  expect(r.engine === "laya", "l'option { engine } prime sur le champ engine du corps");
  const wrongs = ["gpt", "LAYA", "Von", "", 42, ["von"], {}, "__proto__", "von "];
  const callsBefore = seen.laya.length + seen.von.length;
  for (const wrong of wrongs) {
    const e1 = await reject(h.run(valid, { engine: wrong }));
    const e2 = await reject(h.run({ ...valid, engine: wrong }));
    expect(e1?.status === 400 && e1.code === "bad_request" && e2?.status === 400, `engine ${dump(wrong)} refusé (400, option et corps)`, `${e1?.status} ${e2?.status}`);
  }
  expect(seen.laya.length + seen.von.length === callsBefore, "un engine inconnu n'atteint aucun moteur");
  expect((await reject(h.run({ state: "", questions: {} }, { engine: "von" })))?.status === 400, "validateDecide inchangée pour Von (state vide -> 400)");
  h = await harness({ ...baseEnv, VON_MODEL: "von-bis" });
  r = await h.run(valid, { engine: "von" });
  expect(seen.von.at(-1)?.body.model === "von-bis", "VON_MODEL surcharge le nom du modèle", seen.von.at(-1)?.body.model);
  h = await harness({ ...baseEnv, VON_URL: url(CLOSED) });
  const unreachable = await reject(h.run(valid, { engine: "von" }));
  expect(unreachable?.status === 503 && unreachable.code === "von_unavailable" && /Von est absent/.test(unreachable.message),
    "Von injoignable et exécutable absent : 503 von_unavailable (message en français)", unreachable?.message);
  const layaStill = await h.run(valid);
  expect(layaStill.engine === "laya", "après l'échec de Von, Laya répond toujours");

  // =====================================================================================
  section("B. exclusion mutuelle, démarrage paresseux, arrêt sur inactivité (faux exécutables)");
  process.chdir(scratch); // `node serve --host H --port P` : le faux Von est le fichier « serve » d'ici
  const dirB = newLaunchDir();
  process.env.T47_FAKE_API_KEY = "ne-doit-pas-fuiter";
  process.env.T47_DB_PASSWORD = "ne-doit-pas-fuiter";
  h = await harness(lazyEnv(dirB, { DECIDE_IDLE_MS: "600000" }));
  expect(!(await portOpen(LAYA_LAZY)) && !(await portOpen(VON_LAZY)), "avant tout appel : aucun moteur lancé (paresseux)");
  r = await h.run(valid, { engine: "von" });
  let L = launchesOf(dirB);
  const von1 = L.find((x) => x.name === "von");
  if (von1) children.add(von1.pid);
  expect(r.engine === "von" && r.answers.ok.engine === "von" && r.answers.ok.model === "von", "Von lancé puis interrogé (modèle von)", dump(r));
  expect(/[\\/]serve$/.test(von1?.argv[0] || "") && dump(von1.argv.slice(1)) === dump(["--host", "127.0.0.1", "--port", String(VON_LAZY)]) && von1.host === "127.0.0.1",
    "Von lancé comme « node serve --host 127.0.0.1 --port <port> » (script « serve » = 1er argument ; jamais 0.0.0.0)", dump(von1?.argv));
  expect(von1?.leaks.length === 0 && von1.layaHost === null && von1.layaModels === null,
    "Von : environnement filtré des secrets (PASSWORD/TOKEN/API_KEY...), aucune variable LAYA_*", dump([von1?.leaks, von1?.layaHost]));
  expect(von1?.otherAlive === false && alive(von1.pid) && (await portOpen(VON_LAZY)), "Von écoute, aucun Laya vivant");

  r = await h.run(valid, { engine: "laya" });
  L = launchesOf(dirB);
  const laya1 = L.find((x) => x.name === "laya");
  if (laya1) children.add(laya1.pid);
  expect(r.engine === "laya" && r.answers.ok.engine === "laya" && r.answers.ok.model === "multilingual", "puis Laya lancé et interrogé", dump(r));
  expect(laya1?.otherAlive === false, "Laya a démarré alors que Von était déjà arrêté (exclusion mutuelle)", dump(laya1));
  expect(!alive(von1.pid) && !(await portOpen(VON_LAZY)), "Von arrêté pour faire place à Laya (pid mort, port fermé)");
  expect(laya1?.host === "127.0.0.1" && laya1.layaModels === "multilingual" && laya1.leaks.length === 0 && laya1.argv.length === 0,
    "Laya : LAYA_HOST=127.0.0.1, LAYA_MODELS=multilingual, secrets filtrés (non-régression)", dump(laya1));

  r = await h.run(valid, { engine: "von" });
  L = launchesOf(dirB).filter((x) => x.name === "von");
  const von2 = L.at(-1);
  if (von2) children.add(von2.pid);
  expect(L.length === 2 && von2.pid !== von1.pid && von2.otherAlive === false, "Von relancé (nouveau pid) alors que Laya est arrêté", dump(von2));
  expect(!alive(laya1.pid) && !(await portOpen(LAYA_LAZY)), "Laya arrêté pour faire place à Von");
  const warm = launchesOf(dirB).length;
  await h.run(valid, { engine: "von" });
  expect(launchesOf(dirB).length === warm && alive(von2.pid), "deuxième appel Von : réutilise le Von déjà lancé (pas de relance)");

  // appels simultanés : un seul moteur vivant à tout instant
  let stopSampling = false;
  let samples = 0;
  let both = 0;
  const sampler = (async () => {
    while (!stopSampling) {
      const [a, b] = await Promise.all([portOpen(LAYA_LAZY), portOpen(VON_LAZY)]);
      samples += 1;
      if (a && b) both += 1;
      await sleep(25);
    }
  })();
  const burst = await Promise.all(["laya", "von", "laya", "von", "laya"].map((engine) => h.run(valid, { engine })));
  stopSampling = true;
  await sampler;
  const all = launchesOf(dirB);
  for (const x of all) children.add(x.pid);
  expect(burst.every((x, i) => x.engine === ["laya", "von", "laya", "von", "laya"][i] && x.answers.ok.engine === x.engine),
    "5 appels simultanés en alternance : chacun servi par le bon moteur", dump(burst.map((x) => x.engine)));
  expect(both === 0 && samples > 5, "jamais les deux moteurs à l'écoute en même temps (échantillonnage toutes les ~25 ms)", `${both}/${samples}`);
  expect(all.length >= 6 && all.every((x) => x.otherAlive === false), `chaque démarrage (${all.length}) a eu lieu moteur voisin arrêté`, dump(all.filter((x) => x.otherAlive)));
  const laya3 = all.filter((x) => x.name === "laya").at(-1);
  const alivePids = all.filter((x) => alive(x.pid));
  expect(alivePids.length === 1 && alivePids[0].name === "laya" && alivePids[0].pid === laya3.pid,
    "après la rafale : un seul processus lancé encore vivant (le dernier moteur servi)", dump(alivePids.map((x) => [x.name, x.pid])));

  // inactivité
  killChildren();
  await waitUntil(async () => !(await portOpen(LAYA_LAZY)) && !(await portOpen(VON_LAZY)), 5000);
  process.env.DECIDE_IDLE_MS = IDLE;
  h = await harness(lazyEnv(newLaunchDir(), { DECIDE_IDLE_MS: IDLE }));
  const dirIdle = process.env.FAKE_DIR;
  const idleStart = Date.now();
  await h.run(valid, { engine: "von" });
  const vonIdle = launchesOf(dirIdle).find((x) => x.name === "von");
  if (vonIdle) children.add(vonIdle.pid);
  await sleep(1500);
  await h.run(valid, { engine: "von" }); // l'usage remet le compteur à zéro
  const touchedAt = Date.now();
  await sleep(1800);
  expect(alive(vonIdle.pid) && (await portOpen(VON_LAZY)), "inactivité 1,8 s < 2,5 s après le dernier appel : Von toujours vivant (compteur remis à zéro)");
  const stopped = await waitUntil(async () => !alive(vonIdle.pid) && !(await portOpen(VON_LAZY)), 8000);
  const idleMs = Date.now() - touchedAt;
  expect(stopped && idleMs >= 2000 && Date.now() - idleStart > 4000, `Von arrêté après l'inactivité (DECIDE_IDLE_MS=${IDLE}) ; ~${idleMs} ms après le dernier appel`, `stopped=${stopped}`);
  expect(h.logs.some((l) => /arrêt de Von \(inactif depuis \d+ s\)/.test(l)),
    "arrêt d'inactivité journalisé", h.logs.join(" | "));
  await h.run(valid, { engine: "von" });
  const relaunched = launchesOf(dirIdle).filter((x) => x.name === "von");
  if (relaunched.at(-1)) children.add(relaunched.at(-1).pid);
  expect(relaunched.length === 2 && relaunched[1].pid !== vonIdle.pid, "après l'arrêt d'inactivité : relancé à la demande (nouveau pid)");
  const dirDef = newLaunchDir();
  h = await harness(lazyEnv(dirDef, { DECIDE_IDLE_MS: undefined }));
  expect(h.logs.length >= 1, "DECIDE_IDLE_MS absent : valeur par défaut (10 min) sans erreur au chargement");

  // =====================================================================================
  section("C. serveur déjà présent laissé en place ; exécutable absent, non local, qui plante");
  const dirC = newLaunchDir();
  killChildren();
  h = await harness(lazyEnv(dirC, { LAYA_URL: url(LAYA_EXT), FAKE_VON_OTHER: String(LAYA_EXT) }));
  await h.run(valid, { engine: "von" });
  const vonC = launchesOf(dirC).find((x) => x.name === "von");
  if (vonC) children.add(vonC.pid);
  const seenLayaBefore = seen.laya.length;
  r = await h.run(valid, { engine: "laya" });
  expect(r.engine === "laya" && seen.laya.length === seenLayaBefore + 1, "Laya déjà présent (non lancé par nous) : utilisé tel quel");
  expect(!alive(vonC.pid), "notre Von a été arrêté pour faire place (mémoire) même si Laya était déjà là");
  await h.run(valid, { engine: "von" });
  const vonC2 = launchesOf(dirC).filter((x) => x.name === "von").at(-1);
  if (vonC2) children.add(vonC2.pid);
  expect(await portOpen(LAYA_EXT) && alive(vonC2.pid), "Laya externe jamais arrêté ; Von lancé quand même");
  expect(h.logs.some((l) => /Laya écoute déjà.*sans avoir été lancé par le tableau de bord.*laissé en place/.test(l)),
    "le journal dit que le Laya externe est laissé en place", h.logs.filter((l) => /laissé/.test(l)).join(" | "));
  expect(vonC2.otherAlive === true, "(le faux Von constate bien le Laya externe : il n'a pas été touché)");

  h = await harness({ ...baseEnv, VON_URL: url(CLOSED), VON_BIN: join(scratch, "nexiste-pas.exe") });
  const absent = await reject(h.run(valid, { engine: "von" }));
  expect(absent?.status === 503 && absent.code === "von_unavailable" && /Von est absent.*nexiste-pas/.test(absent.message) && /continue de fonctionner/.test(absent.message),
    "VON_BIN absent : 503 en français", absent?.message);
  h = await harness({ ...baseEnv, VON_URL: "http://192.0.2.1:8766/v1/systemone", VON_BIN: process.execPath });
  const remote = await reject(h.run(valid, { engine: "von" }));
  expect(remote?.status === 503 && /ne se lance automatiquement que sur cette machine/.test(remote.message), "VON_URL non locale : jamais de lancement", remote?.message);
  killChildren();
  await waitUntil(async () => !(await portOpen(VON_LAZY)), 5000);
  process.chdir(emptyDir); // aucun fichier « serve » ici : node s'arrête tout de suite avec un code d'erreur
  h = await harness({ ...baseEnv, VON_URL: url(VON_LAZY), VON_BIN: process.execPath, VON_START_TIMEOUT_MS: "20000" });
  const t0 = Date.now();
  const crash = await reject(h.run(valid, { engine: "von" }));
  expect(crash?.status === 503 && /Von s'est arrêté au démarrage \(code \d+\)/.test(crash.message) && Date.now() - t0 < 10_000,
    "Von qui plante au démarrage : 503 explicite, sans attendre le délai complet", `${crash?.message} (${Date.now() - t0} ms)`);
  process.chdir(scratch);
  h = await harness(lazyEnv(newLaunchDir(), { VON_BIN: process.execPath, VON_START_TIMEOUT_MS: "1" }));
  const slow = await reject(h.run(valid, { engine: "von" }));
  expect(slow?.status === 503 && /Von n'a pas répondu dans les/.test(slow.message), "délai de démarrage dépassé : 503, Von arrêté", slow?.message);
  expect(await waitUntil(async () => !(await portOpen(VON_LAZY)), 6000), "délai de démarrage dépassé : plus aucun Von à l'écoute");
  process.chdir(startCwd);

  // =====================================================================================
  section("D. route REST POST /api/v1/decide (instance isolée) et sentinelle de Von");
  function startServer(env, cwd) {
    const e = { ...process.env, DASHBOARD_PORT: String(PORT), DASHBOARD_DATA_DIR: join(scratch, "data"), DASHBOARD_HOST: "127.0.0.1", ...env };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    delete e.DASHBOARD_PASSWORD;
    const proc = spawn(process.execPath, [join(dashboardDir, "server.mjs")], { env: e, cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const s = { proc, log: "", base: `http://127.0.0.1:${PORT}` };
    proc.stdout.on("data", (d) => { s.log += d; });
    proc.stderr.on("data", (d) => { s.log += d; });
    return s;
  }
  const ready = async (s) => { for (let i = 0; i < 300 && !s.log.includes("Paseo dashboard :"); i++) await sleep(100); return s; };
  const post = async (s, body) => {
    const res = await fetch(`${s.base}/api/v1/decide`, { method: "POST", headers: { "Content-Type": "application/json", "X-Agent-Name": "verify-decide-von" }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const stop = async (s) => { if (s.proc.exitCode !== null) return; const gone = new Promise((x) => s.proc.once("exit", x)); s.proc.kill(); await gone; };
  if (await portOpen(PORT)) throw new Error(`le port ${PORT} est déjà utilisé : choisissez VERIFY_PORT`);
  srv = await ready(startServer({ ...baseEnv, LAYA_URL: url(LAYA_EXT), VON_URL: url(VON_EXT) }, rootDir));
  const layaN = seen.laya.length;
  const vonN = seen.von.length;
  let res = await post(srv, valid);
  expect(res.status === 200 && res.json.data?.engine === "laya" && seen.laya.length === layaN + 1 && seen.von.length === vonN, "REST sans engine : Laya", dump(res.json).slice(0, 200));
  res = await post(srv, { ...valid, engine: "von" });
  expect(res.status === 200 && res.json.data?.engine === "von" && res.json.data.answers.ok.engine === "von" && seen.von.at(-1).body.model === "von",
    "REST engine « von » : relayé à Von (modèle von)", dump(res.json).slice(0, 200));
  res = await post(srv, { ...valid, engine: "laya" });
  expect(res.status === 200 && res.json.data?.engine === "laya", "REST engine « laya » : Laya");
  const restBefore = seen.laya.length + seen.von.length;
  for (const wrong of ["gpt", "", 7, ["von"]]) {
    res = await post(srv, { ...valid, engine: wrong });
    expect(res.status === 400 && res.json.ok === false && res.json.error?.code === "bad_request", `REST engine ${dump(wrong)} : HTTP 400 bad_request`, dump(res.json).slice(0, 160));
  }
  expect(seen.laya.length + seen.von.length === restBefore, "REST : un engine refusé n'atteint aucun moteur");
  const activity = JSON.parse(readFileSync(join(scratch, "data", "agent-activity.json"), "utf8"));
  expect(activity.some((e) => /^Décision demandée/.test(e.summary)) && !JSON.stringify(activity).includes(valid.state), "REST : journal d'activité sans le texte de l'état");
  await stop(srv);
  srv = null;

  killChildren();
  await waitUntil(async () => !(await portOpen(VON_LAZY)) && !(await portOpen(LAYA_LAZY)), 5000);
  const dirD = newLaunchDir();
  srv = await ready(startServer(lazyEnv(dirD, { DECIDE_IDLE_MS: "600000" }), scratch));
  res = await post(srv, { ...valid, engine: "von" });
  const vonD = launchesOf(dirD).find((x) => x.name === "von");
  if (vonD) children.add(vonD.pid);
  expect(res.status === 200 && res.json.data?.engine === "von" && vonD && alive(vonD.pid), "REST : Von lancé paresseusement par le tableau de bord", dump(res.json).slice(0, 200));
  expect(vonD?.leaks.length === 0, "REST : Von lancé par le serveur sans aucun secret dans son environnement", dump(vonD?.leaks));
  srv.proc.kill(); // arrêt brutal : aucun gestionnaire de sortie ne s'exécute, seule la sentinelle peut arrêter Von
  srv = null;
  expect(await waitUntil(async () => !alive(vonD.pid) && !(await portOpen(VON_LAZY)), 12_000), "arrêt brutal du tableau de bord : la sentinelle arrête Von", `pid ${vonD?.pid}`);

  // =====================================================================================
  section("E. test RÉEL avec le vrai Von (REAL_VON=1)");
  const realBin = USER_VON_BIN || "D:\\Projets\\AI-OS\\paseo-lab\\.foreman\\von-test\\Scripts\\von.exe";
  const freeGb = freemem() / 1024 ** 3;
  if (process.env.REAL_VON !== "1") {
    console.log("[IGNORÉ] REAL_VON=1 non demandé : le vrai Von n'est pas lancé");
  } else if (!existsSync(realBin)) {
    console.log(`[IGNORÉ] ${realBin} introuvable`);
  } else if (freeGb < 3) {
    console.log(`[IGNORÉ] RAM libre ${freeGb.toFixed(1)} Go < 3 Go : le vrai Von n'est pas lancé`);
  } else if (await portOpen(REAL_PORT) || await portOpen(8765) || await portOpen(8766)) {
    console.log("[IGNORÉ] un serveur de décision écoute déjà (8765/8766/18776) : pas de second moteur en parallèle");
  } else {
    console.log(`RAM libre : ${freeGb.toFixed(1)} Go ; lancement du vrai Von sur le port ${REAL_PORT}`);
    h = await harness({ ...baseEnv, VON_URL: url(REAL_PORT), VON_BIN: realBin, LAYA_URL: url(CLOSED), DECIDE_IDLE_MS: "4000", VON_START_TIMEOUT_MS: "180000" });
    const ask = (summary) => h.run({
      state: `Tâche demandée : Ajouter la fonction sum\nCompte-rendu de l'agent : ${summary}`,
      questions: { ok: { type: "noul", instructions: "Le compte-rendu confirme que la tâche demandée a été réalisée en entier et avec succès, sans erreur ni question restante" } },
    }, { engine: "von" });
    const started = Date.now();
    const good = await ask("La fonction sum(a, b) a été ajoutée dans src/sum.js et les 12 tests passent.");
    console.log(`[RÉEL] démarrage + 1er appel : ${Date.now() - started} ms ; succès : ${dump(good.answers)}`);
    const bad = await ask("Je n'ai pas pu terminer : le build a échoué avec une erreur 402, rien n'a été modifié.");
    console.log(`[RÉEL] 2e appel (échec) : ${bad.latencyMs} ms ; ${dump(bad.answers)}`);
    expect(typeof good.answers.ok?.noul === "number" && good.engine === "von", "[RÉEL] Von lancé paresseusement, champ noul numérique", dump(good));
    expect(good.answers.ok.noul > 0.5 && bad.answers.ok.noul < 0.5, `[RÉEL] succès > 0,5 et échec < 0,5 (${good.answers.ok.noul} / ${bad.answers.ok.noul})`);
    expect(await waitUntil(async () => !(await portOpen(REAL_PORT)), 20_000), "[RÉEL] Von arrêté après l'inactivité (4 s)");
  }
} catch (e) {
  fail("exception inattendue", e.stack || e.message);
} finally {
  process.chdir(startCwd);
  if (srv && srv.proc.exitCode === null) srv.proc.kill();
  killChildren();
  extLaya.close(); extVon.close(); extLaya.closeAllConnections?.(); extVon.closeAllConnections?.();
}
console.log(`\n=== BILAN : ${passed} OK, ${failed} FAIL ===`);
if (failed) { console.log(`journaux : ${scratch}`); process.exit(1); }
await sleep(300);
try { rmSync(scratch, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); } catch { /* ignoré */ }
console.log("VERIFY_DECIDE_VON_PASS");
process.exit(0);
