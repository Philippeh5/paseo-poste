// Jauge de quotas de la barre du haut (T41) : une pastille par fournisseur (OK / ralenti / épuisé / inconnu, le délai
// restant en infobulle) et, au clic, un panneau avec les barres 5 h / 7 j et l'ordre de repli des moteurs (haut / bas).
// Données : handlers/quota.mjs (quota.get -> quota.state, diffusé au changement). L'ordre de repli est envoyé par
// quota.setFallback ; le serveur le valide (forme fournisseur/modèle, jamais d'OpenRouter payant) et rediffuse l'état.
// Tous les textes passent par textContent (el() crée des nœuds texte) : aucun innerHTML avec du contenu dynamique.
import { el } from "../core/util.js";
import { on, send, onConnection } from "../core/socket.js";

const TICK_MS = 15_000;
const STATE = {
  ok: { led: "led-ok", text: "OK" },
  slow: { led: "led-attention", text: "Ralenti" },
  exhausted: { led: "led-danger", text: "Épuisé" },
  unknown: { led: "led-inactif", text: "Inconnu" },
};
const KIND_TEXT = { credit: "crédits épuisés", rate: "limite de débit", quota: "quota atteint", other: "erreur" };

let snap = null;      // dernier quota.state reçu
let receivedAt = 0;   // Date.now() à la réception : les délais restants décroissent sans nouveau message
const listeners = new Set();

on("quota.state", (m) => {
  snap = m;
  receivedAt = Date.now();
  for (const fn of listeners) { try { fn(); } catch { /* ignoré */ } }
});
onConnection((up) => { if (up) send({ type: "quota.get" }); });

// « 45 s », « 28 min », « 1 h 05 », « 3 j ».
export function duration(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.ceil(s / 60);
  if (m < 90) return `${m} min`;
  if (m < 2880) return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
  return `${Math.round(m / 1440)} j`;
}
const left = (ms, now = Date.now()) => (ms == null ? null : Math.max(0, ms - (now - receivedAt)));
const plainDetail = (p) => p.detail.replace(/\s*\(reprise dans [^)]*\)/, "").trim();

// Texte d'infobulle d'un fournisseur : état, cause et délai restant.
export function providerTitle(p, now = Date.now()) {
  const base = `${p.name} : ${STATE[p.state]?.text ?? p.state}`;
  const rest = left(p.remainingMs, now);
  if (rest) return `${base} — ${plainDetail(p)}, reprise dans ${duration(rest)}`;
  return p.state === "ok" ? base : `${base} — ${plainDetail(p)}`;
}


// Classement des moteurs de repli : affiché une seule fois, dans la section « Modèles » de la page Connexions (bloc Avancé).
// Le pool de base = les 8 modèles « fournisseur/alias » (OpenRouter et NVIDIA × opus, sonnet, haiku, fable) ; d'autres moteurs déjà présents
// dans la liste (p. ex. Pi) restent classables. Les fonctions lisent le dernier quota.state reçu (`snap`).
const POOL = [["claude-openrouter", "OpenRouter"], ["claude-nvidia", "NVIDIA"]];
const POOL_ALIASES = ["opus", "sonnet", "haiku", "fable"];
// FreeBuff (code gratuit) se classe aussi, mais ne sert qu'aux tâches d'écriture : le poste ne l'utilise ni pour « Auto » du lanceur ni pour la lecture / planification.
export const FREEBUFF_ENGINE = "freebuff/code";
export const ALIAS_ENGINES = [...POOL.flatMap(([id]) => POOL_ALIASES.map((a) => `${id}/${a}`)), FREEBUFF_ENGINE];
let aliasModels = {}; // fournisseur -> { alias: modèle réel }, fourni par la section Modèles

function engineName(engine) {
  if (engine === FREEBUFF_ENGINE) return { title: "FreeBuff · code", model: "tâches d'écriture seulement" };
  const [provider, alias] = engine.split("/");
  const pool = POOL.find(([id]) => id === provider);
  if (!pool || !POOL_ALIASES.includes(alias)) return { title: engine, model: null };
  const real = aliasModels[provider]?.[alias];
  return { title: `${pool[1]} · ${alias[0].toUpperCase()}${alias.slice(1)}`, model: real || null };
}
let rerender = () => {};
const entries = () => snap.fallback;
const save = (engines) => send({ type: "quota.setFallback", engines });
const ranked = () => (entries() || []).map((f) => f.engine);

function move(index, delta) {
  const engines = ranked();
  const to = index + delta;
  if (to < 0 || to >= engines.length) return;
  [engines[index], engines[to]] = [engines[to], engines[index]];
  save(engines);
}

function engineRow(f, i, count, now) {
  const rest = f.resting ? left(f.restRemainingMs, now) : null;
  const status = f.refused ? f.refused
    : rest != null ? `au repos : ${KIND_TEXT[f.restKind]}, encore ${duration(rest)}` : "disponible";
  const name = engineName(f.engine);
  const btn = (label, glyph, disabled, onclick) => el("button", {
    class: "icon-btn", type: "button", disabled, title: label, "aria-label": `${label} ${f.engine}`, onclick,
  }, glyph);
  return el("li", { class: `qg-engine${f.refused ? " is-refused" : rest != null ? " is-resting" : ""}` },
    el("span", { class: "qg-rank" }, String(i + 1)),
    el("span", { class: "qg-engine-main" }, el("strong", { class: "qg-engine-title" }, name.title),
      name.model && el("code", {}, name.model), !name.model && name.title !== f.engine && el("code", {}, f.engine),
      el("span", { class: "qg-engine-status" }, status)),
    el("span", { class: "qg-move" },
      btn("Monter", "↑", i === 0, () => move(i, -1)), btn("Descendre", "↓", i === count - 1, () => move(i, 1)),
      btn("Retirer du classement", "✕", count === 1, () => save(ranked().filter((e) => e !== f.engine)))));
}

function fallbackBlock(now) {
  const list_ = entries();
  const list = ranked();
  const unused = ALIAS_ENGINES.filter((e) => !list.includes(e));
  const inPool = list.filter((e) => ALIAS_ENGINES.includes(e)).length;
  return el("section", { class: "qg-fallback" },
    el("h3", {}, `Classement des modèles (${inPool} / ${ALIAS_ENGINES.length})`),
    el("p", { class: "qg-hint" }, "Si un moteur est épuisé, la tâche passe au premier moteur disponible, dans cet ordre."),
    el("ol", { class: "qg-order", "aria-label": "Classement des moteurs de repli" },
      list_.map((f, i) => engineRow(f, i, list_.length, now))),
    unused.length ? el("div", { class: "qg-unused" },
      el("h4", {}, `Hors classement (${unused.length})`),
      el("ul", { class: "qg-order" }, unused.map((engine) => {
        const name = engineName(engine);
        return el("li", { class: "qg-engine is-unused" }, el("span", { class: "qg-rank", "aria-hidden": "true" }, "+"),
          el("span", { class: "qg-engine-main" }, el("strong", { class: "qg-engine-title" }, name.title), name.model && el("code", {}, name.model)),
          el("button", { class: "btn btn-sm", type: "button", "aria-label": `Ajouter ${engine}`, onclick: () => save([...list, engine]) }, "Ajouter"));
      })),
      el("button", { class: "btn btn-sm", type: "button", onclick: () => save([...list, ...unused]) }, `Classer les ${unused.length} autres à la suite`)) : null);
}

export function fallbackSection({ aliases, onTab } = {}) {
  if (aliases) aliasModels = aliases;
  if (onTab) rerender = onTab;
  return snap ? fallbackBlock(Date.now()) : null;
}
export const onQuotaChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export function windowRow(w, now) {
  const pct = w.usedPct ?? 0;
  const tone = pct >= 100 ? "is-danger" : pct >= 85 ? "is-warn" : "";
  const reset = w.resetsAt ? Date.parse(w.resetsAt) - now : null;
  return el("div", { class: "qg-window" },
    el("div", { class: "qg-window-head" }, el("span", {}, w.label || w.shortLabel || "Fenêtre"),
      el("span", { class: "qg-num" }, w.usedPct == null ? "—" : `${w.usedPct} %`)),
    el("div", {
      class: `qg-bar ${tone}`, role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100",
      "aria-valuenow": String(Math.min(100, pct)), "aria-label": `${w.label} : ${pct} % utilisé`,
    }, el("i", { style: `width:${Math.min(100, Math.max(0, pct))}%` })),
    reset != null && reset > 0 ? el("div", { class: "qg-reset" }, `Remise à zéro dans ${duration(reset)}`) : null);
}

// Quotas d'un fournisseur sur une ligne de la page Connexions : mêmes barres 5 h / 7 j que le panneau de la barre du haut.
export function providerWindows(p, now = Date.now()) {
  if (!p.windows?.length) return p.state === "ok" ? null : el("span", { class: "pilot-detail" }, `Quota : ${plainDetail(p)}`);
  return el("div", { class: "qg-inline" }, p.windows.map((w) => windowRow(w, now)));
}
export function providerSnapshot(ids) {
  if (!snap) return null;
  const list = snap.providers.filter((p) => ids.includes(p.id));
  return list.length ? list : [];
}

export function createQuotaGauge() {
  const pills = el("span", { class: "qg-pills" });
  const worst = el("span", { class: "qg-worst" }); // téléphone : un seul voyant, celui du pire état
  const button = el("button", {
    class: "btn btn-sm qg-button", type: "button", id: "topbar-quota", "aria-haspopup": "dialog",
    "aria-expanded": "false", "aria-controls": "quota-panel", title: "Quotas et moteurs de repli",
  }, pills, worst);

  const body = el("div", { class: "qg-body" });
  const panel = el("aside", {
    class: "qg-panel", id: "quota-panel", "aria-label": "Quotas et moteurs de repli", hidden: true, tabindex: "-1",
  }, el("header", { class: "qg-head" }, el("strong", {}, "Quotas"),
    el("button", { class: "icon-btn", type: "button", id: "quota-close", "aria-label": "Fermer",
      onclick: () => setOpen(false) }, "×")),
  body);

  function providerBlock(p, now) {
    const st = STATE[p.state] ?? STATE.unknown;
    const rest = left(p.remainingMs, now);
    return el("section", { class: "qg-prov", "data-state": p.state },
      el("h3", { class: "qg-prov-head" }, el("span", { class: `led ${st.led}`, "aria-hidden": "true" }),
        el("span", { class: "qg-prov-name" }, p.name), el("span", { class: "qg-prov-state" }, st.text)),
      p.state === "ok" ? null
        : el("p", { class: "qg-prov-detail" }, rest ? `${plainDetail(p)} — reprise dans ${duration(rest)}` : p.detail),
      p.windows.map((w) => windowRow(w, now)));
  }

  function failuresBlock(now) {
    if (!snap.failures.length) return null;
    const age = (f) => duration(now - receivedAt + snap.at - f.at);
    return el("details", { class: "qg-failures" },
      el("summary", {}, `Échecs récents (${snap.failures.length})`),
      el("ul", {}, snap.failures.map((f) => el("li", {},
        el("code", {}, f.engine), ` — ${KIND_TEXT[f.kind] ?? f.kind}, il y a ${age(f)}`,
        f.reason ? el("div", { class: "qg-fail-reason" }, f.reason) : null))));
  }

  function render() {
    const now = Date.now();
    pills.replaceChildren();
    if (!snap) {
      pills.append(el("span", { class: "qg-pill", "data-state": "unknown" },
        el("span", { class: "led led-inactif", "aria-hidden": "true" }), el("span", { class: "qg-name" }, "Quotas")));
      button.setAttribute("aria-label", "Quotas : état inconnu");
      worst.replaceChildren(el("span", { class: "led led-inactif", "aria-hidden": "true" }));
      return;
    }
    for (const p of snap.providers) {
      const st = STATE[p.state] ?? STATE.unknown;
      pills.append(el("span", { class: "qg-pill", "data-state": p.state, title: providerTitle(p, now) },
        el("span", { class: `led ${st.led}`, "aria-hidden": "true" }), el("span", { class: "qg-name" }, p.name)));
    }
    const summary = snap.providers.map((p) => `${p.name} ${STATE[p.state]?.text ?? p.state}`).join(", ");
    button.setAttribute("aria-label", `Quotas : ${summary}`);
    const overall = snap.providers.some((p) => p.state === "exhausted") ? "exhausted"
      : snap.providers.some((p) => p.state === "slow") ? "slow" : "ok";
    button.dataset.state = overall;
    worst.replaceChildren(el("span", { class: `led ${STATE[overall].led}`, "aria-hidden": "true" }));
    button.title = `Quotas : ${summary}`;
    if (!panel.hidden) {
      body.replaceChildren(...snap.providers.map((p) => providerBlock(p, now)),
        el("a", { class: "qg-link", href: "#connexions", onclick: () => setOpen(false) }, "Connexions, quotas et ordre de repli →"));
      const failures = failuresBlock(now);
      if (failures) body.append(failures);
    }
  }

  let timer = null;
  function setOpen(open) {
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    clearInterval(timer);
    timer = open ? setInterval(render, TICK_MS) : null;
    if (open) { send({ type: "quota.get" }); render(); panel.focus(); }
  }
  button.addEventListener("click", () => setOpen(panel.hidden));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) { setOpen(false); button.focus(); }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) setOpen(false);
  });

  listeners.add(render);
  setInterval(render, 30_000); // les infobulles gardent un délai juste même sans nouveau message du serveur
  document.body.append(panel);
  render();
  return button;
}
