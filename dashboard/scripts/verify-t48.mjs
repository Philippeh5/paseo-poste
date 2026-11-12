// dashboard/scripts/verify-t48.mjs — Ticket T48 : BlastWin sous confirmation, sauvegarde, vérification, retour arrière.
// Hors ligne, aucun LLM, aucun daemon réel, ne touche pas :7070 ni ~/Projets/BlastWin.
// Utilise un dépôt git jetable simulant BlastWin et un dossier de données jetable.
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "..");

// GUARD_HOME doit être défini AVANT l'import de guardrails.mjs (const HOME captée au chargement).
const tmp = mkdtempSync(join(tmpdir(), "t48-"));
const H = join(tmp, "home");
const BLAST = join(H, "Projets", "BlastWin");
const DATA = join(tmp, "data");
mkdirSync(BLAST, { recursive: true });
mkdirSync(DATA, { recursive: true });
process.env.GUARD_HOME = H;
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

const { checkProjectDir, checkToolCall } = await import(pathToFileURL(join(root, "lib", "guardrails.mjs")).href);
const { register } = await import(pathToFileURL(join(root, "handlers", "tasks.mjs")).href);

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Dépôt git jetable simulant BlastWin (recréé à neuf pour chaque scénario). check.mjs est le « test » du projet :
// il échoue si a.txt ET b.txt existent ensemble (conflit sémantique que git ne voit pas).
function freshBlast() {
  rmSync(BLAST, { recursive: true, force: true });
  mkdirSync(join(BLAST, "game"), { recursive: true });
  git(BLAST, "init", "-q", "-b", "main");
  writeFileSync(join(BLAST, "README.md"), "# BlastWin (jetable)\n");
  writeFileSync(join(BLAST, "game/server.js"), "console.log('jeu');\n");
  writeFileSync(join(BLAST, "check.mjs"),
    "import { existsSync } from 'node:fs';\nif (existsSync('a.txt') && existsSync('b.txt')) { console.error('conflit semantique'); process.exit(1); }\n");
  git(BLAST, "add", ".");
  git(BLAST, "commit", "-qm", "etat initial");
}
function commitFile(cwd, name, content, msg) {
  writeFileSync(join(cwd, name), content);
  git(cwd, "add", name);
  git(cwd, "commit", "-qm", msg);
}
freshBlast();
const HEAD_BEFORE = git(BLAST, "rev-parse", "HEAD");

let fails = 0;
function expect(cond, label, detail = "") {
  if (cond) { console.log(`OK   ${label}`); return; }
  fails++;
  console.error(`FAIL ${label}${detail ? ` -> ${detail}` : ""}`);
}
function section(name) { console.log(`\n=== ${name} ===`); }

// ============================================================================
// G1 — garde « confirmable » vs refus durs (guardrails.mjs)
// ============================================================================
section("G1 — garde « confirmable » vs refus durs");

const rBlast = checkProjectDir(BLAST);
expect(!rBlast.allow && rBlast.guard === "blastwin" && rBlast.confirmable === true,
  "checkProjectDir(BlastWin) = {allow:false, guard:'blastwin', confirmable:true}", JSON.stringify(rBlast));
expect(checkProjectDir(join(H, "Projets", "Autre")).allow === true, "autre projet autorisé par checkProjectDir");

// Refus durs absolus (même après confirmation, pas de contournement possible).
writeFileSync(join(H, ".env"), "sk-or-v1-" + "a".repeat(20) + "\n");
expect(!checkToolCall("Write", { file_path: join(H, ".env"), content: "x" }).allow, "secret .env : écriture refusée");
expect(!checkToolCall("Bash", { command: "git push --force origin main" }).allow, "force-push refusé");
expect(!checkToolCall("Bash", { command: "git push origin main" }).allow, "push direct sur main refusé");
expect(!checkToolCall("Bash", { command: "systemctl restart blastwin-game" }).allow, "service BlastWin refusé");


// ============================================================================
// Harness : tasks.mjs et agentapi.mjs RÉELS, seuls le daemon d'agents, la boîte de réception (même contrat que
// handlers/inbox.mjs : références partagées, mark(ids, status)) et le journal sont simulés.
// ============================================================================
const HUMAN = () => ({ _uiId: `ui-${randomUUID()}` });          // navigateur de Philippe
const AGENT = () => ({ _uiId: `invoke:${randomUUID()}` });      // ctx.invoke : API agent / mode Agent

function makeInbox() {
  const items = [];
  return {
    items,
    list: (f = {}) => items.filter((i) => (!f.kind || i.kind === f.kind) && (!f.status || i.status === f.status)),
    add: (raw) => { const e = { id: `inb_${randomUUID().slice(0, 8)}`, status: "nouveau", ...raw }; items.unshift(e); return e; },
    mark: (ids, status) => { let n = 0; for (const i of items) if ([].concat(ids).includes(i.id) && i.status !== status) { i.status = status; n++; } return n; },
  };
}

function bootTasks(dataDir) {
  const inbox = makeInbox();
  const activity = [];
  const sent = [];
  const handlers = {};
  const startedAgents = [];
  const ctx = {
    dataDir, inbox,
    agentActivity: { record: (e) => activity.push(e) },
    agentMode: { getState: () => ({ enabled: false }) },
    hosts: {
      labels: () => ["local"], has: (h) => h === "local",
      get: () => ({
        connected: () => true,
        api: {
          workspaces: { open: async () => ({ id: "ws-1" }) },
          agents: { create: async (opts) => { const id = `agent-${randomUUID().slice(0, 8)}`; startedAgents.push({ id, opts }); return { id }; } },
        },
        daemon: { cancelAgent: async () => {}, archiveAgent: async () => {} },
      }),
    },
    store: { read: (key, def) => (key === "projects" ? { projects: [] } : def) },
    log: () => {}, safeError: String, broadcastState: () => {},
    onMessage: (type, fn) => { handlers[type] = fn; },
    send: (_ws, m) => sent.push(m), broadcast: () => {},
    sendError: (_ws, m) => sent.push({ type: "error", error: m }),
    onStateChange: () => {},
  };
  // Exécute un handler comme le fait le serveur ; renvoie les messages émis pendant l'appel.
  ctx.run = async (who, type, payload = {}) => {
    const before = sent.length;
    await handlers[type](who === "human" ? HUMAN() : AGENT(), payload);
    return sent.slice(before);
  };
  // ctx.invoke interne (ex. création d'un correctif par tasks.mjs) : un appel « agent ».
  ctx.invoke = async (type, payload) => {
    const msgs = await ctx.run("agent", type, payload);
    return msgs.find((m) => m.type?.startsWith("task.")) ?? { ok: true };
  };
  register(ctx);
  ctx.__test = { inbox, inboxItems: inbox.items, activity, sent, handlers, startedAgents };
  ctx.row = async (id) => (await ctx.run("human", "task.list")).find((m) => m.type === "tasks").tasks.find((t) => t.id === id);
  return ctx;
}

const hasError = (msgs) => msgs.some((m) => m.type === "error");
const pending = (ctx, kind) => ctx.__test.inboxItems.find((i) => i.action?.kind === kind && i.status === "nouveau");

// Crée une tâche BlastWin, la démarre (→ demande), Philippe confirme (→ sauvegarde + agent simulé).
async function startBlastTask(ctx, title) {
  const id = (await ctx.run("agent", "task.create", {
    title, description: "test", project: BLAST, host: "local", engine: "claude-openrouter/sonnet",
    mode: "bypassPermissions", isolation: "local", branch: "", status: "todo",
  })).find((m) => m.type === "task.created").id;
  await ctx.run("agent", "task.start", { id });
  const confirm = pending(ctx, "blastwin-confirm");
  const before = ctx.__test.startedAgents.length;
  await ctx.run("human", "blastwin.decide", { id: confirm.id, approve: true });
  await sleep(50);
  const row = await ctx.row(id);
  // Le daemon (non simulé ici) créerait le worktree agent/<id> ; on le crée à la main.
  const wt = join(tmp, `wt-${id}`);
  git(BLAST, "worktree", "add", "-q", "-b", `agent/${id}`, wt);
  return { id, row, wt, confirm, started: ctx.__test.startedAgents.length - before };
}

const setVerify = (dir, project, cmds) => writeFileSync(join(dir, "project-verify.json"), JSON.stringify({ [project]: cmds }));
let scenario = 0;
const newData = () => { const d = join(tmp, `data-${++scenario}`); mkdirSync(d, { recursive: true }); return d; };

// ============================================================================
// G2 — confirmation avant tout agent, uniquement par Philippe
// ============================================================================
section("G2 — confirmation BlastWin avant démarrage");
{
  freshBlast();
  const ctx = bootTasks(newData());
  const { inboxItems, startedAgents } = ctx.__test;
  const id = (await ctx.run("agent", "task.create", {
    title: "Tâche BlastWin test", description: "test", project: BLAST, host: "local",
    engine: "claude-openrouter/sonnet", mode: "bypassPermissions", isolation: "local", branch: "", status: "todo",
  })).find((m) => m.type === "task.created").id;
  await ctx.run("agent", "task.start", { id });
  const item = pending(ctx, "blastwin-confirm");
  expect(!!item && item.title.includes("BlastWin") && item.status === "nouveau", "demande blastwin-confirm créée, en attente", item?.title);
  expect(startedAgents.length === 0, "aucun agent lancé avant approbation");
  expect((await ctx.row(id)).status === "todo", "la tâche reste « À faire »");

  // Falsification : l'agent marque la demande « traité » sans décision « allow » -> toujours pas de démarrage.
  ctx.inbox.mark([item.id], "traité");
  await ctx.run("agent", "task.start", { id });
  expect(startedAgents.length === 0, "demande marquée « traité » sans décision allow : aucun agent");

  // Philippe refuse : rien ne démarre.
  const ctx2 = bootTasks(newData());
  const id2 = (await ctx2.run("agent", "task.create", { title: "refus", project: BLAST, host: "local", engine: "claude-openrouter/sonnet", status: "todo" })).find((m) => m.type === "task.created").id;
  await ctx2.run("agent", "task.start", { id: id2 });
  await ctx2.run("human", "blastwin.decide", { id: pending(ctx2, "blastwin-confirm").id, approve: false });
  await ctx2.run("agent", "task.start", { id: id2 });
  expect(ctx2.__test.startedAgents.length === 0, "refus de Philippe : aucun agent");
}

// ============================================================================
// G3 — sauvegarde AVANT + worktree
// ============================================================================
section("G3 — sauvegarde AVANT (tag + bundle + copie) puis agent");
{
  freshBlast();
  writeFileSync(join(BLAST, "README.md"), "# modif locale non commitée\n"); // doit être copiée dans la sauvegarde
  const data = newData();
  const ctx = bootTasks(data);
  const t = await startBlastTask(ctx, "backup");
  expect(t.started === 1, "agent lancé après l'approbation de Philippe", String(t.started));
  const tags = git(BLAST, "tag", "-l", "pre-agent/*").split("\n").filter(Boolean);
  expect(tags.some((x) => x.startsWith(`pre-agent/${t.id}`)), "tag pre-agent/<id>-<ts> sur le vrai dépôt", tags.join(","));
  const bdir = join(data, "agent-backups", "blastwin");
  const dirs = existsSync(bdir) ? execFileSync("ls", [bdir], { encoding: "utf8" }).split("\n").filter((d) => d.startsWith(t.id)) : [];
  expect(dirs.length === 1, "dossier de sauvegarde créé", dirs.join(","));
  if (dirs.length) {
    const d = join(bdir, dirs[0]);
    expect(execFileSync("ls", [d], { encoding: "utf8" }).includes(".bundle"), "bundle HEAD présent");
    expect(existsSync(join(d, "_index.json")), "_index.json présent");
    expect(existsSync(join(d, "README.md")) && readFileSync(join(d, "README.md"), "utf8").includes("modif locale"), "copie du fichier modifié non commité");
  }
  const launched = ctx.__test.startedAgents.at(-1)?.opts;
  expect(launched?.worktree?.newBranch === `agent/${t.id}`, "agent lancé dans un worktree sur la branche agent/<id> (jamais dans le vrai dossier)", JSON.stringify(launched?.worktree));
  expect(git(BLAST, "rev-parse", "HEAD") === git(BLAST, "rev-parse", "main"), "HEAD du vrai dépôt non touché par le démarrage");
  expect(readFileSync(join(BLAST, "README.md"), "utf8").includes("modif locale"), "modification locale du vrai dossier intacte");
}

// ============================================================================
// G4 — vérification APRÈS travail : vraies fonctions
// ============================================================================
section("G4 — vérification après travail (verifyBlastwinTask réel + task.move réel)");
{
  freshBlast();
  const data = newData();
  const ctx = bootTasks(data);
  const t = await startBlastTask(ctx, "verif");
  const { verifyBlastwinTask } = ctx.blastwin;
  const fake = { ...t.row, project: BLAST };

  // Appel direct de la vraie fonction.
  setVerify(data, BLAST, ["echo vert", "node check.mjs"]);
  let v = await verifyBlastwinTask(fake, t.wt);
  expect(v.passed === true && v.commands.length === 2 && v.commands.every((c) => c.ok), "verifyBlastwinTask : tout vert -> passed", JSON.stringify(v.commands.map((c) => c.ok)));
  setVerify(data, BLAST, ["echo vert", "exit 3", "echo encore"]);
  v = await verifyBlastwinTask(fake, t.wt);
  expect(v.passed === false && JSON.stringify(v.commands.map((c) => c.ok)) === "[true,false,true]", "verifyBlastwinTask : une commande rouge -> passed=false, résultats par commande", JSON.stringify(v.commands.map((c) => c.ok)));
  setVerify(data, "/autre", ["echo x"]);
  v = await verifyBlastwinTask({ ...fake, project: join(tmp, "sans-config") }, t.wt);
  expect(v.passed === false, "aucune commande de vérification connue -> jamais « vert » par défaut");

  // Rouge dans le worktree : task.move vers « done » est bloqué, pas de demande de fusion, rien de fusionné.
  commitFile(t.wt, "a.txt", "a\n", "agent : a");
  commitFile(t.wt, "b.txt", "b\n", "agent : b (casse check.mjs)");
  setVerify(data, BLAST, ["node check.mjs"]);
  const headBefore = git(BLAST, "rev-parse", "HEAD");
  await ctx.run("human", "task.move", { id: t.id, status: "done" });
  await sleep(100);
  const row = await ctx.row(t.id);
  expect(row.status === "blocked", "vérification rouge : tâche « Bloquée »", row.status);
  expect(!ctx.__test.inboxItems.some((i) => i.action?.kind === "blastwin-merge"), "vérification rouge : aucune demande de fusion");
  expect(ctx.__test.inboxItems.some((i) => i.kind === "erreur" && /Vérification rouge/.test(i.title)), "vérification rouge : alerte dans la boîte de réception");
  expect(git(BLAST, "rev-parse", "HEAD") === headBefore && !existsSync(join(BLAST, "a.txt")), "le vrai BlastWin n'a pas bougé");
  expect(ctx.__test.inboxItems.some((i) => /Correctif/.test(i.title)), "correctif planifié (tentative 1/2)");
  git(BLAST, "worktree", "remove", "--force", t.wt);
}

section("G4b — correctif : reprend le worktree d'origine, plafond de 2, puis fusion de la branche d'origine");
{
  freshBlast();
  const data = newData();
  const ctx = bootTasks(data);
  const t = await startBlastTask(ctx, "origine");
  setVerify(data, BLAST, ["node check.mjs"]);
  commitFile(t.wt, "a.txt", "a\n", "agent : a");
  commitFile(t.wt, "b.txt", "b\n", "agent : b (casse check.mjs)");
  const correctifs = async () => (await ctx.run("human", "task.list")).find((m) => m.type === "tasks").tasks.filter((x) => /^Correctif :/.test(x.title));
  await ctx.run("human", "task.move", { id: t.id, status: "done" });
  await sleep(100);
  let cs = await correctifs();
  expect(cs.length === 1 && cs[0].branch === `agent/${t.id}`, "vérification rouge : 1 correctif créé, sur la branche d'origine", JSON.stringify(cs.map((c) => c.branch)));

  // Démarrage du correctif (nouvelle confirmation de Philippe) : l'agent reprend le worktree existant.
  async function startCorrectif(c) {
    await ctx.run("agent", "task.start", { id: c.id });
    const confirm = ctx.__test.inboxItems.find((i) => i.action?.kind === "blastwin-confirm" && i.action.taskId === c.id && i.status === "nouveau");
    await ctx.run("human", "blastwin.decide", { id: confirm.id, approve: true });
    await sleep(50);
  }
  await startCorrectif(cs[0]);
  const opts = ctx.__test.startedAgents.at(-1).opts;
  expect(opts.cwd === t.wt && !opts.worktree, "le correctif travaille dans le worktree d'origine (pas de nouvelle branche)", JSON.stringify({ cwd: opts.cwd, worktree: opts.worktree }));

  // Le correctif retire b.txt : sa vérification (réelle, sur la branche d'origine) est verte -> demande de fusion de agent/<origine>.
  git(t.wt, "rm", "-q", "b.txt");
  git(t.wt, "commit", "-qm", "correctif : retire b.txt");
  await ctx.run("human", "task.move", { id: cs[0].id, status: "done" });
  await sleep(100);
  const mergeItem = pending(ctx, "blastwin-merge");
  expect(mergeItem?.action.taskId === cs[0].id && /agent\//.test(mergeItem.body) && mergeItem.body.includes(`agent/${t.id}`), "correctif vert : demande de fusion de la branche d'origine", mergeItem?.body.slice(0, 80));
  const r = (await ctx.run("human", "blastwin.decide", { id: mergeItem.id, approve: true })).find((m) => m.type === "task.merged");
  expect(r?.ok === true && existsSync(join(BLAST, "a.txt")) && !existsSync(join(BLAST, "b.txt")), "fusion du travail corrigé dans le vrai dépôt", JSON.stringify(r));
  git(BLAST, "worktree", "remove", "--force", t.wt);

  // Plafond : origine rouge -> correctif 1 rouge -> correctif 2 rouge -> bloqué, pas de 3e correctif.
  freshBlast();
  const data2 = newData();
  const c2 = bootTasks(data2);
  const u = await startBlastTask(c2, "plafond");
  setVerify(data2, BLAST, ["exit 1"]);
  const all = async () => (await c2.run("human", "task.list")).find((m) => m.type === "tasks").tasks.filter((x) => /^Correctif :/.test(x.title));
  await c2.run("human", "task.move", { id: u.id, status: "done" }); await sleep(80);
  for (let round = 0; round < 2; round++) {
    const cur = (await all()).find((x) => x.status === "todo");
    if (!cur) break;
    await c2.run("agent", "task.start", { id: cur.id });
    const conf = c2.__test.inboxItems.find((i) => i.action?.kind === "blastwin-confirm" && i.action.taskId === cur.id && i.status === "nouveau");
    await c2.run("human", "blastwin.decide", { id: conf.id, approve: true }); await sleep(50);
    await c2.run("human", "task.move", { id: cur.id, status: "done" }); await sleep(80);
  }
  expect((await all()).length === 2, "plafond : 2 correctifs au plus pour une même branche", String((await all()).length));
  expect(c2.__test.inboxItems.some((i) => /BlastWin bloqué/.test(i.title)), "après le plafond : « BlastWin bloqué », Philippe prévenu");
  expect(!c2.__test.inboxItems.some((i) => i.action?.kind === "blastwin-merge"), "jamais de demande de fusion tant que c'est rouge");
  git(BLAST, "worktree", "remove", "--force", u.wt);
}

// ============================================================================
// G5 — fusion réelle : 2e confirmation, doBlastwinMerge réel, revérification dans le vrai dossier
// ============================================================================
async function mergeScenario({ title, mainAfter, dirty, agentFile = ["a.txt", "a\n"] }) {
  freshBlast();
  const data = newData();
  const ctx = bootTasks(data);
  const t = await startBlastTask(ctx, title);
  setVerify(data, BLAST, ["node check.mjs"]);
  commitFile(t.wt, agentFile[0], agentFile[1], "agent : travail");
  if (mainAfter) commitFile(BLAST, mainAfter[0], mainAfter[1], "main : travail concurrent");
  if (dirty) dirty(BLAST);
  const preHead = git(BLAST, "rev-parse", "HEAD");
  const statusBefore = git(BLAST, "status", "--porcelain");
  await ctx.run("human", "task.move", { id: t.id, status: "done" });
  await sleep(100);
  return { ctx, data, t, preHead, statusBefore, mergeItem: pending(ctx, "blastwin-merge") };
}

section("G5 — fusion dans le vrai BlastWin (réelle) : 2e confirmation, tag, merge --no-ff, revérification");
{
  const s = await mergeScenario({ title: "fusion verte" });
  const { ctx, t, preHead, mergeItem } = s;
  expect((await ctx.row(t.id)).status === "done", "vérification verte : la tâche passe « Terminée »");
  expect(!!mergeItem, "demande blastwin-merge (2e confirmation) créée après vérification verte", mergeItem?.title);
  expect(git(BLAST, "rev-parse", "HEAD") === preHead && !existsSync(join(BLAST, "a.txt")), "rien fusionné tant que Philippe n'a pas approuvé");

  // Sans approbation, task.merge (appel agent) est refusé.
  const refused = await ctx.run("agent", "task.merge", { id: t.id });
  expect(refused.some((m) => m.type === "task.merged" && m.ok === false && /non autorisée/.test(m.error || "")), "task.merge sans approbation de Philippe : refusé");
  expect(git(BLAST, "rev-parse", "HEAD") === preHead, "HEAD inchangé après le task.merge refusé");

  // Philippe approuve -> doBlastwinMerge réel.
  const msgs = await ctx.run("human", "blastwin.decide", { id: mergeItem.id, approve: true });
  const merged = msgs.find((m) => m.type === "task.merged");
  expect(merged?.ok === true && merged.merged === true && merged.rolledBack === false, "fusion effectuée, revérification verte", JSON.stringify(merged));
  expect(existsSync(join(BLAST, "a.txt")), "le fichier de l'agent est dans le vrai dépôt");
  expect(git(BLAST, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length === 3, "commit de fusion --no-ff (2 parents)");
  expect(git(BLAST, "tag", "-l", "pre-merge/*").split("\n").some((x) => x.startsWith(`pre-merge/${t.id}`)) && git(BLAST, "rev-parse", merged.tag + "^{commit}") === preHead, "tag pre-merge/<id>-<ts> = HEAD d'avant");
  expect(git(BLAST, "remote") === "", "aucun remote -> aucun push possible (et le code n'en fait aucun)");
  // Approbation à usage unique.
  const again = await ctx.run("agent", "task.merge", { id: t.id });
  expect(again.some((m) => m.type === "task.merged" && m.ok === false), "approbation à usage unique : 2e fusion refusée");
  git(BLAST, "worktree", "remove", "--force", t.wt);
}

section("G5b — revérification rouge, arbre PROPRE : rollback (reset --merge) vers le HEAD d'avant");
{
  // main reçoit b.txt pendant que l'agent ajoute a.txt : verte séparément, rouge une fois fusionnée.
  const s = await mergeScenario({ title: "rollback propre", mainAfter: ["b.txt", "b\n"] });
  const { ctx, t, preHead, mergeItem } = s;
  expect(!!mergeItem, "vérification dans le worktree verte -> demande de fusion");
  const msgs = await ctx.run("human", "blastwin.decide", { id: mergeItem.id, approve: true });
  const r = msgs.find((m) => m.type === "task.merged");
  expect(r?.rolledBack === true && r.ok === false && r.how === "reset --merge", "revérification rouge détectée par la vraie fonction -> rollback", JSON.stringify(r));
  expect(git(BLAST, "rev-parse", "HEAD") === preHead, "HEAD rétabli exactement au commit d'avant la fusion");
  expect(!existsSync(join(BLAST, "a.txt")) && existsSync(join(BLAST, "b.txt")), "fichier de l'agent retiré, le travail propre de main conservé");
  expect(git(BLAST, "status", "--porcelain") === "", "arbre de travail propre");
  expect(ctx.__test.inboxItems.some((i) => i.kind === "erreur" && /fusion annulée/.test(i.title)), "Philippe est prévenu (boîte de réception)");
  git(BLAST, "worktree", "remove", "--force", t.wt);
}

section("G5c — revérification rouge, arbre NON PROPRE : revert -m 1, aucune modification non commitée perdue");
{
  const DIRTY_README = "# BlastWin\nNOTES NON COMMITÉES de Philippe\n";
  const s = await mergeScenario({
    title: "rollback sale", mainAfter: ["b.txt", "b\n"],
    dirty: (dir) => { writeFileSync(join(dir, "README.md"), DIRTY_README); writeFileSync(join(dir, "notes.txt"), "brouillon\n"); },
  });
  const { ctx, t, preHead, statusBefore, mergeItem } = s;
  expect(statusBefore.includes("M README.md") && statusBefore.includes("?? notes.txt"), "préparation : arbre sale (README modifié + notes.txt non suivi)", statusBefore);
  const msgs = await ctx.run("human", "blastwin.decide", { id: mergeItem.id, approve: true });
  const r = msgs.find((m) => m.type === "task.merged");
  expect(r?.rolledBack === true && r.how === "revert -m 1", "arbre sale -> rollback par revert -m 1 (pas de reset)", JSON.stringify(r));
  expect(readFileSync(join(BLAST, "README.md"), "utf8") === DIRTY_README, "README.md non commité : contenu identique à l'octet");
  expect(readFileSync(join(BLAST, "notes.txt"), "utf8") === "brouillon\n", "fichier non suivi notes.txt intact");
  expect(git(BLAST, "status", "--porcelain") === statusBefore, "git status identique à avant la fusion", git(BLAST, "status", "--porcelain"));
  expect(git(BLAST, "diff", "--stat", preHead, "HEAD") === "", "arbre commité identique à celui d'avant la fusion (a.txt retiré)");
  expect(/^Revert /.test(git(BLAST, "log", "-1", "--format=%s")), "historique : commit « Revert » (jamais de réécriture)", git(BLAST, "log", "-1", "--format=%s"));
  expect(git(BLAST, "rev-parse", r.tag + "^{commit}") === preHead, "tag pre-merge pointe sur le HEAD d'avant");
  git(BLAST, "worktree", "remove", "--force", t.wt);
}

section("G5d — fusion impossible (fichier local en conflit) : refus propre, rien perdu");
{
  const DIRTY = "# BlastWin\nmodif locale qui gêne la fusion\n";
  const s = await mergeScenario({
    title: "fusion gênée", agentFile: ["README.md", "# README modifié par l'agent\n"],
    dirty: (dir) => writeFileSync(join(dir, "README.md"), DIRTY),
  });
  const { ctx, t, preHead, mergeItem } = s;
  const r = (await ctx.run("human", "blastwin.decide", { id: mergeItem.id, approve: true })).find((m) => m.type === "task.merged");
  expect(r?.ok === false && r.merged === false && !r.rolledBack, "fusion refusée par git, annoncée comme échec", JSON.stringify(r));
  expect(readFileSync(join(BLAST, "README.md"), "utf8") === DIRTY, "README.md non commité intact");
  expect(git(BLAST, "rev-parse", "HEAD") === preHead && !existsSync(join(BLAST, ".git", "MERGE_HEAD")), "HEAD inchangé, aucune fusion à moitié faite");
  git(BLAST, "worktree", "remove", "--force", t.wt);
}

// ============================================================================
// G7 — pas d'auto-approbation : API agent (réelle) et WebSocket
// ============================================================================
section("G7 — une approbation venant de l'agent est refusée");
{
  const { register: registerApi } = await import(pathToFileURL(join(root, "handlers", "agentapi.mjs")).href);
  for (const mandateOn of [false, true]) {
    freshBlast();
    const ctx = bootTasks(newData());
    const t = await startBlastTask(ctx, `auto-approbation mandat=${mandateOn}`);
    const inbox = ctx.__test.inbox;
    // 1re confirmation : démarrage d'une 2e tâche, laissée en attente.
    const id2 = (await ctx.run("agent", "task.create", { title: "T2", project: BLAST, host: "local", engine: "claude-openrouter/sonnet", status: "todo" })).find((m) => m.type === "task.created").id;
    await ctx.run("agent", "task.start", { id: id2 });
    const confirm2 = pending(ctx, "blastwin-confirm");
    // 2e confirmation : fusion en attente pour la 1re tâche.
    setVerify(ctx.dataDir, BLAST, ["node check.mjs"]);
    commitFile(t.wt, "a.txt", "a\n", "agent");
    await ctx.run("human", "task.move", { id: t.id, status: "done" });
    const mergeItem = pending(ctx, "blastwin-merge");
    const preHead = git(BLAST, "rev-parse", "HEAD");
    const agentsBefore = ctx.__test.startedAgents.length;

    // API agent réelle (agentapi.mjs) branchée sur ces mêmes handlers.
    let httpHandler;
    const apiCtx = {
      ...ctx,
      onHttpPrefix: (_p, h) => { httpHandler = h; },
      apiRoute: undefined,
      agentMode: { getState: () => ({ enabled: mandateOn }), isForbidden: () => false },
      invoke: async (type, payload) => {
        if (type === "inbox.list") return { replies: [{ type: "inbox.list", items: inbox.list(payload.filter), unreadCount: 0 }], error: null };
        if (type === "inbox.mark") { inbox.mark(payload.ids, payload.status); return { replies: [], error: null }; }
        const msgs = await ctx.run("agent", type, payload);
        const err = msgs.find((m) => m.type === "error");
        return { replies: msgs, error: err ? err.error : null };
      },
    };
    registerApi(apiCtx);
    const post = (path) => new Promise((resolve) => {
      const req = { method: "POST", headers: { host: "127.0.0.1:7070", "x-agent-name": "agent-test" }, on(ev, cb) { if (ev === "end") setImmediate(cb); } };
      const res = { writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }); } };
      httpHandler(req, res, new URL(`http://127.0.0.1:7070/api/v1${path}`));
    });
    const tag = mandateOn ? "mandat actif" : "sans mandat";

    for (const [label, item] of [["démarrage", confirm2], ["fusion", mergeItem]]) {
      const r = await post(`/inbox/${item.id}/approve`);
      expect(r.status === 403 && r.body.error?.code === "owner_only", `API agent : approuver la ${label} -> 403 owner_only (${tag})`, JSON.stringify(r));
      expect(item.status === "nouveau" && item.action.decision === undefined, `la demande de ${label} reste en attente, sans décision (${tag})`);
    }
    expect(ctx.__test.startedAgents.length === agentsBefore, `aucun agent lancé par l'API (${tag})`);
    expect(git(BLAST, "rev-parse", "HEAD") === preHead && !existsSync(join(BLAST, "a.txt")), `rien fusionné par l'API (${tag})`);

    // WebSocket : un appel interne (ctx.invoke) n'a pas le droit de décider.
    for (const [label, item] of [["démarrage", confirm2], ["fusion", mergeItem]]) {
      const msgs = await ctx.run("agent", "blastwin.decide", { id: item.id, approve: true });
      expect(hasError(msgs) && item.status === "nouveau", `blastwin.decide depuis ctx.invoke (agent) : refusé pour la ${label} (${tag})`);
    }
    const viaTask = await ctx.run("agent", "task.merge", { id: t.id });
    expect(viaTask.some((m) => m.ok === false) && git(BLAST, "rev-parse", "HEAD") === preHead, `task.merge par l'agent sans approbation : refusé (${tag})`);

    // Refuser reste possible par l'API (c'est le côté sûr) et verrouille la demande.
    const refus = await post(`/inbox/${confirm2.id}/refuse`);
    expect(refus.status === 200 && confirm2.status === "traité" && confirm2.action.decision === "deny", `API agent : refuser est permis et enregistré (${tag})`, JSON.stringify(refus));
    await ctx.run("agent", "task.start", { id: id2 });
    expect(ctx.__test.startedAgents.length === agentsBefore, `après refus, la tâche ne démarre pas (${tag})`);

    // Seule l'interface de Philippe peut autoriser.
    const ok = await ctx.run("human", "blastwin.decide", { id: mergeItem.id, approve: true });
    expect(ok.find((m) => m.type === "task.merged")?.ok === true && existsSync(join(BLAST, "a.txt")), `Philippe (interface) autorise : la fusion a lieu (${tag})`);
    git(BLAST, "worktree", "remove", "--force", t.wt);
  }
}

// ============================================================================
// G6 — journal d'activité
// ============================================================================
section("G6 — journal d'activité (agentActivity.record)");
{
  freshBlast();
  const ctx = bootTasks(newData());
  const t = await startBlastTask(ctx, "journal");
  commitFile(t.wt, "a.txt", "a\n", "agent");
  setVerify(ctx.dataDir, BLAST, ["node check.mjs"]);
  await ctx.run("human", "task.move", { id: t.id, status: "done" });
  await ctx.run("human", "blastwin.decide", { id: pending(ctx, "blastwin-merge").id, approve: true });
  const sums = ctx.__test.activity.map((a) => a.summary).join(" | ");
  for (const [re, label] of [[/Demande de confirmation BlastWin/, "demande de confirmation"], [/confirmation|démarrage autorisé/i, "décision de Philippe"], [/Sauvegarde BlastWin/, "sauvegarde"],
    [/Vérification BlastWin .*verte/, "vérification"], [/Demande de fusion BlastWin/, "demande de fusion"], [/Fusion BlastWin effectuée/, "fusion"]]) {
    expect(re.test(sums), `journal : ${label}`, sums);
  }
  git(BLAST, "worktree", "remove", "--force", t.wt);
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fails === 0 ? "TOUT EST OK" : fails + " ÉCHEC(S)"}`);
process.exit(fails ? 1 : 0);
