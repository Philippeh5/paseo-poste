// Mises en page nommées du Bureau, stockées dans data/layouts.json.
// Messages : layout.list, layout.save, layout.load, layout.delete, layout.autosave (silencieux).
const FILE = "layouts";
const MAX_WINDOWS = 60;
const MAX_LAYOUTS = 50;
const MAX_NAME = 60;

const text = (value, max = 500) => (typeof value === "string" && value ? value.slice(0, max) : undefined);
const int = (value, fallback = 0) => (Number.isFinite(value) ? Math.round(value) : fallback);

function cleanWindow(w) {
  if (!w || typeof w !== "object" || !/^[a-z][\w-]{0,30}$/.test(w.type || "")) return null;
  return {
    type: w.type,
    host: text(w.host, 100),
    terminalId: text(w.terminalId, 200),
    agentId: text(w.agentId, 200),
    workspaceId: text(w.workspaceId, 200),
    cwd: text(w.cwd, 1000),
    title: text(w.title, 200),
    tool: text(w.tool, 60),
    x: int(w.x),
    y: int(w.y),
    w: Math.max(0, int(w.w, 480)),
    h: Math.max(0, int(w.h, 320)),
    minimized: w.minimized === true,
    maximized: w.maximized === true,
    z: int(w.z),
  };
}

function cleanWindows(list) {
  if (!Array.isArray(list)) return null;
  return list.slice(0, MAX_WINDOWS).map(cleanWindow).filter(Boolean);
}

const cleanName = (name) => String(name ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();

export function register(ctx) {
  const { onMessage, send, broadcast, sendError, store } = ctx;
  const load = () => {
    const data = store.read(FILE, {});
    return { layouts: Array.isArray(data.layouts) ? data.layouts : [], current: data.current ?? null };
  };
  const summary = (data) => ({
    type: "layout.list",
    layouts: data.layouts.map((l) => ({ name: l.name, updatedAt: l.updatedAt, count: l.windows.length })),
    current: data.current,
  });

  onMessage("layout.list", (ws) => send(ws, summary(load())));

  onMessage("layout.save", (ws, m) => {
    const name = cleanName(m.name);
    if (!name) return sendError(ws, "le nom de la mise en page est obligatoire");
    if (name.length > MAX_NAME) return sendError(ws, `le nom de la mise en page dépasse ${MAX_NAME} caractères`);
    const windows = cleanWindows(m.windows);
    if (!windows) return sendError(ws, "la liste des fenêtres est invalide");
    const data = load();
    const entry = { name, windows, updatedAt: new Date().toISOString() };
    const index = data.layouts.findIndex((l) => l.name === name);
    if (index >= 0) data.layouts[index] = entry;
    else if (data.layouts.length >= MAX_LAYOUTS) return sendError(ws, `maximum ${MAX_LAYOUTS} mises en page`);
    else data.layouts.push(entry);
    store.write(FILE, data);
    send(ws, { type: "layout.saved", name, windows, updatedAt: entry.updatedAt });
    broadcast(summary(data));
  });

  onMessage("layout.load", (ws, m) => {
    const name = cleanName(m.name);
    const entry = load().layouts.find((l) => l.name === name);
    if (!entry) return sendError(ws, "mise en page introuvable");
    send(ws, { type: "layout.loaded", name, windows: entry.windows, updatedAt: entry.updatedAt });
  });

  onMessage("layout.delete", (ws, m) => {
    const name = cleanName(m.name);
    const data = load();
    if (!data.layouts.some((l) => l.name === name)) return sendError(ws, "mise en page introuvable");
    data.layouts = data.layouts.filter((l) => l.name !== name);
    store.write(FILE, data);
    send(ws, { type: "layout.deleted", name });
    broadcast(summary(data));
  });

  // Dernier état du Bureau, restauré à la reconnexion. Pas de réponse.
  onMessage("layout.autosave", (_ws, m) => {
    const windows = cleanWindows(m.windows);
    if (!windows) return;
    const data = load();
    data.current = { windows, updatedAt: new Date().toISOString() };
    store.write(FILE, data);
  });
}
