import { createRoot } from "react-dom/client";
import { BrowserPanel } from "../../apps/desktop/src/renderer/BrowserPanel";
import type {
  BrowserControlRequest,
  BrowserFrameSnapshot,
  BrowserFrameTarget,
  DesktopBridge,
} from "../../packages/shared/src/protocol";
import "../../apps/desktop/src/renderer/styles.css";
import fixtureUrl from "./fixtures/browser-preview.jpg?url";

const root = createRoot(document.getElementById("root")!);
const checks: string[] = [];
const requests: BrowserControlRequest[] = [];
const fitRequests: BrowserControlRequest[] = [];
const humanRequests: BrowserControlRequest[] = [];
const external: string[] = [];
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const assert = (value: unknown, message: string): asserts value => {
  if (!value) throw new Error(message);
};
async function wait(check: () => unknown, description: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error(`Timed out: ${description}`);
}
let data = "";
let first = Promise.withResolvers<void>();
let second = Promise.withResolvers<void>();
let initialFrame = Promise.withResolvers<void>();
let initialFrameRequested = false;
let humanControls = 0;
let framesReturned = 0;
const target = { workerPid: 42, name: "native", targetId: "tab" };
const context = (documentId: string) => ({
  documentId,
  width: 800,
  height: 600,
  scrollX: 0,
  scrollY: 0,
  navigation: { entryId: 1, canGoBack: false, canGoForward: true },
});
let currentContext = context("doc-1");
let capturedAt = 101;
const bridge: DesktopBridge = {
  openExternal: async url => { external.push(url); },
  getBrowserMetadata: async (sessionId, hostId) => ({
    protocolVersion: 1,
    hostId,
    sessionId,
    availability: "running",
    workerPid: target.workerPid,
    tabs: [
      {
        ...target,
        backend: "worker",
        kindTag: "headless",
        state: "alive",
        title: "Control target",
        url: "https://example.test/",
        viewport: { width: 800, height: 600 },
      },
    ],
  }),
  getBrowserFrame: async (
    sessionId: string,
    frameTarget: BrowserFrameTarget,
    hostId: string,
  ): Promise<BrowserFrameSnapshot> => {
    if (!initialFrameRequested) { initialFrameRequested = true; await initialFrame.promise; }
    framesReturned++;
    return {
      protocolVersion: 1,
      hostId,
      sessionId,
      ...frameTarget,
      capturedAt: capturedAt++,
      controlEpoch: "epoch-1",
      context: currentContext,
      mimeType: "image/jpeg",
      data,
      width: currentContext.width,
      height: currentContext.height,
      url: "https://example.test/",
      title: "Control target",
    };
  },
  controlBrowser: async (_sessionId, request, hostId) => {
    requests.push(request);
    if (request.action.type === "resize") {
      fitRequests.push(request);
      currentContext = { ...currentContext, width: request.action.width, height: request.action.height };
      return {
        protocolVersion: 1, hostId, sessionId: "session", requestId: request.requestId, ...target,
        outcome: "completed", url: "https://example.test/", title: "Control target", context: currentContext,
      };
    }
    humanRequests.push(request);
    humanControls++;
    if (humanControls === 1) {
      await first.promise;
      currentContext = { ...currentContext, documentId: "doc-2" };
      return {
        protocolVersion: 1,
        hostId,
        sessionId: "session",
        requestId: request.requestId,
        ...target,
        outcome: "completed", url: "https://example.test/", title: "Control target",
        context: currentContext,
      };
    }
    if (humanControls === 2) {
      await second.promise;
      return {
        protocolVersion: 1,
        hostId,
        sessionId: "session",
        requestId: request.requestId,
        ...target,
        outcome: "unknown",
        message: "Native acknowledgement was lost.",
      };
    }
    currentContext = { ...currentContext, documentId: "doc-3" };
    return {
      protocolVersion: 1,
      hostId,
      sessionId: "session",
      requestId: request.requestId,
      ...target,
      outcome: "completed", url: "https://example.test/", title: "Control target",
      context: currentContext,
    };
  },
};
function input(data: string) {
  const field = document.querySelector<HTMLTextAreaElement>(
    ".browser-input-capture",
  );
  assert(field, "Missing focused browser text capture");
  field.dispatchEvent(
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      data,
      inputType: "insertText",
    }),
  );
}
Object.assign(window, {
  browserControlsProgress: () => ({
    checks,
    requests: requests.map((request) => ({
      action: request.action,
      context: request.context,
    })),
    fitRequests: fitRequests.map(request => request.action),
    humanRequests: humanRequests.map(request => request.action),
    text: document.body.innerText,
    address: (() => { const input = document.querySelector<HTMLInputElement>('[aria-label="Page address"]'); return {value: input?.value, start: input?.selectionStart, end: input?.selectionEnd, active: document.activeElement?.tagName, documentFocused: document.hasFocus()}; })(),
    retained: document.querySelector<HTMLTextAreaElement>('[aria-label="Unsent browser input"]')?.value,
  }),
  browserControlsStart: async () => {
    const bytes = new Uint8Array(await (await fetch(fixtureUrl)).arrayBuffer());
    data = btoa(String.fromCharCode(...bytes));
    root.render(<BrowserPanel bridge={bridge} hostId="host" sessionId="session" active={false} />);
    await sleep(300);
    assert(requests.length === 0 && !initialFrameRequested, "Inactive panel attempted initial fit or frame capture");
    root.render(<BrowserPanel bridge={bridge} hostId="host" sessionId="session" active />);
    await wait(() => initialFrameRequested, "initial frame request");
    assert(requests.length === 0, "Fit began before its owned frame completed");
    initialFrame.resolve();
    await wait(
      () => document.querySelector("img")?.naturalWidth === 800,
      "initial live frame",
    );
    await wait(() => fitRequests.length === 1, "initial automatic fit");
    const measured = document.querySelector<HTMLElement>(".browser-viewport")!.getBoundingClientRect();
    assert(fitRequests[0].target.targetId === target.targetId && fitRequests[0].controlEpoch === "epoch-1", "Initial fit lost frame ownership");
    assert(fitRequests[0].action.type === "resize" && fitRequests[0].action.width === Math.floor(measured.width) && fitRequests[0].action.height === Math.floor(measured.height), "Initial fit ignored the measured panel viewport");
    checks.push("initial automatic fit waits for an active owned frame and sends its measured viewport once");
    const address = document.querySelector<HTMLInputElement>('[aria-label="Page address"]')!;
    assert(address.value === 'example.test', 'Idle HTTPS address should show only the host');
    assert(document.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.disabled, 'Back ignored native empty history');
    assert(!document.querySelector<HTMLButtonElement>('[aria-label="Forward"]')!.disabled, 'Forward ignored available native history');
    const row = document.querySelector('.browser-controls')!.getBoundingClientRect();
    const reload = document.querySelector('[aria-label="Reload page"]')!.getBoundingClientRect();
    assert(row.height === 34 && reload.width === 28 && reload.height === 28, 'Browser toolbar is not 34pt with 28pt controls');
    address.focus();
    await wait(() => address.value === 'https://example.test/' && address.selectionStart === 0 && address.selectionEnd === address.value.length, 'focused full URL selected');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(address, "discard this query");
    address.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(30);
    address.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(() => address.value === 'example.test', 'Escape restored native address');
    assert(humanRequests.length === 0, 'Escape navigated the native page');
    document.querySelector<HTMLButtonElement>('[aria-label="Open in external browser"]')!.click();
    await wait(() => external.length === 1, 'external open');
    assert(external[0] === 'https://example.test/', 'External open used a shortened display label');
    const options = document.querySelector<HTMLDetailsElement>('.browser-options')!;
    const summary = options.querySelector('summary')!;
    summary.click();
    assert(options.open, 'Options did not open');
    const refresh = options.querySelector<HTMLButtonElement>('[aria-label="Refresh browser preview"]')!;
    refresh.focus();
    refresh.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert(document.activeElement?.textContent === 'Pause', 'Menu arrow navigation did not move focus');
    options.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert(!options.open && document.activeElement === summary, 'Escape did not close menu and restore focus');
    summary.click();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    assert(!options.open, 'Outside pointer did not close options');
    checks.push('compact toolbar geometry, native history button state, full URL focus/escape, exact external address, options keyboard and dismissal');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(address, "https://draft.example.test/");
    address.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(1300); assert(address.value === "https://draft.example.test/", "polling overwrote the address draft");
    checks.push("address draft survives a native preview refresh");
    document
      .querySelector<HTMLTextAreaElement>(".browser-input-capture")!
      .focus();
  },
  browserControlsReleaseFirst: async () => {
    await wait(() => humanRequests.length === 1, "first text request");
    assert(
      humanRequests.length === 1,
      "typing started a concurrent browser control",
    );
    first.resolve();
    await wait(() => humanRequests.length === 2, "serialized second text request");
    assert(
      humanRequests[1].context.documentId === "doc-2",
      "queued text ignored the completed receipt context",
    );
  },
  browserControlsFinish: async () => {
    await sleep(100);
    assert(humanRequests.length === 2, "pending edit key bypassed the serial queue");
    second.resolve();
    await wait(
      () =>
        document.body.innerText.includes("Native acknowledgement was lost."),
      "unknown action result",
    );
    assert(humanRequests.length === 2, "unknown action was retried");
    assert(
      document.querySelector<HTMLTextAreaElement>('[aria-label="Unsent browser input"]')?.value === "[Backspace]d",
      `unsent queued text was not retained visibly: ${document.querySelector<HTMLTextAreaElement>('[aria-label="Unsent browser input"]')?.value}`,
    );
    checks.push(
      "text is serialized through receipt context; unknown actions are not replayed and leave queued input visible",
    );
    await sleep(1300);
    assert(humanRequests.length === 2, "polling replayed unknown or queued actions");
    assert(document.querySelector<HTMLButtonElement>('[aria-label="Reload page"]')?.disabled, "unknown outcome silently cleared");
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Discard unsent input")!.click();
    await wait(
      () =>
        document.querySelector<HTMLButtonElement>('[aria-label="Reload page"]')
          ?.disabled === false,
      "fresh controls after unknown result",
    );
    document
      .querySelector<HTMLButtonElement>('[aria-label="Reload page"]')!
      .click();
    await wait(
      () => humanRequests.length === 3 && humanRequests[2].action.type === "reload",
      "reload control request",
    );
    assert(
      humanRequests[2].target.targetId === "tab" &&
        humanRequests[2].controlEpoch === "epoch-1",
      "reload request lost target or epoch",
    );
    checks.push(
      "native control buttons send the current owner target and epoch",
    );
    return { passed: true, checks, requests: requests.length, humanRequests: humanRequests.length, initialFit: fitRequests[0].action };
  },
  browserControlsExternalViewport: async () => {
    const before = fitRequests.length;
    const returned = framesReturned;
    currentContext = { ...currentContext, width: currentContext.width + 37, height: currentContext.height + 29 };
    await wait(() => framesReturned > returned, "external viewport context refresh");
    await sleep(300);
    assert(fitRequests.length === before, "External native viewport context caused a resize fight");
    checks.push("external native viewport context changes do not trigger automatic resize");
    return before;
  },
  browserControlsWaitForFit: async (before: number) => {
    await wait(() => fitRequests.length === before + 1, "panel geometry automatic fit");
    await sleep(300);
    assert(fitRequests.length === before + 1, "One panel geometry change sent repeated fits");
    const measured = document.querySelector<HTMLElement>(".browser-viewport")!.getBoundingClientRect();
    const action = fitRequests.at(-1)!.action;
    assert(action.type === "resize" && action.width === Math.floor(measured.width) && action.height === Math.floor(measured.height), "Geometry fit did not use the measured viewport");
    checks.push("one actual panel geometry change sends one measured automatic fit");
    return fitRequests.length;
  },
  browserControlsOpenFitOptions: () => {
    const options = document.querySelector<HTMLDetailsElement>(".browser-options")!;
    options.querySelector<HTMLElement>("summary")!.click();
    const fit = [...options.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Fit page to panel")!;
    assert(options.open && fit.getAttribute("aria-checked") === "true", "Fit option was not enabled and visible");
  },
  browserControlsDisableFit: async () => {
    const options = document.querySelector<HTMLDetailsElement>(".browser-options")!;
    if (!options.open) options.querySelector<HTMLElement>("summary")!.click();
    const fit = [...options.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Fit page to panel")!;
    fit.click();
    await sleep(50);
    assert(fit.getAttribute("aria-checked") === "false", "Fit option did not turn off");
    return fitRequests.length;
  },
  browserControlsAssertFitStayedOff: async (before: number) => {
    await sleep(500);
    assert(fitRequests.length === before, "Panel resized while automatic fit was off");
    checks.push("Fit page to panel off prevents later geometry-driven resize");
  },
  browserControlsGeometry: async () => {
    await document.fonts.ready;
    await sleep(100);
    const panel = document
      .querySelector<HTMLElement>(".browser-panel")!
      .getBoundingClientRect();
    const controls = document
      .querySelector<HTMLElement>(".browser-controls")!
      .getBoundingClientRect();
    const image = document
      .querySelector<HTMLImageElement>("img")!
      .getBoundingClientRect();
    return {
      panel: panel.toJSON(),
      controls: controls.toJSON(),
      image: image.toJSON(),
      fitting:
        panel.right <= innerWidth + 1 &&
        panel.bottom <= innerHeight + 1 &&
        controls.right <= innerWidth + 1 &&
        image.width > 0 &&
        document.documentElement.scrollWidth <= innerWidth + 1,
    };
  },
});
