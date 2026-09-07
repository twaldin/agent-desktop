// Isolated native-worker boundary for authenticated HTTP tests. No provider HTTP.
import path from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import type { ChildMessage, ParentMessage } from "../omp-workers/protocol";
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TERM: "dumb", PI_DISABLE_DOTENV: "1" });
globalThis.fetch = Object.assign(async () => { throw new Error("Outbound fetch disabled in selected-text HTTP fixture"); }, { preconnect: () => {} }) as typeof fetch;
process.on("message", (message: ParentMessage) => {
  if (message.type === "request" && message.operation === "init" && message.args.agentDir) {
    const root = path.dirname(message.args.agentDir);
    Object.assign(process.env, { HOME: root, TMPDIR: root, PI_CODING_AGENT_DIR: message.args.agentDir,
      XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data-home"),
      SELECTED_TEXT_CONTRACT_GATES: path.join(message.args.agentDir, "gates") });
  }
});
const send = process.send!.bind(process);
process.send = ((message: ChildMessage, ...args: unknown[]) => {
  const gates = process.env.SELECTED_TEXT_CONTRACT_GATES;
  if (message.type === "response" && message.phase === "accepted" && message.ok && gates && existsSync(path.join(gates, "lose-receipt"))) {
    writeFileSync(path.join(gates, "receipt-lost.json"), JSON.stringify(message.value));
    process.exit(0);
  }
  return (send as (...args: unknown[]) => unknown)(message, ...args);
}) as typeof process.send;
await import("../omp-workers/entry");
