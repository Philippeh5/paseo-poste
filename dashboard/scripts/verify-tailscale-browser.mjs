// T33 G2 : accès réel par l'IP Tailscale (curl + Playwright headed) sur une instance de test jetable.
// Variables : HEADLESS=1 pour un navigateur sans fenêtre ; SHOT=<fichier.png> pour garder une capture.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const server = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const PASS = "t33b-" + randomBytes(12).toString("hex");
const port = 19000 + Math.floor(Math.random() * 900);
const dataDir = mkdtempSync(join(tmpdir(), "t33b-data-"));
let tsIp;
try { tsIp = execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/)[0]; }
catch { /* tailscale non disponible sur cette machine */ }

let failures = 0;
const ok = (c, l, d = "") => { console.log(`  ${c ? "ok  " : "FAIL"} ${l} ${c ? "" : d}`); if (!c) failures++; };

const child = spawn(process.execPath, [server], {
  cwd: dirname(server), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  env: { ...process.env, DASHBOARD_HOST: "127.0.0.1", DASHBOARD_PORT: String(port), DASHBOARD_DATA_DIR: dataDir, DASHBOARD_PASSWORD: "",
    DASHBOARD_TAILSCALE: "1", DASHBOARD_TAILSCALE_PASSWORD: PASS, DASHBOARD_TAILSCALE_IP: tsIp },
});
let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
let browser;
try {
  for (let i = 0; i < 150 && !out.includes("(Tailscale"); i++) await delay(100);
  if (!out.includes("(Tailscale")) throw new Error("écouteur Tailscale non démarré : " + out);
  await delay(1000);
  const base = `http://${tsIp}:${port}`;
  console.log(`Instance de test : ${base} (mot de passe jetable)`);

  const curl = (...a) => execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "8", ...a], { encoding: "utf8" }).trim();
  ok(curl(base + "/") === "401", "curl sans identifiants -> 401");
  ok(curl("-u", "admin:" + PASS, base + "/") === "200", "curl avec identifiants / -> 200");
  ok(curl("-u", "admin:" + PASS, base + "/api/v1/summary") === "200", "curl avec identifiants /api/v1/summary -> 200");

  let playwright;
  for (const p of ["playwright-core"]) {
    try { const m = await import(p); playwright = m.default || m; break; } catch { /* suivant */ }
  }
  if (!playwright) throw new Error("playwright-core introuvable");
  browser = await playwright.chromium.launch({ headless: process.env.HEADLESS === "1" || (process.env.HEADLESS !== "0" && process.platform !== "win32") });

  // 1. sans identifiants : le navigateur reçoit 401 + WWW-Authenticate (invite de connexion du téléphone)
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  const seen = new Promise((resolve) => anonPage.on("response", (r) => { if (r.url() === base + "/") resolve(r); }));
  anonPage.goto(base + "/").catch(() => { /* l'invite de connexion interrompt la navigation */ });
  const resp = await Promise.race([seen, delay(8000).then(() => null)]);
  ok(resp?.status() === 401 && /basic/i.test(resp.headers()["www-authenticate"] || ""), "navigateur sans identifiants : 401 + invite Basic", String(resp?.status()));
  await anon.close();

  // 2. avec identifiants : page chargée et WebSocket /ui connectée
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, httpCredentials: { username: "admin", password: PASS } });
  const page = await context.newPage();
  const wsInfo = { url: null, frames: 0, state: false };
  page.on("websocket", (ws) => {
    wsInfo.url = ws.url();
    ws.on("framereceived", (f) => { wsInfo.frames++; if (String(f.payload).includes('"type":"state"')) wsInfo.state = true; });
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 100 && !wsInfo.state; i++) await delay(100);
  ok(wsInfo.url === `ws://${tsIp}:${port}/ui`, "WebSocket ouverte sur l'adresse Tailscale (URL relative)", String(wsInfo.url));
  ok(wsInfo.state, "message d'état reçu par la WebSocket", `frames=${wsInfo.frames}`);
  const title = await page.title();
  const bodyText = (await page.locator("body").innerText()).trim();
  ok(bodyText.length > 20, `page rendue (titre « ${title} », ${bodyText.length} caractères)`);
  ok(errors.length === 0, "aucune erreur JS de page", errors.join(" | "));
  const apiStatus = await page.evaluate(async () => (await fetch("/api/v1/summary")).status);
  ok(apiStatus === 200, "fetch /api/v1/summary depuis la page (identifiants du navigateur) -> 200", String(apiStatus));
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  ok(!out.includes(PASS), "le mot de passe n'apparaît pas dans les journaux du serveur");
} catch (e) {
  failures++;
  console.log("ERREUR", e.stack || e.message);
} finally {
  await browser?.close().catch(() => {});
  child.kill();
  await delay(500);
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
}
console.log(failures === 0 ? "verify-tailscale-browser OK" : `verify-tailscale-browser ECHEC (${failures})`);
process.exit(failures === 0 ? 0 : 1);
