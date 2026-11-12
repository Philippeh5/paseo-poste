// Thème sombre/clair. L'attribut data-theme est posé avant le premier rendu par un script dans <head>.
import { readPref, writePref } from "./util.js";

const KEY = "paseo-theme";
const listeners = new Set();
const media = window.matchMedia?.("(prefers-color-scheme: light)");

export function currentTheme() {
  const forced = document.documentElement.dataset.theme;
  if (forced === "light" || forced === "dark") return forced;
  return media?.matches ? "light" : "dark";
}
function notify() {
  for (const fn of listeners) fn(currentTheme());
}
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  writePref(KEY, theme);
  notify();
}
export function toggleTheme() {
  applyTheme(currentTheme() === "dark" ? "light" : "dark");
}
export function initTheme() {
  const saved = readPref(KEY);
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  media?.addEventListener?.("change", notify);
}
export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
// Valeur d'un jeton CSS du thème courant (utile pour xterm).
export const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
