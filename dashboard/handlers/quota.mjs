// Quotas par fournisseur et repli automatique de moteur (T41). Pose `ctx.quota` ; lecture seule côté interface.
//
// BRANCHEMENT (à faire dans handlers/tasks.mjs par le foreman, PAS ici) :
//   - quand la session d'une tâche tombe en erreur (402, 429, « quota », « limit reached »…) :
//       ctx.quota?.noteFailure(task.engine, texteDeLErreur);     // classe la raison et met le moteur au repos
//   - avant de démarrer ou de relancer une tâche :
//       const pick = ctx.quota?.pickEngine(task.engine);          // { engine, changed, reason, retryAt? }
//       if (pick?.engine && pick.changed) { task.engine = pick.engine; /* journaliser pick.reason */ }
//       if (pick && pick.engine === null) { /* rien de disponible : attendre jusqu'à pick.retryAt */ }
//   `ctx.quota` n'existe qu'après le chargement de ce module (ordre alphabétique : « quota » vient après « agentapi »
//   et avant « tasks ») ; l'appeler depuis un callback ou avec `?.`, jamais pendant `register`.
//
// Règles de repos (par moteur ; crédits et quota épuisent aussi tout le fournisseur) :
//   credit (402, « credits »)         -> 30 min        rate (429, « rate limit »)  -> 2 min
//   quota  (« quota », « limit reached ») -> fin de la fenêtre connue (usage du daemon), sinon 60 min
//   other                             -> aucun repos (la panne est seulement notée dans les échecs récents)
// OpenRouter : seuls les modèles `:free` sont acceptés (la clé n'a aucun crédit). L'alias (sonnet…) est résolu dans
// ~/.claude-openrouter/settings.json en LECTURE : seuls les quatre ANTHROPIC_DEFAULT_*_MODEL sont lus, jamais les clés.
//
// Messages WebSocket : quota.get -> quota.state {providers, cooldowns, fallback, failures, at} ;
// quota.setFallback {engines:["fournisseur/modèle",…]} -> diffusion quota.state ; diffusion quota.state au changement
// (30 s au plus entre deux diffusions). REST lecture : GET /api/v1/quota (ctx.apiRoute).
// Réglages de test (variables d'environnement) : QUOTA_COOLDOWN_SCALE (multiplie les délais de repos),
// QUOTA_BROADCAST_MIN_MS, QUOTA_OPENROUTER_SETTINGS (autre fichier d'alias), QUOTA_TEST_HOOK=1 (quota.test.fail).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redact } from "../lib/redact.mjs";

export const DEFAULT_FALLBACK = [
  "claude-openrouter/sonnet",
  "claude-nvidia/sonnet",
  "pi/nvidia-proxy/nvidia/nemotron-3-ultra-550b-a55b",
];
// FreeBuff (code gratuit, terminal) se classe comme un moteur mais ne lance pas d'agent : il ne sert qu'aux tâches d'ÉCRITURE
// (tâches et délégation) ; jamais pour un lancement d'agent (Auto du lanceur) ni pour un rôle lecture / planification.
export const FREEBUFF_ENGINE = "freebuff/code";
export const REST_MS = { credit: 30 * 60_000, rate: 2 * 60_000, quota: 60 * 60_000 };
const FALLBACK_FILE = "engine-fallback";
const MAX_FALLBACK = 12;
const MAX_FAILURES = 20;
const MAX_REST_MS = 8 * 24 * 3_600_000;
const NEAR_FULL = 85;
const ENGINE_RE = /^[A-Za-z0-9][\w.-]{0,40}(?:\/[\w.:@+-]{1,80}){1,5}$/;
const ALIASES = ["sonnet", "opus", "haiku", "fable"];
const PROVIDER_NAMES = {
  "claude-openrouter": "OpenRouter", "claude-nvidia": "NVIDIA", claude: "Claude", claude2: "Claude 2", codex: "Codex", pi: "Pi",
};
const KIND_TEXT = { credit: "crédits épuisés", rate: "limite de débit", quota: "quota atteint" };

// « 402 », « credits » -> credit ; « rate limit », « 429 » -> rate ; « quota », « limit reached » -> quota.
export function classify(reason) {
  const text = String(reason?.message ?? reason ?? "");
  if (/\b402\b|credit|insufficient (?:funds|balance)|payment required/i.test(text)) return "credit";
  if (/rate[\s_-]?limit|too many requests/i.test(text)) return "rate";
  if (/quota|limit reached|usage limit/i.test(text)) return "quota";
  if (/\b429\b/.test(text)) return "rate";
  return "other";
}

export const providerOf = (engine) => {
  const parts = String(engine).split("/");
  return parts[0] === "pi" && parts[1] ? `pi/${parts[1]}` : parts[0];
};
const providerName = (id) => PROVIDER_NAMES[id] ?? (id.startsWith("pi/") ? `Pi · ${id.slice(3)}` : id);

export function formatDuration(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.ceil(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, "0")}`;
}

const validEngine = (e) => typeof e === "string" && e.length <= 200 && ENGINE_RE.test(e);

export function createQuota({
  store, now = Date.now, broadcast = () => {}, log = () => {}, scale = 1, minBroadcastMs = 30_000,
  settingsFile = join(homedir(), ".claude-openrouter", "settings.json"),
} = {}) {
  const cooldowns = new Map(); // moteur ou « fournisseur/* » -> { engine, kind, since, until, reason }
  const failures = [];
  let usage = {};
  let lastSig = "";
  let lastBroadcastAt = 0;
  let timer = null;

  // ---------- Liste de repli ----------
  function getFallback() {
    const data = store?.read(FALLBACK_FILE, null);
    const list = Array.isArray(data) ? data : data?.engines;
    const clean = Array.isArray(list) ? [...new Set(list.filter(validEngine))] : [];
    return clean.length ? clean : [...DEFAULT_FALLBACK];
  }

  // ---------- OpenRouter : uniquement des modèles gratuits ----------
  function aliasModels() {
    try {
      const env = JSON.parse(readFileSync(settingsFile, "utf8")).env || {};
      const out = {};
      for (const a of ALIASES) {
        const value = env[`ANTHROPIC_DEFAULT_${a.toUpperCase()}_MODEL`];
        if (typeof value === "string" && value) out[a] = value;
      }
      return out;
    } catch {
      return {};
    }
  }
  // undefined = pas un moteur OpenRouter ; null = modèle introuvable ; sinon le modèle réel.
  function openRouterModel(engine) {
    const parts = String(engine).split("/");
    if (parts[0] === "claude-openrouter") {
      const rest = parts.slice(1).join("/");
      return ALIASES.includes(rest) ? aliasModels()[rest] ?? null : rest || null;
    }
    const at = parts.findIndex((p) => /openrouter/i.test(p));
    return at < 0 ? undefined : parts.slice(at + 1).join("/") || null;
  }
  // Raison du refus, ou null si le moteur est autorisé.
  function refusal(engine) {
    const model = openRouterModel(engine);
    if (model === undefined) return null;
    if (model === null) return "modèle OpenRouter introuvable (refusé par prudence)";
    return model.endsWith(":free") ? null : `OpenRouter payant refusé (${model})`;
  }

  // ---------- Repos ----------
  function prune() {
    const t = now();
    for (const [key, c] of cooldowns) if (c.until <= t) cooldowns.delete(key);
  }
  const restOf = (engine) => {
    prune();
    const own = cooldowns.get(engine);
    const wide = cooldowns.get(`${providerOf(engine)}/*`);
    return own && wide ? (own.until >= wide.until ? own : wide) : own ?? wide ?? null;
  };

  function mergedUsage() {
    const byId = new Map();
    for (const data of Object.values(usage)) {
      for (const p of Array.isArray(data?.providers) ? data.providers : []) {
        const id = String(p.providerId ?? p.id ?? "");
        if (!id) continue;
        // « Claude (compte@exemple.fr) » -> « Claude » : le compte n'a rien à faire dans une pastille.
        const name = String(p.displayName || "").replace(/\s*\([^)]*\)\s*$/, "").trim() || providerName(id);
        const entry = byId.get(id) ?? { id, name, status: "unavailable", windows: new Map() };
        if (p.status === "available") entry.status = "available";
        else if (entry.status !== "available") entry.status = p.status || "unavailable";
        for (const w of Array.isArray(p.windows) ? p.windows : []) {
          const key = String(w.id ?? w.label);
          const pct = Number.isFinite(w.usedPct) ? w.usedPct : null;
          const old = entry.windows.get(key);
          if (!old || (pct ?? -1) > (old.usedPct ?? -1)) {
            entry.windows.set(key, { id: key, label: String(w.label ?? key), shortLabel: w.shortLabel ?? null,
              usedPct: pct === null ? null : Math.round(pct), resetsAt: w.resetsAt ?? null });
          }
        }
        byId.set(id, entry);
      }
    }
    return byId;
  }

  // Fin de la fenêtre épuisée du fournisseur du moteur, en ms depuis l'époque ; null si inconnue.
  function windowEnd(engine) {
    const entry = mergedUsage().get(providerOf(engine));
    if (!entry) return null;
    const ends = [...entry.windows.values()]
      .filter((w) => (w.usedPct ?? 0) >= 95 && w.resetsAt)
      .map((w) => Date.parse(w.resetsAt))
      .filter((t) => Number.isFinite(t) && t > now());
    return ends.length ? Math.max(...ends) : null;
  }

  function noteFailure(engine, reason) {
    if (typeof engine !== "string" || !engine || engine.length > 200) return null;
    const kind = classify(reason);
    const t = now();
    const text = redact(String(reason?.message ?? reason ?? "")).replace(/\s+/g, " ").trim().slice(0, 160);
    failures.unshift({ engine, kind, reason: text, at: t });
    failures.length = Math.min(failures.length, MAX_FAILURES);
    let until = null;
    if (kind !== "other") {
      const end = kind === "quota" ? windowEnd(engine) : null;
      until = Math.min(end ?? t + REST_MS[kind] * scale, t + MAX_REST_MS);
      const keys = kind === "rate" ? [engine] : [engine, `${providerOf(engine)}/*`];
      for (const key of keys) {
        const old = cooldowns.get(key);
        if (old && old.until >= until) continue; // un repos plus long déjà en cours est conservé tel quel
        cooldowns.set(key, { engine: key, kind, since: old?.since ?? t, until, reason: text });
      }
      log("quota", `${engine} au repos (${kind}) pour ${formatDuration(until - t)}`);
    }
    tick();
    return { engine, kind, until, restMs: until === null ? 0 : until - t };
  }

  function pickEngine(preferred, role, opts = {}) {
    const verdict = (engine) => {
      if (engine === FREEBUFF_ENGINE && (opts.agentsOnly || (role && role !== "writer"))) return `${engine} ne convient pas ici (tâches d'écriture seulement)`;
      const refused = refusal(engine);
      if (refused) return refused;
      const rest = restOf(engine);
      return rest ? `${engine} au repos (${KIND_TEXT[rest.kind]}, encore ${formatDuration(rest.until - now())})` : null;
    };
    const why = preferred ? verdict(preferred) : "aucun moteur demandé";
    if (preferred && !why) return { engine: preferred, changed: false, reason: null };
    const tried = [];
    for (const candidate of getFallback()) {
      if (candidate === preferred) continue;
      const bad = verdict(candidate);
      if (!bad) return { engine: candidate, changed: true, reason: `${why} -> repli sur ${candidate}` };
      tried.push(bad);
    }
    const retry = [...cooldowns.values()].map((c) => c.until);
    return {
      engine: null, changed: false, retryAt: retry.length ? Math.min(...retry) : null,
      reason: `aucun moteur disponible (${[why, ...tried].filter(Boolean).join(" ; ")})`,
    };
  }

  // ---------- Vue d'ensemble ----------
  function providersView() {
    prune();
    const merged = mergedUsage();
    const fallback = getFallback();
    for (const engine of [...fallback, ...[...cooldowns.values()].map((c) => c.engine)]) {
      const id = providerOf(engine);
      if (!merged.has(id)) merged.set(id, { id, name: providerName(id), status: null, windows: new Map() });
    }
    const t = now();
    // Claude 2 (seconde configuration) n'apparaît que s'il est connecté : sinon la pastille n'a rien à dire.
    const connected = (p) => p.id !== "claude2" || p.status === "available";
    return [...merged.values()].filter(connected).map((p) => {
      const rests = [...cooldowns.values()].filter((c) => providerOf(c.engine) === p.id);
      const worst = rests.find((c) => c.kind !== "rate") ?? rests[0] ?? null;
      const windows = [...p.windows.values()];
      const top = Math.max(-1, ...windows.map((w) => w.usedPct ?? -1));
      let state = "ok";
      let detail = "disponible";
      if (worst) {
        state = worst.kind === "rate" ? "slow" : "exhausted";
        detail = `${KIND_TEXT[worst.kind]} (reprise dans ${formatDuration(worst.until - t)})`;
      } else if (top >= 100) {
        [state, detail] = ["exhausted", "fenêtre à 100 %"];
      } else if (top >= NEAR_FULL) {
        [state, detail] = ["slow", `fenêtre à ${top} %`];
      } else if (p.status && p.status !== "available") {
        [state, detail] = ["unknown", "usage indisponible"];
      }
      const until = rests.length ? Math.max(...rests.map((c) => c.until)) : null;
      return { id: p.id, name: p.name, state, detail, windows, until, remainingMs: until === null ? null : until - t };
    });
  }

  function describeEngine(engine) {
    const t = now();
    const rest = restOf(engine);
    return { engine, refused: refusal(engine), resting: Boolean(rest), restKind: rest?.kind ?? null,
      restRemainingMs: rest ? rest.until - t : null };
  }
  function snapshot() {
    prune();
    const t = now();
    return {
      at: t,
      providers: providersView(),
      cooldowns: [...cooldowns.values()].map((c) => ({
        engine: c.engine, provider: providerOf(c.engine), kind: c.kind, since: c.since,
        until: c.until, remainingMs: c.until - t, reason: c.reason,
      })),
      fallback: getFallback().map(describeEngine),
      failures: failures.map((f) => ({ ...f })),
    };
  }

  // ---------- Diffusion au changement (30 s au plus) ----------
  const signature = () => {
    const s = snapshot();
    return JSON.stringify({
      p: s.providers.map((p) => [p.id, p.state, p.windows.map((w) => w.usedPct)]),
      c: s.cooldowns.map((c) => [c.engine, c.kind, c.until]),
      f: s.fallback, x: failures[0]?.at ?? 0,
    });
  };
  function emit() {
    lastBroadcastAt = now();
    lastSig = signature();
    broadcast({ type: "quota.state", ...snapshot(), ref: null });
  }
  function arm() {
    clearTimeout(timer);
    const due = [...cooldowns.values()].map((c) => c.until);
    if (signature() !== lastSig) due.push(lastBroadcastAt + minBroadcastMs);
    if (!due.length) return;
    const delay = Math.min(Math.max(20, Math.min(...due) - now() + 5), 6 * 3_600_000);
    timer = setTimeout(tick, delay);
    timer.unref?.();
  }
  function tick() {
    prune();
    if (signature() !== lastSig && now() - lastBroadcastAt >= minBroadcastMs) emit();
    arm();
  }
  lastSig = signature();

  return {
    snapshot, noteFailure, pickEngine, getFallback, classify, tick, arm,
    ingest(state) {
      usage = state?.usage && typeof state.usage === "object" ? state.usage : {};
      tick();
    },
    setFallback(engines) {
      if (!Array.isArray(engines) || !engines.length) throw new Error("la liste de repli est vide");
      if (engines.length > MAX_FALLBACK) throw new Error(`maximum ${MAX_FALLBACK} moteurs de repli`);
      const clean = engines.map((e) => (typeof e === "string" ? e.trim() : e));
      if (clean.some((e) => !validEngine(e))) throw new Error("forme attendue : fournisseur/modèle");
      if (new Set(clean).size !== clean.length) throw new Error("moteur en double dans la liste de repli");
      for (const engine of clean) {
        const refused = refusal(engine);
        if (refused) throw new Error(`${engine} : ${refused}`);
      }
      store.write(FALLBACK_FILE, { engines: clean, updatedAt: new Date(now()).toISOString() });
      emit();
      arm();
      return clean;
    },
    stop: () => clearTimeout(timer),
  };
}

export function register(ctx) {
  const { onMessage, send, sendError, broadcast, log } = ctx;
  const num = (name, fallback) => {
    const value = Number(process.env[name]);
    return process.env[name] && Number.isFinite(value) ? value : fallback;
  };
  const quota = createQuota({
    store: ctx.store, broadcast, log,
    scale: num("QUOTA_COOLDOWN_SCALE", 1), minBroadcastMs: num("QUOTA_BROADCAST_MIN_MS", 30_000),
    ...(process.env.QUOTA_OPENROUTER_SETTINGS ? { settingsFile: process.env.QUOTA_OPENROUTER_SETTINGS } : {}),
  });
  ctx.quota = quota;

  onMessage("quota.get", (ws, m) => send(ws, { type: "quota.state", ...quota.snapshot(), ref: m.ref ?? null }));
  onMessage("quota.setFallback", (ws, m) => {
    try {
      quota.setFallback(m.engines);
    } catch (e) {
      sendError(ws, ctx.safeError(e));
    }
  });
  // Réservé aux tests d'instance isolée : provoque un échec de moteur sans appeler de fournisseur.
  if (process.env.QUOTA_TEST_HOOK === "1") {
    onMessage("quota.test.fail", (ws, m) => {
      const result = quota.noteFailure(String(m.engine ?? ""), String(m.reason ?? ""));
      send(ws, { type: "quota.test.failed", result, ref: m.ref ?? null });
    });
  }
  ctx.onStateChange((state) => quota.ingest(state));
  ctx.apiRoute?.("GET", "/quota", () => quota.snapshot());
  return () => quota.stop();
}
