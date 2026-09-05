// Explicit extension contract fixture. It never performs a provider call.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerCommand("bridge-contract", {
    description: "Exercise actual native extension callbacks without inference",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) throw new Error("Native extension was not bound to the actual bridge");
      const selected = await ctx.ui.select("Contract select", ["First", { label: "Second", description: "Native option" }]);
      const confirmed = await ctx.ui.confirm("Contract confirm", "No default approval");
      const input = await ctx.ui.input("Contract input", "Text");
      const edited = await ctx.ui.editor("Contract editor", "Original text");
      pi.appendEntry("bridge-contract-result", { selected, confirmed, input, edited });
      ctx.ui.notify("Native extension contract completed", "info");
    },
  });
}
