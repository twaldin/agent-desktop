import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

async function pageState(name: string) {
  const supervisor = await import("@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor");
  const tab = supervisor.getTab(name);
  if (!tab || tab.backend !== "worker") throw new Error("Native browser contract tab is unavailable");
  const target = tab.browser.browser.targets().find(candidate => (candidate as unknown as { _targetId?: string })._targetId === tab.targetId);
  const page = await target?.page();
  if (!page) throw new Error("Native browser contract page is unavailable");
  return { url: page.url(), title: await page.title(), viewport: page.viewport(), state: await page.evaluate(() => (globalThis as unknown as { browserFrameState?: unknown }).browserFrameState) };
}

export default function (pi: ExtensionAPI) {
  const name = "native-frame-proof";
  pi.registerCommand("open-browser-frame-contract", {
    description: "Open the isolated native browser frame fixture",
    handler: async (_args, ctx) => {
      const url = process.env.BROWSER_FRAME_TEST_URL;
      if (!url) throw new Error("Browser frame fixture URL is missing");
      const { acquireBrowser } = await import("@oh-my-pi/pi-coding-agent/tools/browser/registry");
      const { acquireTab } = await import("@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor");
      const viewport = { width: 640, height: 480, deviceScaleFactor: 1 };
      const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: ctx.cwd, viewport });
      await acquireTab(name, browser, { url, viewport, timeoutMs: 30_000, ownerSessionId: ctx.sessionManager.getSessionId() });
      pi.appendEntry("browser-frame-contract-state", { phase: "before", ...(await pageState(name)) });
    },
  });
  pi.registerCommand("inspect-browser-frame-contract", {
    description: "Record the isolated native browser state after capture",
    handler: async (args) => { pi.appendEntry("browser-frame-contract-state", { phase: "after", ...(await pageState(args.trim() || name)) }); },
  });
}
