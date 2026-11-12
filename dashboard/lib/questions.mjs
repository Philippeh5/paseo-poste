// Questions de direction posées par un agent (outil AskUserQuestion de Claude Code) : le daemon les transmet comme une demande de
// permission de type « question » dont l'entrée contient les questions et leurs options. On les expose proprement (texte borné) et on
// valide la réponse : {answers: {"<texte de la question>": "<option choisie>"}} ; une question à choix multiples accepte plusieurs options.
const clip = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function extractQuestions(p) {
  if (p?.kind !== "question" || !Array.isArray(p?.input?.questions)) return null;
  const qs = p.input.questions.slice(0, 4).map((q) => ({
    question: clip(q?.question, 300),
    header: clip(q?.header, 40),
    multiSelect: q?.multiSelect === true,
    options: (Array.isArray(q?.options) ? q.options : []).slice(0, 6)
      .map((o) => ({ label: clip(o?.label, 100), description: clip(o?.description, 200) })).filter((o) => o.label),
  })).filter((q) => q.question);
  return qs.length ? qs : null;
}

// Réponse reçue (objet question -> option(s)) → objet propre, ou lève une erreur lisible. Texte libre accepté (« Autre »), plafonné.
export function cleanAnswers(raw, questions) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("answers : objet {question: réponse} attendu");
  const out = {};
  for (const q of questions || []) {
    const v = raw[q.question] ?? (q.header ? raw[q.header] : undefined);
    if (v === undefined || v === null || v === "") continue;
    const list = (Array.isArray(v) ? v : [v]).map((x) => clip(x, 300)).filter(Boolean);
    if (!list.length) continue;
    if (!q.multiSelect && list.length > 1) throw new Error(`« ${clip(q.question, 60)} » n'accepte qu'une seule réponse`);
    out[q.question] = list.join(", ");
  }
  if (!Object.keys(out).length) throw new Error("aucune réponse reconnue pour cette question");
  return out;
}
