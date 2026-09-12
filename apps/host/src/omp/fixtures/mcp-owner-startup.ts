import { appendFile } from "node:fs/promises";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
/** Disposable native extension: startup itself may need the original host UI
 * before any MCP catalogue or app iframe exists. */
export default function (pi: ExtensionAPI) {
  pi.on("mcp_notification", async event => {
    const file = process.env.MCP_OWNER_NOTIFICATIONS;
    if (file) await appendFile(file, JSON.stringify(event) + "\n");
  });
  pi.on("session_start", async (_event, context) => {
    if (!await context.ui.confirm("Connect directory apps?", `Load native app configuration in ${context.cwd}`)) throw new Error("Native directory app startup was declined.");
  });
}
