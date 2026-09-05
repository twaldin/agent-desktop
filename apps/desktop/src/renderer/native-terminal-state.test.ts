import { expect, test } from "bun:test";
import type { NativeTerminalAttachment, NativeTerminalInfo, NativeTerminalInputReceipt, NativeTerminalInputRequest, NativeTerminalReplay } from "../../../../packages/shared/src/terminals";
import { NativeTerminalInputQueue, NativeTerminalReplayCursor, unsupportedNativeTerminal, verifyNativeTerminalCapabilities } from "./native-terminal-state";
import { unwrapNativeTerminalResult } from "./native-terminal-bridge";
const attachment = (id = "attach-a", revision = 1): NativeTerminalAttachment => ({ id, terminalId: "pane", viewerId: "viewer", inputEpoch: "epoch", geometryRevision: revision, cols: 80, rows: 24, expiresAt: Date.now() + 30000 });
const replay = (attach: NativeTerminalAttachment, sequences: number[], resetRequired = false): NativeTerminalReplay => ({ attachment: attach, terminal: {} as NativeTerminalInfo, chunks: sequences.map(sequence => ({ sequence, data: `output-${sequence}` })), firstSequence: sequences[0] ?? 1, lastSequence: sequences.at(-1) ?? 0, resetRequired });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

test("native cursor never parses a ring gap, resetRequired tail, another attachment, or another grid", async () => {
  const parsed: string[] = [], reset: string[] = [];
  const cursor = new NativeTerminalReplayCursor(value => reset.push(value.id), async chunks => { parsed.push(...chunks.map(item => item.data)); });
  cursor.begin(attachment()); expect(await cursor.apply(replay(attachment(), [1, 2]))).toBe("applied");
  expect(await cursor.apply(replay(attachment(), [5, 6], true))).toBe("reset-required");
  expect(await cursor.apply(replay(attachment(), [4, 5]))).toBe("reset-required");
  expect(await cursor.apply(replay(attachment("other"), [1]))).toBe("stale");
  expect(await cursor.apply(replay(attachment("attach-a", 2), [3]))).toBe("reset-required");
  expect(parsed).toEqual(["output-1", "output-2"]); expect(cursor.sequence).toBe(2);
  cursor.begin(attachment("new")); expect(await cursor.apply(replay(attachment("new"), [1]))).toBe("applied");
  expect(reset).toEqual(["attach-a", "new"]); expect(cursor.sequence).toBe(1);
});

test("native input waits for actual grid acknowledgement and preserves source order", async () => {
  const requests: NativeTerminalInputRequest[] = [];
  const queue = new NativeTerminalInputQueue("pane", async request => { requests.push(request); return { sequence: request.sequence, duplicate: false, outcome: "accepted" }; }, () => {});
  queue.setGeneration(attachment()); queue.enqueue({ kind: "text", data: "too early" }); expect(requests).toHaveLength(0);
  queue.acknowledge(attachment()); queue.enqueue({ kind: "key", key: "Up" }); queue.enqueue({ kind: "paste", data: "first\nsecond" }); await queue.settled();
  expect(requests.map(item => item.sequence)).toEqual([1, 2]); expect(requests.map(item => item.input.kind)).toEqual(["key", "paste"]);
  expect(requests.every(item => item.attachmentId === "attach-a" && item.geometryRevision === 1 && item.inputEpoch === "epoch")).toBe(true);
  queue.dispose();
});

test("lost receipt and stale native admission discard queued keys without automatic replay", async () => {
  for (const outcome of ["throw", "not-submitted", "uncertain"] as const) {
    const requests: NativeTerminalInputRequest[] = [];
    const queue = new NativeTerminalInputQueue("pane", async request => { requests.push(request); if (outcome === "throw") throw new Error("Lost receipt"); return { sequence: request.sequence, duplicate: false, outcome, code: "STALE_TERMINAL_GEOMETRY" }; }, () => {});
    queue.setGeneration(attachment()); queue.acknowledge(attachment()); queue.enqueue({ kind: "text", data: "one" }); queue.enqueue({ kind: "text", data: "must not replay" }); await queue.settled();
    expect(requests).toHaveLength(1); expect(queue.paused).toBe(true); expect(queue.pendingBytes).toBe(0);
    queue.setConnected(false); queue.setConnected(true); queue.setGeneration(attachment("new")); queue.acknowledge(attachment("new")); await queue.settled(); expect(requests).toHaveLength(1);
    queue.resume(); expect(queue.paused).toBe(false); queue.dispose();
  }
});

test("attachment replacement during accepted input drops the old queue and starts an explicit new stream", async () => {
  const first = deferred<NativeTerminalInputReceipt>(), requests: NativeTerminalInputRequest[] = [];
  const queue = new NativeTerminalInputQueue("pane", request => { requests.push(request); return requests.length === 1 ? first.promise : Promise.resolve({ sequence: request.sequence, duplicate: false, outcome: "accepted" }); }, () => {});
  queue.setGeneration(attachment()); queue.acknowledge(attachment()); queue.enqueue({ kind: "text", data: "sent" }); queue.enqueue({ kind: "text", data: "discard" }); await Promise.resolve();
  queue.setGeneration(attachment("new", 2)); queue.acknowledge(attachment("new", 2)); first.resolve({ sequence: 1, duplicate: false, outcome: "accepted" }); await queue.settled();
  expect(requests).toHaveLength(1); expect(queue.paused).toBe(true);
  queue.resume(); queue.enqueue({ kind: "text", data: "new explicit input" }); await queue.settled();
  expect(requests).toHaveLength(2); expect(requests[1]!.sequence).toBe(1); expect(requests[1]!.clientId).not.toBe(requests[0]!.clientId); expect(requests[1]!.attachmentId).toBe("new"); queue.dispose();
});

test("native capability failures preserve codes through result envelopes and never use message guessing", () => {
  expect(unwrapNativeTerminalResult({ ok: true, value: 42 })).toBe(42);
  let error: unknown; try { unwrapNativeTerminalResult({ ok: false, error: { message: "Old host", code: "NATIVE_TERMINAL_UNSUPPORTED", status: 404 } }); } catch (cause) { error = cause; }
  expect(unsupportedNativeTerminal(error)).toBe(true); expect(unsupportedNativeTerminal(new Error("404 native terminal unsupported"))).toBe(false); expect(unsupportedNativeTerminal({ code: "TMUX_UNAVAILABLE", status: 503 })).toBe(false);
  expect(() => verifyNativeTerminalCapabilities({ protocol: "wrong" } as never)).toThrow("not supported");
});
