// dashboard/scripts/verify-thread.mjs
// Vérification du ticket T38 : fil de discussion intelligent entre sessions (messages typés, fils, résumé roulant « digest »,
// décision → proposition de fiche projet, anti-bavardage, relance unique, routage par rôle, archivage, compatibilité). AUCUN appel LLM :
// faux hôte Paseo + VRAIS handlers, serveur MCP et CLI réels, puis une instance jetable du tableau de bord (autre port, données jetables)
// pilotée par un vrai client WebSocket et Playwright. Ne touche ni à :7070, ni à dashboard/data, ni à hosts.json.
//   VERIFY_PART : a (règles pures), b (backend), c (serveur MCP + CLI), d (instance réelle : navigateur) ; vide = tout.
//   VERIFY_HEADLESS=0 pour voir le navigateur ; VERIFY_PORT (défaut 7121).
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = join(dashboardDir, "..");
const work = join(rootDir, ".foreman", "scratch", `t38-thread-${process.pid}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const PART = process.env.VERIFY_PART || "";
const run = (part) => PART === "" || PART === part;
const HEADLESS = process.env.VERIFY_HEADLESS !== "0";
const PORT = Number(process.env.VERIFY_PORT || 7121);

let passed = 0;
let failed = 0;
const ok = (label) => { passed++; console.log(`OK   ${label}`); };
const fail = (label, detail = "") => { failed++; console.error(`FAIL ${label}${detail ? ` -> ${detail}` : ""}`); };
const expect = (cond, label, detail = "") => (cond ? ok(label) : fail(label, detail));
const section = (name) => console.log(`\n=== ${name} ===`);
async function until(fn, label, timeout = 9000, step = 60) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  fail(`Délai dépassé : ${label}`);
  return null;
}
const slash = (p) => p.replace(/\\/g, "/");
const killers = [];
let finished = false;
const finish = () => {
  if (finished) return;
  finished = true;
  for (const k of killers) { try { k(); } catch { /* déjà arrêté */ } }
  console.log(`\n=== BILAN : ${passed} OK, ${failed} FAIL ===`);
  if (failed === 0 && passed > 0) console.log("VERIFY_THREAD_PASS");
  if (!(failed > 0 && process.env.VERIFY_KEEP === "1")) {
    try { rmSync(work, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); } catch { /* verrouillé */ }
    if (existsSync(work)) {
      try {
        spawn(process.execPath, ["-e", "const [d]=process.argv.slice(1);setTimeout(()=>{try{require('fs').rmSync(d,{recursive:true,force:true,maxRetries:20,retryDelay:300})}catch{}},1500)", work],
          { detached: true, stdio: "ignore", windowsHide: true }).unref();
      } catch { /* sans effet */ }
    }
  }
  process.exit(failed > 0 || passed === 0 ? 1 : 0);
};
const crash = (e) => { fail("exception non interceptée", String(e?.stack || e).split("\n").slice(0, 3).join(" | ")); finish(); };
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

const L = await import(pathToFileURL(join(dashboardDir, "lib", "coord.mjs")).href);
const {
  MSG_KINDS, THREAD_LIMITS, WAKE_KINDS, parseMeta, shouldWake, isAck, mentionsInText, indexThreads, splitForArchive, loopCheck,
  buildDigest, normKind, pairKey, projectKey,
} = L;

const iso = (ms) => new Date(ms).toISOString();
const msg = (o) => ({ id: randomUUID(), at: iso(Date.now()), from: "local:a", fromLabel: "Alice", to: "local:b", project: "p", text: "t", readAt: null, ...o });

// =========================================================================================================
if (run("a")) {
  section("A : règles pures (types, validation, fils, digest, archivage, boucle, accusés)");
  expect(MSG_KINDS.join("|") === "question|answer|decision|handoff|blocker|status|fyi", "types : question, answer, decision, handoff, blocker, status, fyi");
  const p0 = parseMeta({ to: "x", text: "y" });
  expect(p0.ok && p0.meta.kind === null && p0.meta.replyTo === null && p0.meta.needsReply === false && p0.meta.by === null && p0.meta.mentions.length === 0, "ancienne forme { to, text } : valide, aucun champ de type");
  expect(normKind({}) === "fyi" && normKind({ kind: "decision" }) === "decision" && normKind({ kind: "inconnu" }) === "fyi", "un message sans type s'affiche « fyi »");
  expect(parseMeta({ kind: "Question" }).meta?.kind === "question" && parseMeta({ kind: "bogus" }).ok === false && /question, answer/.test(parseMeta({ kind: "bogus" }).error) && parseMeta({ kind: 5 }).ok === false, "kind : insensible à la casse, valeur inconnue ou non texte refusée avec la liste");
  expect(parseMeta({ replyTo: "abc" }).ok === false && parseMeta({ replyTo: "x".repeat(65) }).ok === false && parseMeta({ replyTo: randomUUID() }).ok === true && parseMeta({ replyTo: 12345678 }).ok === false, "replyTo : identifiant de 8 à 64 caractères attendu");
  expect(parseMeta({ needsReply: "oui" }).ok === false && parseMeta({ needsReply: true }).meta.needsReply === true, "needsReply : booléen strict");
  expect([0, 1441, 1.5, "5", -3].every((by) => parseMeta({ needsReply: true, by }).ok === false) && parseMeta({ needsReply: true, by: 5 }).meta.by === 5 && parseMeta({ by: 5 }).meta.by === null, "by : entier de 1 à 1440 ; ignoré sans needsReply");
  const pm = parseMeta({ mentions: ["@Alice", "alice", "Bob  ", "@Alice"] });
  expect(pm.ok && pm.meta.mentions.join() === "Alice,alice,Bob", "mentions : « @ » retiré, espaces nettoyés, doublons exacts retirés", JSON.stringify(pm));
  expect(parseMeta({ mentions: new Array(9).fill("x") }).ok === false && parseMeta({ mentions: [3] }).ok === false && parseMeta({ mentions: ["@"] }).ok === false && parseMeta({ mentions: "bob" }).ok === false, "mentions : 8 au plus, textes non vides");

  expect(!shouldWake({ kind: "fyi" }) && !shouldWake({ kind: "status" }), "réveil : fyi et status ne réveillent JAMAIS");
  expect(["question", "answer", "decision", "blocker", "handoff"].every((kind) => shouldWake({ kind })) && WAKE_KINDS.size === 5, "réveil : question, answer, decision, blocker, handoff réveillent");
  expect(shouldWake({ kind: "fyi", needsReply: true }) && shouldWake({ kind: "status", needsReply: true }), "réveil : needsReply réveille même un fyi");
  expect(shouldWake({}) === true && shouldWake({}, { legacyWake: false }) === false, "réveil : sans type (ancienne forme) = comportement historique, coupable par legacyWake:false");

  for (const t of ["ok", "OK", "Reçu", "recu", "ok merci", "👍", "Merci !", "bien reçu", "compris, merci", "ok, reçu.", "Thanks", "d'accord", "d’accord", "c’est noté"]) {
    expect(isAck(t), `accusé de réception reconnu : « ${t} »`);
  }
  for (const t of ["ok mais fais X d'abord", "ok, je commence le module auth", "", "x", "ping 0", "reçu : voici la réponse à ta question sur le cache", "non"]) {
    expect(!isAck(t), `pas un accusé : « ${t.slice(0, 40)} »`);
  }
  expect(mentionsInText("@alice peux-tu voir ? cc @Bob-2, @role:reader et a@b.com ou @x ; @types/node").join() === "alice,Bob-2,role:reader", "mentionsInText : @nom, @role:x ; e-mails, noms d'un caractère et noms de paquets (@types/node) ignorés", mentionsInText("@alice peux-tu voir ? cc @Bob-2, @role:reader et a@b.com ou @x ; @types/node").join());

  // fils
  const q = msg({ kind: "question", text: "Quel port ?" });
  const aFyi = msg({ from: "local:b", fromLabel: "Bob", to: "local:a", replyTo: q.id, kind: "fyi", text: "je regarde" });
  let t = indexThreads([q, aFyi]).threads.get(q.id);
  expect(t.open === true && t.answered === false && t.replies.length === 1, "fil : une question n'est PAS fermée par une réponse « fyi »");
  const aAns = msg({ from: "local:b", fromLabel: "Bob", to: "local:a", replyTo: q.id, kind: "answer", text: "7070" });
  t = indexThreads([q, aFyi, aAns]).threads.get(q.id);
  expect(t.open === false && t.answered === true && t.replies.length === 2, "fil : une réponse « answer » ferme la question");
  const self = msg({ replyTo: q.id, kind: "answer", text: "moi-même" });
  expect(indexThreads([q, self]).threads.get(q.id).open === true, "fil : l'auteur ne peut pas fermer sa propre question");
  expect(indexThreads([{ ...q, resolved: true }]).threads.get(q.id).open === false, "fil : « résolu » ferme la question");
  const blk = msg({ kind: "blocker" });
  expect(indexThreads([blk]).threads.get(blk.id).open === true && indexThreads([blk, msg({ from: "local:b", replyTo: blk.id, kind: "decision" })]).threads.get(blk.id).open === false, "fil : un blocage reste ouvert jusqu'à une réponse (answer ou decision)");
  const hand = msg({ kind: "handoff", needsReply: true });
  expect(indexThreads([hand]).threads.get(hand.id).open === true && indexThreads([hand, msg({ from: "local:b", replyTo: hand.id, kind: "fyi" })]).threads.get(hand.id).open === false, "fil : needsReply sur un autre type : n'importe quelle réponse d'un tiers le ferme");
  const g = randomUUID();
  const c1 = msg({ kind: "question", group: g, to: "local:b" });
  const c2 = msg({ kind: "question", group: g, to: "local:c" });
  const rg = msg({ from: "local:c", replyTo: c2.id, kind: "answer" });
  const ig = indexThreads([c1, c2, rg]);
  expect(ig.threads.size === 2 && ig.threads.get(g).copies.length === 2 && ig.threads.get(g).open === false, "fil de groupe : les copies comptent pour un seul fil, une réponse à n'importe quelle copie le ferme");
  expect(indexThreads([msg({ system: true, kind: "question" })]).threads.size === 1 && [...indexThreads([msg({ system: true, kind: "question" })]).threads.values()][0].open === false, "fil : un événement du poste n'est jamais « ouvert »");

  // archivage
  const old = [];
  const base = Date.now() - 1e6;
  for (let i = 0; i < 380; i++) old.push(msg({ at: iso(base + i), kind: i % 3 ? "fyi" : undefined, text: `fyi ${i}` }));
  for (let i = 0; i < 80; i++) old.push(msg({ at: iso(base + 400 + i), kind: "status", text: `status ${i}` }));
  const decs = []; for (let i = 0; i < 30; i++) decs.push(msg({ at: iso(base + 500 + i), kind: "decision", text: `décision ${i}` }));
  const opens = []; for (let i = 0; i < 20; i++) opens.push(msg({ at: iso(base + 600 + i), kind: "question", text: `question ${i}` }));
  const answered = msg({ at: iso(base + 700), kind: "question", text: "répondue" });
  const answer = msg({ at: iso(base + 701), from: "local:b", replyTo: answered.id, kind: "answer", text: "oui" });
  const mixed = [...old, ...decs, ...opens, answered, answer].sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  const sp = splitForArchive(mixed, 500);
  expect(mixed.length === 512 && sp.keep.length === 500 && sp.archive.length === 12, "archivage : 512 messages → 500 vivants, 12 archivés", `${sp.keep.length}/${sp.archive.length}`);
  expect(sp.archive.every((m) => !m.kind || m.kind === "fyi") && sp.archive.map((m) => m.text).join() === old.slice(0, 12).map((m) => m.text).join(), "archivage : seuls les plus anciens fyi / sans type partent d'abord, dans l'ordre");
  expect(decs.every((m) => sp.keep.includes(m)) && opens.every((m) => sp.keep.includes(m)), "archivage : toutes les décisions et tous les fils non résolus sont conservés");
  const big = []; for (let i = 0; i < 300; i++) big.push(msg({ at: iso(base + i), kind: "fyi" }));
  for (let i = 0; i < 300; i++) big.push(msg({ at: iso(base + 400 + i), kind: "question", text: `q${i}` }));
  const sp2 = splitForArchive(big, 500);
  expect(sp2.keep.length === 500 && sp2.keep.filter((m) => m.kind === "fyi").length === 200 || (sp2.keep.length === 500 && sp2.archive.every((m) => m.kind === "fyi")), "archivage : les fyi partent avant les questions ouvertes");
  const onlyDecisions = []; for (let i = 0; i < 700; i++) onlyDecisions.push(msg({ at: iso(base + i), kind: "decision", text: `d${i}` }));
  const sp3 = splitForArchive(onlyDecisions, 500);
  expect(sp3.keep.length === 500 && sp3.keep[0].text === "d200" && sp3.archive.length === 200, "archivage : plafond STRICT de 500 (si tout est protégé, les plus anciennes décisions partent en dernier)");
  expect(splitForArchive(mixed.slice(0, 499), 500).archive.length === 0 && THREAD_LIMITS.live === 500 && THREAD_LIMITS.archiveBytes === 5 * 1024 * 1024, "archivage : rien sous le plafond ; archive de 5 Mo au plus");

  // boucle
  const now = Date.now();
  const ping = (from, to, ago) => ({ from, to, at: iso(now - ago) });
  const alt = [ping("a", "b", 500000), ping("b", "a", 400000), ping("a", "b", 300000), ping("b", "a", 200000), ping("a", "b", 100000), ping("b", "a", 50000)];
  expect(loopCheck(alt, "a", "b", { now }).loop === true && loopCheck(alt, "b", "a", { now }).loop === true, "boucle : 6 messages échangés dans les 2 sens en 10 min → le 7e déclenche la pause");
  expect(loopCheck(alt.slice(1), "a", "b", { now }).loop === false, "boucle : 5 messages → pas encore");
  const oneWay = Array.from({ length: 9 }, (_, i) => ping("a", "b", 100000 - i * 1000));
  expect(loopCheck(oneWay, "a", "b", { now }).loop === false, "boucle : 9 messages à sens unique ne sont pas un échange");
  const oneSidedFlood = (n) => Array.from({ length: n }, (_, i) => ping("a", "b", 100000 - i * 1000));
  expect(loopCheck(oneSidedFlood(11), "a", "b", { now }).loop === false && loopCheck(oneSidedFlood(12), "a", "b", { now }).loop === true, "boucle : 12 messages à sens unique sans aucune réponse déclenchent la pause (3e passage du vérificateur)");
  expect(loopCheck(alt, "a", "b", { now, progressAt: now - 60000 }).loop === false, "boucle : une décision ou un fichier modifié depuis le début de la fenêtre remet le compteur à zéro");
  expect(loopCheck(alt.map((m) => ({ ...m, at: iso(Date.parse(m.at) - 900000) })), "a", "b", { now }).loop === false, "boucle : au-delà de 10 minutes, rien ne compte");
  expect(pairKey("b", "a") === pairKey("a", "b"), "boucle : la paire est la même dans les deux sens");

  // digest
  const dq = msg({ at: iso(now - 600000), kind: "question", text: "Quel\nport\n## Titre piège ?", needsReply: true });
  const dqDone = msg({ at: iso(now - 500000), kind: "question", text: "Question déjà répondue" });
  const dAns = msg({ at: iso(now - 400000), from: "local:b", fromLabel: "Bob", replyTo: dqDone.id, kind: "answer", text: "ok" });
  const dBlk = msg({ at: iso(now - 300000), kind: "blocker", text: "Bloqué sur la base" });
  const dDec = msg({ at: iso(now - 200000), kind: "decision", text: "On passe à pnpm" });
  const dHand = msg({ at: iso(now - 100000), kind: "handoff", text: "Je passe la main sur le module A" });
  const sess = [{ label: "Alice", role: "writer", status: "running", active: true, orchestrator: true, statusText: "Refonte du menu", files: ["src/menu.js"], taskTitle: "Menu" }, { label: "Inactive", role: "writer", status: "idle", active: false, statusText: "ne doit pas apparaître" }];
  const dg = buildDigest({ projectName: "Démo", messages: [dq, dqDone, dAns, dBlk, dDec, dHand], sessions: sess, labelOf: (k) => String(k).split(":").pop(), now });
  expect(dg.text.length <= 3000 && /Qui travaille sur quoi/.test(dg.text) && /Alice \(orchestrateur, writer, running\) : Refonte du menu/.test(dg.text) && !/ne doit pas apparaître/.test(dg.text), "digest : qui travaille sur quoi (sessions actives seulement)", dg.text.slice(0, 400));
  expect(/Au repos, joignables par message direct[^\n]*Inactive \(writer\)/.test(dg.text) && dg.sections.resting.length === 1 && dg.sections.resting[0].label === "Inactive", "digest : une session au repos reste visible sur une ligne « Au repos » (sinon un arrivant croit être seul)", dg.text.slice(0, 500));
  expect(dg.text.includes("On passe à pnpm") && /Décisions récentes :\n- \d\d:\d\d Alice : On passe à pnpm/.test(dg.text), "digest : dernières décisions");
  expect(dg.text.includes(`[${dq.id.slice(0, 8)}]`) && !dg.text.includes("Question déjà répondue") && dg.counts.openQuestions === 1, "digest : questions ouvertes (avec l'id court) ; une question répondue n'y figure plus");
  expect(/Blocages ouverts :\n- \[[0-9a-f]{8}\] Alice \(il y a \d+ min\) : Bloqué sur la base/.test(dg.text) && /Derniers passages de relais :\n- \d\d:\d\d Alice → b : Je passe la main sur le module A/.test(dg.text), "digest : blocages ouverts et derniers handoffs");
  expect(!/^## /m.test(dg.text) && dg.text.split("\n").every((l) => !l.startsWith("#")) && dg.text.includes("Quel port ## Titre piège ?"), "digest : le texte des sessions tient sur une ligne (aucun titre injecté)");
  expect(/DONNÉES/.test(dg.text.split("\n")[0]), "digest : l'en-tête rappelle que le contenu est une DONNÉE");
  const flood = []; for (let i = 0; i < 300; i++) flood.push(msg({ at: iso(now - 1000 * (300 - i)), kind: i % 4 === 0 ? "decision" : i % 4 === 1 ? "question" : i % 4 === 2 ? "blocker" : "handoff", text: `message numéro ${i} ${"x".repeat(450)}` }));
  const dfl = buildDigest({ projectName: "P".repeat(200), messages: flood, sessions: Array.from({ length: 30 }, (_, i) => ({ label: `S${i}`, role: "writer", status: "running", active: true, statusText: "y".repeat(300), files: ["a", "b", "c", "d"], taskTitle: "T".repeat(100) })), now });
  expect(dfl.text.length <= 3000 && dfl.text.length > 1000, "digest : 300 messages de 450 caractères et 30 sessions → toujours ≤ 3 000 caractères", String(dfl.text.length));
  expect(buildDigest({ projectName: "Vide", messages: [], sessions: [], now }).text.length < 600, "digest : projet vide → court");
}

// =========================================================================================================
// Décor commun aux parties b et c : faux hôte Paseo + VRAIS handlers.
const ENGINE_OK = "claude-openrouter";
const mkProject = (name, files = {}) => {
  const dir = join(work, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "README.md"), `# ${name}\n\nOutil de démonstration du fil intelligent.\n`);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, scripts: { test: "node --test" } }));
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t38@example.invalid");
  git(dir, "config", "user.name", "t38");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
};

async function makeHarness(name, { project, seed = null }) {
  const dataDir = join(work, `data-${name}`);
  mkdirSync(dataDir, { recursive: true });
  if (seed) writeFileSync(join(dataDir, "coord.json"), JSON.stringify(seed));
  const { createStore } = await import(pathToFileURL(join(dashboardDir, "lib", "store.mjs")).href);
  const routes = new Map();
  const broadcasts = [];
  const stateListeners = new Set();
  const prefixes = [];
  const agents = new Map();
  const tasks = [];
  const logs = [];
  const sends = []; // textes remis à un agent (réveils)
  const entry = {
    connected: () => true,
    daemon: { cancelAgent: async () => {}, archiveAgent: async () => {}, getConnectionState: () => ({ status: "connected" }) },
    api: {
      workspaces: { open: async () => ({ id: "w1" }) },
      agents: {
        create: async (options) => { const id = options.agentId || randomUUID(); agents.set(id, { id, cwd: options.cwd, title: options.title, status: "running", provider: "claude", updatedAt: new Date().toISOString(), pending: [] }); return { id, workspaceId: "w1" }; },
        list: async () => ({ entries: [...agents.values()].map((a) => ({ agent: { id: a.id, cwd: a.cwd, title: a.title, status: a.status, updatedAt: a.updatedAt, pendingPermissions: a.pending } })) }),
        ref: (id) => ({
          respondToPermission: async () => {},
          timeline: { refetch: async () => ({ entries: [] }) },
          send: async (text) => { sends.push({ agentId: id, text }); },
        }),
      },
    },
  };
  const ctx = {
    dataDir,
    store: createStore(dataDir),
    log: (scope, ...args) => logs.push(`[${scope}] ${args.join(" ")}`),
    safeError: (e) => String(e?.message ?? e),
    hosts: { get: (l) => (l === "local" ? entry : undefined), has: (l) => l === "local", labels: () => ["local"] },
    hostOf: (m) => ({ label: m.host || "local", entry }),
    onDisconnect: () => {},
    onHostRemoved: () => {},
    onStateChange: (fn) => stateListeners.add(fn),
    onHttp: () => {},
    onHttpPrefix: (prefix, fn) => prefixes.push({ prefix, fn }),
    onMessage: (type, fn) => { if (!routes.has(type)) routes.set(type, []); routes.get(type).push(fn); },
    send: (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); },
    broadcast: (m) => { broadcasts.push(m); },
    sendError: (ws, m) => ctx.send(ws, { type: "error", message: `Erreur : ${m}` }),
    async broadcastState() {
      const state = {
        hosts: [{ label: "local", status: "connected", hostname: "sim" }],
        agents: [...agents.values()].map((a) => ({
          host: "local", agentId: a.id, status: a.status, cwd: a.cwd, title: a.title, provider: a.provider, model: null,
          parentAgentId: null, pending: [], updatedAt: a.updatedAt, duration: 0,
        })),
        workspaces: [], terminals: [],
      };
      for (const fn of stateListeners) fn(state);
    },
  };
  const dispatchAs = async (uiId, type, payload = {}) => {
    if (!routes.has(type)) throw new Error(`message inconnu : ${type}`);
    const replies = [];
    const client = { _uiId: uiId, readyState: 1, send: (raw) => replies.push(JSON.parse(raw)) };
    let error = null;
    try { for (const fn of routes.get(type)) await fn(client, { ...payload, type }); } catch (e) { error = String(e.message); }
    const refused = replies.find((r) => r.type === "error");
    return { replies, error: error ?? (refused ? String(refused.message) : null) };
  };
  ctx.invoke = (type, payload) => dispatchAs(`invoke:${randomUUID()}`, type, payload);
  const fake = (type, fn) => ctx.onMessage(type, (ws, m) => fn(ws, m));
  const projects = [{ name: "proj", dir: slash(project), host: "local" }];
  fake("project.list", (ws) => ctx.send(ws, { type: "project.list", projects }));
  fake("task.list", (ws) => ctx.send(ws, { type: "tasks", tasks: tasks.map((t) => ({ projectName: "proj", project: slash(project), ...t })) }));
  fake("task.create", () => {}); fake("task.start", () => {}); fake("task.stop", () => {}); fake("task.move", () => {}); fake("task.update", () => {});
  const load = async (file) => (await import(pathToFileURL(join(dashboardDir, "handlers", file)).href)).register(ctx, { hosts: ctx.hosts });
  for (const f of ["agentactivity.mjs", "agentapi.mjs", "agentmode.mjs", "coord.mjs", "core-agents.mjs", "inbox.mjs", "permpolicy.mjs", "projectbrief.mjs"]) await load(f);
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const p = prefixes.find((x) => url.pathname.startsWith(x.prefix));
    if (!p) { res.writeHead(404); return res.end(); }
    p.fn(req, res, url);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const idHeaders = (id) => (id ? { "X-Coord-Host": id.host ?? "local", "X-Coord-Agent": id.agentId, "X-Coord-Token": id.token } : {});
  const h = {
    ctx, base, agents, sends, tasks, broadcasts, dataDir, server, logs, project, dispatchAs,
    api: async (method, path, body, id) => {
      const r = await fetch(`${base}/api/v1${path}`, {
        method, headers: { "X-Agent-Name": "verify-thread", ...(body ? { "Content-Type": "application/json" } : {}), ...idHeaders(id) }, body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, json: await r.json() };
    },
    addAgent(id, { title = id, status = "running", role = null } = {}) {
      agents.set(id, { id, cwd: slash(project), title, status, provider: ENGINE_OK, updatedAt: new Date().toISOString(), pending: [] });
      if (role) tasks.push({ id: `t-${id}`, title: `Tâche ${title}`, status: "doing", host: "local", agentId: id, engine: "claude-openrouter/sonnet", mode: "default", role });
    },
    setStatus(id, status) { agents.get(id).status = status; },
    async tick(n = 1) { for (let i = 0; i < n; i++) { ctx.coord.resetCaches(); await ctx.broadcastState(); await ctx.coord.sync(); } },
    id: (agentId) => ({ host: "local", agentId, token: ctx.coord.tokenFor("local", agentId) }),
    human: (type, payload) => dispatchAs("ui-human-1", type, payload),
    agent: (type, payload) => dispatchAs(`invoke:${randomUUID()}`, type, payload),
    messages: () => ctx.coord._state.data.messages,
    // (la limite de 20 messages par minute est remise à zéro entre deux envois : elle est testée à part, avec h.api)
    send: (as, body) => { ctx.coord.thread.resetRate(); return h.api("POST", "/coord/send", body, h.id(as)); },
    inbox: async (as) => (await h.api("GET", "/coord/inbox", undefined, h.id(as))).json.data,
    wakes: (agentId) => sends.filter((x) => x.agentId === agentId),
    close: () => new Promise((r) => server.close(r)),
  };
  return h;
}
const code = (r) => r.json?.error?.code;
const errText = (r) => r.json?.error?.message || "";
const textOf = (r) => r.content?.map((c) => c.text).join("\n") ?? "";

// =========================================================================================================
if (run("b")) {
  section("B : backend (messages typés, réponses, réveil, décision → proposition, accusés, boucle, relance, routage, archivage, compatibilité, digest)");
  const PROJ = mkProject("projb");
  const F = join(PROJ, "PASEO-PROJECT.md");
  const legacySeed = {
    messages: [
      { id: "legacy-0001-aaaaaaaa", at: iso(Date.now() - 86400000), from: "local:agent-a", fromLabel: "Alice", fromKind: "session", to: "local:agent-b", project: projectKey("local", slash(PROJ)), text: "ancien message sans type", readAt: null },
      { id: "legacy-0002-bbbbbbbb", at: iso(Date.now() - 86000000), from: "human", fromLabel: "Philippe", fromKind: "human", to: "local:agent-a", project: projectKey("local", slash(PROJ)), text: "ancien message de Philippe", readAt: iso(Date.now() - 80000000) },
    ],
  };
  const h = await makeHarness("b", { project: PROJ, seed: legacySeed });
  h.addAgent("agent-a", { title: "Alice" });
  h.addAgent("agent-b", { title: "Bobby", status: "idle" });
  h.addAgent("agent-c", { title: "Carol", status: "running", role: "reader" });
  h.addAgent("agent-d", { title: "Dave", status: "running" });
  h.addAgent("agent-n", { title: "Ned", status: "running" });
  await h.tick(2);
  const A = "agent-a"; const B = "agent-b"; const C = "agent-c"; const D = "agent-d";
  const pkey = projectKey("local", slash(PROJ));
  const proj = () => h.messages().filter((m) => m.project === pkey);

  // --- compatibilité avec l'ancien format
  const inb0 = await h.inbox(B);
  const legacy = inb0.messages.find((m) => m.id === "legacy-0001-aaaaaaaa");
  expect(legacy?.kind === "fyi" && legacy.replyTo === null && legacy.needsReply === false && legacy.text === "ancien message sans type", "ancien message sans type : s'affiche « fyi » dans la boîte, texte intact");
  const th0 = h.ctx.coord.thread.threadOf(pkey, 50);
  expect(th0.length === 2 && th0.every((m) => m.kind === "fyi" && m.status === null && m.replyTo === null), "fil : les anciens messages s'affichent « fyi », sans état de fil");
  const oldForm = await h.send(A, { to: "Bobby", text: "ancienne forme { to, text }" });
  expect(oldForm.status === 200 && oldForm.json.data.sent === true && oldForm.json.data.to === "local:agent-b" && oldForm.json.data.kind === "fyi", "ancienne forme { to, text } : toujours valide (kind « fyi » affiché)", JSON.stringify(oldForm.json));
  await sleep(150);
  expect(h.wakes(B).length === 1 && /ancienne forme/.test(h.wakes(B)[0].text), "ancienne forme (sans kind) : le réveil historique est conservé (DASHBOARD_COORD_LEGACY_WAKE=0 pour le couper)");
  expect(h.messages().at(-1).kind === undefined, "ancienne forme : le message est stocké sans champ kind (compatibilité des données)");
  process.env.DASHBOARD_COORD_LEGACY_WAKE = "0";
  h.sends.length = 0;
  await h.send(A, { to: "Bobby", text: "sans kind, réveil historique coupé" });
  await sleep(150);
  delete process.env.DASHBOARD_COORD_LEGACY_WAKE;
  expect(h.wakes(B).length === 0, "DASHBOARD_COORD_LEGACY_WAKE=0 : « sans kind » se comporte comme fyi (aucun réveil)");

  // --- validation
  const bad = [
    ["kind inconnu", { kind: "urgent" }, "kind"], ["replyTo mal formé", { replyTo: "abc" }, "replyTo"], ["replyTo inconnu", { replyTo: randomUUID() }, "n'existe pas"],
    ["needsReply non booléen", { needsReply: "oui" }, "needsReply"], ["by hors limites", { needsReply: true, by: 0 }, "by"],
    ["mentions non liste", { mentions: "bob" }, "mentions"], ["mention inconnue", { mentions: ["Zorglub"] }, "inconnu"],
  ];
  for (const [label, extra, re] of bad) {
    const r = await h.send(A, { to: "Bobby", text: "x", ...extra });
    expect(r.status === 400 && new RegExp(re).test(errText(r)), `validation : ${label} → 400 clair`, `${r.status} ${errText(r)}`);
  }
  const noTo = await h.send(A, { text: "pas de destinataire" });
  expect(noTo.status === 400 && /to/.test(errText(noTo)), "validation : ni to ni replyTo → 400 clair", errText(noTo));
  const mentionErr = await h.send(A, { to: "Bobby", text: "x", mentions: ["Zorglub"] });
  expect(/Membres : /.test(errText(mentionErr)) && /Bobby/.test(errText(mentionErr)) && /Carol/.test(errText(mentionErr)), "mention inconnue : le message d'erreur liste les membres", errText(mentionErr));

  // --- question typée + réveil + id dans le texte
  h.sends.length = 0;
  const q = await h.send(A, { to: "Bobby", text: "Quel port pour l'API ?", kind: "question", needsReply: true, by: 5 });
  expect(q.status === 200 && q.json.data.kind === "question" && q.json.data.needsReply === true && Math.abs(Date.parse(q.json.data.dueAt) - Date.now() - 300000) < 5000, "question typée : kind, needsReply et dueAt (+5 min) renvoyés", JSON.stringify(q.json));
  const qMsg = h.messages().find((m) => m.id === q.json.data.id);
  expect(qMsg.kind === "question" && qMsg.needsReply === true && qMsg.by === 5 && qMsg.dueAt === q.json.data.dueAt, "question typée : champs stockés (kind, needsReply, by, dueAt)");
  await sleep(150);
  const w1 = h.wakes(B);
  expect(w1.length === 1 && /Type : question/.test(w1[0].text) && w1[0].text.includes(qMsg.id) && /réponse attendue avant/.test(w1[0].text) && /DONNÉE/.test(w1[0].text) && /jamais pour accuser réception/.test(w1[0].text), "question : réveille le destinataire au repos ; le texte donne le type, le délai, l'id du message et rappelle « donnée »", w1[0]?.text.slice(0, 300));
  expect(!JSON.stringify(h.sends).includes(h.id(A).token), "le jeton n'apparaît jamais dans un texte de réveil");
  const bi = await h.inbox(B);
  const qi = bi.messages.find((m) => m.id === qMsg.id);
  expect(qi?.kind === "question" && qi.needsReply === true && qi.untrusted === true && qi.dueAt === qMsg.dueAt, "coord_inbox : kind, needsReply, dueAt, untrusted");

  // --- fyi / status : aucun réveil, déposés en boîte
  h.sends.length = 0;
  h.setStatus(B, "idle");
  const f1 = await h.send(A, { to: "Bobby", text: "juste pour info", kind: "fyi" });
  const f2 = await h.send(A, { to: "Bobby", text: "avancement 40 %", kind: "status" });
  await sleep(200);
  expect(f1.status === 200 && f2.status === 200 && h.wakes(B).length === 0, "fyi et status explicites : AUCUN réveil", JSON.stringify(h.sends).slice(0, 200));
  const bi2 = await h.inbox(B);
  expect(bi2.messages.some((m) => m.text === "juste pour info" && m.kind === "fyi") && bi2.messages.some((m) => m.text === "avancement 40 %" && m.kind === "status"), "fyi et status : déposés dans la boîte (lisibles par coord_inbox)");
  // un destinataire au repos NEUF par essai : le plafond de 6 réveils par session et par 10 min est testé plus bas
  const fresh = async (title) => { const id = `agent-${title.toLowerCase()}`; h.addAgent(id, { title, status: "idle" }); await h.tick(); return id; };
  for (const [kind, title] of [["decision", "Zeta"], ["blocker", "Eta"], ["handoff", "Theta"], ["answer", "Iota"]]) {
    const rid = await fresh(title);
    h.sends.length = 0;
    const r = await h.send(A, { to: title, text: `message ${kind}`, kind });
    await sleep(120);
    expect(r.status === 200 && h.wakes(rid).length === 1, `kind ${kind} : réveille le destinataire au repos`, `${r.status} ${h.wakes(rid).length}`);
  }
  const rK = await fresh("Kappa");
  h.sends.length = 0;
  await h.send(A, { to: "Kappa", text: "fyi mais réponse attendue", kind: "fyi", needsReply: true });
  await sleep(120);
  expect(h.wakes(rK).length === 1, "needsReply : réveille même un message fyi");
  // une session qui arrive au repos après avoir travaillé ne reçoit pas les fyi/status non lus
  h.sends.length = 0;
  h.setStatus(D, "running");
  await h.tick();
  await h.send(A, { to: "Dave", text: "fyi pendant que tu travailles", kind: "fyi" });
  await h.send(A, { to: "Dave", text: "status pendant que tu travailles", kind: "status" });
  h.setStatus(D, "idle");
  await h.tick();
  await sleep(200);
  expect(h.wakes(D).length === 0, "remise différée : les fyi/status non lus ne réveillent pas la session quand elle repasse au repos");
  h.setStatus(D, "running"); await h.tick();
  await h.send(A, { to: "Dave", text: "un blocage reçu en travaillant", kind: "blocker" });
  h.setStatus(D, "idle"); await h.tick();
  await sleep(200);
  expect(h.wakes(D).length >= 1 && h.wakes(D).some((x) => /blocage reçu en travaillant/.test(x.text)) && !h.wakes(D).some((x) => /fyi pendant que tu travailles|status pendant que tu travailles/.test(x.text)), "remise différée : un blocage reçu pendant le travail est remis au retour au repos, sans les fyi/status");
  h.setStatus(D, "running"); await h.tick();

  // --- réponse dans le fil
  const ans = await h.send(B, { text: "Le port est 7070", replyTo: qMsg.id });
  expect(ans.status === 200 && ans.json.data.to === "local:agent-a" && ans.json.data.kind === "answer", "réponse avec replyTo, sans « to » : part à l'expéditeur de la question, kind « answer » déduit", JSON.stringify(ans.json));
  const ansMsg = h.messages().find((m) => m.id === ans.json.data.id);
  expect(ansMsg.replyTo === qMsg.id && ansMsg.kind === "answer", "réponse : replyTo et kind stockés");
  const th1 = h.ctx.coord.thread.threadOf(pkey, 100);
  const qEntry = th1.find((m) => m.id === qMsg.id);
  const aEntry = th1.find((m) => m.id === ansMsg.id);
  expect(qEntry.status === "answered" && aEntry.replyTo === qMsg.id && aEntry.kind === "answer", "fil : la question passe à « answered », la réponse pointe vers elle", JSON.stringify([qEntry.status, aEntry.replyTo]));
  expect((await h.inbox(A)).messages.find((m) => m.id === ansMsg.id)?.replyTo === qMsg.id, "coord_inbox de l'asker : la réponse indique replyTo");
  const q2 = await h.send(A, { to: "Bobby", text: "Une seconde question ?", kind: "question" });
  const fyiReply = await h.send(B, { to: "Alice", text: "je regarde ça", replyTo: q2.json.data.id, kind: "fyi" });
  expect(h.ctx.coord.thread.threadOf(pkey, 100).find((m) => m.id === q2.json.data.id).status === "open" && fyiReply.status === 200, "fil : une réponse « fyi » ne ferme pas la question (elle reste « open »)");

  // --- digest : question ouverte
  const dgOpen = (await h.api("GET", "/coord/digest", undefined, h.id(A))).json.data;
  expect(dgOpen.digest.includes(`[${q2.json.data.id.slice(0, 8)}]`) && !dgOpen.digest.includes("Quel port pour l'API"), "digest : la question sans réponse est listée avec son id ; la question répondue n'y est plus", dgOpen.digest.slice(0, 500));

  // --- décision → proposition T37
  const noBriefDec = await h.send(A, { to: "Bobby", text: "Décision sans fiche", kind: "decision" });
  expect(noBriefDec.json.data.decisionProposal?.proposed === false && /fiche/.test(noBriefDec.json.data.decisionProposal.reason), "décision sans fiche projet : message envoyé, proposition refusée avec une raison claire", JSON.stringify(noBriefDec.json.data.decisionProposal));
  const cr = await h.human("brief.create", { host: "local", dir: slash(PROJ) });
  expect(cr.error === null && existsSync(F), "(préparation) fiche projet créée par Philippe");
  const before = readFileSync(F, "utf8");
  const dec = await h.send(A, { to: "Bobby", text: "On utilise pnpm pour tout le dépôt", kind: "decision" });
  const prop = dec.json.data.decisionProposal;
  expect(dec.status === 200 && prop?.proposed === true && typeof prop.id === "string", "décision d'une session : proposition créée pour la fiche projet", JSON.stringify(dec.json.data));
  const pending = h.ctx.projectBrief._state.proposals.filter((p) => p.state === "pending" && p.section === "Décisions");
  expect(pending.some((p) => p.id === prop.id && /On utilise pnpm pour tout le dépôt/.test(p.text) && p.sessionLabel === "Alice" && /Décision annoncée/.test(p.why)), "proposition : section « Décisions », signée par la session, raison « annoncée dans le fil »");
  expect(readFileSync(F, "utf8") === before, "décision : AUCUNE écriture directe dans la fiche (octet pour octet)");
  const accepted = await h.human("brief.proposal.decide", { id: prop.id, approve: true });
  expect(accepted.error === null && /On utilise pnpm pour tout le dépôt \(proposé par Alice\)/.test(readFileSync(F, "utf8")), "Philippe accepte → le poste écrit la ligne dans « Décisions »");
  const dec2 = await h.send(A, { to: "Bobby", text: "Autre décision : garder Node 24", kind: "decision" });
  const refused = await h.human("brief.proposal.decide", { id: dec2.json.data.decisionProposal.id, approve: false });
  expect(refused.error === null && !readFileSync(F, "utf8").includes("garder Node 24"), "Philippe refuse → rien n'est écrit");
  const decDup = await h.send(A, { to: "Bobby", text: "On utilise pnpm pour tout le dépôt", kind: "decision" });
  expect(decDup.json.data.decisionProposal?.proposed === true, "même texte de décision déjà accepté : une nouvelle proposition est possible (pas un doublon en attente)");
  const dec3 = await h.send(A, { to: "Bobby", text: "Décision <img src=x onerror=alert(1)> [x](javascript:alert(1)) clé: sk-live-0123456789abcdefABCDEF", kind: "decision" });
  const p3 = h.ctx.projectBrief._state.proposals.find((p) => p.id === dec3.json.data.decisionProposal?.id);
  expect(p3 && !/[<>]/.test(p3.text) && !/\]\(javascript/i.test(p3.text) && !p3.text.includes("sk-live-0123456789abcdefABCDEF"), "proposition issue d'une décision : HTML échappé, lien javascript neutralisé, secret masqué", p3?.text);
  const decH = await h.send(A, { to: "human", text: "décision destinée à Philippe", kind: "decision" });
  expect(decH.json.data.decisionProposal?.proposed === true, "décision envoyée à Philippe : proposition aussi");
  const hMsgDec = await h.human("coord.send", { to: "local:agent-b", text: "Décision de Philippe lui-même" });
  expect(hMsgDec.error === null && !h.ctx.projectBrief._state.proposals.some((p) => /de Philippe lui-même/.test(p.text)), "un message de Philippe ne crée jamais de proposition");

  // --- digest complet : décisions listées
  const dg = (await h.api("GET", "/coord/digest", undefined, h.id(A))).json.data;
  expect(dg.digest.length <= 3000 && /Décisions récentes/.test(dg.digest) && /pnpm pour tout le dépôt/.test(dg.digest), "digest REST : décisions récentes listées, ≤ 3 000 caractères", String(dg.digest.length));
  expect(dg.brief?.exists === true && /# Fiche projet — /.test(dg.brief.text) && dg.brief.externallyModified === false && /^[0-9a-f]{16}$/.test(dg.brief.rev), "digest REST : la fiche projet (T37) est jointe dans le MÊME appel", JSON.stringify(Object.keys(dg.brief || {})));
  expect(!("llm" in dg), "digest REST : sans DASHBOARD_COORD_DIGEST_LLM, aucune reformulation (règles seulement)");
  const dg0 = (await h.api("GET", "/coord/digest?brief=0", undefined, h.id(A))).json.data;
  expect(!("brief" in dg0) && dg0.digest === dg.digest, "digest REST : ?brief=0 → sans la fiche, même résumé");
  expect((await h.api("GET", "/coord/digest")).status === 401, "digest REST sans identité : refusé (401)");
  expect(dg.sections.openQuestions.some((x) => x.id === q2.json.data.id) && dg.counts.openQuestions >= 1 && dg.sections.working.some((x) => x.label === "Alice"), "digest REST : sections structurées (questions ouvertes, qui travaille)");

  // --- accusés de réception
  h.sends.length = 0;
  const n0 = proj().length;
  const ack1 = await h.send(A, { to: "Bobby", text: "ok" });
  const ack2 = await h.send(A, { to: "Bobby", text: "Reçu, merci !" });
  await sleep(150);
  expect(ack1.json.data.suppressed === "ack" && ack2.json.data.suppressed === "ack" && proj().length === n0 && h.wakes(B).length === 0, "accusés « ok » / « Reçu, merci ! » : supprimés (rien déposé, aucun réveil)", JSON.stringify(ack1.json));
  const ack3 = await h.send(A, { to: "Alice", text: "ok", replyTo: ansMsg.id });
  const ack4 = await h.send(A, { text: "reçu", replyTo: qMsg.id });
  expect(ack4.json.data.suppressed === "ack" && ack4.json.data.merged === true, "accusé en réponse à un message connu : fusionné dans le message d'origine", JSON.stringify(ack4.json));
  void ack3;
  const merged = h.ctx.coord.thread.threadOf(pkey, 100).find((m) => m.id === qMsg.id);
  expect(merged.acks.includes("Alice") && proj().length === n0, "fil : « reçu par Alice » affiché sur la question d'origine, aucun nouveau message");
  const realAck = await h.send(A, { to: "Bobby", text: "ok", kind: "answer" });
  expect(realAck.json.data.sent === true && !realAck.json.data.suppressed, "« ok » avec kind answer : c'est une vraie réponse, livrée");
  const notAck = await h.send(A, { to: "Bobby", text: "ok mais d'abord corrige le module auth", kind: "fyi" });
  expect(!notAck.json.data.suppressed, "un message plus long qui commence par « ok » n'est pas un accusé");
  const ackNeeds = await h.send(A, { to: "Bobby", text: "ok", needsReply: true });
  expect(!ackNeeds.json.data.suppressed, "« ok » avec needsReply n'est pas supprimé");

  // --- routage par rôle, mentions
  h.sends.length = 0;
  h.setStatus(B, "idle");
  const byRole = await h.send(A, { to: "role:reader", text: "à tous les lecteurs", kind: "fyi" });
  expect(byRole.status === 200 && byRole.json.data.to === "role:reader" && byRole.json.data.recipients === 1, "role:reader : résolu par le poste (1 destinataire : Carol)", JSON.stringify(byRole.json));
  expect((await h.inbox(C)).messages.some((m) => m.text === "à tous les lecteurs") && !(await h.inbox(B)).messages.some((m) => m.text === "à tous les lecteurs"), "role:reader : Carol (lecteur) reçoit ; Bobby (rédacteur) non");
  const byWriter = await h.send(A, { to: "role:writer", text: "aux rédacteurs", kind: "fyi" });
  expect(byWriter.status === 200 && byWriter.json.data.recipients === 2, "role:writer : tous les rédacteurs actifs sauf l'expéditeur (Dave et Ned)", JSON.stringify(byWriter.json));
  expect(!(await h.inbox(A)).messages.some((m) => m.text === "aux rédacteurs"), "role:writer : l'expéditeur ne reçoit pas sa propre copie");
  const planner = await h.send(A, { to: "role:planner", text: "x" });
  expect(planner.status === 400 && code(planner) === "unknown_target" && /aucune session active avec le rôle « planner »/.test(errText(planner)) && /Membres : /.test(errText(planner)), "role:planner sans membre : erreur claire avec la liste des membres", errText(planner));
  const badRole = await h.send(A, { to: "role:chef", text: "x" });
  expect(badRole.status === 400 && /rôle inconnu/.test(errText(badRole)) && /writer, reader ou planner/.test(errText(badRole)), "role:chef : rôle inconnu, erreur claire", errText(badRole));
  const unknown = await h.send(A, { to: "Zorglub", text: "x" });
  expect(unknown.status === 400 && code(unknown) === "unknown_target" && /destinataire inconnu/.test(errText(unknown)) && /Membres : /.test(errText(unknown)) && /Carol \(reader\)/.test(errText(unknown)) && /Bobby \(writer, au repos\)/.test(errText(unknown)), "destinataire inconnu : message clair AVEC la liste des membres et leurs rôles", errText(unknown));
  const toTeamMention = await h.send(A, { to: "team", text: "voir avec @Carol pour les tests", kind: "fyi" });
  expect(toTeamMention.json.data.mentioned?.join() === "Carol", "@nom dans le texte (équipe) : mention résolue par le poste", JSON.stringify(toTeamMention.json.data));
  const directMention = await h.send(A, { to: "Bobby", text: "cc @Carol pour information", kind: "fyi" });
  expect(directMention.json.data.recipients === 2 && (await h.inbox(C)).messages.some((m) => /cc @Carol pour information/.test(m.text) && m.mentionsYou === true), "@nom dans un message direct : la personne mentionnée reçoit aussi une copie (mentionsYou)", JSON.stringify(directMention.json.data));
  const unres = await h.send(A, { to: "Bobby", text: "voir @nobody-here et @types/node", kind: "fyi" });
  expect(unres.status === 200 && unres.json.data.unresolvedMentions?.includes("nobody-here"), "@nom inconnu dans le texte : ignoré et signalé (pas une erreur)", JSON.stringify(unres.json.data));
  const roleMention = await h.send(A, { to: "Bobby", text: "pour les lecteurs", kind: "fyi", mentions: ["role:reader"] });
  expect(roleMention.json.data.recipients === 2 && roleMention.json.data.mentioned?.join() === "Carol", "mentions explicites par rôle : « role:reader » atteint Carol", JSON.stringify(roleMention.json.data));
  const toSelf = await h.send(A, { to: "Alice", text: "x" });
  expect(toSelf.status === 400, "message à soi-même : toujours refusé");

  // --- détection de boucle
  for (const [id, title] of [["agent-e", "Eve"], ["agent-f", "Fay"], ["agent-g", "Gus"], ["agent-h", "Hal"]]) h.addAgent(id, { title, status: "running" });
  await h.tick(2);
  const E = "agent-e"; const Fy = "agent-f";
  const ex = [];
  for (let i = 0; i < 6; i++) ex.push(await h.send(i % 2 ? Fy : E, { to: i % 2 ? "Eve" : "Fay", text: `échange ${i}`, kind: "fyi" }));
  expect(ex.every((r) => r.status === 200), "boucle : 6 messages échangés entre deux sessions passent");
  const loopInboxBefore = h.ctx.inbox.list({}).filter((i) => /Échange en boucle/.test(i.title)).length;
  const seventh = await h.send(E, { to: "Fay", text: "échange 6", kind: "fyi" });
  expect(seventh.status === 429 && code(seventh) === "loop_paused" && /pause/.test(errText(seventh)) && /decision/.test(errText(seventh)), "boucle : le 7e message en 10 min sans décision ni fichier modifié → pause (429 loop_paused, avec la marche à suivre)", `${seventh.status} ${errText(seventh)}`);
  const loopItems = h.ctx.inbox.list({}).filter((i) => /Échange en boucle/.test(i.title));
  expect(loopItems.length === loopInboxBefore + 1 && /Eve/.test(loopItems[0].title) && /Fay/.test(loopItems[0].title) && /10 minutes/.test(loopItems[0].body), "boucle : message du poste à Philippe dans la boîte de réception (une seule fois)", loopItems[0]?.title);
  const reverse = await h.send(Fy, { to: "Eve", text: "réponse pendant la pause", kind: "fyi" });
  expect(reverse.status === 429 && code(reverse) === "loop_paused", "boucle : la pause vaut dans les deux sens");
  await h.send(E, { to: "Fay", text: "encore", kind: "fyi" });
  expect(h.ctx.inbox.list({}).filter((i) => /Échange en boucle/.test(i.title)).length === loopInboxBefore + 1, "boucle : pas de deuxième alerte pendant la pause");
  const other = await h.send(E, { to: "Gus", text: "autre paire : libre", kind: "fyi" });
  expect(other.status === 200, "boucle : seule cette paire est en pause (Eve peut écrire à Gus)");
  expect((await h.send(E, { to: "human", text: "je suis bloquée dans une boucle", kind: "blocker" })).status === 200, "boucle : écrire à Philippe reste possible pendant la pause");
  const pairs = h.ctx.coord.thread.loopPauses;
  expect(pairs.size === 1 && [...pairs.values()][0] > Date.now() + 9 * 60000, "boucle : pause d'environ 10 minutes");
  // fin de pause + décision annoncée → compteur remis à zéro
  pairs.clear();
  expect((await h.send(E, { to: "Fay", text: "après la pause sans progrès", kind: "fyi" })).status === 429, "boucle : la pause finie, sans progrès, la boucle est redétectée");
  expect([...pairs.values()].length === 1, "boucle : la pause est de nouveau en cours");
  const decThrough = await h.send(E, { to: "Fay", text: "Décision : on arrête cet échange et on tranche", kind: "decision" });
  expect(decThrough.status === 200, "boucle : une décision passe MÊME pendant la pause (c'est ce qui sort de la boucle)", errText(decThrough));
  expect((await h.send(E, { to: "Fay", text: "après une décision", kind: "fyi" })).status === 200, "boucle : une nouvelle décision remet le compteur à zéro (échange autorisé)");
  // plafond de décisions : une décision passe pendant une pause, mais pas en rafale (3e passage du vérificateur)
  for (const [id, title] of [["agent-l", "Lou"], ["agent-m", "Max"]]) h.addAgent(id, { title, status: "running" });
  await h.tick(2);
  const decs = [];
  for (let i = 0; i < 5; i++) decs.push(await h.api("POST", "/coord/send", { to: "Max", text: `Décision : choix numéro ${i}`, kind: "decision" }, h.id("agent-l")));
  expect(decs.slice(0, 4).every((r) => r.status === 200) && decs[4].status === 429 && code(decs[4]) === "decision_rate", "décisions : 4 par 10 min au plus, la 5e est refusée avec un message clair", decs.map((r) => r.status).join());
  const oneSidedSend = [];
  for (let i = 0; i < 13; i++) oneSidedSend.push(await h.send("agent-m", { to: "Lou", text: `info ${i}`, kind: "fyi" }));
  expect(oneSidedSend.slice(0, 12).every((r) => r.status === 200) && oneSidedSend[12].status === 429 && code(oneSidedSend[12]) === "loop_paused", "boucle : un bavard sans réponse est mis en pause au 13e message", oneSidedSend.map((r) => r.status).join());
  // bavardage via « team » : les copies de groupe comptent, la boucle est vue dès qu'un message direct suit
  for (const [id, title] of [["agent-j", "Jade"], ["agent-k", "Kim"]]) h.addAgent(id, { title, status: "running" });
  await h.tick(2);
  for (let i = 0; i < 6; i++) await h.send(i % 2 ? "agent-k" : "agent-j", { to: "team", text: `bavardage ${i}`, kind: "fyi" });
  const viaGroup = await h.send("agent-j", { to: "Kim", text: "puis un direct", kind: "fyi" });
  expect(viaGroup.status === 429 && code(viaGroup) === "loop_paused", "boucle : des messages échangés via « team » comptent aussi (réserve du vérificateur)", `${viaGroup.status} ${errText(viaGroup)}`);
  // la pause Jade<>Kim est en cours : ni « team » ni une mention ne la contournent (2e passage du vérificateur)
  const teamDuring = await h.send("agent-j", { to: "team", text: "tout le monde, pendant la pause", kind: "fyi" });
  expect(teamDuring.status === 200 && teamDuring.json?.data?.skippedLoop === 1, "boucle : « team » pendant la pause écarte Kim (les autres reçoivent)", `${teamDuring.status} ${JSON.stringify(teamDuring.json?.data || {}).slice(0, 200)}`);
  const kimMsgs = () => h.messages().filter((m) => m.fromLabel === "Jade" && /via mention/.test(m.text));
  const viaMention = await h.send("agent-j", { to: "Eve", text: "via mention @Kim", kind: "fyi" });
  expect(viaMention.status === 200 && kimMsgs().length === 1 && !kimMsgs().some((m) => String(m.to).endsWith("agent-k")), "boucle : une mention n'ajoute pas Kim pendant la pause", `${viaMention.status} ${kimMsgs().length}`);
  const onlyKim = await h.send("agent-j", { to: "role:writer", text: "x", kind: "fyi" });
  expect(onlyKim.status === 200 || onlyKim.status === 429, "boucle : un envoi par rôle pendant la pause répond proprement", String(onlyKim.status));
  // sans échange (sens unique) : pas de boucle
  const oneWay = [];
  for (let i = 0; i < 9; i++) oneWay.push(await h.send("agent-g", { to: "Hal", text: `sens unique ${i}`, kind: "fyi" }));
  expect(oneWay.every((r) => r.status === 200), "boucle : 9 messages à sens unique ne déclenchent rien");
  // fichier modifié → compteur remis à zéro
  await h.tick(2);
  await h.ctx.coord.tick(true);
  const progress0 = h.ctx.coord.thread.fileProgress.get(pkey);
  expect(progress0 && progress0.at === 0, "boucle : première observation des fichiers = référence (pas un progrès)", JSON.stringify(progress0));
  h.addAgent("agent-i", { title: "Ivy", status: "running" });
  h.addAgent("agent-j", { title: "Jon", status: "running" });
  await h.tick(2);
  for (let i = 0; i < 6; i++) await h.send(i % 2 ? "agent-j" : "agent-i", { to: i % 2 ? "Ivy" : "Jon", text: `fichiers ${i}`, kind: "fyi" });
  writeFileSync(join(PROJ, "src", "nouveau.js"), "export const x = 1;\n");
  await h.ctx.coord.tick(true);
  expect(h.ctx.coord.thread.fileProgress.get(pkey).at > 0, "boucle : un fichier modifié (git status + date) est détecté comme un progrès");
  expect((await h.send("agent-i", { to: "Jon", text: "après un fichier modifié", kind: "fyi" })).status === 200, "boucle : un fichier modifié remet le compteur à zéro (échange autorisé)");

  // --- relance unique des questions sans réponse
  h.setStatus(D, "idle");
  await h.tick();
  h.sends.length = 0;
  const rq = await h.send(A, { to: "Dave", text: "Peux-tu confirmer la version de Node ?", kind: "question", needsReply: true, by: 2 });
  const rqMsg = h.messages().find((m) => m.id === rq.json.data.id);
  await sleep(150);
  const wakesBefore = h.wakes(D).length;
  expect(h.ctx.coord.thread.runReminders().reminded === 0, "relance : avant le délai, rien");
  rqMsg.dueAt = iso(Date.now() - 1000);
  const r1 = h.ctx.coord.thread.runReminders();
  await sleep(150);
  expect(r1.reminded === 1 && r1.escalated === 0 && rqMsg.remindedAt, "relance : délai dépassé → UNE relance au destinataire", JSON.stringify(r1));
  const remInbox = (await h.inbox(D)).messages.filter((m) => m.fromPoste && m.replyTo === rqMsg.id);
  expect(remInbox.length === 1 && remInbox[0].kind === "status" && /Node/.test(remInbox[0].text), "relance : message du poste dans la boîte du destinataire (fromPoste, replyTo = la question)");
  expect(h.wakes(D).length === wakesBefore + 1 && /Rappel du poste de commande/.test(h.wakes(D).at(-1).text) && h.wakes(D).at(-1).text.includes(rqMsg.id) && /DONNÉE/.test(h.wakes(D).at(-1).text), "relance : le destinataire au repos est réveillé avec un rappel (donnée, id du message)", h.wakes(D).at(-1)?.text.slice(0, 200));
  const r2 = h.ctx.coord.thread.runReminders();
  expect(r2.reminded === 0 && r2.escalated === 0, "relance : un second passage immédiat ne relance PAS (une seule fois)");
  const inboxItemsBefore = h.ctx.inbox.list({}).filter((i) => /Question sans réponse/.test(i.title)).length;
  rqMsg.remindedAt = iso(Date.now() - 3 * 60000);
  const r3 = h.ctx.coord.thread.runReminders();
  expect(r3.escalated === 1 && r3.reminded === 0, "relance : 2e délai écoulé sans réponse → signalement", JSON.stringify(r3));
  const esc = h.ctx.inbox.list({}).filter((i) => /Question sans réponse/.test(i.title));
  expect(esc.length === inboxItemsBefore + 1 && /Alice/.test(esc[0].title) && /Dave/.test(esc[0].title) && /relancée une fois/.test(esc[0].body), "relance : signalement à Philippe dans la boîte de réception (qui, à qui, « relancée une fois »)", esc[0]?.title);
  expect(proj().some((m) => m.system && /Question sans réponse/.test(m.text)), "relance : événement du poste dans le fil du projet");
  const wakesAfterEsc = h.wakes(D).length;
  const msgCount = h.messages().length;
  const r4 = h.ctx.coord.thread.runReminders();
  await sleep(100);
  expect(r4.reminded === 0 && r4.escalated === 0 && h.messages().length === msgCount && h.wakes(D).length === wakesAfterEsc && h.ctx.inbox.list({}).filter((i) => /Question sans réponse/.test(i.title)).length === inboxItemsBefore + 1, "relance : après le signalement, plus RIEN (ni relance, ni message, ni réveil) : pas de boucle");
  // question répondue : jamais relancée
  const rq2 = await h.send(A, { to: "Dave", text: "Autre question avec réponse", kind: "question", needsReply: true, by: 1 });
  const rq2Msg = h.messages().find((m) => m.id === rq2.json.data.id);
  await h.send(D, { text: "voici", replyTo: rq2Msg.id, kind: "answer" });
  rq2Msg.dueAt = iso(Date.now() - 1000);
  expect(h.ctx.coord.thread.runReminders().reminded === 0 && !rq2Msg.remindedAt, "relance : une question qui a reçu sa réponse n'est jamais relancée");
  // question marquée résolue par Philippe : jamais relancée
  const rq3 = await h.send(A, { to: "Dave", text: "Question que Philippe résout", kind: "question", needsReply: true, by: 1 });
  const rq3Msg = h.messages().find((m) => m.id === rq3.json.data.id);
  await h.human("coord.thread.resolve", { id: rq3Msg.id });
  rq3Msg.dueAt = iso(Date.now() - 1000);
  expect(h.ctx.coord.thread.runReminders().reminded === 0, "relance : un fil marqué résolu par Philippe n'est jamais relancé");
  // destinataire occupé : message déposé, pas de réveil
  h.setStatus(D, "running"); await h.tick();
  const rq4 = await h.send(A, { to: "Dave", text: "Question à un occupé", kind: "question", needsReply: true, by: 1 });
  const rq4Msg = h.messages().find((m) => m.id === rq4.json.data.id);
  rq4Msg.dueAt = iso(Date.now() - 1000);
  const wk = h.wakes(D).length;
  h.ctx.coord.thread.runReminders();
  await sleep(100);
  expect(h.wakes(D).length === wk && rq4Msg.remindedAt, "relance : un destinataire qui travaille reçoit le rappel dans sa boîte, sans être interrompu");

  // --- résolution par Philippe
  const q5 = await h.send(A, { to: "Bobby", text: "Question à résoudre à la main", kind: "question" });
  const resAgent = await h.agent("coord.thread.resolve", { id: q5.json.data.id });
  expect(/Seul Philippe/.test(resAgent.error || "") && h.ctx.coord.thread.threadOf(pkey, 200).find((m) => m.id === q5.json.data.id).status === "open", "« Marquer résolu » demandé par un agent : refusé");
  const resBad = await h.human("coord.thread.resolve", { id: "../../x" });
  const resNone = await h.human("coord.thread.resolve", { id: randomUUID() });
  expect(resBad.error !== null && resNone.error !== null, "« Marquer résolu » : identifiant invalide ou inconnu → erreur");
  const resOk = await h.human("coord.thread.resolve", { id: q5.json.data.id });
  expect(resOk.error === null && resOk.replies.some((r) => r.type === "coord.thread.resolved" && r.resolved === true) && h.ctx.coord.thread.threadOf(pkey, 200).find((m) => m.id === q5.json.data.id).status === "resolved", "« Marquer résolu » (Philippe) : le fil passe à « resolved »");
  expect(!(await h.api("GET", "/coord/digest", undefined, h.id(A))).json.data.digest.includes("Question à résoudre à la main"), "digest : un fil résolu disparaît des questions ouvertes");
  await h.human("coord.thread.resolve", { id: q5.json.data.id, resolved: false });
  expect(h.ctx.coord.thread.threadOf(pkey, 200).find((m) => m.id === q5.json.data.id).status === "open", "« Rouvrir » : le fil redevient « open »");
  const wsThread = await h.human("coord.thread", { host: "local", dir: slash(PROJ) });
  const wsMsgs = wsThread.replies.find((r) => r.type === "coord.thread")?.messages || [];
  expect(wsMsgs.length > 20 && wsMsgs.every((m) => typeof m.kind === "string" && "status" in m && "replyTo" in m && "acks" in m), "WebSocket coord.thread : chaque message porte kind, status, replyTo, acks");

  // --- plafonds existants conservés
  h.addAgent("agent-k", { title: "Kim", status: "idle" });
  h.addAgent("agent-l", { title: "Lou", status: "running" });
  await h.tick(2);
  h.sends.length = 0;
  for (let i = 0; i < 9; i++) { await h.send("agent-l", { to: "Kim", text: `question ${i}`, kind: "question" }); await sleep(30); }
  await sleep(200);
  expect(h.wakes("agent-k").length === 6, "plafond conservé : 6 réveils au plus par session et par 10 min (même avec des questions)", String(h.wakes("agent-k").length));
  expect((await h.inbox("agent-k")).messages.length >= 9 - 6, "plafond conservé : les messages non réveillés restent dans la boîte");
  const flood = [];
  h.ctx.coord.thread.resetRate();
  for (let i = 0; i < 24; i++) flood.push(await h.api("POST", "/coord/send", { to: "Lou", text: `flood ${i}`, kind: "fyi" }, h.id("agent-k")));
  expect(flood.some((r) => r.status === 429 && code(r) === "rate_limited"), "plafond conservé : 20 messages par minute au plus");
  const long = await h.send("agent-l", { to: "Ned", text: "é".repeat(1500), kind: "fyi" });
  expect(long.status === 200 && h.messages().at(-1).text.length === 1000, "plafond conservé : 1000 caractères au plus par message");
  const withCtl = await h.send("agent-l", { to: "Ned", text: "a\u0000b\u202ec\u0007d", kind: "fyi" });
  expect(withCtl.status === 200 && !/[\u0000\u0007\u202e]/.test(h.messages().at(-1).text), "contenu = donnée : caractères de contrôle et de renversement retirés comme avant");

  // --- archivage
  const data = h.ctx.coord._state.data;
  const archive = h.ctx.coord.thread.archiveFile();
  rmSync(archive, { force: true });
  data.messages.length = 0;
  const t0 = Date.now() - 5e6;
  for (let i = 0; i < 380; i++) data.messages.push(msg({ at: iso(t0 + i), project: "arch", kind: i % 2 ? "fyi" : undefined, text: `ancien fyi ${i}` }));
  for (let i = 0; i < 60; i++) data.messages.push(msg({ at: iso(t0 + 400 + i), project: "arch", kind: "status", text: `ancien status ${i}` }));
  for (let i = 0; i < 25; i++) data.messages.push(msg({ at: iso(t0 + 500 + i), project: "arch", kind: "decision", text: `décision ${i}` }));
  for (let i = 0; i < 15; i++) data.messages.push(msg({ at: iso(t0 + 600 + i), project: "arch", kind: "question", text: `question ouverte ${i}` }));
  for (let i = 0; i < 40; i++) data.messages.push(msg({ at: iso(t0 + 700 + i), project: "arch", kind: "fyi", text: `récent ${i}` }));
  expect(data.messages.length === 520, "archivage (préparation) : 520 messages vivants");
  h.ctx.coord.thread.compact();
  expect(data.messages.length === 500, "archivage : le fil vivant est ramené à 500 messages", String(data.messages.length));
  expect(data.messages.filter((m) => m.kind === "decision").length === 25 && data.messages.filter((m) => m.kind === "question").length === 15, "archivage : décisions (25) et fils non résolus (15) TOUS conservés");
  const lines = readFileSync(archive, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.length === 20 && lines.every((l) => l.message && l.archivedAt && l.reason) && lines.every((l) => /ancien fyi/.test(l.message.text)), "archivage : data/coord-archive.jsonl contient les 20 plus anciens fyi (une ligne JSON chacun)", `${lines.length}`);
  expect(lines[0].message.text === "ancien fyi 0" && lines[19].message.text === "ancien fyi 19", "archivage : ordre chronologique conservé");
  // rotation de l'archive
  process.env.DASHBOARD_COORD_ARCHIVE_MAX_BYTES = "6000";
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 60; i++) data.messages.push(msg({ at: iso(Date.now() + round * 1000 + i), project: "arch", kind: "fyi", text: `rotation ${round}-${i} ${"z".repeat(60)}` }));
    h.ctx.coord.thread.compact();
  }
  delete process.env.DASHBOARD_COORD_ARCHIVE_MAX_BYTES;
  expect(existsSync(`${archive}.1`) && statSync(archive).size <= 6000 && statSync(`${archive}.1`).size <= 6000, "archivage : rotation (fichier courant ≤ plafond, ancien déplacé vers .1)", `${statSync(archive).size}`);
  expect(data.messages.length <= 500, "archivage : jamais plus de 500 messages vivants");
  await sleep(500);
  expect(JSON.parse(readFileSync(join(h.dataDir, "coord.json"), "utf8")).messages.length <= 500, "archivage : data/coord.json persisté avec 500 messages au plus");

  // --- reformulation LLM optionnelle (jamais bloquante, clés jamais exposées)
  data.messages.length = 0;
  await h.tick();
  process.env.DASHBOARD_COORD_DIGEST_LLM = "1";
  const llm = h.ctx.coord.thread.llm;
  const calls = [];
  const origCall = llm.call; const origPick = llm.pick;
  llm.pick = () => ({ provider: "stub", model: "stub-model" });
  llm.call = async ({ messages }) => { calls.push(messages[0].content); await sleep(1200); return "Version reformulée. clé sk-abcdefghijklmnop1234567890 fin"; };
  const t1 = Date.now();
  const l1 = (await h.api("GET", "/coord/digest?brief=0", undefined, h.id(A))).json.data;
  expect(Date.now() - t1 < 800 && l1.llm?.state === "pending" && l1.digest.length > 50, "reformulation : l'appel REST n'attend JAMAIS le modèle (résumé à règles tout de suite, llm.state = pending)", `${Date.now() - t1} ms`);
  expect(calls.length === 1 && /DONNÉE/.test(calls[0]) && calls[0].includes("Résumé du projet"), "reformulation : le modèle reçoit le résumé avec la consigne « donnée »");
  await sleep(1500);
  const l2 = (await h.api("GET", "/coord/digest?brief=0", undefined, h.id(A))).json.data;
  expect(l2.llm?.state === "ready" && /Version reformulée/.test(l2.llm.text) && l2.llm.untrusted === true && l2.llm.model === "stub-model", "reformulation : au 2e appel, texte prêt (mis en cache, marqué non fiable)", JSON.stringify(l2.llm));
  expect(!/sk-abcdefghij/.test(JSON.stringify(l2)) && calls.length === 1, "reformulation : toute clé est masquée dans la réponse ; pas de nouvel appel pour un résumé inchangé");
  llm.call = async () => { throw new Error("échec fournisseur sk-secretsecretsecret99"); };
  await h.send("agent-l", { to: "Ned", text: "nouveau contenu qui change le résumé", kind: "decision" });
  await h.api("GET", "/coord/digest?brief=0", undefined, h.id(A));
  await sleep(200);
  const l3 = (await h.api("GET", "/coord/digest?brief=0", undefined, h.id(A))).json.data;
  expect(l3.llm?.state === "error" && !/sk-secret/.test(JSON.stringify(l3)) && !h.logs.join("\n").includes("sk-secret") && l3.digest.length > 50, "reformulation : en cas d'échec, état « error » sans clé (ni réponse ni journal) ; le résumé à règles reste servi", JSON.stringify(l3.llm));
  llm.call = origCall; llm.pick = origPick;
  delete process.env.DASHBOARD_COORD_DIGEST_LLM;
  expect(!("llm" in (await h.api("GET", "/coord/digest?brief=0", undefined, h.id(A))).json.data), "reformulation : désactivée par défaut (variable absente → aucun champ llm)");
  await h.close();
}

// =========================================================================================================
if (run("c")) {
  section("C : serveur MCP (protocole réel) et CLI (processus réels) contre le poste");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const PROJ = mkProject("projc");
  const h = await makeHarness("c", { project: PROJ });
  h.addAgent("agent-a", { title: "Alice" });
  h.addAgent("agent-b", { title: "Bobby", status: "running" });
  await h.tick(2);
  await h.human("brief.create", { host: "local", dir: slash(PROJ) });
  const MCP = join(rootDir, "tools", "paseo-coord-mcp.mjs");
  const CLI = join(rootDir, "tools", "coord.mjs");
  const baseEnv = { PASEO_COORD_URL: h.base, PASEO_COORD_HOME: join(work, "coord-home") };
  const envOf = (agent) => ({ PASEO_SESSION_ID: `local:${agent}`, PASEO_COORD_TOKEN: h.id(agent).token });
  const mkClient = async (agent, name) => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [MCP], env: { ...baseEnv, ...envOf(agent) }, cwd: PROJ, stderr: "pipe" });
    const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    killers.push(() => client.close());
    return client;
  };
  const mcpA = await mkClient("agent-a", "verify-thread-a");
  const mcpB = await mkClient("agent-b", "verify-thread-b");
  const data = (r) => { try { return JSON.parse(textOf(r)); } catch { return null; } };
  const tools = (await mcpA.listTools()).tools;
  const names = tools.map((t) => t.name);
  expect(names.length === 13 && names.includes("coord_digest"), "MCP : 13 outils, dont coord_digest", names.join(","));
  const sendTool = tools.find((t) => t.name === "coord_send");
  const props = sendTool.inputSchema.properties;
  expect(JSON.stringify(sendTool.inputSchema.required) === '["text"]' && props.kind.enum.join() === MSG_KINDS.join() && props.needsReply.type === "boolean" && props.by.maximum === 1440 && props.mentions.maxItems === 8 && props.replyTo.maxLength === 64 && sendTool.inputSchema.additionalProperties === false, "MCP : schéma de coord_send (kind, replyTo, mentions, needsReply, by ; seul text est requis)");
  expect(/fyi et status ne réveillent jamais/.test(sendTool.description) && /replyTo/.test(sendTool.description) && /accusé de réception/.test(sendTool.description), "MCP : la description de coord_send explique les types, replyTo et l'interdiction des accusés");
  expect(/coord_digest/.test(mcpA.getInstructions() || "") && /kind/.test(mcpA.getInstructions() || ""), "MCP : les instructions du serveur annoncent coord_digest et les types");
  const dtool = tools.find((t) => t.name === "coord_digest");
  expect(/EN ARRIVANT/.test(dtool.description) && /3 000/.test(dtool.description) && /DONNÉES/.test(dtool.description) && JSON.stringify(dtool.inputSchema.properties) === "{}", "MCP : coord_digest décrit (à l'arrivée, 3 000 caractères, données)");
  const callA = (name, args) => mcpA.callTool({ name, arguments: args });
  const old = data(await callA("coord_send", { to: "Bobby", text: "ancienne forme MCP" }));
  expect(old?.sent === true && old.kind === "fyi", "MCP : ancienne forme { to, text } toujours valide");
  const typed = data(await callA("coord_send", { to: "Bobby", text: "Quelle base de données ?", kind: "question", needsReply: true, by: 3 }));
  expect(typed?.sent === true && typed.kind === "question" && typed.needsReply === true && typed.dueAt, "MCP : coord_send avec kind, needsReply, by", JSON.stringify(typed));
  const inb = data(await mcpB.callTool({ name: "coord_inbox", arguments: {} }));
  const qIn = inb.messages.find((m) => m.id === typed.id);
  expect(qIn?.kind === "question" && qIn.needsReply === true && /Alice/.test(qIn.fromText), "MCP : coord_inbox du destinataire montre kind, needsReply et l'id");
  const reply = data(await mcpB.callTool({ name: "coord_send", arguments: { text: "PostgreSQL 16", replyTo: typed.id } }));
  expect(reply?.sent === true && reply.to === "local:agent-a" && reply.kind === "answer", "MCP : réponse avec replyTo seulement (pas de « to ») : va à l'asker en « answer »", JSON.stringify(reply));
  for (const [label, args] of [["kind inconnu", { to: "Bobby", text: "x", kind: "urgent" }], ["ni to ni replyTo", { text: "x" }], ["by hors limites", { to: "Bobby", text: "x", needsReply: true, by: 5000 }],
    ["paramètre inconnu", { to: "Bobby", text: "x", priority: 1 }], ["needsReply non booléen", { to: "Bobby", text: "x", needsReply: "oui" }], ["9 mentions", { to: "Bobby", text: "x", mentions: new Array(9).fill("a") }]]) {
    const r = await callA("coord_send", args).catch((e) => ({ isError: true, content: [{ text: String(e.message) }] }));
    expect(r.isError === true, `MCP : ${label} → erreur`, textOf(r));
  }
  const dig = data(await callA("coord_digest"));
  expect(typeof dig?.digest === "string" && dig.digest.length <= 3000 && /Qui travaille sur quoi/.test(dig.digest) && dig.brief?.exists === true && /# Fiche projet — /.test(dig.brief.text) && /DONNÉES/.test(dig.notice), "MCP : coord_digest renvoie le résumé (≤ 3 000) ET la fiche projet en un seul appel", Object.keys(dig || {}).join());
  const decMcp = data(await callA("coord_send", { to: "team", text: "Décision : pas de MongoDB", kind: "decision" }));
  expect(decMcp?.decisionProposal?.proposed === true, "MCP : kind decision → proposition pour la fiche projet");

  const cli = (args, agent = "agent-a", env = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: PROJ, env: { ...process.env, ...baseEnv, ...envOf(agent), ...env }, windowsHide: true });
    let out = ""; let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (c) => resolve({ code: c, out, err }));
  });
  const help = await cli(["--help"]);
  expect(help.code === 0 && /\n  digest  /.test(help.out) && /--kind/.test(help.out) && /--reply-to/.test(help.out) && /--needs-reply/.test(help.out) && /role:writer/.test(help.out), "CLI : l'aide liste digest, --kind, --reply-to, --needs-reply et role:…");
  const c0 = await cli(["send", "Bobby", "ancienne", "forme", "CLI"]);
  expect(c0.code === 0 && /Message envoyé à local:agent-b \(fyi\)/.test(c0.out), "CLI : ancienne forme « send <dest> <texte> » toujours valide", c0.out + c0.err);
  const c1 = await cli(["send", "Bobby", "Quel", "framework", "?", "--kind", "question", "--needs-reply", "--by", "4"]);
  expect(c1.code === 0 && /\(question\) — réponse attendue avant/.test(c1.out), "CLI : --kind question --needs-reply --by 4", c1.out + c1.err);
  const qId = h.messages().find((m) => /Quel framework/.test(m.text))?.id;
  expect(h.messages().find((m) => m.id === qId)?.by === 4, "CLI : le délai --by est transmis");
  const c2 = await cli(["inbox"], "agent-b");
  expect(c2.code === 0 && new RegExp(`<question, réponse attendue, id ${qId}>`).test(c2.out), "CLI : « inbox » affiche le type, « réponse attendue » et l'id", c2.out.slice(0, 400));
  const c3 = await cli(["send", "-", "Vue 3", "--reply-to", qId, "--kind", "answer"], "agent-b");
  expect(c3.code === 0 && /Message envoyé à local:agent-a \(answer\)/.test(c3.out), "CLI : réponse « send - … --reply-to ID » (destinataire omis)", c3.out + c3.err);
  const c4 = await cli(["send", "Bobby", "x", "--kind", "bogus"]);
  expect(c4.code === 1 && /kind/.test(c4.err), "CLI : kind inconnu → erreur lisible, code 1", c4.err);
  const c5 = await cli(["send", "Bobby", "x", "--by", "abc", "--needs-reply"]);
  expect(c5.code === 2 && /Usage/.test(c5.err), "CLI : --by non numérique → usage, code 2");
  const c6 = await cli(["send", "Bobby", "ok"]);
  expect(c6.code === 0 && /Non envoyé : accusé de réception court/.test(c6.out), "CLI : un accusé « ok » est annoncé comme non envoyé", c6.out);
  const c7 = await cli(["send", "Bobby", "Décision : on garde Vue", "--kind", "decision"]);
  expect(c7.code === 0 && /Décision proposée pour la fiche projet/.test(c7.out), "CLI : une décision annonce la proposition faite à Philippe", c7.out);
  const c8 = await cli(["send", "Zorglub", "x"]);
  expect(c8.code === 1 && /Membres : /.test(c8.err), "CLI : destinataire inconnu → liste des membres", c8.err);
  const c9 = await cli(["digest"]);
  expect(c9.code === 0 && /DONNÉES/.test(c9.out) && /Résumé du projet/.test(c9.out) && /Décisions récentes/.test(c9.out) && /Fiche du projet proj/.test(c9.out) && /# Fiche projet — /.test(c9.out), "CLI : « digest » affiche le résumé puis la fiche projet", c9.out.slice(0, 300) + c9.err);
  const c10 = await cli(["digest", "--json"]);
  const cj = (() => { try { return JSON.parse(c10.out); } catch { return null; } })();
  expect(c10.code === 0 && cj?.digest?.length <= 3000 && cj.brief?.exists === true && cj.sections && cj.counts, "CLI : « digest --json » renvoie digest, sections, counts, brief");
  const c11 = await cli(["digest"], "agent-a", { PASEO_SESSION_ID: "", PASEO_COORD_TOKEN: "", PASEO_AGENT_ID: "", PASEO_COORD_HOME: join(work, "vide") });
  expect(c11.code === 3 && /identité/.test(c11.err), "CLI sans identité : digest refusé, code 3");
  await mcpA.close(); await mcpB.close();
  await h.close();
}

// =========================================================================================================
if (run("d")) {
  section("D : instance réelle du tableau de bord (port jetable) : WebSocket réel puis navigateur (fils, pastilles, « Marquer résolu », mobile)");
  const dir = join(work, "inst");
  const data = join(dir, "data");
  mkdirSync(data, { recursive: true });
  const PROJ = mkProject("projd");
  const P = PROJ;
  const pk = projectKey("local", slash(P));
  writeFileSync(join(dir, "hosts.json"), JSON.stringify({ hosts: [{ label: "local", url: "ws://127.0.0.1:9/ws" }] }));
  writeFileSync(join(data, "projects.json"), JSON.stringify({ version: 1, dismissed: true, projects: [{ id: "p38", host: "local", dir: P, name: "projd", color: null, addedAt: new Date().toISOString(), order: 0 }] }));
  const t0 = Date.now() - 3600000;
  const ids = Object.fromEntries(["q1", "q1a", "q2", "q2a", "dec", "blk", "fyi", "old", "st", "q3"].map((k) => [k, randomUUID()]));
  const seedMsg = (k, o) => ({ id: ids[k], at: iso(t0 + Object.keys(ids).indexOf(k) * 60000), from: "local:s1", fromLabel: "Alice", fromKind: "session", to: "local:s2", project: pk, text: k, readAt: iso(t0), ...o });
  const seed = {
    messages: [
      seedMsg("old", { text: "ancien message sans type (compatibilité)", from: "human", fromLabel: "Philippe", fromKind: "human" }),
      seedMsg("q1", { kind: "question", needsReply: true, by: 5, dueAt: iso(t0 + 300000), text: "Quelle base de données choisit-on pour le projet ?", acks: ["Bob"] }),
      seedMsg("q2", { kind: "question", from: "local:s2", fromLabel: "Bob", to: "local:s1", text: "Peux-tu relire le module auth ?" }),
      seedMsg("q2a", { kind: "answer", replyTo: ids.q2, text: "Relu : deux remarques sur les jetons.", from: "local:s1", fromLabel: "Alice", to: "local:s2" }),
      seedMsg("dec", { kind: "decision", text: "Décision : on utilise pnpm pour tout le dépôt." }),
      seedMsg("blk", { kind: "blocker", text: "Bloquée : la CI est cassée depuis ce matin." }),
      seedMsg("fyi", { kind: "fyi", text: "Info : la doc est à jour." }),
      seedMsg("st", { kind: "status", text: "Avancement : 60 % du module menu." }),
      seedMsg("q3", { kind: "handoff", text: "Je passe la main sur le module B à Bob.", needsReply: true }),
    ],
  };
  writeFileSync(join(data, "coord.json"), JSON.stringify(seed));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PASEO_|DASHBOARD_|POSTECTL_|COORD_)/.test(k)));
  const logs = [];
  const dash = spawn(process.execPath, [join(dashboardDir, "server.mjs")], {
    env: { ...clean, DASHBOARD_PORT: String(PORT), DASHBOARD_WSL: "0", DASHBOARD_DATA_DIR: data, DASHBOARD_HOST: "127.0.0.1", DASHBOARD_HOSTS_FILE: join(dir, "hosts.json"), DASHBOARD_COORD_WAKE: "0" },
    cwd: dashboardDir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  dash.stdout.on("data", (d) => logs.push(String(d)));
  dash.stderr.on("data", (d) => logs.push(String(d)));
  killers.push(() => dash.kill());
  const BASE = `http://127.0.0.1:${PORT}`;
  await until(async () => { try { return (await fetch(BASE)).ok; } catch { return false; } }, "démarrage de l'instance", 30000, 200);
  expect(logs.join("").includes("chargé : coord.mjs"), "l'instance charge handlers/coord.mjs", logs.join("").slice(-300));

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ui`, { origin: BASE });
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
  await until(() => ws.readyState === 1, "WebSocket ouvert");
  const ask = async (msg, type, timeout = 8000) => {
    inbox.length = 0;
    ws.send(JSON.stringify(msg));
    return until(() => { const i = inbox.findIndex((m) => m.type === type); return i >= 0 ? inbox.splice(i, 1)[0] : null; }, `${type} après ${msg.type}`, timeout);
  };
  const th = await ask({ type: "coord.thread", host: "local", dir: P }, "coord.thread");
  const byId = Object.fromEntries((th?.messages || []).map((m) => [m.id, m]));
  expect(th?.messages.length === 9 && byId[ids.old].kind === "fyi" && byId[ids.old].status === null, "WebSocket réel : le fil chargé du disque (9 messages) ; l'ancien message sans type est « fyi »");
  expect(byId[ids.q1].status === "open" && byId[ids.q2].status === "answered" && byId[ids.q2a].replyTo === ids.q2 && byId[ids.blk].status === "open" && byId[ids.q3].status === "open" && byId[ids.q1].acks.join() === "Bob", "WebSocket réel : états de fil (open / answered), replyTo, accusés fusionnés (« reçu par Bob »)");
  // un faux client sans l'en-tête Origin attendu ne peut rien
  const foreign = new WebSocket(`ws://127.0.0.1:${PORT}/ui`, { origin: "http://evil.example" });
  const foreignState = await new Promise((res) => { foreign.on("open", () => res("open")); foreign.on("error", () => res("refused")); foreign.on("close", () => res("closed")); setTimeout(() => res("timeout"), 4000); });
  expect(foreignState !== "open", "WebSocket avec une origine étrangère : refusé", foreignState);
  foreign.close();

  const getPlaywright = async () => {
    for (const p of ["playwright-core", "file:///C:/Users/Philippe/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core/index.mjs"]) {
      try { const m = await import(p); return m.default || m; } catch { /* suivant */ }
    }
    throw new Error("playwright-core introuvable");
  };
  const playwright = await getPlaywright();
  const browser = await playwright.chromium.launch({ headless: HEADLESS });
  killers.push(() => { try { browser.process()?.kill(); } catch { /* fermé */ } });
  const shots = join(dashboardDir, "screenshots");
  mkdirSync(shots, { recursive: true });
  const problems = [];
  try {
    const ctxb = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: "dark" });
    const page = await ctxb.newPage();
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource|WebSocket/.test(m.text())) problems.push(`console: ${m.text()}`); });
    await page.goto(`${BASE}/#agents`, { waitUntil: "domcontentloaded" }); await page.locator('[data-agents-open="conversation"]').click();
    await page.locator(".grp-item", { hasText: "projd" }).click({ timeout: 30000 });
    await page.locator("#grp-msgs .grp-bubble").first().waitFor({ timeout: 15000 });
    const q1 = page.locator(`.grp-bubble[data-id="${ids.q1}"]`);
    expect(await q1.count() === 1 && await q1.getAttribute("data-kind") === "question" && await q1.getAttribute("data-status") === "open", "interface : la question sans réponse est affichée (type question, état open)");
    expect(/Question sans réponse/.test(await q1.locator(".grp-state").innerText()) && (await q1.getAttribute("class")).includes("is-open") && /Question/.test(await q1.locator(".grp-kind").first().innerText()), "interface : pastille « Question » + « Question sans réponse » en évidence");
    expect(/reçu par Bob/.test(await q1.locator(".grp-meta").innerText()), "interface : « reçu par Bob » (accusé fusionné) affiché");
    const blk = page.locator(`.grp-bubble[data-id="${ids.blk}"]`);
    expect(/Blocage ouvert/.test(await blk.locator(".grp-state").innerText()) && /Blocage/.test(await blk.locator(".grp-kind").innerText()), "interface : un blocage ouvert est signalé (pastille « Blocage » + « Blocage ouvert »)");
    const dec = page.locator(`.grp-bubble[data-id="${ids.dec}"]`);
    expect(/Décision/.test(await dec.locator(".grp-kind").innerText()) && await dec.locator(".grp-state").count() === 0, "interface : une décision porte sa pastille, sans état de fil");
    const old = page.locator(`.grp-bubble[data-id="${ids.old}"]`);
    expect(await old.locator(".grp-kind").count() === 0 && await old.locator(".grp-state").count() === 0, "interface : un ancien message sans type s'affiche comme avant (aucune pastille)");
    expect(await page.locator(`.grp-bubble[data-id="${ids.fyi}"] .grp-kind`).count() === 0 && /Statut/.test(await page.locator(`.grp-bubble[data-id="${ids.st}"] .grp-kind`).innerText()), "interface : fyi sans pastille ; status avec pastille « Statut »");
    expect((await page.locator("#grp-brief-btn").innerText()).trim() === "Fiche projet" && !/null/.test(await page.locator("#grp-members").innerText()), "interface : aucun « null » parasite (bouton « Fiche projet », liste des membres)");
    // fil repliable : la question répondue est repliée, sa réponse est dedans
    const thr = page.locator(`.grp-thread[data-thread="${ids.q2}"]`);
    expect(await thr.count() === 1 && await thr.getAttribute("data-replies") === "1", "interface : la réponse est rangée sous sa question dans un fil (1 réponse)");
    expect(await thr.locator("details").evaluate((d) => d.open) === false && /1 réponse/.test(await thr.locator("summary").innerText()) && /Répondu/.test(await thr.locator("summary").innerText()), "interface : fil répondu = replié par défaut, résumé « Répondu · 1 réponse »");
    expect(!(await thr.locator(".grp-bubble").first().isVisible()), "interface : le contenu d'un fil replié n'est pas visible");
    await thr.locator("summary").click();
    expect(await thr.locator("details").evaluate((d) => d.open) === true && await thr.locator(".grp-bubble").count() === 2 && /Relu : deux remarques/.test(await thr.innerText()), "interface : un clic déplie le fil (question + réponse visibles)");
    await page.screenshot({ path: join(shots, "t38-fil-sombre.png") });
    await thr.locator("summary").focus();
    await page.keyboard.press("Enter");
    expect(await thr.locator("details").evaluate((d) => d.open) === false, "interface : clavier (Entrée sur le résumé) replie le fil");
    await thr.locator("summary").click(); // réouvre pour la capture
    // « Marquer résolu »
    const resolveBtn = q1.locator('[data-action="thread-resolve"]');
    expect(await resolveBtn.count() === 1 && /Marquer résolu/.test(await resolveBtn.innerText()), "interface : bouton « Marquer résolu » sur la question sans réponse");
    expect(await dec.locator('[data-action="thread-resolve"]').count() === 0, "interface : pas de bouton « Marquer résolu » sur un message qui n'attend rien");
    await resolveBtn.click();
    await page.waitForFunction((id) => document.querySelector(`.grp-bubble[data-id="${id}"]`)?.dataset.status === "resolved", ids.q1, { timeout: 10000 });
    expect(/Résolu/.test(await q1.locator(".grp-state").innerText()) && !(await q1.getAttribute("class")).includes("is-open") && await q1.locator('[data-action="thread-resolve"]').count() === 0, "interface : après « Marquer résolu » : état « Résolu », mise en évidence et bouton retirés");
    await until(() => { try { return JSON.parse(readFileSync(join(data, "coord.json"), "utf8")).messages.find((m) => m.id === ids.q1)?.resolved === true; } catch { return false; } }, "résolution persistée sur le disque", 15000);
    ok("interface : la résolution est écrite dans data/coord.json");
    // mobile : 390 px, pas de défilement horizontal
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const widths = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth, document.querySelector("#grp-msgs")?.scrollWidth, document.querySelector("#grp-msgs")?.clientWidth]);
    expect(widths[0] <= widths[1] && widths[2] <= widths[3], "interface : 390 px sans défilement horizontal (page et fil)", JSON.stringify(widths));
    await page.screenshot({ path: join(shots, "t38-fil-mobile.png") });
    // thème clair
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, "t38-fil-clair.png") });
    const lightOk = await page.evaluate(() => { const s = getComputedStyle(document.querySelector(".grp-state") || document.body); return Boolean(s.color); });
    expect(lightOk, "interface : thème clair rendu (capture t38-fil-clair.png)");
    expect(problems.length === 0, "interface : console sans erreur ni exception", problems.join(" | "));
  } finally { await browser.close(); }
  ws.close();
}

finish();
