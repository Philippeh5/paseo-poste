// dashboard/lib/tgagents.mjs — Table des agents du poste (Telegram).
// Contient la liste fixe des 7 agents (AGENTS), la génération de leur avatar SVG (cercle coloré + initiale),
// et le rendu en PNG via playwright-core + chromium (avatarPng). Pas de dépendance réseau.
// Importé par tguser.mjs (upload avatar BotFather) et par les outils de setup.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Table des agents (ordre = ordre de création des bots)
// ---------------------------------------------------------------------------

/** @type {Array<{id:string, nom:string, emoji:string, couleur:string, role:string}>} */
export const AGENTS = [
  { id: "vigie",         nom: "Vigie",         emoji: "🛰️", couleur: "#0EA5E9", role: "surveille le poste (CI, services, disque, quota)" },
  { id: "relecteur",    nom: "Relecteur",     emoji: "🔍", couleur: "#8B5CF6", role: "relit et fusionne le travail des agents" },
  { id: "batisseur",    nom: "Bâtisseur",     emoji: "🔨", couleur: "#F59E0B", role: "code les missions et ouvre les PR" },
  { id: "eclaireur",    nom: "Éclaireur",     emoji: "💡", couleur: "#22C55E", role: "propose des idées pour le projet" },
  { id: "concierge",    nom: "Concierge",     emoji: "🧹", couleur: "#64748B", role: "fait le ménage (branches, worktrees, sessions)" },
  { id: "recap",        nom: "Récap",         emoji: "☀️", couleur: "#EAB308", role: "envoie le récap du matin" },
  { id: "orchestrateur",nom: "Orchestrateur", emoji: "🧭", couleur: "#EF4444", role: "ton interlocuteur dans chaque projet : il répond et distribue le travail" },
];

// ---------------------------------------------------------------------------
// Génération SVG
// ---------------------------------------------------------------------------

/**
 * Retourne un SVG 512×512 : cercle coloré avec la première lettre de l'agent en blanc gras.
 * Aucun emoji : le serveur peut manquer de polices emoji.
 * @param {{ id:string, nom:string, couleur:string }} agent
 * @returns {string} contenu SVG
 */
export function avatarSvg(agent) {
  // Première lettre en majuscule, insensible aux accents (Bâtisseur → B, Éclaireur → É)
  const lettre = (agent.nom || agent.id).charAt(0).toUpperCase();
  const couleur = agent.couleur || "#666666";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <circle cx="256" cy="256" r="256" fill="${couleur}"/>
  <text x="256" y="256"
    font-family="Arial,Helvetica,sans-serif"
    font-size="280"
    font-weight="bold"
    fill="white"
    text-anchor="middle"
    dominant-baseline="central">${lettre}</text>
</svg>`;
}

// ---------------------------------------------------------------------------
// Rendu PNG via playwright-core + chromium
// ---------------------------------------------------------------------------

/**
 * Rend le SVG de l'agent en PNG 512×512 et l'écrit dans `outFile`.
 * Lance chromium en mode headless via playwright-core.
 * Lève une erreur claire si chromium n'est pas disponible.
 * @param {{ id:string, nom:string, couleur:string }} agent
 * @param {string} outFile  chemin absolu du fichier PNG de sortie
 * @returns {Promise<void>}
 */
export async function avatarPng(agent, outFile) {
  // Chercher playwright-core (chemin npm standard + chemin Windows de Philippe)
  let playwright = null;
  for (const p of [
    "playwright-core",
    "file:///C:/Users/Philippe/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core/index.mjs",
  ]) {
    try { playwright = await import(p); break; } catch { /* essai suivant */ }
  }
  if (!playwright) throw new Error("playwright-core introuvable — installe-le via npm i -D playwright-core");

  const svg = avatarSvg(agent);
  // On encode en data URI pour éviter d'écrire un fichier intermédiaire
  const dataUri = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);

  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 512, height: 512 });
    // Fond transparent via CSS body + chargement du SVG
    await page.setContent(
      `<!DOCTYPE html><html><head><style>*{margin:0;padding:0}body{background:transparent;width:512px;height:512px;overflow:hidden}</style></head>` +
      `<body><img src="${dataUri}" width="512" height="512"/></body></html>`
    );
    await page.evaluate(() => document.querySelector("img").decode()); // attend le décodage du SVG avant la capture
    mkdirSync(dirname(outFile), { recursive: true });
    await page.screenshot({ path: outFile, clip: { x: 0, y: 0, width: 512, height: 512 } });
  } finally {
    await browser.close();
  }
}
