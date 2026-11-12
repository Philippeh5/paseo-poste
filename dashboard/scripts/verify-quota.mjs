// dashboard/scripts/verify-quota.mjs
// Vérification du ticket T41 : quotas par fournisseur et repli automatique de moteur (handlers/quota.mjs).
// - Partie A (en processus, horloge injectable) : classification des raisons, durées de repos (crédits 30 min,
//   débit 2 min, quota = fin de fenêtre ou 60 min), reprise, pickEngine (saute un moteur au repos, refuse OpenRouter
//   payant, rien de disponible), validation de la liste de repli, diffusion limitée à une par 30 s, aucune clé exposée.
// - Partie B (instance isolée, port 7098 ou VERIFY_PORT, dossier de données temporaire, aucune machine configurée) :
//   quota.get / quota.setFallback / quota.state diffusé par WebSocket, reprise avec délais réduits
//   (QUOTA_COOLDOWN_SCALE), GET /api/v1/quota, fichiers statiques. N'écrit jamais dans dashboard/data
//   et ne touche pas :7070.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createQuota, classify, DEFAULT_FALLBACK, REST_MS } from "../handlers/quota.mjs";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratchDir = join(dashboardDir, "..", ".foreman", "scratch", `t41-quota-${process.pid}`);
rmSync(scratchDir, { recursive: true, force: true });
mkdirSync(join(scratchDir, "data"), { recursive: true });

const PORT = Number(process.env.VERIFY_PORT || 7098);
if (PORT === 7070) throw new Error("jamais contre le serveur réel :7070");
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "sk-or-v1-SECRETSECRETSECRET1234567890";

let passed = 0;
let failed = 0;
const ok = (label) => { passed++; console.log(`OK   ${label}`); };
const fail = (label, detail = "") => { failed++; console.error(`FAIL ${label}${detail ? ` -> ${detail}` : ""}`); };
const expect = (cond, label, detail = "") => (cond ? ok(label) : fail(label, detail));
const section = (name) => console.log(`\n=== ${name} ===`);
const MIN = 60_000;

// Alias OpenRouter de test : sonnet gratuit, opus payant ; une clé factice que rien ne doit laisser sortir.
const settingsFile = join(scratchDir, "or-settings.json");
writeFileSync(settingsFile, JSON.stringify({ env: {
  ANTHROPIC_API_KEY: SECRET, ANTHROPIC_AUTH_TOKEN: SECRET,
  ANTHROPIC_DEFAULT_SONNET_MODEL: "vendor/free-model:free", ANTHROPIC_DEFAULT_OPUS_MODEL: "vendor/paid-model",
} }));

function memoryStore() {
  const files = new Map();
  return { files, read: (n, fb = null) => (files.has(n) ? structuredClone(files.get(n)) : fb), write: (n,
    v) => files.set(n, structuredClone(v)) };
}

// =========================================================================================== Partie A
section("A1 : classification des raisons");
const table = [
  ["402 Payment Required", "credit"], ["Insufficient credits on account", "credit"], [new Error("HTTP 402"), "credit"],
  ["429", "rate"], ["Rate limit reached for model", "rate"], ["Too Many Requests", "rate"],
  ["5-hour limit reached", "quota"], ["Quota exceeded for project", "quota"], ["usage limit hit", "quota"],
  ["HTTP 429 quota exceeded", "quota"], ["connection reset by peer", "other"], ["", "other"], [undefined, "other"],
];
for (const [input, expected] of table) {
  const got = classify(input);
  expect(got === expected, `classify(${JSON.stringify(String(input?.message ?? input))}) = ${expected}`, got);
}

section("A2 : repos, reprise et repli (horloge injectée)");
let clock = Date.parse("2026-10-21T10:00:00Z");
const sent = [];
const store = memoryStore();
const q = createQuota({ store, now: () => clock, broadcast: (m) => sent.push(m), settingsFile });
const names = (snap) => snap.providers.map((p) => p.id).sort().join(",");
const first = q.snapshot();
expect(names(first) === "claude-nvidia,claude-openrouter,pi/nvidia-proxy",
  "fournisseurs connus au départ (liste de repli)", names(first));
expect(first.providers.every((p) => p.state === "ok") && first.cooldowns.length === 0, "tout est OK au départ");
expect(JSON.stringify(first.fallback.map((f) => f.engine)) === JSON.stringify(DEFAULT_FALLBACK),
  "liste de repli par défaut");
expect(store.files.size === 0, "rien n'est écrit tant que la liste n'est pas modifiée");

let pick = q.pickEngine("claude-openrouter/sonnet");
expect(pick.engine === "claude-openrouter/sonnet" && pick.changed === false && pick.reason === null,
  "moteur disponible : gardé tel quel");

const credit = q.noteFailure("claude-openrouter/sonnet", "402 Payment Required: insufficient credits");
expect(credit.kind === "credit" && credit.restMs === 30 * MIN, "402 : repos « crédits » de 30 min",
  JSON.stringify(credit));
expect(REST_MS.credit === 30 * MIN && REST_MS.rate === 2 * MIN && REST_MS.quota === 60 * MIN,
  "constantes 30 min / 2 min / 60 min");
pick = q.pickEngine("claude-openrouter/sonnet");
expect(pick.engine === "claude-nvidia/sonnet" && pick.changed === true && /crédits épuisés/.test(pick.reason),
  "moteur au repos sauté : repli sur claude-nvidia/sonnet avec la raison", JSON.stringify(pick));
pick = q.pickEngine("claude-openrouter/vendor/other-model:free");
expect(pick.engine === "claude-nvidia/sonnet" && pick.changed,
  "crédits épuisés = tout le fournisseur OpenRouter au repos");
const stateAfter = q.snapshot();
const orProvider = stateAfter.providers.find((p) => p.id === "claude-openrouter");
expect(orProvider.state === "exhausted" && orProvider.remainingMs === 30 * MIN,
  "pastille OpenRouter : épuisé, 30 min restantes");
clock += 29 * MIN;
expect(q.pickEngine("claude-openrouter/sonnet").changed === true, "29 min plus tard : encore au repos");
clock += 1 * MIN + 1;
pick = q.pickEngine("claude-openrouter/sonnet");
expect(pick.engine === "claude-openrouter/sonnet" && !pick.changed, "30 min écoulées : reprise, moteur d'origine");
expect(q.snapshot().cooldowns.length === 0 && q.snapshot().providers.every((p) => p.state === "ok"),
  "plus aucun repos après la reprise");

const rate = q.noteFailure("claude-nvidia/sonnet", "HTTP 429 Too Many Requests");
expect(rate.kind === "rate" && rate.restMs === 2 * MIN, "429 : repos « débit » de 2 min");
expect(q.pickEngine("claude-nvidia/opus").changed === false, "débit : seul ce moteur est au repos, pas le fournisseur");
expect(q.snapshot().providers.find((p) => p.id === "claude-nvidia").state === "slow", "pastille NVIDIA : ralenti");
clock += 2 * MIN + 1;
expect(q.pickEngine("claude-nvidia/sonnet").changed === false, "2 min écoulées : reprise");

// quota : fin de fenêtre connue (usage du daemon), sinon 60 min
q.ingest({ usage: { local: { available: true, providers: [
  { providerId: "claude", displayName: "Claude", status: "available", windows: [
    { id: "5h", label: "5 heures", shortLabel: "5h", usedPct: 100, resetsAt: new Date(clock + 47 * MIN).toISOString() },
    { id: "7d", label: "7 jours", shortLabel: "7j", usedPct: 40.4,
      resetsAt: new Date(clock + 3 * 86_400_000).toISOString() }] },
  { providerId: "codex", displayName: "Codex", status: "unavailable", windows: [] },
] } } });
const withUsage = q.snapshot();
const claude = withUsage.providers.find((p) => p.id === "claude");
expect(claude?.windows.length === 2 && claude.windows[1].usedPct === 40,
  "fenêtres 5h / 7j reprises de listUsage (arrondies)");
expect(claude.state === "exhausted", "fenêtre à 100 % : pastille épuisée sans même un échec");
expect(withUsage.providers.find((p) => p.id === "codex")?.state === "unknown", "fournisseur sans usage : inconnu");
const quotaKnown = q.noteFailure("claude/sonnet", "5-hour limit reached");
expect(quotaKnown.kind === "quota" && quotaKnown.restMs === 47 * MIN,
  "quota : repos jusqu'à la fin de la fenêtre connue (47 min)",
  JSON.stringify(quotaKnown));
const quotaUnknown = q.noteFailure("codex/gpt-x", "usage limit reached");
expect(quotaUnknown.kind === "quota" && quotaUnknown.restMs === 60 * MIN, "quota sans fenêtre connue : 60 min");
const other = q.noteFailure("claude-nvidia/sonnet", `connection reset (token=${SECRET})`);
expect(other.kind === "other" && other.restMs === 0 && q.pickEngine("claude-nvidia/sonnet").changed === false,
  "autre erreur : notée mais aucun repos");
expect(!JSON.stringify(q.snapshot()).includes("SECRETSECRET"), "une clé dans le message d'erreur est masquée");
expect(q.snapshot().failures[0].kind === "other" && q.snapshot().failures.length === 5, "échecs récents conservés (5)");
clock += 61 * MIN;

section("A3 : OpenRouter gratuit seulement, liste de repli, aucun moteur disponible");
pick = q.pickEngine("claude-openrouter/opus");
expect(pick.engine !== "claude-openrouter/opus" && pick.changed
  && /OpenRouter payant refusé \(vendor\/paid-model\)/.test(pick.reason),
  "alias opus -> modèle payant : refusé", JSON.stringify(pick));
expect(q.pickEngine("claude-openrouter/sonnet").engine === "claude-openrouter/sonnet",
  "alias sonnet -> modèle :free : accepté");
expect(q.pickEngine("claude-openrouter/some/model").changed === true, "modèle littéral sans :free : refusé");
expect(q.pickEngine("claude-openrouter/some/model:free").changed === false, "modèle littéral :free : accepté");
expect(q.pickEngine("pi/openrouter/openai/gpt-4o").changed === true, "pi/openrouter/… payant : refusé");
const missing = createQuota({ store: memoryStore(), now: () => clock, settingsFile: join(scratchDir, "absent.json") });
expect(/introuvable/.test(missing.pickEngine("claude-openrouter/sonnet").reason ?? ""),
  "alias illisible : refusé par prudence");
expect(!JSON.stringify(q.snapshot()).includes("SECRETSECRET") && !JSON.stringify(pick).includes("SECRETSECRET"),
  "aucune clé OpenRouter dans les réponses");

const raw = memoryStore();
raw.write("engine-fallback", { engines: ["claude-openrouter/opus", "claude-nvidia/sonnet"] });
const q3 = createQuota({ store: raw, now: () => clock, settingsFile });
q3.noteFailure("claude-openrouter/sonnet", "402");
expect(q3.pickEngine("claude-openrouter/sonnet").engine === "claude-nvidia/sonnet",
  "liste éditée à la main avec un moteur payant en tête : il est sauté");

for (const [label, bad] of [["non-tableau", "claude/x"], ["liste vide", []], ["sans fournisseur", ["sonnet"]],
  ["doublon", ["claude/a", "claude/a"]], ["trop long", Array.from({ length: 13 }, (_, i) => `claude/m${i}`)],
  ["caractères interdits", ["claude/a b"]], ["OpenRouter payant", ["claude-openrouter/opus"]], ["nombre", [42]]]) {
  let error = null;
  try { q.setFallback(bad); } catch (e) { error = e.message; }
  expect(Boolean(error), `setFallback refuse : ${label}`, error ?? "accepté");
}
const before = sent.length;
q.setFallback(["claude-nvidia/sonnet", "claude-openrouter/sonnet",
  "pi/nvidia-proxy/nvidia/nemotron-3-ultra-550b-a55b"]);
expect(store.files.get("engine-fallback")?.engines[0] === "claude-nvidia/sonnet",
  "ordre enregistré par ctx.store (engine-fallback)");
expect(q.getFallback()[0] === "claude-nvidia/sonnet" && sent.length === before + 1, "ordre relu et diffusé aussitôt");

const downs = createQuota({ store: memoryStore(), now: () => clock, settingsFile });
for (const e of DEFAULT_FALLBACK) downs.noteFailure(e, "402 credits");
const none = downs.pickEngine("claude-openrouter/sonnet");
expect(none.engine === null && none.changed === false && none.retryAt > clock
  && /aucun moteur disponible/.test(none.reason),
  "tous au repos : engine null avec retryAt", JSON.stringify(none));

section("A4 : diffusion au changement, 30 s au plus");
const spy = [];
let c4 = 1_000_000;
const q4 = createQuota({ store: memoryStore(), now: () => c4, broadcast: (m) => spy.push(m), settingsFile });
q4.tick();
expect(spy.length === 0, "aucun changement : aucune diffusion");
q4.noteFailure("claude-nvidia/sonnet", "429");
expect(spy.length === 1 && spy[0].type === "quota.state", "premier changement : diffusé aussitôt");
expect(spy[0].cooldowns.length === 1 && spy[0].providers.some((p) => p.state === "slow"),
  "le message porte cooldowns et providers");
c4 += 5_000;
q4.noteFailure("claude-openrouter/sonnet", "402");
q4.tick();
expect(spy.length === 1, "second changement 5 s plus tard : retenu (30 s au plus)");
c4 += 26_000;
q4.tick();
expect(spy.length === 2 && spy[1].cooldowns.some((c) => c.kind === "credit"),
  "après 30 s : diffusé avec les deux changements");
c4 += 2 * MIN;
q4.tick();
expect(spy.length === 3 && !spy[2].cooldowns.some((c) => c.kind === "rate")
  && spy[2].cooldowns.some((c) => c.kind === "credit"),
  "la fin du repos « débit » (2 min) est diffusée, les crédits restent au repos");
q4.stop();

// =========================================================================================== Partie B
section("B : instance isolée (WebSocket + REST)");
const occupied = await fetch(BASE).then(() => true, () => false);
if (occupied) {
  throw new Error(`le port ${PORT} est déjà utilisé : ce test ne se branche jamais sur un serveur existant`);
}
const hostsFile = join(scratchDir, "hosts-vide.json");
writeFileSync(hostsFile, JSON.stringify({ hosts: [] }));
const env = {
  ...process.env, DASHBOARD_PORT: String(PORT), DASHBOARD_DATA_DIR: join(scratchDir, "data"),
    DASHBOARD_HOST: "127.0.0.1",
  DASHBOARD_HOSTS_FILE: hostsFile, QUOTA_COOLDOWN_SCALE: "0.004", QUOTA_BROADCAST_MIN_MS: "250",
  QUOTA_OPENROUTER_SETTINGS: settingsFile, QUOTA_TEST_HOOK: "1",
};
delete env.DASHBOARD_PASSWORD;
const proc = spawn(process.execPath, [join(dashboardDir, "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true });
let log = "";
proc.stdout.on("data", (d) => { log += d; });
proc.stderr.on("data", (d) => { log += d; });
let ws = null;
try {
  for (let i = 0; i < 300 && !log.includes("Paseo dashboard :"); i++) await sleep(100);
  expect(log.includes("chargé : quota.mjs"), "le serveur charge handlers/quota.mjs");
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ui`, { origin: BASE });
  const inbox = [];
  ws.on("message", (raw) => inbox.push({ ...JSON.parse(raw.toString()), _t: Date.now() }));
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  const take = async (pred, label, timeout = 8000) => {
    for (const end = Date.now() + timeout; Date.now() < end; await sleep(20)) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0];
    }
    fail(`Délai dépassé : ${label}`);
    return null;
  };
  const rpc = (msg, pred, label, timeout) => { inbox.length = 0; ws.send(JSON.stringify(msg)); return take(pred,
    label, timeout); };
  const isState = (m) => m.type === "quota.state";

  const got = await rpc({ type: "quota.get", ref: "r1" }, isState, "quota.get");
  expect(got?.ref === "r1" && Array.isArray(got.providers) && Array.isArray(got.cooldowns)
    && Array.isArray(got.fallback),
    "quota.get -> quota.state {providers, cooldowns, fallback}");
  expect(got?.fallback.map((f) => f.engine).join("|") === DEFAULT_FALLBACK.join("|"),
    "liste de repli par défaut côté serveur");
  expect(got?.providers.every((p) => p.state === "ok"), "tous les fournisseurs OK au départ");

  const refuse = async (msg, pattern, label) => {
    const err = await rpc(msg, (m) => m.type === "error", label);
    expect(pattern.test(err?.message ?? ""), label, err?.message);
  };
  await refuse({ type: "quota.setFallback", engines: ["sonnet"] }, /fournisseur\/modèle/,
    "setFallback : forme invalide refusée");
  await refuse({ type: "quota.setFallback", engines: [] }, /vide/, "setFallback : liste vide refusée");
  await refuse({ type: "quota.setFallback", engines: ["claude-openrouter/opus"] }, /OpenRouter payant refusé/,
    "setFallback : OpenRouter payant refusé");
  expect(!JSON.stringify(inbox).includes("SECRETSECRET"), "aucune clé dans les messages d'erreur");

  const reordered = ["claude-nvidia/sonnet", "claude-openrouter/sonnet",
    "pi/nvidia-proxy/nvidia/nemotron-3-ultra-550b-a55b"];
  const set = await rpc({ type: "quota.setFallback", engines: reordered }, isState,
    "setFallback valide -> quota.state diffusé");
  expect(set?.fallback.map((f) => f.engine).join("|") === reordered.join("|"), "ordre de repli modifié et diffusé");
  const onDisk = JSON.parse(readFileSync(join(scratchDir, "data", "engine-fallback.json"), "utf8"));
  expect(onDisk.engines.join("|") === reordered.join("|"), "data/engine-fallback.json écrit (dossier de test)");

  // Échecs : crédits sur OpenRouter (7,2 s), puis débit sur NVIDIA (0,48 s) aussitôt -> diffusion retenue ~250 ms
  inbox.length = 0;
  ws.send(JSON.stringify({ type: "quota.test.fail", engine: "claude-openrouter/sonnet",
    reason: "402 insufficient credits" }));
  const credited = await take(isState, "quota.state après un échec « crédits »");
  expect(credited?.cooldowns.some((c) => c.kind === "credit" && c.engine === "claude-openrouter/sonnet"
    && c.remainingMs > 0),
    "échec 402 : repos « crédits » diffusé");
  expect(credited?.providers.find((p) => p.id === "claude-openrouter")?.state === "exhausted", "OpenRouter : épuisé");
  ws.send(JSON.stringify({ type: "quota.test.fail", engine: "claude-nvidia/sonnet", reason: "429 Too Many Requests" }));
  const delayed = await take(isState, "quota.state après l'échec « débit » (retenu)");
  const gap = delayed ? delayed._t - credited._t : 0;
  expect(gap >= 200, `deuxième diffusion retenue (écart ${gap} ms, minimum réglé à 250 ms)`);
  expect(delayed?.cooldowns.some((c) => c.kind === "rate") && delayed.cooldowns.some((c) => c.kind === "credit"),
    "la diffusion retenue contient les deux repos");
  expect(delayed?.fallback.find((f) => f.engine === "claude-openrouter/sonnet")?.resting === true,
    "liste de repli : moteur marqué au repos");

  const rest = await api("/api/v1/quota");
  expect(rest.status === 200 && Array.isArray(rest.json?.data?.providers ?? rest.json?.providers),
    "GET /api/v1/quota : instantané en lecture", `${rest.status} ${JSON.stringify(rest.json).slice(0, 120)}`);
  const posted = await fetch(`${BASE}/api/v1/quota`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: "{}" });
  expect(posted.status >= 400, "POST /api/v1/quota : refusé (lecture seule)", String(posted.status));

  // Reprise : le débit (0,48 s) puis les crédits (7,2 s) se terminent tout seuls et la fin est diffusée
  const nvidiaBack = await take((m) => isState(m) && !m.cooldowns.some((c) => c.kind === "rate"),
    "fin du repos « débit » diffusée");
  expect(Boolean(nvidiaBack), "fin du repos « débit » diffusée sans action");
  const allBack = await take((m) => isState(m) && m.cooldowns.length === 0, "fin du repos « crédits » diffusée", 8000);
  expect(allBack?.providers.every((p) => p.state === "ok"), "plus aucun repos : tous les fournisseurs OK de nouveau");
  const regot = await rpc({ type: "quota.get" }, isState, "quota.get après reprise");
  expect(regot?.failures.length === 2 && regot.cooldowns.length === 0, "échecs récents conservés (2), aucun repos");

  const css = await fetch(`${BASE}/css/quota.css`);
  const js = await fetch(`${BASE}/js/components/quota.js`);
  const html = await (await fetch(`${BASE}/`)).text();
  expect(css.status === 200 && js.status === 200 && html.includes('href="css/quota.css"'),
    "quota.css / quota.js servis, <link> dans index.html");
  const topbarSrc = readFileSync(join(dashboardDir, "public", "js", "core", "topbar.js"), "utf8");
  expect(topbarSrc.includes('import { createQuotaGauge } from "../components/quota.js"')
    && topbarSrc.includes("createQuotaGauge()"),
    "topbar.js importe et place la jauge");
  expect(!log.includes("SECRETSECRET"), "aucune clé dans le journal du serveur");
} catch (e) {
  fail("exception pendant la vérification", e.stack || e.message);
} finally {
  section("Nettoyage");
  try { ws?.close(); } catch { /* ignoré */ }
  proc.kill();
  await sleep(400);
  try { rmSync(scratchDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); } catch { /* ignoré */ }
  console.log(`\n=== BILAN : ${passed} OK, ${failed} FAIL ===`);
  if (failed > 0) process.exitCode = 1;
  else console.log("VERIFY_QUOTA_PASS");
}

async function api(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { "X-Agent-Name": "verify-quota" } });
  return { status: res.status, json: await res.json().catch(() => null) };
}
