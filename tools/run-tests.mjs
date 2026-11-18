#!/usr/bin/env node
// Lance les suites dashboard/scripts/verify-*.mjs hors ligne (sans daemon réel ni LLM) : `npm test`.
// Les suites qui exigent un navigateur, un daemon Paseo ou le réseau sont listées dans tools/tests-skip.json (avec la raison).
// Usage : node tools/run-tests.mjs [--all] [--timeout=90] [--jobs=4] [filtre]
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixture, freePort } from "./test-fixture.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scripts = join(root, "dashboard", "scripts");
const args = process.argv.slice(2);
const opt = (n, d) => Number((args.find(a => a.startsWith(`--${n}=`)) || "").split("=")[1]) || d;
const all = args.includes("--all");
const filter = args.find(a => !a.startsWith("--"));
const timeoutMs = opt("timeout", 90) * 1000;
const jobs = opt("jobs", 4);
const skipFile = join(root, "tools", "tests-skip.json");
const skip = existsSync(skipFile) ? JSON.parse(readFileSync(skipFile, "utf8")) : {};

const suites = readdirSync(scripts).filter(f => /^verify-.*\.mjs$/.test(f))
  .filter(f => !filter || f.includes(filter))
  .filter(f => all || !skip[f]).sort();
const skipped = readdirSync(scripts).filter(f => skip[f] && !all && (!filter || f.includes(filter)));

// Les suites qui visaient le serveur réel (:7070) reçoivent un poste jetable (daemon + tableau de bord, ports libres, données en temp).
// Aucune suite ne peut atteindre le :7070 : sans poste jetable, les URL par défaut pointent vers un port fermé.
const needsFixture = f => /DASHBOARD_VERIFY_URL|T30_URL|AGENTAPI_PROD_URL|ws:\/\/127\.0\.0\.1:7070/.test(readFileSync(join(scripts, f), "utf8"));
const killGroup = p => { try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch { /* déjà arrêté */ } } };

const run = async f => {
  const t0 = Date.now();
  let fixture = null; let out = "";
  const tmp = mkdtempSync(join(tmpdir(), "paseo-suite-"));
  try {
    const hostsDummy = join(tmp, "hosts.json");
    writeFileSync(hostsDummy, JSON.stringify({ hosts: [{ label: "local", url: "ws://127.0.0.1:9/ws" }] }));
    // Dépôt bac à sable jetable (remplace D:/Projets/AI-OS/paseo-poste/sandbox-repo des suites écrites sous Windows).
    const sandbox = join(tmp, "sandbox-repo");
    mkdirSync(sandbox, { recursive: true });
    writeFileSync(join(sandbox, "README.md"), "# sandbox-repo\n");
    const git = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: sandbox, stdio: "ignore" });
    git("init", "-q"); git("add", "."); git("commit", "-qm", "init");
    const env = { ...process.env, VERIFY_SANDBOX: sandbox.replace(/\\/g, "/"), VERIFY_HEADLESS: "1", VERIFY_PORT: String(await freePort()), DASHBOARD_HOSTS_FILE: hostsDummy, PASEO_LOCAL_URL: "ws://127.0.0.1:9/ws",
      DASHBOARD_VERIFY_URL: "ws://127.0.0.1:1/ui", T30_URL: "http://127.0.0.1:1", AGENTAPI_PROD_URL: "http://127.0.0.1:1" };
    if (needsFixture(f)) {
      try { fixture = await startFixture(); Object.assign(env, fixture.env); }
      catch (e) { return { f, ok: false, ms: Date.now() - t0, out: `[FIXTURE] ${e.message}` }; }
    }
    return await new Promise(resolve => {
      const p = spawn(process.execPath, [join(scripts, f)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      p.stdout.on("data", d => (out += d)); p.stderr.on("data", d => (out += d));
      const timer = setTimeout(() => { out += "\n[TIMEOUT]"; killGroup(p); }, timeoutMs);
      p.on("close", code => { clearTimeout(timer); killGroup(p); if (code !== 0 && fixture && process.env.VERIFY_SHOW_FIXTURE) out += `\n[poste jetable] ${fixture.logs.dash.slice(-600)}`; resolve({ f, ok: code === 0, ms: Date.now() - t0, out }); });
    });
  } finally { fixture?.stop(); try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } }
};

const results = []; const queue = [...suites];
await Promise.all(Array.from({ length: jobs }, async () => {
  while (queue.length) {
    const r = await run(queue.shift()); results.push(r);
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.f} (${(r.ms / 1000).toFixed(1)}s)`);
  }
}));
const failed = results.filter(r => !r.ok).sort((a, b) => a.f.localeCompare(b.f));
// La sortie COMPLÈTE d'une suite en échec est gardée hors du dépôt (dossier temporaire) : utile pour les échecs rares (délais).
const logDir = join(tmpdir(), "paseo-test-failures");
for (const r of failed) {
  let kept = "";
  try {
    mkdirSync(logDir, { recursive: true });
    const file = join(logDir, `${r.f.replace(/\.mjs$/, "")}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
    writeFileSync(file, `${r.f} (${(r.ms / 1000).toFixed(1)} s)\n${r.out}`);
    kept = `\n(sortie complète : ${file})`;
  } catch { /* dossier temporaire indisponible : la fin de la sortie reste affichée */ }
  console.log(`\n--- ${r.f} ---\n${r.out.split("\n").slice(-Number(process.env.VERIFY_TAIL || 15)).join("\n")}${kept}`);
}
console.log(`\n${results.length - failed.length}/${results.length} suites OK, ${skipped.length} ignorées (tests-skip.json)`);
process.exit(failed.length ? 1 : 0);
