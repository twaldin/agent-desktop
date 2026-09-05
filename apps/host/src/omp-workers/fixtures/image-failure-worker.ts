// Explicit storage-fault contract: actual native writes still run, but the
// selected manager flush cannot certify them. No live/user store is opened.
import { existsSync } from "node:fs";
import path from "node:path";
globalThis.fetch = Object.assign(async () => { throw new Error("Outbound fetch is disabled in image storage contract"); }, { preconnect: () => {} }) as typeof fetch;
const { SessionManager } = await import("@oh-my-pi/pi-coding-agent/session/session-manager");
const original = SessionManager.prototype.flush;
SessionManager.prototype.flush = async function () {
  await original.call(this);
  if (existsSync(path.join(process.env.IMAGE_CONTRACT_GATES!, "fail-flush"))) throw new Error("Controlled native image storage certification failure");
};
await import("../entry");
