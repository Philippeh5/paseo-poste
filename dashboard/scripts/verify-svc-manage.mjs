// Vérification de la gestion des services (ajout, rangement, retrait, détectés) sur un dossier de données JETABLE.
// En processus : aucun écrit dans le vrai services.json, aucun processus lancé.
import http from "node:http";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../lib/store.mjs";
import { addService, removeService, setGroup, detect, suggestGroup, slugId } from "../lib/svc-manage.mjs";
import { register } from "../handlers/services.mjs";
let failed = 0; const check = (c, l) => { console.log(`${c ? "OK  " : "FAIL"} ${l}`); if (!c) failed++; };

// --- Fonctions pures ---
const base = [{ id: "tunnel", group: "BlastWin", name: "Tunnel", warn: "UN SEUL TUNNEL", match: ["cloudflared"], modes: [{ id: "run", label: "Lancer", cmd: "x" }], extra: { a: 1 } },
  { id: "front", group: "BlastWin", name: "Site", port: 3100 }];
let r = addService(base, { name: "n8n", group: "Outils", port: 5678 });
check(r.services.length === 3 && r.entry.id === "n8n" && r.entry.port === 5678 && r.entry.group === "Outils", "ajout par port");
check(JSON.stringify(r.services[0]) === JSON.stringify(base[0]), "entrées existantes inchangées (champs inconnus, avertissements)");
for (const bad of [{}, { name: "x" }, { name: "x", port: 80 }, { name: "x", cmd: "ls" }, { name: "x", cmd: "ls", cwd: "relatif" }]) {
  let err = null; try { addService(base, bad); } catch (e) { err = e; }
  check(!!err, `refus : ${JSON.stringify(bad)}`);
}
r = addService(base, { name: "Site", port: 3200 });
check(r.entry.id === "site" && new Set(r.services.map((s) => s.id)).size === 3, "identifiant unique");
check(slugId("Été & Café", new Set()) === "ete-cafe", "slug sans accents");
r = addService(base, { name: "Mon serveur", cwd: "/tmp", cmd: "node s.js", group: "  " });
check(r.entry.group === "Divers" && r.entry.modes[0].cmd === "node s.js", "commande + groupe par défaut");
check(setGroup(base, "front", "Autre").services[1].group === "Autre" && setGroup(base, "front", "Autre").services[0] === base[0], "rangement : une seule entrée touchée");
check(removeService(base, "front").services.length === 1, "retrait");
check(suggestGroup("/home/u/Projets/BlastWin/x/y", [{ dir: "/home/u/Projets/BlastWin", name: "BlastWin" }], "/home/u/Projets") === "BlastWin", "groupe suggéré = projet suivi");
check(suggestGroup("/home/u/Projets/Autre/x", [], "/home/u/Projets") === "Autre" && suggestGroup(null) === "Divers", "groupe suggéré de repli");
const det = detect({ ports: [{ port: 3100, process: "node" }, { port: 5678, process: "n8n" }, { port: 8384, process: "syncthing" }, { port: 3299, process: "next-server" }, { port: 9999, process: "x" }],
  services: base, snapPorts: new Map([[5678, 11], [8384, 12], [3299, 13], [9999, 14]]), coveredPids: new Set([14]), ignored: [8384], info: (pid) => ({ cwd: pid === 13 ? "/home/u/Projets/BlastWin/web" : null }),
  projects: [{ dir: "/home/u/Projets/BlastWin", name: "BlastWin" }] });
check(JSON.stringify(det.map((d) => d.port)) === "[5678,3299]", "détectés : suivi, couvert par un service et ignoré écartés");
const det2 = detect({ ports: [{ port: 9222, process: "chrome" }, { port: 41231, process: "Paseo terminal" }, { port: 40000, process: "node" }, { port: 6379, process: "redis-server" }], services: [], snapPorts: new Map() });
check(JSON.stringify(det2.map((d) => [d.port, d.temp])) === '[[40000,true],[6379,false]]', "détectés : processus d'outils écartés, ports éphémères marqués");
check(det[1].suggestedGroup === "BlastWin", "détecté : groupe suggéré d'après le dossier du processus");

// --- Handler, dossier de données jetable ---
const dir = mkdtempSync(join(tmpdir(), "svc-manage-"));
const seed = JSON.parse(JSON.stringify(base));
writeFileSync(join(dir, "services.json"), JSON.stringify(seed));
const store = createStore(dir);
const handlers = new Map(); const sent = []; const errors = [];
const ctx = { onMessage: (t, fn) => handlers.set(t, fn), send: (_ws, m) => sent.push(m), broadcast: () => {}, sendError: (_ws, m) => errors.push(m), store, dataDir: dir, log: () => {}, safeError: (e) => String(e), onHttp: () => {} };
const stop = register(ctx);
const call = async (type, m) => { sent.length = 0; errors.length = 0; await handlers.get(type)({ _uiId: "ui:1" }, { ...m, ref: "r" }); return sent.find((x) => x.type === "svc.state"); };

// Petit serveur de test : doit apparaître dans « Détectés ».
const app = http.createServer((q, s) => s.end("ok")).listen(0, "127.0.0.1");
await new Promise((ok) => app.once("listening", ok));
const port = app.address().port;
let st = await call("svc.list", { force: true });
let d = st.detected.find((x) => x.port === port);
check(!!d, `serveur de test :${port} dans « Détectés »`);
check(d && d.process && d.cwd, "détecté : processus et dossier connus");
st = await call("svc.follow", { port, group: "Essais", name: "Serveur de test" });
check(!errors.length && st.services.some((s) => s.port === port && s.group === "Essais" && s.name === "Serveur de test"), `suivre : ajouté au groupe Essais ${errors.join(";")}`);
check(!st.detected.some((x) => x.port === port), "suivi : disparaît des détectés");
const onDisk = JSON.parse(readFileSync(join(dir, "services.json"), "utf8"));
check(onDisk.length >= 3 && JSON.stringify(onDisk[0]) === JSON.stringify(seed[0]) && onDisk[0].warn === "UN SEUL TUNNEL", "services.json : champs inconnus et avertissements préservés");
check(readdirSync(dir).some((f) => f.startsWith("services.json.bak-")), "sauvegarde horodatée créée");
check(!readdirSync(dir).some((f) => f.endsWith(".tmp")), "aucun fichier temporaire");
st = await call("svc.setGroup", { id: "front", group: "Site de test" });
check(st.services.find((s) => s.id === "front").group === "Site de test" && st.groups.includes("Site de test"), "rangement dans un autre groupe");
st = await call("svc.add", { name: "Cmd", cmd: "node a.js", cwd: "/tmp" });
check(errors.length === 1 && /confirm/.test(errors[0]), "commande sans confirmation refusée");
st = await call("svc.add", { name: "Cmd", cmd: "node a.js", cwd: "/tmp", confirm: true });
check(st.services.some((s) => s.name === "Cmd" && s.modes?.length === 1), `ajout avec commande confirmée ${errors.join(";")}`);
st = await call("svc.remove", { id: "cmd" });
check(!st.services.some((s) => s.id === "cmd"), "retrait");
// Message refusé en appel interne (agents) : jamais d'écriture.
sent.length = 0; errors.length = 0; await handlers.get("svc.add")({ _uiId: "invoke:x" }, { name: "Z", port: 4444 });
check(errors.length === 1 && !JSON.parse(readFileSync(join(dir, "services.json"), "utf8")).some((s) => s.name === "Z"), "appel interne refusé");
st = await call("svc.ignore", { port: 1 }); // port inexistant : sans effet visible
// Redémarrage : un nouveau register relit le fichier.
stop?.(); 
const handlers2 = new Map();
const stop2 = register({ ...ctx, onMessage: (t, fn) => handlers2.set(t, fn), send: (_w, m) => sent.push(m) });
sent.length = 0; await handlers2.get("svc.list")({ _uiId: "ui:1" }, { force: true, ref: "r" });
const st2 = sent.find((x) => x.type === "svc.state");
check(st2.services.some((s) => s.port === port && s.group === "Essais") && st2.services.find((s) => s.id === "front").group === "Site de test", "persistance après redémarrage");
stop2?.(); app.close(); rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} échec(s)` : "\nTout est bon");
process.exit(failed ? 1 : 0);
