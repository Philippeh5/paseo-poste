// Poste jetable pour les suites qui visaient jadis le serveur réel :7070 : un daemon Paseo + un tableau de bord
// sur des ports libres, avec dossier de données et hosts.json jetables (temp). Rien de réel n'est touché
// (ni :7070, ni dashboard/data, ni hosts.json, ni ~/paseo-dash-data). Seuls les PID lancés ici sont arrêtés.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const slash = (p) => p.replace(/\\/g, "/");

export const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const portOpen = (port) => new Promise((resolve) => {
  const c = connect(port, "127.0.0.1");
  c.once("connect", () => { c.destroy(); resolve(true); });
  c.once("error", () => resolve(false));
});

async function waitUntil(fn, ms, step = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, step)); }
  return false;
}

// Variables d'environnement « propres » : rien de la session de l'utilisateur (PASEO_*, DASHBOARD_*…) ne fuit.
export const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PASEO_|DASHBOARD_|POSTECTL_|COORD_|AGENTAPI_|T30_|VERIFY_)/.test(k)));

export async function startFixture({ withDaemon = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "paseo-fixture-"));
  const home = join(dir, "daemon-home");
  const data = join(dir, "data");
  for (const d of [home, data]) mkdirSync(d, { recursive: true });
  const procs = [];
  const logs = { daemon: "", dash: "" };
  const kill = () => { for (const p of procs) { try { p.kill("SIGKILL"); } catch { /* déjà arrêté */ } } };
  try {
    const daemonPort = await freePort();
    const dashPort = await freePort();
    const hostUrl = `ws://127.0.0.1:${daemonPort}/ws`;
    if (withDaemon) {
      writeFileSync(join(home, "config.json"), JSON.stringify({
        version: 1,
        daemon: { listen: `127.0.0.1:${daemonPort}`, cors: { allowedOrigins: [] }, relay: { enabled: false } },
        pluginsEnabled: false,
        features: { dictation: { enabled: false }, voiceMode: { enabled: false } },
      }, null, 2));
      const daemon = spawn(process.execPath, [join(root, "node_modules", "@getpaseo", "cli", "bin", "paseo"), "daemon", "run", "--home", home], {
        env: { ...cleanEnv(), PASEO_HOME: home, PASEO_LISTEN: `127.0.0.1:${daemonPort}`, PASEO_DICTATION_ENABLED: "false", PASEO_VOICE_MODE_ENABLED: "false" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      procs.push(daemon);
      daemon.stdout.on("data", (d) => { logs.daemon += d; });
      daemon.stderr.on("data", (d) => { logs.daemon += d; });
      if (!(await waitUntil(() => portOpen(daemonPort), 90000))) throw new Error(`daemon jetable non démarré : ${logs.daemon.slice(-300)}`);
    }
    const hostsFile = join(dir, "hosts.json");
    writeFileSync(hostsFile, JSON.stringify({ hosts: [{ label: "local", url: hostUrl }, { label: "oracle", url: "ws://127.0.0.1:9/ws" }] }));
    const dash = spawn(process.execPath, [join(root, "dashboard", "server.mjs")], {
      env: { ...cleanEnv(), DASHBOARD_PORT: String(dashPort), DASHBOARD_WSL: "0", DASHBOARD_DATA_DIR: data, DASHBOARD_HOST: "127.0.0.1", DASHBOARD_HOSTS_FILE: hostsFile },
      cwd: join(root, "dashboard"), stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(dash);
    dash.stdout.on("data", (d) => { logs.dash += d; });
    dash.stderr.on("data", (d) => { logs.dash += d; });
    if (!(await waitUntil(() => logs.dash.includes("Paseo dashboard :"), 60000, 100))) throw new Error(`tableau de bord jetable non démarré : ${logs.dash.slice(-300)}`);
    // Laisse le temps à la connexion dashboard -> daemon.
    if (withDaemon) await waitUntil(async () => { try { const r = await fetch(`http://127.0.0.1:${dashPort}/api/v1/summary`); const j = await r.json(); return JSON.stringify(j).includes("connected"); } catch { return false; } }, 20000, 300);
    return {
      dir, home, data, hostsFile, daemonPort, dashPort, logs,
      env: {
        DASHBOARD_VERIFY_URL: `ws://127.0.0.1:${dashPort}/ui`,
        T30_URL: `http://127.0.0.1:${dashPort}`,
        AGENTAPI_PROD_URL: `http://127.0.0.1:${dashPort}`,
        DASHBOARD_HOSTS_FILE: hostsFile,
        PASEO_LOCAL_URL: hostUrl,
        DASHBOARD_DATA_DIR: data,
        VERIFY_FIXTURE_DIR: slash(dir),
      },
      stop() { kill(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } },
    };
  } catch (e) { kill(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } throw e; }
}
