// Vue « Bots & serveurs » : tout ce qui tourne en arrière-plan sur le poste, avec des boutons.
//   - Services (handlers/services.mjs) : serveurs BlastWin, tunnel, Hermes, daemon Paseo… lancer / relancer / arrêter / journal.
//   - Bot Telegram : superviseur dédié (telegramctl.*).
//   - Recherches : petits formulaires pour le bot de stage (offres stage/emploi, repérage alumni, export).
//   - Données : offres (jobs.db) et alumni (alumni.db) consultables ici, avec recherche, filtres et exports à télécharger.
// Tous les textes passent par el() (nœuds texte) : aucun innerHTML avec du contenu dynamique.
import { registerView } from "./registry.js";
import { el, led } from "../core/util.js";
import { send, on, onConnection } from "../core/socket.js";
import { confirmDialog } from "../core/confirm.js";
import { toast } from "../core/toast.js";
import { getState, allProjects, subscribe } from "../core/state.js";
import { isStarred } from "../core/projects.js";

const ICON = '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="14" height="5" rx="1.5"/>' +
  '<rect x="3" y="12" width="14" height="5" rx="1.5"/><path d="M6 5.5h.01M6 14.5h.01"/></svg>';

const PAGE = 50;
const STATUS_LABEL = { discovered: "Découverte", review: "À examiner", shortlisted: "Retenue", prepared: "Préparée", applied: "Postulé",
  interview: "Entretien", rejected: "Refusée", withdrawn: "Retirée" };

let root; let offs = [];
let svc = null;            // dernier svc.state
let tg = null;             // dernier telegramctl.state
let tgBeat = null;         // dernier telegram.status
let logsOpen = new Map();  // id -> lignes
let timer = null;
let ftTimer = null;
const modeChoice = new Map();
const data = { dataset: "", q: "", facets: {}, marked: "", offset: 0, result: null };
let page = "serveurs";  // sous-page : « serveurs » ou l'id d'un bot
let nav = null;

// ---------- FreqTrade : assistant de lancement ----------
// 5 etapes : type de lancement -> config -> strategie -> donnees & options -> lancement.
// L'etape « donnees » montre ce qui est deja telecharge (paires, timeframes, periodes) et
// propose de telecharger ce qui manque : un backtest sans donnees echoue systematiquement.

const FT_KEY = "pilot-freqtrade-form";
const ftDefaults = {
  step: 0, mode: "trade", config: "", strategy: "", pairs: [], timerange: "", maxTrials: "50",
  dryRun: true, timeframe: "5m", days: "30",
};
const ft = { ...ftDefaults };
try { Object.assign(ft, JSON.parse(sessionStorage.getItem(FT_KEY) || "null")); } catch { /* rien a restaurer */ }
function ftSave() { try { sessionStorage.setItem(FT_KEY, JSON.stringify(ft)); } catch { /* indisponible */ } }

let ftData = null;     // { modes, configs, strategies, pairs }
let ftRanges = [];     // plages reelles : paire, timeframe, du, au, nb de bougies
let runningId = null;  // lancement en cours
let ftLogLines = [];   // journal du lancement en cours
let ftResult = null;   // dernier resultat

const FT_STEP_LABELS = ["1 · Type de lancement", "2 · Configuration", "3 · Stratégie", "4 · Données & options", "5 · Lancement"];
const FT_TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"];
const FT_COLS = ["pair", "timeframe", "from", "to", "candles"];
const FT_HEADS = ["Paire", "Timeframe", "Du", "Au", "Bougies"];

const curBot = () => svc?.bots?.find((b) => b.id === page) ?? null;
let els = {};

const ago = (iso) => {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} j`;
};
const bytes = (n) => (n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);
const safeUrl = (u) => (/^https?:\/\//i.test(String(u)) ? String(u) : null);

function button(label, onclick, { kind = "", title, disabled = false } = {}) {
  return el("button", { class: `btn btn-sm ${kind}`.trim(), type: "button", title, disabled, onclick }, label);
}
// Renommer un service : le nom est gardé par le poste (svc.rename), donc le même sur mobile et sur ordinateur.
function renameService(s) {
  const next = window.prompt(`Nom de « ${s.defaultName} » (vide = nom d'origine)`, s.name);
  if (next !== null) call({ type: "svc.rename", id: s.id, name: next });
}
const call = (message) => { if (!send(message)) toast("Pas de connexion au poste de commande.", { kind: "error" }); };

// ---------- Services ----------
function serviceRow(s) {
  const tone = s.running ? (s.listening === false ? "attention" : "ok") : "inactif";
  const mode = modeChoice.get(s.id) || s.mode || s.modes[0]?.id;
  const detail = s.running
    ? [s.mode ? `mode ${s.modes.find((m) => m.id === s.mode)?.label ?? s.mode}` : "lancé hors du tableau de bord",
      s.port ? `port ${s.port}${s.listening === false ? " (ne répond pas encore)" : ""}` : null,
      s.startedAt ? `depuis ${ago(s.startedAt)}` : null].filter(Boolean).join(" · ")
    : (s.lastError ? `Dernier échec : ${s.lastError}` : "Arrêté");
  const modeSelect = s.modes.length > 1
    ? el("select", { class: "pilot-mode", "aria-label": `Mode de ${s.name}`, onchange: (e) => modeChoice.set(s.id, e.target.value) },
      s.modes.map((m) => el("option", { value: m.id, selected: m.id === mode }, m.label)))
    : null;
  const stop = async () => {
    if (!await confirmDialog({ title: `Arrêter ${s.name} ?`, message: (s.warn ? `${s.warn} ` : "") + (s.managed ? "Le processus lancé ici et ses sous-processus seront fermés."
      : "Ce processus a été lancé à la main (fenêtre noire) : il sera fermé avec ses sous-processus."), confirmLabel: "Arrêter", danger: true })) return;
    call({ type: "svc.stop", id: s.id });
  };
  const restart = async () => {
    if (!await confirmDialog({ title: `Relancer ${s.name} ?`, message: `${s.warn ? `${s.warn} ` : ""}Arrêt puis nouveau lancement.`, confirmLabel: "Relancer" })) return;
    call({ type: "svc.restart", id: s.id, mode });
  };
  return el("li", { class: "pilot-row", dataset: { state: s.running ? "up" : "down" } },
    led(tone, { label: s.running ? "en marche" : "arrêté" }),
    el("div", { class: "pilot-main" }, el("strong", {}, s.name), el("span", { class: "pilot-detail" }, detail)),
    el("div", { class: "pilot-actions" },
      modeSelect,
      s.running ? null : button("Lancer", () => call({ type: "svc.start", id: s.id, mode }), { kind: "btn-primary" }),
      s.running ? button("Relancer", restart) : null,
      s.running ? button("Arrêter", stop, { kind: "btn-danger-ghost" }) : null,
      safeUrl(s.url) && s.running ? el("a", { class: "btn btn-sm", href: s.url, target: "_blank", rel: "noopener noreferrer" }, "Ouvrir") : null,
      button("Renommer", () => renameService(s)),
      button(logsOpen.has(s.id) ? "Masquer le journal" : "Journal", () => toggleLogs(s.id))),
    logsOpen.has(s.id) ? logBox(s.id) : null);
}

function logBox(id) {
  return el("pre", { class: "pilot-log", tabindex: "0", "aria-label": "Journal" }, (logsOpen.get(id) || []).join("\n") || "(journal vide)");
}
function toggleLogs(id) {
  if (logsOpen.has(id)) logsOpen.delete(id); else { logsOpen.set(id, []); requestLogs(id); }
  renderServices();
}
function requestLogs(id) {
  if (id === "telegram") call({ type: "telegramctl.logs", lines: 120 });
  else if (id.startsWith("task-")) call({ type: "svc.task.logs", id: id.slice(5), lines: 120 });
  else call({ type: "svc.logs", id, lines: 120 });
}

// Projets en favori (étoile du rail), avec leur état GitHub : on les retrouve ici sans changer de vue.
function favoriteRows() {
  const state = getState();
  if (!state) return [];
  return allProjects(state).filter(isStarred).map((p) => el("li", { class: "pilot-row" },
    led("ok", { label: "favori" }),
    el("div", { class: "pilot-main" }, el("strong", {}, `★ ${p.name}`), el("span", { class: "pilot-detail" }, p.directory)),
    el("div", { class: "pilot-actions" }, el("a", { class: "btn btn-sm", href: "#projets" }, "Ouvrir"))));
}

// Un bot = une ligne ici, et une page à lui seul (actions, données, fichiers) pour « discuter » avec lui en tête-à-tête.
function botRow(b) {
  return el("li", { class: "pilot-row" },
    led("inactif", { label: "bot" }),
    el("div", { class: "pilot-main" }, el("strong", {}, b.name), el("span", { class: "pilot-detail" }, b.desc)),
    el("div", { class: "pilot-actions" }, button("Ouvrir seul", () => openPage(b.id), { kind: "btn-primary" })));
}
function openPage(id) {
  page = id;
  try { sessionStorage.setItem("pilot-page", id); } catch { /* stockage indisponible */ }
  buildPage();
}

function telegramRow() {
  const up = !!tg?.running;
  const detail = !tg ? "Chargement…" : !tg.available ? "Supervision indisponible"
    : up ? [`pid ${tg.pid}`, tg.since ? `depuis ${ago(tg.since)}` : null, tgBeat?.lastSeenAt ? `dernier signe de vie il y a ${ago(tgBeat.lastSeenAt)}` : null,
      tg.adopted ? "lancé hors du tableau de bord" : null].filter(Boolean).join(" · ")
      : (tg.gaveUp ? "Abandonné après des échecs répétés : voir le journal" : tg.lastError || "Arrêté");
  const act = (type, label, kind = "", confirm = false) => button(label, async () => {
    if (confirm && !await confirmDialog({ title: `${label} le bot Telegram ?`, message: "Le bot ne répondra pas pendant quelques secondes.", confirmLabel: label })) return;
    call({ type });
  }, { kind, disabled: !tg?.available || !!tg?.busy });
  return el("li", { class: "pilot-row", dataset: { state: up ? "up" : "down" } },
    led(up ? "ok" : "inactif", { label: up ? "en marche" : "arrêté" }),
    el("div", { class: "pilot-main" }, el("strong", {}, "Assistant Telegram"), el("span", { class: "pilot-detail" }, detail)),
    el("div", { class: "pilot-actions" },
      up ? null : act("telegramctl.start", "Lancer", "btn-primary"),
      up ? act("telegramctl.restart", "Relancer", "", true) : null,
      up ? act("telegramctl.stop", "Arrêter", "btn-danger-ghost", true) : null,
      button(logsOpen.has("telegram") ? "Masquer le journal" : "Journal", () => toggleLogs("telegram"))),
    logsOpen.has("telegram") ? logBox("telegram") : null);
}

function renderServices() {
  if (!els.services) return;
  const groups = new Map();
  const favs = favoriteRows();
  if (favs.length) groups.set("Projets favoris", favs);
  groups.set("Assistants", [telegramRow()]);
  for (const s of svc?.services ?? []) {
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(serviceRow(s));
  }
  if (svc?.bots?.length) groups.set("Bots", svc.bots.map(botRow));
  const up = (svc?.services ?? []).filter((s) => s.running).length + (tg?.running ? 1 : 0);
  const total = (svc?.services ?? []).length + 1;
  els.summary.textContent = svc ? `${up} en marche sur ${total}` : "Chargement…";
  els.services.replaceChildren(...[...groups].map(([name, rows]) => {
    const members = (svc?.services ?? []).filter((s) => s.group === name && !s.optional);
    const anyUp = members.some((s) => s.running);
    const allUp = members.length > 0 && members.every((s) => s.running);
    const head = el("header", { class: "pilot-group-head" }, el("h2", {}, name),
      members.length > 1 ? el("span", { class: "pilot-group-actions" },
        allUp ? null : button("Tout lancer", () => call({ type: "svc.group", group: name, action: "start" }), { kind: "btn-primary" }),
        anyUp ? button("Tout arrêter", async () => {
          if (await confirmDialog({ title: `Arrêter tout « ${name} » ?`, message: members.map((m) => m.name).join(", "), confirmLabel: "Tout arrêter", danger: true })) {
            call({ type: "svc.group", group: name, action: "stop" });
          }
        }, { kind: "btn-danger-ghost" }) : null) : null);
    return el("section", { class: "pilot-group" }, head, el("ul", { class: "pilot-list" }, rows));
  }));
}

// ---------- Recherches (tâches) ----------
let taskSig = "";
function renderTasks() {
  if (!els.tasks || !svc) return;
  const bot = curBot();
  // FreqTrade : formulaire en cascade custom (remplace taskCard classique)
  if (bot && bot.id === "freqtrade") {
    els.tasks.replaceChildren(renderFreqTradeForm());
    return;
  }
  const mine = svc.tasks.filter((t) => bot?.tasks.includes(t.id));
  const sig = JSON.stringify([page, mine.map((t) => [t.id, t.fields.map((f) => [f.key, f.options])])]);
  if (sig !== taskSig) {
    taskSig = sig;
    els.tasks.replaceChildren(...mine.map(taskCard));
  }
  for (const t of mine) updateTaskStatus(t);
}

function taskCard(t) {
  const inputs = {};
  const form = el("form", { class: "pilot-form", onsubmit: (e) => {
    e.preventDefault();
    const params = {};
    for (const f of t.fields) params[f.key] = f.type === "check" ? inputs[f.key].checked : inputs[f.key].value;
    call({ type: "svc.task.run", id: t.id, params });
  } }, t.fields.map((f) => {
    let input;
    if (f.type === "select") input = el("select", { id: `f-${t.id}-${f.key}` }, f.options.map((o) => el("option", { value: o, selected: o === f.value }, o || "—")));
    else if (f.type === "check") input = el("input", { type: "checkbox", id: `f-${t.id}-${f.key}`, checked: !!f.value });
    else input = el("input", { type: "text", id: `f-${t.id}-${f.key}`, value: f.value ?? "", placeholder: f.placeholder ?? "", maxlength: 80, autocomplete: "off" });
    inputs[f.key] = input;
    return el("label", { class: `pilot-field${f.type === "check" ? " is-check" : ""}`, for: input.id }, el("span", {}, f.label), input);
  }), el("div", { class: "pilot-form-actions" },
    el("button", { class: "btn btn-sm btn-primary", type: "submit", id: `run-${t.id}` }, "Lancer"),
    el("button", { class: "btn btn-sm", type: "button", id: `cancel-${t.id}`, onclick: () => call({ type: "svc.task.cancel", id: t.id }) }, "Annuler"),
    button("Journal", () => toggleLogs(`task-${t.id}`)),
    el("span", { class: "pilot-run-status", id: `status-${t.id}`, "aria-live": "polite" })));
  return el("article", { class: "pilot-card", id: `task-${t.id}` }, el("h3", {}, t.name), el("p", { class: "pilot-help" }, t.help), form,
    el("div", { class: "pilot-help", id: `taskhist-${t.id}` }), el("div", { id: `tasklog-${t.id}` }));
}

function updateTaskStatus(t) {
  const status = document.getElementById(`status-${t.id}`);
  if (!status) return;
  const run = t.run; const last = t.lastRun;
  const runBtn = document.getElementById(`run-${t.id}`); const cancel = document.getElementById(`cancel-${t.id}`);
  const running = !!run?.running;
  if (runBtn) runBtn.disabled = running;
  if (cancel) cancel.hidden = !running;
  let text = "Jamais lancée";
  let tone = "";
  if (running) { text = `En cours depuis ${ago(run.startedAt)}…`; tone = "is-run"; }
  else if (run?.endedAt || last) {
    const r = run?.endedAt ? { code: run.code, at: run.endedAt, error: run.error } : { code: last.code, at: last.endedAt, error: last.error };
    text = r.code === 0 ? `Terminée il y a ${ago(r.at)}` : `Échec il y a ${ago(r.at)}${r.error ? ` — ${r.error}` : ""}`;
    tone = r.code === 0 ? "is-ok" : "is-fail";
  }
  status.textContent = text;
  status.className = `pilot-run-status ${tone}`.trim();
  const hist = document.getElementById(`taskhist-${t.id}`);
  if (hist) hist.textContent = (t.history ?? []).length
    ? "Derniers lancements du bot : " + t.history.map((h) => `${h.label} ${ago(h.ended)} ${h.code === 0 ? "✓" : "✗"}`).join(" · ")
    : "";
  const holder = document.getElementById(`tasklog-${t.id}`);
  if (holder) holder.replaceChildren(...(logsOpen.has(`task-${t.id}`) ? [logBox(`task-${t.id}`)] : []));
}

// ---------- FreqTrade : assistant ----------
function ftCoverage(pair, timeframe) {
  const hit = ftRanges.filter((r) => r.pair === pair && r.timeframe === timeframe && r.type === "futures");
  return hit[0] || null;
}
function ftAnyData(timeframe) {
  return ftRanges.some((r) => r.timeframe === timeframe && r.type === "futures");
}
// La periode demandee (AAAAMMJJ-AAAAMMJJ) est-elle couverte par les donnees presentes ?
function ftRangeCovered(pair, timeframe, timerange) {
  if (!timerange || !/^\d{8}-\d{8}$/.test(timerange)) return null;
  const wantFrom = timerange.slice(0, 8);
  const wantTo = timerange.slice(9);
  const hit = ftRanges.filter((r) => r.timeframe === timeframe && r.type === "futures"
    && (!pair || r.pair === pair) && r.from && r.to);
  if (!hit.length) return false;
  return hit.some((r) => r.from.slice(0, 10).replace(/-/g, "") <= wantFrom
    && r.to.slice(0, 10).replace(/-/g, "") >= wantTo);
}

function ftLoad() {
  send({ type: "freqtrade.list" });
  send({ type: "freqtrade.data" });
  send({ type: "freqtrade.ranges" });
}

const btnFreq = (label, cls, onclick) => el("button", { class: `btn ${cls || ""}`, type: "button", onclick }, label);

function ftStepEl(i) {
  const cls = i < ft.step ? "done" : (i === ft.step ? "current" : "");
  const num = el("span", { class: "step-num" }, i + 1);
  const label = el("span", { class: "step-label" }, FT_STEP_LABELS[i]);
  return el("span", { class: `step ${cls}` }, num, label);
}

function ftHead(extra) {
  const h2 = el("h2", { class: "pilot-section-title" }, "FreqTrade — assistant de lancement");
  const nav = el("nav", { class: "freqtrade-stepper" }, FT_STEP_LABELS.map((l, i) => ftStepEl(i)));
  return el("section", { class: "pilot-section" }, h2, nav, extra);
}

function ftPairsChips() {
  const set = new Set(ft.pairs);
  const chips = (ftData?.pairs || []).map((p) => {
    const on = set.has(p);
    const cov = ftCoverage(p, ft.timeframe);
    const title = cov
      ? `Donnees ${ft.timeframe} : du ${cov.from} au ${cov.to} (${cov.candles} bougies)`
      : `Pas de donnees ${ft.timeframe}`;
    const chip = el("span", { class: `pair-chip ${on ? "on" : "off"}${cov ? " has-data" : ""}`, title, onclick: (e) => {
      if (on) set.delete(p); else set.add(p);
      ft.pairs = [...set];
      ftSave();
      renderTasks();
    } }, p);
    return chip;
  });
  return el("div", { class: "pair-picker" }, ...chips);
}

function ftTable() {
  if (!ftRanges.length) return el("p", { class: "pilot-empty" }, "Aucune donnee telechargee pour l'instant.");
  const head = el("tr", {}, FT_HEADS.map((h) => el("th", { scope: "col" }, h)));
  const rows = ftRanges.map((r) => {
    const cells = FT_COLS.map((k) => {
      let txt = "";
      if (k === "pair" && r.type !== "futures") txt = `${r.pair} (${r.type})`;
      else if (k === "candles") txt = String(r[k] || 0);
      else txt = r[k] || "—";
      return el("td", { class: k === "candles" ? "mono" : "" }, txt);
    });
    return el("tr", {}, ...cells);
  });
  return el("table", { class: "pilot-table" }, el("thead", {}, head), el("tbody", {}, ...rows));
}

// Contenu du bandeau de donnees manquantes : recalcule sans redessiner le formulaire,
// pour ne pas perdre le focus pendant la saisie du timerange.
function ftAlertContent() {
  const needsData = ft.mode === "backtest" || ft.mode === "hyperopt" || ft.mode === "download";
  if (!needsData || ft.mode === "download") return null;
  const first = ft.pairs[0] || "";
  let covered = true;
  let why = "";
  if (ft.timerange) {
    covered = ftRangeCovered(first, ft.timeframe, ft.timerange);
    why = covered === true ? "" : (first
      ? `periode ${ft.timerange} non couverte pour ${first} en ${ft.timeframe}`
      : `periode ${ft.timerange} non couverte en ${ft.timeframe}`);
  } else if (first) {
    covered = !!ftCoverage(first, ft.timeframe);
    why = covered ? "" : `aucune donnee pour ${first} en ${ft.timeframe}`;
  } else {
    covered = ftAnyData(ft.timeframe);
    why = covered ? "" : `aucune donnee en ${ft.timeframe}`;
  }
  if (covered) return null;
  const p = el("p", {}, `Donnees manquantes (${why}). Un lancement echouerait sans elles.`);
  const b = btnFreq(`Telecharger ${ft.timeframe} sur ${ft.days} jours`, "btn-primary", ftDownload);
  return el("div", { class: "alert-banner" }, p, b);
}

function ftRefreshAlert() {
  const box = document.getElementById("ft-alert");
  if (!box) return;
  box.replaceChildren(ftAlertContent() || el("span"));
}

function ftDataCard() {
  const needsData = ft.mode === "backtest" || ft.mode === "hyperopt" || ft.mode === "download";
  const needsStrategy = ft.mode !== "freqai" && ft.mode !== "download";
  const fields = [];

  if (needsData) {
    const sel = el("select", { name: "timeframe", onchange: (e) => { ft.timeframe = e.target.value; ftSave(); renderTasks(); } },
      FT_TIMEFRAMES.map((t) => el("option", { value: t, selected: t === ft.timeframe }, t)));
    fields.push(el("div", { class: "field" },
      el("label", {}, "Timeframe"), sel,
      el("p", { class: "muted small" }, "Unite des bougies de la strategie. Une paire cochee avec \u2713 a deja ses donnees pour ce timeframe.")));
  }

  const pairsHelp = needsData
    ? "Cochez les paires dont vous avez besoin (ou a telecharger)."
    : "En mode trade, les paires viennent de la config (pairliste) : rien a choisir ici.";
  fields.push(el("div", { class: "field" },
    el("label", {}, "Paires"), el("p", { class: "muted small" }, pairsHelp),
    needsData ? ftPairsChips() : null));

  if (ft.mode === "backtest" || ft.mode === "hyperopt") {
    const tr = el("input", { name: "timerange", type: "text", class: "mono", placeholder: "20250101-20250131",
      value: ft.timerange, oninput: (e) => { ft.timerange = e.target.value; ftSave(); ftRefreshAlert(); } });
    fields.push(el("div", { class: "field" }, el("label", {}, "Periode (timerange)"), tr,
      el("p", { class: "muted small" }, "Format AAAAMMJJ-AAAAMMJJ. Laisser vide = prendre tout ce qui est telecharge.")));
  }

  if (ft.mode === "hyperopt") {
    const mt = el("input", { name: "maxTrials", type: "number", class: "mono", min: "1", max: "1000",
      value: ft.maxTrials, oninput: (e) => { ft.maxTrials = e.target.value; ftSave(); ftRefreshAlert(); } });
    fields.push(el("div", { class: "field" }, el("label", {}, "Nombre d'essais HyperOpt"), mt));
  }

  if (ft.mode === "download") {
    const days = el("input", { name: "days", type: "number", class: "mono", min: "1", max: "720",
      value: ft.days, oninput: (e) => { ft.days = e.target.value; ftSave(); ftRefreshAlert(); } });
    fields.push(el("div", { class: "field" }, el("label", {}, "Nombre de jours a telecharger"), days,
      el("p", { class: "muted small" }, "Sans paire cochee, telecharge toutes les paires de la config (long).")));
  }

  if (ft.mode !== "freqai") {
    const dry = el("input", { type: "checkbox", checked: ft.dryRun,
      onchange: (e) => { ft.dryRun = e.target.checked; ftSave(); } });
    fields.push(el("div", { class: "field check-row" },
      el("label", { class: "check" }, dry, " Dry-run (simulation, sans argent reel)"),
      el("p", { class: "muted small" }, "Desactiver seulement si vous savez ce que vous faites.")));
  }

  // Bandeau de donnees manquantes : son conteneur est mis a jour en direct pendant la saisie.
  const alertBox = el("div", { id: "ft-alert" }, ftAlertContent());

  const kids = [el("h2", {}, "Donnees & options"), alertBox];
  const nFut = ftRanges.filter((r) => r.type === "futures").length;
  kids.push(el("h3", { class: "label-caps" }, ));
  kids.push(ftTable());
  for (const f of fields) kids.push(f);
  kids.push(el("div", { class: "nav" },
    btnFreq("Precedent", "btn-outline", () => { ft.step = 2; renderTasks(); }),
    btnFreq(ft.mode === "download" ? "Telecharger" : "Lancer FreqTrade", "btn-primary", launchFreqTrade)));
  return el("div", { class: "card" }, ...kids);
}

function ftDownload() {
  ftResult = null;
  ftLogLines = [];
  send({ type: "freqtrade.launch", mode: "download", config: ft.config || "config.json", strategy: "",
    pairs: ft.pairs, timerange: "", maxTrials: ft.maxTrials, dryRun: ft.dryRun, days: ft.days, timeframes: ft.timeframe });
}

function launchFreqTrade() {
  if (ft.mode !== "freqai" && ft.mode !== "download" && !ft.strategy) { toast("Choisissez une strategie."); return; }
  if (ft.mode !== "download" && !ft.config) { toast("Choisissez une config."); return; }
  ftResult = null;
  ftLogLines = [];
  send({ type: "freqtrade.launch", mode: ft.mode, config: ft.config, strategy: ft.strategy, pairs: ft.pairs,
    timerange: ft.timerange, maxTrials: ft.maxTrials, dryRun: ft.dryRun, days: ft.days, timeframes: ft.timeframe });
}

function renderFreqTradeForm() {
  const needsStrategy = ft.mode !== "freqai" && ft.mode !== "download";
  if (!ftData) return ftHead(el("p", { class: "pilot-empty" }, "Chargement des options FreqTrade…"));

  if (runningId) {
    const detail = `mode ${ft.mode} · config ${ft.config}${ft.strategy ? ` · strategie ${ft.strategy}` : ""}`;
    const card = el("div", { class: "pilot-card" },
      el("div", { class: "pilot-main" }, el("strong", {}, "FreqTrade est en marche"), el("span", { class: "pilot-detail" }, detail)),
      el("div", { class: "pilot-actions" },
        btnFreq("Arreter", "btn-danger-ghost", () => { send({ type: "freqtrade.stop", id: runningId }); toast("Arret demande."); })));
    const log = ftLogLines.length
      ? el("pre", { class: "pilot-log", tabindex: "0", "aria-label": "Journal" }, ftLogLines.join("\n")) : null;
    return ftHead(card, log);
  }

  if (ftResult) {
    const ok = ftResult.code === 0 && !ftResult.stopped;
    const noData = !ok && !ftResult.stopped && /No data found|No history/i.test(ftResult.lines.join("\n"));
    const label = ftResult.stopped ? "Arrete par vous" : ok ? "Termine (code 0)" : `Erreur : ${ftResult.error || "code " + ftResult.code}`;
    const kids = [
      el("h2", {}, ftResult.stopped ? "Lancement arrete" : ok ? "Lancement termine" : "Lancement en echec"),
      el("div", { class: `pilot-run-status ${ok ? "is-ok" : "is-fail"}` }, label),
    ];
    if (ftResult.cmd) kids.push(el("p", { class: "mono muted small wrap" }, `freqtrade ${ftResult.cmd}`));
    if (ftResult.lines.length) kids.push(el("pre", { class: "pilot-log", tabindex: "0", "aria-label": "Journal" }, ftResult.lines.join("\n")));
    if (noData) {
      kids.push(el("div", { class: "alert-banner" },
        el("p", {}, "Aucune donnee pour cette paire ou cette periode : telechargez l'historique puis relancez."),
        btnFreq("Aller telecharger", "btn-primary", () => { ft.mode = "download"; ft.step = 3; ftResult = null; ftSave(); renderTasks(); })));
    }
    kids.push(el("div", { class: "nav" },
      btnFreq("Nouveau lancement", "btn-primary", () => { ftResult = null; ft.step = 0; renderTasks(); })));
    return ftHead(el("div", { class: "card" }, ...kids));
  }

  let content;
  if (ft.step === 0) {
    const hints = {
      trade: "Lance le bot en direct (dry_run active selon le config).",
      backtest: "Teste une strategie sur une periode passee : demande des donnees telechargees.",
      hyperopt: "Optimise les parametres d'une strategie sur plusieurs essais.",
      download: "Telecharge l'historique des prix depuis Binance pour pouvoir lancer un backtest.",
      freqai: "Lance le bot avec FreqIA (machine learning, config_freqai.json).",
    };
    const modes = (ftData.modes || []).map((m) => {
      const b = el("button", { class: `mode-btn ${ft.mode === m.id ? "selected" : ""}`, type: "button",
        onclick: () => { ft.mode = m.id; ft.strategy = ""; ft.step = 1; ftSave(); renderTasks(); } });
      b.append(el("span", {}, m.label));
      return b;
    });
    content = el("div", { class: "card" },
      el("h2", {}, "Type de lancement"),
      el("div", { class: "mode-grid" }, ...modes),
      el("div", { class: "mode-hint" }, el("p", { class: "muted small" }, hints[ft.mode] || "")));
  } else if (ft.step === 1) {
    const cfgs = (ftData.configs || []).map((c) => el("button", {
      class: `config-btn ${ft.config === c.id ? "selected" : ""}`, type: "button",
      onclick: () => { ft.config = c.id; ft.step = 2; ftSave(); renderTasks(); },
    }, el("span", { class: "mono" }, c.label || c.id)));
    content = el("div", { class: "card" },
      el("h2", {}, "Configuration"),
      el("p", { class: "muted" }, "Le fichier config definit l'echange, les cles API, le wallet et le serveur API."),
      el("div", { class: "select-list" }, ...cfgs),
      el("div", { class: "nav" }, btnFreq("Precedent", "btn-outline", () => { ft.step = 0; renderTasks(); })));
  } else if (ft.step === 2) {
    const strats = (ftData.strategies || []).map((st) => el("button", {
      class: `strategy-btn ${ft.strategy === st.id ? "selected" : ""}`, type: "button",
      onclick: () => { ft.strategy = st.id; ft.step = 3; ftSave(); renderTasks(); },
    }, el("span", {}, st.label || st.id)));
    const kids = [
      el("h2", {}, "Strategie"),
      el("p", { class: "muted" }, "La strategie definit les signaux d'achat/vente et la gestion de position."),
      el("div", { class: "select-list" }, ...strats),
      el("div", { class: "nav" }, btnFreq("Precedent", "btn-outline", () => { ft.step = 1; renderTasks(); })),
    ];
    if (!needsStrategy) kids.push(el("p", { class: "pilot-empty" }, "Aucune strategie a choisir pour ce mode : passez a l'etape suivante."));
    content = el("div", { class: "card" }, ...kids);
  } else {
    content = ftDataCard();
  }

  return ftHead(content);
}

// ---------- Données ----------
function requestData() {
  call({ type: "svc.data.query", dataset: data.dataset, q: data.q, facets: data.facets, marked: data.marked, offset: data.offset, limit: PAGE, ref: "pilot-data" });
}

function renderData() {
  if (!els.data) return;
  const r = data.result;
  const tabs = el("div", { class: "pilot-tabs", role: "tablist" }, (svc?.datasets ?? []).filter((d) => curBot()?.datasets.includes(d.id)).map((d) =>
    el("button", { class: "pilot-tab", type: "button", role: "tab", "aria-selected": String(d.id === data.dataset),
      onclick: () => { data.dataset = d.id; data.q = ""; data.facets = {}; data.marked = ""; data.offset = 0; data.result = null; renderData(); requestData(); } }, d.name)));
  const search = el("input", { type: "search", class: "pilot-search", id: "pilot-q", value: data.q, placeholder: "Rechercher (ville, entreprise, poste…)",
    "aria-label": "Rechercher", maxlength: 80 });
  search.addEventListener("keydown", (e) => { if (e.key === "Enter") { data.q = search.value.trim(); data.offset = 0; requestData(); } });
  const filters = Object.entries(r?.facets ?? {}).map(([key, f]) => el("label", { class: "pilot-facet" }, el("span", {}, f.label),
    el("select", { onchange: (e) => { if (e.target.value) data.facets[key] = e.target.value; else delete data.facets[key]; data.offset = 0; requestData(); } },
      el("option", { value: "" }, "Tous"),
      f.values.map((v) => el("option", { value: v.value, selected: data.facets[key] === v.value }, `${key === "status" ? (STATUS_LABEL[v.value] ?? v.value) : v.value} (${v.count})`)))));
  if (r?.marks) {
    filters.push(el("label", { class: "pilot-facet" }, el("span", {}, "Traitement"),
      el("select", { onchange: (e) => { data.marked = e.target.value; data.offset = 0; requestData(); } },
        [["", "Tous"], ["no", "À traiter"], ["yes", "Traités"]].map(([v, l]) => el("option", { value: v, selected: data.marked === v }, l)))));
  }
  const bar = el("div", { class: "pilot-databar" }, search, button("Chercher", () => { data.q = search.value.trim(); data.offset = 0; requestData(); }, { kind: "btn-primary" }), filters);

  let body;
  if (!r) body = el("p", { class: "pilot-empty" }, "Chargement…");
  else if (!r.available) body = el("p", { class: "pilot-empty" }, r.reason);
  else if (!r.rows.length) body = el("p", { class: "pilot-empty" }, "Aucun résultat.");
  else {
    body = el("div", { class: "pilot-tablewrap" }, el("table", { class: "pilot-table" },
      el("thead", {}, el("tr", {}, r.marks ? el("th", { scope: "col", title: "Coche quand c'est traité" }, "Fait") : null,
        r.columns.map(([, label]) => el("th", { scope: "col" }, label)))),
      el("tbody", {}, r.rows.map((row) => el("tr", { class: row._marked ? "is-done" : "" },
        r.marks ? el("td", {}, el("input", { type: "checkbox", checked: !!row._marked, "aria-label": "Traité",
          onchange: (e) => {
            row._marked = e.target.checked;
            e.target.closest("tr").classList.toggle("is-done", row._marked);
            call({ type: "svc.mark", dataset: r.dataset, id: row.id, on: e.target.checked });
          } })) : null,
        r.columns.map(([key], i) => el("td", {}, cell(r.dataset, key, row), i === 0 && row._detail
          ? el("details", { class: "pilot-detail-row" }, el("summary", {}, "Voir le message"), el("pre", {}, row._detail)) : null)))))));
  }
  const pages = r?.available ? el("div", { class: "pilot-pager" },
    el("span", {}, `${r.total} résultat${r.total > 1 ? "s" : ""}${r.total ? ` · ${r.offset + 1}–${Math.min(r.offset + PAGE, r.total)}` : ""}`),
    button("Précédent", () => { data.offset = Math.max(0, data.offset - PAGE); requestData(); }, { disabled: r.offset === 0 }),
    button("Suivant", () => { data.offset += PAGE; requestData(); }, { disabled: r.offset + PAGE >= r.total })) : null;
  els.data.replaceChildren(tabs, bar, body, pages);
  renderFiles();
}

function cell(dataset, key, row) {
  const v = row[key];
  if (key === "mailto" && !v && row.note) {
    const b = el("button", { type: "button", class: "btn", title: row.note, onclick: async () => {
      try { await navigator.clipboard.writeText(row.note); b.textContent = "✅ copié"; } catch { b.textContent = "copie refusée"; }
      setTimeout(() => { b.textContent = "📋 note LinkedIn"; }, 2000);
    } }, "📋 note LinkedIn");
    return b;
  }
  if (v == null || v === "") return "";
  if (key === "cv") return el("a", { href: `/api/svc/file?bot=cv&name=${encodeURIComponent(v)}`, download: v, title: v }, `📎 ${(v.match(/- (FR|EN|DE)\.pdf$/i) || [, "CV"])[1]}`);
  if (key === "posted_at" && /^\d{9,10}$/.test(String(v))) return new Date(Number(v) * 1000).toLocaleDateString("fr-FR");
  if (key === "profile") return String(v).replace(/^dash-/, "");
  if (key === "mailto") return /^mailto:/.test(v) ? el("a", { href: v, title: "Ouvre le brouillon dans ta messagerie" }, "✉️ écrire") : "";
  if (key === "url" || key === "linkedin_url") return safeUrl(v) ? el("a", { href: v, target: "_blank", rel: "noopener noreferrer" }, "ouvrir") : "";
  if (dataset === "jobs" && key === "status") {
    const sel = el("select", { "aria-label": "Suivi de l'offre", onchange: (e) => call({ type: "svc.job.status", job_key: row.id, profile: row.profile, value: e.target.value }) },
      Object.entries(STATUS_LABEL).map(([k, l]) => el("option", { value: k, selected: k === v }, l)));
    sel.disabled = !row.profile;
    return sel;
  }
  return String(v);
}

function renderFiles() {
  if (!els.files) return;
  const files = (svc?.files ?? []).filter((f) => f.bot === curBot()?.files || (curBot()?.files === "alumni" && f.bot === "cv"));
  const item = (f) => el("li", {}, el("a", { href: `/api/svc/file?bot=${encodeURIComponent(f.bot)}&name=${encodeURIComponent(f.name)}`, download: f.name }, f.name),
    el("span", { class: "pilot-detail" }, ` ${bytes(f.size)} · il y a ${ago(f.modifiedAt)}`));
  const hasCv = files.some((f) => f.bot === "cv");
  els.files.replaceChildren(el("h3", {}, "Fichiers exportés"), hasCv ? el("p", { class: "pilot-detail" }, "Le CV (pdf / docx) est à joindre à la main : un lien ✉️ ne peut pas porter de pièce jointe.") : null, files.length
    ? el("div", {}, el("ul", { class: "pilot-files" }, files.slice(0, 8).map(item)),
      files.length > 8 ? el("details", {}, el("summary", {}, `Voir les ${files.length - 8} autres`), el("ul", { class: "pilot-files" }, files.slice(8).map(item))) : null)
    : null, files.length ? null : el("p", { class: "pilot-empty" }, "Aucun export."));
}

// ---------- Cycle de vie ----------
function section(title, ...children) {
  return el("section", { class: "pilot-section" }, el("h2", { class: "pilot-section-title" }, title), ...children);
}

function renderNav() {
  if (!nav) return;
  const pages = [["serveurs", "Tout"], ...(svc?.bots ?? []).map((b) => [b.id, b.name])];
  nav.replaceChildren(...pages.map(([id, name]) => el("button", { class: "pilot-page", type: "button", id: `page-${id}`, "aria-current": id === page ? "page" : "false",
    onclick: () => { page = id; try { sessionStorage.setItem("pilot-page", id); } catch { /* stockage indisponible */ } buildPage(); } }, name)));
}

// (Re)construit la sous-page courante : « Serveurs » (services + Telegram) ou un bot (actions, données, fichiers).
function buildPage() {
  if (!root) return;
  const host = root.querySelector(".pilot");
  logsOpen = new Map(); taskSig = "";
  nav = el("nav", { class: "pilot-nav", "aria-label": "Pages" });
  els = { summary: el("span", { class: "pilot-summary", "aria-live": "polite" }, "Chargement…") };
  const head = el("header", { class: "pilot-head" }, el("h1", {}, "Bots & serveurs"), els.summary,
    button("Actualiser", () => { call({ type: "svc.list", force: true }); call({ type: "telegramctl.get" }); }));
  const bot = curBot();
  let body;
  if (page === "serveurs" || (svc && !bot)) {
    page = "serveurs";
    els.services = el("div", { class: "pilot-services" });
    body = [section("Tout au même endroit", els.services)];
  } else if (bot) {
    els.tasks = el("div", { class: "pilot-cards" }); els.data = el("div", { class: "pilot-data" }); els.files = el("div", { class: "pilot-filesbox" });
    els.summary.textContent = bot.desc;
    // Un bot sans jeu de donnees ni fichiers (FreqTrade) n'a pas de section « Donnees » : elle
    // affichait a tort les entreprises du bot PME, un heritage du premier bot defini.
    const withData = (bot.datasets ?? []).length > 0;
    body = withData ? [section("Actions", els.tasks), section("Données", els.data, els.files)] : [section("Actions", els.tasks)];
    const ds = bot.datasets ?? [];
    if (ds.length && !ds.includes(data.dataset)) { data.dataset = ds[0]; data.q = ""; data.facets = {}; data.marked = ""; data.offset = 0; data.result = null; }
  } else {
    body = [el("p", { class: "pilot-empty" }, "Chargement…")];
  }
  host.replaceChildren(head, nav, ...body);
  renderNav(); renderServices(); renderTasks(); renderData(); renderFiles();
  if (bot && bot.id === "freqtrade") { ftData = null; ftRanges = []; ftLoad(); }
  if (bot && (bot.datasets ?? []).length) requestData();
}

const view = {
  id: "pilotage", title: "Bots & serveurs", short: "Bots", icon: ICON, order: 15,
  mount(container) {
    root = container;
    try { page = sessionStorage.getItem("pilot-page") || "serveurs"; } catch { page = "serveurs"; }
    root.replaceChildren(el("div", { class: "pilot" }));
    buildPage();
    call({ type: "svc.list" });
    call({ type: "telegramctl.get" });
    offs.push(on("svc.state", (m) => {
      // Une tâche qui vient de finir change les données : on les relit (pas de relecture périodique, elle effacerait la saisie).
      const finished = svc && m.tasks.some((t) => !t.run?.running && svc.tasks.find((o) => o.id === t.id)?.run?.running);
      const first = !svc;
      svc = m;
      if (first) { buildPage(); return; }
      if (finished && data.dataset) requestData();
      renderNav(); renderServices(); renderTasks(); renderFiles();
      for (const id of logsOpen.keys()) if (id.startsWith("task-") || svc.services.some((s) => s.id === id)) requestLogs(id);
    }));
    offs.push(on("telegramctl.state", (m) => { tg = m; renderServices(); }));
    offs.push(on("telegram.status", (m) => { tgBeat = m; }));
    offs.push(on("telegramctl.logs", (m) => { if (logsOpen.has("telegram")) { logsOpen.set("telegram", m.lines ?? []); renderServices(); } }));
    offs.push(on("freqtrade.list", (m) => {
      ftData = { modes: m.modes, configs: m.configs, strategies: m.strategies, pairs: m.pairs };
      renderTasks();
    }));
    offs.push(on("freqtrade.data", (m) => { renderTasks(); }));
    offs.push(on("freqtrade.ranges", (m) => { ftRanges = m.ranges || []; renderTasks(); }));
    offs.push(on("freqtrade.logs", (m) => {
      if (m.id !== runningId && !ftResult) return;
      ftLogLines = m.lines ?? [];
      if (ftResult && ftLogLines.length) ftResult = { ...ftResult, lines: ftLogLines };
      renderTasks();
    }));
    offs.push(on("freqtrade.state", (m) => {
      if (!m.id) return;
      if (m.running) { runningId = m.id; ftResult = null; }
      else {
        runningId = null;
        ftResult = { code: m.code ?? null, error: m.error ?? null,
          lines: (m.lines && m.lines.length) ? m.lines : ftLogLines, stopped: !!m.stopped, cmd: m.cmd ?? "" };
        if (!ftResult.lines.length) setTimeout(() => send({ type: "freqtrade.logs", id: m.id, lines: 300 }), 900);
        if (m.stopped) toast("FreqTrade arrete.");
        else if (m.code === 0) toast("FreqTrade termine avec succes.");
        else toast(`FreqTrade termine avec une erreur : ${m.error || "code " + m.code}`, { kind: "error" });
        // Un telechargement vient peut-etre d'ajouter des donnees : on relit les plages reelles.
        if (ft.mode === "download") setTimeout(ftLoad, 2000);
      }
      renderTasks();
    }));
    offs.push(on("freqtrade.state", (m) => {
      if (!m.id) return;
      if (m.running) { runningId = m.id; ftResult = null; }
      else {
        runningId = null;
        const partial = { code: m.code ?? null, error: m.error ?? null,
          lines: (m.lines && m.lines.length) ? m.lines : ftLogLines, stopped: !!m.stopped, cmd: m.cmd ?? "" };
        ftResult = partial;
        // Le handler complete le journal 600 ms plus tard : on redemande si le premier message etait vide.
        if (!partial.lines.length) {
          setTimeout(() => send({ type: "freqtrade.logs", id: m.id, lines: 300 }), 900).unref?.();
        }
        if (m.stopped) toast("FreqTrade arrêté.");
        else if (m.code === 0) toast("FreqTrade terminé avec succès.");
        else toast(`FreqTrade terminé avec une erreur : ${m.error || "code " + m.code}`, { kind: "error" });
      }
      renderTasks();
    }));
    offs.push(on("freqtrade.logs", (m) => {
      if (m.id !== runningId && !ftResult) return;
      ftLogLines = m.lines ?? [];
      if (ftResult && ftLogLines.length) { ftResult = { ...ftResult, lines: ftLogLines }; }
      renderTasks();
    }));
    // Interconnexion : re-render les favoris quand l'état global change (ajout/suppression de favori depuis une autre vue)
    offs.push(subscribe(() => {
      try { renderServices(); } catch { /* état pas encore prêt */ }
    }));

    offs.push(on("svc.logs", (m) => {
      if (!logsOpen.has(m.id)) return;
      logsOpen.set(m.id, m.lines ?? []);
      if (m.id.startsWith("task-") && svc) { const t = svc.tasks.find((x) => `task-${x.id}` === m.id); if (t) updateTaskStatus(t); } else renderServices();
    }));
    offs.push(on("svc.data.result", (m) => {
      if (m.ref !== "pilot-data" || m.dataset !== data.dataset) return;
      data.result = m; renderData();
    }));
    offs.push(onConnection((up) => { if (up) { call({ type: "svc.list" }); call({ type: "telegramctl.get" }); if (data.dataset) requestData(); } }));
    timer = setInterval(() => call({ type: "svc.list" }), 10_000);
    ftTimer = setInterval(() => { if (runningId) send({ type: "freqtrade.logs", id: runningId, lines: 200 }); }, 3000);
  },
  unmount() {
    clearInterval(timer);
    clearInterval(ftTimer);
    clearInterval(ftTimer);
    for (const off of offs) off();
    offs = []; logsOpen = new Map(); taskSig = ""; root = null; els = {}; nav = null;
  },
};

registerView(view);
export default view;
