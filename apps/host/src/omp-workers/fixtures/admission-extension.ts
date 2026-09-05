// Native extension used only by isolated admission contracts; no provider work.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerCommand("admission-contract", {
    description: "Record a labelled native command side effect for the admission contract",
    handler: async (args, ctx) => {
      if (args === "throw-before") throw new Error("Admission contract failed before side effect");
      if (args === "wait" && !(await ctx.ui.confirm("Admission contract", "Perform the labelled side effect?"))) return;
      if (args === "rename") await pi.setSessionName("Native command title");
      pi.appendEntry("admission-contract", { args });
      if (args === "throw-after") throw new Error("Admission contract failed after side effect");
    },
  });
}
