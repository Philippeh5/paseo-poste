// Pastille d'avis sur les tâches « À valider » (T44). Pose `ctx.reviewbadge` ; handlers/tasks.mjs appelle
// `ctx.reviewbadge.note({ id, title, summary, at })` quand une session arrive « À valider » avec un compte-rendu.
// Avis INDICATIF, jamais un garde-fou ni une acceptation : calculé en arrière-plan (délai 15 s, jamais bloquant, échec
// silencieux) à partir de
//   1. règles déterministes sur le texte (erreur, échec/échoué, n'ai pas pu, impossible, timeout, 402, 429,
//      « API Error », question finale sans réponse, « non terminé », « partiel », « rien n'a été ») ; une négation juste avant
//      (« sans erreur », « aucune erreur », « pas d'erreur », « 0 erreur ») ne compte pas ;
//   2. une question de type `noul` (ctx.decide.run) posée d'abord à Von (T47 : 12/12 échecs repérés, scores bimodaux
//      ~0,19 / ~0,81), puis à Laya si Von est indisponible (absent, panne, délai, réponse sans `noul`). On lit le champ
//      `noul` (probabilité que la proposition soit vraie), JAMAIS `answer_confidence` (confiance dans la réponse choisie,
//      élevée aussi pour un « faux » certain).
// Avis : a_verifier si une règle se déclenche OU noul < 0,5 ; probablement_ok si noul >= 0,7 (Von) ou >= 0,9 (Laya) ET
// aucune règle ; sinon incertain. Source : « rules+von », « rules+laya » ou « rules » (aucun moteur : règles seules,
// jamais probablement_ok).
// Stockage : data/review-hints.json (ctx.store, 200 derniers, clé = id de tâche + horodatage du compte-rendu).
// Messages : reviewhint.get {taskId?} -> reviewhint.list {hints} ; diffusion
// reviewhint.update {taskId, hint, p, reasons, source, at} (hint null = avis en cours de calcul, à effacer). Réglage de test : REVIEWBADGE_DELAY_MS (défaut 0 : avis par règles immédiat, Laya ensuite).
const FILE = "review-hints";
const KEEP = 200;
const STATE_MAX = 1900;
const QUESTION = "ok";
const PROPOSITION = "Le compte-rendu confirme que la tâche demandée a été réalisée en entier et avec succès, "
  + "sans erreur ni question restante";
const LOW = 0.5;
const HIGH = { von: 0.7, laya: 0.9 }; // les scores de Von sont bimodaux (~0,19 / ~0,81) : seuil de confiance plus bas
const ENGINES = ["von", "laya"]; // ordre d'essai ; le suivant prend le relais si le précédent est indisponible
const ENGINE_LIMIT_MS = 120_000; // démarrage paresseux du moteur inclus (premier appel Laya ≈ 37 s)
const NEGATION = /(?:\bsans|\baucune?s?|\bpas d['’e]|\bjamais d['’e]|\bzéro|\bno|\bwithout|\b0)\s*$/i;

// [libellé affiché, motif, la négation immédiate l'annule]
const RULES = [
  ["erreur", /\berreurs?\b/gi, true],
  ["échec", /[ée]chec/gi, true],
  ["échoué", /[ée]chou[ée]/gi, false],
  ["n'ai pas pu", /n['’]ai pas pu/gi, false],
  ["impossible", /impossible/gi, true],
  ["timeout", /time[\s-]?out/gi, true],
  ["402", /\b402\b/g, false],
  ["429", /\b429\b/g, false],
  ["API Error", /api error/gi, true],
  ["non terminé", /non[\s-]termin[ée]/gi, false],
  ["partiel", /partiel/gi, false],
  ["rien n'a été", /rien n['’]a [ée]t[ée]/gi, false],
];
const TRAILING_QUESTION = /\?[\s"'»”’)\]*_]*$/;

// Libellés des règles déclenchées par `text` (liste vide si rien).
export function rulesOf(text) {
  const flat = String(text ?? "");
  const hits = [];
  for (const [label, pattern, negatable] of RULES) {
    pattern.lastIndex = 0;
    for (const match of flat.matchAll(pattern)) {
      if (negatable && NEGATION.test(flat.slice(Math.max(0, match.index - 14), match.index))) continue;
      hits.push(label);
      break;
    }
  }
  if (TRAILING_QUESTION.test(flat.trim())) hits.push("question sans réponse");
  return hits;
}

// Avis final d'après les règles déclenchées et la probabilité `noul` (null si aucun moteur) du moteur `source`.
export function verdictOf(rules, noul, source = "laya") {
  if (rules.length || (noul !== null && noul < LOW)) return "a_verifier";
  if (noul !== null && noul >= (HIGH[source] ?? HIGH.laya)) return "probablement_ok";
  return "incertain";
}

const french = (p) => p.toFixed(2).replace(".", ",");

// Lit la probabilité `noul` de la réponse de Laya ; null si elle n'est pas un nombre de [0, 1].
export function noulOf(answers, name = QUESTION) {
  const value = answers?.[name]?.noul;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

export function layaState(title, summary) {
  const head = `Tâche demandée : ${String(title ?? "").replace(/\s+/g, " ").trim()}\nCompte-rendu de l'agent : `;
  return (head + String(summary ?? "").replace(/\s+/g, " ").trim()).slice(0, STATE_MAX);
}

export function register(ctx) {
  const { onMessage, send, broadcast } = ctx;
  const delay = () => {
    const value = Number(process.env.REVIEWBADGE_DELAY_MS);
    return process.env.REVIEWBADGE_DELAY_MS !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
  };
  const pending = new Map(); // taskId -> clé en cours de calcul
  let queue = Promise.resolve(); // un calcul à la fois : les moteurs ne sont jamais interrogés en parallèle

  const read = () => {
    const data = ctx.store.read(FILE, null);
    return Array.isArray(data?.hints) ? data.hints : [];
  };
  function save(entry) {
    const hints = read().filter((h) => h.key !== entry.key);
    hints.push(entry);
    ctx.store.write(FILE, { hints: hints.slice(-KEEP) });
  }
  // Dernier avis de chaque tâche, sauf celles dont un nouveau calcul est en cours.
  function latest(taskId) {
    const byTask = new Map();
    for (const h of read()) byTask.set(h.taskId, h);
    return [...byTask.values()].filter((h) => !pending.has(h.taskId) && (!taskId || h.taskId === taskId))
      .map(({ taskId: id, hint, p, reasons, source, at }) => ({ taskId: id, hint, p, reasons, source, at }));
  }

  // Une question `noul` à un moteur ; null si indisponible (absent, panne, délai) ou sans champ `noul` valide.
  async function askEngine(engine, title, summary) {
    let timer;
    try {
      const limit = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("délai dépassé")), ENGINE_LIMIT_MS);
      });
      const { answers } = await Promise.race([
        ctx.decide.run({
          state: layaState(title, summary),
          questions: { [QUESTION]: { type: "noul", instructions: PROPOSITION } },
        }, { engine }),
        limit,
      ]);
      return noulOf(answers);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  // Von d'abord, puis Laya ; { p, engine } ou null (règles seules).
  async function ask(title, summary) {
    if (!ctx.decide?.run) return null;
    for (const engine of ENGINES) {
      const p = await askEngine(engine, title, summary);
      if (p !== null) return { p, engine };
    }
    return null;
  }

  // Calcule et publie l'avis d'une tâche. Exposé pour les tests ; ne lance jamais.
  async function compute({ id, title, summary, at }) {
    const key = `${id}@${at}`;
    try {
      const rules = rulesOf(summary);
      const answer = await ask(title, summary);
      const p = answer?.p ?? null;
      const hint = verdictOf(rules, p, answer?.engine);
      const reasons = [];
      if (rules.length) reasons.push(`mots : ${rules.join(", ")}`);
      if (answer) reasons.push(`${answer.engine === "von" ? "Von" : "Laya"} ${french(p)}`);
      else reasons.push("Laya indisponible");
      const entry = { key, taskId: id, at, hint, p, reasons, source: answer ? `rules+${answer.engine}` : "rules" };
      const current = pending.get(id);
      if (current && current !== key) return null; // un compte-rendu plus récent a pris la place
      pending.delete(id);
      save(entry);
      broadcast({ type: "reviewhint.update", taskId: id, hint, p, reasons, source: entry.source, at });
      return entry;
    } catch (error) {
      if (pending.get(id) === key) pending.delete(id);
      ctx.log?.("reviewbadge", `avis impossible : ${ctx.safeError?.(error) ?? "erreur"}`);
      return null;
    }
  }

  function note(task) {
    const summary = String(task?.summary ?? "").trim();
    if (!task?.id || !summary) return;
    const key = `${task.id}@${task.at}`;
    if (pending.get(task.id) === key || read().some((h) => h.key === key)) return;
    pending.set(task.id, key);
    // Étape 1, tout de suite : avis par règles seules (le 1er appel du moteur peut prendre ~40 s). Étape 2 : avis affiné par Von ou Laya.
    const early = rulesOf(summary);
    broadcast({
      type: "reviewhint.update", taskId: task.id, hint: verdictOf(early, null),
      p: null, reasons: [...(early.length ? [`mots : ${early.join(", ")}`] : []), "Laya en cours…"], source: "rules", at: task.at,
    });
    const timer = setTimeout(() => {
      queue = queue.then(() => compute({ ...task, summary })).catch(() => {});
    }, delay());
    timer.unref?.();
  }

  ctx.reviewbadge = { note, compute, latest };
  onMessage("reviewhint.get", (ws, m) => send(ws, {
    type: "reviewhint.list", hints: latest(typeof m.taskId === "string" ? m.taskId : ""), ref: m.ref ?? null,
  }));
}
