// Vérifie handlers/agentsoverview.mjs (page « Agents ») et son branchement dans timeline.mjs, hors ligne (aucun daemon, aucun LLM).
// Usage : node dashboard/scripts/verify-agents-overview.mjs
// A. règles pures : dernière ligne utile d'un écran, invite en attente, état affiché (actif, en attente, bloqué, au repos).
// B. module isolé avec un faux contexte : fusion agents du daemon + terminaux d'agents (coord terms ET nom d'outil), statut déclaré,
//    réservations, tâche liée, quota, question ouverte, échantillonnage des écrans (cache : aucune lecture par diffusion), diffusion.
// C. timeline.mjs : un terminal d'agent dont l'écran bouge ouvre un épisode (agentId « term-<id> »), fermé quand il disparaît.
// D. interface : main.js redirige les anciennes ancres vers #agents ; aucune vue fusionnée n'est encore inscrite ; aucun innerHTML.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.AGENTS_SAMPLE_MS = "3600000"; // pas d'échantillonnage automatique : le test le déclenche lui-même
const here = fileURLToPath(new URL(".", import.meta.url));
const mod = await import(pathToFileURL(join(here, "..", "handlers", "agentsoverview.mjs")).href);
const { usefulLine, screenLine, promptOf, stateOf, countsOf } = mod;
let failures = 0;
const expect = (cond, label, detail = "") => {
  if (cond) console.log(`OK ${label}`);
  else { failures += 1; console.log(`FAIL ${label} ${detail}`); }
};

// ---------- A. Règles pures ----------
expect(usefulLine(["⏺ Édite hooks/useQuests.ts", "", "╭──────────╮", "│ >        │", "╰──────────╯", "  ? for shortcuts"]) === "Édite hooks/useQuests.ts",
  "dernière ligne utile : cadres, invite vide et barre d'état ignorés, puce retirée");
expect(usefulLine(["export API_TOKEN=abcdefghijklmnopqrstuvwxyz0123456789"]).includes("[masqué]"), "dernière ligne : secret masqué");
expect(usefulLine(["", "   ", "────"]) === "", "écran sans ligne utile → texte vide");
expect(usefulLine(["Lecture terminée : 3 remarques", "ubuntu@instance-1:~/Projets/paseo-poste$ "]) === "Lecture terminée : 3 remarques", "invite du shell ignorée (dernière action = vraie sortie)");
expect(usefulLine(["x".repeat(400)]).length <= 160, "dernière ligne plafonnée à 160 caractères");
expect(screenLine(["Bash(npm run build)", "", "Do you want to proceed?", "❯ 1. Yes", "  2. No"]) === "Bash(npm run build) → Do you want to proceed?", "devant une invite : « action demandée → question » (pas « 2. No »)");
expect(promptOf(["Bash(npm run build)", "Do you want to proceed?", "❯ 1. Yes", "  2. No"]) === "permission", "invite de permission Claude Code détectée");
expect(promptOf(["Quel fichier ?", "Enter to select · ↑/↓ to navigate"]) === "question", "question à choix (AskUserQuestion) détectée");
expect(promptOf(["Compilation…", "fait."]) === null, "écran ordinaire : pas d'invite");
const now = Date.parse("2026-11-18T12:00:00Z");
const min = (m) => now - m * 60000;
expect(stateOf({ kind: "terminal", lastActivityAt: min(0.5) }, now).state === "active", "terminal dont l'écran a bougé il y a 30 s → actif");
const idle5 = stateOf({ kind: "terminal", lastActivityAt: min(5) }, now);
expect(idle5.state === "waiting" && idle5.reason === "inactivite" && /5 min/.test(idle5.text), "écran figé depuis 5 min (> 2 min) → en attente (inactivité)", idle5.text);
expect(stateOf({ kind: "terminal", lastActivityAt: min(180) }, now).state === "idle", "écran figé depuis 3 h → au repos");
expect(stateOf({ kind: "terminal", lastActivityAt: min(0.2), prompt: "permission" }, now).reason === "permission", "invite de permission à l'écran → en attente (permission)");
expect(stateOf({ kind: "terminal", lastActivityAt: null }, now).state === "unknown", "écran pas encore lu → inconnu");
expect(stateOf({ kind: "terminal", offline: true, lastActivityAt: min(0) }, now).state === "unknown", "machine injoignable → inconnu");
expect(stateOf({ kind: "agent", status: "waiting-permission" }, now).state === "waiting", "agent du daemon en attente de permission → en attente");
expect(stateOf({ kind: "agent", status: "error" }, now).state === "blocked", "agent en erreur → bloqué");
expect(stateOf({ kind: "agent", status: "running", lastActivityAt: min(45) }, now).state === "blocked", "agent « en cours » muet depuis 45 min → semble bloqué");
expect(stateOf({ kind: "agent", status: "running", lastActivityAt: min(1) }, now).state === "active", "agent en cours → actif");
expect(stateOf({ kind: "agent", status: "idle", question: true }, now).reason === "question", "question ouverte à Philippe → en attente (question)");
expect(stateOf({ kind: "terminal", lastActivityAt: min(10), quotaExhausted: true, quotaDetail: "quota atteint" }, now).state === "blocked", "terminal figé + quota épuisé → bloqué");
const c = countsOf([{ state: "active" }, { state: "waiting" }, { state: "waiting" }, { state: "blocked" }]);
expect(c.active === 1 && c.waiting === 2 && c.blocked === 1 && c.total === 4, "compteurs par état");

// ---------- B. Module isolé ----------
const T1 = "11111111-aaaa-4bbb-8ccc-000000000001"; // claude (coord terms)
const T2 = "22222222-aaaa-4bbb-8ccc-000000000002"; // freebuff (coord terms) : invite de permission
const T3 = "33333333-aaaa-4bbb-8ccc-000000000003"; // pi (nom du terminal seulement)
const T4 = "44444444-aaaa-4bbb-8ccc-000000000004"; // shell ordinaire : ignoré
const screens = {
  [T1]: ["$ claude", "⏺ Édite blastwin-frontend/hooks/useQuests.ts", "╭────╮", "│ >  │", "╰────╯"],
  [T2]: ["Bash(rm -rf build)", "Do you want to proceed?", "❯ 1. Yes", "  2. No"],
  [T3]: ["pi> lance les tests", "12 tests OK"],
  [T4]: ["$ ls"],
};
let scrollbackCalls = 0;
const broadcasts = [];
const handlers = {};
const hooks = [];
const coordData = {
  terms: {
    [`oracle:term-${T1}`]: { terminalId: T1, host: "oracle", cwd: "/home/USERNAME/Projets/BlastWin", tool: "claude", label: "claude · BlastWin", at: "2026-11-18T10:00:00Z" },
    [`oracle:term-${T2}`]: { terminalId: T2, host: "oracle", cwd: "/home/USERNAME/Projets/BlastWin", tool: "freebuff", label: "FreeBuff · BlastWin", at: "2026-11-18T10:05:00Z" },
  },
  reservations: [{ session: `oracle:term-${T1}`, rel: "blastwin-frontend/hooks/useQuests.ts", expiresAt: new Date(Date.now() + 600000).toISOString() },
    { session: `oracle:term-${T1}`, rel: "expiré.ts", expiresAt: new Date(Date.now() - 1000).toISOString() }],
  messages: [{ id: "q1", from: "oracle:agent-9", to: "human", kind: "question", text: "Fusionner ?", at: new Date().toISOString() }],
};
const ctx = {
  onMessage: (type, fn) => { handlers[type] = fn; },
  send: (ws, m) => ws.out.push(m),
  broadcast: (m) => broadcasts.push(m),
  log() {}, safeError: (e) => String(e?.message || e),
  onStateChange: (fn) => hooks.push(fn),
  invoke: async (type, payload) => {
    if (type === "task.list") return { replies: [{ type: "tasks", tasks: [{ id: "T48", title: "Quêtes", status: "doing", host: "oracle", agentId: "agent-9" }] }], error: null };
    if (type === "windows.scrollback") { scrollbackCalls += 1; return { replies: [{ type: "windows.scrollback", terminalId: payload.terminalId, lines: screens[payload.terminalId] || [] }], error: null }; }
    return { replies: [], error: null };
  },
  coord: {
    _state: { data: coordData, sessions: new Map(), declared: new Map([[`oracle:term-${T1}`, { statusText: "Corrige le calcul des <b>quêtes</b>", files: [] }]]) },
    projectOf: (host, cwd) => ({ key: `${host}|${cwd.toLowerCase()}`, name: cwd.split("/").pop(), dir: cwd, host }),
  },
  quota: { snapshot: () => ({ providers: [{ id: "claude", name: "Claude", state: "ok", detail: "disponible", windows: [{ usedPct: 62 }] },
    { id: "pi/nvidia", name: "Pi · nvidia", state: "exhausted", detail: "quota atteint", windows: [] }] }) },
};
mod.register(ctx);
const state = {
  hosts: [{ label: "oracle", status: "connected" }],
  agents: [
    { host: "oracle", agentId: "agent-9", provider: "claude", model: "opus", status: "idle", cwd: "/home/USERNAME/Projets/paseo-poste", title: "Revue du lot D", updatedAt: new Date().toISOString(), pending: [] },
    { host: "oracle", agentId: "agent-closed", provider: "claude", status: "closed", cwd: "/x" },
  ],
  terminals: [
    { host: "oracle", terminalId: T1, name: "Terminal", cwd: "/home/USERNAME/Projets/BlastWin" },
    { host: "oracle", terminalId: T2, name: "Terminal", cwd: "/home/USERNAME/Projets/BlastWin" },
    { host: "oracle", terminalId: T3, name: "pi · paseo-poste", cwd: "/home/USERNAME/Projets/paseo-poste" },
    { host: "oracle", terminalId: T4, name: "bash", cwd: "/home/USERNAME" },
  ],
};
for (const h of hooks) h(state);
await new Promise((r) => setTimeout(r, 50));
expect(scrollbackCalls === 0, "aucune lecture d'écran pendant une diffusion d'état (échantillonnage seulement)");
await ctx.agentsOverview.sampleNow();
const calls1 = scrollbackCalls; // (suite)
expect(calls1 === 3, "échantillonnage : seuls les 3 terminaux d'agents sont lus (pas le shell ordinaire)", String(calls1));
for (const h of hooks) h(state);
for (const h of hooks) h(state);
await new Promise((r) => setTimeout(r, 50));
expect(scrollbackCalls === calls1, "écrans en cache : aucune relecture entre deux échantillons");
const ws = { out: [] };
await handlers["agents.overview"](ws, {});
const reply = ws.out.at(-1);
expect(reply?.type === "agents.overview" && Array.isArray(reply.agents), "agents.overview répond la liste");
const by = (pred) => reply.agents.find(pred);
const a1 = by((a) => a.terminalId === T1);
const a2 = by((a) => a.terminalId === T2);
const a3 = by((a) => a.terminalId === T3);
const ag = by((a) => a.agentId === "agent-9");
expect(reply.agents.length === 4 && !by((a) => a.terminalId === T4) && !by((a) => a.agentId === "agent-closed"), "4 agents : 3 terminaux d'agents + 1 agent du daemon (shell et agent fermé exclus)", String(reply.agents.length));
expect(a1 && a1.tool === "claude" && a1.toolName === "Claude Code" && a1.project.name === "BlastWin" && a1.host === "oracle" && a1.registered === true, "terminal claude : outil, projet, machine, connu de la coordination");
expect(a1.lastAction === "Corrige le calcul des <b>quêtes</b>" && a1.lastActionSource === "statut", "statut déclaré prioritaire sur l'écran (texte brut, jamais interprété)");
expect(a1.files.length === 1 && a1.files[0] === "blastwin-frontend/hooks/useQuests.ts", "fichiers réservés (réservation expirée ignorée)");
expect(a1.quota?.provider === "claude" && a1.quota.usedPct === 62, "quota du moteur rattaché (Claude 62 %)");
expect(a1.state === "unknown" && /à confirmer/.test(a1.stateText), "terminal lu une seule fois : activité « à confirmer » (jamais « actif » par défaut après un redémarrage)", a1.stateText);
expect(a1.approx === true, "premier échantillon : durée marquée approximative (« au moins »)");
expect(a2 && a2.state === "waiting" && a2.reason === "permission", "FreeBuff avec invite « Do you want to proceed? » → en attente (permission)");
expect(a3 && a3.tool === "pi" && a3.registered === false && a3.lastAction === "12 tests OK" && a3.lastActionSource === "terminal", "terminal nommé d'après l'outil (pi) reconnu ; dernière action = dernière ligne de l'écran");
expect(ag && ag.kind === "agent" && ag.state === "waiting" && ag.reason === "question" && ag.task?.id === "T48", "agent du daemon : question ouverte → en attente ; tâche liée T48");
expect(broadcasts.some((m) => m.type === "agents.overview"), "diffusion agents.overview");
// Deuxième lecture, écran identique : « en attente, aucune activité vue depuis au moins… »
await ctx.agentsOverview.sampleNow();
await handlers["agents.overview"](ws, {});
const a3b = ws.out.at(-1).agents.find((a) => a.terminalId === T3);
expect(a3b.state === "blocked" && a3b.reason === "quota", "pi immobile + quota Pi épuisé → bloqué (quota)", a3b.stateText);
const a1s = ws.out.at(-1).agents.find((a) => a.terminalId === T1);
expect(a1s.state === "waiting" && a1s.reason === "inactivite" && /aucune activité vue depuis/.test(a1s.stateText) && a1s.approx === true, "écran immobile sur deux lectures → en attente, « aucune activité vue depuis… » (borne basse)", a1s.stateText);
// L'écran du terminal claude bouge → actif, durée exacte
screens[T1] = [...screens[T1], "⏺ Lance npm test"];
const before = broadcasts.length;
await ctx.agentsOverview.sampleNow();
await handlers["agents.overview"](ws, {});
const a1b = ws.out.at(-1).agents.find((a) => a.terminalId === T1);
expect(a1b.state === "active" && a1b.approx === false, "écran qui bouge → actif, durée exacte", a1b.state);
expect(broadcasts.length > before, "changement d'état → nouvelle diffusion");
const n = broadcasts.length;
for (const h of hooks) h(state);
await new Promise((r) => setTimeout(r, 50));
expect(broadcasts.length === n, "rien de changé → pas de diffusion en double");
const asAgents = ctx.agentsOverview.asAgents();
expect(asAgents.length === 3 && asAgents.find((x) => x.agentId === `term-${T1}`)?.status === "running" && asAgents.find((x) => x.agentId === `term-${T2}`)?.status === "waiting-permission",
  "asAgents() : terminaux vus comme agents (running / waiting-permission) pour la chronologie");

// ---------- C. Chronologie ----------
const tl = await import(pathToFileURL(join(here, "..", "handlers", "timeline.mjs")).href);
const { createStore } = await import(pathToFileURL(join(here, "..", "lib", "store.mjs")).href);
const tmp = mkdtempSync(join(tmpdir(), "agents-overview-verify-"));
try {
  let fake = [{ host: "oracle", agentId: `term-${T1}`, title: "claude · BlastWin", provider: "claude", cwd: "/home/USERNAME/Projets/BlastWin", status: "running" }];
  const sent = [];
  let hook = null;
  const tctx = {
    onMessage: (type, fn) => { tctx.h = fn; }, send: (_ws, m) => sent.push(m), broadcast() {}, store: createStore(tmp), log() {}, safeError: String,
    onStateChange: (fn) => { hook = fn; }, agentsOverview: { asAgents: () => fake },
  };
  tl.register(tctx);
  const st = { hosts: [{ label: "oracle", status: "connected" }], agents: [] };
  hook(st);
  tctx.h({}, {});
  let eps = sent.at(-1).episodes;
  expect(eps.length === 1 && eps[0].agentId === `term-${T1}` && eps[0].provider === "claude" && eps[0].project === "BlastWin" && !eps[0].end, "chronologie : épisode ouvert pour le terminal d'agent actif");
  fake = [];
  hook(st);
  tctx.h({}, {});
  eps = sent.at(-1).episodes;
  expect(eps[0].end && eps[0].status === "interrupted", "chronologie : épisode fermé quand le terminal disparaît");
} finally { rmSync(tmp, { recursive: true, force: true }); }

// ---------- D. Interface (lecture du code) ----------
const pub = join(here, "..", "public", "js");
const main = readFileSync(join(pub, "main.js"), "utf8");
for (const old of ["sessions", "projets", "agent", "groupes", "chronologie", "taches"]) {
  expect(new RegExp(`\\b${old}: "agents"`).test(main), `main.js : #${old} redirige vers #agents`);
}
const views = readdirSync(join(pub, "views")).filter((f) => f.endsWith(".js"));
expect(!views.some((f) => ["sessions.js", "projects.js", "agent.js", "groupes.js", "timeline.js", "tasks.js"].includes(f)) && views.includes("agents.js"),
  "sélecteur : les 6 anciennes vues retirées, vue agents.js présente");
const agentsView = readFileSync(join(pub, "views", "agents.js"), "utf8");
expect(!/innerHTML/.test(agentsView.replace(/^\s*\/\/.*$/gm, "")), "views/agents.js : aucun innerHTML (données non fiables en nœuds texte)");
for (const f of ["groupesPanel.js", "tasksPanel.js", "timelinePanel.js", "orchestratorPanel.js"]) {
  const src = readFileSync(join(pub, "components", f), "utf8");
  expect(/export default view/.test(src) && !/registerView\(/.test(src), `components/${f} : réutilisé comme panneau, plus inscrit comme vue`);
}

console.log(failures ? `ÉCHECS : ${failures}` : "TOUT OK");
process.exit(failures ? 1 : 0);
