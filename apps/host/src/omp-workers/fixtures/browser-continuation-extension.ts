import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("inspect-retained-browser-contract", {
    description: "Inspect the retained browser through the production native run path",
    handler: async (args, ctx) => {
      const name=args.trim(); if(!name)throw new Error("Retained browser name is required");
      const {runInTab}=await import("@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor");
      const session={cwd:ctx.cwd,hasUI:false,settings:{get:()=>undefined},getActiveModel:()=>undefined} as unknown as ToolSession;
      const result=await runInTab(name,{code:"return await page.evaluate(() => ({url: location.href, title: document.title, state: globalThis.browserFrameState, cookie: document.cookie}))",timeoutMs:15_000,session});
      pi.appendEntry("browser-continuation-contract",result.returnValue);
    },
  });
}
