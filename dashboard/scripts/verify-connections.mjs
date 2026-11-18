// Vérification de la page « Connexions » : détection, clés d'API (600, jamais renvoyées), installation en liste blanche,
// skills partagés (liens sans écrasement). Partie A en processus ; partie B : instance isolée (port 7099 ou VERIFY_PORT).
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, lstatSync, readFileSync, rmSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { CATALOG, detectOne, install, writeEnvKey, removeEnvKey, readEnv, listSharedSkills, linkSkills, skillsStatus, importSkill, getEntry } from "../lib/connections.mjs";

let failed = 0;
const check = (cond, label) => { console.log(`${cond ? "OK  " : "FAIL"} ${label}`); if (!cond) failed++; };
const dir = mkdtempSync(join(tmpdir(), "conn-"));
const SECRET = "sk-or-v1-SECRETSECRET1234567890";

// --- A. détection
const gh = getEntry("github");
check((await detectOne(gh, { run: async () => true })).status !== "missing" || true, "détection sans plantage");
const fakeKey = getEntry("openrouter");
check((await detectOne(fakeKey, { dataDir: dir, env: {} })).status === "missing", "clé absente → absent");
writeEnvKey(dir, "OPENROUTER_API_KEY", SECRET);
const det = await detectOne(fakeKey, { dataDir: dir, env: {} });
check(det.status === "connected", "clé enregistrée → connecté");
check(!JSON.stringify(det).includes(SECRET), "la clé n'apparaît jamais dans l'état");
check((statSync(join(dir, "connections.env")).mode & 0o777) === 0o600, "fichier de clés en 600");
check(removeEnvKey(dir, "OPENROUTER_API_KEY") && !readEnv(dir).OPENROUTER_API_KEY, "suppression de la clé");
for (const bad of ["", "a\nb", "x".repeat(600)]) { let t = false; try { writeEnvKey(dir, "OPENROUTER_API_KEY", bad); } catch { t = true; } check(t, `clé refusée : ${JSON.stringify(bad.slice(0, 8))}`); }
let t = false; try { writeEnvKey(dir, "bad name", "v"); } catch { t = true; } check(t, "nom de variable invalide refusé");

// --- installation : liste blanche
let rej = ""; try { await install("tailscale"); } catch (e) { rej = e.message; } check(/Pas d'installation/.test(rej), "sans commande fixe → refus");
rej = ""; try { await install("../../bin/sh"); } catch (e) { rej = e.message; } check(/inconnu/.test(rej), "identifiant inconnu → refus");
let seen; await install("codex", { run: (bin, args, o, cb) => { seen = args; cb(null, "ok", ""); } });
check(seen.join(" ") === "install -g @openai/codex", "installation = argv fixe du catalogue");
rej = ""; try { await install("codex", { run: (b, a, o, cb) => cb(Object.assign(new Error("x"), { code: 1 }), "", `token=${SECRET}`) }); } catch (e) { rej = e.message; }
check(rej.includes("Échec") && !rej.includes(SECRET), "échec d'installation : message sans secret");
check(CATALOG.every((c) => c.kind === "key" || c.bin) && new Set(CATALOG.map((c) => c.id)).size === CATALOG.length, "catalogue cohérent, ids uniques");

// --- skills
const shared = join(dir, "shared"); const tgt = join(dir, "t1"); const tgt2 = join(dir, "t2");
for (const n of ["alpha", "beta"]) { mkdirSync(join(shared, n), { recursive: true }); writeFileSync(join(shared, n, "SKILL.md"), "# s"); }
mkdirSync(join(shared, "pas-un-skill"), { recursive: true });
mkdirSync(join(tgt, "alpha"), { recursive: true }); writeFileSync(join(tgt, "alpha", "SKILL.md"), "ORIGINAL");
const targets = [{ id: "t1", label: "T1", dir: tgt }, { id: "t2", label: "T2", dir: tgt2 }];
check(listSharedSkills(shared).join() === "alpha,beta", "seuls les dossiers avec SKILL.md sont des skills");
const r = linkSkills({ sharedDir: shared, targets });
check(r.created.length === 3 && r.skipped.join() === "t1/alpha", "liens créés, existant ignoré");
check(readFileSync(join(tgt, "alpha", "SKILL.md"), "utf8") === "ORIGINAL", "skill existant jamais écrasé");
check(lstatSync(join(tgt2, "beta")).isSymbolicLink() && readlinkSync(join(tgt2, "beta")) === join(shared, "beta"), "lien symbolique vers le dossier partagé");
check(skillsStatus({ sharedDir: shared, targets }).targets.every((x) => x.missing === 0), "état : tout relié");
const src = join(dir, "src", "gamma"); mkdirSync(src, { recursive: true }); writeFileSync(join(src, "SKILL.md"), "# g");
check(importSkill(src, { sharedDir: shared }) === "gamma", "import d'un skill");
rej = ""; try { importSkill(src, { sharedDir: shared }); } catch (e) { rej = e.message; } check(/déjà/.test(rej), "import sans écrasement");
rej = ""; try { importSkill(dir, { sharedDir: shared }); } catch (e) { rej = e.message; } check(/SKILL\.md/.test(rej), "import refusé sans SKILL.md");

// --- Composio : politique
const { ensurePolicy, setAgent, removeAgent, readPolicy, summarize, listAccounts } = await import("../lib/composio-admin.mjs");
const pf = join(dir, "pol.json");
check(ensurePolicy(pf) === true && (statSync(pf).mode & 0o777) === 0o600, "politique créée en 600");
check(readPolicy(pf).agents["*"].toolkits.length === 0 && readPolicy(pf).defaults.writes === false, "politique par défaut : tout refusé");
setAgent(pf, { agent: "claude", toolkits: ["gmail", "github"], writes: false });
check(ensurePolicy(pf) === false, "politique existante jamais remplacée");
writeFileSync(pf, JSON.stringify({ ...readPolicy(pf), agents: { ...readPolicy(pf).agents, claude: { ...readPolicy(pf).agents.claude, link: true, deniedSlugs: ["X"] } } }));
setAgent(pf, { agent: "claude", toolkits: ["gmail"], writes: true });
const c = readPolicy(pf).agents.claude;
check(c.toolkits.join() === "gmail" && c.writes === true && c.link === true && c.deniedSlugs[0] === "X", "setAgent préserve link et deniedSlugs, ne les accorde pas");
for (const bad of [{ agent: "Bad Name", toolkits: [], writes: false }, { agent: "x", toolkits: ["*"], writes: false }, { agent: "x", toolkits: "gmail", writes: false }]) { let r2 = false; try { setAgent(pf, bad); } catch { r2 = true; } check(r2, `setAgent refuse ${JSON.stringify(bad.agent)}/${JSON.stringify(bad.toolkits)}`); }
setAgent(pf, { agent: "nouveau", toolkits: [], writes: false });
check(summarize(readPolicy(pf)).agents.find((a) => a.name === "nouveau").link === false, "un nouvel agent n'a ni link ni scripts");
removeAgent(pf, "*"); check(!!readPolicy(pf).agents["*"], "la règle « * » ne peut pas être retirée");
removeAgent(pf, "nouveau"); check(!readPolicy(pf).agents.nouveau, "retrait d'un agent");
const accts = await listAccounts(async () => JSON.stringify({ google_maps: [{ status: "ACTIVE", id: "ca_SECRET", alias: "a@b.c" }], gmail: [{ status: "ACTIVE" }, { status: "EXPIRED" }] }));
check(accts.find((a) => a.toolkit === "googlemaps").count === 1 && accts.find((a) => a.toolkit === "gmail").active === 1 && !JSON.stringify(accts).includes("ca_SECRET") && !JSON.stringify(accts).includes("a@b.c"), "comptes : agrégés, sans identifiant ni alias");

// --- B. instance isolée
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.VERIFY_PORT || 7099); if (PORT === 7070) throw new Error("jamais :7070");
const data = join(dir, "data"); mkdirSync(data);
const hostsFile = join(dir, "hosts.json"); writeFileSync(hostsFile, JSON.stringify({ hosts: [] }));
const child = spawn(process.execPath, [join(root, "server.mjs")], { env: { ...process.env, DASHBOARD_HOST: "127.0.0.1", DASHBOARD_PORT: String(PORT), DASHBOARD_DATA_DIR: data, DASHBOARD_HOSTS_FILE: hostsFile, PASEO_SHARED_SKILLS: shared, COMPOSIO_POLICY_FILE: join(dir, "inst-pol.json"), COMPOSIO_BIN: "/bin/false" }, stdio: "ignore" });
try {
  let ws; for (let i = 0; i < 50; i++) { try { ws = await new Promise((res, rej2) => { const w = new WebSocket(`ws://127.0.0.1:${PORT}/ui`, { origin: `http://127.0.0.1:${PORT}` }); w.on("open", () => res(w)); w.on("error", rej2); }); break; } catch { await sleep(200); } }
  check(!!ws, "instance isolée joignable");
  const msgs = []; ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
  const waitFor = async (type, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = msgs.find((x) => x.type === type); if (m) { msgs.splice(msgs.indexOf(m), 1); return m; } await sleep(50); } return null; };
  ws.send(JSON.stringify({ type: "connections.get" }));
  const s = await waitFor("connections.state");
  check(s && s.items.length === CATALOG.length && Array.isArray(s.skills.shared), "connections.state complet");
  ws.send(JSON.stringify({ type: "connections.setKey", id: "openrouter", value: SECRET }));
  const e1 = await waitFor("error"); check(e1 && /Confirmation/.test(e1.message), "setKey sans confirm refusé");
  ws.send(JSON.stringify({ type: "connections.setKey", id: "openrouter", value: SECRET, confirm: true }));
  const d1 = await waitFor("connections.done"); const s2 = await waitFor("connections.state");
  check(d1?.ok && s2?.items.find((i) => i.id === "openrouter").status === "connected", "clé enregistrée → état connecté");
  check(!JSON.stringify([d1, s2]).includes(SECRET), "aucun écho de la clé");
  ws.send(JSON.stringify({ type: "connections.install", id: "tailscale", confirm: true }));
  const d2 = await waitFor("connections.done"); check(d2 && d2.ok === false, "installation sans commande fixe → échec propre");
  ws.send(JSON.stringify({ type: "connections.setKey", id: "claude", value: "x", confirm: true }));
  const e2 = await waitFor("error"); check(!!e2, "setKey sur un connecteur sans clé refusé");
  ws.send(JSON.stringify({ type: "composio.get" }));
  const cg = await waitFor("composio.state"); check(cg && cg.policy.exists === false && !!cg.error, "composio.get : sans politique, CLI en échec signalé proprement");
  ws.send(JSON.stringify({ type: "composio.setAgent", agent: "claude", toolkits: ["gmail"], writes: false }));
  check(/Confirmation/.test((await waitFor("error"))?.message ?? ""), "composio.setAgent sans confirm refusé");
  ws.send(JSON.stringify({ type: "composio.setAgent", agent: "claude", toolkits: ["gmail"], writes: false, confirm: true }));
  await waitFor("connections.done"); const cg2 = await waitFor("composio.state");
  check(cg2?.policy.agents.find((a) => a.name === "claude")?.toolkits[0] === "gmail", "composio.setAgent confirmé → politique diffusée");
  ws.close();
} finally { child.kill(); rmSync(dir, { recursive: true, force: true }); }
console.log(failed ? `\n${failed} échec(s)` : "\nTout est vert");
process.exit(failed ? 1 : 0);
