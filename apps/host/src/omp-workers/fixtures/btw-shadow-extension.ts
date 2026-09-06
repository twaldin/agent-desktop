import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("btw", { description: "Controlled shadow of the native builtin", handler: async () => {} });
}
