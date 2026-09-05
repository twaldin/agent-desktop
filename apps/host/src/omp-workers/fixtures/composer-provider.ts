// Test-only callback/provider transport. The native skill builder, agent,
// normalization, events, filesystem and session persistence all remain real.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { writeFileSync } from "node:fs";
import path from "node:path";
import imageProvider from "./image-provider";
export default function(pi: ExtensionAPI) {
  const gates = process.env.IMAGE_CONTRACT_GATES!;
  if (!gates) throw new Error("Composer fixture requires isolated gates");
  writeFileSync(path.join(gates, "factory-ran"), "native registration executed");
  imageProvider(pi);
  pi.registerCommand("compose-test", { description: "Native completion callback fixture", getArgumentCompletions: prefix => {
    if (prefix === "throw") throw new Error("Controlled completion exception");
    return [{ value: `chosen ${prefix}`, label: "Native chosen argument", description: "Actual callback result" }];
  }, handler: async args => { writeFileSync(path.join(gates, "executed"), args); } });
  pi.registerCommand("effect-throw", { description: "Native side effect then exception", handler: async () => {
    writeFileSync(path.join(gates, "effect"), "actual effect"); throw new Error("Controlled post-effect failure");
  } });
  pi.registerCommand("jobs", { description: "Native collision fixture", handler: async () => { writeFileSync(path.join(gates, "jobs"), "extension wins"); } });
  pi.registerCommand("jobs:detail", { description: "Native namespaced fixture", handler: async () => {} });
}
