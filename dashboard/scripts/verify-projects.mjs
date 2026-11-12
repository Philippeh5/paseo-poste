// Vérifie l'explorateur de dossiers, les projets suivis et les garde-fous GitHub (handlers fs / projects / github).
// Usage : node dashboard/scripts/verify-projects.mjs   (le serveur du dashboard doit tourner)
//   DASHBOARD_VERIFY_URL=ws://127.0.0.1:7071/ui pour viser une autre instance.
// Garanties : aucune création de dépôt, aucun push, aucune écriture dans un dépôt de Philippe. Les écritures GitHub ne
// sont envoyées qu'avec dryRun:true (le script refuse de les envoyer autrement). Nettoyage : projets désuivis, dossier jetable supprimé.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

const url = process.env.DASHBOARD_VERIFY_URL || "ws://127.0.0.1:7070/ui";
const origin = new URL(url).origin.replace("ws:", "http:").replace("wss:", "https:");
const dataDir = fileURLToPath(new URL("../data/", import.meta.url));
const projectsFile = join(dataDir, "projects.json");
const SANDBOX = process.env.VERIFY_SANDBOX || "D:\\Projets\\AI-OS\\paseo-lab\\sandbox-repo";
const REMOTE_REPO = "D:\\Projets\\Orchestrateur"; // dépôt de Philippe avec remote GitHub : lecture seule
const socket = new WebSocket(url, { origin });
const inbox = [];
const everything = [];
let opened = false;
socket.on("open", () => { opened = true; });
socket.on("message", (raw) => {
  const text = raw.toString();
  everything.push(text);
  inbox.push(JSON.parse(text));
});

const fail = (message) => { throw new Error(message); };
const WRITE_TYPES = new Set(["github.create", "github.sync"]);
const send = (message) => {
  // Garde-fou : aucune écriture GitHub réelle depuis ce script.
  if (WRITE_TYPES.has(message.type) && message.confirm === true && message.dryRun !== true) {
    fail(`Écriture GitHub réelle refusée par le script de test : ${message.type}`);
  }
  inbox.length = 0;
  socket.send(JSON.stringify(message));
};
async function receive(type, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const index = inbox.findIndex((m) => m.type === type);
    if (index >= 0) return inbox.splice(index, 1)[0];
    await delay(40);
  }
  return fail(`Délai dépassé : ${label}`);
}
const ask = async (message, responseType, label) => {
  send(message);
  return receive(responseType, label);
};
const expect = (condition, label, detail = "") => {
  if (!condition) fail(`${label} ${detail}`);
  console.log(`OK ${label}`);
};
const show = (label, value) => console.log(`${label} ${JSON.stringify(value)}`);
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

const scratch = mkdtempSync(join(tmpdir(), "paseo-t09-"));
const scratchChild = join(scratch, "projet-test");
const followedByTest = [];
let initialIds = [];
let cleaned = false;

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const id of followedByTest) {
    socket.send(JSON.stringify({ type: "project.unfollow", id }));
    await delay(150);
  }
  rmSync(scratch, { recursive: true, force: true });
}

try {
  for (let i = 0; i < 100 && !opened; i++) await delay(50);
  expect(opened, "connexion au dashboard");

  // ---- Départ : liste existante (restaurée à la fin) ----
  const startList = await ask({ type: "project.list" }, "project.list", "project.list initial");
  initialIds = startList.projects.map((p) => p.id);
  show("PROJETS_AU_DEPART", initialIds);

  // ---- fs.roots / fs.list : local ----
  const rootsLocal = await ask({ type: "fs.roots", host: "local" }, "fs.roots", "fs.roots local");
  show("FS_ROOTS_LOCAL", rootsLocal.roots.map((r) => `${r.kind}:${r.path}`));
  expect(rootsLocal.ok && rootsLocal.platform === "win32", "fs.roots local : plateforme Windows");
  expect(rootsLocal.roots.some((r) => r.kind === "drive" && r.path === "D:\\"), "fs.roots local : le lecteur D: est listé");
  expect(rootsLocal.roots.some((r) => r.kind === "home"), "fs.roots local : dossier personnel présent");

  const listLocal = await ask({ type: "fs.list", host: "local", path: "D:\\Projets" }, "fs.list", "fs.list D:\\Projets");
  const names = listLocal.entries.map((e) => e.name);
  show("FS_LIST_LOCAL_D_PROJETS", { path: listLocal.path, parent: listLocal.parent, count: names.length, sample: listLocal.entries.slice(0, 4) });
  expect(listLocal.ok && names.includes("AI-OS") && names.includes("Orchestrateur"), "fs.list local : D:\\Projets liste AI-OS et Orchestrateur");
  expect(listLocal.entries.find((e) => e.name === "Orchestrateur")?.git === true, "fs.list local : Orchestrateur signalé dépôt git");
  expect(listLocal.entries.every((e) => e.path.startsWith("D:\\Projets\\")), "fs.list local : chemins complets des sous-dossiers");
  expect(!names.some((n) => n.startsWith(".")), "fs.list local : dossiers cachés masqués par défaut");
  const withFiles = await ask({ type: "fs.list", host: "local", path: SANDBOX }, "fs.list", "fs.list sandbox-repo");
  expect(withFiles.ok && withFiles.isGit === true && withFiles.entries.length === 0, "fs.list local : sandbox-repo = dépôt git sans sous-dossier (fichiers non listés)");

  const missing = await ask({ type: "fs.list", host: "local", path: "D:\\Projets\\dossier-inexistant-zz" }, "fs.list", "dossier inexistant");
  show("FS_LIST_INEXISTANT", missing);
  expect(missing.ok === false && missing.code === "not_found" && /introuvable/i.test(missing.error), "fs.list local : dossier inexistant -> erreur claire");
  for (const [label, bad] of [
    ["traversée « .. »", "D:\\Projets\\..\\Windows"],
    ["chemin relatif", "Projets\\AI-OS"],
    ["chemin réseau UNC", "\\\\serveur\\partage"],
    ["chemin trop long", `D:\\${"a".repeat(1100)}`],
    ["format d'une autre machine", "/home/ubuntu"],
  ]) {
    const refused = await ask({ type: "fs.list", host: "local", path: bad }, "fs.list", label);
    expect(refused.ok === false && refused.code === "invalid_path", `fs.list refuse : ${label}`, refused.error);
  }
  const aFile = await ask({ type: "fs.list", host: "local", path: join(SANDBOX, "calc.py") }, "fs.list", "fichier");
  expect(aFile.ok === false && aFile.code === "not_directory", "fs.list local : un fichier n'est pas un dossier", aFile.error);

  // ---- fs.roots / fs.list : oracle ----
  const rootsOracle = await ask({ type: "fs.roots", host: "oracle" }, "fs.roots", "fs.roots oracle");
  show("FS_ROOTS_ORACLE", rootsOracle.roots.map((r) => `${r.kind}:${r.path}`));
  expect(rootsOracle.ok && rootsOracle.platform === "posix" && rootsOracle.roots.some((r) => r.path === "/"), "fs.roots oracle : racine / présente");
  expect(rootsOracle.roots.some((r) => r.kind === "home" && r.path === "/home/ubuntu"), "fs.roots oracle : $HOME = /home/ubuntu");
  const listOracle = await ask({ type: "fs.list", host: "oracle", path: "/home/ubuntu" }, "fs.list", "fs.list oracle");
  show("FS_LIST_ORACLE_HOME", { path: listOracle.path, parent: listOracle.parent, count: listOracle.entries.length, sample: listOracle.entries.slice(0, 3) });
  expect(listOracle.ok && listOracle.parent === "/home" && listOracle.entries.length > 0, "fs.list oracle : /home/ubuntu listé (daemon)");
  expect(listOracle.entries.every((e) => e.path.startsWith("/home/ubuntu/")), "fs.list oracle : chemins complets");
  const missingOracle = await ask({ type: "fs.list", host: "oracle", path: "/home/ubuntu/dossier-inexistant-zz" }, "fs.list", "oracle inexistant");
  expect(missingOracle.ok === false && missingOracle.code === "not_found", "fs.list oracle : dossier inexistant -> erreur claire", missingOracle.error);
  const unknownHost = await ask({ type: "fs.list", host: "fantome", path: "/" }, "fs.list", "machine inconnue");
  expect(unknownHost.ok === false && unknownHost.code === "unknown_host", "fs.list : machine inconnue refusée", unknownHost.error);

  // ---- fs.mkdir sur un dossier jetable (puis nettoyage) ----
  const made = await ask({ type: "fs.mkdir", host: "local", path: scratchChild }, "fs.mkdir", "fs.mkdir");
  expect(made.ok && existsSync(scratchChild), "fs.mkdir local : dossier créé", made.error);
  const listed = await ask({ type: "fs.list", host: "local", path: scratch }, "fs.list", "fs.list du dossier jetable");
  expect(listed.entries.some((e) => e.name === "projet-test"), "fs.list voit le dossier créé");
  const again = await ask({ type: "fs.mkdir", host: "local", path: scratchChild }, "fs.mkdir", "mkdir doublon");
  expect(again.ok === false && again.code === "exists", "fs.mkdir refuse un dossier déjà présent", again.error);
  for (const [label, bad, code] of [
    ["nom réservé Windows", join(scratch, "CON"), "invalid_name"],
    ["caractère interdit", `${scratch}\\a?b`, "invalid_path"],
    ["traversée", `${scratch}\\..\\x`, "invalid_path"],
    ["parent inexistant", join(scratch, "absent", "enfant"), "not_found"],
    ["nom finissant par un point", join(scratch, "nom."), "invalid_name"],
  ]) {
    const refused = await ask({ type: "fs.mkdir", host: "local", path: bad }, "fs.mkdir", label);
    expect(refused.ok === false && refused.code === code, `fs.mkdir refuse : ${label}`, `${refused.code} ${refused.error}`);
  }
  expect(readdirSync(scratch).join(",") === "projet-test", "fs.mkdir : aucun dossier parasite créé par les refus");

  // ---- Suivre / ne plus suivre / réordonner + persistance ----
  const f1 = await ask({ type: "project.follow", host: "local", dir: SANDBOX }, "project.followed", "follow sandbox");
  expect(f1.ok && f1.added.length === 1 && f1.added[0].name === "sandbox-repo", "project.follow : sandbox-repo suivi", f1.error);
  followedByTest.push(f1.added[0].id);
  const f2 = await ask({ type: "project.follow", host: "local", dir: scratchChild, name: "Projet test", color: "#4cc38a" }, "project.followed", "follow temp");
  followedByTest.push(f2.added[0].id);
  const f3 = await ask({ type: "project.follow", host: "local", dir: REMOTE_REPO }, "project.followed", "follow orchestrateur");
  followedByTest.push(f3.added[0].id);
  expect(f2.added[0].name === "Projet test" && f2.added[0].color === "#4cc38a", "project.follow : nom et couleur conservés");
  const dup = await ask({ type: "project.follow", host: "local", dir: SANDBOX.toLowerCase() }, "project.followed", "follow doublon");
  expect(dup.ok && dup.added.length === 0 && dup.already.length === 1, "project.follow : doublon (casse différente) ignoré");
  const nope = await ask({ type: "project.follow", host: "local", dir: "D:\\Projets\\inexistant-zz" }, "project.followed", "follow inexistant");
  expect(nope.ok === false && nope.code === "not_found", "project.follow : dossier inexistant refusé", nope.error);
  const batch = await ask({ type: "project.follow", host: "local", dirs: [join(scratch), "D:\\Projets\\absent-zz"] }, "project.followed", "follow lot");
  expect(batch.added.length === 1 && batch.errors.length === 1, "project.follow : lot = 1 ajouté, 1 erreur");
  followedByTest.push(batch.added[0].id);
  const [idSandbox, idTemp, idRemote, idScratch] = followedByTest;

  const disk1 = JSON.parse(readFileSync(projectsFile, "utf8"));
  expect(followedByTest.every((id) => disk1.projects.some((p) => p.id === id)), "persistance : les 4 projets sont dans data/projects.json");
  const reorder = await ask({ type: "project.reorder", ids: [idRemote, idScratch, idSandbox, idTemp] }, "project.reordered", "reorder");
  expect(reorder.ids.slice(0, 4).join() === [idRemote, idScratch, idSandbox, idTemp].join()  , "project.reorder : ordre renvoyé", reorder.ids.join());
  const listAfter = await ask({ type: "project.list" }, "project.list", "project.list après réordonnancement");
  const orderedTest = listAfter.projects.filter((p) => followedByTest.includes(p.id)).map((p) => p.id);
  expect(orderedTest.join() === [idRemote, idScratch, idSandbox, idTemp].join(), "project.list reflète le nouvel ordre", orderedTest.join());
  const disk2 = JSON.parse(readFileSync(projectsFile, "utf8"));
  const diskOrder = disk2.projects.filter((p) => followedByTest.includes(p.id)).map((p) => `${p.id}:${p.order}`);
  show("PERSISTANCE_FICHIER", { file: "dashboard/data/projects.json", order: diskOrder, firstRunFlag: listAfter.firstRun });
  expect(disk2.projects.filter((p) => followedByTest.includes(p.id)).map((p) => p.id).join() === orderedTest.join(), "persistance : ordre relu depuis le fichier");
  expect(disk2.projects.every((p, i) => p.order === i), "persistance : champ order contigu dans le fichier");
  expect(listAfter.firstRun === false, "project.list : firstRun faux dès qu'un projet est suivi");

  const upd = await ask({ type: "project.update", id: idTemp, name: "Renommé", color: null }, "project.updated", "update");
  expect(upd.ok && upd.project.name === "Renommé" && upd.project.color === null, "project.update : renommer et retirer la couleur");
  const badColor = await ask({ type: "project.update", id: idTemp, color: "rouge" }, "project.updated", "update couleur");
  expect(badColor.ok === false && badColor.code === "invalid_color", "project.update : couleur invalide refusée");

  // ---- project.status (lecture seule) ----
  const stSandbox = await ask({ type: "project.status", host: "local", dir: SANDBOX, fresh: true }, "project.status", "status sandbox");
  show("STATUS_SANDBOX", stSandbox);
  expect(stSandbox.ok && stSandbox.isGit && stSandbox.hasRemote === false && stSandbox.remoteUrl === null, "project.status sandbox-repo : dépôt git sans remote");
  expect(stSandbox.github === "unlinked" && stSandbox.branch, "project.status sandbox-repo : pastille « non lié », branche connue", stSandbox.branch);
  const stRemote = await ask({ type: "project.status", host: "local", dir: REMOTE_REPO, fresh: true }, "project.status", "status orchestrateur");
  show("STATUS_ORCHESTRATEUR", stRemote);
  expect(stRemote.ok && stRemote.hasRemote && stRemote.githubRemote && stRemote.github === "linked", "project.status Orchestrateur : remote GitHub, « lié »");
  expect(stRemote.repo === "Philippeh5/Orchestrateur" && !/@/.test(stRemote.remoteUrl), "project.status : dépôt Philippeh5/Orchestrateur, URL sans identifiants");
  expect(typeof stRemote.dirty === "boolean" && Number.isInteger(stRemote.ahead) && Number.isInteger(stRemote.behind), "project.status : propre/modifié et avance/retard renseignés");
  const stNotGit = await ask({ type: "project.status", host: "local", dir: scratch }, "project.status", "status non git");
  expect(stNotGit.ok && stNotGit.isGit === false && stNotGit.branch === null, "project.status : dossier non git signalé");
  const stMissing = await ask({ type: "project.status", host: "local", dir: "D:\\Projets\\inexistant-zz" }, "project.status", "status inexistant");
  expect(stMissing.ok === false && stMissing.code === "not_found", "project.status : dossier inexistant -> erreur claire");
  const stOracle = await ask({ type: "project.status", host: "oracle", dir: "/home/ubuntu", fresh: true }, "project.status", "status oracle");
  show("STATUS_ORACLE", { ok: stOracle.ok, isGit: stOracle.isGit, github: stOracle.github, githubReason: stOracle.githubReason });
  expect(stOracle.ok && ["disconnected", "unlinked", "linked"].includes(stOracle.github) && (stOracle.github !== "disconnected" || Boolean(stOracle.githubReason)), "project.status oracle : état GitHub cohérent (connecté: lié ou non lié ; sinon une raison est fournie)");

  // ---- Écritures GitHub : refus sans confirm, simulation avec confirm + dryRun ----
  const noConfirm = await ask({ type: "github.create", host: "local", dir: SANDBOX, name: "sandbox-repo" }, "github.result", "create sans confirm");
  show("GITHUB_CREATE_SANS_CONFIRM", noConfirm);
  expect(noConfirm.ok === false && noConfirm.code === "confirm_required", "github.create sans confirm:true -> refusé");
  const falseConfirm = await ask({ type: "github.create", host: "local", dir: SANDBOX, confirm: "true", dryRun: true }, "github.result", "create confirm texte");
  expect(falseConfirm.ok === false && falseConfirm.code === "confirm_required", "github.create avec confirm non booléen -> refusé");
  const syncNoConfirm = await ask({ type: "github.sync", host: "local", dir: REMOTE_REPO }, "github.result", "sync sans confirm");
  expect(syncNoConfirm.ok === false && syncNoConfirm.code === "confirm_required", "github.sync sans confirm:true -> refusé");
  const dryOnlyNoConfirm = await ask({ type: "github.sync", host: "local", dir: REMOTE_REPO, dryRun: true }, "github.result", "sync dryRun sans confirm");
  expect(dryOnlyNoConfirm.ok === false && dryOnlyNoConfirm.code === "confirm_required", "github.sync dryRun sans confirm:true -> refusé aussi");

  const dryCreate = await ask({ type: "github.create", host: "local", dir: SANDBOX, name: "sandbox-repo", description: "test", confirm: true, dryRun: true }, "github.result", "create dryRun");
  console.log("PLAN_CREATE_DRYRUN", JSON.stringify(dryCreate, null, 2));
  expect(dryCreate.ok && dryCreate.dryRun === true && dryCreate.executed === false, "github.create confirm+dryRun : plan renvoyé, rien exécuté");
  expect(dryCreate.plan.visibility === "private", "github.create : visibilité privée par défaut");
  expect(/^Cela va créer un dépôt privé sandbox-repo sur le compte \S+ et y pousser la branche master\.$/.test(dryCreate.plan.summary), "github.create : phrase de confirmation conforme", dryCreate.plan.summary);
  const drySync = await ask({ type: "github.sync", host: "local", dir: REMOTE_REPO, confirm: true, dryRun: true }, "github.result", "sync dryRun");
  console.log("PLAN_SYNC_DRYRUN", JSON.stringify(drySync, null, 2));
  expect(drySync.ok && drySync.dryRun === true && drySync.executed === false, "github.sync confirm+dryRun : plan renvoyé, rien exécuté");
  expect(drySync.plan.commands.join() === "git pull,git push" && drySync.plan.branch === stRemote.branch, "github.sync : plan pull puis push");
  const syncBlocked = await ask({ type: "github.sync", host: "local", dir: SANDBOX, confirm: true, dryRun: true }, "github.result", "sync sans remote");
  expect(syncBlocked.ok === false && syncBlocked.code === "no_remote", "github.sync sans dépôt distant -> bloqué (no_remote)", syncBlocked.error);
  const createLinked = await ask({ type: "github.create", host: "local", dir: REMOTE_REPO, confirm: true, dryRun: true }, "github.result", "create sur dépôt lié");
  expect(createLinked.ok === false && createLinked.code === "remote_exists", "github.create sur un dépôt déjà lié -> bloqué (remote_exists)");
  const badName = await ask({ type: "github.create", host: "local", dir: SANDBOX, name: "nom invalide!", confirm: true, dryRun: true }, "github.result", "nom invalide");
  expect(badName.ok === false && badName.code === "invalid_name", "github.create : nom de dépôt invalide refusé");
  const oracleCreate = await ask({ type: "github.create", host: "oracle", dir: "/home/ubuntu", confirm: true, dryRun: true }, "github.result", "create oracle");
  show("GITHUB_ORACLE", { ok: oracleCreate.ok, code: oracleCreate.code, error: oracleCreate.error, help: oracleCreate.plan?.github?.help });
  const oracleConnected = stOracle.github !== "disconnected";
  if (oracleConnected) {
    expect(oracleCreate.ok === false && ["remote_unsupported", "not_git"].includes(oracleCreate.code), "oracle (GitHub connecté) : création de dépôt refusée proprement (remote_unsupported ou not_git)");
  } else {
    expect(oracleCreate.ok === false && oracleCreate.code === "github_disconnected" && oracleCreate.error === "GitHub n’est pas connecté sur cette machine", "oracle : « GitHub n’est pas connecté sur cette machine »");
    expect(/gh auth login/.test(oracleCreate.plan?.github?.help ?? ""), "oracle : l'aide indique `gh auth login`");
  }

  const planRead = await ask({ type: "github.plan", host: "local", dir: SANDBOX, action: "create" }, "github.plan", "github.plan lecture seule");
  expect(planRead.ok && planRead.summary === dryCreate.plan.summary, "github.plan (lecture seule, sans confirm) renvoie la même phrase");
  const ghStatus = await ask({ type: "github.status", host: "local", dir: REMOTE_REPO }, "github.status", "github.status");
  show("GITHUB_STATUS_ORCHESTRATEUR", { ok: ghStatus.ok, linked: ghStatus.linked, connected: ghStatus.github?.connected, account: ghStatus.github?.account, repo: ghStatus.repo });
  expect(ghStatus.ok && ghStatus.linked && ghStatus.github.connected && ghStatus.repo?.exists === true, "github.status : dépôt GitHub existant détecté (gh repo view, lecture seule)");

  // Preuve que rien n'a été créé ni modifié.
  expect(git(SANDBOX, "remote") === "", "sandbox-repo : toujours aucun remote après les simulations");
  let created = true;
  try {
    execFileSync("gh", ["repo", "view", `${ghStatus.github.account}/sandbox-repo`, "--json", "name"], { stdio: "pipe" });
  } catch {
    created = false;
  }
  expect(created === false, `GitHub : aucun dépôt ${ghStatus.github.account}/sandbox-repo n'a été créé`);

  // ---- Ne plus suivre ----
  for (const id of [idSandbox, idTemp, idRemote, idScratch]) {
    const un = await ask({ type: "project.unfollow", id }, "project.unfollowed", "unfollow");
    expect(un.ok, `project.unfollow ${id}`);
  }
  followedByTest.length = 0;
  const unknown = await ask({ type: "project.unfollow", id: "inconnu" }, "project.unfollowed", "unfollow inconnu");
  expect(unknown.ok === false && unknown.code === "not_followed", "project.unfollow : projet inconnu refusé");
  const end = await ask({ type: "project.list" }, "project.list", "project.list final");
  expect(end.projects.map((p) => p.id).join() === initialIds.join(), "liste finale identique à la liste de départ");
  const disk3 = JSON.parse(readFileSync(projectsFile, "utf8"));
  expect(disk3.projects.map((p) => p.id).join() === initialIds.join(), "persistance : fichier relu = liste de départ");

  // ---- Hygiène ----
  const leftovers = readdirSync(dataDir).filter((f) => f.endsWith(".tmp"));
  expect(leftovers.length === 0, "écriture atomique : aucun fichier .tmp résiduel", leftovers.join(","));
  // Aucun secret dans ce que reçoit le navigateur : ni jeton GitHub, ni mot de passe de machine (lus localement, jamais affichés).
  const secrets = (JSON.parse(readFileSync((process.env.DASHBOARD_HOSTS_FILE || fileURLToPath(new URL("../hosts.json", import.meta.url))), "utf8")).hosts || [])
    .map((h) => h.password).filter((value) => typeof value === "string" && value.length >= 6);
  const leaked = everything.filter((t) => /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_/.test(t) || secrets.some((secret) => t.includes(secret)));
  expect(leaked.length === 0, "aucun jeton GitHub ni mot de passe de machine dans les messages reçus", `${leaked.length} message(s)`);
  console.log("VERIFY_PROJECTS_PASS");
} catch (error) {
  console.error("VERIFY_PROJECTS_FAIL", error.message);
  process.exitCode = 1;
} finally {
  await cleanup();
  const left = existsSync(scratch);
  console.log(`NETTOYAGE dossier jetable supprimé : ${!left}`);
  socket.close();
}
