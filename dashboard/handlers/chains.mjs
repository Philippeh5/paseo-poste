// Chaînes d'agents (T40) : enchaînements automatiques d'agents de base
// (plan -> relecture du plan -> dev -> relecture -> test). Quand une tâche de la chaîne est terminée, la suivante
// démarre toute seule (règle de workflow de handlers/tasks.mjs).
// Persisté dans data/agent-chains.json. Chaque étape est un agent de base (handlers/profiles.mjs) du même identifiant.
// Messages WS : chain.list (→ chain.list {chains}), chain.save {chain}, chain.delete {id}, chain.reset ;
// diffusion chain.list.
// chain.run {chain, project, host?, mission} → chain.started {runId, taskIds} : crée une tâche par étape (dépendance
// sur la précédente, démarrage automatique) par `task.create` ; la première démarre tout de suite. Le projet est un
// dossier suivi (nom affiché, nom du dossier ou chemin complet), résolu comme pour le mode Agent.
import { randomUUID } from "node:crypto";

import { SELF_HOST, SELF_LABEL, isSelfHost } from "../lib/selfhost.mjs";
const FILE = "agent-chains";
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX = { name: 60, description: 200, steps: 12, chains: 30, mission: 2000, title: 60 };

export const DEFAULT_CHAINS = [
  { id: "feature", name: "Nouvelle fonction",
    description: "Plan, relecture du plan, développement, relecture du code, tests.",
    steps: ["plan", "plan-review", "dev", "review", "test"] },
  { id: "bugfix", name: "Correction de bug", description: "Correction, tests, relecture du code.",
    steps: ["dev", "test", "review"] },
  { id: "audit", name: "Audit", description: "Relecture seule du projet, sans modification.", steps: ["review"] },
  { id: "verified", name: "Développement vérifié",
    description: "Développement puis vérification aveugle (PASS / FAIL).", steps: ["dev", "verifier"] },
].map((c) => ({ builtin: true, ...c }));

const clean = (value, max) =>
  String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").trim().slice(0, max);
const slashes = (path) => String(path ?? "").replace(/\\/g, "/");
const baseName = (dir) => slashes(dir).replace(/\/+$/, "").split("/").pop();
const strip = (message) => String(message ?? "").replace(/^Erreur\s*:\s*/, "");

export function normalize(raw, { builtin = false } = {}) {
  const id = clean(raw?.id, 40).toLowerCase();
  if (!ID.test(id)) {
    return { error: "identifiant de chaîne invalide (minuscules, chiffres et tirets, 40 caractères au plus)" };
  }
  const name = clean(raw.name, MAX.name);
  if (!name) return { error: "le nom de la chaîne est obligatoire" };
  if (!Array.isArray(raw.steps) || !raw.steps.length) return { error: "une chaîne a besoin d'au moins une étape" };
  if (raw.steps.length > MAX.steps) return { error: `une chaîne ne peut pas dépasser ${MAX.steps} étapes` };
  const steps = raw.steps.map((s) => clean(s, 40).toLowerCase());
  if (steps.some((s) => !ID.test(s))) return { error: "étape invalide : indiquez l'identifiant d'un agent de base" };
  return { chain: { id, name, description: clean(raw.description, MAX.description), steps, builtin } };
}

export function register(ctx) {
  const { onMessage, send, broadcast, sendError, store } = ctx;

  const load = () => {
    const saved = store.read(FILE, null);
    if (!saved || !Array.isArray(saved.chains)) return DEFAULT_CHAINS.map((c) => ({ ...c, steps: [...c.steps] }));
    return saved.chains.map((c) => normalize(c, { builtin: Boolean(c?.builtin) }).chain).filter(Boolean);
  };
  let chains = load();
  const persist = () => store.write(FILE, { chains });
  const announce = () => broadcast({ type: "chain.list", chains });

  // Dossier suivi correspondant au nom ou au chemin demandé (comme agentmode.mjs), éventuellement sur une machine.
  async function resolveProject(name, host) {
    const result = await ctx.invoke("project.list", {});
    const list = result.replies.find((r) => r.type === "project.list")?.projects || [];
    const wanted = slashes(name).replace(/\/+$/, "").toLowerCase();
    const matches = list.filter((p) => (!host || p.host === host) && (
      String(p.name || "").toLowerCase() === wanted || baseName(p.dir).toLowerCase() === wanted ||
      slashes(p.dir).replace(/\/+$/, "").toLowerCase() === wanted));
    return matches.find((p) => isSelfHost(p.host)) || matches[0] || null;
  }

  // Supprime ce qui a été créé si la création d'une étape échoue (la première a pu démarrer : on l'arrête d'abord).
  async function rollback(ids) {
    for (const id of [...ids].reverse()) {
      await ctx.invoke("task.stop", { id }).catch(() => {});
      await ctx.invoke("task.delete", { id }).catch(() => {});
    }
  }

  async function run(ws, m) {
    const chain = chains.find((c) => c.id === String(m.chain ?? "").toLowerCase());
    if (!chain) return sendError(ws, "chaîne inconnue : choisissez une chaîne de la liste");
    const mission = clean(m.mission, MAX.mission + 1);
    if (!mission) return sendError(ws, "la mission est obligatoire : décrivez ce que la chaîne doit faire");
    if (mission.length > MAX.mission) {
      return sendError(ws, `la mission ne doit pas dépasser ${MAX.mission} caractères`);
    }
    const projectName = clean(m.project, 1000);
    if (!projectName) return sendError(ws, "choisissez le projet sur lequel la chaîne doit travailler");
    const host = m.host == null || m.host === "" ? "" : clean(m.host, 100);
    const target = await resolveProject(projectName, host);
    if (!target) {
      return sendError(ws, `le projet « ${projectName} » n'est pas dans les projets suivis. ` +
        "Suivez d'abord ce dossier (vue Projets).");
    }
    const steps = chain.steps.map((id) => ctx.profiles?.get(id) || null);
    const missing = chain.steps.filter((_, i) => !steps[i]);
    if (missing.length) {
      const names = [...new Set(missing)].join(", ");
      return sendError(ws, `agent de base inconnu dans la chaîne « ${chain.name} » : ${names}`);
    }

    const runId = randomUUID();
    const first = mission.split("\n")[0].slice(0, MAX.title);
    const taskIds = [];
    for (const [i, profile] of steps.entries()) {
      const context = `Étape ${i + 1}/${steps.length} de la chaîne « ${chain.name} » (${profile.name}).` +
        (i ? " Les étapes précédentes ont déjà travaillé sur ce projet : retrouve leur travail dans les fichiers" +
          " (git status, git diff)." : "");
      const created = await ctx.invoke("task.create", {
        profile: profile.id, title: `${profile.name} — ${first}`, description: `${mission}\n\n${context}`,
        project: target.dir, host: target.host, deps: i ? [taskIds[i - 1]] : [], chain: runId, autostart: true,
      });
      const id = created.replies.find((r) => r.type === "task.created")?.id;
      if (created.error || !id) {
        await rollback(taskIds);
        return sendError(ws, `la chaîne n'a pas pu être créée : ${strip(created.error) || "tâche non créée"}`);
      }
      taskIds.push(id);
    }
    ctx.log?.("chains", `chaîne ${chain.id} lancée (${taskIds.length} tâche(s), exécution ${runId.slice(0, 8)})`);
    send(ws, { type: "chain.started", runId, chain: chain.id, taskIds });
  }

  onMessage("chain.list", (ws) => send(ws, { type: "chain.list", chains }));
  onMessage("chain.run", async (ws, m) => {
    try {
      await run(ws, m);
    } catch (error) {
      sendError(ws, `la chaîne n'a pas pu être lancée : ${ctx.safeError ? ctx.safeError(error) : error.message}`);
    }
  });
  onMessage("chain.save", (ws, m) => {
    const existing = chains.find((c) => c.id === String(m.chain?.id ?? "").toLowerCase());
    const found = normalize(m.chain, { builtin: Boolean(existing?.builtin) });
    if (found.error) return sendError(ws, found.error);
    const at = chains.findIndex((c) => c.id === found.chain.id);
    if (at < 0 && chains.length >= MAX.chains) return sendError(ws, `maximum ${MAX.chains} chaînes`);
    if (at >= 0) chains[at] = found.chain;
    else chains.push(found.chain);
    persist();
    announce();
  });
  onMessage("chain.delete", (ws, m) => {
    const before = chains.length;
    chains = chains.filter((c) => c.id !== String(m.id ?? "").toLowerCase());
    if (chains.length === before) return sendError(ws, "chaîne introuvable");
    persist();
    announce();
  });
  onMessage("chain.reset", () => {
    // Restaure les chaînes par défaut sans toucher à celles créées par Philippe.
    const custom = chains.filter((c) => !DEFAULT_CHAINS.some((d) => d.id === c.id));
    chains = [...DEFAULT_CHAINS.map((c) => ({ ...c, steps: [...c.steps] })), ...custom];
    persist();
    announce();
  });

  ctx.chains = { list: () => chains.map((c) => ({ ...c, steps: [...c.steps] })) };
}
