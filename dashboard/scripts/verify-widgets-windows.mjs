// Vérifie handlers/widgets.mjs et handlers/windows.mjs (+ route HTTP /api/windows*).
// Usage : node dashboard/scripts/verify-widgets-windows.mjs   (le serveur du dashboard doit tourner sur :7070)
// Widgets : liste par défaut, sauvegarde valide, refus (type inconnu, URL http, id dupliqué, commande multiligne…),
//   persistance (fichier relu + module isolé redémarré), reset. Fenêtres : desk.state / windows.list entre deux
//   clients, scrollback d'un vrai terminal de sandbox-repo, windows.send avec et sans confirm, HTTP en lecture
//   seule, et refus sans identifiants sur une 2e instance protégée par mot de passe (port 7071, données isolées).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

const url = process.env.DASHBOARD_VERIFY_URL || "ws://127.0.0.1:7070/ui";
const origin = new URL(url).origin.replace("ws:", "http:").replace("wss:", "https:");
const http = origin;
const here = fileURLToPath(new URL(".", import.meta.url));
const dataDir = process.env.DASHBOARD_DATA_DIR || join(here, "..", "data");
const SANDBOX = process.env.VERIFY_SANDBOX || "D:/Projets/AI-OS/paseo-lab/sandbox-repo";

const fail = (message) => { throw new Error(message); };
const expect = (condition, label, detail = "") => {
  if (!condition) fail(`${label} ${detail}`);
  console.log(`OK ${label}`);
};
async function waitFor(label, fn, timeout = 15000, step = 100) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(step);
  }
  return fail(`Délai dépassé : ${label}`);
}

function client() {
  const ws = new WebSocket(url, { origin });
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
  ws.on("error", (e) => console.error("[ws]", e.message));
  const api = {
    ws, inbox,
    ready: () => waitFor("connexion", () => ws.readyState === WebSocket.OPEN, 5000, 50),
    // Envoie un message et attend la réponse `type` ou une erreur (renvoie alors { error }).
    async ask(message, type, timeout = 10000) {
      const from = inbox.length;
      ws.send(JSON.stringify(message));
      const reply = await waitFor(`${message.type} → ${type}`,
        () => inbox.slice(from).find((m) => m.type === type || m.type === "error"), timeout, 40);
      return reply.type === "error" ? { error: reply.message } : reply;
    },
    close: () => ws.close(),
  };
  return api;
}

// ---------- Widgets ----------
const a = client();
const b = client();
let terminalId = null;
let child = null;
let childDir = null;
try {
  await Promise.all([a.ready(), b.ready()]);
  expect(true, "deux clients WebSocket connectés");

  await a.ask({ type: "widgets.reset" }, "widgets.saved");
  const first = await a.ask({ type: "widgets.list" }, "widgets.list");
  const labels = first.all.map((w) => w.label);
  expect(["Terminal Mini PC", "Terminal Oracle", "Agent OpenRouter", "Agent NVIDIA", "FreeBuff", "Hermes (Oracle)",
    "Tâches"]
    .every((l) => labels.includes(l)) && first.all.length >= 7, "liste par défaut : les 7 widgets du ticket (+ ajouts ultérieurs : Hermes et Pi Mini PC)",
      labels.join(" | "));
  const hermes = first.all.find((w) => w.label === "Hermes (Oracle)");
  expect(hermes.action.provider === "hermes" && hermes.action.host === "oracle",
    "widget Hermes : provider hermes sur oracle");
  expect(first.all.every((w, i, all) => i === 0 || all[i - 1].order <= w.order), "widgets triés par order");

  // Sauvegarde valide : renommer, masquer, ajouter (https, commande, vue) ; l'autre client reçoit widgets.changed
  const edited = first.all.map((w) => ({ ...w }));
  edited[0].label = "Terminal ici (test)";
  edited[1].hidden = true;
  edited.push({ id: "w-test-url", label: "Docs", icon: "menu", order: 200, hidden: false,
    action: { type: "url", url: "https://example.com/docs" } });
  edited.push({ id: "w-test-cmd", label: "Git status", icon: "terminal", order: 210, hidden: false,
    action: { type: "terminal", host: "local", cwd: SANDBOX, command: "git", args: ["status", "--short"] } });
  edited.push({ id: "w-test-view", label: "Boîte", icon: "inbox", order: 220, hidden: false,
    action: { type: "view", view: "reception" } });
  const fromB = b.inbox.length;
  const saved = await a.ask({ type: "widgets.save", widgets: edited }, "widgets.saved");
  expect(saved.count === first.all.length + 3, "widgets.save valide → widgets par défaut + 3 enregistrés", JSON.stringify(saved).slice(0, 300));
  const changed = await waitFor("widgets.changed chez l'autre client", () =>
    b.inbox.slice(fromB).find((m) => m.type === "widgets.changed"), 5000, 50);
  expect(changed.all.length === first.all.length + 3 && changed.widgets.length === first.all.length + 2 && changed.widgets.every((w) => !w.hidden),
    "widgets.changed diffusé (9 visibles sur 10)");
  const onDisk = JSON.parse(readFileSync(join(dataDir, "widgets.json"), "utf8")).widgets;
  expect(onDisk.length === first.all.length + 3 && onDisk[0].label === "Terminal ici (test)" && onDisk[1].hidden === true,
    "persistance : data/widgets.json relu");
  expect(onDisk.find((w) => w.id === "w-test-cmd").action.args.join(" ") === "status --short", "args conservés");

  // Refus : chaque tentative doit renvoyer une erreur ET laisser la liste enregistrée intacte
  const base = () => edited.map((w) => ({ ...w, action: { ...w.action } }));
  const attempts = {
    "type d'action inconnu": (l) => l.push({ id: "bad1", label: "x", icon: "terminal", order: 1, hidden: false,
      action: { type: "shell", host: "local" } }),
    "URL http": (l) => l.push({ id: "bad2", label: "x", icon: "terminal", order: 1, hidden: false,
      action: { type: "url", url: "http://example.com" } }),
    "URL avec identifiants": (l) => l.push({ id: "bad2b", label: "x", icon: "terminal", order: 1, hidden: false,
      action: { type: "url", url: "https://user:pw@example.com" } }),
    "id dupliqué": (l) => l.push({ ...l[0] }),
    "commande multiligne": (l) => l.push({ id: "bad3", label: "x", icon: "terminal", order: 1, hidden: false,
      action: { type: "terminal", host: "local", command: "echo a\necho b" } }),
    "commande avec retour final": (l) => l.push({ id: "bad3b", label: "x", icon: "terminal", order: 1, hidden: false,
      action: { type: "terminal", host: "local", command: "echo a\n" } }),
    "argument multiligne": (l) => l.push({ id: "bad3c", label: "x", icon: "terminal", order: 1, hidden: false,
      action: { type: "terminal", host: "local", command: "echo", args: ["a\nb"] } }),
    "hôte inconnu": (l) => l.push({ id: "bad4", label: "x", icon: "terminal", order: 1, hidden: false,
      action: { type: "terminal", host: "machine-inconnue" } }),
    "vue inconnue": (l) => l.push({ id: "bad5", label: "x", icon: "terminal", order: 1, hidden: false,
      action: { type: "view", view: "nimporte" } }),
    "icône inconnue": (l) => l.push({ id: "bad6", label: "x", icon: "pirate", order: 1, hidden: false,
      action: { type: "view", view: "bureau" } }),
    "id invalide": (l) => l.push({ id: "a b/c", label: "x", icon: "terminal", order: 1, hidden: false,
      action: { type: "view", view: "bureau" } }),
    "libellé vide": (l) => l.push({ id: "bad7", label: "  ", icon: "terminal", order: 1, hidden: false,
      action: { type: "view", view: "bureau" } }),
    "agent sans provider": (l) => l.push({ id: "bad8", label: "x", icon: "agent", order: 1, hidden: false,
      action: { type: "agent", host: "local" } }),
    "plus de 40 widgets": (l) => {
      for (let i = 0; i < 31; i++) l.push({ id: `many-${i}`, label: "x", icon: "menu", order: 300 + i, hidden: false,
        action: { type: "view", view: "bureau" } });
    },
  };
  const refusedAs = [];
  for (const [name, mutate] of Object.entries(attempts)) {
    const list = base();
    mutate(list);
    const reply = await a.ask({ type: "widgets.save", widgets: list }, "widgets.saved");
    expect(Boolean(reply.error), `refusé : ${name}`, JSON.stringify(reply));
    refusedAs.push(reply.error);
  }
  console.log(`  exemples de messages : ${refusedAs.slice(0, 3).join(" / ")}`);
  const stillThere = JSON.parse(readFileSync(join(dataDir, "widgets.json"), "utf8")).widgets;
  expect(stillThere.length === first.all.length + 3 && stillThere.every((w, i) => w.id === onDisk[i].id),
    "fichier inchangé après les refus");
  const notList = await a.ask({ type: "widgets.save", widgets: "oui" }, "widgets.saved");
  expect(Boolean(notList.error), "refusé : widgets n'est pas une liste");

  // Persistance : un module neuf (redémarrage) relit le fichier ; sans fichier il crée les valeurs par défaut
  const { register } = await import(pathToFileURL(join(here, "..", "handlers", "widgets.mjs")).href);
  const { createStore } = await import(pathToFileURL(join(here, "..", "lib", "store.mjs")).href);
  const tmp = mkdtempSync(join(tmpdir(), "widgets-verify-"));
  try {
    const handlers = {};
    const sent = [];
    const ctx = {
      onMessage: (t, fn) => { handlers[t] = fn; }, send: (_w, m) => sent.push(m), broadcast() {}, sendError() {},
      store: createStore(tmp), log() {}, hosts: { labels: () => ["local", "oracle"] },
    };
    register(ctx);
    expect(JSON.parse(readFileSync(join(tmp, "widgets.json"), "utf8")).widgets.length === first.all.length,
      "fichier absent → créé avec les 7 valeurs par défaut");
    handlers["widgets.save"]({}, { widgets: edited });
    register({ ...ctx, onMessage: (t, fn) => { handlers[t] = fn; } });
    handlers["widgets.list"]({}, {});
    expect(sent.at(-1).all.length === first.all.length + 3 && sent.at(-1).all[0].label === "Terminal ici (test)",
      "module redémarré : widgets relus depuis le fichier");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const reset = await a.ask({ type: "widgets.reset" }, "widgets.saved");
  const back = JSON.parse(readFileSync(join(dataDir, "widgets.json"), "utf8")).widgets;
  expect(reset.count === first.all.length && back.length === first.all.length && back[0].label === "Terminal Mini PC",
    "widgets.reset → valeurs par défaut");

  // ---------- Fenêtres ----------
  const start = await a.ask({ type: "launch.start", host: "local", cwd: SANDBOX, kind: "terminal", ref: "vww" },
    "launch.started");
  terminalId = start.terminalId;
  expect(Boolean(terminalId), "terminal réel créé dans sandbox-repo", terminalId);
  const keyword = `KW${randomBytes(4).toString("hex").toUpperCase()}`;
  await delay(2500); // laisse le shell afficher son invite
  a.ws.send(JSON.stringify({ type: "term.input", host: "local", terminalId, data: `echo ${keyword}\r` }));
  const scroll = await waitFor("mot-clé dans le scrollback", async () => {
    const r = await a.ask({ type: "windows.scrollback", host: "local", terminalId }, "windows.scrollback");
    return r.lines?.some((l) => l.trim() === keyword) ? r : null;
  }, 15000, 500);
  expect(scroll.lines.length > 1 && scroll.lines.some((l) => l.includes("sandbox-repo")),
    "scrollback d'un vrai terminal",
    `${scroll.lines.length} lignes`);
  expect(scroll.lines.some((l) => l.trim() === keyword), `scrollback contient le mot-clé aléatoire ${keyword}`);
  expect(!scroll.lines.some((l) => /\x1b/.test(l)) && scroll.lines.at(-1).trim() !== "",
    "ANSI retiré, lignes vides de fin retirées");
  const two = await a.ask({ type: "windows.scrollback", host: "local", terminalId, lines: 2 }, "windows.scrollback");
  expect(two.lines.length === 2, "lines=2 → 2 lignes", String(two.lines.length));
  const huge = await a.ask({ type: "windows.scrollback", host: "local", terminalId, lines: 9999999 },
    "windows.scrollback");
  expect(huge.lines.length <= 2000, "lines plafonné à 2000");
  expect(Boolean((await a.ask({ type: "windows.scrollback", host: "local", terminalId: "inconnu-1" },
    "windows.scrollback")).error),
    "terminal inconnu → erreur");
  expect(Boolean((await a.ask({ type: "windows.scrollback", host: "nulle-part", terminalId },
    "windows.scrollback")).error),
    "hôte inconnu → erreur");
  expect(Boolean((await a.ask({ type: "windows.scrollback", host: "local", terminalId: "../x" },
    "windows.scrollback")).error),
    "identifiant de terminal invalide → erreur");

  // desk.state (client A) → windows.list (client B), dédoublonné, avec browserId ; supprimé à la déconnexion
  const desk = [
    { id: "w1", kind: "terminal", host: "local", cwd: SANDBOX, title: "Terminal test", terminalId, agentId: null,
      minimized: false, focused: true, x: 24, y: 40, w: 560, h: 344 },
    { id: "w2", kind: "agent", host: "oracle", cwd: "/home/ubuntu/projets/essai", title: "Agent test", terminalId: null,
      agentId: "agent-xyz", minimized: true, focused: false, x: 600, y: 40, w: 520, h: 432 },
  ];
  a.ws.send(JSON.stringify({ type: "desk.state", windows: desk }));
  const seen = await waitFor("windows.list chez B", async () => {
    const r = await b.ask({ type: "windows.list" }, "windows.list");
    return r.windows?.some((w) => w.terminalId === terminalId) ? r : null;
  }, 5000, 150);
  const w1 = seen.windows.find((w) => w.id === "w1");
  expect(w1.kind === "terminal" && w1.focused === true && w1.w === 560 && Boolean(w1.browserId),
    "un second client reçoit les fenêtres du premier (avec browserId)");
  expect(seen.windows.find((w) => w.id === "w2").minimized === true, "état « réduite » transmis");
  b.ws.send(JSON.stringify({ type: "desk.state", windows: [{ ...desk[0], id: "w1-b" }, { kind: "x", host: 5,
    w: "?" }] }));
  await delay(300);
  const merged = await a.ask({ type: "windows.list" }, "windows.list");
  expect(merged.windows.filter((w) => w.terminalId === terminalId).length === 1,
    "même terminal ouvert dans deux navigateurs → dédoublonné");
  expect(merged.windows.every((w) => ["terminal", "agent"].includes(w.kind) && typeof w.host === "string"),
    "entrées invalides normalisées");
  b.ws.send(JSON.stringify({ type: "desk.state", windows: [] }));
  await delay(200);

  // windows.send : refusé sans confirm, accepté avec
  const refusedKw = `NO${randomBytes(3).toString("hex").toUpperCase()}`;
  const noConfirm = await a.ask({ type: "windows.send", host: "local", terminalId, text: `echo ${refusedKw}`,
    enter: true },
    "windows.sent");
  expect(Boolean(noConfirm.error) && /confirm/.test(noConfirm.error), "windows.send sans confirm → refusé",
    noConfirm.error);
  const falsy = await a.ask({ type: "windows.send", host: "local", terminalId, text: `echo ${refusedKw}`, enter: true,
    confirm: "true" }, "windows.sent");
  expect(Boolean(falsy.error), "windows.send avec confirm non booléen → refusé");
  await delay(1000);
  let after = await a.ask({ type: "windows.scrollback", host: "local", terminalId }, "windows.scrollback");
  expect(!after.lines.some((l) => l.includes(refusedKw)), "rien n'a été tapé dans le terminal sans confirm");
  const okKw = `OK${randomBytes(3).toString("hex").toUpperCase()}`;
  const sentOk = await a.ask({ type: "windows.send", host: "local", terminalId, text: `echo ${okKw}`, enter: true,
    confirm: true }, "windows.sent");
  expect(sentOk.type === "windows.sent", "windows.send avec confirm: true → accepté");
  after = await waitFor("texte envoyé visible", async () => {
    const r = await a.ask({ type: "windows.scrollback", host: "local", terminalId }, "windows.scrollback");
    return r.lines.some((l) => l.trim() === okKw) ? r : null;
  }, 10000, 400);
  expect(Boolean(after), "le texte envoyé a été exécuté dans le terminal");
  const unknownTerm = await a.ask({ type: "windows.send", host: "local",
    terminalId: "00000000-0000-0000-0000-000000000000",
    text: "x", confirm: true }, "windows.sent");
  expect(Boolean(unknownTerm.error), "windows.send vers un terminal inconnu → refusé", unknownTerm.error);

  // HTTP en lecture seule : même JSON que windows.list
  a.ws.send(JSON.stringify({ type: "desk.state", windows: desk }));
  await delay(300);
  const viaWs = (await a.ask({ type: "windows.list" }, "windows.list")).windows;
  const viaHttp = await (await fetch(`${http}/api/windows`)).json();
  expect(JSON.stringify(viaHttp.windows) === JSON.stringify(viaWs) && viaWs.some((w) => w.id === "w2"),
    "GET /api/windows renvoie le même JSON que windows.list");
  const sb = await (await fetch(`${http}/api/windows/scrollback?host=local&terminal=${terminalId}&lines=3`)).json();
  expect(sb.lines.length === 3 && sb.terminalId === terminalId, "GET /api/windows/scrollback?host=&terminal=&lines=");
  const post = await fetch(`${http}/api/windows`, { method: "POST", body: "{}" });
  expect(post.status === 405, "POST /api/windows refusé (aucune écriture par HTTP)", String(post.status));
  expect((await fetch(`${http}/api/windows/scrollback?host=local`)).status === 400, "scrollback sans terminal → 400");
  expect((await fetch(`${http}/api/windows/scrollback?host=local&terminal=inconnu`)).status === 404,
    "terminal inconnu → 404");
  b.close();
  await delay(300);
  a.ws.send(JSON.stringify({ type: "desk.state", windows: [] }));

  // 2e instance avec mot de passe : refus sans identifiants
  const password = randomBytes(8).toString("hex");
  childDir = mkdtempSync(join(tmpdir(), "dashboard-pw-"));
  child = spawn(process.execPath, [join(here, "..", "server.mjs")], {
    env: { ...process.env, DASHBOARD_PORT: "7071", DASHBOARD_PASSWORD: password, DASHBOARD_DATA_DIR: childDir },
    stdio: "ignore", windowsHide: true,
  });
  const secured = "http://127.0.0.1:7071";
  await waitFor("2e instance", async () => fetch(`${secured}/api/windows`).then(() => true, () => false), 20000, 300);
  const basic = (pw) => ({ Authorization: `Basic ${Buffer.from(`admin:${pw}`).toString("base64")}` });
  const noAuth = await fetch(`${secured}/api/windows`);
  expect(noAuth.status === 401, "mot de passe défini : /api/windows sans identifiants → 401", String(noAuth.status));
  expect((await fetch(`${secured}/api/windows/scrollback?host=local&terminal=${terminalId}`)).status === 401,
    "mot de passe défini : /api/windows/scrollback sans identifiants → 401");
  expect((await fetch(`${secured}/api/windows`, { headers: basic("mauvais") })).status === 401,
    "mauvais mot de passe → 401");
  const good = await fetch(`${secured}/api/windows`, { headers: basic(password) });
  expect(good.status === 200 && Array.isArray((await good.json()).windows), "bons identifiants → 200 et JSON");
  child.kill();
  await delay(500);
  child = null;
  console.log("\nVERIFY_WIDGETS_WINDOWS_PASS");
} catch (error) {
  console.error("\nVERIFY_WIDGETS_WINDOWS_FAIL", error.message);
  process.exitCode = 1;
} finally {
  if (child) child.kill();
  if (childDir) rmSync(childDir, { recursive: true, force: true });
  try {
    if (terminalId) {
      a.ws.send(JSON.stringify({ type: "term.kill", host: "local", terminalId }));
      await delay(500);
      console.log(`terminal de test fermé : ${terminalId.slice(0, 8)}`);
    }
    a.ws.send(JSON.stringify({ type: "widgets.reset" }));
    await delay(300);
    console.log("widgets remis aux valeurs par défaut");
  } catch { /* connexion déjà fermée */ }
  a.close();
  b.close();
}
