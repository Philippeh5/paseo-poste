// Vérifie la pastille d'avis des tâches « À valider » (T44) : handlers/reviewbadge.mjs (+ relais handlers/decide.mjs).
// Usage : node dashboard/scripts/verify-reviewbadge.mjs
//   A. (toujours) vrais handlers decide + reviewbadge dans un harnais jetable, FAUX serveur Laya local (LAYA_URL) :
//      règles, seuils, lecture du champ `noul` (le faux Laya renvoie answer_confidence = 0,99 pour piéger une mauvaise
//      lecture), Laya indisponible ou muet, délai de 15 s, persistance (200 derniers), idempotence, forme de la requête.
//      REAL_LAYA=0 saute l'unique vrai appel Laya (démarrage paresseux de Laya, ≈ 40 s la première fois).
//   B. (VERIFY_REAL=0 pour sauter) instance isolée (VERIFY_PORT, défaut 7089) : 2 petits appels réels (« réponds exactement… »)
//      avec le moteur gratuit, faux Laya ; la tâche arrive « À valider » puis reçoit son avis. HOLD_FILE=<chemin> garde
//      l'instance vivante après les vérifications (captures d'écran) jusqu'à l'apparition de ce fichier.
//   T47 : Von est interrogé AVANT Laya (repli Von -> Laya -> règles ; seuil probablement_ok 0,7 pour Von, 0,9 pour Laya).
//      Partie A9 : faux Von (second port local) ; ailleurs VON_URL pointe un port fermé et VON_BIN un exécutable absent
//      (aucun vrai Von n'est lancé ici). Le vrai Von se teste avec dashboard/scripts/verify-decide-von.mjs (REAL_VON=1).
// Ne parle jamais au serveur :7070 et n'écrit pas dans dashboard/data/ : tout est dans .foreman/scratch/t44-badge-*.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, connect } from "node:net";
import http from "node:http";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createStore } from "../lib/store.mjs";
import { layaState, noulOf, rulesOf, verdictOf } from "../handlers/reviewbadge.mjs";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = join(dashboardDir, "..");
const scratch = join(rootDir, ".foreman", "scratch", `t44-badge-${process.pid}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

const PORT = Number(process.env.VERIFY_PORT || 7089);
if (PORT === 7070) throw new Error("VERIFY_PORT ne doit jamais être 7070 (serveur réel)");
const SANDBOX = join(rootDir, "sandbox-repo");
const ENGINE = "claude-openrouter/sonnet";

let passed = 0;
let failed = 0;
const ok = (label) => { passed += 1; console.log(`OK   ${label}`); };
const bad = (label, detail = "") => { failed += 1; console.error(`FAIL ${label}${detail ? ` -> ${detail}` : ""}`); };
const expect = (cond, label, detail = "") => (cond ? ok(label) : bad(label, String(detail)));
const section = (name) => console.log(`\n=== ${name} ===`);
// Avis définitif = pas l'avis provisoire « Laya en cours… » diffusé tout de suite (règles seules).
const isFinal = (b) => Boolean(b.hint) && !(b.reasons || []).includes("Laya en cours…");
const dump = (v) => JSON.stringify(v);

async function until(fn, label, timeout = 8000, step = 40) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(step);
  }
  bad(`Délai dépassé : ${label}`);
  return null;
}

// ---------------------------------------------------------------- faux serveur Laya
// LAYAP=<p> dans l'état -> noul = p ; LAYAP=none -> pas de champ noul ; LAYAP=hang -> pas de réponse ; sinon noul = 0,7.
// answer_confidence vaut toujours 0,99 : lire ce champ au lieu de `noul` donnerait « probablement OK » à tort.
const requests = [];
const fake = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", () => {
    const body = JSON.parse(raw);
    requests.push(body);
    const marker = /LAYAP=([\w.]+)/.exec(body.state)?.[1];
    if (marker === "hang") return;
    const entry = { answer: "true", answer_confidence: 0.99 };
    if (marker !== "none") entry.noul = marker ? Number(marker) : 0.7;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map((q) => [q, { ...entry }])) }));
  });
});
await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
const FAKE_URL = `http://127.0.0.1:${fake.address().port}/v1/systemone`;
// Faux Von : VONP=<p> -> noul = p ; VONP=none -> pas de champ noul ; VONP=hang -> muet ; VONP=500 -> HTTP 500 ; sinon 0,81.
const vonRequests = [];
const fakeVon = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", () => {
    const body = JSON.parse(raw);
    vonRequests.push(body);
    const marker = /VONP=([\w.]+)/.exec(body.state)?.[1];
    if (marker === "hang") return;
    if (marker === "500") { res.writeHead(500, { "Content-Type": "application/json" }); return res.end('{"detail":"boom"}'); }
    const entry = { answer: "true", answer_confidence: 0.99 };
    if (marker !== "none") entry.noul = marker ? Number(marker) : 0.81;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map((q) => [q, { ...entry }])) }));
  });
});
await new Promise((resolve) => fakeVon.listen(0, "127.0.0.1", resolve));
const FAKE_VON_URL = `http://127.0.0.1:${fakeVon.address().port}/v1/systemone`;
const closedPort = await new Promise((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});

// ---------------------------------------------------------------- harnais : vrais handlers, faux ctx
async function harness({ name, modules = ["decide", "reviewbadge"], stubDecide = null }) {
  const dataDir = join(scratch, name);
  mkdirSync(dataDir, { recursive: true });
  const routes = new Map();
  const broadcasts = [];
  const ctx = {
    dataDir, store: createStore(dataDir), log: () => {}, safeError: (e) => String(e?.message ?? e),
    onMessage: (type, fn) => { if (!routes.has(type)) routes.set(type, []); routes.get(type).push(fn); },
    send: (ws, m) => ws.send(JSON.stringify(m)), broadcast: (m) => broadcasts.push(m),
  };
  for (const file of modules) await (await import(`../handlers/${file}.mjs`)).register(ctx);
  if (stubDecide) ctx.decide = stubDecide;
  return {
    ctx, broadcasts, dataDir,
    get: async (payload = {}) => {
      const replies = [];
      for (const fn of routes.get("reviewhint.get")) await fn({ send: (raw) => replies.push(JSON.parse(raw)) }, payload);
      return replies[0];
    },
    stored: () => ctx.store.read("review-hints", { hints: [] }).hints,
  };
}

const task = (id, summary, title = "Ajouter la fonction sum") => ({ id, title, summary, at: `2026-10-21T10:00:00.${id.length}Z` });

try {
  process.env.LAYA_URL = FAKE_URL;
  process.env.LAYA_BIN = join(scratch, "inexistant.exe");
  process.env.VON_URL = `http://127.0.0.1:${closedPort}/v1/systemone`; // Von indisponible : repli sur Laya
  process.env.VON_BIN = join(scratch, "inexistant-von.exe");
  process.env.REVIEWBADGE_DELAY_MS = "0";

  section("A1. règles déterministes (rulesOf)");
  const cases = [
    ["Une erreur est survenue pendant le build", ["erreur"]],
    ["Le build a échoué", ["échoué"]],
    ["Échec des tests unitaires", ["échec"]],
    ["Je n'ai pas pu lire le fichier", ["n'ai pas pu"]],
    ["Je n’ai pas pu lire le fichier (apostrophe typographique)", ["n'ai pas pu"]],
    ["Impossible de se connecter", ["impossible"]],
    ["Timeout après 30 s", ["timeout"]],
    ["Le serveur a répondu 402", ["402"]],
    ["Réponse 429 du fournisseur", ["429"]],
    ["API Error: overloaded", ["API Error"]],
    ["Tâche non terminée", ["non terminé"]],
    ["Résultat partiel seulement", ["partiel"]],
    ["Rien n'a été modifié", ["rien n'a été"]],
    ["J'ai fini la première partie. Veux-tu que je continue ?", ["question sans réponse"]],
    ["Faut-il continuer ? **", ["question sans réponse"]],
    ["Le test a échoué : timeout, erreur 429", ["erreur", "échoué", "timeout", "429"]],
    ["Tout est terminé, 12 tests passent.", []],
    ["Fonction sum ajoutée dans src/sum.js, tests verts. Veux-tu que je continue ? Non, c'est tout.", []],
    ["Terminé sans erreur, aucune erreur dans les journaux, 0 erreur de lint, pas d'erreur de type.", []],
    ["Terminé : aucun timeout, sans échec, jamais d'erreur.", []],
    ["", []],
  ];
  for (const [text, want] of cases) {
    const got = rulesOf(text);
    expect(dump([...got].sort()) === dump([...want].sort()), `rulesOf « ${text.slice(0, 50)} » -> ${dump(want)}`, dump(got));
  }

  section("A2. seuils (verdictOf) et lecture de la réponse");
  const th = [
    [[], 0.49, "a_verifier"], [[], 0.5, "incertain"], [[], 0.89, "incertain"], [[], 0.9, "probablement_ok"],
    [[], 1, "probablement_ok"], [[], 0, "a_verifier"], [["erreur"], 0.99, "a_verifier"], [["erreur"], null, "a_verifier"],
    [[], null, "incertain"],
  ];
  for (const [rules, p, want] of th) expect(verdictOf(rules, p) === want, `verdictOf(${dump(rules)}, ${p}) = ${want}`, verdictOf(rules, p));
  const thVon = [
    [[], 0.19, "a_verifier"], [[], 0.49, "a_verifier"], [[], 0.5, "incertain"], [[], 0.69, "incertain"], [[], 0.7, "probablement_ok"],
    [[], 0.81, "probablement_ok"], [[], 0.9, "probablement_ok"], [["partiel"], 0.81, "a_verifier"], [["erreur"], 0.99, "a_verifier"],
  ];
  for (const [rules, p, want] of thVon) {
    expect(verdictOf(rules, p, "von") === want, `verdictOf(${dump(rules)}, ${p}, "von") = ${want}`, verdictOf(rules, p, "von"));
  }
  expect(verdictOf([], 0.81, "laya") === "incertain" && verdictOf([], 0.81) === "incertain",
    "0,81 : probablement_ok pour Von seulement (Laya garde le seuil 0,9, défaut Laya)");
  expect(noulOf({ ok: { noul: 0.31, answer_confidence: 0.99 } }) === 0.31, "noulOf lit le champ noul");
  expect(noulOf({ ok: { answer_confidence: 0.99 } }) === null, "noulOf : answer_confidence seul -> null (jamais utilisé)");
  expect(noulOf({ ok: { noul: "0.9" } }) === null && noulOf({ ok: { noul: 1.5 } }) === null && noulOf(null) === null,
    "noulOf : valeur non numérique ou hors [0, 1] -> null");
  const big = layaState("T".repeat(300), "x ".repeat(4000));
  expect(big.length === 1900 && big.startsWith(`Tâche demandée : ${"T".repeat(300)}\nCompte-rendu de l'agent : x x`),
    "état Laya : « Tâche demandée : … » + « Compte-rendu de l'agent : … », 1900 caractères au plus", String(big.length));

  section("A3. faux Laya : avis final, lecture de noul (answer_confidence = 0,99 partout)");
  const h = await harness({ name: "main" });
  const run = async (id, summary, title) => h.ctx.reviewbadge.compute(task(id, summary, title));
  let e = await run("a1", "Tâche terminée avec succès, tests verts. LAYAP=0.95");
  expect(e?.hint === "probablement_ok" && e.p === 0.95 && e.source === "rules+laya" && dump(e.reasons) === dump(["Laya 0,95"]),
    "noul 0,95 sans règle -> probablement_ok (« Laya 0,95 »)", dump(e));
  e = await run("a2", "Tâche terminée avec succès, tests verts. LAYAP=0.12");
  expect(e?.hint === "a_verifier" && e.p === 0.12, "noul 0,12 avec answer_confidence 0,99 -> a_verifier (bon champ lu)", dump(e));
  e = await run("a3", "Tâche terminée. LAYAP=0.70");
  expect(e?.hint === "incertain" && e.p === 0.7, "noul 0,70 -> incertain", dump(e));
  e = await run("a4", "Le test a échoué : timeout après 30 s. LAYAP=0.97");
  expect(e?.hint === "a_verifier" && dump(e.reasons) === dump(["mots : échoué, timeout", "Laya 0,97"]),
    "règle + noul 0,97 -> a_verifier, raisons « mots : échoué, timeout » / « Laya 0,97 »", dump(e));
  e = await run("a5", "Tâche terminée. LAYAP=0.50");
  expect(e?.hint === "incertain", "noul = 0,5 pile -> incertain (seuil strict < 0,5)", e?.hint);
  e = await run("a6", "Tâche terminée. LAYAP=0.90");
  expect(e?.hint === "probablement_ok", "noul = 0,9 pile -> probablement_ok", e?.hint);
  e = await run("a7", "Tâche terminée. LAYAP=none");
  expect(e?.hint === "incertain" && e.p === null && e.source === "rules" && dump(e.reasons) === dump(["Laya indisponible"]),
    "réponse sans champ noul (answer_confidence 0,99 seul) : ignorée, règles seules, jamais probablement_ok", dump(e));

  section("A4. requête envoyée à Laya");
  requests.length = 0;
  await run("b1", "Fonction ajoutée. LAYAP=0.8", "Titre de la tâche");
  const q = requests.at(-1);
  expect(q?.questions && Object.keys(q.questions).length === 1, "une seule question", dump(Object.keys(q?.questions || {})));
  const only = Object.values(q?.questions || {})[0];
  expect(only?.type === "noul" && only.instructions === "Le compte-rendu confirme que la tâche demandée a été réalisée en entier "
    + "et avec succès, sans erreur ni question restante", "question de type noul avec la proposition demandée", dump(only));
  expect(q?.state === "Tâche demandée : Titre de la tâche\nCompte-rendu de l'agent : Fonction ajoutée. LAYAP=0.8",
    "état = « Tâche demandée : <titre>\\nCompte-rendu de l'agent : <résumé> »", q?.state);
  requests.length = 0;
  await run("b2", `${"mot ".repeat(1200)} LAYAP=0.8`);
  expect(requests.length === 1 && requests[0].state.length <= 1900, "résumé géant : état tronqué à 1900 caractères au plus",
    String(requests[0]?.state.length));

  section("A5. diffusion, avis en cours, lecture, idempotence, persistance");
  h.broadcasts.length = 0;
  requests.length = 0;
  const started = performance.now();
  h.ctx.reviewbadge.note(task("c1", "Tout est fait. LAYAP=0.95"));
  expect(performance.now() - started < 50, "note() rend la main tout de suite (jamais bloquant)",
    `${(performance.now() - started).toFixed(1)} ms`);
  expect(h.broadcasts[0]?.type === "reviewhint.update" && (h.broadcasts[0].reasons || []).includes("Laya en cours…") && h.broadcasts[0].taskId === "c1",
    "avis provisoire (règles, « Laya en cours… ») diffusé tout de suite", dump(h.broadcasts[0]));
  expect(!(await h.get({ taskId: "c1" })).hints.length, "reviewhint.get : pas d'avis tant que le calcul est en cours");
  const update = await until(() => h.broadcasts.find((b) => b.type === "reviewhint.update" && isFinal(b)), "reviewhint.update final");
  expect(update?.taskId === "c1" && update.hint === "probablement_ok" && update.p === 0.95 &&
    dump(update.reasons) === dump(["Laya 0,95"]), "diffusion reviewhint.update {taskId, hint, p, reasons}", dump(update));
  const list = await h.get({ taskId: "c1" });
  expect(list.type === "reviewhint.list" && list.hints.length === 1 && list.hints[0].hint === "probablement_ok",
    "reviewhint.get {taskId} -> reviewhint.list", dump(list));
  h.ctx.reviewbadge.note(task("c1", "Tout est fait. LAYAP=0.95"));
  await sleep(200);
  expect(requests.length === 1, "même compte-rendu : un seul calcul (idempotent)", String(requests.length));
  const all = await h.get();
  expect(all.hints.length >= 8 && all.hints.every((x) => x.taskId && x.hint && "reasons" in x), "reviewhint.get sans filtre : tous les avis",
    String(all.hints.length));
  const keys = h.stored().map((x) => x.key);
  expect(keys.includes(task("c1", "").id + "@" + task("c1", "").at) && existsSync(join(h.dataDir, "review-hints.json")),
    "data/review-hints.json : clé = id de tâche + horodatage du compte-rendu", dump(keys.slice(-2)));
  const h2 = await harness({ name: "main" });
  const after = await h2.get({ taskId: "c1" });
  expect(after.hints.length === 1 && after.hints[0].hint === "probablement_ok", "après redémarrage : avis relu depuis le fichier",
    dump(after));
  const fresh = task("c1", "Nouveau compte-rendu. LAYAP=0.1");
  fresh.at = "2026-10-21T11:00:00.000Z";
  h.ctx.reviewbadge.note(fresh);
  await until(() => h.stored().some((x) => x.key === `c1@${fresh.at}`), "nouveau compte-rendu de la même tâche");
  const latest = (await h.get({ taskId: "c1" })).hints;
  expect(latest.length === 1 && latest[0].hint === "a_verifier", "même tâche, nouveau compte-rendu : l'avis le plus récent seul",
    dump(latest));

  section("A6. 200 derniers avis, sans Laya (aucun ctx.decide)");
  const h3 = await harness({ name: "cap", modules: ["reviewbadge"] });
  for (let i = 0; i < 205; i++) await h3.ctx.reviewbadge.compute({ id: `t${i}`, title: "x", summary: "Fini", at: `at${i}` });
  const kept = h3.stored();
  expect(kept.length === 200 && kept[0].key === "t5@at5" && kept.at(-1).key === "t204@at204", "200 derniers conservés, les plus anciens évincés",
    dump([kept.length, kept[0]?.key]));
  expect(kept.every((x) => x.source === "rules" && x.hint === "incertain"), "sans Laya : source « rules », jamais probablement_ok");
  const r2 = await h3.ctx.reviewbadge.compute({ id: "tx", title: "x", summary: "Impossible de continuer", at: "atx" });
  expect(r2.hint === "a_verifier" && r2.source === "rules" && dump(r2.reasons) === dump(["mots : impossible", "Laya indisponible"]),
    "sans Laya : une règle suffit pour « à vérifier »", dump(r2));

  section("A7. Laya injoignable (port fermé), puis muet ; avis provisoire immédiat");
  process.env.LAYA_URL = `http://127.0.0.1:${closedPort}/v1/systemone`;
  const down = await harness({ name: "down" });
  const d1 = await down.ctx.reviewbadge.compute(task("d1", "Tout est terminé."));
  const d2 = await down.ctx.reviewbadge.compute(task("d2", "Le job a échoué."));
  expect(d1?.hint === "incertain" && d1.source === "rules" && d2?.hint === "a_verifier" && d2.source === "rules",
    "Laya injoignable : avis par règles seules (source « rules »), échec silencieux", dump([d1, d2]));
  // Délai : ctx.decide factice (la variable LAYA_URL est globale) ; REVIEWBADGE_DELAY_MS absent = 15 s.
  delete process.env.REVIEWBADGE_DELAY_MS;
  const slow = await harness({ name: "delay", modules: ["reviewbadge"],
    stubDecide: { run: async (_body, opts) => {
      if (opts?.engine === "von") throw new Error("Von indisponible"); // repli sur Laya
      return { answers: { ok: { noul: 0.95, answer_confidence: 0.1 } } };
    } } });
  const t0 = Date.now();
  slow.ctx.reviewbadge.note(task("e1", "Terminé sans souci."));
  const interimAtOnce = slow.broadcasts.find((b) => b.hint); // synchrone : diffusé dans note()
  const savedBefore = existsSync(join(slow.dataDir, "review-hints.json"));
  process.env.REVIEWBADGE_DELAY_MS = "0";
  // muet : le faux Laya ne répond jamais ; le relais abandonne au bout de 10 s -> règles seules
  process.env.LAYA_URL = FAKE_URL;
  const mute = await harness({ name: "mute" });
  const m0 = performance.now();
  mute.ctx.reviewbadge.note(task("f1", "Tout est fait. LAYAP=hang"));
  expect(performance.now() - m0 < 50, "Laya muet : note() ne bloque pas");
  const muted = await until(() => mute.broadcasts.find((b) => isFinal(b)), "avis par règles quand Laya ne répond pas", 20000, 100);
  expect(muted?.source === "rules" && muted.hint === "incertain" && Date.now() - t0 < 14000,
    "Laya muet (10 s) : avis par règles seules", dump(muted));
  expect(interimAtOnce?.source === "rules" && (interimAtOnce.reasons || []).includes("Laya en cours…") && !savedBefore,
    "avis provisoire par règles diffusé tout de suite (dans note()), rien de persisté avant Laya", dump(interimAtOnce));
  const final = await until(() => slow.broadcasts.find((b) => isFinal(b)), "avis définitif après Laya", 20000, 100);
  expect(final?.hint === "probablement_ok" && final.source === "rules+laya",
    "noul 0,95 lu malgré answer_confidence 0,1 -> probablement_ok (avis définitif)", dump(final));

  section("A9. T47 : Von d'abord, repli Laya, puis règles seules ; seuil 0,7 pour Von");
  process.env.LAYA_URL = FAKE_URL;
  process.env.VON_URL = FAKE_VON_URL;
  const h9 = await harness({ name: "von" });
  const run9 = async (id, summary) => h9.ctx.reviewbadge.compute(task(id, summary));
  requests.length = 0;
  vonRequests.length = 0;
  e = await run9("v1", "Tâche terminée avec succès. VONP=0.81 LAYAP=0.1");
  expect(e?.hint === "probablement_ok" && e.p === 0.81 && e.source === "rules+von" && dump(e.reasons) === dump(["Von 0,81"]),
    "Von 0,81 (answer_confidence 0,99 ignoré) -> probablement_ok, source rules+von, raison « Von 0,81 »", dump(e));
  expect(vonRequests.length === 1 && requests.length === 0 && vonRequests[0].model === "von",
    "Von répond : Laya n'est pas interrogé ; requête au modèle « von »", dump([vonRequests.length, requests.length, vonRequests[0]?.model]));
  const vq = Object.values(vonRequests[0]?.questions || {})[0];
  expect(vq?.type === "noul" && /^Le compte-rendu confirme/.test(vq.instructions),
    "Von reçoit la question noul (même proposition que pour Laya)", dump(vq));
  e = await run9("v2", "Tâche terminée. VONP=0.69");
  expect(e?.hint === "incertain" && e.source === "rules+von", "Von 0,69 -> incertain", dump(e));
  e = await run9("v3", "Tâche terminée. VONP=0.70");
  expect(e?.hint === "probablement_ok", "Von 0,70 pile -> probablement_ok (seuil 0,7)", e?.hint);
  e = await run9("v4", "Tâche terminée. VONP=0.19");
  expect(e?.hint === "a_verifier" && e.p === 0.19, "Von 0,19 -> a_verifier", dump(e));
  e = await run9("v5", "Tâche terminée. VONP=0.50");
  expect(e?.hint === "incertain", "Von 0,50 pile -> incertain (seuil strict < 0,5)", e?.hint);
  e = await run9("v6", "Le test a échoué : timeout. VONP=0.95");
  expect(e?.hint === "a_verifier" && dump(e.reasons) === dump(["mots : échoué, timeout", "Von 0,95"]) && e.source === "rules+von",
    "règle + Von 0,95 -> a_verifier", dump(e));
  requests.length = 0;
  e = await run9("v7", "Tâche terminée. VONP=none LAYAP=0.95");
  expect(e?.source === "rules+laya" && e.p === 0.95 && e.hint === "probablement_ok" && requests.length === 1,
    "Von sans champ noul (answer_confidence seul) : repli sur Laya", dump(e));
  e = await run9("v8", "Tâche terminée. VONP=500 LAYAP=0.8");
  expect(e?.source === "rules+laya" && e.hint === "incertain" && e.p === 0.8 && dump(e.reasons) === dump(["Laya 0,80"]),
    "Von en panne (HTTP 500) : repli sur Laya, seuil Laya 0,9 conservé (0,8 -> incertain)", dump(e));
  e = await run9("v9", "Tâche terminée. VONP=hang LAYAP=0.95");
  expect(e?.source === "rules+laya" && e.hint === "probablement_ok", "Von muet (délai de 10 s) : repli sur Laya", dump(e));
  process.env.VON_URL = `http://127.0.0.1:${closedPort}/v1/systemone`;
  e = await run9("v10", "Tâche terminée. LAYAP=0.95");
  expect(e?.source === "rules+laya" && e.hint === "probablement_ok", "Von absent : repli sur Laya", dump(e));
  process.env.LAYA_URL = `http://127.0.0.1:${closedPort}/v1/systemone`;
  e = await run9("v11", "Tâche terminée. VONP=0.95");
  expect(e?.source === "rules" && e.p === null && e.hint === "incertain" && dump(e.reasons) === dump(["Laya indisponible"]),
    "Von et Laya indisponibles : règles seules (source rules, jamais probablement_ok)", dump(e));
  e = await run9("v12", "Impossible de continuer.");
  expect(e?.source === "rules" && e.hint === "a_verifier", "Von et Laya indisponibles + règle : a_verifier", dump(e));
  // même résultat par note() : l'avis diffusé porte la source
  process.env.LAYA_URL = FAKE_URL;
  process.env.VON_URL = FAKE_VON_URL;
  h9.broadcasts.length = 0;
  h9.ctx.reviewbadge.note(task("v13", "Tout est fait. VONP=0.88"));
  const upd = await until(() => h9.broadcasts.find((b) => b.type === "reviewhint.update" && isFinal(b)), "avis Von diffusé");
  expect(upd?.source === "rules+von" && upd.hint === "probablement_ok" && upd.p === 0.88, "diffusion reviewhint.update : source rules+von", dump(upd));
  expect((await h9.get({ taskId: "v13" })).hints[0]?.source === "rules+von", "reviewhint.get : source rules+von relue");
  process.env.VON_URL = `http://127.0.0.1:${closedPort}/v1/systemone`;

  if (process.env.REAL_LAYA !== "0") {
    section("A8. un vrai appel Laya (démarrage paresseux, plusieurs dizaines de secondes la première fois)");
    delete process.env.LAYA_URL;
    delete process.env.LAYA_BIN;
    process.env.LAYA_START_TIMEOUT_MS = "120000";
    const real = await harness({ name: "real" });
    const good = await real.ctx.reviewbadge.compute(task("g1", "La fonction sum(a, b) a été ajoutée dans src/sum.js et les 12 tests passent."));
    const badOne = await real.ctx.reviewbadge.compute(task("g2", "Je n'ai pas pu terminer : le build a échoué avec une erreur 402, rien n'a été modifié."));
    console.log(`INFO Laya réel : succès p=${good?.p} (${good?.hint}) ; échec p=${badOne?.p} (${badOne?.hint})`);
    expect(typeof good?.p === "number" && good.source === "rules+laya", "[RÉEL] Laya a rendu un champ noul numérique", dump(good));
    expect(badOne?.hint === "a_verifier" && typeof badOne.p === "number", "[RÉEL] compte-rendu d'échec : à vérifier", dump(badOne));
  }
} catch (error) {
  bad("exception pendant la partie A", error?.stack || error);
}

// ================================================================ B. instance isolée
let server = null;
let daemon = null;
const agentsToDelete = new Set();
async function realParts() {
  const dataDir = join(scratch, "real-data");
  mkdirSync(dataDir, { recursive: true });
  const env = { ...process.env, DASHBOARD_PORT: String(PORT), DASHBOARD_DATA_DIR: dataDir, DASHBOARD_HOST: "127.0.0.1",
    BRAIN_DB: join(dataDir, "brain.sqlite"), LAYA_URL: FAKE_URL, LAYA_BIN: join(scratch, "inexistant.exe"),
    VON_URL: `http://127.0.0.1:${closedPort}/v1/systemone`, VON_BIN: join(scratch, "inexistant-von.exe"),
    REVIEWBADGE_DELAY_MS: "300" };
  delete env.DASHBOARD_PASSWORD;
  const taken = await new Promise((resolve) => {
    const probe = connect(PORT, "127.0.0.1");
    probe.on("connect", () => { probe.destroy(); resolve(true); });
    probe.on("error", () => resolve(false));
  });
  if (taken) throw new Error(`le port ${PORT} est déjà utilisé par un autre processus : choisissez VERIFY_PORT`);
  server = { log: "", proc: spawn(process.execPath, [join(dashboardDir, "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true }) };
  server.proc.stdout.on("data", (d) => { server.log += d; });
  server.proc.stderr.on("data", (d) => { server.log += d; });
  for (let i = 0; i < 300 && !server.log.includes("Paseo dashboard :"); i++) await sleep(100);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ui`, { origin: `http://127.0.0.1:${PORT}` });
  const inbox = [];
  let tasks = [];
  const hints = new Map();
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "tasks") tasks = m.tasks;
    else if (m.type === "reviewhint.update") { if (m.hint && !(m.reasons || []).includes("Laya en cours…")) hints.set(m.taskId, m); }
    else inbox.push(m);
  });
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  const send = (m) => ws.send(JSON.stringify(m));
  const take = (pred, label, timeout = 10000) =>
    until(() => { const i = inbox.findIndex(pred); return i >= 0 ? inbox.splice(i, 1)[0] : null; }, label, timeout);
  const byId = (id) => tasks.find((x) => x.id === id);
  const local = JSON.parse(readFileSync((process.env.DASHBOARD_HOSTS_FILE || join(dashboardDir, "hosts.json")), "utf8")).hosts.find((x) => x.label === "local");
  daemon = new DaemonClient({ url: local.url, clientId: `verify-badge-${Date.now()}`, clientType: "cli",
    password: local.password || undefined });
  await daemon.connect();

  const say = (text) => `Réponds exactement par la phrase suivante, sans rien ajouter et sans utiliser aucun outil : ${text}`;
  const specs = [
    ["T44 avis échec", "Le test a échoué : timeout après 30 s. LAYAP=0.31", "a_verifier"],
    ["T44 avis succès", "Tout est terminé avec succès, tout fonctionne. LAYAP=0.95", "probablement_ok"],
  ];
  const ids = [];
  for (const [title, text] of specs) {
    send({ type: "task.create", title, description: say(text), project: SANDBOX, host: "local", engine: ENGINE });
    const created = await take((m) => m.type === "task.created", `task.create ${title}`);
    ids.push(created?.id);
    send({ type: "task.start", id: created?.id });
  }
  for (const [i, [title, , want]] of specs.entries()) {
    const id = ids[i];
    await until(() => byId(id)?.status === "review", `réel : « ${title} » arrive à valider`, 240000, 300);
    if (byId(id)?.agentId) agentsToDelete.add(byId(id).agentId);
    expect(byId(id)?.status === "review" && (byId(id).summary || "").includes("LAYAP"),
      `réel : « ${title} » : compte-rendu reçu`, byId(id)?.summary);
    const got = await until(() => hints.get(id), `réel : avis diffusé pour « ${title} »`, 20000, 100);
    expect(got?.hint === want, `réel : « ${title} » -> ${want}`, dump(got));
    if (i === 0) {
      expect(dump(got?.reasons) === dump(["mots : échoué, timeout", "Laya 0,31"]), "réel : raisons « mots : échoué, timeout » / « Laya 0,31 »",
        dump(got?.reasons));
    } else {
      // Le modèle réel recopie parfois mal le texte demandé (observé : « 0.9 » pour « 0.95 ») : on compare à ce qu'il a écrit.
      const marker = Number(/LAYAP=(\d+(?:\.\d+)?)/.exec(byId(id)?.summary || "")?.[1]);
      expect(Number.isFinite(marker) && dump(got?.reasons) === dump([`Laya ${marker.toFixed(2).replace(".", ",")}`]),
        "réel : raisons « Laya <p du compte-rendu> » (aucun mot d'alerte)", dump([got?.reasons, byId(id)?.summary]));
    }
  }
  send({ type: "reviewhint.get" });
  const list = await take((m) => m.type === "reviewhint.list", "reviewhint.get sur le serveur isolé");
  expect(ids.every((id) => list?.hints.some((x) => x.taskId === id)), "réel : reviewhint.get renvoie les deux avis", dump(list?.hints?.length));
  const file = JSON.parse(readFileSync(join(dataDir, "review-hints.json"), "utf8"));
  expect(ids.every((id) => file.hints.some((x) => x.taskId === id && x.key.startsWith(`${id}@`))),
    "réel : data/review-hints.json (dossier jetable) contient les deux avis");
  if (process.env.HOLD_FILE) {
    console.log(`HOLD : instance isolée vivante sur http://127.0.0.1:${PORT} jusqu'à l'apparition de ${process.env.HOLD_FILE}`);
    for (let i = 0; i < 1800 && !existsSync(process.env.HOLD_FILE); i++) await sleep(500);
  }
  for (const id of ids) if (id) send({ type: "task.delete", id });
  await sleep(500);
  ws.close();
}

try {
  if (process.env.VERIFY_REAL !== "0") {
    section("B. instance isolée, 2 petits appels réels, faux Laya");
    await realParts();
  }
} catch (error) {
  bad("exception pendant la partie B", error?.stack || error);
} finally {
  if (daemon) {
    for (const id of agentsToDelete) await daemon.deleteAgent(id).catch(() => {});
    await daemon.close().catch(() => {});
    if (agentsToDelete.size) console.log(`nettoyage : ${agentsToDelete.size} agent(s) de test supprimé(s)`);
  }
  if (server) {
    server.proc.kill();
    await sleep(300);
    console.log("instance isolée arrêtée (PID propre uniquement)");
  }
}
console.log(`\n${failed ? "VERIFY_REVIEWBADGE_FAIL" : "VERIFY_REVIEWBADGE_PASS"} : ${passed} vérification(s) réussie(s), ${failed} échec(s)`);
console.log(`journaux : ${scratch}`);
process.exit(failed ? 1 : 0);
