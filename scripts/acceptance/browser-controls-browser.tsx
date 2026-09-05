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
let controls = 0;
const target = { workerPid: 42, name: "native", targetId: "tab" };
const context = (documentId: string) => ({
  documentId,
  width: 800,
  height: 600,
  scrollX: 0,
  scrollY: 0,
});
const bridge: DesktopBridge = {
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
  ): Promise<BrowserFrameSnapshot> => ({
    protocolVersion: 1,
    hostId,
    sessionId,
    ...frameTarget,
    capturedAt: 101,
    controlEpoch: "epoch-1",
    context: context("doc-1"),
    mimeType: "image/jpeg",
    data,
    width: 800,
    height: 600,
    url: "https://example.test/",
    title: "Control target",
  }),
  controlBrowser: async (_sessionId, request, hostId) => {
    requests.push(request);
    controls++;
    if (controls === 1) {
      await first.promise;
      return {
        protocolVersion: 1,
        hostId,
        sessionId: "session",
        requestId: request.requestId,
        ...target,
        outcome: "completed", url: "https://example.test/", title: "Control target",
        context: context("doc-2"),
      };
    }
    if (controls === 2) {
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
    return {
      protocolVersion: 1,
      hostId,
      sessionId: "session",
      requestId: request.requestId,
      ...target,
      outcome: "completed", url: "https://example.test/", title: "Control target",
      context: context("doc-3"),
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
    text: document.body.innerText,
    retained: document.querySelector<HTMLTextAreaElement>('[aria-label="Unsent browser input"]')?.value,
  }),
  browserControlsStart: async () => {
    const bytes = new Uint8Array(await (await fetch(fixtureUrl)).arrayBuffer());
    data = btoa(String.fromCharCode(...bytes));
    root.render(
      <BrowserPanel bridge={bridge} hostId="host" sessionId="session" active />,
    );
    await wait(
      () => document.querySelector("img")?.naturalWidth === 800,
      "initial live frame",
    );
    const address = document.querySelector<HTMLInputElement>('[aria-label="Page address"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(address, "https://draft.example.test/");
    address.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(1300); assert(address.value === "https://draft.example.test/", "polling overwrote the address draft");
    checks.push("address draft survives a native preview refresh");
    document
      .querySelector<HTMLTextAreaElement>(".browser-input-capture")!
      .focus();
  },
  browserControlsReleaseFirst: async () => {
    await wait(() => requests.length === 1, "first text request");
    assert(
      requests.length === 1,
      "typing started a concurrent browser control",
    );
    first.resolve();
    await wait(() => requests.length === 2, "serialized second text request");
    assert(
      requests[1].context.documentId === "doc-2",
      "queued text ignored the completed receipt context",
    );
  },
  browserControlsFinish: async () => {
    await sleep(100);
    assert(requests.length === 2, "pending edit key bypassed the serial queue");
    second.resolve();
    await wait(
      () =>
        document.body.innerText.includes("Native acknowledgement was lost."),
      "unknown action result",
    );
    assert(requests.length === 2, "unknown action was retried");
    assert(
      document.querySelector<HTMLTextAreaElement>('[aria-label="Unsent browser input"]')?.value === "[Backspace]d",
      `unsent queued text was not retained visibly: ${document.querySelector<HTMLTextAreaElement>('[aria-label="Unsent browser input"]')?.value}`,
    );
    checks.push(
      "text is serialized through receipt context; unknown actions are not replayed and leave queued input visible",
    );
    await sleep(1300);
    assert(requests.length === 2, "polling replayed unknown or queued actions");
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
      () => requests.length === 3 && requests[2].action.type === "reload",
      "reload control request",
    );
    assert(
      requests[2].target.targetId === "tab" &&
        requests[2].controlEpoch === "epoch-1",
      "reload request lost target or epoch",
    );
    checks.push(
      "native control buttons send the current owner target and epoch",
    );
    return { passed: true, checks, requests: requests.length };
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
