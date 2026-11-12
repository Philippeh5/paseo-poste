// Outil « décider » (T29, T47) : relaie une décision typée (choice / score / noul) vers un serveur de décision local
// (CPU) pour les AUTRES modèles et agents. Exposé par POST /api/v1/decide (handlers/agentapi.mjs, via ctx.decide.run),
// postectl decide et l'outil MCP post_decide. Voir dashboard/README.md, « Outil décider ».
// Deux moteurs : « laya » (défaut, 421M, LAYA_URL / LAYA_BIN) et « von » (395M, VON_URL / VON_BIN, modèle « von »),
// choisis par `ctx.decide.run(body, { engine })` ou par le champ facultatif `engine` du corps REST (liste blanche, sinon 400).
// Démarrage paresseux : si le moteur n'écoute pas, on lance son exécutable (toujours sur 127.0.0.1) et on l'arrête avec
// le tableau de bord. Mémoire limitée : UN SEUL moteur lancé par ce tableau de bord vit à la fois (avant de servir un
// moteur on arrête l'autre s'il est le nôtre ; un serveur lancé par autre chose est laissé en place) et un moteur
// inactif est arrêté après DECIDE_IDLE_MS (10 min). Les appels sont donc traités un par un.
// Moteur absent ou en panne : l'appel échoue en 503 et le reste du tableau de bord n'est pas touché.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

export const LIMITS = { state: 2000, questions: 8, instructions: 500, name: 40, options: 26, optionText: 200 };
const REQUEST_TIMEOUT_MS = 10_000;
const IDLE_MS = 10 * 60_000;
const ENGINES = {
  laya: {
    label: "Laya", urlEnv: "LAYA_URL", url: "http://127.0.0.1:8765/v1/systemone", binEnv: "LAYA_BIN",
    bin: "D:\\Projets\\AI-OS\\paseo-lab\\.foreman\\laya-test\\.venv\\Scripts\\laya-serve.exe",
    modelEnv: "LAYA_MODEL", model: "multilingual", startEnv: "LAYA_START_TIMEOUT_MS", other: "von",
    args: () => [],
    env: (port) => ({ LAYA_HOST: "127.0.0.1", LAYA_PORT: String(port), LAYA_MODELS: "multilingual" }),
  },
  von: {
    label: "Von", urlEnv: "VON_URL", url: "http://127.0.0.1:8766/v1/systemone", binEnv: "VON_BIN",
    bin: "D:\\Projets\\AI-OS\\paseo-lab\\.foreman\\von-test\\Scripts\\von.exe",
    modelEnv: "VON_MODEL", model: "von", startEnv: "VON_START_TIMEOUT_MS", other: "laya",
    args: (port) => ["serve", "--host", "127.0.0.1", "--port", String(port)],
    env: () => ({}),
  },
};
export const ENGINE_NAMES = Object.keys(ENGINES);
const TYPES = new Set(["choice", "score", "noul"]);
const NAME = /^[A-Za-z0-9_-]{1,40}$/;
// Sentinelle : si le tableau de bord est tué sans pouvoir se nettoyer (arrêt brutal), elle arrête le moteur à sa place.
const WATCHDOG = `const [parent, child] = process.argv.slice(1).map(Number);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const timer = setInterval(() => {
  if (alive(parent) && alive(child)) return;
  clearInterval(timer);
  if (alive(child)) {
    if (process.platform === "win32") require("node:child_process").spawnSync("taskkill", ["/pid", String(child), "/T", "/F"]);
    else process.kill(child);
  }
}, 1500);`;
const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\])$/i;

export class DecideError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (message) => new DecideError(400, "bad_request", message);
const down = (name, message) => new DecideError(503, `${name}_unavailable`, `${message} Le tableau de bord continue de fonctionner.`);
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clip = (value, max) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

// Validation stricte du corps de POST /decide ; renvoie { state, questions } nettoyés ou lance une erreur 400.
export function validateDecide(body) {
  if (!isPlain(body)) throw bad("corps JSON (objet) attendu : { state, questions }");
  const { state, questions } = body;
  if (typeof state !== "string" || !state.trim()) throw bad("state requis : texte non vide");
  if (state.length > LIMITS.state) throw bad(`state : ${LIMITS.state} caractères au plus`);
  if (!isPlain(questions)) throw bad("questions requis : { nom: { type, instructions, criteria? } }");
  const names = Object.keys(questions);
  if (!names.length) throw bad("questions : au moins une question");
  if (names.length > LIMITS.questions) throw bad(`questions : ${LIMITS.questions} au plus`);
  const clean = [];
  for (const name of names) {
    if (!NAME.test(name)) throw bad(`question « ${clip(name, 20)} » : nom de 1 à ${LIMITS.name} lettres, chiffres, _ ou -`);
    const q = questions[name];
    if (!isPlain(q)) throw bad(`question ${name} : objet attendu`);
    for (const key of Object.keys(q)) {
      if (!["type", "instructions", "criteria"].includes(key)) throw bad(`question ${name} : champ inconnu « ${clip(key, 20)} »`);
    }
    if (!TYPES.has(q.type)) throw bad(`question ${name} : type parmi choice, score, noul`);
    if (typeof q.instructions !== "string" || !q.instructions.trim()) throw bad(`question ${name} : instructions requises`);
    if (q.instructions.length > LIMITS.instructions) {
      throw bad(`question ${name} : instructions de ${LIMITS.instructions} caractères au plus`);
    }
    const out = { type: q.type, instructions: q.instructions.trim() };
    if (q.criteria !== undefined) {
      if (!isPlain(q.criteria)) throw bad(`question ${name} : criteria doit être un objet { option: description }`);
      const options = Object.entries(q.criteria);
      if (options.length > LIMITS.options) throw bad(`question ${name} : ${LIMITS.options} options au plus`);
      for (const [key, text] of options) {
        if (!key || key.length > LIMITS.name) throw bad(`question ${name} : nom d'option de 1 à ${LIMITS.name} caractères`);
        if (typeof text !== "string" || text.length > LIMITS.optionText) {
          throw bad(`question ${name} : description d'option (texte de ${LIMITS.optionText} caractères au plus)`);
        }
      }
      out.criteria = Object.fromEntries(options);
    }
    if (q.type === "choice" && Object.keys(out.criteria || {}).length < 2) {
      throw bad(`question ${name} : un choix demande au moins 2 options dans criteria`);
    }
    clean.push([name, out]);
  }
  return { state: state.trim(), questions: Object.fromEntries(clean) };
}


const listening = (host, port) => new Promise((resolve) => {
  const socket = connect({ host, port });
  const done = (value) => { socket.destroy(); resolve(value); };
  socket.setTimeout(500, () => done(false));
  socket.once("connect", () => done(true));
  socket.once("error", () => done(false));
});

const cleanEnv = (e) => Object.fromEntries(Object.entries(e).filter(([k]) => !/PASSWORD|SECRET|TOKEN|API_?KEY|CREDENTIAL/i.test(k)));

// Moteur demandé : absent -> « laya » ; sinon liste blanche, sinon 400.
function pickEngine(value) {
  if (value === undefined || value === null) return "laya";
  if (typeof value !== "string" || !Object.hasOwn(ENGINES, value)) throw bad(`engine : ${ENGINE_NAMES.join(" ou ")} attendu`);
  return value;
}

export function register(ctx) {
  const env = () => process.env;
  const target = (name) => {
    const url = new URL(env()[ENGINES[name].urlEnv] || ENGINES[name].url);
    return { url, host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) || (url.protocol === "https:" ? 443 : 80) };
  };
  const idleMs = () => (Number(env().DECIDE_IDLE_MS) > 0 ? Number(env().DECIDE_IDLE_MS) : IDLE_MS);
  // child : processus lancé par ce tableau de bord (jamais un serveur déjà présent) ; idle : minuterie d'inactivité
  const state = { laya: { child: null, idle: null }, von: { child: null, idle: null } };

  function stopEngine(name, why = "") {
    const s = state[name];
    clearTimeout(s.idle);
    s.idle = null;
    const proc = s.child;
    s.child = null;
    if (!proc || proc.exitCode !== null || !proc.pid) return false;
    try {
      // laya-serve.exe / von.exe sont des lanceurs : on arrête tout l'arbre de processus pour ne pas laisser Python orphelin.
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
      else proc.kill();
    } catch { /* déjà arrêté */ }
    if (why) ctx.log("decide", `arrêt de ${ENGINES[name].label} (${why})`);
    return true;
  }
  const stopAll = () => { for (const name of ENGINE_NAMES) stopEngine(name); };
  process.on("exit", stopAll);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stopAll);

  // Arrêt automatique d'un moteur que nous avons lancé s'il reste inutilisé DECIDE_IDLE_MS.
  function touch(name) {
    const s = state[name];
    clearTimeout(s.idle);
    s.idle = null;
    if (!s.child) return;
    const ms = idleMs();
    s.idle = setTimeout(() => stopEngine(name, `inactif depuis ${Math.round(ms / 1000)} s`), ms);
    s.idle.unref();
  }

  async function launch(name, t) {
    const e = ENGINES[name];
    const bin = env()[e.binEnv] || e.bin;
    if (!LOOPBACK.test(t.url.hostname)) {
      throw down(name, `${e.label} est injoignable (${t.url.origin}) et ne se lance automatiquement que sur cette machine.`);
    }
    if (!existsSync(bin)) throw down(name, `${e.label} est absent : exécutable introuvable (${bin}).`);
    // Un autre serveur de décision déjà là (pas lancé par nous) n'est jamais arrêté : on le dit seulement.
    try {
      const o = target(e.other);
      if (!state[e.other].child && await listening(o.host, o.port)) {
        ctx.log("decide", `${ENGINES[e.other].label} écoute déjà (port ${o.port}) sans avoir été lancé par le tableau de bord : laissé en place`);
      }
    } catch { /* URL de l'autre moteur invalide : sans objet */ }
    const limit = Number(env()[e.startEnv]) || 90_000;
    let spawnError = null;
    const proc = spawn(bin, e.args(t.port), {
      env: { ...cleanEnv(env()), ...e.env(t.port) },
      stdio: "ignore",
      windowsHide: true,
    });
    proc.once("error", (err) => { spawnError = err; });
    proc.unref(); // ne retient jamais l'arrêt du tableau de bord ; stopEngine() l'arrête explicitement
    state[name].child = proc;
    if (proc.pid) {
      spawn(process.execPath, ["-e", WATCHDOG, String(process.pid), String(proc.pid)], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    }
    ctx.log("decide", `démarrage de ${e.label} (${t.host}:${t.port})`);
    const deadline = Date.now() + limit;
    while (Date.now() < deadline) {
      if (spawnError) { state[name].child = null; throw down(name, `${e.label} n'a pas pu démarrer (${ctx.safeError(spawnError)}).`); }
      if (proc.exitCode !== null) { state[name].child = null; throw down(name, `${e.label} s'est arrêté au démarrage (code ${proc.exitCode}).`); }
      if (await listening("127.0.0.1", t.port)) return;
      await sleep(500);
    }
    stopEngine(name);
    throw down(name, `${e.label} n'a pas répondu dans les ${Math.round(limit / 1000)} s suivant son démarrage.`);
  }

  async function execute(name, request) {
    const e = ENGINES[name];
    clearTimeout(state[name].idle); // jamais d'arrêt d'inactivité en pleine requête
    try {
      stopEngine(e.other, `${e.label} prend la place (mémoire limitée)`);
      const t = target(name);
      if (!(await listening(t.host, t.port))) await launch(name, t);
      const started = performance.now();
      let response;
      try {
        response = await fetch(t.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: env()[e.modelEnv] || e.model, ...request }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        const timeout = err?.name === "TimeoutError" || err?.name === "AbortError";
        throw down(name, timeout ? `${e.label} n'a pas répondu en ${REQUEST_TIMEOUT_MS / 1000} s.` : `${e.label} est injoignable (${t.url.origin}).`);
      }
      const latencyMs = Math.round(performance.now() - started);
      let payload = null;
      try { payload = await response.json(); } catch { /* corps non JSON */ }
      if (response.status >= 400 && response.status < 500) {
        throw bad(`${e.label} a refusé la requête (HTTP ${response.status}) : ${clip(JSON.stringify(payload?.detail ?? payload ?? ""), 200)}`);
      }
      if (!response.ok) throw down(name, `${e.label} est en panne (HTTP ${response.status}).`);
      const answers = payload?.answers ?? payload;
      if (!isPlain(answers)) throw new DecideError(502, `bad_${name}_response`, `réponse inattendue de ${e.label}`);
      ctx.log("decide", `décision rendue par ${e.label} (${Object.keys(request.questions).length} question(s), ${latencyMs} ms)`);
      return { answers, latencyMs, engine: name };
    } finally {
      touch(name);
    }
  }

  // Un seul appel à la fois : jamais deux moteurs vivants en parallèle (mémoire du PC), même en cas d'appels simultanés.
  let chain = Promise.resolve();
  async function run(body, opts = {}) {
    const name = pickEngine(opts?.engine ?? (isPlain(body) ? body.engine : undefined));
    const request = validateDecide(body);
    const result = chain.then(() => execute(name, request));
    chain = result.catch(() => {});
    return result;
  }

  ctx.decide = { run, engines: ENGINE_NAMES };
  ctx.log("decide", `Laya : ${target("laya").url.origin} ; Von : ${target("von").url.origin} `
    + "(lancement paresseux, un seul moteur à la fois, arrêt après inactivité)");
}
