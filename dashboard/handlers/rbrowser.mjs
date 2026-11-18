// Navigateur distant (vue « Navigateur »). Messages : rbrowser.status ; rbrowser.start {confirm:true} ; rbrowser.stop ;
// rbrowser.watch / rbrowser.unwatch (abonnement aux images) ; rbrowser.nav {url} ; rbrowser.back / rbrowser.forward ;
// rbrowser.input {kind: mouse|wheel|key, …} ; rbrowser.copy -> rbrowser.selection {text} ; rbrowser.paste {text}.
// Diffusions : rbrowser.state, rbrowser.frame {data (jpeg base64), width, height} aux seuls abonnés. Voir lib/rbrowser.mjs.
import { createRemoteBrowser } from "../lib/rbrowser.mjs";

export function register(ctx) {
  const watchers = new Set();
  const rb = createRemoteBrowser({
    log: ctx.log,
    onChange: () => ctx.broadcast({ type: "rbrowser.state", ...rb.status() }),
    onFrame: (frame) => { for (const ws of watchers) ctx.send(ws, { type: "rbrowser.frame", ...frame }); },
  });
  const state = () => ({ type: "rbrowser.state", ...rb.status() });
  const guard = (fn) => async (ws, m) => { try { await fn(ws, m); } catch (e) { ctx.sendError(ws, ctx.safeError(e)); } };
  ctx.onMessage("rbrowser.status", (ws, m) => ctx.send(ws, { ...state(), ref: m.ref ?? null }));
  ctx.onMessage("rbrowser.start", guard(async (ws, m) => {
    if (m.confirm !== true) throw new Error("Confirmation requise (confirm: true).");
    await rb.start(); ctx.broadcast(state());
  }));
  ctx.onMessage("rbrowser.stop", guard(async () => { rb.stop(); watchers.clear(); ctx.broadcast(state()); }));
  ctx.onMessage("rbrowser.watch", (ws) => { watchers.add(ws); });
  ctx.onMessage("rbrowser.unwatch", (ws) => { watchers.delete(ws); });
  ctx.onDisconnect?.((ws) => watchers.delete(ws));
  ctx.onMessage("rbrowser.nav", guard(async (ws, m) => { await rb.navigate(m.url); ctx.broadcast(state()); }));
  ctx.onMessage("rbrowser.newTab", guard(async (ws, m) => { await rb.openTab(m.url || "about:blank"); }));
  ctx.onMessage("rbrowser.switchTab", guard(async (ws, m) => { await rb.switchTab(String(m.id)); }));
  ctx.onMessage("rbrowser.closeTab", guard(async (ws, m) => { await rb.closeTab(String(m.id)); }));
  ctx.onMessage("rbrowser.back", guard(() => rb.history("back")));
  ctx.onMessage("rbrowser.forward", guard(() => rb.history("forward")));
  ctx.onMessage("rbrowser.input", guard(async (ws, m) => { await rb.input(m); }));
  ctx.onMessage("rbrowser.copy", guard(async (ws, m) => ctx.send(ws, { type: "rbrowser.selection", text: await rb.getSelection(), ref: m.ref ?? null })));
  ctx.onMessage("rbrowser.paste", guard(async (ws, m) => { await rb.paste(m.text); }));
  return () => rb.stop();
}
