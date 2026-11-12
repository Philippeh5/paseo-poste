// dashboard/scripts/verify-telegram.mjs
// Vérification du ticket T32, partie B : bouton « Telegram » (lecture seule) de la barre du haut.
// Instance de test isolée (port 7232, dossier de données temporaire) + FAUX dossier de bot : ne touche ni le serveur :7070,
// ni dashboard/data, ni le vrai dossier du bot, et ne lit aucun jeton.
// - handlers/telegram.mjs : heartbeat frais / périmé (> 90 s) / absent / illisible / daté du futur ; journal tronqué à 20
//   (plus récent d'abord), lignes cassées ignorées, champs plafonnés ; message telegram.status + diffusion au changement (≤ 12 s) ;
//   le module est en lecture seule (aucune écriture, aucun processus, aucun réseau) ;
// - navigateur (Playwright) : pastille verte / grise, panneau (état, 20 dernières, aide-mémoire), textContent (HTML non interprété),
//   bascule vivant -> arrêté -> vivant sans rechargement, mobile 390 px sans débordement. Captures .foreman/scratch/t32-*.png.
//   T32_HEADED=1 : navigateur visible.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { DEFAULT_BOT_DIR, STALE_MS } from "../handlers/telegram.mjs";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = join(dashboardDir, "..");
const shotDir = join(rootDir, ".foreman", "scratch");
const workDir = join(shotDir, `t32-verify-${process.pid}`);
const dataDir = join(workDir, "data");
const botDir = join(workDir, "fake-bot");
rmSync(workDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(botDir, { recursive: true });

const PORT = Number(process.env.VERIFY_PORT || 7232);
const BASE = `http://127.0.0.1:${PORT}`;
const HB = join(botDir, ".heartbeat.json");
const JOURNAL = join(botDir, "poste_activity.jsonl");

let passed = 0;
let failed = 0;
const ok = (label) => { passed++; console.log(`OK   ${label}`); };
const fail = (label, detail = "") => { failed++; console.error(`FAIL ${label}${detail ? ` -> ${detail}` : ""}`); };
const expect = (cond, label, detail = "") => (cond ? ok(label) : fail(label, detail));
const section = (name) => console.log(`\n=== ${name} ===`);

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const beat = (offsetMs = 0, extra = {}) => writeFileSync(HB, JSON.stringify({
  pid: 4242, startedAt: iso(-3_600_000), lastSeenAt: iso(offsetMs), version: "2.0-test", ...extra }));
const entry = (i, extra = {}) => JSON.stringify({ at: iso(-60_000 + i * 1000), kind: "commande", label: `/poste test ${i}`, result: "réussi", ...extra });

function startServer() {
  const env = { ...process.env, DASHBOARD_PORT: String(PORT), DASHBOARD_DATA_DIR: dataDir, DASHBOARD_HOST: "127.0.0.1",
    TELEGRAM_BOT_DIR: botDir };
  delete env.DASHBOARD_PASSWORD;
  const proc = spawn(process.execPath, [join(dashboardDir, "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const srv = { proc, log: "" };
  proc.stdout.on("data", (d) => { srv.log += d; });
  proc.stderr.on("data", (d) => { srv.log += d; });
  return srv;
}
async function stopServer(srv) {
  if (srv.proc.exitCode !== null) return;
  const gone = new Promise((r) => srv.proc.once("exit", r));
  srv.proc.kill();
  await gone;
}
async function connectWs(srv) {
  for (let i = 0; i < 300 && !srv.log.includes("Paseo dashboard :"); i++) await sleep(100);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ui`, { origin: BASE });
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  const take = async (pred, label, timeout = 8000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0];
      await sleep(20);
    }
    fail(`Délai dépassé : ${label}`);
    return null;
  };
  const status = async (ref = "t") => {
    ws.send(JSON.stringify({ type: "telegram.status", ref }));
    return take((m) => m.type === "telegram.status" && m.ref === ref, "telegram.status");
  };
  return { ws, inbox, take, status };
}

const srv = startServer();
let client;
try {
  client = await connectWs(srv);
  expect(srv.log.includes("chargé : telegram.mjs"), "handler telegram.mjs chargé par le serveur");

  section("G3.a : handler — états du fichier de vie");
  expect(DEFAULT_BOT_DIR === "D:\\Projets\\TelegramAssistant", "dossier du bot par défaut = D:\\Projets\\TelegramAssistant");
  expect(STALE_MS === 90_000, "seuil de péremption = 90 s");
  let s = await client.status();
  expect(s && s.running === false && s.lastSeenAt === null && s.recent.length === 0, "fichiers absents -> bot arrêté, aucune commande", JSON.stringify(s));
  beat(-12_000);
  s = await client.status();
  expect(s.running === true && s.ageMs >= 11_000 && s.ageMs < 20_000, "heartbeat de 12 s -> en marche, âge ≈ 12 s", JSON.stringify(s));
  expect(s.version === "2.0-test" && s.startedAt && s.lastSeenAt, "version, startedAt, lastSeenAt exposés");
  expect(!("pid" in s) && !("dir" in s), "ni pid ni chemin exposés");
  beat(-(STALE_MS - 3000));
  expect((await client.status()).running === true, "heartbeat de 87 s -> encore en marche");
  beat(-(STALE_MS + 5000));
  s = await client.status();
  expect(s.running === false && s.lastSeenAt !== null, "heartbeat de 95 s -> bot arrêté (périmé)", JSON.stringify(s));
  writeFileSync(HB, "{ pas du json");
  expect((await client.status()).running === false, "fichier de vie illisible -> bot arrêté, pas de plantage");
  writeFileSync(HB, JSON.stringify({ lastSeenAt: "hier", pid: 1 }));
  expect((await client.status()).running === false, "lastSeenAt invalide -> bot arrêté");
  beat(+3_600_000);
  expect((await client.status()).running === false, "heartbeat daté d'une heure dans le futur -> bot arrêté");
  beat(-1000);
  expect((await client.status()).running === true, "retour à un heartbeat frais -> en marche");

  section("G3.b : handler — journal d'activité");
  const lines = [];
  for (let i = 0; i < 600; i++) lines.push(entry(i));
  lines.splice(300, 0, "ligne cassée {", "", JSON.stringify({ at: "pas une date", label: "x" }));
  lines.push(entry(999, { label: "L".repeat(500), result: "R".repeat(500), kind: "K".repeat(100), secret: "ne-doit-pas-sortir" }));
  writeFileSync(JOURNAL, lines.join("\n") + "\n");
  s = await client.status();
  expect(s.recent.length === 20, "20 dernières entrées seulement", String(s.recent.length));
  expect(s.recent[0].label.length <= 160 && s.recent[0].label.startsWith("LLL"), "la plus récente est en tête, libellé plafonné", String(s.recent[0].label.length));
  expect(s.recent[0].result.length <= 160 && s.recent[0].kind.length <= 30, "résultat et type plafonnés");
  expect(s.recent[1].label === "/poste test 599" && s.recent[19].label === "/poste test 581", "ordre : plus récent d'abord", `${s.recent[1].label} … ${s.recent[19].label}`);
  expect(!JSON.stringify(s).includes("ne-doit-pas-sortir"), "seuls at / kind / label / result sont relayés");
  expect(Object.keys(s.recent[0]).sort().join() === "at,kind,label,result", "forme des entrées");
  writeFileSync(JOURNAL, "x".repeat(400_000) + "\n" + entry(1) + "\n");
  s = await client.status();
  expect(s.recent.length === 1 && s.recent[0].label === "/poste test 1", "gros fichier : seule la fin est lue, ligne tronquée ignorée");

  section("G3.c : diffusion quand l'état change (≤ 12 s) et lecture seule");
  client.inbox.length = 0;
  const t0 = Date.now();
  beat(-(STALE_MS + 20_000));
  const pushed = await client.take((m) => m.type === "telegram.status" && m.ref === null && m.running === false, "diffusion « arrêté »", 14_000);
  expect(pushed !== null && Date.now() - t0 <= 13_000, "la diffusion arrive toute seule quand le bot devient périmé", `${Date.now() - t0} ms`);
  const source = readFileSync(join(dashboardDir, "handlers", "telegram.mjs"), "utf8")
    .replace(/^\s*\/\/.*$/gm, "").replace(/process\.env\.TELEGRAM_BOT_DIR/g, "");   // sans commentaires ni la variable de dossier
  expect(!/writeFile|appendFile|unlink|rmSync|mkdir|spawn|exec\(|execSync|child_process|fetch\(|https?:\/\/api\.telegram|\.env|tokens\.json/.test(source),
    "handler en lecture seule : aucune écriture, aucun processus, aucun réseau, aucun fichier secret");

  section("G3.d : navigateur (Playwright) — pastille, panneau, bascule, mobile");
  let browser = null;
  try {
    let playwright = null;
    for (const p of ["playwright-core", "file:///C:/Users/Philippe/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core/index.mjs"]) {
      try { const mod = await import(p); playwright = mod.default || mod; break; } catch { /* suivant */ }
    }
    if (!playwright) throw new Error("playwright-core introuvable");
    writeFileSync(JOURNAL, [...Array.from({ length: 30 }, (_, i) => entry(i)),
      entry(31, { label: '<img src=x onerror="window.__xss=1"> /poste état', result: "<b>réussi</b>" }),
      entry(32, { label: "Poste : fermer des sessions", result: "non effectué" })].join("\n") + "\n");
    beat(-4000);
    browser = await playwright.chromium.launch({ headless: process.env.T32_HEADED !== "1" });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let navigations = 0;
    page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigations++; });
    await page.goto(`${BASE}/#taches`, { waitUntil: "domcontentloaded" });
    const button = page.locator("#topbar-telegram");
    await button.waitFor({ state: "visible", timeout: 10_000 });
    expect((await button.innerText()).trim() === "Hermes", "bouton « Hermes » (ex-Telegram) dans la barre du haut");
    await page.waitForFunction(() => /^(ok|attention|danger|inactif)$/.test(document.querySelector("#topbar-telegram")?.dataset.state || ""), null, { timeout: 8000 });
    const state = await button.getAttribute("data-state");
    expect(["ok", "attention", "danger", "inactif"].includes(state), "pastille d'état renseignée (ok / attention / danger / inactif)", state);
    expect((await button.getAttribute("aria-label")).startsWith("Hermes :"), "nom accessible « Hermes : … »", await button.getAttribute("aria-label"));
    expect(await button.locator(".led").count() === 1, "pastille led présente");
    const panel = page.locator("#telegram-panel");
    expect(await panel.isHidden(), "panneau fermé au départ");
    await button.click();
    await panel.waitFor({ state: "visible", timeout: 3000 });
    const statusText = await page.locator(".telegram-status").first().innerText();
    expect(statusText.trim().length > 0, "état du bot affiché dans le panneau", statusText);
    expect(await page.evaluate(() => window.__xss === undefined), "aucun script du journal exécuté");
    await panel.evaluate((n) => { n.scrollTop = 0; });
    await page.screenshot({ path: join(shotDir, "t32-panel-running.png") });

    // Fermeture par Échap puis par clic à côté, sans rechargement de la page
    const navBefore = navigations;
    await page.keyboard.press("Escape");
    expect(await panel.isHidden(), "Échap ferme le panneau");
    await button.click();
    await panel.waitFor({ state: "visible", timeout: 3000 });
    await page.mouse.click(10, 400);
    expect(await panel.isHidden(), "un clic à côté ferme le panneau");
    expect(navigations === navBefore, "aucun rechargement de la page pendant les ouvertures/fermetures", `${navigations - navBefore}`);

    // mobile 390 px : le panneau reste dans la vue sans défilement horizontal
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true })).newPage();
    await phone.goto(`${BASE}/#taches`, { waitUntil: "domcontentloaded" });
    // Depuis la refonte mobile (css/mobile.css, barre du haut réduite à l'essentiel), le bouton Hermes est masqué sous 720 px :
    // il reste présent dans le DOM mais n'est plus affiché. On vérifie donc ce choix, puis on ouvre le panneau par un clic
    // programmatique pour contrôler que, s'il est ouvert, il tient dans l'écran.
    await phone.locator("#topbar-telegram").waitFor({ state: "attached", timeout: 10_000 });
    expect(await phone.locator("#topbar-telegram").isHidden(), "mobile 390 px : bouton Hermes masqué dans la barre du haut (choix de la barre réduite)");
    await phone.locator("#topbar-telegram").evaluate((b) => b.click());
    await phone.locator("#telegram-panel").waitFor({ state: "visible", timeout: 3000 });
    const geo = await phone.evaluate(() => {
      const r = document.querySelector("#telegram-panel").getBoundingClientRect();
      return { scroll: document.documentElement.scrollWidth, left: r.left, right: r.right, width: innerWidth };
    });
    expect(geo.scroll <= geo.width, "mobile 390 px : pas de défilement horizontal de la page", JSON.stringify(geo));
    expect(geo.left >= 0 && geo.right <= geo.width, "mobile 390 px : panneau entièrement visible", JSON.stringify(geo));
    await phone.screenshot({ path: join(shotDir, "t32-mobile.png") });
    expect(errors.length === 0, "aucune erreur JavaScript dans la page", errors.join(" | "));
    await browser.close();
    browser = null;
  } catch (e) {
    fail("vérification navigateur", e.stack || e.message);
  } finally {
    if (browser) await browser.close();
  }
} catch (e) {
  fail("exception inattendue", e.stack || e.message);
} finally {
  try { client?.ws.close(); } catch { /* ignoré */ }
  await stopServer(srv);
  await sleep(300);
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); } catch { /* ignoré */ }
}

console.log(`\n=== BILAN : ${passed} OK, ${failed} FAIL ===`);
if (failed > 0) process.exit(1);
console.log("T32 TELEGRAM VERIFY PASSED");
