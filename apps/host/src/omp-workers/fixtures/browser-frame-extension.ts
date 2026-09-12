import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Target } from "puppeteer-core";

async function targetId(target: Target) {
  const raw = target as unknown as { _targetId?: unknown };
  if (typeof raw._targetId === "string") return raw._targetId;
  const session = await target.createCDPSession();
  try { return ((await session.send("Target.getTargetInfo")) as { targetInfo?: { targetId?: string } }).targetInfo?.targetId; }
  finally { await session.detach().catch(() => undefined); }
}

async function pageState(name: string) {
  const supervisor = await import("@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor");
  const tab = supervisor.getTab(name);
  if (!tab || tab.backend !== "worker") throw new Error("Native browser contract tab is unavailable");
  let target: Target | undefined;
  for (const candidate of tab.browser.browser.targets()) if (await targetId(candidate) === tab.targetId) { target = candidate; break; }
  const page = await target?.page();
  if (!page) throw new Error("Native browser contract page is unavailable");
  return { url: page.url(), title: await page.title(), viewport: page.viewport(), state: await page.evaluate(() => (globalThis as unknown as { browserFrameState?: unknown }).browserFrameState) };
}

export default function (pi: ExtensionAPI) {
  const name = "native-frame-proof";
  let restoreScreenshot: (() => void) | undefined;
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
  pi.registerCommand("navigate-during-frame-contract", {
    description: "Schedule real navigation at the next native screenshot boundary",
    handler: async args => {
      const repeat = args.trim() === "repeat";
      if (args.trim() && !repeat) throw new Error("Unknown frame transition fixture mode");
      restoreScreenshot?.();
      const { getTab } = await import("@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor");
      const tab = getTab(name);
      if (!tab || tab.backend !== "worker") throw new Error("Native browser contract tab is unavailable");
      let target: Target | undefined;
      for (const candidate of tab.browser.browser.targets()) if (await targetId(candidate) === tab.targetId) { target = candidate; break; }
      const page = await target?.page();
      if (!page) throw new Error("Native browser contract page is unavailable");
      const destination = new URL("/page2", process.env.BROWSER_FRAME_TEST_URL).href;
      const screenshot = page.screenshot.bind(page);
      restoreScreenshot = () => { page.screenshot = screenshot; restoreScreenshot = undefined; };
      // Schedule a real browser transition after the capture's first context read.
      // No context, screenshot bytes, or exception is fabricated. Restore before
      // navigation so any read-only retry takes an ordinary Chromium screenshot.
      page.screenshot = (async options => {
        if (!repeat) restoreScreenshot?.();
        await page.goto(destination, { waitUntil: "domcontentloaded" });
        pi.appendEntry("browser-frame-contract-navigation", { url: page.url(), targetId: tab.targetId });
        return screenshot(options);
      }) as typeof page.screenshot;
    },
  });
  pi.registerCommand("stop-frame-transition-contract", {
    description: "Restore the real screenshot method after the transition fixture",
    handler: async () => { restoreScreenshot?.(); },
  });
}
