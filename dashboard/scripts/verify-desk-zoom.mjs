// dashboard/scripts/verify-desk-zoom.mjs
// Vérification navigateur (Playwright, fenêtré par défaut) du ticket T30 : bureau infini (zoom + déplacement).
// Usage : T30_URL=http://127.0.0.1:7171 node dashboard/scripts/verify-desk-zoom.mjs [desk|mobile|all]
// T30_URL est OBLIGATOIRE et doit pointer vers une instance de test (autre port, dossier de données temporaire) :
// le script écrit des fenêtres factices dans la mise en page automatique du serveur visé, jamais sur le :7070 de Philippe.
// Mode desk : boutons −/+/100 %, Ctrl+molette, glisser le fond vide (toutes directions, sans limite), glisser une fenêtre
//   à 50 % (distance exacte), redimensionner à 50 %, le fond/contenu des fenêtres ne déclenche pas le déplacement,
//   « Ranger en grille » (100 % + fenêtres visibles), « Tout voir », rechargement (zoom/position restaurés).
// Mode mobile : 390 px, aucun défilement horizontal de la page, commandes de zoom masquées.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const base = process.env.T30_URL;
if (!base) {
  console.error("T30_URL manquant : indiquez l'URL d'une instance de test (ex. http://127.0.0.1:7171), jamais le :7070.");
  process.exit(2);
}
if (/:7070(\/|$)/.test(base)) {
  console.error("Refus : ce script écrit dans la mise en page du serveur visé ; n'utilisez pas le :7070 de Philippe.");
  process.exit(2);
}
const mode = process.argv[2] || "all";
const here = fileURLToPath(new URL(".", import.meta.url));
const shots = join(here, "..", "..", ".foreman", "scratch");
mkdirSync(shots, { recursive: true });
const shot = (name) => join(shots, `t30-${name}`);

let checks = 0;
function expect(cond, label, detail = "") {
  checks++;
  if (!cond) {
    console.error(`\x1b[31mFAIL: ${label} ${detail}\x1b[0m`);
    throw new Error(`${label} ${detail}`);
  }
  console.log(`OK ${label}${detail ? ` (${detail})` : ""}`);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

async function getPlaywright() {
  for (const p of [
    "playwright-core",
    "file:///C:/Users/Philippe/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core/index.mjs",
  ]) {
    try {
      const mod = await import(p);
      return mod.default || mod;
    } catch { /* suivant */ }
  }
  throw new Error("playwright-core introuvable");
}

const pw = await getPlaywright();
const headless = process.env.T30_HEADLESS === "1" || process.env.VERIFY_HEADLESS === "1";
let browser;
try {
  browser = await pw.chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined, headless });
} catch {
  browser = await pw.chromium.launch({ headless });
}

// Fenêtres factices (terminaux « fermés » : aucun processus réel n'est créé ni touché).
async function seedWindows(page) {
  await page.evaluate(() => {
    const list = window.__getWindows();
    list.length = 0;
    const mk = (id, x, y) => ({ id, type: "terminal", host: "local", terminalId: `fake-${id}`, cwd: "D:/Projets/AI-OS/paseo-poste/sandbox-repo",
      x, y, w: 360, h: 240, z: 10 + list.length, minimized: false, maximized: false });
    list.push(mk("t30-a", 40, 40), mk("t30-b", 460, 60), mk("t30-c", 200, 360));
    window.__changed("add");
  });
  await page.waitForFunction(() => document.querySelectorAll(".win").length === 3);
}

const rectOf = (page, sel) => page.evaluate((s) => {
  const r = document.querySelector(s).getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom };
}, sel);
const winRect = (page, id) => page.evaluate((i) => {
  const idx = { "t30-a": 0, "t30-b": 1, "t30-c": 2 }[i]; // ids régénérés au rechargement : l'ordre fait foi
  const r = document.querySelectorAll(".win")[idx].getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom };
}, id);
const pct = async (page) => parseInt((await page.locator(".desk-zoom-pct").textContent()).replace(/\D/g, ""), 10);
const view = (page) => page.evaluate(() => ({ ...window.__getDeskView() }));

// Point du fond vide (ni fenêtre ni barre d'outils) de la surface.
async function emptyPoint(page) {
  return page.evaluate(() => {
    const surface = document.querySelector(".desk-surface");
    const rect = surface.getBoundingClientRect();
    const ok = (x, y) => { const t = document.elementFromPoint(x, y); return t === surface || t?.classList.contains("desk-world"); };
    for (let y = rect.bottom - 20; y > rect.top + 20; y -= 25) {
      for (let x = rect.right - 20; x > rect.left + 20; x -= 25) if (ok(x, y)) return { x, y };
    }
    return null;
  });
}

async function drag(page, from, dx, dy, steps = 8) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps });
  await page.mouse.up();
}

async function runDesk() {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  // Le test pose des fenêtres factices (sessions qui n'existent pas) : le rangement automatique du Bureau les retirerait.
  await context.addInitScript(() => localStorage.setItem("desk.autoTidy", "0"));
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.goto(`${base}/#bureau`, { waitUntil: "networkidle" });
  await delay(1200);
  await seedWindows(page);
  await delay(500);

  // ---- Zoom : boutons + pourcentage ----
  console.log("\n--- Zoom : − / + / 100 % ---");
  expect(await pct(page) === 100, "pourcentage initial 100 %");
  const w0 = (await winRect(page, "t30-a")).w;
  await page.locator(".desk-zoom-in").click();
  const afterIn = await pct(page);
  expect(afterIn > 100, "« + » augmente le pourcentage", `${afterIn} %`);
  const wIn = (await winRect(page, "t30-a")).w;
  expect(near(wIn / w0, afterIn / 100, 0.01), "« + » agrandit réellement la fenêtre à l'échelle affichée", `${wIn.toFixed(1)}/${w0.toFixed(1)}`);
  await page.locator(".desk-zoom-reset").click();
  expect(await pct(page) === 100, "bouton « 100 % » rétablit 100 %");
  expect(near((await winRect(page, "t30-a")).w, w0, 0.6), "à 100 % la fenêtre retrouve sa taille d'origine");
  await page.locator(".desk-zoom-out").click();
  const afterOut = await pct(page);
  expect(afterOut < 100, "« − » diminue le pourcentage", `${afterOut} %`);
  expect(near((await winRect(page, "t30-a")).w / w0, afterOut / 100, 0.01), "« − » réduit réellement la fenêtre à l'échelle affichée");
  for (let i = 0; i < 20; i++) if (!(await page.locator(".desk-zoom-out").isDisabled())) await page.locator(".desk-zoom-out").click();
  expect(await pct(page) === 25, "zoom minimum 25 %");
  expect(await page.locator(".desk-zoom-out").isDisabled(), "« − » désactivé à 25 %");
  await page.locator(".desk-zoom-reset").click();
  for (let i = 0; i < 20; i++) if (!(await page.locator(".desk-zoom-in").isDisabled())) await page.locator(".desk-zoom-in").click();
  expect(await pct(page) === 200, "zoom maximum 200 %");
  expect(await page.locator(".desk-zoom-in").isDisabled(), "« + » désactivé à 200 %");
  await page.locator(".desk-zoom-reset").click();
  expect(await pct(page) === 100, "retour à 100 %");

  // ---- Ctrl + molette ----
  console.log("\n--- Ctrl + molette ---");
  const pt = await emptyPoint(page);
  expect(Boolean(pt), "point de fond vide trouvé", JSON.stringify(pt));
  await page.mouse.move(pt.x, pt.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -300);
  await page.keyboard.up("Control");
  await delay(150);
  const wheelUp = await pct(page);
  expect(wheelUp > 100, "Ctrl + molette vers le haut zoome", `${wheelUp} %`);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 900);
  await page.keyboard.up("Control");
  await delay(150);
  const wheelDown = await pct(page);
  expect(wheelDown < wheelUp, "Ctrl + molette vers le bas dézoome", `${wheelDown} %`);
  await page.locator(".desk-zoom-reset").click();

  // ---- Panoramique sur le fond vide ----
  console.log("\n--- Panoramique : glisser le fond vide ---");
  await page.screenshot({ path: shot("1-desk-100.png") });
  const before = await winRect(page, "t30-a");
  const beforeC = await winRect(page, "t30-c");
  const p1 = await emptyPoint(page);
  await drag(page, p1, -137, -83);
  const after = await winRect(page, "t30-a");
  const afterC = await winRect(page, "t30-c");
  expect(near(after.x - before.x, -137, 1) && near(after.y - before.y, -83, 1), "glisser le fond déplace une fenêtre de la distance exacte",
    `dx=${(after.x - before.x).toFixed(1)} dy=${(after.y - before.y).toFixed(1)}`);
  expect(near(afterC.x - beforeC.x, -137, 1) && near(afterC.y - beforeC.y, -83, 1), "toutes les fenêtres se déplacent ensemble");
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector(".desk-surface")).backgroundPosition);
  const vNow = await view(page);
  const [bgx, bgy] = bg.split(" ").map(parseFloat);
  expect(near(bgx, vNow.x, 0.5) && near(bgy, vNow.y, 0.5), "la grille de fond suit le déplacement", bg);
  const cursor = await page.evaluate(() => getComputedStyle(document.querySelector(".desk-surface")).cursor);
  expect(cursor === "grab", "curseur « grab » sur le fond", cursor);
  // Toutes directions, sans limite : +3000 px à droite/bas puis -4000 px à gauche/haut (par pas pour rester dans l'écran).
  const startView = await view(page);
  for (let i = 0; i < 6; i++) {
    const pp = await emptyPoint(page);
    await drag(page, pp, 500, 380, 4);
  }
  const far = await view(page);
  expect(far.x - startView.x >= 2900 && far.y - startView.y >= 2200, "déplacement sans limite vers la droite et le bas", `x+${(far.x - startView.x).toFixed(0)} y+${(far.y - startView.y).toFixed(0)}`);
  for (let i = 0; i < 30; i++) {
    const pp = await emptyPoint(page);
    if (!pp) break;
    await drag(page, pp, -300, -240, 4);
  }
  const farNeg = await view(page);
  expect(farNeg.x < startView.x - 800 && farNeg.y < startView.y - 800, "déplacement sans limite vers la gauche et le haut", `x=${farNeg.x.toFixed(0)} y=${farNeg.y.toFixed(0)}`);
  const surfAway = await rectOf(page, ".desk-surface");
  const awayA = await winRect(page, "t30-a");
  expect(awayA.r < surfAway.x || awayA.b < surfAway.y, "les fenêtres sont bien parties hors de la surface visible (vue vraiment infinie)");
  await page.screenshot({ path: shot("2-desk-panned-away.png") });
  // Molette seule sur le fond : déplacement
  const pw1 = await emptyPoint(page);
  const vWheel0 = await view(page);
  await page.mouse.move(pw1.x, pw1.y);
  await page.mouse.wheel(0, 120);
  await delay(150);
  const vWheel1 = await view(page);
  expect(near(vWheel1.y - vWheel0.y, -120, 1), "molette seule sur le fond déplace la vue", `dy=${vWheel1.y - vWheel0.y}`);

  // « Tout voir »
  console.log("\n--- Tout voir ---");
  await page.locator(".desk-zoom-all").click();
  const surf = await rectOf(page, ".desk-surface");
  for (const id of ["t30-a", "t30-b", "t30-c"]) {
    const r = await winRect(page, id);
    expect(r.x >= surf.x - 1 && r.y >= surf.y - 1 && r.r <= surf.r + 1 && r.b <= surf.b + 1, `« Tout voir » : fenêtre ${id} entièrement visible`);
  }
  await page.screenshot({ path: shot("3-desk-fit-all.png") });

  // ---- Fenêtres : le fond ne doit pas se déclencher en glissant une fenêtre / son contenu ----
  console.log("\n--- Glisser une fenêtre ne déplace pas la vue ---");
  await page.locator(".desk-zoom-reset").click();
  await page.evaluate(() => { const w = window.__getWindows(); w[0].x = 40; w[0].y = 40; w[1].x = 460; w[1].y = 60; w[2].x = 200; w[2].y = 360; window.__changed("move"); });
  await delay(300);
  const v100 = await view(page);
  const barA = await page.evaluate(() => { const r = document.querySelectorAll(".win-bar")[0].getBoundingClientRect(); return { x: r.x + 120, y: r.y + 18 }; });
  const winA0 = await winRect(page, "t30-a");
  await drag(page, barA, 64, 40);
  const winA1 = await winRect(page, "t30-a");
  expect(near(winA1.x - winA0.x, 64, 8) && near(winA1.y - winA0.y, 40, 8), "100 % : glisser la barre de titre déplace la fenêtre", `dx=${(winA1.x - winA0.x).toFixed(1)} dy=${(winA1.y - winA0.y).toFixed(1)}`);
  const vAfterBar = await view(page);
  expect(vAfterBar.x === v100.x && vAfterBar.y === v100.y, "glisser une fenêtre ne déplace pas la vue");
  const bodyPt = await page.evaluate(() => { const r = document.querySelectorAll(".win-body")[1].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const winB0 = await winRect(page, "t30-b");
  await drag(page, bodyPt, 90, 70);
  const winB1 = await winRect(page, "t30-b");
  const vAfterBody = await view(page);
  expect(vAfterBody.x === v100.x && vAfterBody.y === v100.y && near(winB1.x, winB0.x, 0.5) && near(winB1.y, winB0.y, 0.5),
    "glisser le contenu d'une fenêtre ne déplace ni la vue ni la fenêtre");
  await page.mouse.move(bodyPt.x, bodyPt.y);
  await page.mouse.wheel(0, 200);
  await delay(150);
  const vAfterWinWheel = await view(page);
  expect(vAfterWinWheel.x === v100.x && vAfterWinWheel.y === v100.y, "molette sur une fenêtre : la vue ne bouge pas (le contenu garde son défilement)");

  // ---- Précision à 50 % ----
  console.log("\n--- Précision du glisser / redimensionner à 50 % ---");
  await page.locator(".desk-zoom-reset").click();
  await page.locator(".desk-zoom-out").click(); // 90
  while ((await pct(page)) > 50) await page.locator(".desk-zoom-out").click();
  expect(await pct(page) === 50, "zoom à 50 %");
  const bar50 = await page.evaluate(() => { const r = document.querySelectorAll(".win-bar")[2].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const c0 = await winRect(page, "t30-c");
  const worldBefore = await page.evaluate(() => ({ x: window.__getWindows()[2].x, y: window.__getWindows()[2].y }));
  await drag(page, bar50, 100, 60);
  const c1 = await winRect(page, "t30-c");
  const worldAfter = await page.evaluate(() => ({ x: window.__getWindows()[2].x, y: window.__getWindows()[2].y }));
  expect(near(c1.x - c0.x, 100, 5) && near(c1.y - c0.y, 60, 5), "50 % : glisser de 100 × 60 px écran déplace de 100 × 60 px écran", `dx=${(c1.x - c0.x).toFixed(1)} dy=${(c1.y - c0.y).toFixed(1)}`);
  expect(near(worldAfter.x - worldBefore.x, 200, 8) && near(worldAfter.y - worldBefore.y, 120, 8), "50 % : coordonnées de la fenêtre corrigées du zoom (×2)", `Δmonde=${worldAfter.x - worldBefore.x}/${worldAfter.y - worldBefore.y}`);
  const handle = await page.evaluate(() => { const r = document.querySelectorAll(".win")[2].querySelector(".h-se").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const c2 = await winRect(page, "t30-c");
  await drag(page, handle, 60, 40);
  const c3 = await winRect(page, "t30-c");
  expect(near(c3.w - c2.w, 60, 6) && near(c3.h - c2.h, 40, 6), "50 % : redimensionner de 60 × 40 px écran agrandit de 60 × 40 px écran", `dw=${(c3.w - c2.w).toFixed(1)} dh=${(c3.h - c2.h).toFixed(1)}`);
  await page.screenshot({ path: shot("4-desk-50-drag.png") });

  // Agrandir à 50 % : remplit la zone visible
  await page.evaluate(() => { window.__getWindows()[0].maximized = true; window.__changed("maximize"); });
  await delay(400);
  const surf50 = await rectOf(page, ".desk-surface");
  const max50 = await winRect(page, "t30-a");
  expect(near(max50.x, surf50.x, 2) && near(max50.y, surf50.y, 2) && near(max50.w, surf50.w, 3) && near(max50.h, surf50.h, 3),
    "fenêtre agrandie à 50 % : remplit exactement la surface visible");
  await page.evaluate(() => { window.__getWindows()[0].maximized = false; window.__changed("maximize"); });

  // ---- Conservation après rechargement ----
  console.log("\n--- Rechargement : zoom + position restaurés ---");
  await page.locator(".desk-zoom-reset").click();
  await page.locator(".desk-zoom-in").click();
  await page.locator(".desk-zoom-out").click();
  await page.locator(".desk-zoom-out").click();
  const pp2 = await emptyPoint(page);
  await drag(page, pp2, -210, 130);
  await delay(600);
  const saved = await view(page);
  const savedPct = await pct(page);
  await page.reload({ waitUntil: "networkidle" });
  await delay(1500);
  const restored = await view(page);
  expect(restored.z === saved.z && near(restored.x, saved.x, 0.5) && near(restored.y, saved.y, 0.5), "zoom et position identiques après rechargement",
    `${JSON.stringify(saved)} -> ${JSON.stringify(restored)}`);
  expect(await pct(page) === savedPct, "pourcentage affiché identique après rechargement", `${savedPct} %`);
  const transform = await page.evaluate(() => document.querySelector(".desk-world").style.transform);
  expect(transform.includes(`scale(${saved.z})`), "transformation appliquée au rechargement", transform);
  await page.screenshot({ path: shot("5-desk-after-reload.png") });

  // ---- Ranger en grille ----
  console.log("\n--- Ranger en grille ---");
  await page.evaluate(() => { const w = window.__getWindows(); w[0].x = -3000; w[1].y = 5200; w[2].x = 9000; window.__changed("move"); });
  for (let i = 0; i < 3; i++) await page.locator(".desk-zoom-out").click();
  const pg = await emptyPoint(page);
  await drag(page, pg, 300, -200, 4);
  const messy = await view(page);
  expect(messy.z !== 1 || messy.x !== 0 || messy.y !== 0, "avant rangement : vue décalée et dézoomée", JSON.stringify(messy));
  await page.getByRole("button", { name: "Ranger en grille" }).click();
  await delay(500);
  const vg = await view(page);
  expect(vg.z === 1 && vg.x === 0 && vg.y === 0, "Ranger en grille : zoom 100 % et origine sur la grille", JSON.stringify(vg));
  expect(await pct(page) === 100, "Ranger en grille : pourcentage 100 %");
  const surfG = await rectOf(page, ".desk-surface");
  for (const id of ["t30-a", "t30-b", "t30-c"]) {
    const r = await winRect(page, id);
    expect(r.x >= surfG.x - 1 && r.y >= surfG.y - 1 && r.r <= surfG.r + 1 && r.b <= surfG.b + 1, `Ranger en grille : fenêtre ${id} visible dans la vue`);
  }
  await page.screenshot({ path: shot("6-desk-arranged.png") });
  await page.getByRole("button", { name: "Grouper par machine" }).click();
  await delay(300);
  const vgm = await view(page);
  expect(vgm.z === 1 && vgm.x === 0 && vgm.y === 0, "Grouper par machine : vue recadrée à 100 % / origine");

  // ---- Fenêtres et titres ----
  const titles = await page.evaluate(() => [...document.querySelectorAll(".win-title")].map((t) => t.textContent));
  expect(titles.every((t) => !/\blocal\b|terminal\s*\d/i.test(t)), "titres de fenêtres sans « local » ni « terminal N »", titles.join(" | "));
  expect(titles[0] === "Terminal · sandbox-repo · Mini PC" && titles[1] === "Terminal · sandbox-repo · Mini PC (2)"
    && titles[2] === "Terminal · sandbox-repo · Mini PC (3)", "doublons numérotés dans le Bureau", titles.join(" | "));

  await page.evaluate(() => { window.__getWindows().length = 0; window.__changed("remove"); }); // ne laisse pas les fenêtres factices dans la mise en page
  await delay(700);
  await context.close();
}

async function runMobile() {
  console.log("\n--- Mobile 390 px ---");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  // Le test pose des fenêtres factices (sessions qui n'existent pas) : le rangement automatique du Bureau les retirerait.
  await context.addInitScript(() => localStorage.setItem("desk.autoTidy", "0"));
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.goto(`${base}/#bureau`, { waitUntil: "networkidle" });
  await delay(1200);
  await seedWindows(page);
  await delay(600);
  const dims = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(dims.sw <= dims.cw, "mobile 390 px : pas de défilement horizontal de la page", `scrollWidth=${dims.sw} clientWidth=${dims.cw}`);
  const zoomHidden = await page.evaluate(() => getComputedStyle(document.querySelector(".desk-zoom")).display === "none");
  expect(zoomHidden, "mobile : commandes de zoom masquées (fenêtres empilées)");
  const stacked = await page.evaluate(() => [...document.querySelectorAll(".win")].every((w) => getComputedStyle(w).position === "relative"));
  expect(stacked, "mobile : fenêtres empilées dans le flux (non transformées)");
  const overflow = await page.evaluate(() => [...document.querySelectorAll(".win")].every((w) => w.getBoundingClientRect().right <= document.documentElement.clientWidth + 1));
  expect(overflow, "mobile : aucune fenêtre ne déborde à droite");
  await page.screenshot({ path: shot("7-mobile-390.png"), fullPage: false });
  await page.evaluate(() => { window.__getWindows().length = 0; window.__changed("remove"); }); // ne laisse pas les fenêtres factices dans la mise en page
  await delay(700);
  await context.close();
}

try {
  if (mode === "desk" || mode === "all") await runDesk();
  if (mode === "mobile" || mode === "all") await runMobile();
  console.log(`\n\x1b[32mT30 ${mode.toUpperCase()} VERIFY PASSED (${checks} checks)\x1b[0m`);
} finally {
  await browser.close().catch(() => {});
}
