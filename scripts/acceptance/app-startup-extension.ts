import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const confirmed = await ctx.ui.confirm("Native startup question", "This isolated extension waits here before dispatching the submitted slash command. No provider is called.");
    pi.appendEntry("renderer-startup-answer", { confirmed });
  });
  pi.registerCommand("renderer-startup-contract", {
    description: "A controlled native command that never calls a provider",
    handler: async () => { pi.appendEntry("renderer-startup-dispatched", { fixture: true }); },
  });
}
