import path from "node:path";
const { SessionManager } = await import(path.join(process.env.OWNERSHIP_NATIVE_PACKAGE!, "src/session/session-manager.ts"));
const [file] = process.argv.slice(2);
let manager;
try {
  manager = await SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true });
  process.send?.({ type: "ready", id: manager.getSessionId(), file: manager.getSessionFile() });
} catch (error) { process.send?.({ type: "rejected", message: String(error) }); process.exit(73); }
process.on("message", async (request: any) => {
  try {
    if (request.type === "append") { manager.appendCustomEntry("isolated-owner-append", {}); await manager.flush(); process.send?.({ type: "appended" }); }
    if (request.type === "close") { await manager.close(); process.send?.({ type: "closed" }); process.exit(0); }
  } catch (error) { process.send?.({ type: "error", message: String(error) }); }
});
