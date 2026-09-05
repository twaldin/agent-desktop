import { createRoot } from "react-dom/client";
import type { BrowserControlRequest, BrowserControlReceipt, BrowserFrameSnapshot, BrowserFrameTarget, BrowserMetadataSnapshot, DesktopBridge } from "../../packages/shared/src/protocol";
import { BrowserPanel } from "../../apps/desktop/src/renderer/BrowserPanel";
import "../../apps/desktop/src/renderer/styles.css";

declare global {
  interface Window {
    nativePreviewBridge: {
      getBrowserMetadata(sessionId: string, hostId: string): Promise<BrowserMetadataSnapshot | null>;
      getBrowserFrame(sessionId: string, target: BrowserFrameTarget, hostId: string): Promise<BrowserFrameSnapshot>;
      insertText(text: string): Promise<void>;
      key(key: string): Promise<void>;
      controlBrowser(sessionId: string, request: BrowserControlRequest, hostId: string): Promise<BrowserControlReceipt>;
      capture(label: "initial" | "remounted" | "controlled"): Promise<string>;
    };
    runNativeBrowserPreviewAcceptance(): Promise<unknown>;
    nativeBrowserPreviewProgress(): unknown;
  }
}

const params = new URLSearchParams(location.search);
const expected = {
  hostId: params.get("hostId")!, sessionId: params.get("sessionId")!, workerPid: Number(params.get("workerPid")),
  name: params.get("name")!, targetId: params.get("targetId")!, url: params.get("url")!, title: params.get("title")!,
};
const sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const assert = (value: unknown, message: string): asserts value => { if (!value) throw new Error(message); };
async function wait(check: () => unknown, message: string) {
  for (let attempt = 0; attempt < 240; attempt++) { if (check()) return; await sleep(25); }
  throw new Error(`Timed out: ${message}`);
}

const root = createRoot(document.getElementById("root")!);
const checks: string[] = [];
let metadataCalls = 0, frameCalls = 0;
const actions: Array<{type: string; receipt: BrowserControlReceipt}> = [];
let lastMetadata: BrowserMetadataSnapshot | null | undefined, lastFrame: BrowserFrameSnapshot | undefined;
const bridge = {
  controlBrowser: params.get("controls") !== "true" ? undefined : async (sessionId: string, request: BrowserControlRequest, hostId: string) => {
    const receipt = await window.nativePreviewBridge.controlBrowser(sessionId, request, hostId); actions.push({type: request.action.type, receipt}); return receipt;
  },
  getBrowserMetadata: async (sessionId: string, hostId: string) => {
    metadataCalls++; lastMetadata = await window.nativePreviewBridge.getBrowserMetadata(sessionId, hostId); return lastMetadata;
  },
  getBrowserFrame: async (sessionId: string, target: BrowserFrameTarget, hostId: string) => {
    frameCalls++; lastFrame = await window.nativePreviewBridge.getBrowserFrame(sessionId, target, hostId); return lastFrame;
  },
} as DesktopBridge;
const render = (active: boolean) => root.render(<BrowserPanel bridge={bridge} hostId={expected.hostId} sessionId={expected.sessionId} active={active}/>);
const image = () => document.querySelector<HTMLImageElement>(".browser-viewport img");

window.nativeBrowserPreviewProgress = () => ({ checks, metadataCalls, frameCalls, actions, text: document.body.innerText, lastMetadata,
  lastFrame: lastFrame && { ...lastFrame, data: `<${lastFrame.data.length} base64 characters>` } });
window.runNativeBrowserPreviewAcceptance = async () => {
  render(true);
  await wait(() => image()?.complete && image()?.naturalWidth === 640 && image()?.naturalHeight === 480, "actual native JPEG decode");
  assert(lastMetadata?.availability === "running", "Production main transport did not return running metadata");
  assert(lastMetadata.hostId === expected.hostId && lastMetadata.sessionId === expected.sessionId && lastMetadata.workerPid === expected.workerPid, "Metadata owner identity changed");
  const tab = lastMetadata.tabs.find(value => value.name === expected.name);
  assert(tab?.targetId === expected.targetId && tab.url === expected.url, "Metadata native target changed");
  assert(lastFrame?.hostId === expected.hostId && lastFrame.sessionId === expected.sessionId && lastFrame.workerPid === expected.workerPid
    && lastFrame.name === expected.name && lastFrame.targetId === expected.targetId && lastFrame.url === expected.url && lastFrame.title === expected.title,
  "Frame owner or target identity changed");
  assert(lastFrame.width === 640 && lastFrame.height === 480 && lastFrame.data.length > 100, "Frame did not preserve its decoded JPEG dimensions");
  assert(document.querySelector<HTMLInputElement>('[aria-label="Page address"]')?.value === expected.url, "Production panel did not show the actual native URL");
  const initialDigest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(atob(lastFrame.data), character => character.charCodeAt(0))))]
    .map(value => value.toString(16).padStart(2, "0")).join("");
  await window.nativePreviewBridge.capture("initial");
  checks.push("actual worker, authenticated HTTP route, production main transport, and BrowserPanel decoded the exact native JPEG");

  render(false); await sleep(1_250); const hiddenCalls = { metadataCalls, frameCalls };
  await sleep(1_250); assert(metadataCalls === hiddenCalls.metadataCalls && frameCalls === hiddenCalls.frameCalls, "Hidden preview continued polling");
  root.render(null); await sleep(1_250); const unmountedCalls = { metadataCalls, frameCalls };
  await sleep(1_250); assert(metadataCalls === unmountedCalls.metadataCalls && frameCalls === unmountedCalls.frameCalls, "Unmounted preview continued polling");
  checks.push("hidden and unmounted viewers stopped native viewport polling");

  render(true);
  await wait(() => image()?.complete && image()?.naturalWidth === 640 && frameCalls > hiddenCalls.frameCalls, "remounted native JPEG decode");
  assert(lastFrame?.targetId === expected.targetId && lastFrame.url === expected.url, "Remount substituted another native target");
  await window.nativePreviewBridge.capture("remounted");
  checks.push("remount retained selection and rendered the same live native tab");
  if (params.get("controls") === "true") {
    assert(lastFrame?.context && lastFrame.controlEpoch, "Native frame lacks control context/epoch");
    const click = (x: number, y: number) => {
      const img = image()!, rect = img.getBoundingClientRect();
      img.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: rect.left + x * rect.width / 640, clientY: rect.top + y * rect.height / 480 }));
    };
    click(50, 180);
    await wait(() => actions.length === 1, "same-target counter click receipt");
    assert(actions[0]!.receipt.outcome === "completed", "Counter click did not complete");
    await wait(() => !document.body.innerText.includes("Sending browser action"), "counter UI ready");
    await sleep(1200);
    click(440, 100);
    await wait(() => actions.length === 2, "native input focus click receipt");
    assert(actions[1]!.receipt.outcome === "completed", "Input focus did not complete");
    await sleep(200);
    const keyboard = document.querySelector<HTMLTextAreaElement>('[aria-label="Browser page keyboard input"]');
    assert(keyboard, "Direct native keyboard capture is missing"); keyboard.focus();
    await window.nativePreviewBridge.key("End");
    await wait(() => actions.length === 3, "native End key receipt");
    await sleep(100);
    await window.nativePreviewBridge.insertText(" typed through desktop");
    await wait(() => actions.length === 4, "direct text input receipt");
    assert(actions.every(action => action.receipt.outcome === "completed"), "A native input action failed");
    await sleep(1400); await window.nativePreviewBridge.capture("controlled");
    checks.push("production BrowserPanel click, edit key and direct Electron text input reached the same native document");
  }
  root.render(null);
  return { passed: true, checks, expected, metadataCalls, frameCalls, actions, decodedJpeg: { width: 640, height: 480, sha256: initialDigest, base64Characters: lastFrame.data.length },
    captures: ["initial.png", "remounted.png"] };
};
