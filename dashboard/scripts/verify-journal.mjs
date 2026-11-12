// dashboard/scripts/verify-journal.mjs
// Vérification du ticket T42 : rapport de fin de mission (handlers/missionreport.mjs) + journal par projet
// (handlers/journal.mjs, vue public/js/views/journal.js).
// Instance ISOLÉE (port 7097 ou VERIFY_PORT, dossier de données jetable, liste de machines jetable SANS machine
// joignable : aucun appel à un daemon, aucun appel LLM). Ne touche ni au :7070, ni à dashboard/data, ni à hosts.json.
// Aucune écriture git dans un vrai projet : le dépôt de test est un dossier jetable (git init + git add, jamais de
// commit). Les tâches de test (faux orchestrateur « Jarvis — … », enfants) sont écrites dans la base jetable.
//   VERIFY_BROWSER=0 : saute les captures playwright-cli ; VERIFY_KEEP=1 : garde le dossier jetable.
// Captures : dashboard/screenshots/journal-*.png
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { outcomeOf, scrub, verdictOf, nextStep, reportText, missionOf } from "../handlers/missionreport.mjs";
import { dayRange } from "../handlers/journal.mjs";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = join(dashboardDir, "..");
const PORT = Number(process.env.VERIFY_PORT || 7097);
if (PORT === 7070) throw new Error("Le port 7070 est celui du serveur de Philippe : refusé.");
const BASE = `http://127.0.0.1:${PORT}`;
const scratch = join(rootDir, ".foreman", "scratch", `t42-journal-${process.pid}`);
const dataDir = join(scratch, "data");
const projDir = join(scratch, "journal-proj");
const otherDir = join(scratch, "autre-dossier");
const shotsDir = join(dashboardDir, "screenshots");
const hostsFile = join(scratch, "hosts-jetable.json");
const toWin = (p) => p.replace(/\//g, "\\");
const slash = (p) => p.replace(/\\/g, "/");
const J = JSON.stringify;

let passed = 0;
let failed = 0;
const ok = (label) => { passed += 1; console.log(`OK   ${label}`); };
const fail = (label, detail = "") => {
  failed += 1;
  console.error(`FAIL ${label}${detail ? ` -> ${detail}` : ""}`);
};
const expect = (cond, label, detail = "") => (cond ? ok(label) : fail(label, detail));
const section = (name) => console.log(`\n=== ${name} ===`);

const pad = (n) => String(n).padStart(2, "0");
const today = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();
const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();

// ---------------------------------------------------------------- dossiers jetables
rmSync(scratch, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(projDir, { recursive: true });
mkdirSync(otherDir, { recursive: true });
const git = (...args) => spawnSync("git", ["-C", projDir, ...args], { encoding: "utf8", windowsHide: true });
git("init", "-q");
writeFileSync(join(projDir, "notes.txt"), "version 1\n");
git("add", "notes.txt"); // index du dépôt JETABLE seulement ; aucun commit
writeFileSync(join(projDir, "notes.txt"), "version 1\nversion 2\n");
writeFileSync(join(projDir, "new.txt"), "nouveau fichier\n");

writeFileSync(hostsFile, J({ hosts: [{ label: "local", url: "ws://127.0.0.1:1/ws" }] }));
// Données semées avant le démarrage (lues par handlers/journal.mjs en lecture seule) : projet suivi, session,
// décisions automatiques, message de groupe.
const projKey = `local|${slash(projDir).toLowerCase()}`;
writeFileSync(join(dataDir, "projects.json"), J({
  version: 1, dismissed: false,
  projects: [{
    id: "p-journal", host: "local", dir: projDir, name: "journal-proj", color: null, addedAt: ago(3600), order: 0,
  }],
}));
writeFileSync(join(dataDir, "timeline.json"), J({
  episodes: [{
    id: "ep-1", host: "local", agentId: "seed-agent", title: "Session de test", provider: "claude-openrouter",
    model: "sonnet", project: "journal-proj", start: ago(50), end: ago(40), status: "closed", markers: [],
  }],
}));
const activity = (id, at, route, ok_, status, summary) =>
  ({ id, at, method: "POST", route, ok: ok_, status, summary, mandateActive: true });
writeFileSync(join(dataDir, "agent-activity.json"), J([
  activity("act-1", ago(30), "/permission", true, 200,
    "Autorisé automatiquement : exécuter node D:/x/tools/postectl.mjs tasks"),
  activity("act-2", ago(29), "/permission", false, 403, "Refusé par le mandat : git push"),
  activity("act-3", ago(28), "/tasks", true, 200, "Tâche créée : bruit hors permissions"),
]));
writeFileSync(join(dataDir, "coord.json"), J({
  reservations: [], roles: {}, settings: {}, bound: {}, observer: null, terms: {},
  messages: [
    { id: "msg-1", at: ago(35), from: "seed:a", fromLabel: "Dev test", to: "team", group: "g-1", project: projKey,
      text: "Je prends notes.txt, personne d'autre n'y touche.", kind: "fyi" },
    { id: "msg-2", at: ago(34), from: "system", fromLabel: "Poste", to: "team", project: projKey,
      text: "« Dev test » a rejoint le projet.", system: true },
  ],
}));

// ---------------------------------------------------------------- serveur isolé
function startServer() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(PASEO_|DASHBOARD_|POSTECTL_|COORD_)/.test(k)),
  );
  Object.assign(env, {
    DASHBOARD_PORT: String(PORT), DASHBOARD_DATA_DIR: dataDir, DASHBOARD_HOST: "127.0.0.1", DASHBOARD_WSL: "0",
    DASHBOARD_HOSTS_FILE: hostsFile, BRAIN_DB: join(dataDir, "brain.sqlite"),
  });
  const proc = spawn(process.execPath, [join(dashboardDir, "server.mjs")], {
    env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const srv = { proc, log: "" };
  proc.stdout.on("data", (d) => { srv.log += d; });
  proc.stderr.on("data", (d) => { srv.log += d; });
  return srv;
}
async function until(fn, label, timeout = 20000, step = 100) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(step);
  }
  fail(`Délai dépassé : ${label}`);
  return null;
}
async function connectWs(srv) {
  await until(() => srv.log.includes("Paseo dashboard :"), "serveur isolé démarré", 40000);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ui`, { origin: BASE });
  const inbox = [];
  ws.on("message", (raw) => { try { inbox.push(JSON.parse(raw.toString())); } catch { /* ignoré */ } });
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  const rpc = async (msg, pred, label, timeout = 15000) => {
    inbox.length = 0;
    ws.send(J(msg));
    return until(() => {
      const i = inbox.findIndex(pred);
      return i >= 0 ? inbox.splice(i, 1)[0] : null;
    }, label, timeout, 25);
  };
  return { ws, rpc };
}
const api = async (path) => {
  const res = await fetch(`${BASE}/api/v1${path}`, { headers: { "X-Agent-Name": "verify-journal" } });
  return { status: res.status, json: await res.json() };
};

// Le port doit être libre : aucun autre serveur ne doit répondre à la place de l'instance jetable.
const portFree = await new Promise((res) => {
  const probe = createServer();
  probe.once("error", () => res(false));
  probe.listen(PORT, "127.0.0.1", () => probe.close(() => res(true)));
});
if (!portFree) {
  rmSync(scratch, { recursive: true, force: true });
  throw new Error(`Le port ${PORT} est déjà utilisé : définir VERIFY_PORT (rien n'est arrêté).`);
}
let srv = startServer();
let client = await connectWs(srv);
const readJson = (name) => JSON.parse(readFileSync(join(dataDir, name), "utf8"));
const type = (t) => (m) => m.type === t;
const missionItems = async () => {
  const r = await client.rpc({ type: "inbox.list", filter: {} }, type("inbox.list"), "inbox.list");
  return (r?.items || []).filter((i) => /^Jarvis a terminé/.test(i.title));
};

let db = null;
const COLS = "id,title,description,project,host,engine,status,summary,error,reason,created_at,updated_at,position,"
  + "origin,agent_run,role";
function insertTask(t) {
  db.prepare(`INSERT INTO tasks (${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    t.id, t.title, t.description || "", t.project, "local", t.engine || "", t.status, t.summary || "", t.error || "",
    t.reason || "", t.created, t.updated || t.created, 0, t.origin ?? "agent", t.run, t.role || "writer");
}
const setTask = (id, status, fields = {}) => db.prepare(
  "UPDATE tasks SET status = ?, summary = ?, reason = ?, error = ?, updated_at = ? WHERE id = ?",
).run(status, fields.summary || "", fields.reason || "", fields.error || "", new Date().toISOString(), id);

try {
  // ---------------------------------------------------------------- unitaire : fonctions pures
  section("Fonctions pures");
  const dirty = "Fichier D:/Projets/MonProjet/src/a.js et D:\\Projets\\Autre\\b.txt "
    + "et C:\\Users\\Philippe\\.ssh\\id_rsa "
    + "et /home/philippe/.config/x/secret.json et ~/notes/perso.txt ; password=hunter2 ; "
    + "Authorization: Bearer abcdef0123456789xyz ; clé sk-abcdefghijklmnopqrstu ; "
    + "https://exemple.fr/chemin/page ; et/ou";
  const cleaned = scrub(dirty, "D:\\Projets\\MonProjet");
  expect(cleaned.includes("MonProjet/src/a.js"), "scrub : le dossier du projet devient son nom", cleaned);
  expect(!/Autre|\.ssh|philippe|perso\.txt/i.test(cleaned) && cleaned.split("[chemin hors projet]").length >= 5,
    "scrub : chemins hors projet masqués", cleaned);
  expect(!/hunter2|abcdef0123456789xyz|sk-abcdefghij/.test(cleaned),
    "scrub : mot de passe, jeton et clé masqués", cleaned);
  expect(cleaned.includes("https://exemple.fr/chemin/page") && cleaned.includes("et/ou"),
    "scrub : URL et « et/ou » intacts", cleaned);
  expect(verdictOf("PASS") === "PASS" && verdictOf("  **FAIL** : bug") === "FAIL"
    && verdictOf("PASS_WITH_NOTES x") === "PASS_WITH_NOTES" && verdictOf("Verdict : pass") === "PASS"
    && verdictOf("Le code est PASS") === null && verdictOf("") === null,
  "verdictOf : PASS / FAIL / PASS_WITH_NOTES en première ligne");
  expect(outcomeOf({ status: "review" }) === "review" && outcomeOf({ status: "done" }) === "done",
    "outcomeOf : À valider et Terminé");
  expect(outcomeOf({ status: "blocked", reason: "session perdue" }) === "error"
    && outcomeOf({ status: "blocked", reason: "Arrêtée manuellement" }) === null,
  "outcomeOf : blocage = erreur, arrêt manuel = pas de rapport");
  const erroring = { status: "doing", error: "boom" };
  expect(outcomeOf(erroring, { errorForMs: 1000, graceMs: 60000 }) === null
    && outcomeOf(erroring, { errorForMs: 61000, graceMs: 60000 }) === "error"
    && outcomeOf({ status: "doing", error: "" }) === null && outcomeOf({ status: "todo" }) === null,
  "outcomeOf : erreur transitoire attendue 60 s");
  const described = {
    description: "intro\n\nMISSION DE PHILIPPE (son mandat) :\nFaire Y\nsuite\n\nORGANISATION : ...",
  };
  expect(missionOf({ brief: "Faire X" }, null) === "Faire X" && missionOf(null, described) === "Faire Y\nsuite",
    "missionOf : consigne du mandat, sinon extraite de la consigne de l'orchestrateur");
  const longReport = {
    outcome: "done", at: ago(0), mission: "m".repeat(900), next: "n".repeat(400), verdicts: [],
    tasks: Array.from({ length: 40 }, (_, i) => ({
      title: `t${i}`.repeat(30), roleLabel: "rédacteur", engine: "a/b", statusLabel: "Terminé",
      summary: "s".repeat(300),
    })),
    files: { changed: Array.from({ length: 60 }, (_, i) => ` M f${i}.txt`), stat: [" 1 file changed"], note: "" },
  };
  expect(reportText(longReport).length <= 2000, "reportText : 2000 caractères au plus",
    String(reportText(longReport).length));
  const failing = { outcome: "review", tasks: [], verdicts: [{ title: "r", verdict: "FAIL" }], changed: 0 };
  expect(/FAIL/.test(nextStep(failing)),
    "nextStep : un FAIL est signalé");
  const range = dayRange("2026-10-21");
  expect(dayRange("2026-02-30") === null && range.end - range.start >= 23 * 3600e3 && dayRange("hier") === null,
    "dayRange : jour local valide / invalide refusé");

  // ---------------------------------------------------------------- G1 : rapport de mission
  section("G1 : un faux orchestrateur terminé produit UN élément de boîte de réception");
  db = new DatabaseSync(join(dataDir, "brain.sqlite"));
  db.exec("PRAGMA busy_timeout = 4000");
  const enabled = await client.rpc({
    type: "agentmode.enable", project: "journal-proj", launch: false, forbidden: ["supprimer"],
    brief: "Range les notes du dossier et vérifie le résultat. Jeton de test : token=SUPERSECRET123",
  }, (m) => m.type === "agentmode.state" && m.enabled, "agentmode.enable");
  const runId = enabled?.runId;
  expect(Boolean(runId), "mandat actif avec un runId", String(runId));
  const projWin = toWin(projDir);
  const orchId = "t42-orch-1";
  const engine = "claude-openrouter/sonnet";
  insertTask({
    id: orchId, title: "Jarvis — journal-proj", project: projWin, status: "doing", created: ago(45), run: runId,
    engine,
  });
  insertTask({
    id: "t42-dev", title: "Écrire notes.txt", project: projWin, status: "done", created: ago(44), run: runId,
    role: "writer", engine,
    summary: "Fait. password=hunter2 sk-abcdefghijklmnopqrstu ; clé C:\\Users\\Philippe\\.ssh\\id_rsa ; "
      + `/home/philippe/.config/app/secret.json ; modifié ${projWin}\\notes.txt`,
  });
  insertTask({
    id: "t42-rev1", title: "Relire notes.txt", project: projWin, status: "review", created: ago(43), run: runId,
    role: "reader", summary: "PASS_WITH_NOTES Le fichier est bon, une remarque mineure.",
  });
  insertTask({
    id: "t42-rev2", title: "Relire le plan", project: projWin, status: "review", created: ago(42), run: runId,
    role: "reader", summary: "FAIL il manque un test",
  });
  insertTask({
    id: "t42-todo", title: "Écrire la doc", project: projWin, status: "todo", created: ago(41), run: runId,
  });
  insertTask({
    id: "t42-human", title: "Tâche de Philippe (hors mandat)", project: projWin, status: "todo", created: ago(40),
    run: "", origin: "",
  });

  await sleep(7000); // plus d'un cycle de synchronisation (5 s) : l'orchestrateur est encore « En cours »
  expect((await missionItems()).length === 0, "orchestrateur encore En cours : aucun rapport");

  setTask(orchId, "review", { summary: "Compte-rendu : notes rangées, voir les tâches filles." });
  const first = await until(async () => (await missionItems())[0],
    "élément « Jarvis a terminé » dans la boîte de réception", 25000, 500);
  expect(Boolean(first), "rapport ajouté à la boîte de réception");
  console.log(`     élément : ${J({
    id: first?.id, kind: first?.kind, title: first?.title, source: first?.source, project: first?.project,
    taskId: first?.taskId,
  })}`);
  expect(first?.kind === "fin" && first?.source === "agent" && first?.title === "Jarvis a terminé : journal-proj",
    "élément : kind fin, source agent, titre « Jarvis a terminé : journal-proj »");

  for (let i = 0; i < 2; i += 1) {
    const r = await client.rpc({ type: "missionreport.get", runId }, type("missionreport.data"),
      `missionreport.get #${i + 1}`);
    expect(r?.report?.runId === runId && r.reports.length === 1,
      `missionreport.get #${i + 1} : un seul rapport mémorisé`, J(r?.reports));
  }
  await sleep(11500); // au moins deux synchronisations automatiques supplémentaires
  const items = await missionItems();
  expect(items.length === 1, "exactement UN élément après plusieurs synchronisations", `${items.length}`);
  const stored = readJson("mission-reports.json");
  expect(stored.reports.length === 1 && stored.reports[0].runId === runId && stored.reports[0].inboxed === true,
    "data/mission-reports.json : un rapport, inboxed", J(stored.reports.map((r) => [r.runId, r.inboxed])));

  const got = await client.rpc({ type: "missionreport.get", runId }, type("missionreport.data"), "missionreport.get");
  const report = got?.report;
  console.log("--- texte du rapport ---");
  console.log(report?.text);
  console.log("--- fin du texte ---");
  expect(report?.outcome === "review" && report.project === "journal-proj",
    "rapport : issue « review », projet journal-proj");
  expect(report?.mission.startsWith("Range les notes"), "rapport : mission = consigne du mandat", report?.mission);
  const ids = report?.tasks.map((t) => t.id) || [];
  expect(ids.length === 4 && !ids.includes(orchId) && !ids.includes("t42-human"),
    "rapport : 4 tâches filles, ni l'orchestrateur ni la tâche hors mandat", J(ids));
  const roleOf = (id) => report?.tasks.find((t) => t.id === id)?.roleLabel;
  expect(roleOf("t42-dev") === "rédacteur" && roleOf("t42-rev1") === "lecteur", "rapport : rôle de chaque tâche fille");
  const verdicts = report?.verdicts.map((v) => v.verdict) || [];
  expect(verdicts.length === 2 && verdicts.includes("PASS_WITH_NOTES") && verdicts.includes("FAIL"),
    "rapport : verdicts des relecteurs", J(report?.verdicts));
  expect(/FAIL/.test(report?.next || ""), "rapport : prochaine étape tient compte du FAIL", report?.next);
  const files = report?.files;
  expect(files?.changed.some((l) => /notes\.txt/.test(l)) && files.changed.some((l) => /new\.txt/.test(l))
    && files.stat.some((l) => /notes\.txt/.test(l)),
  "rapport : fichiers modifiés (git status) et bilan (git diff --stat)", J(files));
  const everything = J(report) + J(first);
  expect(!/hunter2|SUPERSECRET123|sk-abcdefghij/.test(everything), "rapport : aucun mot de passe ni jeton");
  const lower = everything.toLowerCase();
  expect(!/users[\\/]+philippe|philippe[\\/]\.config|\.ssh/.test(lower.replace(/\\\\/g, "\\"))
    && !lower.includes(slash(scratch).toLowerCase()) && !lower.includes(scratch.toLowerCase().replace(/\\/g, "\\\\")),
  "rapport : aucun chemin hors projet (ni chemin absolu du dossier jetable)");
  expect(report?.text.includes("[chemin hors projet]") && /journal-proj[\\/]notes\.txt/.test(report.text),
    "rapport : chemins du projet relatifs, autres masqués");
  expect(report?.text.length <= 2000 && first?.body.length <= 600,
    "rapport : texte ≤ 2000 car. (boîte de réception : 600)", `${report?.text.length}/${first?.body.length}`);

  // Scénario B : deux autres exécutions, seulement dans la base (titre « Jarvis — … » + consigne parsée).
  section("G1b : erreur, arrêt manuel, dossier hors git");
  const desc = "Tu es JARVIS.\n\nMISSION DE PHILIPPE (son mandat, a lire d'abord) :\nNettoyer le dossier de test.\n\n"
    + "ORGANISATION : ...";
  const other = toWin(otherDir);
  insertTask({ id: "t42-orch-err", title: "Jarvis — autre-dossier", description: desc, project: other, status: "doing",
    created: ago(20), run: "run-err" });
  insertTask({
    id: "t42-err-child", title: "Tâche en échec", project: other, status: "blocked", reason: "session perdue",
    created: ago(19), run: "run-err",
  });
  insertTask({ id: "t42-orch-stop", title: "Jarvis — arrêté", project: other, status: "doing", created: ago(18),
    run: "run-stop" });
  setTask("t42-err-child", "blocked", { reason: "session perdue" });
  setTask("t42-orch-err", "blocked", { reason: "session perdue" });
  setTask("t42-orch-stop", "blocked", { reason: "Arrêtée manuellement" });
  const second = await until(async () => {
    const i = await missionItems();
    return i.length >= 2 ? i : null;
  }, "second rapport (erreur)", 25000, 500);
  await sleep(6000);
  const after = await missionItems();
  expect(after.length === 2 && Boolean(second), "deux éléments au total : l'arrêt manuel ne produit aucun rapport",
    `${after.length}`);
  const reportOf = async (id) =>
    (await client.rpc({ type: "missionreport.get", runId: id }, type("missionreport.data"), `rapport ${id}`))?.report;
  const errReport = await reportOf("run-err");
  expect(errReport?.outcome === "error" && errReport.mission === "Nettoyer le dossier de test.",
    "rapport d'erreur : issue error, mission extraite de la consigne", J([errReport?.outcome, errReport?.mission]));
  expect(/échec|erreur/i.test(errReport?.next || "") && /dépôt git/.test(errReport?.files.note || ""),
    "rapport d'erreur : prochaine étape et « pas un dépôt git »", J([errReport?.next, errReport?.files.note]));
  expect((await reportOf("run-stop")) === null, "arrêt manuel : pas de rapport");

  // ---------------------------------------------------------------- G2 : journal
  section("G2 : journal du jour");
  const getJournal = (msg, label) => client.rpc({ type: "journal.get", ...msg }, type("journal.data"), label);
  const j = await getJournal({ day: today }, "journal.get");
  const proj = j?.projects.find((p) => p.name === "journal-proj");
  console.log(`     projets : ${J((j?.projects || []).map((p) => [p.name, p.host, p.events.length]))}`);
  for (const e of proj?.events || []) console.log(`       ${e.at.slice(11, 19)} ${e.kind}/${e.state} ${e.text}`);
  expect(j?.day === today && Boolean(proj) && proj.dir === projDir && proj.host === "local",
    "journal.data {day, projects[{name, dir, host, events}]}",
    J(proj && { name: proj.name, dir: proj.dir, host: proj.host }));
  const texts = (proj?.events || []).map((e) => e.text);
  const has = (prefix, part) => texts.some((x) => x.startsWith(prefix) && x.includes(part));
  const created = ["Écrire notes.txt", "Relire notes.txt", "Relire le plan", "Écrire la doc", "Jarvis — journal-proj"];
  for (const t of created) {
    expect(has("Tâche créée", t), `journal : « Tâche créée : ${t} »`);
  }
  expect(has("Tâche créée", "Tâche de Philippe"), "journal : tâche de Philippe aussi présente");
  expect(has("Tâche terminée", "Écrire notes.txt"), "journal : tâche terminée (état daté par updatedAt)");
  expect(has("Tâche à valider", "Jarvis — journal-proj"), "journal : orchestrateur à valider");
  expect(has("Session lancée", "Session de test") && has("Session terminée", "Session de test"),
    "journal : session lancée et fermée (timeline.json)");
  expect(has("Autorisé automatiquement", "postectl tasks") && has("Refusé par le mandat", "git push"),
    "journal : décisions de permission automatiques");
  expect(!texts.some((x) => x.includes("bruit hors permissions")),
    "journal : les autres appels de l'agent ne sont pas des décisions de permission");
  expect(has("Dev test → équipe", "Je prends notes.txt") && !texts.some((x) => x.includes("a rejoint le projet")),
    "journal : message de groupe (messages système exclus)");
  const rapport = (proj?.events || []).find((e) => e.kind === "rapport");
  expect(rapport?.runId === runId, "journal : rapport de mission avec son runId", J(rapport));
  expect(proj.events.every((e, i, a) => i === 0 || Date.parse(a[i - 1].at) <= Date.parse(e.at)),
    "journal : événements en ordre chronologique");
  const second2 = j?.projects.find((p) => p.name === "autre-dossier");
  expect(Boolean(second2) && second2.events.some((e) => e.kind === "rapport"),
    "journal : second projet avec son rapport d'erreur");
  const only = await getJournal({ day: today, project: "JOURNAL-PROJ" }, "journal.get projet");
  expect(only?.projects.length === 1 && only.projects[0].name === "journal-proj",
    "journal.get {project} : filtre insensible à la casse");
  const empty = await getJournal({ day: "2001-01-01" }, "journal.get jour vide");
  expect(empty?.projects.length === 0, "journal.get : jour sans événement = liste vide");
  const bad = await client.rpc({ type: "journal.get", day: "demain" }, type("error"), "jour invalide");
  expect(/AAAA-MM-JJ/.test(bad?.message || ""), "journal.get : jour invalide refusé clairement", bad?.message);

  // transitions observées (au-delà du dernier état) : une tâche qui change de colonne devant le journal
  setTask("t42-todo", "doing");
  await getJournal({ day: today }, "journal.get (observation)");
  setTask("t42-todo", "review", { summary: "ok" });
  const j2 = await getJournal({ day: today }, "journal.get (observation 2)");
  const states = j2?.projects.find((p) => p.name === "journal-proj")?.events
    .filter((e) => e.text.includes("Écrire la doc")).map((e) => e.state);
  expect(states?.includes("doing") && states.includes("review") && states.includes("created"),
    "journal : transitions observées conservées (créée, démarrée, à valider)", J(states));
  expect(readJson("journal.json").events.length >= 2, "data/journal.json : transitions enregistrées");

  // ---------------------------------------------------------------- REST
  section("G3 : route REST et texte compact");
  const rest = await api(`/journal?day=${today}`);
  expect(rest.status === 200 && rest.json.ok && rest.json.data.day === today
    && rest.json.data.projects.some((p) => p.name === "journal-proj"),
  "GET /api/v1/journal?day= : 200 et même contenu", `${rest.status}`);
  const restP = await api(`/journal?day=${today}&project=autre-dossier`);
  expect(restP.json.data?.projects.length === 1, "GET /api/v1/journal?project= : filtre");
  const restBad = await api("/journal?day=pas-un-jour");
  expect(restBad.status === 400 && restBad.json.error.code === "bad_request",
    "GET /api/v1/journal?day=invalide : 400", `${restBad.status}`);
  const txt = await api(`/journal?day=${today}&format=text&maxChars=600`);
  const summary = txt.json.data?.text || "";
  console.log(`--- résumé texte (${summary.length} car.) ---\n${summary}\n--- fin ---`);
  expect(txt.status === 200 && summary.length <= 600 && summary.includes("journal-proj")
    && summary.includes("autre-dossier") && /Rapport de mission/.test(summary),
  "summaryText : texte compact ≤ maxChars, chaque projet représenté, rapports en tête", `${summary.length}`);
  const restReports = await api("/mission-reports");
  expect(restReports.json.data?.reports.length === 2, "GET /api/v1/mission-reports : 2 rapports");

  // ---------------------------------------------------------------- G4 : redémarrage
  section("G4 : redémarrage du serveur, toujours un seul élément par exécution");
  client.ws.close();
  srv.proc.kill();
  await sleep(1500);
  srv = startServer();
  client = await connectWs(srv);
  await sleep(12000);
  const again = await missionItems();
  expect(again.length === 2, "après redémarrage : toujours 2 éléments (un par exécution)", `${again.length}`);
  expect(readJson("mission-reports.json").reports.length === 2, "après redémarrage : 2 rapports mémorisés");

  // ---------------------------------------------------------------- G5 : navigateur
  section("G5 : vue Journal dans un navigateur (playwright-cli)");
  if (process.env.VERIFY_BROWSER === "0") console.log("     (sauté : VERIFY_BROWSER=0)");
  else {
    mkdirSync(shotsDir, { recursive: true });
    const pw = (...args) => {
      const r = spawnSync("playwright-cli", ["-s=t42", ...args], {
        encoding: "utf8", shell: true, windowsHide: true, timeout: 90000,
      });
      return `${r.stdout || ""}${r.stderr || ""}`;
    };
    const evalJs = (expr) => pw("eval", J(expr)).replace(/\r/g, "");
    const shot = (name) => pw("screenshot", `--filename=${join(shotsDir, `${name}.png`)}`);
    pw("open", `${BASE}/#journal`);
    pw("resize", "1280", "800");
    await sleep(2500);
    const snap = pw("snapshot");
    expect(/Journal/.test(snap) && /journal-proj/.test(snap) && /Voir le rapport/.test(snap),
      "vue : onglet Journal, projet et bouton « Voir le rapport »");
    shot("journal-dark-1280");
    const click = evalJs("(() => { document.querySelector('.journal-report .btn').click(); return 'clic'; })()");
    await sleep(1500);
    const reportShown = evalJs(
      "document.querySelector('.journal-report-text:not([hidden])')?.textContent.slice(0, 120) || 'AUCUN'");
    expect(/Statut : /.test(reportShown), "vue : « Voir le rapport » affiche le texte du rapport",
      `${click.trim()} ${reportShown.trim()}`);
    shot("journal-dark-report-1280");
    evalJs("document.documentElement.dataset.theme = 'light'");
    await sleep(500);
    shot("journal-light-1280");
    const collapse = evalJs("(() => { const b = document.querySelector('.journal-project-head'); b.click(); "
      + "return document.querySelector('.journal-project-head').getAttribute('aria-expanded'); })()");
    expect(/false/.test(collapse), "vue : projet repliable (aria-expanded=false)", collapse.trim());
    evalJs("document.querySelector('.journal-project-head').click()");
    pw("resize", "390", "844");
    await sleep(1000);
    const overflow = evalJs("({ page: document.documentElement.scrollWidth - document.documentElement.clientWidth, "
      + "view: document.querySelector('.view').scrollWidth - document.querySelector('.view').clientWidth, "
      + "vw: innerWidth })");
    const measured = (overflow.match(/\{[^}]*\}/) || [overflow])[0].replace(/\s+/g, " ");
    console.log(`     débordement horizontal à 390 px : ${measured}`);
    expect(/"page": 0\b/.test(overflow) && /"view": 0\b/.test(overflow) && /"vw": 390/.test(overflow),
      "vue : 390 px sans défilement horizontal (scrollWidth === clientWidth)");
    shot("journal-light-390");
    evalJs("document.documentElement.dataset.theme = 'dark'");
    await sleep(500);
    shot("journal-dark-390");
    const consoleOut = pw("console", "error");
    console.log(`     console (erreurs) : ${consoleOut.replace(/\s+/g, " ").trim().slice(0, 300)}`);
    expect(/Errors: 0/.test(consoleOut), "vue : console sans erreur");
    pw("close");
    for (const f of ["journal-dark-1280", "journal-dark-report-1280", "journal-light-1280", "journal-light-390",
      "journal-dark-390"]) {
      expect(existsSync(join(shotsDir, `${f}.png`)), `capture ${f}.png`);
    }
  }
} catch (error) {
  fail("exception du script", error?.stack || String(error));
} finally {
  try { db?.close(); } catch { /* fermée */ }
  try { client?.ws.close(); } catch { /* fermé */ }
  try { srv?.proc.kill(); } catch { /* arrêté */ }
  await sleep(800);
  if (process.env.VERIFY_KEEP !== "1") {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
  console.log(`\n${failed ? "ECHEC" : "SUCCES"} : ${passed} vérifications réussies, ${failed} échec(s)`);
  process.exitCode = failed ? 1 : 0;
}
