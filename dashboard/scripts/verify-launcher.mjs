// Vérifie la gestion des favoris et le type LLM direct (handlers/favorites.mjs, handlers/llmchat.mjs).
// Usage : node dashboard/scripts/verify-launcher.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

const url = process.env.DASHBOARD_VERIFY_URL || "ws://127.0.0.1:7070/ui";
const origin = new URL(url).origin.replace("ws:", "http:").replace("wss:", "https:");
const favFile = process.env.VERIFY_FIXTURE_DIR ? `${process.env.VERIFY_FIXTURE_DIR}/data/model-favorites.json` : fileURLToPath(new URL("../data/model-favorites.json", import.meta.url));

const socket = new WebSocket(url, { origin });
const inbox = [];
let opened = false;

const KEY_PATTERN = /\bsk-[a-zA-Z0-9_\-\.]{8,}/;

socket.on("open", () => { opened = true; });
socket.on("message", (raw) => {
  const text = raw.toString();
  if (KEY_PATTERN.test(text)) {
    throw new Error("Clé secrète d'API détectée dans un message WebSocket !");
  }
  try {
    inbox.push(JSON.parse(text));
  } catch (e) {
    console.error("Message non JSON reçu :", text);
  }
});

const fail = (message) => { throw new Error(message); };

const send = (message) => {
  inbox.length = 0;
  socket.send(JSON.stringify(message));
};

async function receive(type, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const index = inbox.findIndex((m) => m.type === type);
    if (index >= 0) return inbox.splice(index, 1)[0];
    await delay(50);
  }
  return fail(`Délai dépassé (${timeout} ms) : ${label}`);
}

const expect = (condition, label, detail = "") => {
  if (!condition) fail(`${label} ${detail}`);
  console.log(`OK ${label}`);
};

try {
  for (let i = 0; i < 100 && !opened; i++) await delay(50);
  expect(opened, "connexion au dashboard");

  // 1. favorites.get
  send({ type: "favorites.get" });
  const getRes = await receive("favorites.list", "réponse favorites.list après favorites.get");
  expect(getRes && typeof getRes.favorites === "object", "favorites.get renvoie une liste de favoris");
  expect(Array.isArray(getRes.favorites["claude-openrouter"]), "favorites contient claude-openrouter");

  // 2. favorites.toggle et persistance sur disque
  const testModel = `test-model-${Date.now().toString(36)}`;
  send({ type: "favorites.toggle", provider: "claude-openrouter", modelId: testModel });
  const tog1 = await receive("favorites.list", "réponse favorites.list après toggle ajout");
  expect(tog1.favorites["claude-openrouter"].includes(testModel), "toggle ajoute le modèle aux favoris en mémoire");

  // Relecture directe du fichier model-favorites.json
  const fileContent1 = JSON.parse(readFileSync(favFile, "utf8"));
  expect(
    Array.isArray(fileContent1["claude-openrouter"]) && fileContent1["claude-openrouter"].includes(testModel),
    "toggle favori persiste après relecture du fichier"
  );

  // Toggle retrait
  send({ type: "favorites.toggle", provider: "claude-openrouter", modelId: testModel });
  const tog2 = await receive("favorites.list", "réponse favorites.list après toggle retrait");
  expect(!tog2.favorites["claude-openrouter"].includes(testModel), "toggle retire le modèle des favoris en mémoire");

  const fileContent2 = JSON.parse(readFileSync(favFile, "utf8"));
  expect(
    Array.isArray(fileContent2["claude-openrouter"]) && !fileContent2["claude-openrouter"].includes(testModel),
    "retrait du favori persiste après relecture du fichier"
  );

  // 3. Validation favorites.toggle sans arguments requis
  send({ type: "favorites.toggle", provider: "" });
  const errRes = await receive("error", "erreur attendue pour toggle incomplet");
  expect(errRes.message.includes("fournisseur et modèle requis"), "toggle rejette les arguments vides");

  // 4. llm.models
  send({ type: "llm.models" });
  const modelsRes = await receive("llm.models", "réponse llm.models");
  expect(Array.isArray(modelsRes.providers) && modelsRes.providers.length >= 2, "llm.models liste au moins 2 fournisseurs");
  const or = modelsRes.providers.find((p) => p.id === "openrouter");
  const nv = modelsRes.providers.find((p) => p.id === "nvidia");
  expect(Boolean(or && nv), "llm.models contient openrouter et nvidia");

  // 5. llm.chat : appel avec modèle gratuit OpenRouter
  const chatId = `pong-${Date.now().toString(36)}`;
  send({
    type: "llm.chat",
    id: chatId,
    provider: "openrouter",
    model: "poolside/laguna-s-2.1:free",
    messages: [{ role: "user", content: "Reply with the single word PONG and nothing else." }],
  });
  const chatRes = await receive("llm.reply", "réponse llm.reply à llm.chat", 35000);
  expect(chatRes.id === chatId, "llm.reply correspond à l'identifiant de la demande");
  if (chatRes.ok) {
    const text = String(chatRes.text || chatRes.reply || "");
    expect(text.length > 0, `llm.chat réponse réelle reçue (${text.slice(0, 40).trim()})`);
  } else {
    const err = String(chatRes.error || "");
    expect(err.length > 0, `llm.chat échec propre reçu (${err.slice(0, 60)})`);
  }

  // 6. llm.chat validation : sans fournisseur
  send({ type: "llm.chat", id: "err-test", provider: "", model: "test", messages: "salut" });
  const chatErr = await receive("llm.reply", "réponse llm.reply pour fournisseur manquant");
  expect(chatErr.ok === false && chatErr.error.includes("Fournisseur non spécifié"), "llm.chat rejette fournisseur manquant");

  // 7. Vérification finale sécurité : aucune clé dans le trafic
  console.log("OK aucune clé d'API présente dans les messages échangés");

  console.log("\nTOUS LES TESTS DU LANCEUR ET DU LLM DIRECT SONT PASSÉS AVEC SUCCÈS.");
} finally {
  socket.close();
}
