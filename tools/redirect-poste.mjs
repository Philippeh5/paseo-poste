#!/usr/bin/env node
// Redirection du mini-PC vers LE poste de commande (Oracle) : un seul poste, plus de doublon qui prête à confusion.
// Répond à toute requête par « 302 Location: http://<TAILSCALE_IP>:7070<chemin+requête> » (le navigateur garde le #fragment)
// et une courte page en français avec le lien. Aucune dépendance.
// Écoute : l'adresse Tailscale du PC (100.64.0.0/10) sur le port 7070, et aussi 127.0.0.1:7070 si ce port est libre
// (il peut être tenu par un tunnel SSH vers Oracle : on n'échoue jamais pour ça). Si Tailscale n'a pas encore d'adresse au démarrage
// (ouverture de session), on écoute d'abord sur 127.0.0.1 puis on la recherche toutes les 30 s et on écoute dessus dès qu'elle apparaît.
// Variables : POSTE_URL (cible, défaut http://<TAILSCALE_IP>:7070), REDIRECT_LISTEN (« hôte:port », remplace l'écoute par défaut).
import http from "node:http";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";

export const DEFAULT_TARGET = "http://<TAILSCALE_IP>:7070";

/** Adresse Tailscale (CGNAT 100.64.0.0/10) de cette machine, ou null. */
export function tailscaleIp(ifaces = networkInterfaces()) {
  for (const list of Object.values(ifaces)) {
    for (const a of list || []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      const [o1, o2] = a.address.split(".").map(Number);
      if (o1 === 100 && o2 >= 64 && o2 <= 127) return a.address;
    }
  }
  return null;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Adresse de redirection pour une requête : cible + chemin + requête d'origine. */
export function redirectLocation(target, reqUrl) {
  let path = String(reqUrl || "/").replace(/[\r\n]/g, "");
  if (!path.startsWith("/")) path = "/" + path;
  return target.replace(/\/+$/, "") + path;
}

export function makeServer(target = process.env.POSTE_URL || DEFAULT_TARGET) {
  return http.createServer((req, res) => {
    const to = redirectLocation(target, req.url);
    const body = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
      + `<title>Poste de commande</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem">`
      + `<h1>Le poste de commande a déménagé</h1><p>Il n'y a plus qu'un seul poste, sur Oracle (allumé en permanence) : `
      + `<a href="${esc(to)}">${esc(to)}</a></p><p>Redirection automatique en cours. Pensez à mettre à jour votre favori.</p></body></html>`;
    res.writeHead(302, { Location: to, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : body);
  });
}

function listenOn(server, host, port) {
  return new Promise((resolve) => {
    const onErr = (e) => { server.off("listening", onOk); resolve(e); };
    const onOk = () => { server.off("error", onErr); resolve(null); };
    server.once("error", onErr); server.once("listening", onOk);
    server.listen(port, host);
  });
}

/**
 * Tant que l'adresse Tailscale n'existe pas (ouverture de session : Tailscale démarre après nous), la cherche toutes les
 * `intervalMs` (30 s) et démarre l'écoute dessus dès qu'elle apparaît. S'arrête après un succès. Rend { stop, done } (stop() ferme aussi l'écoute démarrée).
 * `find` et `intervalMs` sont injectables pour les tests.
 */
export function watchTailscaleIp({ target = process.env.POSTE_URL || DEFAULT_TARGET, port = 7070, find = tailscaleIp, intervalMs = 30_000, log = () => {} } = {}) {
  let stopped = false, timer = null, wake = null, server = null;
  const done = (async () => {
    while (!stopped) {
      await new Promise((r) => { wake = r; timer = setTimeout(r, intervalMs); });
      if (stopped) break;
      const ip = find();
      if (!ip) continue;
      const srv = makeServer(target);
      const err = await listenOn(srv, ip, port);
      if (!err) { server = srv; log(`redirection ${ip}:${port} -> ${target} (adresse Tailscale apparue)`); return ip; }
      log(`${ip}:${port} indisponible (${err.code || err.message}), nouvel essai dans ${Math.round(intervalMs / 1000)} s`);
    }
    return null;
  })();
  return { done, stop() { stopped = true; clearTimeout(timer); if (wake) wake(); if (server) server.close(); } };
}

async function main() {
  const target = process.env.POSTE_URL || DEFAULT_TARGET;
  const explicit = process.env.REDIRECT_LISTEN;
  const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
  const wanted = [];
  let ip = null;
  if (explicit) {
    const i = explicit.lastIndexOf(":");
    wanted.push({ host: explicit.slice(0, i), port: Number(explicit.slice(i + 1)), required: true });
  } else {
    ip = tailscaleIp();
    if (ip) wanted.push({ host: ip, port: 7070, required: true });
    else log("Adresse Tailscale (100.64.0.0/10) introuvable : écoute sur 127.0.0.1 seulement, nouvel essai toutes les 30 s");
    wanted.push({ host: "127.0.0.1", port: 7070, required: !ip });
  }
  let up = 0;
  for (const w of wanted) {
    const server = makeServer(target);
    const err = await listenOn(server, w.host, w.port);
    if (err) { log(`${w.host}:${w.port} indisponible (${err.code || err.message})${w.required ? "" : " : ignoré"}`); continue; }
    up++; log(`redirection ${w.host}:${w.port} -> ${target}`);
  }
  // Adresse Tailscale absente au démarrage : on la guette (la minuterie garde le processus en vie même si 127.0.0.1 est pris)
  if (!explicit && !ip) { watchTailscaleIp({ target, log }); return; }
  if (!up) { log("aucune adresse d'écoute disponible, arrêt"); process.exit(1); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
