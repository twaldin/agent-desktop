import { expect, test } from "bun:test";
import type { BrowserFrameTarget } from "@agent-desktop/shared";
import { WorkerBrowserEvaluationChannels } from "./evaluation";
import type { BrowserEvaluationBinding, BrowserEvaluationFrame, NativeCdpEvaluation, NativeCmuxEvaluation } from "./evaluation-wire";
import { WorkerBrowserReservations } from "./reservation";
import type { BrowserEvaluationReservation, NativeBrowserOwner } from "./owner";

const target: BrowserFrameTarget = { workerPid: 71, name: "original", targetId: "target-71" };
const binding = (backend: "cdp" | "cmux", operationId = `${backend}-op`): BrowserEvaluationBinding => ({ ...target, ownerId: "owner-71", operationId, backend });
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const settled = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: undefined as Error | undefined }), error => ({ value: undefined as T | undefined, error: error as Error }));

interface OwnerDouble {
  readonly id: string;
  reserveBrowserEvaluation(target: Readonly<{ name: string; targetId: string }>, operationId: string): Promise<Readonly<BrowserEvaluationReservation>>;
  openBrowserEvaluation(target: Readonly<{ name: string; targetId: string }>, operationId: string, backend: "cdp" | "cmux", timeoutMs: number): Promise<Readonly<NativeCdpEvaluation> | Readonly<NativeCmuxEvaluation>>;
}

interface NativeControl {
  readonly cdp: NativeCdpEvaluation;
  readonly cmux: NativeCmuxEvaluation;
  readonly cdpPost: (frame: BrowserEvaluationFrame) => void;
  readonly cdpReceived: BrowserEvaluationFrame[];
  readonly cmuxInputs: Array<{ method: string; params: Record<string, unknown>; options?: { timeoutMs?: number } }>;
  readonly disposeCalls: { cdp: number; cmux: number; reservation: number };
  readonly cmuxGate: ReturnType<typeof Promise.withResolvers<Record<string, unknown>>>;
  readonly owner: OwnerDouble;
  replace(owner: OwnerDouble): void;
}

function fixture(options: { readonly cdp?: NativeCdpEvaluation; readonly cmux?: NativeCmuxEvaluation; readonly post?: (binding: BrowserEvaluationBinding, frame: BrowserEvaluationFrame) => void } = {}) {
  let nativePost: (frame: BrowserEvaluationFrame) => void = () => {};
  const cdpReceived: BrowserEvaluationFrame[] = [], cmuxInputs: NativeControl["cmuxInputs"] = [];
  const disposeCalls = { cdp: 0, cmux: 0, reservation: 0 };
  const cmuxGate = Promise.withResolvers<Record<string, unknown>>();
  const cdp: NativeCdpEvaluation = options.cdp ?? {
    descriptor: { version: 1, channel: "cdp-71", targetId: target.targetId, activateForScreenshot: true },
    start(post) { nativePost = post; },
    receive(frame) { cdpReceived.push(frame); },
    async dispose() { disposeCalls.cdp++; },
  };
  const cmux: NativeCmuxEvaluation = options.cmux ?? {
    state: { version: 1, surfaceId: target.targetId, url: "https://original.invalid/", viewport: { width: 800, height: 600 }, elementRefs: [{ id: 7, ref: "@e7", name: "Original" }] },
    async request(method, params, requestOptions) { cmuxInputs.push({ method, params, options: requestOptions }); return cmuxGate.promise; },
    async dispose() { disposeCalls.cmux++; },
  };
  const reservation: BrowserEvaluationReservation = {
    ownerSessionId: "owner-71", name: target.name, targetId: target.targetId, operationId: "unused",
    ready: Promise.resolve(), assertCurrent() {}, async dispose() { disposeCalls.reservation++; },
  };
  const initial: OwnerDouble = {
    id: "owner-71",
    async reserveBrowserEvaluation(_target: Readonly<{ name: string; targetId: string }>, operationId: string) {
      return { ...reservation, operationId };
    },
    async openBrowserEvaluation(_target: Readonly<{ name: string; targetId: string }>, _operationId: string, backend: "cdp" | "cmux") {
      return backend === "cdp" ? cdp : cmux;
    },
  };
  let current: OwnerDouble = initial;
  const reservations = new WorkerBrowserReservations(target.workerPid, () => current);
  const frames: Array<{ binding: BrowserEvaluationBinding; frame: BrowserEvaluationFrame }> = [];
  const channels = new WorkerBrowserEvaluationChannels(reservations, () => current as NativeBrowserOwner, options.post ?? ((value, frame) => frames.push({ binding: value, frame })));
  return { channels, reservations, frames, control: {
    cdp, cmux, cdpPost: frame => nativePost(frame), cdpReceived, cmuxInputs, disposeCalls, cmuxGate, owner: initial,
    replace(owner: OwnerDouble) { current = owner; },
  } satisfies NativeControl };
}

async function ready(h: ReturnType<typeof fixture>, value: BrowserEvaluationBinding) {
  await h.reservations.reserve(target, value.operationId);
  return h.channels.open(value, 500);
}

test("evaluation opens only a ready exact reservation, captures the original tuple, and publishes before native reentry", async () => {
  const h = fixture();
  await expect(h.channels.open(binding("cdp"), 500)).rejects.toThrow("reservation");
  const value = binding("cdp", "reentrant");
  await h.reservations.reserve(target, value.operationId);
  let nested: Promise<unknown> | undefined;
  const original = h.control.owner;
  original.openBrowserEvaluation = async (...args) => {
    nested = h.channels.open(value, 500);
    return h.control.cdp;
  };
  const opened = await h.channels.open(value, 500);
  expect((await nested) as unknown).toMatchObject({ backend: "cdp", binding: value });
  expect(opened).toMatchObject({ backend: "cdp", binding: value });
  const changed = { ...value, targetId: "replacement" };
  await expect(h.channels.open(changed, 500)).rejects.toThrow("changed binding");
  h.control.replace({ id: "owner-71", reserveBrowserEvaluation: async () => { throw new Error("replacement"); }, openBrowserEvaluation: async () => { throw new Error("replacement"); } });
  await expect(h.channels.start(value)).rejects.toThrow("owner changed");
  await h.channels.dispose().catch(() => {});
});

test("CDP publishes its receiver before a synchronous replay and preserves data/ack/close/drained flow without a fabricated acknowledgement", async () => {
  let post: (frame: BrowserEvaluationFrame) => void = () => {}, starts = 0; const received: BrowserEvaluationFrame[] = [];
  const h = fixture({ cdp: {
    descriptor: { version: 1, channel: "cdp-71", targetId: target.targetId, activateForScreenshot: true },
    start(receiver) { starts++; post = receiver; receiver({ type: "worker-cdp", channel: "cdp-71", kind: "data", sequence: 1, data: "synchronous" }); },
    receive(frame) { received.push(frame); }, async dispose() {},
  } });
  const value = binding("cdp", "frames"); await ready(h, value);
  await h.channels.start(value); // The native callback replays while start is still on stack.
  expect(h.frames.map(entry => entry.frame)).toEqual([{ type: "worker-cdp", channel: "cdp-71", kind: "data", sequence: 1, data: "synchronous" }]);
  await h.channels.start(value); expect(starts).toBe(1);
  h.channels.receive(value, { type: "worker-cdp", channel: "cdp-71", kind: "ack", sequence: 1 });
  expect(received).toEqual([{ type: "worker-cdp", channel: "cdp-71", kind: "ack", sequence: 1 }]);
  post({ type: "worker-cdp", channel: "cdp-71", kind: "close", errors: [] });
  post({ type: "worker-cdp", channel: "cdp-71", kind: "drained", errors: [] });
  await tick();
  expect(h.frames.map(entry => entry.frame.kind)).toEqual(["data", "close", "drained"]);
  await h.channels.dispose();
});

test("a live CDP callback delivery failure is retained through disposal", async () => {
  const h = fixture({ post: (_binding, frame) => { if (frame.kind === "data") throw new Error("post failed"); } });
  const value = binding("cdp", "post-failure"); await ready(h, value); await h.channels.start(value);
  expect(() => h.control.cdpPost({ type: "worker-cdp", channel: "cdp-71", kind: "data", sequence: 1, data: "live" })).toThrow("post failed");
  await expect(h.channels.close(value)).rejects.toThrow("post failed");
});

test("retirement drains a late native open, invalid native descriptor cleanup, and channel disposal never kills the reservation", async () => {
  const held = Promise.withResolvers<NativeCdpEvaluation>(); let disposals = 0;
  const invalid: NativeCdpEvaluation = { descriptor: { version: 1, channel: "bad", targetId: "foreign", activateForScreenshot: true }, start() {}, receive() {}, async dispose() { disposals++; } };
  const h = fixture({ cdp: invalid }); const value = binding("cdp", "invalid"); await h.reservations.reserve(target, value.operationId);
  await expect(h.channels.open(value, 500)).rejects.toThrow("Invalid retained CDP descriptor");
  await tick(); expect(disposals).toBe(1); expect(h.control.disposeCalls.reservation).toBe(0);

  const late = fixture({ cdp: { descriptor: { version: 1, channel: "late", targetId: target.targetId, activateForScreenshot: true }, start() {}, receive() {}, async dispose() { disposals++; } } });
  const owner = late.control.owner;
  owner.openBrowserEvaluation = async () => held.promise;
  const lateBinding = binding("cdp", "late"); await late.reservations.reserve(target, lateBinding.operationId);
  const opening = settled(late.channels.open(lateBinding, 500)); await tick(); const closing = late.channels.close(lateBinding);
  held.resolve(late.control.cdp); await expect(closing).resolves.toBeUndefined();
  expect((await opening).error?.message).toContain("retired"); expect(late.control.disposeCalls.reservation).toBe(0);
});

test("CMUX opaque native requests retain all 64 delivered receipts until acknowledgement and isolate caller and reply values", async () => {
  const h = fixture(); const value = binding("cmux", "cmux"); await ready(h, value);
  const deliveries: Array<{ ok: boolean; value?: unknown; error?: unknown }> = [];
  const caller = { nested: { before: true } };
  const first = h.channels.request(value, 1, "opaque.native.method", caller, { timeoutMs: 10 }, (ok, response, error) => deliveries.push({ ok, value: response, error }));
  caller.nested.before = false;
  const requests = [first, ...Array.from({ length: 63 }, (_, index) => h.channels.request(value, index + 2, "opaque.native.method", { index }, undefined, (ok, response, error) => deliveries.push({ ok, value: response, error })))];
  await tick();
  expect(h.control.cmuxInputs).toHaveLength(64); expect((h.control.cmuxInputs[0]?.params.nested as { before: boolean }).before).toBe(true);
  await expect(h.channels.request(value, 65, "opaque.native.method", {}, undefined, () => {})).rejects.toThrow("capacity");
  const response = { nested: { exact: true, reverse: "native" } }; h.control.cmuxGate.resolve(response); await Promise.all(requests);
  response.nested.exact = false;
  const delivered = deliveries[0]?.value as { nested: { exact: boolean; reverse: string } }; expect(delivered.nested.exact).toBe(true);
  delivered.nested.reverse = "caller"; expect(response.nested.reverse).toBe("native");
  await expect(h.channels.request(value, 65, "opaque.native.method", {}, undefined, () => {})).rejects.toThrow("capacity");
  for (let sequence = 1; sequence <= 64; sequence++) h.channels.acknowledge(value, sequence);
  let deliveredError = false;
  await h.channels.request(value, 65, "opaque.native.method", {}, undefined, () => { deliveredError = true; throw new Error("delivery failed"); }).catch(() => {});
  expect(deliveredError).toBe(true); await expect(h.channels.close(value)).rejects.toThrow("delivery failed");
});

test("unacknowledged live errors remain cleanup failures, acknowledged errors do not, and retirement/native cleanup errors remain visible", async () => {
  const state = { version: 1 as const, surfaceId: target.targetId, url: "https://original.invalid/", viewport: { width: 1, height: 1 }, elementRefs: [] };
  const unacknowledgedGate = Promise.withResolvers<Record<string, unknown>>();
  const unacknowledged = fixture({ cmux: { state, request: async () => unacknowledgedGate.promise, async dispose() {} } }); const value = binding("cmux", "unacknowledged"); await ready(unacknowledged, value);
  let live = false; const request = unacknowledged.channels.request(value, 1, "opaque.native.failure", {}, undefined, ok => { live = !ok; });
  unacknowledgedGate.reject(new Error("native operational failure")); await request; expect(live).toBe(true);
  await expect(unacknowledged.channels.close(value)).rejects.toThrow("native operational failure");

  const acknowledgedGate = Promise.withResolvers<Record<string, unknown>>();
  const acknowledged = fixture({ cmux: { state, request: async () => acknowledgedGate.promise, async dispose() {} } }); const acknowledgedValue = binding("cmux", "acknowledged"); await ready(acknowledged, acknowledgedValue);
  const acknowledgedRequest = acknowledged.channels.request(acknowledgedValue, 1, "opaque.native.failure", {}, undefined, () => {});
  acknowledgedGate.reject(new Error("acknowledged native failure")); await acknowledgedRequest; acknowledged.channels.acknowledge(acknowledgedValue, 1);
  await expect(acknowledged.channels.close(acknowledgedValue)).resolves.toBeUndefined();

  const held = Promise.withResolvers<Record<string, unknown>>(); let nativeDisposals = 0;
  const later = fixture({ cmux: { state, request: async () => held.promise, async dispose() { nativeDisposals++; throw new Error("native cleanup failed"); } } }); const laterValue = binding("cmux", "retired-error"); await ready(later, laterValue);
  const pending = later.channels.request(laterValue, 1, "opaque.native.failure", {}, undefined, () => {});
  const closing = later.channels.close(laterValue); held.reject(new Error("late operational failure")); await pending;
  await expect(closing).rejects.toThrow("late operational failure"); expect(nativeDisposals).toBe(1);
});
