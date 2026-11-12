// Aide commune aux vues pas encore construites : un état vide soigné qui dit ce qui y apparaîtra.
// (Le préfixe « _ » évite qu'elle soit chargée comme une vue.)
import { el } from "../core/util.js";

export function emptyView({ title, icon, sentence, hint }) {
  const mark = el("div", { class: "empty-mark", "aria-hidden": "true" });
  mark.innerHTML = icon;
  return el("div", { class: "view-page" },
    el("div", { class: "view-toolbar" }, el("h1", { class: "view-title" }, title)),
    el("div", { class: "empty-state" },
      mark,
      el("h2", {}, "Rien à afficher pour l’instant"),
      el("p", {}, sentence),
      hint && el("p", { class: "empty-hint" }, hint),
    ),
  );
}
