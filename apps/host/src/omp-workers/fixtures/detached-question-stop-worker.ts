// Hold only the first durable delivery-attempt flush, so a real Stop can
// complete before delivery resumes. All dispatch and journaling remain native.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";

globalThis.fetch = Object.assign(async () => { throw new Error("Outbound fetch disabled in the detached Stop contract"); }, { preconnect: () => {} }) as typeof fetch;
const gates = process.env.DETACHED_QUESTION_GATES;
if (!gates) throw new Error("Detached Stop fixture requires isolated gates");
const originalFlush = SessionManager.prototype.flush;
let held = false;
SessionManager.prototype.flush = async function (...args: Parameters<SessionManager["flush"]>) {
  const result = await originalFlush.apply(this, args);
  if (!held && this.getBranch().some(entry => entry.type === "custom" && entry.customType === "agent-desktop.question-delivery-attempt")) {
    held = true;
    await writeFile(path.join(gates, "attempt.flushed"), "flushed");
    while (!await Bun.file(path.join(gates, "attempt.release")).exists()) await Bun.sleep(5);
  }
  return result;
};
await import("../entry");
