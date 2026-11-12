// Registre ordonné des vues. Chaque fichier de js/views/ s'y inscrit avec registerView(...) ;
// main.js les charge tous automatiquement (liste fournie par le serveur), il n'y a rien d'autre à modifier.
//
// Une vue : { id, title, short?, icon?, order?, mount(container, ctx), unmount() }
//   id     : ancre de l'URL (#bureau) ; lettres minuscules, chiffres, tirets
//   title  : libellé complet ; short : libellé court pour la barre basse du téléphone
//   icon   : chaîne SVG (voir core/util.js)
//   order  : position dans le sélecteur (les vues d'origine utilisent 10, 20… 60)
const views = [];
const listeners = new Set();

export function registerView(view) {
  const valid = view && /^[a-z0-9-]+$/.test(view.id || "") && view.title &&
    typeof view.mount === "function" && typeof view.unmount === "function";
  if (!valid) throw new TypeError("Vue invalide : { id, title, mount, unmount } attendus.");
  const existing = views.findIndex((v) => v.id === view.id);
  if (existing >= 0) views.splice(existing, 1);
  views.push(view);
  views.sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000));
  for (const fn of listeners) fn(views);
  return view;
}

export const getViews = () => views;
export const getView = (id) => views.find((v) => v.id === id);
export function onViewsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
