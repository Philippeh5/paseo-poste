// Page « Connexions » (serveur) : état des outils/fournisseurs/services de CETTE machine, installation par commande fixe,
// clés d'API (stockées en 600 dans data/connections.env, jamais renvoyées), skills partagés entre agents.
// Messages : connections.get -> connections.state {groups, items, skills, at}
//   connections.install {id, confirm:true}   connections.setKey {id, value, confirm:true}   connections.removeKey {id, confirm:true}
//   connections.login {id, confirm:true} -> ouvre un terminal du Bureau et y saisit la commande de connexion du CATALOGUE
//   (réponse connections.loginStarted {id, host, terminalId}) ; jamais de commande libre venant du navigateur
//   connections.skills.link {target?, confirm:true}   connections.skills.import {path, confirm:true}
// Réponse aux actions : connections.done {action, id, ok, message} puis diffusion connections.state. Test : verify-connections.mjs
import { homedir } from "node:os";
import { SELF_HOST } from "../lib/selfhost.mjs";
import { policyFile, readPolicy, ensurePolicy, listAccounts, summarize, setAgent, removeAgent } from "../lib/composio-admin.mjs";
import { detectAll, detectOne, getEntry, loginCommand, install, writeEnvKey, removeEnvKey, skillsStatus, linkSkills, importSkill, SKILL_TARGETS } from "../lib/connections.mjs";

const HOME = homedir();

export function register(ctx) {
  const { onMessage, send, sendError, broadcast, log } = ctx;
  let busy = false;

  async function snapshot() {
    const base = await detectAll({ dataDir: ctx.dataDir });
    return { ...base, skills: skillsStatus(), at: Date.now() };
  }
  const needConfirm = (ws, m) => { if (m.confirm !== true) { sendError(ws, "Confirmation requise (confirm: true)."); return false; } return true; };

  onMessage("connections.get", async (ws, m) => send(ws, { type: "connections.state", ...(await snapshot()), ref: m.ref ?? null }));

  onMessage("connections.install", async (ws, m) => {
    if (!needConfirm(ws, m)) return;
    if (busy) return sendError(ws, "Une installation est déjà en cours.");
    busy = true;
    try {
      const out = await install(m.id);
      log("connections", `installé : ${m.id}`);
      send(ws, { type: "connections.done", action: "install", id: m.id, ok: true, message: out.output || "Installé." });
    } catch (e) {
      send(ws, { type: "connections.done", action: "install", id: m.id, ok: false, message: ctx.safeError(e) });
    } finally { busy = false; }
    broadcast({ type: "connections.state", ...(await snapshot()) });
  });

  // Connexion : terminal sur cette machine, commande prise dans le catalogue (liste fermée) ; l'utilisateur termine dans le terminal.
  onMessage("connections.login", async (ws, m) => {
    if (!needConfirm(ws, m)) return;
    const entry = getEntry(m.id);
    const cmd = loginCommand(entry);
    if (!entry || entry.kind === "key" || !cmd) return sendError(ws, "Ce connecteur n'a pas de commande de connexion.");
    if ((await detectOne(entry, { dataDir: ctx.dataDir })).status === "missing") return sendError(ws, `${entry.label} n'est pas installé.`);
    const host = SELF_HOST;
    const r = await ctx.invoke("launch.start", { ref: `conn-login-${entry.id}-${Date.now().toString(36)}`, host, cwd: HOME, kind: "terminal" }, { timeoutMs: 30_000 });
    const started = r.replies?.find((x) => x.type === "launch.started");
    if (r.error || !started?.terminalId) return sendError(ws, `Le terminal n'a pas démarré : ${r.error || "pas de réponse"}`);
    await new Promise((res) => setTimeout(res, 1500));
    const t = await ctx.invoke("term.input", { host, terminalId: started.terminalId, data: `${cmd}\r` }, { timeoutMs: 10_000 });
    if (t.error) return sendError(ws, `Terminal ouvert mais commande non saisie : ${t.error}`);
    log("connections", `connexion lancée dans un terminal : ${entry.id}`);
    send(ws, { type: "connections.loginStarted", id: entry.id, host: started.host ?? host, terminalId: started.terminalId, cwd: HOME });
  });

  onMessage("connections.setKey", async (ws, m) => {
    if (!needConfirm(ws, m)) return;
    const entry = getEntry(m.id);
    if (!entry || entry.kind !== "key") return sendError(ws, "Ce connecteur n'utilise pas de clé d'API.");
    try {
      writeEnvKey(ctx.dataDir, entry.envVar, m.value);
      log("connections", `clé enregistrée : ${entry.envVar}`);
      send(ws, { type: "connections.done", action: "setKey", id: entry.id, ok: true, message: "Clé enregistrée (fichier 600, jamais réaffichée)." });
    } catch (e) { return sendError(ws, ctx.safeError(e)); }
    broadcast({ type: "connections.state", ...(await snapshot()) });
  });

  onMessage("connections.removeKey", async (ws, m) => {
    if (!needConfirm(ws, m)) return;
    const entry = getEntry(m.id);
    if (!entry || entry.kind !== "key") return sendError(ws, "Ce connecteur n'utilise pas de clé d'API.");
    const had = removeEnvKey(ctx.dataDir, entry.envVar);
    send(ws, { type: "connections.done", action: "removeKey", id: entry.id, ok: true, message: had ? "Clé supprimée." : "Aucune clé à supprimer." });
    broadcast({ type: "connections.state", ...(await snapshot()) });
  });

  onMessage("connections.skills.link", async (ws, m) => {
    if (!needConfirm(ws, m)) return;
    if (m.target && !SKILL_TARGETS.some((t) => t.id === m.target)) return sendError(ws, "Agent inconnu.");
    try {
      const r = linkSkills({ only: m.target || null });
      send(ws, { type: "connections.done", action: "skills.link", id: m.target || "all", ok: true, message: `${r.created.length} lien(s) créé(s), ${r.skipped.length} déjà présent(s).` });
    } catch (e) { return sendError(ws, ctx.safeError(e)); }
    broadcast({ type: "connections.state", ...(await snapshot()) });
  });

  onMessage("connections.skills.import", async (ws, m) => {
    if (!needConfirm(ws, m)) return;
    try {
      const name = importSkill(String(m.path || ""));
      send(ws, { type: "connections.done", action: "skills.import", id: name, ok: true, message: `Skill « ${name} » ajouté au dossier partagé.` });
    } catch (e) { return sendError(ws, ctx.safeError(e)); }
    broadcast({ type: "connections.state", ...(await snapshot()) });
  });

  // ---- Composio : comptes connectés + matrice agent × application (link / scripts jamais accordés d'ici)
  const composioState = async () => {
    let accounts = []; let error = null;
    try { accounts = await listAccounts(); } catch (e) { error = ctx.safeError(e); }
    let policy; try { policy = summarize(readPolicy(policyFile(ctx.dataDir))); } catch (e) { policy = { exists: false, agents: [] }; error = error || ctx.safeError(e); }
    return { accounts, policy, error };
  };
  onMessage("composio.get", async (ws, m) => send(ws, { type: "composio.state", ...(await composioState()), ref: m.ref ?? null }));
  const composioChanged = async () => broadcast({ type: "composio.state", ...(await composioState()) });
  onMessage("composio.ensurePolicy", async (ws, m) => {
    if (!needConfirm(ws, m)) return;
    try { const created = ensurePolicy(policyFile(ctx.dataDir)); send(ws, { type: "connections.done", action: "composio", id: "composio", ok: true, message: created ? "Politique créée : tout est refusé tant que vous n'accordez rien." : "Une politique existe déjà, rien n'a été modifié." }); }
    catch (e) { return sendError(ws, ctx.safeError(e)); }
    await composioChanged();
  });
  onMessage("composio.setAgent", async (ws, m) => {
    if (!needConfirm(ws, m)) return;
    try { setAgent(policyFile(ctx.dataDir), { agent: m.agent, toolkits: m.toolkits, writes: m.writes }); log("composio", `politique mise à jour : ${m.agent}`);
      send(ws, { type: "connections.done", action: "composio", id: String(m.agent), ok: true, message: `Accès de « ${m.agent} » enregistré.` }); }
    catch (e) { return sendError(ws, ctx.safeError(e)); }
    await composioChanged();
  });
  onMessage("composio.removeAgent", async (ws, m) => {
    if (!needConfirm(ws, m)) return;
    try { removeAgent(policyFile(ctx.dataDir), String(m.agent)); } catch (e) { return sendError(ws, ctx.safeError(e)); }
    await composioChanged();
  });

  ctx.apiRoute?.("GET", "/connections", () => snapshot());
}
