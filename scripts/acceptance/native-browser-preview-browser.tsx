import { useEffect } from "react";
import { DockPanel } from "../../apps/desktop/src/renderer/DockPanel";
import { useWorkbenchDock, type DockSnapshot } from "../../apps/desktop/src/renderer/use-workbench-dock";
import { defaultWindowView, parseDockSnapshot } from "../../apps/desktop/src/window-state";
import type { BrowserCreateRequest, BrowserCreateReceipt } from "../../packages/shared/src/protocol";
import { createRoot } from "react-dom/client";
import type { BrowserControlRequest, BrowserControlReceipt, BrowserFrameSnapshot, BrowserFrameTarget, BrowserMetadataSnapshot, DesktopBridge } from "../../packages/shared/src/protocol";
import { BrowserPanel } from "../../apps/desktop/src/renderer/BrowserPanel";
import "../../apps/desktop/src/renderer/styles.css";

declare global {
  interface Window {
    nativePreviewBridge: {
      createBrowserTab(sessionId: string, request: BrowserCreateRequest, hostId: string): Promise<BrowserCreateReceipt>;
      getBrowserMetadata(sessionId: string, hostId: string): Promise<BrowserMetadataSnapshot | null>;
      getBrowserFrame(sessionId: string, target: BrowserFrameTarget, hostId: string): Promise<BrowserFrameSnapshot>;
      insertText(text: string): Promise<void>;
      key(key: string): Promise<void>;
      controlBrowser(sessionId: string, request: BrowserControlRequest, hostId: string): Promise<BrowserControlReceipt>;
      capture(label: "initial" | "remounted" | "controlled" | "created" | "restored"): Promise<string>;
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
let createCalls = 0, createdTarget: BrowserFrameTarget | undefined;
let dockSnapshot: DockSnapshot | undefined;
const dockErrors: string[] = [];
const bridge = {
  createBrowserTab: async (sessionId: string, request: BrowserCreateRequest, hostId: string) => {
    createCalls++; const receipt = await window.nativePreviewBridge.createBrowserTab(sessionId, request, hostId);
    if (receipt.outcome === "completed") createdTarget = {workerPid: receipt.workerPid, name: receipt.tab.name, targetId: receipt.tab.targetId};
    return receipt;
  },
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
function CreatedDock({ initial }: { initial?: DockSnapshot }) {
  const dock = useWorkbenchDock(bridge, { ...defaultWindowView(), ...(initial ? {dock: initial} : {}) }, expected.hostId, {sessionId: expected.sessionId}, true, message => dockErrors.push(message));
  useEffect(() => { dockSnapshot = dock.snapshot; }, [dock.snapshot]);
  return <div style={{height: "100vh", display: "flex"}}><DockPanel destination="right" state={dock.snapshot.state} tabs={dock.snapshot.tabs} viewport={{width: innerWidth, height: innerHeight}} onChange={dock.change}
    addActions={[{id:"browser",label:"Browser",onSelect:destination => void dock.browser(destination, true)}]}
    renderTab={(tab, active) => <BrowserPanel bridge={bridge} hostId={tab.hostId} sessionId={tab.target.slice(8)} nativeTarget={tab.browserTarget} active={active} onMetadata={metadata => dock.updateBrowserTitle(tab.id, metadata.title || metadata.url || "Browser")}/>}/></div>;
}
const image = () => document.querySelector<HTMLImageElement>(".browser-viewport img");

window.nativeBrowserPreviewProgress = () => ({ checks, metadataCalls, frameCalls, actions, createCalls, createdTarget, dockErrors, dockSnapshot, text: document.body.innerText, lastMetadata,
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
  root.render(null); await sleep(100);
  if (params.get("create") === "true") {
    root.render(<CreatedDock/>);
    await wait(() => document.querySelector('[aria-label="Add panel tab"]'), "browser add menu");
    (document.querySelector('[aria-label="Add panel tab"]') as HTMLElement).click();
    const createButton = [...document.querySelectorAll<HTMLButtonElement>(".dock-add button")].find(button => button.textContent === "Browser");
    assert(createButton, "Dock browser action missing"); createButton.click();
    await wait(() => createdTarget && dockSnapshot?.tabs.length === 1 && image()?.naturalWidth, "native created dock page");
    assert(createCalls === 1 && dockErrors.length === 0, `Unexpected native creation outcome: ${dockErrors.join("; ")}`);
    assert(!document.querySelector(".browser-tabs"), "Native target has a duplicate nested tab selector");
    const created = dockSnapshot!.tabs[0]!;
    assert(JSON.stringify(created.browserTarget) === JSON.stringify(createdTarget), "Dock did not bind the receipt's exact native identity");
    const address = document.querySelector<HTMLInputElement>('[aria-label="Page address"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(address, expected.url.replace("/page", "/second"));
    address.dispatchEvent(new Event("input", {bubbles: true})); await sleep(50);
    address.form!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true}));
    await wait(() => lastFrame?.targetId === createdTarget!.targetId && lastFrame.url.endsWith("/second") && dockSnapshot?.tabs[0]?.title === "Actual native preview", "same native created page navigation and dock title");
    await window.nativePreviewBridge.capture("created");
    const persisted = parseDockSnapshot(JSON.parse(JSON.stringify(dockSnapshot)));
    assert(persisted, "Created target dock cannot be persisted");
    (document.querySelector(".dock-tab-close") as HTMLButtonElement).click();
    await wait(() => dockSnapshot?.tabs.length === 0 && !image(), "closing the created viewer");
    const stillAlive = await bridge.getBrowserMetadata!(expected.sessionId, expected.hostId);
    assert(stillAlive?.availability === "running" && stillAlive.tabs.some(tab => tab.targetId === createdTarget!.targetId), "Closing viewer closed its native page");
    root.render(null); await sleep(100); root.render(<CreatedDock initial={persisted}/>);
    await wait(() => image()?.naturalWidth && lastFrame?.targetId === createdTarget!.targetId && lastFrame.url.endsWith("/second"), "restored exact native page");
    assert(createCalls === 1, "Restoring viewer created a replacement browser page");
    await window.nativePreviewBridge.capture("restored");
    checks.push("Dock Browser menu created one native page, navigated it, updated its title, closed only the viewer, and restored the exact persisted target");
    root.render(null); await sleep(100);
  }
  return { passed: true, checks, expected, metadataCalls, frameCalls, actions, createCalls, createdTarget, decodedJpeg: { width: 640, height: 480, sha256: initialDigest, base64Characters: lastFrame.data.length },
    captures: params.get("create") === "true" ? ["initial.png", "remounted.png", "controlled.png", "created.png", "restored.png"] : params.get("controls") === "true" ? ["initial.png", "remounted.png", "controlled.png"] : ["initial.png", "remounted.png"] };
};
