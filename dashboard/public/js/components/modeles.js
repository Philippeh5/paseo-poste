// Section « Modèles » de la page Connexions : le modèle derrière l'alias « sonnet » (le plus utilisé) de Claude via OpenRouter
// et de Claude via NVIDIA, une ligne par fournisseur avec un bouton Tester. Le reste (opus / haiku / fable, filtre du catalogue,
// ordre de repli des moteurs) est dans « Avancé », replié. Données : handlers/models.mjs. Textes via el() : aucun innerHTML dynamique.
import { el } from "../core/util.js";
import { send, on, onConnection } from "../core/socket.js";
import { confirmDialog } from "../core/confirm.js";
import { toast } from "../core/toast.js";
import { fallbackSection, onQuotaChange } from "./quota.js";

const MAIN_ALIAS = "sonnet";
const ALIAS_LABEL = { opus: "Opus (le plus puissant)", haiku: "Haiku (rapide)", fable: "Fable" };
let st = null;             // dernier models.state
let rerender = () => {};
let advancedOpen = false;
const filters = new Map(); // provider -> texte de filtre
const picked = new Map();  // "provider|alias" -> modèle choisi mais pas encore enregistré
const tests = new Map();   // "provider|model" -> résultat du test

const ctxText = (n) => (n ? `${Math.round(n / 1000)}k` : "");
const optionText = (m) => `${m.id}${m.context ? ` · ${ctxText(m.context)}` : ""}${m.tools === false ? " · sans outils" : ""}`;
const testLabel = (result) => (result === "…" ? "Test en cours…" : result
  ? (result.ok ? `✔ répond (${(result.ms / 1000).toFixed(1)} s)` : `✖ ${result.error}${result.ms ? ` (${(result.ms / 1000).toFixed(1)} s)` : ""}`) : "");

// Liste déroulante + boutons Tester / Enregistrer d'un alias.
function aliasControls(p, alias, list) {
  const key = `${p.id}|${alias}`;
  const current = p.aliases[alias];
  const chosen = picked.get(key) ?? current ?? "";
  const options = [...list];
  if (chosen && !options.some((m) => m.id === chosen)) options.unshift({ id: chosen, context: null, tools: null });
  const result = tests.get(`${p.id}|${chosen}`);
  const select = el("select", { "aria-label": `Modèle de ${alias} pour ${p.label}`, onchange: (e) => { picked.set(key, e.target.value); rerender(); } },
    options.map((m) => el("option", { value: m.id, selected: m.id === chosen }, optionText(m))));
  const test = el("button", { class: "btn btn-sm", type: "button", disabled: !chosen || result === "…", onclick: () => {
    tests.set(`${p.id}|${chosen}`, "…"); rerender(); send({ type: "models.test", provider: p.id, model: chosen }); } }, "Tester");
  const save = el("button", { class: "btn btn-sm btn-primary", type: "button", disabled: !chosen || chosen === current, onclick: async () => {
    if (await confirmDialog({ title: "Changer de modèle ?", message: `${p.label} · ${alias} → ${chosen}. Les NOUVELLES sessions utiliseront ce modèle.`, confirmLabel: "Enregistrer" }))
      send({ type: "models.set", provider: p.id, alias, model: chosen }); } }, "Enregistrer");
  return { select, test, save, text: testLabel(result) };
}

function providerRow(p) {
  if (!p.available) return el("li", { class: "pilot-row" }, el("span", { class: "pilot-run-status is-fail" }, "Absent"),
    el("div", { class: "pilot-main" }, el("strong", {}, p.label), el("span", { class: "pilot-detail" }, p.problem || "Configuration absente sur cette machine.")));
  const q = (filters.get(p.id) || "").toLowerCase();
  const list = p.catalog.filter((m) => !q || m.id.toLowerCase().includes(q));
  const main = aliasControls(p, MAIN_ALIAS, list);
  return el("li", { class: "pilot-row modeles-row" },
    el("span", { class: "pilot-run-status is-ok" }, "Prêt"),
    el("div", { class: "pilot-main" }, el("strong", {}, `${p.label} · modèle par défaut`),
      el("span", { class: "pilot-detail" }, p.freeOnly ? "modèles gratuits uniquement" : "catalogue NVIDIA"), main.select,
      main.text ? el("span", { class: "pilot-sub", "aria-live": "polite" }, main.text) : null),
    el("div", { class: "pilot-actions" }, main.test, main.save));
}

function advancedProvider(p) {
  if (!p.available) return null;
  const q = (filters.get(p.id) || "").toLowerCase();
  const list = p.catalog.filter((m) => !q || m.id.toLowerCase().includes(q));
  const filter = el("input", { type: "search", placeholder: "Filtrer la liste (nom du modèle)…", value: filters.get(p.id) || "", "aria-label": `Filtrer ${p.label}`,
    oninput: (e) => { filters.set(p.id, e.target.value); const pos = e.target.selectionStart; rerender(); const again = document.querySelector(`input[aria-label="Filtrer ${p.label}"]`); again?.focus(); again?.setSelectionRange(pos, pos); } });
  const rows = Object.keys(ALIAS_LABEL).map((alias) => {
    const c = aliasControls(p, alias, list);
    return el("tr", {}, el("th", { scope: "row" }, ALIAS_LABEL[alias]), el("td", {}, c.select),
      el("td", { class: "pilot-actions-cell" }, c.test, c.save), el("td", { class: "pilot-sub", "aria-live": "polite" }, c.text));
  });
  return el("div", { class: "modeles-adv-prov" },
    el("h3", {}, p.label),
    el("div", { class: "pilot-databar" }, filter, el("span", { class: "pilot-sub" }, `${list.length} / ${p.catalog.length} modèle(s)${p.catalogError ? ` — catalogue : ${p.catalogError}` : ""}`)),
    el("div", { class: "pilot-tablewrap" }, el("table", { class: "pilot-table modeles-table" },
      el("thead", {}, el("tr", {}, el("th", {}, "Alias"), el("th", {}, "Modèle"), el("th", {}, "Actions"), el("th", {}, "Test"))),
      el("tbody", {}, rows))));
}

// Section complète, à insérer dans la page.
export function modelsSection() {
  const providers = st?.providers ?? [];
  const advanced = el("details", { class: "modeles-advanced", open: advancedOpen, ontoggle: (e) => { advancedOpen = e.target.open; } },
    el("summary", {}, "Avancé : autres alias, catalogue, ordre de repli"),
    el("div", { class: "pilot-databar" }, el("button", { class: "btn btn-sm", type: "button", onclick: () => send({ type: "models.refresh" }) }, "Actualiser le catalogue")),
    ...providers.map(advancedProvider),
    el("section", { class: "modeles-fallback" }, fallbackSection({ onTab: rerender, aliases: Object.fromEntries(providers.map((p) => [p.id, p.aliases || {}])) })
      || el("p", { class: "pilot-empty" }, "Chargement de l’ordre de repli…")));
  return el("section", { class: "pilot-group", id: "modeles" },
    el("header", { class: "pilot-group-head" }, el("h2", {}, "Modèles Claude"),
      el("span", { class: "pilot-sub" }, "Un changement n'affecte que les nouvelles sessions.")),
    st ? el("ul", { class: "pilot-list" }, providers.map(providerRow)) : el("p", { class: "pilot-empty", style: "padding:10px 14px" }, "Chargement…"),
    advanced);
}

// À appeler au montage de la page ; retourne la fonction de nettoyage.
export function mountModels(onChange) {
  rerender = onChange;
  const offs = [
    on("models.state", (m) => {
      st = m;
      if (m.saved) { picked.delete(`${m.saved.provider}|${m.saved.alias}`); toast(`${m.saved.alias} → ${m.saved.model}`); }
      onChange();
    }),
    on("models.tested", (m) => { tests.set(`${m.provider}|${m.model}`, m); onChange(); }),
    onQuotaChange(onChange),
    onConnection((up) => { if (up) send({ type: "models.get" }); }),
  ];
  send({ type: "models.get" });
  return () => { for (const off of offs) off(); rerender = () => {}; };
}
