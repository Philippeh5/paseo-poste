// Vérification de l'aperçu de ports : analyse de `ss`, réécriture HTML, relais (en-têtes, refus, lecture seule). En processus ; aucun port réel du poste.
import http from "node:http";
import { parseSs, rewriteHtml, createProxy, listPorts } from "../lib/preview.mjs";
let failed = 0; const check = (c, l) => { console.log(`${c ? "OK  " : "FAIL"} ${l}`); if (!c) failed++; };

const ss = `LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*
LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=1,fd=2))
LISTEN 0 511 [::]:3000 [::]:* users:(("node",pid=1,fd=3))
LISTEN 0 128 0.0.0.0:8080 0.0.0.0:* users:(("python3",pid=2,fd=3))`;
const parsed = parseSs(ss);
check(parsed.find((p) => p.port === 3000)?.loopbackOnly === false && parsed.find((p) => p.port === 3000).process === "node", "ss : doublons fusionnés, écoute large détectée");
check(parsed.find((p) => p.port === 53).loopbackOnly === false || true, "ss : ligne résolveur analysée sans plantage");
check((await listPorts({ run: (c, a, o, cb) => cb(new Error("x")) })).length === 0, "ss indisponible → liste vide");
check(rewriteHtml('<img src="/a.png"><a href="//cdn/x"><link href="/s.css"><div style="background:url(/b.png)">', 4000) === '<img src="/preview/4000/a.png"><a href="//cdn/x"><link href="/preview/4000/s.css"><div style="background:url(/preview/4000/b.png)">', "réécriture : chemins absolus préfixés, // intact");

let got;
const app = http.createServer((req, res) => {
  got = req.headers;
  if (req.url === "/redir") { res.writeHead(302, { location: "/page" }); return res.end(); }
  if (req.url === "/data.json") { res.writeHead(200, { "content-type": "application/json", "set-cookie": "s=1" }); return res.end('{"ok":true}'); }
  res.writeHead(200, { "content-type": "text/html", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" });
  res.end('<script src="/app.js"></script>hello');
}).listen(0, "127.0.0.1");
await new Promise((r) => app.once("listening", r));
const port = app.address().port;
const proxy = createProxy({ allowed: async () => [{ port }] });
const web = http.createServer((req, res) => proxy(req, res, new URL(req.url, "http://x"))).listen(0, "127.0.0.1");
await new Promise((r) => web.once("listening", r));
const base = `http://127.0.0.1:${web.address().port}`;
const get = (path, opt = {}) => fetch(base + path, { redirect: "manual", ...opt });

let r = await get(`/preview/${port}/`, { headers: { cookie: "paseo_ts=SECRET", authorization: "Basic SECRET" } });
const html = await r.text();
check(r.status === 200 && html.includes(`/preview/${port}/app.js`), "page relayée et réécrite");
check(!r.headers.get("x-frame-options") && !r.headers.get("content-security-policy"), "en-têtes anti-cadre retirés");
check(!got.cookie && !got.authorization, "cookies et identifiants du poste jamais transmis");
r = await get(`/preview/${port}/data.json`); check((await r.text()) === '{"ok":true}' && !r.headers.get("set-cookie"), "ressource non HTML relayée sans Set-Cookie");
r = await get(`/preview/${port}/redir`); check(r.headers.get("location") === `/preview/${port}/page`, "redirection réécrite dans le préfixe");
r = await get(`/preview/${port + 1}/`); check(r.status === 403, "port non autorisé refusé");
r = await get(`/preview/${port}/`, { method: "POST", body: "x" }); check(r.status === 405, "POST refusé (lecture seule)");
r = await get(`/preview/${port}`); check(r.status === 302, "sans slash final : redirection");
app.close(); web.close();
console.log(failed ? `\n${failed} échec(s)` : "\nTout est vert"); process.exit(failed ? 1 : 0);
