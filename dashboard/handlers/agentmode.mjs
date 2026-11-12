// Mode « Agent » (bascule) du poste de commande (N10 / T28, démarrage automatique T31).
// État persistant dans data/agent-mode.json (écriture atomique via ctx.store).
// Messages WS : agentmode.get, agentmode.enable {project, brief, forbidden, launch?, engine?}, agentmode.answer,
// agentmode.disable {stopTasks?} ; diffusion agentmode.state.
// T34 : `autoPermissions` (défaut vrai : la politique de lib/permpolicy.mjs répond seule à ce qui est sûr), `allowGit`
// (défaut faux : git commit refusé) et `writeScope` (chemins relatifs au projet où l'agent peut modifier ; vide = tout le projet).
// Avec `launch: true`, l'activation crée UNE tâche « Jarvis — <projet> » (origine « agent ») et la
// démarre par les handlers task.create / task.start ; la désactivation arrête cette tâche (task.stop).
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { forbids } from "../lib/permpolicy.mjs";

import { SELF_HOST, SELF_LABEL, isSelfHost } from "../lib/selfhost.mjs";
import { checkProjectDir } from "../lib/guardrails.mjs";
const FILE = "agent-mode";

export const DEFAULT_QUESTIONS = [
  "Sur quel projet l'agent doit-il travailler ?",
  "Que doit-il faire ?",
  "Que lui est-il interdit de faire sans demander ?",
];

export const DEFAULT_FORBIDDEN = [
  "supprimer",
  "pousser sur GitHub",
  "éteindre une machine",
];

// L'orchestrateur (celui qui réfléchit et décide) tourne sur un vrai modèle Claude ; ses employés (tâches filles) sur des modèles gratuits.
export const DEFAULT_ENGINE = "claude/claude-sonnet-5-5";
export const DEFAULT_WORKER_ENGINE = "claude-openrouter/sonnet";
const ENGINE = /^[A-Za-z0-9][\w.-]*\/[\w.:@/-]+$/;
const POSTECTL = fileURLToPath(new URL("../../tools/postectl.mjs", import.meta.url)).replace(/\\/g, "/");

const MAX_BRIEF = 2000;
const MAX_PROJECT = 200;
const MAX_QUESTION = 200;
const MAX_ANSWER = 2000;
const MAX_LIST = 50;
const MAX_ENGINE = 200;
const MAX_ERROR = 300;
const MAX_SCOPE = 20;
const MAX_SCOPE_PATH = 300;

// Périmètre d'écriture : chemins RELATIFS au projet, sans « .. », sans lecteur, sans joker. Renvoie { list } ou { error }.
export function cleanWriteScope(raw) {
  if (raw == null) return { list: [] };
  if (!Array.isArray(raw)) return { error: "Le périmètre d'écriture doit être une liste de chemins." };
  if (raw.length > MAX_SCOPE) return { error: `Le périmètre d'écriture ne doit pas dépasser ${MAX_SCOPE} chemins.` };
  const list = [];
  for (const entry of raw) {
    if (typeof entry !== "string") return { error: "Chaque chemin du périmètre d'écriture doit être du texte." };
    const p = entry.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (!p) continue;
    if (p.length > MAX_SCOPE_PATH) return { error: `Un chemin du périmètre d'écriture dépasse ${MAX_SCOPE_PATH} caractères.` };
    if (/[\u0000-\u001f<>"|?*:]/.test(p) || p.startsWith("/") || p.startsWith("~") || p.split("/").some((seg) => seg === ".." || seg === ".")) {
      return { error: `Chemin du périmètre d'écriture refusé (« ${clip(p, 60)} ») : indiquez un chemin relatif au projet, sans « .. ».` };
    }
    if (!list.includes(p)) list.push(p);
  }
  return { list };
}

const clip = (value, max) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const strip = (message) => String(message ?? "").replace(/^Erreur\s*:\s*/, "");
const slashes = (path) => String(path ?? "").replace(/\\/g, "/");
const baseName = (dir) => slashes(dir).replace(/\/+$/, "").split("/").pop();
const text = (value, max) => (typeof value === "string" && value ? value.slice(0, max) : null);

export function freshState(saved) {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) saved = {};
  const enabled = saved.enabled === true;
  const launch = saved.launch && typeof saved.launch === "object" && !Array.isArray(saved.launch)
    ? { status: text(saved.launch.status, 20), error: text(saved.launch.error, MAX_ERROR), at: text(saved.launch.at, 40) }
    : null;
  // Un lancement « en cours » au moment d'un arrêt du serveur ne finira jamais : on le dit clairement.
  if (launch && launch.status === "starting") { launch.status = "failed"; launch.error = "Le démarrage a été interrompu par un redémarrage du poste."; }
  return {
    enabled,
    project: typeof saved.project === "string" ? saved.project : null,
    brief: typeof saved.brief === "string" ? saved.brief : null,
    since: saved.since ?? null,
    forbidden: Array.isArray(saved.forbidden)
      ? saved.forbidden.filter((f) => typeof f === "string").slice(0, MAX_LIST)
      : (enabled ? [...DEFAULT_FORBIDDEN] : []),
    questions: Array.isArray(saved.questions) && saved.questions.length
      ? saved.questions.filter((q) => typeof q === "string").slice(0, MAX_LIST)
      : [...DEFAULT_QUESTIONS],
    answers: Array.isArray(saved.answers) ? saved.answers.filter((a) => a && typeof a === "object").slice(-MAX_LIST) : [],
    // T31 : identifiant du mandat, orchestrateur lancé (tâche), moteur et dossier du projet.
    runId: enabled ? text(saved.runId, 80) : null,
    engine: enabled ? text(saved.engine, MAX_ENGINE) : null,
    projectDir: enabled ? text(saved.projectDir, 1000) : null,
    projectHost: enabled ? text(saved.projectHost, 100) : null,
    orchestratorTaskId: enabled ? text(saved.orchestratorTaskId, 80) : null,
    launch: enabled ? launch : null,
    // T34 : politique de permissions.
    autoPermissions: saved.autoPermissions !== false,
    allowGit: enabled && saved.allowGit === true,
    permissive: saved.permissive !== false, // Philippe (2026-10-24) : tout sauf le très dangereux ; false = liste blanche stricte
    writeScope: enabled ? cleanWriteScope(saved.writeScope).list || [] : [],
  };
}

// Consigne d'orchestrateur (courte). Fonction pure, testée par verify-agentlaunch.
export function buildBrief({ project, dir, brief, forbidden, engine, workerEngine = engine, postectl = POSTECTL, url = "", writeScope = [], allowGit = false }) {
  const dirSlash = slashes(dir);
  const cmd = `node ${slashes(postectl)}${url ? ` --url ${url}` : ""}`;
  const banned = (Array.isArray(forbidden) ? forbidden : []).filter(Boolean);
  const scope = (Array.isArray(writeScope) ? writeScope : []).filter(Boolean);
  return [
    `Tu es JARVIS, agent autonome du poste Paseo (Oracle, Linux) sur le projet ${project} (${dirSlash}). Philippe est sur son telephone : sois concis, autonome, et va jusqu'au bout.`,
    "",
    `MISSION (mandat complet : ${cmd} mandate) :`,
    brief ? String(brief).trim() : "(aucune consigne precise : lis le mandat et dis ce que tu comptes faire.)",
    "",
    "METHODE :",
    "1. Lis le README/CLAUDE.md du projet et l'etat reel, puis fixe-toi des criteres de fin verifiables.",
    "2. Fais TOI-MEME ce qui est court (lancer un script, lire un fichier, une commande). Pour le travail simple ou parallele a deleguer a des modeles moins chers, charge la skill claude-foreman (outil Skill) et suis-la. " +
      `Pas de tache fille du poste (${cmd} task add) sauf travail long (>10 min) : une tache = un sujet, jamais de doublon (verifie ${cmd} tasks), engine ${workerEngine}, attente avec ${cmd} wait <id> --timeout 540, fermeture de ses sessions inactives avec ${cmd} session close <hote> <id>.`,
    "3. Verifie toi-meme chaque resultat (relis le fichier, compte, lance le test) avant de le dire fait.",
    "4. Bloque par un humain (captcha, connexion, choix) : fais d'abord tout le reste, puis une seule question AskUserQuestion (outil differe : ToolSearch select:AskUserQuestion) avec l'action exacte a faire et « C'est fait, reprends (Recommande) ». Ta session ATTEND la reponse : ne termine jamais sur « previens-moi ». Idem pour une vraie decision de direction (2 a 4 options, recommandation en premier).",
    "5. Ne conclus pas tant qu'il reste une etape du plan. Fin : compte-rendu court en francais (fait / reste / incertain) puis 2 ou 3 suites concretes via AskUserQuestion.",
    "",
    "REGLES :",
    scope.length ? `- Tu ne modifies QUE : ${scope.join(", ")} (relatifs a ${dirSlash}).` : `- Tu ne modifies que des fichiers dans ${dirSlash}.`,
    `- ${allowGit ? "git commit autorise par le mandat" : "Aucun git commit, push, reset, checkout, clean, rebase, merge ni stash"}.`,
    "- Ne reecris jamais le texte brut de l'utilisateur ; n'invente pas le sens d'un texte flou.",
    "- N'utilise que les commandes listees par postectl --help. Tu ne peux pas approuver toi-meme une permission.",
    `- INTERDITS sans demander : ${banned.length ? banned.join(", ") : "aucun"}. Si une action est refusee (403), ne la contourne pas : explique-le.`,
    "- Rends compte dans le groupe (coord_send, destinataire \"team\") aux etapes importantes, si tu as cet outil.",
  ].join("\n");
}

export function register(ctx) {
  const { onMessage, send, broadcast, sendError, store, log } = ctx;

  let state = freshState(store.read(FILE, {}));

  const save = () => {
    store.write(FILE, state);
  };

  const publish = (ws, ref) => {
    const payload = { type: "agentmode.state", ...state, ref: ref ?? null };
    broadcast(payload);
    if (ws) send(ws, payload);
  };

  const dashboardUrl = () => {
    const port = String(process.env.DASHBOARD_PORT || 7070);
    return port === "7070" ? "" : `http://127.0.0.1:${port}`;
  };

  ctx.agentMode = {
    getState: () => ({ ...state }),
    isForbidden: (category) => state.enabled && forbids(state.forbidden, category),
    resolveProject, // aussi utilisé par handlers/freebuff.mjs (même résolution du projet suivi)
  };

  // Dossier suivi correspondant au nom du projet du mandat (nom affiché, nom du dossier ou chemin complet).
  async function resolveProject(name) {
    const result = await ctx.invoke("project.list", {});
    const list = result.replies.find((r) => r.type === "project.list")?.projects || [];
    const wanted = slashes(name).replace(/\/+$/, "").toLowerCase();
    const matches = list.filter((p) =>
      String(p.name || "").toLowerCase() === wanted || baseName(p.dir).toLowerCase() === wanted ||
      slashes(p.dir).replace(/\/+$/, "").toLowerCase() === wanted);
    return matches.find((p) => isSelfHost(p.host)) || matches[0] || null;
  }

  const activity = (summary, ok = true) => ctx.agentActivity?.record({
    method: "POST", route: "/agentmode", ok, status: ok ? 200 : 500, summary, mandateActive: state.enabled,
  });

  // Crée puis démarre la tâche orchestrateur ; l'état du lancement est publié à chaque étape.
  async function launchOrchestrator(ws, ref, runId, target) {
    let taskId = null;
    try {
      const description = buildBrief({
        project: state.project, dir: target.dir, brief: state.brief, forbidden: state.forbidden,
        engine: state.engine, workerEngine: DEFAULT_WORKER_ENGINE, url: dashboardUrl(), writeScope: state.writeScope, allowGit: state.allowGit,
      });
      const created = await ctx.invoke("task.create", {
        title: `Jarvis — ${baseName(target.dir) || state.project}`.slice(0, 200),
        description, project: target.dir, host: target.host, engine: state.engine, origin: "agent", agentRun: runId,
        // Vrai Claude : lancé sans demandes de permission (bypass) ; il ne pose que des questions de direction.
        ...(/^claude(\/|$)/.test(String(state.engine || "")) ? { mode: "bypassPermissions" } : {}),
      });
      if (created.error) throw new Error(strip(created.error));
      taskId = created.replies.find((r) => r.type === "task.created")?.id;
      if (!taskId) throw new Error("la tâche de l'agent n'a pas pu être créée");
      if (state.runId !== runId) return; // le mandat a été repris entre-temps : rien n'est démarré
      state.orchestratorTaskId = taskId;
      save();
      publish(ws, ref);
      const started = await ctx.invoke("task.start", { id: taskId }, { timeoutMs: 60000 });
      if (started.error) throw new Error(strip(started.error));
      if (state.runId !== runId) {
        // Repris pendant le démarrage : la session qui vient de naître est arrêtée aussitôt.
        await ctx.invoke("task.stop", { id: taskId }, { timeoutMs: 30000 });
        return;
      }
      state.launch = { status: "started", error: null, at: new Date().toISOString() };
      log("agentmode", `agent lancé (tâche ${taskId.slice(0, 8)}, moteur ${state.engine})`);
      activity(`Agent lancé sur ${state.project} (${state.engine})`);
    } catch (e) {
      // Une tâche créée mais jamais démarrée n'est pas laissée en orphelin sur le tableau des tâches.
      if (taskId) {
        try { await ctx.invoke("task.delete", { id: taskId }); } catch { /* tâche déjà démarrée : on la laisse */ }
        if (state.runId === runId) state.orchestratorTaskId = null;
      }
      if (state.runId !== runId) return;
      const reason = clip(strip(ctx.safeError ? ctx.safeError(e) : e.message), MAX_ERROR);
      state.launch = { status: "failed", error: reason, at: new Date().toISOString() };
      log("agentmode", `lancement de l'agent impossible : ${reason}`);
      activity(`Lancement de l'agent impossible : ${reason}`, false);
      sendError(ws, `L'agent n'a pas pu démarrer : ${reason}`);
    }
    save();
    publish(ws, ref);
  }

  onMessage("agentmode.get", (ws, m) => {
    send(ws, { type: "agentmode.state", ...state, ref: m.ref ?? null });
  });

  onMessage("agentmode.enable", async (ws, m) => {
    const rawBrief = m.brief != null ? String(m.brief) : "";
    if (rawBrief.length > MAX_BRIEF) {
      return sendError(ws, `Le brief ne doit pas dépasser ${MAX_BRIEF} caractères.`);
    }
    if (m.project != null && typeof m.project !== "string") return sendError(ws, "Le nom du projet doit être du texte.");
    if (m.brief != null && typeof m.brief !== "string") return sendError(ws, "La consigne doit être du texte.");
    if (m.forbidden != null && !Array.isArray(m.forbidden)) return sendError(ws, "La liste des interdictions doit être une liste.");
    if (m.launch != null && typeof m.launch !== "boolean") return sendError(ws, "Le lancement de l'agent doit être oui ou non.");
    if (m.engine != null && typeof m.engine !== "string") return sendError(ws, "Le moteur doit être du texte (fournisseur/modèle).");
    const rawProject = m.project != null ? String(m.project) : "";
    if (rawProject.length > MAX_PROJECT) {
      return sendError(ws, `Le nom du projet ne doit pas dépasser ${MAX_PROJECT} caractères.`);
    }
    const rawEngine = m.engine != null ? String(m.engine).trim() : "";
    if (rawEngine.length > MAX_ENGINE) return sendError(ws, `Le moteur ne doit pas dépasser ${MAX_ENGINE} caractères.`);
    if (m.autoPermissions != null && typeof m.autoPermissions !== "boolean") return sendError(ws, "L'autorisation automatique doit être oui ou non.");
    if (m.permissive != null && typeof m.permissive !== "boolean") return sendError(ws, "Le mode permissif doit être oui ou non.");
    if (m.allowGit != null && typeof m.allowGit !== "boolean") return sendError(ws, "L'autorisation de git doit être oui ou non.");
    const scope = cleanWriteScope(m.writeScope);
    if (scope.error) return sendError(ws, scope.error);
    const launch = m.launch === true;
    const engine = rawEngine || DEFAULT_ENGINE;
    if (launch && !ENGINE.test(engine)) return sendError(ws, "Le moteur doit avoir la forme fournisseur/modèle.");

    // Un seul mandat actif à la fois : en confier un nouveau demande d'avoir repris la main avant.
    if (state.enabled) {
      return sendError(ws, `Un mandat est déjà actif${state.project ? ` sur ${state.project}` : ""} : reprenez la main avant d'en confier un nouveau.`);
    }

    const project = rawProject.trim().slice(0, MAX_PROJECT);
    const brief = rawBrief.trim().slice(0, MAX_BRIEF);
    let target = null;
    let blastPending = false;
    if (launch) {
      if (!project) return sendError(ws, "Choisissez le projet sur lequel l'agent doit travailler.");
      target = await resolveProject(project);
      if (!target) {
        return sendError(ws, `Impossible de lancer l'agent : le projet « ${project} » n'est pas dans les projets suivis. Suivez d'abord ce dossier (vue Projets).`);
      }
      const blast = checkProjectDir(target.dir);
      if (!blast.allow) {
        if (blast.guard === "blastwin" && blast.confirmable) {
          // Confirmation requise avant de lancer sur BlastWin : la tâche est créée en « À faire »,
          // l'agent ne démarre qu'après l'approbation de Philippe (élément inbox ci-dessous).
          blastPending = true;
        } else {
          return sendError(ws, blast.reason); // refus dur absolu
        }
      }
      if (!isSelfHost(target.host)) {
        return sendError(ws, `Impossible de lancer l'agent : pour l'instant il ne peut travailler que sur un projet de ${SELF_LABEL} (l'outil de pilotage est sur cette machine).`);
      }
    }
    const forbidden = Array.isArray(m.forbidden)
      ? m.forbidden.filter((f) => typeof f === "string").slice(0, MAX_LIST).map((f) => clip(f, 100)).filter(Boolean)
      : [...DEFAULT_FORBIDDEN];
    const questions = Array.isArray(m.questions) && m.questions.length
      ? m.questions.filter((q) => typeof q === "string").slice(0, MAX_LIST).map((q) => clip(q, MAX_QUESTION))
      : [...DEFAULT_QUESTIONS];

    let answers;
    if (Array.isArray(m.answers)) {
      answers = m.answers.map((a) => {
        if (typeof a === "string") return { question: "", answer: clip(a, MAX_ANSWER), at: new Date().toISOString() };
        return {
          question: clip(a.question, MAX_QUESTION),
          answer: clip(a.answer, MAX_ANSWER),
          at: new Date().toISOString(),
        };
      });
    } else {
      answers = [
        { question: questions[0] || DEFAULT_QUESTIONS[0], answer: project },
        { question: questions[1] || DEFAULT_QUESTIONS[1], answer: brief },
        { question: questions[2] || DEFAULT_QUESTIONS[2], answer: forbidden.join(", ") },
      ];
    }

    const runId = randomUUID();
    state = {
      enabled: true,
      project: project || null,
      brief: brief || null,
      since: new Date().toISOString(),
      forbidden,
      questions,
      answers,
      runId,
      engine: launch ? engine : null,
      projectDir: target ? target.dir : null,
      projectHost: target ? target.host : null,
      orchestratorTaskId: null,
      launch: launch ? (blastPending ? { status: "pending_confirmation", error: null, at: new Date().toISOString() } : { status: "starting", error: null, at: new Date().toISOString() }) : null,
      autoPermissions: m.autoPermissions !== false,
      allowGit: m.allowGit === true,
      permissive: m.permissive !== false,
      writeScope: scope.list,
    };

    save();

    if (ctx.inbox) {
      ctx.inbox.add({
        kind: "système",
        title: "Mode Agent activé",
        body: `Mandat confié sur ${state.project || "projet"}${state.brief ? ` : ${state.brief}` : ""}`,
        host: SELF_LABEL,
        source: "agentmode",
      });
    }

    log("agentmode", `activé pour le projet ${state.project || "(aucun)"}${launch ? " avec lancement de l'agent" : ""}${blastPending ? " (confirmation BlastWin en attente)" : ""}`);
    publish(ws, m.ref);
    if (blastPending) {
      // T48 : tâche créée en « À faire », lancement de l'agent suspendu jusqu'à la confirmation de Philippe.
      const created = await ctx.invoke("task.create", {
        title: `Jarvis — ${baseName(target.dir) || project}`.slice(0, 200),
        description: brief, project: target.dir, host: target.host, engine: engine,
        origin: "agent", agentRun: runId,
        isolation: "worktree",
        branch: `agent/pending`,
        ...(/^claude(\/|$)/.test(String(engine)) ? { mode: "bypassPermissions" } : {}),
      });
      if (!created.error) {
        const tid = created.replies.find((r) => r.type === "task.created")?.id;
        if (tid) {
          state.orchestratorTaskId = tid;
          state.launch = { status: "pending_confirmation", error: null, taskId: tid, at: new Date().toISOString() };
          save();
          if (ctx.inbox) {
            const requestId = randomUUID();
            ctx.inbox.add({
              kind: "permission",
              host: target.host,
              taskId: tid,
              title: `BlastWin : autoriser l'agent sur ${project} ?`,
              body: `Tâche : ${project}\nConsigne : ${brief || "(aucune)"}\nMoteur : ${engine}\nProjet : ${target.dir}\n\nÀ l'approbation : sauvegarde (tag git + bundle + fichiers) puis travail dans un worktree isolé sur la branche agent/${tid}. Vérification automatique à la fin, puis fusion dans le vrai BlastWin après 2e confirmation.`,
              status: "nouveau",
              source: "t48-blastwin-agentmode",
              action: {
                type: "permission", requestId, kind: "blastwin-confirm", tool: "task",
                target: target.dir, cwd: target.dir, taskId: tid,
                actions: [
                  { id: "allow", behavior: "allow", label: "Autoriser" },
                  { id: "deny", behavior: "deny", label: "Refuser" },
                ],
                danger: false,
              },
            });
          }
          ctx.agentActivity?.record({
            method: "POST", route: "/agentmode", ok: true, status: 200,
            summary: `Demande de confirmation BlastWin pour l'agent sur ${project}`,
            mandateActive: true,
          });
        }
      }
      publish(ws, m.ref);
      return; // n'appelle pas launchOrchestrator : attend la confirmation de Philippe
    }
    if (launch) await launchOrchestrator(ws, m.ref, runId, target);
  });

  onMessage("agentmode.answer", (ws, m) => {
    const rawAnswer = m.answer != null ? String(m.answer) : "";
    if (rawAnswer.length > MAX_ANSWER) {
      return sendError(ws, `La réponse ne doit pas dépasser ${MAX_ANSWER} caractères.`);
    }
    const rawQuestion = m.question != null ? String(m.question) : "";
    if (rawQuestion.length > MAX_QUESTION) {
      return sendError(ws, `La question ne doit pas dépasser ${MAX_QUESTION} caractères.`);
    }

    if (Array.isArray(m.answers)) {
      for (const a of m.answers.slice(0, MAX_LIST)) {
        if (typeof a === "string") {
          state.answers.push({ question: "", answer: clip(a, MAX_ANSWER), at: new Date().toISOString() });
        } else if (a && typeof a === "object") {
          state.answers.push({
            question: clip(a.question, MAX_QUESTION),
            answer: clip(a.answer, MAX_ANSWER),
            at: new Date().toISOString(),
          });
        }
      }
    } else if (m.answer != null) {
      const q = rawQuestion ? clip(rawQuestion, MAX_QUESTION) : "Réponse";
      const a = clip(rawAnswer, MAX_ANSWER);
      state.answers.push({
        question: q,
        answer: a,
        at: new Date().toISOString(),
      });
      if (rawQuestion && !state.questions.includes(q)) {
        state.questions.push(q);
      }
    }

    if (state.answers.length > MAX_LIST) state.answers = state.answers.slice(-MAX_LIST);
    if (state.questions.length > MAX_LIST) state.questions = state.questions.slice(0, MAX_LIST);
    save();
    log("agentmode", `nouvelle réponse enregistrée (${state.answers.length} au total)`);
    publish(ws, m.ref);
  });

  // « Reprendre la main » : arrête l'orchestrateur ; les tâches filles restent, sauf demande explicite (stopTasks).
  onMessage("agentmode.disable", async (ws, m) => {
    const { runId, orchestratorTaskId } = state;
    state.enabled = false;
    state.since = null;
    state.runId = null;
    state.engine = null;
    state.projectDir = null;
    state.projectHost = null;
    state.orchestratorTaskId = null;
    state.launch = null;
    state.allowGit = false;
    state.writeScope = [];
    state.autoPermissions = true;
    save();

    if (ctx.inbox) {
      ctx.inbox.add({
        kind: "système",
        title: "Mode Agent désactivé",
        body: "Reprise de la main par Philippe.",
        host: SELF_LABEL,
        source: "agentmode",
      });
    }

    log("agentmode", "désactivé");
    publish(ws, m.ref);

    const stop = async (id) => {
      const result = await ctx.invoke("task.stop", { id }, { timeoutMs: 30000 });
      if (result.error) log("agentmode", `arrêt de la tâche ${String(id).slice(0, 8)} : ${clip(strip(result.error), 120)}`);
      return !result.error;
    };
    if (orchestratorTaskId) await stop(orchestratorTaskId);
    if (m.stopTasks === true && runId) {
      const listed = await ctx.invoke("task.list", {});
      const tasks = listed.replies.find((r) => r.type === "tasks")?.tasks || [];
      for (const t of tasks) {
        if (t.origin === "agent" && t.agentRun === runId && t.status === "doing" && t.id !== orchestratorTaskId) await stop(t.id);
      }
    }
    if (orchestratorTaskId || m.stopTasks === true) ctx.broadcastState?.();
  });
}
