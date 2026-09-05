// Fault injection around real production worker IPC, never provider output.
// The native apply completes, then this disposable worker loses its receipt.
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildMessage, ParentMessage } from "../protocol";
globalThis.fetch = Object.assign(async () => { throw new Error("Provider fetch forbidden in permission contract"); }, { preconnect: () => {} }) as typeof fetch;
let loseId: string | undefined;
const marker = join(process.env.PI_CODING_AGENT_DIR!, "lose-permission-receipt");
process.on("message", (message: ParentMessage) => {
  if (message.type === "request" && message.operation === "setApprovalOverride" && existsSync(marker)) {
    unlinkSync(marker); loseId = message.id;
  }
});
const send = process.send!.bind(process);
process.send = ((message: ChildMessage, ...args: unknown[]) => {
  if (message.type === "response" && message.id === loseId && message.ok) {
    writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "applied-before-lost-receipt.json"), JSON.stringify({ pid: process.pid, value: message.value }));
    process.exit(0);
  }
  return (send as (...args: unknown[]) => unknown)(message, ...args);
}) as typeof process.send;
await import("../entry");
