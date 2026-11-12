// dashboard/scripts/verify-autonomy.mjs — phase 3 : modes par projet, battement de cœur, moteur selon l'heure, idées, récap, réveil du cerveau.
// Hors ligne : faux ctx, lanceur du cerveau remplacé par un script jetable, Telegram redirigé vers un fichier. Aucun LLM.
import { execFileSync, execFile } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, mkdirSync, existsSync, statSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const tmp = mkdtempSync(join(tmpdir(), "autonomy-"));
const home = join(tmp, "home"); mkdirSync(join(home, "Projets", "BlastWin"), { recursive: true }); mkdirSync(join(home, "Projets", "Demo"), { recursive: true });
process.env.GUARD_HOME = home; process.env.POSTE_STOP_FILE = join(tmp, "STOP"); process.env.NOTIFY_DRY_FILE = join(tmp, "notif.jsonl");
const marker = join(tmp, "runner-called");
writeFileSync(join(tmp, "runner.sh"), `#!/bin/bash\necho "$1 $2 POSTE_AUTONOMOUS=$POSTE_AUTONOMOUS" >> ${marker}\ncat >> ${marker}.prompt\nexit 0\n`); chmodSync(join(tmp, "runner.sh"), 0o755);
process.env.POSTE_BRAIN_RUNNER = join(tmp, "runner.sh"); process.env.POSTE_BRAIN_SYSTEMD = "0"; process.env.POSTE_BRAIN_POLL_MS = "200";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");
const A = await import("../lib/autonomy.mjs");
const { createStore } = await import("../lib/store.mjs");
const { register } = await import("../handlers/autonomy.mjs");
let fails = 0;
const ok = (name, cond, extra = "") => { if (!cond) fails++; console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " " + extra}`); };

// --- fonctions pures
const paris = (iso) => new Date(iso); // 2026-10-24 : Paris = UTC+2
ok("nuit à 03h Paris", A.isNight(paris("2026-10-24T01:00:00Z")));
ok("jour à 14h Paris", !A.isNight(paris("2026-10-24T12:00:00Z")));
ok("07h59 Paris = encore nuit", A.isNight(paris("2026-10-24T05:59:00Z")));
ok("08h00 Paris = jour", !A.isNight(paris("2026-10-24T06:00:00Z")));
ok("nuit → Claude", A.chooseEngine(paris("2026-10-24T01:00:00Z")).engine === "claude");
ok("jour → gratuit", A.chooseEngine(paris("2026-10-24T12:00:00Z")).engine === "free");
ok("jour, usage Claude bas → Claude", A.chooseEngine(paris("2026-10-24T12:00:00Z"), { usageRatio: 0.2 }).engine === "claude");
ok("jour, usage Claude haut → gratuit", A.chooseEngine(paris("2026-10-24T12:00:00Z"), { usageRatio: 0.8 }).engine === "free");
ok("nuit mais quota Claude épuisé → gratuit", A.chooseEngine(paris("2026-10-24T01:00:00Z"), { claudeOk: false }).engine === "free");
ok("mode inconnu → off", A.normalizeProject({ mode: "pirate" }).mode === "off");
ok("battement borné (min 10)", A.normalizeProject({ heartbeatMin: 1 }).heartbeatMin === 10);
ok("Arrêt jamais dû", !A.isDue({ mode: "off", lastBeat: 0 }, Date.now()));
ok("Autonome dû après 60 min", A.isDue({ mode: "auto", lastBeat: Date.now() - 61 * 60_000 }, Date.now()));
ok("Autonome pas dû avant 60 min", !A.isDue({ mode: "auto", lastBeat: Date.now() - 30 * 60_000 }, Date.now()));
const recap = A.recapText({ tasks: [{ title: "T1", status: "done", updatedAt: Date.now() }, { title: "T2", status: "blocked" }], ideas: [{ status: "pending", title: "I1", project: "/x/Demo" }], projects: { "/x/Demo": { mode: "auto" } }, guardRefusals: 2, since: Date.now() - 864e5 });
ok("récap : fait, bloqué, idée, garde-fous", /T1/.test(recap) && /T2/.test(recap) && /Demo — I1/.test(recap) && /2 action/.test(recap) && /Demo \(autonome\)/.test(recap), recap);
ok("consigne mode Idées : n'écrit pas", /ATTENDS/.test(A.brainPrompt({ mode: "ideas", dir: "/x/Demo" })));
ok("consigne inclut les idées validées", /\[i1\] Faire X/.test(A.brainPrompt({ mode: "ideas", dir: "/x/Demo", ideas: [{ id: "i1", title: "Faire X", status: "approved" }] })));

// --- usage de Claude (estimation propre + erreurs de quota)
const t0 = Date.parse("2026-10-24T12:00:00Z");
const runsC = [{ engine: "claude", at: t0 - 10 * 60_000, endedAt: t0 - 5 * 60_000 }, { engine: "free", at: t0 - 60_000, endedAt: t0 }, { engine: "claude", at: t0 - 6 * 3600_000, endedAt: t0 - 5.9 * 3600_000 }];
ok("minutes de Claude dans la fenêtre de 5 h (hors gratuit, hors vieux runs)", A.claudeMinutes(runsC, t0) === 5, String(A.claudeMinutes(runsC, t0)));
ok("run en cours compté jusqu'à maintenant", A.claudeMinutes([{ engine: "claude", at: t0 - 12 * 60_000 }], t0) === 12);
ok("usage du daemon prioritaire sur l'estimation", A.claudeUsageRatio({ daemonPct: 90, runs: [], now: t0 }) === 0.9);
ok("sans daemon : estimation du cerveau", A.claudeUsageRatio({ runs: [{ engine: "claude", at: t0 - 15 * 60_000, endedAt: t0 }], now: t0 }) === 0.5);
ok("jour, budget cerveau entamé (80 %) → gratuit", A.chooseEngine(paris("2026-10-24T12:00:00Z"), { usageRatio: 0.8 }).engine === "free");
ok("jour, budget cerveau intact → Claude", A.chooseEngine(paris("2026-10-24T12:00:00Z"), { usageRatio: 0 }).engine === "claude");
ok("erreur de quota reconnue", A.quotaErrorIn("Claude AI usage limit reached|1761300000") && A.quotaErrorIn("API Error: 429 rate limit") && !A.quotaErrorIn("tout s'est bien passé"));

// --- A3 : la consigne donne ce qui attend, dans l'ordre « finir d'abord »
{
  const now = Date.now();
  const tasks = [{ id: "07faa595-aaaa", title: "Tests d'UI", status: "review", branch: "agent/Demo/tests-ui", updatedAt: new Date(now - 30 * 3600_000).toISOString() }, { id: "b267261a-bbbb", title: "Doublon", status: "doing", updatedAt: new Date(now).toISOString() }, { id: "zz", title: "Fini", status: "done" }];
  const prs = [{ number: 3, title: "Tests d'UI", headRefName: "agent/Demo/tests-ui", updatedAt: new Date(now - 3600_000).toISOString() }, { number: 9, title: "Autre", headRefName: "dependabot/x" }];
  const pr = A.brainPrompt({ mode: "ideas", dir: "/x/Demo", tasks, prs, ideas: [{ id: "i1", title: "Tests d'UI", status: "approved", taskId: "07faa595-aaaa" }], now });
  ok("consigne : tâche À VALIDER listée (titre, branche, ancienneté, idée liée)", /\[07faa595\] À VALIDER : Tests d'UI — branche agent\/Demo\/tests-ui — depuis 30 h — idée validée \[i1\]/.test(pr), pr);
  ok("consigne : tâche EN COURS marquée « n'y touche pas », tâche terminée absente", /\[b267261a\] EN COURS.*n'y touche pas/.test(pr) && !/Fini/.test(pr));
  ok("consigne : PR agent/* listée, pas les autres", /PR #3 « Tests d'UI » \(agent\/Demo\/tests-ui\)/.test(pr) && !/dependabot/.test(pr));
  ok("consigne : ordre finir (1) → réaliser (2) → proposer (3)", pr.indexOf("1) FINIR") > 0 && pr.indexOf("1) FINIR") < pr.indexOf("2) RÉALISER") && pr.indexOf("2) RÉALISER") < pr.indexOf("3) SEULEMENT"));
  ok("mode Idées : fusion permise seulement pour une idée validée", /FUSIONNER seulement ce qui réalise une idée VALIDÉE/.test(pr));
  ok("mode Autonome : fusion de ce qui attend", /fusionne \(`gh pr merge/.test(A.brainPrompt({ mode: "auto", dir: "/x/Demo", tasks, now })));
  ok("consigne sans rien en attente : le dit", /Rien n'attend/.test(A.brainPrompt({ mode: "auto", dir: "/x/Demo" })));
  // A5 : worktrees
  const wt = A.brainPrompt({ mode: "auto", dir: "/x/Demo", now, worktrees: [{ path: "/x/Demo-wt-a", branch: "agent/Demo/a", merged: true, dirtyFiles: 0, lastCommitMs: now - 5 * 3600_000, locked: true }, { path: "/x/Demo-wt-b", branch: "agent/Demo/b", merged: false, dirtyFiles: 2, lastCommitMs: now - 50 * 3600_000 }] });
  ok("consigne : worktrees (fusionné, verrouillé, fichiers non commités) + règles d'hygiène", /wt-a \[agent\/Demo\/a\] : branche DÉJÀ FUSIONNÉE, propre, dernier commit il y a 5 h, VERROUILLÉ/.test(wt) && /wt-b.*2 fichier\(s\) non commités.*2 j/.test(wt) && /commit « wip »/.test(wt) && /git worktree unlock/.test(wt), wt);
}
// --- A4 : doublons d'idées
ok("titres proches (≥ 70 %) = doublon, même avec accents et pluriels", A.titleOverlap("Ajouter des tests d'UI", "Tests d'UI ajoutés pour le tableau") >= 0.7);
ok("titres différents = pas doublon", A.titleOverlap("Faire le README", "Corriger la CI rouge") < 0.7);
ok("doublon cherché parmi attente/validée du même projet seulement", A.findDuplicateIdea([{ project: "/a", title: "Ajouter tests", status: "refused" }, { project: "/b", title: "Ajouter tests", status: "pending" }, { project: "/a", title: "Ajouter tests UI", status: "approved", id: "ok" }], "/a", "Tests ajoutés UI")?.id === "ok");
ok("récap : idée en attente depuis > 3 jours signalée « à trancher »", /À trancher : 1 idée/.test(A.recapText({ ideas: [{ status: "pending", title: "Vieille", project: "/x/D", createdAt: Date.now() - 4 * 864e5 }, { status: "pending", title: "Neuve", project: "/x/D", createdAt: Date.now() }] })));

// --- compte rendu Fait / Bloqué / Prochaine étape (A6)
const rep = A.parseReport("blabla\n**Fait :** PR #3 fusionnée\n- Bloqué : rien\nProchaine étape : relire");
ok("compte rendu : Fait lu (même en gras), Bloqué « rien » vidé, suite lue", rep.fait === "PR #3 fusionnée" && rep.bloque === "" && rep.suite === "relire", JSON.stringify(rep));
ok("compte rendu : Bloqué lu", A.parseReport("Fait : rien\nBloqué : postectl absent\n").bloque === "postectl absent");
ok("compte rendu : le dernier du journal l'emporte", A.parseReport("Fait : a\nFait : b").fait === "b");
{ const { isRealInstance } = await import("../lib/realinstance.mjs");
  ok("Telegram réel : seulement le poste ~/paseo-dash-data", isRealInstance({ DASHBOARD_DATA_DIR: "/home/u/paseo-dash-data" }, "/home/u") && !isRealInstance({ DASHBOARD_DATA_DIR: "/tmp/x" }, "/home/u") && !isRealInstance({}, "/home/u") && isRealInstance({ TELEGRAM_REAL_SEND: "1" }, "/home/u")); }
{ const { telegramText } = await import("../handlers/missionreport.mjs");
  const t = telegramText({ outcome: "review", project: "Demo", mission: "Ajouter les tests", next: "Valider la tâche « À valider ».", tasks: [{ status: "done" }, { status: "review" }, { status: "todo" }], files: { changed: ["a", "b"] } });
  ok("fin de mission Jarvis sur Telegram : fait + reste à faire", /^🔎 Demo/.test(t) && /1 terminée\(s\), 1 à valider, 1 encore ouverte/.test(t) && /2 fichier/.test(t) && /➡️ Reste : Valider/.test(t), t); }
ok("message ⛔ si bloqué (prioritaire sur Fait)", A.reportMessage("Demo", { fait: "x", bloque: "CI rouge" }) === "⛔ Demo : CI rouge");
ok("message ✅ si fait", A.reportMessage("Demo", { fait: "tests ajoutés", bloque: "" }) === "✅ Demo : tests ajoutés");
ok("message ✅ avec ce qui reste à faire", A.reportMessage("Demo", { fait: "tests ajoutés", bloque: "", suite: "brancher la CI" }) === "✅ Demo : tests ajoutés\n➡️ Reste : brancher la CI");
ok("aucun message si rien d'utile / rien", A.reportMessage("Demo", { fait: "Rien d'utile aujourd'hui", bloque: "" }) === null && A.reportMessage("Demo", parseEmpty()) === null);
function parseEmpty() { return A.parseReport("Fait : rien\nBloqué : rien"); }
// --- réconciliation d'un run « en cours » au démarrage (A2)
ok("réconciliation : fichier .exit → clôture avec son code", JSON.stringify(A.reconcileRun({ unitActive: false, exit: 0 })) === '{"action":"close","code":0}');
ok("réconciliation : unité active → on suit", A.reconcileRun({ unitActive: true, exit: null }).action === "follow");
ok("réconciliation : ni unité ni .exit → interrompu", A.reconcileRun({ unitActive: false, exit: null }).action === "interrupted");
ok("code 0 → done, code 3 → outil manquant, autre → erreur", A.runStatusFromCode(0) === "done" && /postectl/.test(A.runStatusFromCode(3)) && A.runStatusFromCode(1) === "erreur (code 1)");

// --- consignes : chaque commande postectl citée existe dans `postectl --help` (A7)
{
  const help = execFileSync("node", [join(ROOT, "tools", "postectl.mjs"), "--help"], { encoding: "utf8" }).split("\n");
  const block = (w1, w2) => { const i = help.findIndex((l) => { const t = l.trim().split(/\s+/); return l.startsWith("  ") && !l.startsWith("   ") && t[0] === w1 && (!w2 || t[1]?.split("|").includes(w2)); }); if (i < 0) return null; const out = [help[i]]; for (let j = i + 1; j < help.length && /^ {10,}/.test(help[j]); j++) out.push(help[j]); return out.join("\n"); };
  const hasSubs = (w1) => help.some((l) => new RegExp(`^  ${w1} [a-z]`).test(l));
  const cited = (text) => [...String(text).matchAll(/postectl([^`\n]*)/g)].map((m) => m[1].trim().split(/\s+/).filter(Boolean)).filter((t) => t.length);
  const badIn = (text) => {
    const bad = []; let n = 0;
    for (const [w1, w2c, ...rest] of cited(text)) {
      n++;
      const w2 = hasSubs(w1) && /^[a-z][a-z-]*$/.test(w2c || "") ? w2c : null;
      const b = block(w1, w2);
      if (!b) { bad.push(`${w1} ${w2 || ""}`); continue; }
      for (const f of [w2c, ...rest].filter((x) => /^--[a-z-]+/.test(x || ""))) if (!["--json", "--url", "--help"].includes(f) && !b.includes(f)) bad.push(`${w1} ${w2 || ""} ${f}`);
    }
    return { bad, n };
  };
  const texts = [readFileSync(join(ROOT, "deploy", "oracle", "cerveau", "CONSIGNE.md"), "utf8"),
    ...["ideas", "auto"].map((mode) => A.brainPrompt({ mode, dir: "/x/Demo", ideas: [{ id: "i1", title: "T", status: "approved" }] })), A.brainPrompt({ kind: "ci-fix", mode: "auto", dir: "/x/Demo", ci: { id: 1 } })];
  const res = badIn(texts.join("\n"));
  ok(`consignes : ${res.n} commandes postectl citées, toutes dans « postectl --help »`, res.n >= 8 && res.bad.length === 0, res.bad.join(" | "));
  // témoins négatifs : le contrôle sait échouer (ancienne consigne fausse, commande inventée)
  ok("contrôle : « idea add --done » (ancienne consigne) est détecté", badIn("(postectl idea add --done)").bad.length === 1);
  ok("contrôle : une commande inventée est détectée", badIn("`postectl teleport mars`").bad.length === 1);
  ok("consigne Autonome : plus de « idea add --done »", !/idea add --done/.test(texts.join("\n")));
  // témoin négatif : le contrôle sait échouer
  ok("contrôle : une commande inventée est détectée", !block("idea", "add") || !block("idea", "add").includes("--done"));
}
// --- postectl installable pour tous les agents (A1)
{
  const wrapper = join(ROOT, "deploy", "oracle", "bin", "postectl");
  ok("deploy/oracle/bin/postectl existe et est exécutable", existsSync(wrapper) && (statSync(wrapper).mode & 0o111) !== 0);
  const ln = join(tmp, "link-postectl"); symlinkSync(wrapper, ln);
  ok("postectl via lien symbolique : --help fonctionne", /pilote le poste/.test(execFileSync(ln, ["--help"], { encoding: "utf8" })));
  ok("install.sh crée le lien ~/.local/bin/postectl", /ln -sfn "\$HERE\/bin\/postectl" "\$HOME\/.local\/bin\/postectl"/.test(readFileSync(join(ROOT, "deploy", "oracle", "install.sh"), "utf8")));
  // run.sh sans postectl dans le PATH : code 3, « Bloqué : outil manquant », fichier .exit
  const sbx = join(tmp, "sbx"); mkdirSync(join(sbx, "d"), { recursive: true }); mkdirSync(join(sbx, "home"));
  const fakeRoot = join(sbx, "r"); mkdirSync(join(fakeRoot, "cerveau"), { recursive: true });
  for (const f of ["run.sh", "CONSIGNE.md"]) writeFileSync(join(fakeRoot, "cerveau", f), readFileSync(join(ROOT, "deploy", "oracle", "cerveau", f))); // pas de ../bin → postectl introuvable
  let code = 0; try { execFileSync("bash", [join(fakeRoot, "cerveau", "run.sh"), join(sbx, "d"), "free"], { input: "x", env: { PATH: "/usr/bin:/bin", HOME: join(sbx, "home"), DASHBOARD_DATA_DIR: join(sbx, "data"), POSTE_RUN_ID: "t1" }, stdio: ["pipe", "pipe", "pipe"] }); } catch (e) { code = e.status; }
  const logs = join(sbx, "data", "brain-logs"); const logf = readdirSync(logs).find((f) => f.endsWith(".log"));
  ok("run.sh sans postectl : code 3 + « Bloqué : outil manquant » + .exit", code === 3 && /Bloqué : outil manquant : postectl/.test(readFileSync(join(logs, logf), "utf8")) && readFileSync(join(logs, "t1.exit"), "utf8").trim() === "3");
}

// --- handler avec faux ctx
const handlers = new Map(), routes = new Map(), sent = [], bcast = [];
const ctx = {
  onMessage: (t, fn) => handlers.set(t, fn), send: (_ws, m) => sent.push(m), sendError: (_ws, e) => sent.push({ type: "error", error: e }), broadcast: (m) => bcast.push(m),
  store: createStore(tmp), dataDir: tmp, log() {}, safeError: (e) => e.message,
  invoke: async () => ({ replies: [{ type: "tasks", tasks: [{ title: "Fini", status: "done", updatedAt: Date.now() }] }] }),
  apiRoute: (m, p, h) => routes.set(`${m} ${p}`, h),
};
register(ctx);
const call = async (t, m = {}) => { sent.length = 0; await handlers.get(t)({}, m); return sent.slice(); };
const D = join(home, "Projets", "Demo"), B = join(home, "Projets", "BlastWin");
let r = await call("autonomy.set", { dir: B, mode: "auto" });
ok("BlastWin ne peut pas passer en Autonome", r[0]?.type === "error", JSON.stringify(r));
r = await call("autonomy.set", { dir: D, mode: "pirate" });
ok("mode invalide refusé", r[0]?.type === "error");
await call("autonomy.set", { dir: D, mode: "ideas", heartbeatMin: 30 });
r = await call("autonomy.list");
ok("mode enregistré (ideas, 30 min)", r[0].projects[D]?.mode === "ideas" && r[0].projects[D].heartbeatMin === 30, JSON.stringify(r[0]));
// idées : proposer via l'API agent, valider seulement via le navigateur
const post = routes.get("POST /ideas");
const created = (await post({ body: { project: D, title: "Ajouter des tests", body: "plan" } })).idea;
ok("idée créée en attente + Telegram prévenu", created.status === "pending" && /Ajouter des tests/.test(readFileSync(process.env.NOTIFY_DRY_FILE, "utf8")));
let refused = false; try { await post({ body: { project: B, title: "x" } }); } catch { refused = true; }
ok("idée sur BlastWin refusée", refused);
let notYet = null; try { await routes.get("POST /ideas/:id/done")({ params: { id: created.id } }); } catch (e) { notYet = e.status; }
ok("le cerveau ne peut pas marquer faite une idée non validée (403)", notYet === 403, String(notYet));
ok("la seule route de validation de l'API est celle protégée par secret", [...routes.keys()].filter((k) => /decide|approve/.test(k)).join() === "POST /ideas/:id/decide");
// validation par l'API locale (Telegram) : secret obligatoire
const decideRoute = routes.get("POST /ideas/:id/decide");
let denied = null; try { await decideRoute({ params: { id: created.id }, body: { decision: "approve" }, req: { headers: {} } }); } catch (e) { denied = e.status; }
ok("décision par l'API sans secret : 403", denied === 403, String(denied));
try { await decideRoute({ params: { id: created.id }, body: { decision: "approve" }, req: { headers: { "x-decide-secret": "faux" } } }); denied = null; } catch (e) { denied = e.status; }
ok("décision par l'API avec mauvais secret : 403", denied === 403, String(denied));
const secret = readFileSync(join(tmp, "decide-secret.txt"), "utf8").trim();
const viaTelegram = await decideRoute({ params: { id: created.id }, body: { decision: "approve", comment: "ok" }, req: { headers: { "x-decide-secret": secret } } });
ok("décision par l'API avec le bon secret", viaTelegram.idea.status === "approved");
ok("notification d'idée avec boutons Valider/Refuser/Arrêt", /pi:[0-9a-f]+:a/.test(readFileSync(process.env.NOTIFY_DRY_FILE, "utf8")) && /ps:x/.test(readFileSync(process.env.NOTIFY_DRY_FILE, "utf8")));
const list = (await call("idea.list"))[0].ideas;
ok("idée validée par le navigateur", list[0].status === "approved" && list[0].comment === "ok");
r = await call("idea.decide", { id: created.id, decision: "refuse" });
ok("idée déjà traitée : pas de 2e décision", r[0]?.type === "error");
const done = await routes.get("POST /ideas/:id/done")({ params: { id: created.id } });
ok("idée validée → faite par le cerveau", done.idea.status === "done");
// réveil du cerveau : lanceur factice appelé avec POSTE_AUTONOMOUS=1
await sleep(1200); // le décideur programme un réveil après validation (≤ 1 s)
await sleep(400);
const called = existsSync(marker) ? readFileSync(marker, "utf8") : "";
ok("réveil du cerveau lancé (après validation), POSTE_AUTONOMOUS=1", /POSTE_AUTONOMOUS=1/.test(called) && called.includes(D), called);
ok("consigne transmise sur stdin", /Mode d'autonomie/.test(existsSync(marker + ".prompt") ? readFileSync(marker + ".prompt", "utf8") : ""));
await sleep(300);
// quota Claude : un run Claude qui échoue sur « usage limit » bloque Claude, le réveil suivant passe sur les modèles gratuits
writeFileSync(join(tmp, "runner.sh"), `#!/bin/bash\nmkdir -p ${tmp}/brain-logs\necho "Claude AI usage limit reached|1761300000" > ${tmp}/brain-logs/x-$POSTE_RUN_ID.log\ncat > /dev/null\nexit 1\n`);
await call("brain.wake", { dir: D }); await sleep(1500);
const afterFail = (await call("autonomy.list"))[0];
const failedRun = afterFail.runs.at(-1);
ok("run Claude échoué sur limite d'usage détecté", failedRun.engine === "claude" && failedRun.quotaHit === true, JSON.stringify(failedRun));
await call("brain.wake", { dir: D }); await sleep(1500);
const next = (await call("autonomy.list"))[0].runs.at(-1);
ok("réveil suivant : repli automatique sur les modèles gratuits", next.engine === "free", JSON.stringify(next));
ok("Telegram prévenu du quota atteint", /Quota Claude atteint/.test(readFileSync(process.env.NOTIFY_DRY_FILE, "utf8")));
r = await call("brain.wake", { dir: B });
ok("réveil sur BlastWin refusé", r[0]?.type === "error");
writeFileSync(process.env.POSTE_STOP_FILE, "stop");
r = await call("brain.wake", { dir: D });
ok("réveil refusé pendant l'arrêt d'urgence", r[0]?.type === "error" && /urgence/.test(r[0].error), JSON.stringify(r));
rmSync(process.env.POSTE_STOP_FILE);
await call("recap.now");
ok("récap envoyé sur Telegram", /Récap/.test(readFileSync(process.env.NOTIFY_DRY_FILE, "utf8")) && /Fini/.test(readFileSync(process.env.NOTIFY_DRY_FILE, "utf8")));
// plus aucun récap automatique : un tick ne dit rien, même avec l'ancien réglage recapAuto et un jour ancien
{ const st = ctx.store.read("autonomy", {}); st.meta = { ...(st.meta || {}), lastRecapDay: "2000-01-01", recapAuto: true }; ctx.store.write("autonomy", st); }
const before = readFileSync(process.env.NOTIFY_DRY_FILE, "utf8").split("\n").filter((l) => /Récap/.test(l)).length;
ok("buildRecap ne publie rien sur Telegram", /Fini/.test(await ctx.autonomy.buildRecap()) && readFileSync(process.env.NOTIFY_DRY_FILE, "utf8").split("\n").filter((l) => /Récap/.test(l)).length === before);
// --- A4 : idées sans doublon, obsolete, lien idée → tâche (API)
{
  const before = (await call("idea.list"))[0].ideas.length;
  const n0 = readFileSync(process.env.NOTIFY_DRY_FILE, "utf8").split("\n").length;
  const orig = (await post({ body: { project: D, title: "Documenter le déploiement Oracle" } })).idea;
  const dup = await post({ body: { project: D, title: "Déploiement Oracle documenté" } });
  const n1 = readFileSync(process.env.NOTIFY_DRY_FILE, "utf8").split("\n").length;
  ok("doublon : l'idée existante est renvoyée, rien créé, Telegram pas renotifié", dup.duplicate === true && dup.idea.id === orig.id && (await call("idea.list"))[0].ideas.length === before + 1 && n1 === n0 + 1, JSON.stringify(dup));
  const obs = await routes.get("POST /ideas/:id/obsolete")({ params: { id: orig.id }, body: { why: "déjà fait dans abc123" } });
  ok("obsolete : idée en attente retirée avec sa raison", obs.idea.status === "obsolete" && obs.idea.obsoleteWhy === "déjà fait dans abc123");
  let st = null; try { await routes.get("POST /ideas/:id/obsolete")({ params: { id: orig.id }, body: { why: "x" } }); } catch (e) { st = e.status; }
  ok("obsolete : refusé sur une idée qui n'est plus en attente (403)", st === 403, String(st));
  const appr = (await call("idea.list"))[0].ideas.find((i) => i.status === "done" || i.status === "approved");
  st = null; try { await routes.get("POST /ideas/:id/obsolete")({ params: { id: appr.id }, body: { why: "x" } }); } catch (e) { st = e.status; }
  ok("obsolete : jamais sur une idée validée/faite par Philippe (403)", st === 403, String(st));
  const again = (await post({ body: { project: D, title: "Documenter le déploiement Oracle" } }));
  ok("une idée obsolète ne bloque plus un nouveau dépôt de la même idée", !again.duplicate);
  const ap = (await post({ body: { project: D, title: "Brancher la sauvegarde distante" } })).idea;
  await decideRoute({ params: { id: ap.id }, body: { decision: "approve" }, req: { headers: { "x-decide-secret": secret } } });
  const linked = await routes.get("POST /ideas/:id/task")({ params: { id: ap.id }, body: { task: "abcd1234-0000" } });
  ok("lien idée validée → tâche enregistré (GET /ideas/:id)", linked.idea.taskId === "abcd1234-0000" && (await routes.get("GET /ideas/:id")({ params: { id: ap.id } })).idea.taskId === "abcd1234-0000");
  st = null; try { await routes.get("POST /ideas/:id/task")({ params: { id: again.idea.id }, body: { task: "t" } }); } catch (e) { st = e.status; }
  ok("lien refusé pour une idée non validée (403)", st === 403, String(st));
}
// --- postectl en vrai (client HTTP) contre un faux poste : --why et --idea sont bien lus comme des options à valeur
{
  const seen = [];
  const fake = createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      seen.push(`${req.method} ${req.url} ${b}`); res.setHeader("content-type", "application/json");
      const data = req.url.startsWith("/api/v1/ideas/i9/obsolete") ? { idea: { id: "i9", obsoleteWhy: "déjà fait" } }
        : req.url === "/api/v1/ideas/i7" ? { idea: { id: "i7", status: "approved" } }
        : req.url === "/api/v1/tasks" && req.method === "POST" ? { task: { id: "t1", title: "T", status: "todo", projectName: "" } } : { ok: true };
      res.end(JSON.stringify({ ok: true, data }));
    });
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const cli = (...a) => new Promise((res) => execFile("node", [join(ROOT, "tools", "postectl.mjs"), "--url", `http://127.0.0.1:${fake.address().port}`, ...a], (e, out, err) => res({ code: e ? e.code : 0, out, err })));
  const o1 = await cli("idea", "obsolete", "i9", "--why", "déjà fait dans abc");
  ok("postectl idea obsolete envoie la raison (--why)", o1.code === 0 && seen.some((l) => l.includes('/ideas/i9/obsolete {"why":"déjà fait dans abc"}')), o1.err + seen.join("|"));
  const o2 = await cli("task", "add", "Faire T", "--idea", "i7");
  ok("postectl task add --idea : titre intact, tâche liée à l'idée", o2.code === 0 && seen.some((l) => l.includes('POST /api/v1/tasks {"title":"Faire T"}')) && seen.some((l) => l.includes('/ideas/i7/task {"task":"t1"}')), o2.err + seen.join("|"));
  fake.close();
}
// --- A3 : le réveil transmet bien tâches/PR au cerveau (prompt reçu par le lanceur)
{
  writeFileSync(join(tmp, "runner.sh"), `#!/bin/bash\ncat > ${marker}.prompt2\nexit 0\n`); await sleep(100);
  ctx.invoke = async () => ({ replies: [{ type: "tasks", tasks: [{ id: "0123456789", title: "Tests d'UI en attente", status: "review", project: D, branch: "agent/Demo/ui", updatedAt: new Date().toISOString() }, { id: "other", title: "Autre projet", status: "review", project: "/ailleurs" }] }] });
  await call("brain.wake", { dir: D }); await sleep(1500);
  const got = existsSync(marker + ".prompt2") ? readFileSync(marker + ".prompt2", "utf8") : "";
  ok("réveil : consigne avec la tâche À valider du projet (pas celle d'un autre projet)", /Tests d'UI en attente/.test(got) && !/Autre projet/.test(got), got.slice(0, 300));
}

// --- A6 : un réveil qui finit par « Bloqué : … » / « Fait : … » prévient Telegram et garde le compte rendu
const notif = () => readFileSync(process.env.NOTIFY_DRY_FILE, "utf8");
const runnerWith = (lines, code = 0) => writeFileSync(join(tmp, "runner.sh"), `#!/bin/bash\nmkdir -p ${tmp}/brain-logs\ncat > /dev/null\nprintf '%s\\n' ${lines.map((l) => `'${l}'`).join(" ")} > ${tmp}/brain-logs/x-$POSTE_RUN_ID.log\nexit ${code}\n`);
await sleep(300);
runnerWith(["travail...", "Fait : rien", "Bloqué : CI illisible", "Prochaine étape : attendre"]);
await call("brain.wake", { dir: D }); await sleep(1200);
let last = (await call("autonomy.list"))[0].runs.at(-1);
ok("réveil « Bloqué » : ⛔ envoyé, compte rendu gardé dans le run", /⛔ Demo : CI illisible/.test(notif()) && last.report?.bloque === "CI illisible" && last.report.suite === "attendre", JSON.stringify(last));
runnerWith(["Fait : tests ajoutés", "Bloqué : rien", "Prochaine étape : fusionner"]);
await call("brain.wake", { dir: D }); await sleep(1200);
ok("réveil « Fait » : ✅ envoyé", /✅ Demo : tests ajoutés/.test(notif()));
const nBefore = notif().split("\n").length;
runnerWith(["Fait : rien", "Bloqué : rien", "Prochaine étape : rien"]);
await call("brain.wake", { dir: D }); await sleep(1200);
ok("réveil « rien » : aucun message", notif().split("\n").length === nBefore);
runnerWith(["Bloqué : outil manquant : postectl"], 3);
await call("brain.wake", { dir: D }); await sleep(1200);
last = (await call("autonomy.list"))[0].runs.at(-1);
ok("code 3 : statut « outil manquant : postectl » + ⛔ (pas de ⚠️ en double)", /postectl/.test(last.status) && /⛔ Demo : outil manquant/.test(notif()) && !/échoué sur Demo : outil manquant/.test(notif()), last.status);

// --- A2 : réconciliation au démarrage du poste
{
  const logs = join(tmp, "brain-logs"); mkdirSync(logs, { recursive: true });
  const st = ctx.store.read("autonomy", {}); st.projects[D] = { ...st.projects[D], mode: "auto" };
  st.runs.push({ id: "r-exit", dir: D, kind: "heartbeat", engine: "free", at: Date.now() - 5000, status: "running", unit: "cerveau-r-exit" });
  st.runs.push({ id: "r-lost", dir: D, kind: "heartbeat", engine: "free", at: Date.now() - 5000, status: "running", unit: "cerveau-r-lost" });
  ctx.store.write("autonomy", st);
  writeFileSync(join(logs, "r-exit.exit"), "0\n"); writeFileSync(join(logs, "x-r-exit.log"), "Fait : migration finie\nBloqué : rien\n");
  runnerWith(["Fait : relance ok", "Bloqué : rien"]);
  await ctx.autonomy.reconcile(); await sleep(1500);
  const runs = (await call("autonomy.list"))[0].runs; const byId = (id) => runs.find((r) => r.id === id);
  ok("réconciliation : run avec .exit clos « done » (pas « code null ») + compte rendu", byId("r-exit").status === "done" && byId("r-exit").report?.fait === "migration finie", JSON.stringify(byId("r-exit")));
  ok("réconciliation : run perdu → « interrompu »", /^interrompu/.test(byId("r-lost").status), byId("r-lost").status);
  const retry = runs.find((r) => r.retryOf === "r-lost");
  ok("mode Autonome : UNE relance automatique du run interrompu", !!retry && runs.filter((r) => r.retryOf === "r-lost").length === 1, JSON.stringify(runs.map((r) => [r.id, r.status, r.retryOf])));
  // pas de boucle : un run relancé puis interrompu ne se relance pas encore
  const st2 = ctx.store.read("autonomy", {}); st2.runs.push({ id: "r-lost2", dir: D, kind: "heartbeat", engine: "free", at: Date.now(), status: "running", retryOf: "r-x", unit: "cerveau-r-lost2" }); ctx.store.write("autonomy", st2);
  await ctx.autonomy.reconcile(); await sleep(800);
  ok("pas de seconde relance en chaîne", !(await call("autonomy.list"))[0].runs.some((r) => r.retryOf === "r-lost2"));
}
rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} échec(s)` : "\ntout est OK");
process.exit(fails ? 1 : 0);
