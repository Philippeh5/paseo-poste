// Vue « Modèles » : choisir à la main le modèle derrière chaque alias (opus / sonnet / haiku / fable) de Claude via OpenRouter et
// Claude via NVIDIA, avec le catalogue en ligne (OpenRouter : gratuits seulement) et un bouton de test. Données : handlers/models.mjs.
// Tous les textes passent par el() (nœuds texte) : aucun innerHTML avec du contenu dynamique.
import { registerView } from "./registry.js";
import { el } from "../core/util.js";
import { send, on, onConnection } from "../core/socket.js";
import { confirmDialog } from "../core/confirm.js";
import { toast } from "../core/toast.js";
import { fallbackSection, onQuotaChange } from "../components/quota.js";

const ICON = '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="3"/>' +
  '<path d="M10 2v2.5M10 15.5V18M2 10h2.5M15.5 10H18M4.3 4.3l1.8 1.8M13.9 13.9l1.8 1.8M15.7 4.3l-1.8 1.8M6.1 13.9l-1.8 1.8"/></svg>';

const ALIAS_LABEL = { opus: "Opus (le plus puissant)", sonnet: "Sonnet (par défaut)", haiku: "Haiku (rapide)", fable: "Fable" };
let root; let offs = [];
let st = null;            // dernier models.state
const filters = new Map(); // provider -> texte de filtre
const picked = new Map();  // "provider|alias" -> modèle choisi mais pas encore enregistré
const tests = new Map();   // "provider|model" -> résultat du test

const ctxText = (n) => (n ? `${Math.round(n / 1000)}k` : "");
const optionText = (m) => `${m.id}${m.context ? ` · ${ctxText(m.context)}` : ""}${m.tools === false ? " · sans outils" : ""}`;

function providerCard(p) {
  const head = el("header", { class: "pilot-card-head" }, el("h2", {}, p.label),
    el("span", { class: "pilot-sub" }, p.freeOnly ? "modèles gratuits uniquement" : "catalogue NVIDIA"));
  if (!p.available) return el("section", { class: "pilot-section" }, head, el("p", { class: "pilot-empty" }, p.problem || "Configuration absente sur cette machine."));
  const q = (filters.get(p.id) || "").toLowerCase();
  const list = p.catalog.filter((m) => !q || m.id.toLowerCase().includes(q));
  const filter = el("input", { type: "search", placeholder: "Filtrer la liste (nom du modèle)…", value: filters.get(p.id) || "", "aria-label": `Filtrer ${p.label}`,
    oninput: (e) => { filters.set(p.id, e.target.value); const pos = e.target.selectionStart; render(); const again = root.querySelector(`input[aria-label="Filtrer ${p.label}"]`); again?.focus(); again?.setSelectionRange(pos, pos); } });
  const rows = Object.keys(ALIAS_LABEL).map((alias) => {
    const key = `${p.id}|${alias}`;
    const current = p.aliases[alias];
    const chosen = picked.get(key) ?? current ?? "";
    const options = [...list];
    if (chosen && !options.some((m) => m.id === chosen)) options.unshift({ id: chosen, context: null, tools: null });
    const select = el("select", { "aria-label": `Modèle de ${alias} pour ${p.label}`,
      onchange: (e) => { picked.set(key, e.target.value); render(); } },
    options.map((m) => el("option", { value: m.id, selected: m.id === chosen }, optionText(m))));
    const dirty = chosen && chosen !== current;
    const result = tests.get(`${p.id}|${chosen}`);
    const testText = result === "…" ? "Test en cours…" : result
      ? (result.ok ? `✔ répond (${(result.ms / 1000).toFixed(1)} s)` : `✖ ${result.error}${result.ms ? ` (${(result.ms / 1000).toFixed(1)} s)` : ""}`) : "";
    return el("tr", {},
      el("th", { scope: "row" }, ALIAS_LABEL[alias]),
      el("td", {}, select),
      el("td", { class: "pilot-actions-cell" },
        el("button", { class: "btn btn-sm", type: "button", disabled: !chosen || result === "…", onclick: () => {
          tests.set(`${p.id}|${chosen}`, "…"); render(); send({ type: "models.test", provider: p.id, model: chosen }); } }, "Tester"),
        el("button", { class: "btn btn-sm btn-primary", type: "button", disabled: !dirty, onclick: async () => {
          const yes = await confirmDialog({ title: "Changer de modèle ?",
            message: `${p.label} · ${alias} → ${chosen}. Les NOUVELLES sessions utiliseront ce modèle.`, confirmLabel: "Enregistrer" });
          if (yes) send({ type: "models.set", provider: p.id, alias, model: chosen }); } }, "Enregistrer")),
      el("td", { class: "pilot-sub", "aria-live": "polite" }, testText));
  });
  return el("section", { class: "pilot-section" }, head,
    el("div", { class: "pilot-databar" }, filter,
      el("span", { class: "pilot-sub" }, `${list.length} / ${p.catalog.length} modèle(s)${p.catalogError ? ` — catalogue : ${p.catalogError}` : ""}`)),
    el("div", { class: "pilot-tablewrap" }, el("table", { class: "pilot-table modeles-table" },
      el("thead", {}, el("tr", {}, el("th", {}, "Alias"), el("th", {}, "Modèle"), el("th", {}, "Actions"), el("th", {}, "Test"))),
      el("tbody", {}, rows))));
}

function render() {
  if (!root) return;
  const host = root.querySelector(".pilot");
  const refresh = el("button", { class: "btn", type: "button", onclick: () => send({ type: "models.refresh" }) }, "Actualiser le catalogue");
  host.replaceChildren(
    el("header", { class: "pilot-head" }, el("h1", {}, "Modèles Claude"),
      el("span", { class: "pilot-summary" }, "Choisis le modèle derrière chaque alias. Un changement n'affecte que les nouvelles sessions."), refresh),
    el("section", { class: "pilot-section modeles-fallback" }, fallbackSection({ onTab: render, aliases: Object.fromEntries((st?.providers || []).map((p) => [p.id, p.aliases || {}])) }) || el("p", { class: "pilot-empty" }, "Chargement de l’ordre de repli…")),
    ...(st ? st.providers.map(providerCard) : [el("p", { class: "pilot-empty" }, "Chargement…")]));
}

const view = {
  id: "modeles", title: "Modèles", short: "Modèles", icon: ICON, order: 16,
  mount(container) {
    root = container;
    root.replaceChildren(el("div", { class: "pilot" }));
    render();
    offs.push(on("models.state", (m) => {
      st = m;
      if (m.saved) { picked.delete(`${m.saved.provider}|${m.saved.alias}`); toast(`${m.saved.alias} → ${m.saved.model}`); }
      render();
    }));
    offs.push(on("models.tested", (m) => { tests.set(`${m.provider}|${m.model}`, m); render(); }));
    offs.push(onQuotaChange(render));
    offs.push(onConnection((up) => { if (up) { send({ type: "models.get" }); send({ type: "quota.get" }); } }));
    send({ type: "models.get" });
    send({ type: "quota.get" });
  },
  unmount() { for (const off of offs) off(); offs = []; root = null; },
};

registerView(view);
export default view;
