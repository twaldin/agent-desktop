import { createRoot } from "react-dom/client";
import { BrowserPanel } from "../../apps/desktop/src/renderer/BrowserPanel";
import type { BrowserFrameSnapshot, BrowserFrameTarget, DesktopBridge } from "../../packages/shared/src/protocol";
import "../../apps/desktop/src/renderer/styles.css";
import fixtureUrl from "./fixtures/browser-preview.jpg?url";

const root = createRoot(document.getElementById("root")!);
let generation = 1, metadataCalls = 0, frameCalls = 0, inFlight = 0, maximumInFlight = 0;
let fail = false, wrongFrameOwner = false, cmux = false;
let hold: { promise: Promise<void>; resolve(): void; entered: boolean } | undefined;
let data = "";
const checks: string[] = [];
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const assert = (value: unknown, message: string): asserts value => { if (!value) throw new Error(message); };
async function wait(check: () => unknown, description: string) {
  for (let i = 0; i < 200; i++) { if (check()) return; await sleep(25); }
  throw new Error(`Timed out: ${description}`);
}
function holdFrame() {
  const gate = Promise.withResolvers<void>();
  hold = { promise: gate.promise, resolve: () => gate.resolve(), entered: false }; return hold;
}
const bridge = {
  getBrowserMetadata: async (sessionId: string, hostId: string) => {
    metadataCalls++;
    if (fail) throw new Error("Owner offline");
    return { protocolVersion: 1, hostId, sessionId, availability: "running", workerPid: generation,
      tabs: ["one", "two"].map(name => ({ name, targetId: name, backend: cmux ? "cmux" : "worker", kindTag: cmux ? "cmux" : "headless", state: "alive", url: `http://${hostId}/${name}`, title: name, viewport: { width: 800, height: 600 } })) };
  },
  getBrowserFrame: async (sessionId: string, target: BrowserFrameTarget, hostId: string): Promise<BrowserFrameSnapshot> => {
    frameCalls++; inFlight++; maximumInFlight = Math.max(maximumInFlight, inFlight);
    try {
      const gate = hold; if (gate) { hold = undefined; gate.entered = true; await gate.promise; }
      return { protocolVersion: 1, hostId: wrongFrameOwner ? "wrong" : hostId, sessionId, ...target, capturedAt: Date.now(), mimeType: "image/jpeg", data, width: 800, height: 600, url: `http://${hostId}/${target.name}`, title: target.name };
    } finally { inFlight--; }
  },
} as unknown as DesktopBridge;
function render(hostId = "host", active = true, override = bridge) { root.render(<BrowserPanel bridge={override} hostId={hostId} sessionId="session" active={active}/>); }
const caption = () => document.querySelector("figcaption")?.textContent ?? "";
const image = () => document.querySelector<HTMLImageElement>("img");
function button(text: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(value => value.textContent === text);
  assert(found, `Missing button ${text}`); found.click();
}
Object.assign(window, {
  browserPanelProgress: () => ({ checks, metadataCalls, frameCalls, maximumInFlight, text: document.body.innerText }),
  runBrowserPanelAcceptance: async () => {
    const bytes = new Uint8Array(await (await fetch(fixtureUrl)).arrayBuffer());
    data = btoa(String.fromCharCode(...bytes));
    render(); await wait(() => image()?.complete && image()?.naturalWidth === 800, "decoded initial JPEG");
    const selectionGate = holdFrame(); await wait(() => selectionGate.entered, "deferred old selection");
    button("two"); await wait(() => !image(), "selection clears old pixels");
    selectionGate.resolve(); await sleep(150); assert(!image(), "Old selection response painted after selection changed");
    await wait(() => caption() === "two", "new selection frame");
    checks.push("deferred old tab response cannot replace the selected tab; valid JPEG decodes");

    const pauseGate = holdFrame(); await wait(() => pauseGate.entered, "deferred frame before pause");
    button("Pause"); pauseGate.resolve(); const pausedCalls = metadataCalls;
    await sleep(1200); assert(metadataCalls === pausedCalls && caption().includes("stale preview"), "Paused preview kept polling or failed to label retained pixels");
    button("Resume"); await wait(() => caption() === "two", "resume captures again");
    checks.push("pause stops scheduling and ignores in-flight completion; resume refreshes");

    const generationGate = holdFrame(); generation = 2;
    await wait(() => generationGate.entered, "new native worker capture");
    assert(!image(), "Old worker pixels remain during replacement capture");
    generationGate.resolve(); await wait(() => caption() === "one", "new worker selection");
    fail = true; await wait(() => caption().includes("stale preview") && document.body.innerText.includes("Owner offline"), "offline retained frame");
    checks.push("worker replacement clears old pixels; offline retains explicitly stale preview");

    render("host", false); await sleep(100); const hiddenCalls = metadataCalls;
    await sleep(1200); assert(metadataCalls === hiddenCalls, "Hidden dock keeps polling");
    render("other", false); await wait(() => !image(), "owner switch clears old pixels while hidden");
    fail = false; render("other", true); await wait(() => document.querySelector<HTMLInputElement>('[aria-label="Page address"]')?.value.startsWith("http://other/"), "new owner's frame");
    wrongFrameOwner = true; await wait(() => document.body.innerText.includes("different session or tab"), "wrong response owner rejected");
    checks.push("hidden dock stops polling and owner changes discard old pixels; mismatched owner response rejected");

    wrongFrameOwner = false; cmux = true;
    await wait(() => document.body.innerText.includes("does not support viewport previews"), "unsupported native backend explained");
    assert(!image(), "Unsupported backend reused old pixels");
    render("old", true, { getBrowserMetadata: bridge.getBrowserMetadata } as DesktopBridge);
    await wait(() => document.body.innerText.includes("Update this desktop"), "old bridge explanation");
    root.render(null); await sleep(100); const removedCalls = metadataCalls;
    await sleep(1200); assert(metadataCalls === removedCalls, "Unmounted preview kept polling");
    checks.push("unsupported backend and old bridge stay explicit; unmount stops polling");

    cmux = false; render("host", true); await wait(() => image()?.naturalWidth === 800, "final representative frame");
    button("Pause"); assert(maximumInFlight === 1, "Viewport requests overlapped");
    return { passed: true, checks, metadataCalls, frameCalls, maximumInFlight, scope: "Production BrowserPanel with controlled transport and generated JPEG fixture; no native-browser or provider evidence." };
  },
  browserGeometry: async () => {
    await document.fonts.ready; await sleep(100);
    const panel = document.querySelector<HTMLElement>(".browser-panel")!.getBoundingClientRect();
    const viewport = document.querySelector<HTMLElement>(".browser-viewport")!.getBoundingClientRect();
    const img = image()!.getBoundingClientRect();
    return { viewport: { width: innerWidth, height: innerHeight }, panel: panel.toJSON(), image: img.toJSON(),
      fitting: img.width > 0 && img.height > 0 && img.left >= viewport.left - 1 && img.right <= viewport.right + 1 && img.top >= viewport.top - 1 && img.bottom <= viewport.bottom + 1 && panel.right <= innerWidth + 1 && panel.bottom <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth + 1 };
  },
});
