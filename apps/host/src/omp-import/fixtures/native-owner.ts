// Actual native writer used only by the isolated ownership contract.
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileLock } from "@oh-my-pi/pi-natives";
const [sessionFile, mode, lockPath] = process.argv.slice(2);
const lock = mode === "cooperative" ? FileLock.tryAcquire(lockPath!) : undefined;
if (lock && !lock.acquired) { process.send?.({ type: "busy" }); process.exit(2); }
const manager = await SessionManager.open(sessionFile!, undefined, undefined, { suppressBreadcrumb: true });
manager.appendCustomEntry("contract-owner-open", { mode }); await manager.ensureOnDisk();
process.send?.({ type: "ready", id: manager.getSessionId(), file: manager.getSessionFile(), cwd: manager.getCwd() });
let tail = Promise.resolve();
process.on("message", (input: unknown) => {
  const request = input as { id: string; operation: "append" | "release" };
  tail = tail.then(async () => {
    if (request.operation === "append") { manager.appendCustomEntry("contract-external-append", {}); await manager.flush(); process.send?.({ type: "appended", id: request.id }); }
    else { await manager.close(); lock?.release(); process.send?.({ type: "released", id: request.id }); process.exit(0); }
  });
});
