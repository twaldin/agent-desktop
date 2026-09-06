// Test-only worker: pause after the native accepted entry is actually flushed,
// allowing the parent to prove that loss of the IPC response is outcome-unknown.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";

globalThis.fetch = Object.assign(
  async () => { throw new Error("Outbound fetch is disabled in the detached-question crash contract"); },
  { preconnect: () => {} },
) as typeof fetch;

const gates = process.env.DETACHED_QUESTION_GATES;
if (!gates) throw new Error("Detached question crash fixture requires its isolated gate directory");
const originalFlush = SessionManager.prototype.flush;
SessionManager.prototype.flush = async function (...args: Parameters<SessionManager["flush"]>) {
  const result = await originalFlush.apply(this, args);
  const accepted = this.getBranch().some(entry => entry.type === "custom" && entry.customType === "agent-desktop.question-accepted");
  if (accepted && !await Bun.file(path.join(gates, "acceptance.flushed")).exists()) {
    await writeFile(path.join(gates, "acceptance.flushed"), "flushed");
    await new Promise<never>(() => {});
  }
  return result;
};

await import("../entry");
