// dashboard/scripts/verify-composio.mjs
// Vérification 100 % hors ligne du pont Composio : décisions de politique, refus,
// comptes par fournisseur, CLI (code 3), serveur MCP et journal d'audit.
// Aucun appel réseau, aucune session Composio réelle, aucun secret : tout est temporaire.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, isWriteSlug, readAudit, redact, toolkitOf } from "../../tools/composio-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(root, "tools", "composio.mjs");
const mcp = join(root, "tools", "composio-mcp.mjs");
const scratch = mkdtempSync(join(tmpdir(), "paseo-composio-"));
const policyFile = join(scratch, "policy.json");
const dataDir = join(scratch, "data");

const policy = {
  defaults: { toolkits: [], writes: false, link: false, scripts: false },
  agents: {
    reader: { toolkits: ["gmail"], writes: false, accounts: { gmail: "lecture" } },
    writer: { toolkits: ["github", "googlesheets"], writes: true, accounts: { github: "work", googlesheets: "compta" }, deniedSlugs: ["GITHUB_DELETE_REPOSITORY"] },
    ops: { toolkits: ["*"], writes: true, link: true, scripts: true },
  },
  deniedSlugs: ["GMAIL_DELETE_ALL_EMAILS"],
};
writeFileSync(policyFile, JSON.stringify(policy, null, 2));
process.env.COMPOSIO_POLICY_FILE = policyFile;
process.env.DASHBOARD_DATA_DIR = dataDir;

let passed = 0;
let failed = 0;
const ok = (label) => { passed++; console.log(`OK   ${label}`); };
const fail = (label, detail = "") => { failed++; console.error(`FAIL ${label}${detail ? ` -> ${detail}` : ""}`); };
const expect = (cond, label, detail = "") => (cond ? ok(label) : fail(label, detail));
const section = (name) => console.log(`\n=== ${name} ===`);

const env = (agent) => ({ ...process.env, COMPOSIO_AGENT: agent });
const runCli = (agent, args) => spawnSync(process.execPath, [cli, ...args], { env: env(agent), encoding: "utf8", timeout: 15000 });
const runMcp = (agent, requests) => spawnSync(process.execPath, [mcp], {
  env: env(agent),
  input: requests.map((r) => JSON.stringify(r)).join("\n") + "\n",
  encoding: "utf8",
  timeout: 15000,
});
const handshake = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "verify", version: "1" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
];

try {
  section("Détection d'application et d'écriture");
  expect(toolkitOf("GMAIL_FETCH_EMAILS") === "gmail", "slug -> toolkit gmail");
  expect(toolkitOf("GOOGLECALENDAR_CREATE_EVENT") === "googlecalendar", "slug -> toolkit googlecalendar (nom collé)");
  expect(isWriteSlug("GMAIL_SEND_EMAIL") === true, "SEND est une écriture");
  expect(isWriteSlug("GMAIL_FETCH_EMAILS") === false, "FETCH est une lecture");

  section("Politique par agent et par application");
  const d = (agent, opts) => decide(policy, agent, opts);
  expect(d("intrus", { action: "execute", slug: "GMAIL_FETCH_EMAILS", toolkit: "gmail" }).allowed === false,
    "agent inconnu : aucune application");
  const read = d("reader", { action: "execute", slug: "GMAIL_FETCH_EMAILS" });
  expect(read.allowed === true && read.toolkit === "gmail" && read.account === "lecture",
    "lecture Gmail autorisée avec le compte « lecture »");
  expect(d("reader", { action: "execute", slug: "GMAIL_SEND_EMAIL", confirm: true }).code === "write_denied",
    "lecture Gmail : écriture refusée même avec confirm");
  const write = d("writer", { action: "execute", slug: "GITHUB_CREATE_AN_ISSUE", confirm: true });
  expect(write.allowed === true && write.account === "work", "writer : création d'issue GitHub avec le compte « work »");
  expect(d("writer", { action: "execute", slug: "GITHUB_CREATE_AN_ISSUE" }).code === "confirm_required",
    "écriture sans confirm refusée");
  expect(d("writer", { action: "execute", slug: "GITHUB_DELETE_REPOSITORY", confirm: true }).code === "forbidden_slug",
    "slug interdit même sur un toolkit autorisé");
  expect(d("writer", { action: "schema", slug: "GMAIL_FETCH_EMAILS", toolkit: "gmail" }).code === "toolkit_denied",
    "writer n'a pas accès à Gmail");
  expect(d("writer", { action: "link", toolkit: "github" }).code === "link_denied", "writer ne peut pas connecter de compte");
  expect(d("writer", { action: "run", confirm: true }).code === "script_denied", "writer ne peut pas lancer de script");
  expect(d("ops", { action: "run", confirm: true }).allowed === true, "ops peut lancer un script multi-apps");
  const sheets = d("writer", { action: "execute", slug: "GOOGLESHEETS_FIND_WORKSHEET", toolkit: "google" });
  expect(sheets.allowed === true && sheets.toolkit === "googlesheets" && sheets.account === "compta",
    "toolkit multi-mot déduit correctement (googlesheets)");

  section("Anonymisation des sorties");
  const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
  expect(!String(redact(secret)).includes(secret), "jeton tronqué dans le journal");
  expect(redact({ token: "abcdefghijklmnop" }).token !== "abcdefghijklmnop", "champ token masqué");

  section("CLI : refus et sorties");
  const cliDenied = runCli("reader", ["execute", "GMAIL_SEND_EMAIL", "-d", "{}", "--confirm"]);
  let cliPayload = null;
  try { cliPayload = JSON.parse(cliDenied.stdout); } catch { /* ignoré */ }
  expect(cliDenied.status === 3 && cliPayload?.error?.code === "write_denied", "CLI : refus d'écriture, code 3");
  const cliConfirm = runCli("writer", ["execute", "GITHUB_CREATE_AN_ISSUE", "-d", "{}"]);
  try { cliPayload = JSON.parse(cliConfirm.stdout); } catch { /* ignoré */ }
  expect(cliConfirm.status === 3 && cliPayload?.error?.code === "confirm_required", "CLI : confirm manquant, code 3");
  const cliPolicy = runCli("reader", ["policy"]);
  let cliPolicyPayload = null;
  try { cliPolicyPayload = JSON.parse(cliPolicy.stdout); } catch { /* ignoré */ }
  expect(cliPolicy.status === 0 && cliPolicyPayload?.toolkits?.includes("gmail"), "CLI : policy montre les apps de l'agent");

  section("Serveur MCP");
  const mcpTools = runMcp("reader", [...handshake, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }]);
  const names = [...new Set(String(mcpTools.stdout).match(/app_[a-z_]+/g) || [])];
  expect(mcpTools.status === 0 && names.length === 8, "MCP : 8 outils app_* exposés", names.join(","));
  const mcpConfirm = runMcp("reader", [...handshake, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "app_execute", arguments: { slug: "GMAIL_SEND_EMAIL", data: {} } } }]);
  expect(String(mcpConfirm.stdout).includes("confirm: true"), "MCP : écriture sans confirm refusée");
  const mcpDenied = runMcp("reader", [...handshake, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "app_execute", arguments: { slug: "GMAIL_SEND_EMAIL", data: {}, confirm: true } } }]);
  expect(String(mcpDenied.stdout).includes("write_denied"), "MCP : refus de politique appliqué");

  section("Journal d'audit");
  const entries = readAudit(20);
  expect(entries.length >= 1 && entries.some((e) => e.code === "confirm_required"), "MCP : refus journalisé");
  const raw = readFileSync(join(dataDir, "composio-audit.jsonl"), "utf8");
  expect(!raw.includes("sk-") && !raw.includes("data"), "journal sans charge utile ni jeton");
} catch (e) {
  fail("exception inattendue", e.stack || e.message);
} finally {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* ignoré */ }
}

console.log(`\n=== BILAN : ${passed} OK, ${failed} FAIL ===`);
if (failed > 0) process.exit(1);
console.log("VERIFY_COMPOSIO_PASS");
process.exit(0);
