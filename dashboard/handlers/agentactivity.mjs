// Historique d'activité de l'agent (T29) : journal des appels mutants de /api/v1, visible en direct dans l'interface.
// État persistant dans data/agent-activity.json (tableau, écriture atomique via ctx.store, 500 entrées au plus).
// Messages WS : agentactivity.list (réponse agentactivity.list) ; diffusion agentactivity.added à chaque entrée.
// Alimenté par handlers/agentapi.mjs via ctx.agentActivity.record(...) ; les textes y sont déjà expurgés des secrets.
import { randomUUID } from "node:crypto";

const FILE = "agent-activity";
export const MAX_ENTRIES = 500;
const DEFAULT_LIST = 50;
const MAX_ROUTE = 160;
const MAX_SUMMARY = 200;

const clip = (value, max) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

// Ne garde que les champs attendus, du bon type et plafonnés : le fichier relu peut avoir été modifié à la main.
export function cleanEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const at = typeof raw.at === "string" && !Number.isNaN(Date.parse(raw.at)) ? raw.at : null;
  if (!at || typeof raw.id !== "string") return null;
  return {
    id: clip(raw.id, 64),
    at,
    method: clip(raw.method, 10).toUpperCase(),
    route: clip(raw.route, MAX_ROUTE),
    ok: raw.ok === true,
    status: Number.isInteger(raw.status) ? raw.status : 0,
    summary: clip(raw.summary, MAX_SUMMARY),
    mandateActive: raw.mandateActive === true,
  };
}

export function register(ctx) {
  const { onMessage, send, broadcast, store, log } = ctx;

  const saved = store.read(FILE, []);
  let entries = (Array.isArray(saved) ? saved : []).map(cleanEntry).filter(Boolean).slice(-MAX_ENTRIES);

  function record({ method, route, ok, status, summary, mandateActive }) {
    const entry = cleanEntry({
      id: randomUUID(), at: new Date().toISOString(), method, route, ok, status, summary, mandateActive,
    });
    if (!entry) return null;
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
    try {
      store.write(FILE, entries);
    } catch (e) {
      log("agentactivity", `écriture impossible : ${ctx.safeError(e)}`);
    }
    broadcast({ type: "agentactivity.added", entry });
    return entry;
  }

  ctx.agentActivity = { record, list: (limit = DEFAULT_LIST) => entries.slice(-limit).reverse() };

  onMessage("agentactivity.list", (ws, m) => {
    const wanted = Number.isInteger(m.limit) ? m.limit : DEFAULT_LIST;
    const limit = Math.min(Math.max(wanted, 1), MAX_ENTRIES);
    send(ws, { type: "agentactivity.list", entries: ctx.agentActivity.list(limit), total: entries.length, ref: m.ref ?? null });
  });
}
