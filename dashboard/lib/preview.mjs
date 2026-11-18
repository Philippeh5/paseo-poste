// Aperçu de serveurs locaux dans le poste : liste des ports qui écoutent sur la machine + relais HTTP en lecture (GET/HEAD)
// vers 127.0.0.1:<port>. Garde-fous : seuls les ports actuellement à l'écoute (>= 1024, hors le poste lui-même) sont joignables ;
// ni cookies ni identifiants du poste ne sont transmis ; les en-têtes qui interdisent l'affichage en cadre sont retirés.
import { execFile } from "node:child_process";
import { request } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function parseSs(text) {
  const seen = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0] !== "LISTEN") continue;
    const m = /^(.*):(\d+)$/.exec(cols[3]);
    if (!m) continue;
    const port = Number(m[2]); const addr = m[1].replace(/^\[|\]$/g, "");
    const proc = /\(\("([^"]+)"/.exec(line)?.[1] ?? null;
    const prev = seen.get(port);
    if (!prev) seen.set(port, { port, addr, process: proc, loopbackOnly: /^(127\.|::1$)/.test(addr) });
    else { prev.loopbackOnly = prev.loopbackOnly && /^(127\.|::1$)/.test(addr); prev.process ||= proc; }
  }
  return [...seen.values()].sort((a, b) => a.port - b.port);
}

export function listPorts({ exclude = [], run = execFile } = {}) {
  return new Promise((resolve) => {
    run("ss", ["-ltnHp"], { timeout: 5000, maxBuffer: 1024 * 1024 }, (e, stdout) => {
      if (e) return resolve([]);
      resolve(parseSs(stdout).filter((p) => p.port >= 1024 && !exclude.includes(p.port)));
    });
  });
}

export const prefixOf = (port, token = null) => (token ? `/preview/t/${token}/${port}/` : `/preview/${port}/`);

// Jeton d'aperçu : adresse-capacité liée à UN port, valable `ttlMs`, signée avec un secret aléatoire propre au processus.
// Sert aux sous-ressources d'un cadre isolé (origine opaque) qui n'envoient pas le cookie de session du poste.
export function createTokens({ secret = randomBytes(32), now = () => Date.now(), ttlMs = 8 * 3_600_000 } = {}) {
  const mac = (exp, port) => createHmac("sha256", secret).update(`preview|${exp}|${port}`).digest("hex");
  return {
    sign: (port) => { const exp = now() + ttlMs; return `${exp}.${mac(exp, port)}`; },
    verify(token, port) {
      const m = /^(\d{10,16})\.([0-9a-f]{64})$/.exec(String(token || ""));
      if (!m || Number(m[1]) < now()) return false;
      try { return timingSafeEqual(Buffer.from(m[2], "hex"), Buffer.from(mac(m[1], port), "hex")); } catch { return false; }
    },
  };
}
export const PREVIEW_PATH = /^\/preview\/(?:t\/(\d{10,16}\.[0-9a-f]{64})\/)?(\d{2,5})(\/.*)?$/;

export function rewriteHtml(html, port, token = null) {
  const prefix = prefixOf(port, token);
  return html.replace(/(\s(?:src|href|action|poster)=)(["'])\/(?!\/)/gi, `$1$2${prefix}`)
    .replace(/(url\()(["']?)\/(?!\/)/gi, `$1$2${prefix}`);
}

// handle(req, res, url) : à brancher avec ctx.onHttpPrefix("/preview/", handle) ; `allowed()` renvoie la liste des ports autorisés.
export function createProxy({ allowed, tokens = null, timeoutMs = 30_000, maxHtml = 5 * 1024 * 1024 }) {
  return async function handle(req, res, url) {
    const m = PREVIEW_PATH.exec(url.pathname);
    const fail = (code, text) => { if (!res.headersSent) res.writeHead(code, { "content-type": "text/plain; charset=utf-8" }); res.end(text); };
    if (!m) return fail(404, "Aperçu : chemin invalide");
    if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "Aperçu en lecture seule (GET/HEAD)");
    const token = m[1] || null; const port = Number(m[2]);
    if (token && !(tokens && tokens.verify(token, port))) return fail(403, "Jeton d'aperçu invalide ou expiré");
    const ports = await allowed();
    if (!ports.some((p) => p.port === port)) return fail(403, "Ce port n'écoute pas (ou n'est pas autorisé)");
    if (m[3] === undefined) { res.writeHead(302, { location: prefixOf(port, token) + (url.search || "") }); return res.end(); }
    const headers = { host: `127.0.0.1:${port}`, "accept-encoding": "identity", accept: req.headers.accept || "*/*", "user-agent": req.headers["user-agent"] || "paseo-preview" };
    if (req.headers.range) headers.range = req.headers.range;
    const upstream = request({ host: "127.0.0.1", port, method: req.method, path: m[3] + (url.search || ""), headers, timeout: timeoutMs }, (up) => {
      const out = { ...up.headers };
      for (const h of ["x-frame-options", "content-security-policy", "content-security-policy-report-only", "set-cookie", "content-length", "transfer-encoding"]) delete out[h];
      out["access-control-allow-origin"] = "*";
      out["cache-control"] = "no-store";
      out["referrer-policy"] = "no-referrer";
      if (typeof out.location === "string" && out.location.startsWith("/") && !out.location.startsWith("//")) out.location = prefixOf(port, token) + out.location.slice(1);
      const isHtml = /text\/html/i.test(String(up.headers["content-type"] || ""));
      if (!isHtml) { res.writeHead(up.statusCode || 502, out); up.pipe(res); return; }
      const chunks = []; let size = 0;
      up.on("data", (c) => { size += c.length; if (size > maxHtml) { up.destroy(); fail(502, "Page trop grande pour l'aperçu"); } else chunks.push(c); });
      up.on("end", () => { if (res.writableEnded) return; const body = Buffer.from(rewriteHtml(Buffer.concat(chunks).toString("utf8"), port, token)); out["content-length"] = body.length; res.writeHead(up.statusCode || 502, out); res.end(req.method === "HEAD" ? undefined : body); });
    });
    upstream.on("timeout", () => upstream.destroy(new Error("délai dépassé")));
    upstream.on("error", () => fail(502, "Le serveur local ne répond pas"));
    upstream.end();
  };
}
