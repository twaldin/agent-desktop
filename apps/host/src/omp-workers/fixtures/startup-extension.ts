// The production host must return native identity before this callback waits.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    await ctx.ui.confirm("Contract startup", "Wait for a real response before allowing the submitted command");
  });
  pi.registerCommand("startup-contract", {
    description: "Record only if a submitted command is actually dispatched",
    handler: async () => { pi.appendEntry("startup-command-dispatched", { fixture: true }); },
  });
}
