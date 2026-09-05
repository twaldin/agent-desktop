// Isolated HTTP fixture using production worker IPC. Configure the private
// profile before entry's deferred SDK import; outbound provider HTTP is denied.
import path from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import type { ChildMessage, ParentMessage } from "../omp-workers/protocol";
globalThis.fetch = Object.assign(async () => { throw new Error("Outbound provider fetch is disabled in native image HTTP contract"); }, { preconnect: () => {} }) as typeof fetch;
process.on("message", (message: ParentMessage) => {
  if (message.type === "request" && message.operation === "init" && message.args.agentDir) {
    const root = path.dirname(message.args.agentDir);
    process.env.HOME = root;
    process.env.XDG_CONFIG_HOME = path.join(root, "config");
    process.env.XDG_DATA_HOME = path.join(root, "data-home");
    process.env.IMAGE_CONTRACT_GATES = path.join(message.args.agentDir, "image-gates");
  }
});
const send = process.send!.bind(process);
process.send = ((message: ChildMessage, ...args: unknown[]) => {
  if (message.type === "response" && message.phase === "accepted" && message.ok && process.env.IMAGE_CONTRACT_GATES
    && existsSync(path.join(process.env.IMAGE_CONTRACT_GATES, "lose-receipt"))) {
    writeFileSync(path.join(process.env.IMAGE_CONTRACT_GATES, "receipt-lost.json"), JSON.stringify({ receipt: message.value }));
    process.exit(0);
  }
  return (send as (...args: unknown[]) => unknown)(message, ...args);
}) as typeof process.send;
await import("../omp-workers/entry");
