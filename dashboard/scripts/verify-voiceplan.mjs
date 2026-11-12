// Vérification du handler voiceplan (T23) :
// (a) Tests purs du parse JSON tolérant (≥ 8 cas : markdown, JSON invalide, tâches vides, >12 tâches, dépendances).
// (b) Test WebSocket réel avec texte de 3 idées → plan créé dans l'inbox ou repli d'erreur claire en français.
// (c) Vérification d'absence de toute clé secrète dans les flux WS, puis nettoyage (marqué traité).
import { WebSocket } from "ws";
import { setTimeout as delay } from "node:timers/promises";
import { parseAndValidatePlan } from "../handlers/voiceplan.mjs";

const KEY_PATTERN = /sk-[a-zA-Z0-9_\-\.]{8,}/;
let fails = 0;

function ok(condition, label, detail = "") {
  if (condition) {
    console.log(`OK ${label}${detail ? ` (${detail})` : ""}`);
  } else {
    console.error(`FAIL ${label}${detail ? ` (${detail})` : ""}`);
    fails++;
  }
}

// =========================================================================
// PARTIE A : Tests purs du parseur JSON tolérant
// =========================================================================
console.log("--- PARTIE A : Tests purs du parse JSON tolérant ---");

// Cas 1 : JSON strict valide
try {
  const res = parseAndValidatePlan(JSON.stringify({
    title: "Plan standard",
    tasks: [
      { title: "Préparer l'environnement", dependsOn: [] },
      { title: "Lancer le build", dependsOn: [0] },
    ],
  }));
  ok(res.title === "Plan standard" && res.tasks.length === 2, "Cas 1 : JSON strict valide");
} catch (e) {
  ok(false, "Cas 1 : JSON strict valide", e.message);
}

// Cas 2 : Bloc Markdown ```json ... ```
try {
  const raw = "```json\n" + JSON.stringify({
    title: "Plan en bloc json",
    tasks: [{ title: "Tâche unique", dependsOn: [] }],
  }) + "\n```";
  const res = parseAndValidatePlan(raw);
  ok(res.tasks.length === 1 && res.tasks[0].title === "Tâche unique", "Cas 2 : Bloc ```json");
} catch (e) {
  ok(false, "Cas 2 : Bloc ```json", e.message);
}

// Cas 3 : Bloc Markdown simple ``` ... ``` avec texte avant et après
try {
  const raw = "Voici le plan d'action :\n```\n" + JSON.stringify({
    title: "Plan avec texte externe",
    tasks: [{ title: "Étape 1", dependsOn: [] }, { title: "Étape 2", dependsOn: [0] }],
  }) + "\n```\nEn espérant que cela aide !";
  const res = parseAndValidatePlan(raw);
  ok(res.tasks.length === 2, "Cas 3 : Bloc ``` avec texte avant/après");
} catch (e) {
  ok(false, "Cas 3 : Bloc ``` avec texte avant/après", e.message);
}

// Cas 4 : JSON invalide (syntaxe cassée)
try {
  parseAndValidatePlan("Voici une erreur : { title: non-quoted, tasks: [ }");
  ok(false, "Cas 4 : JSON syntaxe invalide non rejeté");
} catch (e) {
  ok(e.message.includes("JSON invalide"), "Cas 4 : Rejet de JSON syntaxe invalide", e.message);
}

// Cas 5 : Réponse vide ou uniquement espaces
try {
  parseAndValidatePlan("   \n\t  ");
  ok(false, "Cas 5 : Réponse vide non rejetée");
} catch (e) {
  ok(e.message.includes("vide ou invalide"), "Cas 5 : Rejet de réponse vide", e.message);
}

// Cas 6 : Pas de liste tasks
try {
  parseAndValidatePlan(JSON.stringify({ title: "Sans tâches" }));
  ok(false, "Cas 6 : Absence de tasks non rejetée");
} catch (e) {
  ok(e.message.includes("liste de tâches"), "Cas 6 : Rejet d'absence de liste tasks", e.message);
}

// Cas 7 : Liste tasks vide
try {
  parseAndValidatePlan(JSON.stringify({ title: "Plan vide", tasks: [] }));
  ok(false, "Cas 7 : Tasks vide non rejeté");
} catch (e) {
  ok(e.message.includes("aucune tâche"), "Cas 7 : Rejet de tasks vide", e.message);
}

// Cas 8 : Plus de 12 tâches (> 12 tâches)
try {
  const thirteenTasks = Array.from({ length: 13 }, (_, i) => ({
    title: `Tâche ${i + 1}`,
    dependsOn: [],
  }));
  parseAndValidatePlan(JSON.stringify({ title: "Trop de tâches", tasks: thirteenTasks }));
  ok(false, "Cas 8 : Plus de 12 tâches non rejeté");
} catch (e) {
  ok(e.message.includes("maximum 12"), "Cas 8 : Rejet de plus de 12 tâches", e.message);
}

// Cas 9 : Tâche avec titre vide
try {
  parseAndValidatePlan(JSON.stringify({
    title: "Titre vide",
    tasks: [{ title: "   ", dependsOn: [] }],
  }));
  ok(false, "Cas 9 : Titre vide non rejeté");
} catch (e) {
  ok(e.message.includes("Titre de tâche manquant ou vide"), "Cas 9 : Rejet de titre de tâche vide", e.message);
}

// Cas 10 : Dépendance hors bornes négative
try {
  parseAndValidatePlan(JSON.stringify({
    title: "Dep négative",
    tasks: [{ title: "Tâche 1", dependsOn: [-1] }],
  }));
  ok(false, "Cas 10 : Dépendance négative non rejetée");
} catch (e) {
  ok(e.message.includes("hors bornes"), "Cas 10 : Rejet de dépendance négative", e.message);
}

// Cas 11 : Dépendance hors bornes supérieure ou égale à N
try {
  parseAndValidatePlan(JSON.stringify({
    title: "Dep hors bornes haute",
    tasks: [{ title: "Tâche 1", dependsOn: [5] }],
  }));
  ok(false, "Cas 11 : Dépendance hors bornes haute non rejetée");
} catch (e) {
  ok(e.message.includes("hors bornes"), "Cas 11 : Rejet de dépendance hors bornes haute", e.message);
}

// Cas 12 : Dépendance circulaire (tâche dépendant d'elle-même)
try {
  parseAndValidatePlan(JSON.stringify({
    title: "Auto-dépendance",
    tasks: [
      { title: "Tâche 0", dependsOn: [] },
      { title: "Tâche 1", dependsOn: [1] },
    ],
  }));
  ok(false, "Cas 12 : Auto-dépendance non rejetée");
} catch (e) {
  ok(e.message.includes("circulaire"), "Cas 12 : Rejet d'auto-dépendance", e.message);
}

// =========================================================================
// PARTIE B & C : Test WebSocket réel et sécurité
// =========================================================================
console.log("\n--- PARTIE B & C : Test WebSocket réel, sécurité et cycle de vie ---");

const url = process.env.DASHBOARD_VERIFY_URL || "ws://127.0.0.1:7070/ui";
const origin = new URL(url).origin.replace("ws:", "http:").replace("wss:", "https:");

const ws = new WebSocket(url, { origin });
const inbox = [];
let keyLeakDetected = false;

ws.on("message", (raw) => {
  const text = raw.toString();
  if (KEY_PATTERN.test(text)) {
    keyLeakDetected = true;
    console.error("FAIL : Clé d'API secrète détectée dans le flux WebSocket !");
  }
  try {
    const msg = JSON.parse(text);
    if (msg.type !== "state") inbox.push(msg);
  } catch {}
});

async function next(pred, label, timeout = 65000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const idx = inbox.findIndex(pred);
    if (idx >= 0) return inbox.splice(idx, 1)[0];
    await delay(50);
  }
  throw new Error(`Délai dépassé (${timeout} ms) : ${label}`);
}

const sendWs = (msg) => {
  inbox.length = 0;
  ws.send(JSON.stringify(msg));
};

try {
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  ok(true, "Connexion WebSocket établie avec le dashboard");

  // Test 1 : Rejet texte vide
  sendWs({ type: "voiceplan.generate", text: "" });
  const errEmpty = await next((m) => m.type === "voiceplan.error" || m.type === "error", "erreur texte vide", 5000);
  ok(Boolean(errEmpty), "Rejet du texte vide avec message d'erreur", errEmpty.error || errEmpty.message);

  // Test 2 : Rejet texte > 4000 caractères
  sendWs({ type: "voiceplan.generate", text: "X".repeat(4001) });
  const errLong = await next((m) => m.type === "voiceplan.error" || m.type === "error", "erreur texte trop long", 5000);
  ok(
    (errLong.error || errLong.message || "").includes("4000"),
    "Rejet du texte dépassant 4000 caractères",
    errLong.error || errLong.message
  );

  // Test 3 : Génération réelle avec 3 idées
  const sampleVoiceText =
    "Premièrement, configurer le dépôt et initialiser les dépendances. " +
    "Deuxièmement, implémenter les endpoints de l'API de gestion des utilisateurs. " +
    "Troisièmement, rédiger les tests unitaires et d'intégration avant déploiement.";

  console.log("Envoi de la demande de génération de plan (3 idées)...");
  sendWs({
    type: "voiceplan.generate",
    text: sampleVoiceText,
    project: "sandbox-repo",
    host: "local",
  });

  const reply = await next(
    (m) => m.type === "voiceplan.created" || m.type === "voiceplan.error" || m.type === "error",
    "réponse génération voiceplan",
    65000
  );

  if (reply.type === "voiceplan.created") {
    ok(Boolean(reply.itemId), "Plan créé avec succès via l'IA", `itemId = ${reply.itemId}`);
    // Vérifier l'apparition dans l'inbox
    sendWs({ type: "inbox.list" });
    const listMsg = await next((m) => m.type === "inbox.list", "liste inbox", 5000);
    const item = (listMsg.items || []).find((i) => i.id === reply.itemId);
    ok(Boolean(item), "L'élément de plan apparaît dans la liste inbox");
    ok(item && item.kind === "plan", "L'élément est de type 'plan'");
    ok(item && item.source === "voix", "La source de l'élément est 'voix'");
    ok(
      item && Array.isArray(item.tasks) && item.tasks.length >= 2,
      "Le plan contient >= 2 tâches",
      `${item?.tasks?.length} tâches`
    );

    // Nettoyage : marquer le plan comme traité
    sendWs({ type: "inbox.mark", ids: [reply.itemId], status: "traité" });
    await next((m) => m.type === "inbox.marked", "marquage traité");
    ok(true, "Nettoyage : plan marqué comme traité");
  } else {
    // Fournisseur ou clé indisponible : repli propre avec erreur claire
    const errMsg = reply.error || reply.message || "";
    ok(
      errMsg.length > 0 &&
      (errMsg.includes("clé") || errMsg.includes("Délai") || errMsg.includes("JSON") || errMsg.includes("Échec")),
      "Repli propre avec message d'erreur clair en français (clé/fournisseur indisponible)",
      errMsg
    );
    console.log(`[INFO FOURNISSEUR] Repli honnête vérifié : "${errMsg}"`);
  }

  // Vérification de sécurité (c) : aucune clé dans le trafic
  ok(!keyLeakDetected, "Sécurité : aucune clé secrète détectée dans les messages WebSocket");
} catch (e) {
  ok(false, "Exception WebSocket", e.message);
} finally {
  ws.close();
}

console.log(fails ? `\nÉCHECS TOTAUX : ${fails}` : "\nTOUS LES TESTS VOICEPLAN SONT PASSÉS AVEC SUCCÈS.");
process.exit(fails ? 1 : 0);
