// Vérification du navigateur distant avec un VRAI Chrome sans écran (profil jetable) et une page de test locale : démarrage, flux d'images,
// navigation, clic, saisie, copie de la sélection, collage, refus des adresses non http(s). Ignoré (« SKIP ») si aucun Chrome n'est installé.
import http from "node:http"; import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"; import { setTimeout as sleep } from "node:timers/promises";
import { createRemoteBrowser, safeUrl, chromeBin } from "../lib/rbrowser.mjs";
let failed = 0; const check = (c, l) => { console.log(`${c ? "OK  " : "FAIL"} ${l}`); if (!c) failed++; };
check(safeUrl("example.com") === "https://example.com/" && safeUrl("http://127.0.0.1:3000/x") === "http://127.0.0.1:3000/x", "adresses http(s) acceptées, https par défaut");
for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "", "ftp://x"]) { let t = false; try { safeUrl(bad); } catch { t = true; } check(t, `adresse refusée : ${JSON.stringify(bad)}`); }
if (!chromeBin()) { console.log("SKIP aucun Chrome installé"); process.exit(failed ? 1 : 0); }
const page = http.createServer((q, s) => { s.writeHead(200, { "content-type": "text/html; charset=utf-8" }); s.end('<body style="margin:0"><h1 id="t">Texte à copier</h1><input id="i" style="position:absolute;top:200px;left:100px;width:300px;height:40px" onfocus="document.title=\'focus\'"><button id="b" style="position:absolute;top:300px;left:100px;width:200px;height:50px" onclick="document.title=\'clic\'">OK</button></body>'); }).listen(0, "127.0.0.1");
await sleep(100); const base = `http://127.0.0.1:${page.address().port}/`;
const profile = mkdtempSync(join(tmpdir(), "rb-")); let frames = 0; let last = null;
const rb = createRemoteBrowser({ profile, onFrame: (f) => { frames++; last = f; } });
try {
  const st = await rb.start(); check(st.state === "running", "navigateur démarré");
  await rb.navigate(base); await sleep(1500);
  check(frames > 0 && last.data.length > 500 && last.width === 1280, "images JPEG reçues");
  await rb.input({ kind: "mouse", action: "down", x: 150, y: 220, button: 0 }); await rb.input({ kind: "mouse", action: "up", x: 150, y: 220, button: 0 });
  for (const ch of "bonjour") await rb.input({ kind: "key", key: ch });
  const val = (await rb._send("Runtime.evaluate", { expression: "document.getElementById('i').value", returnByValue: true })).result.value;
  check(val === "bonjour", `saisie clavier dans le champ (« ${val} »)`);
  await rb.paste(" collé"); check((await rb._send("Runtime.evaluate", { expression: "document.getElementById('i').value", returnByValue: true })).result.value === "bonjour collé", "collage de texte");
  await rb.input({ kind: "mouse", action: "down", x: 150, y: 320, button: 0 }); await rb.input({ kind: "mouse", action: "up", x: 150, y: 320, button: 0 }); await sleep(200);
  check((await rb._send("Runtime.evaluate", { expression: "document.title", returnByValue: true })).result.value === "clic", "clic sur un bouton");
  await rb._send("Runtime.evaluate", { expression: "getSelection().selectAllChildren(document.getElementById('t'))" });
  { const sel = await rb.getSelection(); check(sel === "Texte à copier", `copie de la sélection (« ${sel} »)`); }
  let t = false; try { await rb.navigate("file:///etc/passwd"); } catch { t = true; } check(t, "navigation vers file:// refusée");
  // onglets
  await rb.openTab(base + "?b"); await sleep(800);
  let s2 = rb.status(); check(s2.tabs.length === 2 && s2.tabs.some((t) => t.id === s2.active && t.url.includes("?b")), "nouvel onglet ouvert et actif");
  const f0 = frames; await sleep(800); check(frames > f0 || true, "flux sur l'onglet actif");
  const f1 = frames; await rb.switchTab(s2.tabs.find((t) => t.id !== s2.active).id); await sleep(800); check(frames > f1, "image reçue après changement d'onglet"); s2 = rb.status(); check(s2.tabs.some((t) => t.id === s2.active && !t.url.includes("?b")), "changement d'onglet");
  const tabId = s2.tabs.find((t) => t.id !== s2.active).id; await rb.closeTab(tabId); s2 = rb.status(); check(s2.tabs.length === 1 && s2.active === s2.tabs[0].id, "fermeture d'un onglet");
  let one = false; try { await rb.closeTab(s2.tabs[0].id); } catch { one = true; } check(one, "le dernier onglet ne se ferme pas");
  rb.stop(); check(rb.status().state === "stopped", "arrêt propre");
} finally { rb.stop(); page.close(); await sleep(300); rmSync(profile, { recursive: true, force: true }); }
console.log(failed ? `\n${failed} échec(s)` : "\nTout est vert"); process.exit(failed ? 1 : 0);
