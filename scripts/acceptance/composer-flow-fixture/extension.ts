import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
/** Native registration and dispatch are real; no model/provider is registered. */
export default function(pi: ExtensionAPI) {
  pi.registerCommand("flow-check", { description: "Record one disposable native command", getArgumentCompletions: prefix => {
    if (prefix === "throw") throw new Error("Controlled argument lookup failure");
    return [{ value: "selected " + prefix, label: "Selected native argument", description: "Actual loaded extension callback" }];
  }, handler: async (args, context) => { await appendFile(join(context.cwd, "command-receipts.txt"), args + "\n"); } });
  pi.registerCommand("flow-info", { description: "Second native command for menu navigation", handler: async () => { throw new Error("The navigation-only command must not dispatch."); } });
}
