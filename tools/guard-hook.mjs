#!/usr/bin/env node
// Hook PreToolUse de Claude Code : applique dashboard/lib/guardrails.mjs aux agents AUTONOMES seulement
// (variable POSTE_AUTONOMOUS=1, posée par le lanceur du cerveau/des ouvriers). Les sessions interactives de Philippe ne sont pas touchées.
// Refus = code de sortie 2 + message sur stderr (Claude Code le renvoie à l'agent). Chaque refus est journalisé.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.env.POSTE_AUTONOMOUS !== "1") process.exit(0);
let raw = "";
for await (const c of process.stdin) raw += c;
let ev; try { ev = JSON.parse(raw); } catch { process.exit(0); }
const { checkToolCall } = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "dashboard", "lib", "guardrails.mjs")).href);
const G = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "dashboard", "lib", "guardrails.mjs")).href);
let verdict = checkToolCall(ev.tool_name, ev.tool_input || {}, { cwd: ev.cwd });
// Fusion d'une PR : seulement si tous ses contrôles GitHub sont verts (la CI est le filet de sécurité de la fusion automatique).
const cmd = String(ev.tool_input?.command ?? "");
if (verdict.allow && /^bash$/i.test(ev.tool_name) && G.isPrMerge(cmd)) {
  const r = G.prChecksGreen(G.prMergeTarget(cmd), ev.cwd);
  if (!r.green) verdict = { allow: false, guard: "ci", reason: r.status === 8 ? "la CI de la PR est encore en cours : attends (gh pr checks --watch) puis refais la fusion" : "la CI de la PR n'est pas verte : corrige avant de fusionner" };
}
if (verdict.allow) process.exit(0);
try {
  const dir = process.env.DASHBOARD_DATA_DIR || join(homedir(), "paseo-dash-data"); mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "guard-audit.jsonl"), JSON.stringify({ at: new Date().toISOString(), guard: verdict.guard, tool: ev.tool_name, cwd: ev.cwd, session: ev.session_id, reason: verdict.reason }) + "\n");
} catch {}
process.stderr.write(`GARDE-FOU (${verdict.guard}) : ${verdict.reason}\n`);
process.exit(2);
