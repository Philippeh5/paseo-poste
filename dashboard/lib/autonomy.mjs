// Autonomie par projet (PLAN-AUTONOMIE.md, phase 3). Fonctions pures : modes, échéances du battement de cœur,
// choix du moteur selon l'heure (quota Claude), récap à la demande, consigne du cerveau. Aucun effet de bord.

export const MODES = ["off", "ideas", "auto"]; // Arrêt · Idées (attend la validation) · Autonome
export const DEFAULTS = { mode: "off", heartbeatMin: 60 };
export const MIN_HEARTBEAT = 10, MAX_HEARTBEAT = 24 * 60;
export const NIGHT = { startHour: 0, endHour: 8, tz: "Europe/Paris" }; // fenêtre où Claude est utilisable à fond

export const normalizeProject = (p = {}) => ({
  mode: MODES.includes(p.mode) ? p.mode : DEFAULTS.mode,
  heartbeatMin: Number.isInteger(p.heartbeatMin) ? Math.min(Math.max(p.heartbeatMin, MIN_HEARTBEAT), MAX_HEARTBEAT) : DEFAULTS.heartbeatMin,
  lastBeat: typeof p.lastBeat === "number" ? p.lastBeat : 0,
  lastCiRun: p.lastCiRun ?? null,
});

/** Heure locale (0-23) dans le fuseau donné. */
export const hourIn = (now, tz = NIGHT.tz) => Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: tz }).format(now)) % 24;
export const dayKeyIn = (now, tz = NIGHT.tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);

export const isNight = (now, w = NIGHT) => { const h = hourIn(now, w.tz); return w.startHour <= w.endHour ? h >= w.startHour && h < w.endHour : h >= w.startHour || h < w.endHour; };

/**
 * Moteur du cerveau : la nuit Claude (abonnement) ; le jour on garde une réserve pour Philippe → modèles gratuits,
 * sauf si l'usage Claude de la fenêtre est connu et sous le seuil (usageRatio 0..1, reserve = part gardée, 0.3 par défaut).
 */
export function chooseEngine(now, { usageRatio = null, reserve = 0.3, window = NIGHT, claudeOk = true } = {}) {
  if (!claudeOk) return { engine: "free", why: "quota Claude épuisé" };
  if (isNight(now, window)) return { engine: "claude", why: "nuit : tout le quota Claude est disponible" };
  if (usageRatio != null && usageRatio < 1 - reserve) return { engine: "claude", why: `jour, usage Claude bas (${Math.round(usageRatio * 100)} %)` };
  return { engine: "free", why: "jour : réserve Claude gardée pour Philippe" };
}

/** Le battement de ce projet est-il dû ? (mode ≠ off, intervalle écoulé) */
export const isDue = (cfg, now) => { const c = normalizeProject(cfg); return c.mode !== "off" && now - c.lastBeat >= c.heartbeatMin * 60_000; };

/** Récap à la demande (/recap), sans LLM : fait / bloqué / idées en attente / prévu. */
export function recapText({ tasks = [], ideas = [], guardRefusals = 0, projects = {}, since }) {
  const done = tasks.filter((t) => t.status === "done" && (!since || new Date(t.updatedAt || t.doneAt || 0).getTime() >= since));
  const blocked = tasks.filter((t) => t.status === "blocked");
  const doing = tasks.filter((t) => t.status === "doing" || t.status === "review");
  const todo = tasks.filter((t) => t.status === "todo");
  const pending = ideas.filter((i) => i.status === "pending");
  const approved = ideas.filter((i) => i.status === "approved");
  const stale = pending.filter((i) => Date.now() - (i.createdAt || 0) > STALE_IDEA_MS);
  const modes = Object.entries(projects).filter(([, p]) => p.mode && p.mode !== "off").map(([d, p]) => `${d.split("/").pop()} (${p.mode === "auto" ? "autonome" : "idées"})`);
  const line = (label, list, fmt = (t) => t.title) => (list.length ? `${label} (${list.length}) :\n${list.slice(0, 6).map((t) => `• ${fmt(t)}`).join("\n")}${list.length > 6 ? `\n• … +${list.length - 6}` : ""}` : `${label} : rien`);
  return [
    "📋 Récap",
    line("✅ Fait", done), line("⛔ Bloqué", blocked), line("🔄 En cours", doing),
    line("💡 Idées à valider", pending, (i) => `${i.project?.split("/").pop() || "?"} — ${i.title}`),
    stale.length ? `⏳ À trancher : ${stale.length} idée(s) en attente depuis plus de 3 jours (${stale.slice(0, 3).map((i) => i.title).join(" · ")}${stale.length > 3 ? " …" : ""})` : null,
    approved.length ? line("👍 Idées validées à réaliser", approved, (i) => i.title) : null,
    todo.length ? `📋 Prévu : ${todo.length} tâche(s) à faire` : null,
    modes.length ? `Projets suivis par le cerveau : ${modes.join(", ")}` : "Aucun projet n'est en mode Idées ou Autonome.",
    guardRefusals ? `🛡️ Garde-fous : ${guardRefusals} action(s) refusée(s) cette nuit` : null,
  ].filter(Boolean).join("\n\n");
}

const ago = (ms) => { const h = Math.floor(ms / 3600_000); return h < 1 ? "moins d'1 h" : h < 48 ? `${h} h` : `${Math.floor(h / 24)} j`; };
/** Tâches « À valider » / « En cours » du projet, pour la consigne (titre, branche, ancienneté). */
export function formatTasks(tasks = [], ideas = [], now = Date.now()) {
  const lines = tasks.filter((t) => t.status === "review" || t.status === "doing").map((t) => {
    const idea = ideas.find((i) => i.taskId === t.id);
    return `- [${t.id.slice(0, 8)}] ${t.status === "review" ? "À VALIDER" : "EN COURS (un agent y travaille peut-être : n'y touche pas)"} : ${t.title}${t.branch ? ` — branche ${t.branch}` : ""} — depuis ${ago(now - new Date(t.updatedAt || now).getTime())}${idea ? ` — idée validée [${idea.id}]` : ""}`;
  });
  return lines.join("\n");
}
/** PR ouvertes de branches agent/* (sortie de gh pr list --json number,title,headRefName,updatedAt). */
export const formatPrs = (prs = [], now = Date.now()) => prs.filter((p) => String(p.headRefName).startsWith("agent/")).map((p) => `- PR #${p.number} « ${p.title} » (${p.headRefName}) — ouverte depuis ${ago(now - new Date(p.updatedAt || now).getTime())}`).join("\n");
/** Worktrees du projet : [{path, branch, merged, dirtyFiles, lastCommitMs, locked}] → lignes lisibles. */
export const formatWorktrees = (list = [], now = Date.now()) => list.map((w) => `- ${w.path}${w.branch ? ` [${w.branch}]` : ""} : ${w.merged ? "branche DÉJÀ FUSIONNÉE" : "non fusionnée"}, ${w.dirtyFiles ? `${w.dirtyFiles} fichier(s) non commités` : "propre"}${w.lastCommitMs ? `, dernier commit il y a ${ago(now - w.lastCommitMs)}` : ""}${w.locked ? ", VERROUILLÉ" : ""}`).join("\n");

/** Consigne d'un réveil du cerveau pour un projet. kind : "heartbeat" | "ci-fix". tasks/prs/worktrees : voir formatTasks/formatPrs/formatWorktrees. */
export function brainPrompt({ kind = "heartbeat", mode, dir, objectives = "", ideas = [], ci = null, tasks = [], prs = [], worktrees = [], now = Date.now() }) {
  const name = dir.split("/").pop();
  const head = `Projet : ${name} (${dir}). Mode d'autonomie : ${mode === "auto" ? "AUTONOME (tu fais, tu testes, tu fusionnes seul)" : "IDÉES (tu proposes, tu ATTENDS la validation de Philippe avant toute réalisation)"}.`;
  const obj = objectives.trim() ? `Objectifs du projet (HEARTBEAT.md) :\n${objectives.trim().slice(0, 4000)}` : "Pas de HEARTBEAT.md : déduis les priorités du dépôt (README, TODO, issues, CI).";
  const approved = ideas.filter((i) => i.status === "approved");
  const approvedTxt = approved.length ? `Idées VALIDÉES par Philippe, à réaliser en priorité :\n${approved.map((i) => `- [${i.id}] ${i.title} : ${i.body || ""}${i.comment ? ` (commentaire de Philippe : ${i.comment})` : ""}`).join("\n")}` : "";
  if (kind === "ci-fix") {
    return [head, `La CI GitHub est ROUGE sur la branche principale (run ${ci?.id}, « ${ci?.title || ""} »). Mission : lire les journaux (gh run view --log-failed), corriger la cause sur une branche agent/${name}/ci-fix, faire passer les tests, fusionner si vert, puis noter ce que tu as fait dans MEMORY.md.`, obj].join("\n\n");
  }
  const waiting = [formatTasks(tasks, ideas, now), formatPrs(prs, now)].filter(Boolean).join("\n");
  const waitingTxt = waiting ? `Ce qui ATTEND déjà dans ce projet (tâches « À valider » / « En cours » et PR agent/* ouvertes) :\n${waiting}` : "Rien n'attend dans ce projet (aucune tâche à valider ou en cours, aucune PR agent/* ouverte).";
  const wtTxt = worktrees.length ? `Worktrees du projet (git worktree list) :\n${formatWorktrees(worktrees, now)}` : "";
  const step1 = mode === "auto"
    ? "1) FINIR CE QUI ATTEND : pour chaque tâche « À valider » ou PR agent/* ouverte ci-dessus, relis le diff, lance `npm test` (ou les tests du projet) et regarde la CI de la PR (`gh pr checks`) ; si tout est vert, fusionne (`gh pr merge <n°> --merge`), passe la tâche en Terminé (`postectl task move <id> done`) et, si une idée validée y est liée, `postectl idea done <id>`. Si c'est faux, renvoie-la avec tes remarques (`postectl task edit <id> --description …`, `postectl task move <id> todo`). Une tâche « EN COURS » n'est pas à toi : ne la touche pas (risque de doublon) ; toute autre tâche l'est."
    : "1) FINIR CE QUI ATTEND : tu peux relire (diff, `npm test`, CI de la PR) et FUSIONNER seulement ce qui réalise une idée VALIDÉE (marquée « idée validée » ci-dessus, ou dont le titre correspond clairement) : fusion avec `gh pr merge <n°> --merge` si tout est vert, puis `postectl task move <id> done` et `postectl idea done <id>`. Pour le reste, relis et résume dans ton compte rendu, sans fusionner. Une tâche « EN COURS » n'est pas à toi : ne la touche pas.";
  const step2 = "2) RÉALISER les idées validées ci-dessus : délègue le gros du code aux ouvriers (`postectl task add \"titre\" --project <dossier> --idea <id-idée> …` pour lier la tâche à l'idée ; une idée validée n'a qu'une tâche active), relis leur travail.";
  const step3 = mode === "auto"
    ? "3) SEULEMENT ENSUITE, si rien ne reste aux étapes 1 et 2 : choisis UNE amélioration utile et petite, fais-la sur une branche agent/<projet>/<sujet>, lance les tests, fusionne si tout est vert. Rends compte : `postectl idea done <id>` si tu as réalisé une idée validée, sinon une ligne « Fait : … » dans ton compte rendu final."
    : "3) SEULEMENT ENSUITE : étudie le projet et propose 1 à 3 idées concrètes via `postectl idea add` (titre court, détail du plan). N'écris AUCUN code dans le dépôt pour une idée non validée. Avant de proposer, lis `postectl ideas` : ne propose pas ce qui existe déjà (le poste refuse les doublons) et, si une de tes idées EN ATTENTE est déjà faite, retire-la avec `postectl idea obsolete <id> --why \"déjà fait dans <commit>\"`.";
  const hygiene = "Hygiène (à chaque réveil, avant l'étape 3) : branche d'un worktree déjà FUSIONNÉE → `git worktree remove <chemin>` puis supprime la branche (locale et `git push origin --delete`) ; worktree avec des fichiers non commités depuis plus de 24 h → commit « wip » sur SA branche + push (rien n'est perdu) puis tâche « À valider » ; worktree VERROUILLÉ par un agent mort → `git worktree unlock` puis même règle. N'agis jamais sur un worktree dont la tâche est « EN COURS ».";
  return [head, obj, waitingTxt, wtTxt, approvedTxt, `Ordre de travail OBLIGATOIRE (finir avant de proposer) :\n${step1}\n${step2}\n${step3}`, hygiene, "Si rien d'utile n'est à faire, dis-le en une ligne et arrête-toi (ne produis pas de travail artificiel)."].filter(Boolean).join("\n\n");
}

// --- Idées : doublons (A4)
const STOP = new Set(["les", "des", "une", "pour", "avec", "dans", "sur", "par", "aux", "est", "que", "qui", "the", "and", "for"]);
/** Mots significatifs d'un titre : minuscules, sans accents ni ponctuation, mots de 3 lettres et plus, tronqués à 5 lettres (ajouter ≈ ajoutés). */
export const titleWords = (t) => new Set(String(t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => w.slice(0, 5)));
/** Part de mots communs (par rapport au plus petit des deux titres), 0..1. */
export function titleOverlap(a, b) {
  const A = titleWords(a), B = titleWords(b); const min = Math.min(A.size, B.size);
  if (min < 2) return A.size === 1 && B.size === 1 && [...A][0] === [...B][0] ? 1 : 0;
  let common = 0; for (const w of A) if (B.has(w)) common++;
  return common / min;
}
export const DUPLICATE_RATIO = 0.7;
/** Idée EN ATTENTE ou VALIDÉE du même projet dont le titre est proche (≥ 70 % de mots communs), sinon null. */
export const findDuplicateIdea = (ideas, project, title) => ideas.find((i) => i.project === project && (i.status === "pending" || i.status === "approved") && titleOverlap(i.title, title) >= DUPLICATE_RATIO) || null;
export const STALE_IDEA_MS = 3 * 864e5;

// --- Compte rendu d'un réveil : le cerveau termine par trois lignes « Fait : … », « Bloqué : … », « Prochaine étape : … » (CONSIGNE.md).
const NOTHING = /^(?:rien|aucune?|néant|non|n\/a|ras|[-–—.]+)(?:\b|$)/i;
/** Lit le compte rendu à la fin du journal d'un run. Retourne { fait, bloque, suite } (chaînes, "" si absent ou « rien »). */
export function parseReport(text) {
  const out = { fait: "", bloque: "", suite: "" };
  const keys = { fait: "fait", bloqué: "bloque", bloque: "bloque", "prochaine étape": "suite", "prochaine etape": "suite" };
  for (const raw of String(text || "").split("\n")) {
    const m = raw.match(/^\s*(?:[-*•>]\s*)?\**\s*(Fait|Bloqu[ée]|Prochaine [ée]tape)\s*(?::\s*\**|\**\s*:)\s*(.*?)\s*$/i);
    if (!m) continue;
    const v = m[2].replace(/\*+$/, "").trim();
    out[keys[m[1].toLowerCase()]] = NOTHING.test(v) ? "" : v.slice(0, 300); // le dernier compte rendu du journal l'emporte
  }
  return out;
}
/** Message Telegram d'un réveil terminé, ou null (rien de fait, rien de bloquant : pas de bruit). */
export function reportMessage(project, report) {
  const reste = report?.suite ? `\n➡️ Reste : ${report.suite}` : "";
  if (report?.bloque) return `⛔ ${project} : ${report.bloque}${reste}`;
  if (report?.fait && !/rien d'utile/i.test(report.fait)) return `✅ ${project} : ${report.fait}${reste}`;
  return null;
}
/** Que faire d'un run « en cours » trouvé au démarrage du poste ? exit : code lu dans <runId>.exit (ou null). */
export function reconcileRun({ unitActive, exit }) {
  if (exit != null) return { action: "close", code: exit };
  if (unitActive) return { action: "follow" };
  return { action: "interrupted" };
}
export const runStatusFromCode = (code) => (code === 0 ? "done" : code === 3 ? "outil manquant : postectl" : `erreur (code ${code})`);

// --- Usage de Claude : le daemon ne le remonte pas toujours (Oracle : « usage indisponible »). Deux signaux propres au poste :
//     1. ce que le cerveau a lui-même consommé sur Claude dans la fenêtre de 5 h ; 2. une erreur de quota reçue lors d'un run.
export const CLAUDE_WINDOW_MS = 5 * 3600_000;
export const DAY_BUDGET_MIN = 30; // minutes de Claude par fenêtre de 5 h au-delà desquelles le jour bascule sur les modèles gratuits (avec réserve 30 % : 21 min)
export const QUOTA_BLOCK_MS = 60 * 60_000;

/** Minutes de Claude consommées par le cerveau dans la fenêtre (runs en cours comptés jusqu'à maintenant). */
export function claudeMinutes(runs, now, windowMs = CLAUDE_WINDOW_MS) {
  let ms = 0;
  for (const r of runs || []) {
    if (r.engine !== "claude") continue;
    const start = Math.max(r.at || 0, now - windowMs), end = Math.min(r.endedAt || now, now);
    if (end > start) ms += end - start;
  }
  return ms / 60_000;
}
/** Le texte (fin du journal d'un run) signale-t-il une limite d'usage / un quota épuisé ? */
export const quotaErrorIn = (text) => /usage limit|limit reached|rate.?limit|quota (?:exceeded|exhausted)|out of (?:extra )?usage|credit balance|\b429\b|overloaded/i.test(String(text || ""));
/** Part (0..1) d'usage Claude : la valeur du daemon si elle existe, sinon l'estimation propre du cerveau. */
export function claudeUsageRatio({ daemonPct = null, runs = [], now = Date.now() } = {}) {
  if (Number.isFinite(daemonPct)) return Math.min(Math.max(daemonPct / 100, 0), 1);
  return Math.min(claudeMinutes(runs, now) / DAY_BUDGET_MIN, 1);
}
