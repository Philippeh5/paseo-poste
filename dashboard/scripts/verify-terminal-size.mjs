// Vérification de la taille des terminaux et du redimensionnement PTY/xterm (Ticket T16 PARTIE A).
// Usage : node dashboard/scripts/verify-terminal-size.mjs
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const screenshotsDir = join(here, "..", "screenshots");
mkdirSync(screenshotsDir, { recursive: true });

async function getPlaywright() {
  const paths = ["playwright-core"];
  for (const p of paths) {
    try {
      const mod = await import(p);
      return mod.default || mod;
    } catch {}
  }
  throw new Error("playwright non trouvé");
}

const url = process.env.DASHBOARD_VERIFY_URL || "ws://127.0.0.1:7070/ui";
const origin = new URL(url).origin.replace("ws:", "http:").replace("wss:", "https:");

const fail = (msg) => { throw new Error(msg); };
const expect = (cond, label, detail = "") => {
  if (!cond) fail(`${label} : ${detail}`);
  console.log(`OK ${label}${detail ? ` (${detail})` : ""}`);
};

const pw = await getPlaywright();
const browser = await pw.chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await context.newPage();

const ws = new WebSocket(url, { origin });
const inbox = [];
ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
await new Promise((resolve) => ws.once("open", resolve));

const createdTerminals = [];
const sandbox = process.env.VERIFY_SANDBOX || "/tmp";

async function waitForLaunchStarted(ref, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const idx = inbox.findIndex((m) => m.type === "launch.started" && m.ref === ref && m.kind === "terminal");
    if (idx >= 0) return inbox.splice(idx, 1)[0];
    await delay(100);
  }
  fail(`launch.started non reçu pour ref=${ref}`);
}

async function launchTerminal(ref, { tool, large } = {}) {
  ws.send(JSON.stringify({
    type: "launch.start", host: "local", cwd: sandbox, kind: "terminal", ref,
    ...(tool ? { tool } : {}),
  }));
  const started = await waitForLaunchStarted(ref);
  await page.evaluate(({ host, tid, cwd, large }) => {
    window.__openTerminalWindow(host, tid, { cwd, large });
  }, { host: started.host, tid: started.terminalId, cwd: started.cwd, large });
  return started;
}

async function getSttySize(host, terminalId) {
  // Envoie stty size et lit les dernières lignes de sortie
  const marker = `SZ_${Date.now().toString(36)}`;
  const cmd = `stty size\r`;
  ws.send(JSON.stringify({ type: "term.input", host, terminalId, data: cmd }));
  await delay(1200);

  const res = await page.evaluate(({ host, terminalId }) => {
    const key = `${host}\u0000${terminalId}`;
    const item = window.__terms?.get(key);
    if (!item) return null;
    const term = item.terminal;
    const lines = [];
    const buf = term.buffer.active;
    for (let i = 0; i < buf.length; i++) {
      const l = buf.getLine(i);
      if (l) lines.push(l.translateToString(true).trim());
    }
    return {
      text: lines.filter(Boolean).slice(-10).join("\n"),
      xtermRows: term.rows,
      xtermCols: term.cols,
    };
  }, { host, terminalId });

  if (!res) return null;
  const matches = [...res.text.matchAll(/\b(\d+)\s+(\d+)\b/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const r = parseInt(matches[i][1], 10);
    const c = parseInt(matches[i][2], 10);
    if (r > 5 && r < 500 && c > 20 && c < 500) {
      return { rows: r, cols: c, xtermRows: res.xtermRows, xtermCols: res.xtermCols, raw: `${r} ${c}` };
    }
  }
  return { rows: 0, cols: 0, xtermRows: res.xtermRows, xtermCols: res.xtermCols, raw: res.text };
}

try {
  console.log("--- 1. Ouverture du Bureau dans le navigateur ---");
  await page.goto((url.replace("ws:", "http:").replace(/\/ui$/, "")) + "/#bureau", { waitUntil: "networkidle" });
  await page.waitForSelector(".desk", { timeout: 10000 });
  await page.evaluate(() => {
    const list = window.__getWindows ? window.__getWindows() : [];
    list.length = 0;
    if (window.__changed) window.__changed("clean");
  });
  await delay(1000);

  console.log("--- 2. Ouverture d'une fenêtre de terminal classique ---");
  const initial = await launchTerminal("ts-initial");
  await page.waitForSelector(".win.win-terminal", { timeout: 10000 });
  await page.waitForFunction(() => (window.__terms?.size || 0) > 0, { timeout: 10000 });
  await delay(1500); // Laisse au shell le temps d'afficher son invite

  const termInfo = await page.evaluate(() => {
    const list = [...(window.__terms?.values() || [])];
    const t = list[list.length - 1];
    return { host: t.host, terminalId: t.terminalId, rows: t.rows, cols: t.cols };
  });
  createdTerminals.push({ host: termInfo.host, terminalId: termInfo.terminalId });
  console.log("Terminal initial xterm :", `${termInfo.cols} cols × ${termInfo.rows} rows`);

  const s1 = await getSttySize(termInfo.host, termInfo.terminalId);
  console.log("Sortie brute stty size (initial) :", s1.raw);
  expect(s1.rows === termInfo.rows && s1.cols === termInfo.cols,
    "stty size initial correspond à xterm", `stty=${s1.rows}x${s1.cols}, xterm=${termInfo.rows}x${termInfo.cols}`);

  console.log("--- 3. Redimensionnement de la fenêtre (+240px largeur, +120px hauteur) ---");
  await page.evaluate(({ tid }) => {
    const win = window.__getWindows().find((w) => w.terminalId === tid);
    if (win) {
      win.w += 240;
      win.h += 120;
      window.__changed("resize");
    }
  }, { tid: termInfo.terminalId });
  await delay(800); // debounce + fit

  const termResized = await page.evaluate(({ host, tid }) => {
    const t = window.__terms?.get(`${host}\0${tid}`);
    return { rows: t?.rows || 0, cols: t?.cols || 0 };
  }, { host: termInfo.host, tid: termInfo.terminalId });
  console.log("Terminal redimensionné xterm :", `${termResized.cols} cols × ${termResized.rows} rows`);
  expect(termResized.cols > termInfo.cols && termResized.rows > termInfo.rows,
    "xterm s'est agrandi après changement de taille de la fenêtre",
    `${termInfo.cols}x${termInfo.rows} → ${termResized.cols}x${termResized.rows}`);

  const s2 = await getSttySize(termInfo.host, termInfo.terminalId);
  console.log("Sortie brute stty size (redimensionné) :", s2.raw);
  expect(s2.rows === termResized.rows && s2.cols === termResized.cols,
    "stty size redimensionné correspond à xterm",
    `stty=${s2.rows}x${s2.cols}, xterm=${termResized.rows}x${termResized.cols}`);

  console.log("--- 4. Agrandissement plein écran (maximiser) ---");
  await page.locator(`.win-terminal button.win-max`).first().dispatchEvent("click");
  await delay(800);

  const termMax = await page.evaluate(({ host, tid }) => {
    const t = window.__terms?.get(`${host}\0${tid}`);
    return { rows: t?.rows || 0, cols: t?.cols || 0 };
  }, { host: termInfo.host, tid: termInfo.terminalId });
  console.log("Terminal maximisé xterm :", `${termMax.cols} cols × ${termMax.rows} rows`);
  const s3 = await getSttySize(termInfo.host, termInfo.terminalId);
  console.log("Sortie brute stty size (maximisé) :", s3.raw);
  expect(s3.rows === termMax.rows && s3.cols === termMax.cols,
    "stty size maximisé correspond à xterm", `stty=${s3.rows}x${s3.cols}, xterm=${termMax.rows}x${termMax.cols}`);

  console.log("--- 5. Restauration de la taille normale ---");
  await page.locator(`.win-terminal button.win-max`).first().dispatchEvent("click");
  await delay(800);

  const termRestored = await page.evaluate(({ host, tid }) => {
    const t = window.__terms?.get(`${host}\0${tid}`);
    return { rows: t?.rows || 0, cols: t?.cols || 0 };
  }, { host: termInfo.host, tid: termInfo.terminalId });
  console.log("Terminal restauré xterm :", `${termRestored.cols} cols × ${termRestored.rows} rows`);
  const s4 = await getSttySize(termInfo.host, termInfo.terminalId);
  console.log("Sortie brute stty size (restauré) :", s4.raw);
  expect(s4.rows === termRestored.rows && s4.cols === termRestored.cols,
    "stty size restauré correspond à xterm",
    `stty=${s4.rows}x${s4.cols}, xterm=${termRestored.rows}x${termRestored.cols}`);

  console.log("--- 6. Bouton « Ajuster la taille » dans la barre de titre ---");
  const fitBtn = page.locator(".win-terminal .win-fit");
  expect(await fitBtn.count() > 0, "Bouton Ajuster la taille présent dans la barre de titre");
  await fitBtn.dispatchEvent("click");
  await delay(400);
  console.log("Bouton Ajuster la taille cliqué sans erreur.");

  console.log("--- 7. Traçage d'un cadre sur toute la largeur (capture PNG) ---");
  const frameCmd = `printf '\\n'; w=$(tput cols); printf '#%.0s' $(seq 1 $w); printf '\\n#'; printf ' %.0s' $(seq 1 $((w - 2))); printf '#\\n'; printf '#%.0s' $(seq 1 $w); printf '\\n'\r`;
  ws.send(JSON.stringify({ type: "term.input", host: termInfo.host, terminalId: termInfo.terminalId, data: frameCmd }));
  await delay(1200);

  const shotPath = join(screenshotsDir, "terminal-fit-powershell.png");
  await page.screenshot({ path: shotPath });
  console.log(`Capture enregistrée : ${shotPath}`);

  console.log("--- 8. Ouverture par défaut plus grande pour le widget FreeBuff (min 100 x 30) ---");
  const fb = await launchTerminal("ts-freebuff", { tool: "freebuff", large: true });
  await page.waitForFunction(() => (window.__terms?.size || 0) >= 2, { timeout: 10000 });
  await delay(1200);

  const termsList = await page.evaluate(() => {
    return [...window.__terms.values()].map((t) => ({
      host: t.host,
      terminalId: t.terminalId,
      cols: t.cols,
      rows: t.rows,
    }));
  });
  const fbTerm = termsList[termsList.length - 1];
  createdTerminals.push({ host: fbTerm.host, terminalId: fbTerm.terminalId });
  console.log("Terminal FreeBuff ouvert :", `${fbTerm.cols} cols × ${fbTerm.rows} rows`);
  expect(fbTerm.cols >= 100, "FreeBuff ouvert avec au moins 100 colonnes", `${fbTerm.cols} cols`);
  expect(fbTerm.rows >= 30, "FreeBuff ouvert avec au moins 30 lignes", `${fbTerm.rows} rows`);

  const shotFbPath = join(screenshotsDir, "terminal-fit-freebuff.png");
  await page.screenshot({ path: shotFbPath });
  console.log(`Capture FreeBuff enregistrée : ${shotFbPath}`);

  console.log("\n==========================================");
  console.log("SORTIES BRUTES stty size :", [s1.raw, s2.raw, s3.raw, s4.raw].join(" -> "));
  console.log("VERIFY_TERMINAL_SIZE_PASS");
  console.log("==========================================\n");
} finally {
  for (const t of createdTerminals) {
    ws.send(JSON.stringify({ type: "term.kill", host: t.host, terminalId: t.terminalId }));
  }
  await delay(500);
  ws.close();
  await context.close();
  await browser.close();
}
