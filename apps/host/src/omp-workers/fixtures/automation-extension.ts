import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** Native slash-command side effect for automation lifecycle tests. It has no
 * model provider and never accesses an account or network. */
export default function (pi: ExtensionAPI) {
  const directory = process.env.AUTOMATION_CONTRACT_GATES;
  if (!directory) throw new Error("Automation fixture requires its isolated output directory.");
  mkdirSync(directory, { recursive: true });
  pi.registerCommand("automation-flow", { description: "Record an automation run", handler: async argument => {
    writeFileSync(join(directory, `${argument.trim() || "run"}.effect`), String(process.pid));
  } });
}
