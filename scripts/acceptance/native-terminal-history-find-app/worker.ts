import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.env.HOME;
if (!root || !existsSync(join(root, "fixture-owner.json")) || process.env.PI_CODING_AGENT_DIR !== join(root, "agent")) throw new Error("Owned native Find worker profile required.");
const reject = (kind: string) => {
  appendFileSync(join(root, "guard-violations.jsonl"), JSON.stringify({ kind, pid: process.pid, at: Date.now() }) + "\n", { mode: 0o600 });
  throw new Error("Network/provider activity is forbidden in native history Find acceptance.");
};
globalThis.fetch = Object.assign(async () => reject("worker-fetch"), { preconnect: () => reject("worker-preconnect") }) as typeof fetch;
const { ModelRegistry } = await import("@oh-my-pi/pi-coding-agent");
const originalRefresh = ModelRegistry.prototype.refresh;
type Registry = InstanceType<typeof ModelRegistry>;
ModelRegistry.prototype.refresh = function(this: Registry, strategy: Parameters<Registry["refresh"]>[0]) {
  appendFileSync(join(root, "native-offline-discovery.jsonl"), JSON.stringify({ pid: process.pid, requested: strategy, effective: "offline", at: Date.now() }) + "\n", { mode: 0o600 });
  return originalRefresh.call(this, "offline");
};
// Real worker/SDK entry; only the documented native discovery strategy is controlled.
await import("../../../apps/host/src/omp-workers/entry");
