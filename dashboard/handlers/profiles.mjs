// Agents de base (profils) : modèles d'agents prêts à l'emploi — Planificateur, Relecteur du plan, Développeur, Relecteur de code,
// Testeur, Rédacteur de doc — que l'orchestrateur appelle par leur identifiant au lieu de réécrire une consigne à chaque fois,
// et que Philippe peut créer, modifier ou supprimer. Persisté dans data/agent-profiles.json.
// Messages WS : profile.list (→ profile.list {profiles}), profile.save {profile}, profile.delete {id}, profile.reset ; diffusion profile.list.
// T40 : l'agent de base « verifier » (vérificateur aveugle) est ajouté aux fichiers déjà enregistrés (clé `seen` : agents de
// base connus à la dernière écriture ; un agent de base supprimé par Philippe n'est donc pas ressuscité).
// REST : GET /api/v1/profiles, POST /api/v1/profiles. Utilisé par tasks.mjs (`task.create {profile}`) via ctx.profiles.
const FILE = "agent-profiles";
const ROLES = ["writer", "reader", "planner"];
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX = { name: 60, description: 200, instructions: 4000, engine: 200, mode: 40 };
const MAX_PROFILES = 40;
export const DEFAULT_ENGINE = "claude-openrouter/sonnet"; // moteur quand ni la demande ni le profil n'en fixent un

const LEGACY_DEFAULTS = ["plan", "plan-review", "dev", "review", "test", "doc"]; // agents de base d'avant la clé `seen`

const READ_ONLY = "Tu es en LECTURE SEULE : ne modifie, ne crée et ne supprime aucun fichier ; réponds uniquement par écrit.";

export const DEFAULT_PROFILES = [
  {
    id: "plan", name: "Planificateur", role: "planner",
    description: "Écrit un plan d'action découpé en étapes vérifiables, sans toucher au code.",
    instructions: `Tu es le PLANIFICATEUR. Lis le projet, puis écris un plan court : objectif, étapes numérotées (chacune vérifiable), fichiers concernés, risques. ${READ_ONLY}`,
  },
  {
    id: "plan-review", name: "Relecteur du plan", role: "reader",
    description: "Relit un plan : trous, ordre des étapes, risques oubliés, tâches mal réparties.",
    instructions: `Tu es le RELECTEUR DU PLAN. On te donne un plan (dans la consigne ou dans un fichier). Vérifie : étapes manquantes, ordre, dépendances, risques, tâches mal réparties. Réponds par une liste courte « à corriger » puis un verdict (OK / à revoir). ${READ_ONLY}`,
  },
  {
    id: "dev", name: "Développeur", role: "writer",
    description: "Implémente exactement ce qui est demandé, petit à petit, et vérifie que ça marche.",
    instructions: "Tu es le DÉVELOPPEUR. Implémente uniquement ce qui est demandé, avec le plus petit changement possible, dans le style du code existant. Lance la vérification (build ou tests) avant de répondre. Compte-rendu : fichiers modifiés et résultat de la vérification.",
  },
  {
    id: "review", name: "Relecteur de code", role: "reader",
    description: "Relit le code modifié (git diff) : bugs, régressions, oublis, sécurité.",
    instructions: `Tu es le RELECTEUR DE CODE. Regarde ce qui a été modifié (git status, git diff, ou les fichiers cités). Cherche bugs, régressions, cas limites oubliés, failles de sécurité, code mort. Réponds par une liste classée par gravité (fichier:ligne, problème, correction proposée) puis un verdict. ${READ_ONLY}`,
  },
  {
    id: "test", name: "Testeur", role: "writer",
    description: "Lance les tests, écrit les tests manquants et rapporte ce qui casse.",
    instructions: "Tu es le TESTEUR. Lance les tests existants, écris les tests manquants pour la zone modifiée, et rapporte précisément ce qui casse (commande, sortie, cause probable). Ne corrige pas le code de production : signale-le.",
  },
  {
    id: "doc", name: "Rédacteur de doc", role: "writer",
    description: "Met à jour README et commentaires pour refléter le code actuel.",
    instructions: "Tu es le RÉDACTEUR DE DOC. Mets à jour la documentation (README, commentaires utiles) pour qu'elle décrive le code tel qu'il est maintenant, en langage simple. Ne modifie pas le code.",
  },
  {
    id: "verifier", name: "Vérificateur", role: "reader",
    description: "Vérificateur aveugle : refait lui-même les vérifications et rend un verdict PASS / FAIL / PASS_WITH_NOTES.",
    instructions: "Tu es le VÉRIFICATEUR AVEUGLE. Tu reçois la consigne d'origine, pas le compte-rendu de celui qui a travaillé : ne lui fais JAMAIS confiance et ne te fie à aucune affirmation « ça marche ». Retrouve ce qui a été fait (git status, git diff, fichiers concernés), puis reproduis toi-même chaque vérification : lance les tests, le build ou les commandes utiles et lis leur sortie. Tu peux lancer des commandes en lecture seule, mais tu ne modifies, ne crées et ne supprimes aucun fichier du projet. PREMIÈRE LIGNE de ta réponse : exactement PASS, FAIL ou PASS_WITH_NOTES (rien d'autre sur cette ligne). Ensuite : chaque point de la consigne avec la commande lancée, sa sortie et ta conclusion ; ce que tu n'as pas pu vérifier (écris NON VÉRIFIÉ) ; les remarques. En cas de doute, réponds FAIL.",
  },
].map((p) => ({ engine: "", mode: "", builtin: true, ...p }));

const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);

export function normalize(raw, { builtin = false } = {}) {
  const id = clean(raw?.id, 40).toLowerCase();
  if (!ID.test(id)) return { error: "identifiant invalide (minuscules, chiffres et tirets, 40 caractères au plus)" };
  const name = clean(raw.name, MAX.name);
  if (!name) return { error: "le nom est obligatoire" };
  const instructions = clean(raw.instructions, MAX.instructions);
  if (!instructions) return { error: "les instructions sont obligatoires" };
  const role = ROLES.includes(raw.role) ? raw.role : "writer";
  const engine = clean(raw.engine, MAX.engine);
  if (engine && !/^[A-Za-z0-9][\w.-]*\/[\w.:@/-]+$/.test(engine)) return { error: "le moteur doit avoir la forme fournisseur/modèle" };
  const mode = clean(raw.mode, MAX.mode);
  if (!/^[\w.-]*$/.test(mode)) return { error: "mode invalide" };
  return { profile: { id, name, description: clean(raw.description, MAX.description), instructions, role, engine, mode, builtin } };
}

// Applique un profil aux champs d'une création de tâche : la consigne du profil précède la tâche demandée.
export function applyProfile(profile, fields) {
  const task = clean(fields.description, 3000) || clean(fields.title, 200);
  return {
    ...fields,
    title: clean(fields.title, 200) || profile.name,
    description: `${profile.instructions}\n\n--- TÂCHE ---\n${task}`,
    engine: clean(fields.engine, 200) || profile.engine || DEFAULT_ENGINE,
    mode: fields.mode || profile.mode || fields.mode,
    role: fields.role || profile.role,
  };
}

export function register(ctx) {
  const { onMessage, send, broadcast, sendError, store } = ctx;

  let added = false; // des agents de base nouveaux ont été ajoutés à un fichier existant
  const load = () => {
    const saved = store.read(FILE, null);
    if (!saved || !Array.isArray(saved.profiles)) return DEFAULT_PROFILES.map((p) => ({ ...p }));
    const list = saved.profiles.map((p) => normalize(p, { builtin: Boolean(p.builtin) }).profile).filter(Boolean);
    const seen = Array.isArray(saved.seen) ? saved.seen : LEGACY_DEFAULTS;
    for (const d of DEFAULT_PROFILES) {
      if (seen.includes(d.id) || list.some((p) => p.id === d.id) || list.length >= MAX_PROFILES) continue;
      list.push({ ...d });
      added = true;
    }
    return list;
  };
  let profiles = load();
  const persist = () => store.write(FILE, { profiles, seen: DEFAULT_PROFILES.map((p) => p.id) });
  if (added) persist();
  const announce = () => broadcast({ type: "profile.list", profiles });

  const save = (raw) => {
    const existing = profiles.find((p) => p.id === String(raw?.id ?? "").toLowerCase());
    const found = normalize(raw, { builtin: Boolean(existing?.builtin) });
    if (found.error) return found;
    const at = profiles.findIndex((p) => p.id === found.profile.id);
    if (at < 0 && profiles.length >= MAX_PROFILES) return { error: `maximum ${MAX_PROFILES} agents` };
    if (at >= 0) profiles[at] = found.profile;
    else profiles.push(found.profile);
    persist();
    announce();
    return found;
  };

  ctx.profiles = {
    list: () => profiles.map((p) => ({ ...p })),
    get: (id) => profiles.find((p) => p.id === String(id ?? "").toLowerCase()) || null,
    apply: (id, fields) => {
      const profile = ctx.profiles.get(id);
      return profile ? applyProfile(profile, fields) : null;
    },
    save,
  };

  onMessage("profile.list", (ws) => send(ws, { type: "profile.list", profiles }));
  onMessage("profile.save", (ws, m) => {
    const r = save(m.profile);
    if (r.error) sendError(ws, r.error);
  });
  onMessage("profile.delete", (ws, m) => {
    const before = profiles.length;
    profiles = profiles.filter((p) => p.id !== String(m.id ?? "").toLowerCase());
    if (profiles.length === before) return sendError(ws, "agent introuvable");
    persist();
    announce();
  });
  onMessage("profile.reset", () => {
    // Restaure les agents de base sans toucher aux agents créés par Philippe.
    const custom = profiles.filter((p) => !DEFAULT_PROFILES.some((d) => d.id === p.id));
    profiles = [...DEFAULT_PROFILES.map((p) => ({ ...p })), ...custom];
    persist();
    announce();
  });

  // Lecture seule pour les agents (l'orchestrateur choisit un agent de base ; seul Philippe en crée ou en modifie).
  ctx.apiRoute?.("GET", "/profiles", () => ({
    profiles: profiles.map(({ id, name, description, role, engine }) => ({ id, name, description, role, engine })),
  }));
}
