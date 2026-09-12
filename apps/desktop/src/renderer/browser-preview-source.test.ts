import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BrowserControlRequest, DesktopBridge, DraftBrowserFrameSnapshot, DraftBrowserMetadataSnapshot, DraftBrowserOwnerReference } from "@agent-desktop/shared";
import { BrowserPanel } from "./BrowserPanel";
import { browserPreviewSource } from "./browser-preview-source";

const ref = { ownerId: "owner", draftId: "draft", draftRevision: 3 };
const target = { workerPid: 50, name: "page", targetId: "native-target" };
const base = { protocolVersion: 1 as const, ownerKind: "draft" as const, hostId: "host", ownerId: "owner" };
const context = { documentId: "document", width: 800, height: 600, scrollX: 0, scrollY: 0 };
const metadata: DraftBrowserMetadataSnapshot = { ...base, availability: "running", workerPid: 50,
  tabs: [{ name: "page", targetId: "native-target", backend: "worker", kindTag: "headless", state: "alive", url: "https://example.com/", viewport: { width: 800, height: 600 } }] };
const image: DraftBrowserFrameSnapshot = { ...base, ...target, capturedAt: 1, context, mimeType: "image/jpeg", data: "aGVsbG8=", width: 800, height: 600, url: "https://example.com/", title: "Page", controlEpoch: "epoch" };
const request = (): BrowserControlRequest => ({ requestId: "request", controlEpoch: "epoch", capturedAt: 1, target: { ...target }, context: { ...context }, action: { type: "text", text: "retained input" } });
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const calls: Array<{ method: string; ref?: DraftBrowserOwnerReference; host?: string; value?: unknown }> = [];
  const forbidden = async () => { throw new Error("Acquisition, inspection and retirement are forbidden in preview"); };
  const bridge: Partial<DesktopBridge> = { draftBrowser: {
    acquire: forbidden, status: forbidden, retire: forbidden, create: forbidden, creationStatus: forbidden,
    metadata: async (reference, host) => { calls.push({ method: "metadata", ref: reference, host }); return structuredClone(metadata); },
    frame: async (reference, value, host) => { calls.push({ method: "frame", ref: reference, host, value }); return structuredClone(image); },
    control: async (reference, value, host) => { calls.push({ method: "control", ref: reference, host, value }); return { ...base, ...target, requestId: value.requestId, outcome: "completed" as const }; },
  }, getBrowserMetadata: async () => { throw new Error("Session fallback forbidden"); }, getBrowserFrame: async () => { throw new Error("Session fallback forbidden"); },
  controlBrowser: async () => { throw new Error("Session fallback forbidden"); } };
  let generation = 1;
  const owner = { kind: "draft" as const, hostId: "host", reference: { ...ref }, target: { ...target }, isCurrent: () => generation === 1 };
  return { bridge: bridge as DesktopBridge, owner, calls, lose: () => { generation++; } };
}

test("draft preview uses only the original explicit draft route and copies caller-owned requests", async () => {
  const f = fixture(), source = browserPreviewSource(f.bridge, f.owner);
  f.owner.reference.ownerId = "replacement"; f.owner.target.targetId = "replacement";
  expect((await source.metadata())?.hostId).toBe("host");
  expect(await source.frame(target)).toEqual(image);
  const sent = request(), completed = source.control(sent); sent.action = { type: "reload" }; sent.context.width = 123;
  expect((await completed).outcome).toBe("completed");
  expect(f.calls).toEqual([{ method: "metadata", ref, host: "host" }, { method: "frame", ref, host: "host", value: target },
    { method: "control", ref, host: "host", value: request() }]);
  f.calls[0]!.ref!.ownerId = "callback-mutated";
  await source.metadata(); expect(f.calls[3]!.ref).toEqual(ref);
  expect(source.addressOwner).toBe(JSON.stringify(["draft", "host", "owner", "draft", 3]));
});

test("unavailable draft transport never falls back to an otherwise working session transport", async () => {
  const f = fixture(); delete f.bridge.draftBrowser;
  const source = browserPreviewSource(f.bridge, f.owner);
  expect(source.canRead).toBe(false); expect(source.canControl).toBe(false);
  expect(await source.metadata()).toBeNull();
  await expect(source.frame(target)).rejects.toThrow("viewport"); await expect(source.control(request())).rejects.toThrow("receipt");
  expect(f.calls).toEqual([]);
});

test("a revoked original guard prevents all three dispatches and never revives", async () => {
  const f = fixture(); let valid = true;
  const source = browserPreviewSource(f.bridge, { ...f.owner, isCurrent: () => valid }); valid = false;
  expect(source.current()).toBe(false); valid = true;
  await expect(source.metadata()).rejects.toThrow("original"); await expect(source.frame(target)).rejects.toThrow("original");
  await expect(source.control(request())).rejects.toThrow("original"); expect(f.calls).toEqual([]);
});

test("generation loss during each await suppresses late metadata, pixels and control success", async () => {
  for (const method of ["metadata", "frame", "control"] as const) {
    const f = fixture(), waiting = gate<unknown>(); let calls = 0;
    Object.assign(f.bridge.draftBrowser!, { [method]: async () => { calls++; return waiting.promise; } });
    const source = browserPreviewSource(f.bridge, f.owner);
    const pending = method === "metadata" ? source.metadata() : method === "frame" ? source.frame(target) : source.control(request());
    f.lose(); waiting.resolve(method === "metadata" ? metadata : method === "frame" ? image : { ...base, ...target, requestId: "request", outcome: "completed" });
    await expect(pending).rejects.toThrow("original"); expect(calls).toBe(1);
  }
});

test("foreign owner, worker and target responses cannot publish or acknowledge a control", async () => {
  for (const change of [{ ownerId: "other" }, { hostId: "other" }, { ownerKind: "session" }, { sessionId: "fake" }, { protocolVersion: 2 }, { workerPid: 51 }]) {
    const f = fixture(); f.bridge.draftBrowser!.metadata = async () => ({ ...metadata, ...change }) as DraftBrowserMetadataSnapshot;
    await expect(browserPreviewSource(f.bridge, f.owner).metadata()).rejects.toThrow("different owner");
  }
  for (const change of [{ ownerId: "other" }, { workerPid: 51 }, { targetId: "other" }, { mimeType: "image/png" }]) {
    const f = fixture(); f.bridge.draftBrowser!.frame = async () => ({ ...image, ...change }) as DraftBrowserFrameSnapshot;
    await expect(browserPreviewSource(f.bridge, f.owner).frame(target)).rejects.toThrow("different owner or tab");
  }
  const f = fixture(); f.bridge.draftBrowser!.control = async () => ({ ...base, ...target, requestId: "another", outcome: "completed" });
  await expect(browserPreviewSource(f.bridge, f.owner).control(request())).rejects.toThrow("receipt");
});

test("foreign target requests are rejected before frame or control dispatch", async () => {
  const f = fixture(), source = browserPreviewSource(f.bridge, f.owner);
  await expect(source.frame({ ...target, workerPid: 51 })).rejects.toThrow("target changed");
  await expect(source.control({ ...request(), target: { ...target, targetId: "other" } })).rejects.toThrow("target changed");
  expect(f.calls).toEqual([]);
});

test("session preview preserves its real session arguments and legacy selection key", async () => {
  const calls: unknown[] = [], { ownerKind, ownerId, ...sessionImage } = image, { ownerKind: _, ownerId: __, ...sessionMetadata } = metadata;
  const bridge = { getBrowserMetadata: async (...args: unknown[]) => { calls.push(args); return { ...sessionMetadata, sessionId: "session" }; },
    getBrowserFrame: async (...args: unknown[]) => { calls.push(args); return { ...sessionImage, sessionId: "session" }; },
    controlBrowser: async (...args: unknown[]) => { calls.push(args); return { protocolVersion: 1, hostId: "host", sessionId: "session", ...target, requestId: "request", outcome: "completed" }; },
  } as DesktopBridge;
  const source = browserPreviewSource(bridge, { kind: "session", hostId: "host", sessionId: "session" });
  await source.metadata(); await source.frame(target); await source.control(request());
  expect(calls).toEqual([["session", "host"], ["session", target, "host"], ["session", request(), "host"]]);
  expect(source.selectionKey).toBe("browser.preview.selected.host.session"); expect(source.addressOwner).toBe(JSON.stringify(["host", "session"]));
});

test("actual shared panel renders draft and session shells without calling a bridge", () => {
  const f = fixture();
  const draft = renderToStaticMarkup(createElement(BrowserPanel, { bridge: f.bridge, draftOwner: f.owner, active: true }));
  const session = renderToStaticMarkup(createElement(BrowserPanel, { bridge: f.bridge, hostId: "host", sessionId: "session", nativeTarget: target, active: true }));
  for (const html of [draft, session]) {
    expect(html).toContain('aria-label="Page address"'); expect(html).toContain('aria-label="Browser options"');
    expect(html).toContain("Fit page to panel"); expect(html).not.toContain('<img');
  }
  expect(draft).toContain('draft'); expect(f.calls).toEqual([]);
});


test("unknown and rejected control outcomes stay explicit and transport failures are not retried", async () => {
  for (const outcome of ["unknown", "rejected"] as const) {
    const f = fixture(); let count = 0;
    f.bridge.draftBrowser!.control = async () => { count++; return { ...base, ...target, requestId: "request", outcome, message: "Inspect before retry" }; };
    const source = browserPreviewSource(f.bridge, f.owner);
    expect(await source.control(request())).toMatchObject({ outcome, message: "Inspect before retry" }); expect(count).toBe(1);
  }
  const f = fixture(); let count = 0;
  f.bridge.draftBrowser!.control = async () => { count++; throw new Error("Transport lost"); };
  await expect(browserPreviewSource(f.bridge, f.owner).control(request())).rejects.toThrow("Transport lost"); expect(count).toBe(1);
});


test("draft focus groups share the original draft while worker and selection identities stay distinct", () => {
  const f = fixture(), first = browserPreviewSource(f.bridge, f.owner);
  const second = browserPreviewSource(f.bridge, { ...f.owner, reference: { ...ref, ownerId: "second-owner" } });
  expect(first.focusOwner).toBe(JSON.stringify(["draft", "host", "draft"])); expect(second.focusOwner).toBe(first.focusOwner);
  expect(second.selectionKey).not.toBe(first.selectionKey); expect(second.key).not.toBe(first.key);
  expect(first.addressOwner).toBe(JSON.stringify(["draft", "host", "owner", "draft", 3]));
  const html = renderToStaticMarkup(createElement(BrowserPanel, { bridge: f.bridge, active: true, draftOwner: f.owner }));
  expect(html).toContain('data-browser-address-owner="[&quot;draft&quot;,&quot;host&quot;,&quot;draft&quot;]"');
  expect(f.calls).toEqual([]);
  const session = browserPreviewSource(f.bridge, { kind: "session", hostId: "host", sessionId: "session" });
  expect(session.focusOwner).toBe(JSON.stringify(["host", "session"])); expect(session.focusOwner).toBe(session.addressOwner);
});
