import { createPaseoClient } from "@getpaseo/client";

const client = createPaseoClient({ url: "ws://127.0.0.1:6767/ws", reconnect: { enabled: true } });
try {
  await client.connect();
  const { entries } = await client.workspaces.list({});
  const workspace = entries[0];
  if (!workspace) throw new Error("Le daemon ne fournit aucun workspace.");
  const terminal = await client.terminals.create({
    workspaceId: workspace.id,
    name: "Dashboard clock",
    command: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-Command", "while ($true) { Write-Output (Get-Date -Format HH:mm:ss); Start-Sleep -Seconds 1 }"]
  });
  console.log(JSON.stringify({ host: "local", workspaceId: workspace.id, terminalId: terminal.id }));
  console.log("Terminal actif. Ctrl+C termine le script; le terminal reste ouvert sur le daemon.");
  await new Promise(() => {});
} catch (error) {
  console.error(error.message);
  await client.close();
  process.exitCode = 1;
}
