// Projet sélectionné dans le rail (un clic) et dépliage des sessions par projet. Mémorisés dans le navigateur.
import { safeStorage } from "./util.js";

const SEL_KEY = "poste.projetSelectionne";
const COLLAPSED_KEY = "poste.projetsReplies";
const listeners = new Set();

const read = (key, fallback) => {
  try {
    const raw = safeStorage()?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};
const write = (key, value) => {
  try {
    safeStorage()?.setItem(key, JSON.stringify(value));
  } catch { /* stockage indisponible : la sélection vaut pour cette page seulement */ }
};

let selected = read(SEL_KEY, null);
let collapsed = new Set(read(COLLAPSED_KEY, []));

const emit = () => listeners.forEach((fn) => fn());
export const onSelectionChange = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

const norm = (d) => String(d || "").replace(/[\\]/g, "/").replace(/\/+$/, "").toLowerCase();
export const projectKey = (p) => `${p.host}|${norm(p.directory)}`;

export const getSelectedProject = () => selected;
export const isSelected = (p) => Boolean(selected) && selected.key === projectKey(p);
export function selectProject(p) {
  // Un second clic sur le projet déjà sélectionné ne le désélectionne pas : il y a un bouton pour ça.
  selected = p ? { key: projectKey(p), host: p.host, directory: p.directory, name: p.name } : null;
  write(SEL_KEY, selected);
  emit();
}

export const isCollapsed = (p) => collapsed.has(projectKey(p));
export function toggleCollapsed(p) {
  const key = projectKey(p);
  if (collapsed.has(key)) collapsed.delete(key);
  else collapsed.add(key);
  write(COLLAPSED_KEY, [...collapsed]);
  emit();
}
