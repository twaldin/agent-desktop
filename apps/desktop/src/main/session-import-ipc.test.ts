import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { IpcMainInvokeEvent } from "electron";
import { nativeImportCommandId, parseNativeImportAdmissionRequest, parseNativeImportPreparationRequest } from "@agent-desktop/shared";
import { SessionSearchRequests } from "./session-search-requests";

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type Bridge = Record<string, (...args: unknown[]) => Promise<unknown>>;
type Endpoint = { hostId: string; origin: string; token: string };
type Call = { operation: string; hostId: string; input?: unknown; signal: AbortSignal };
const endpoint = (hostId: string): Endpoint => ({ hostId, origin: "https://controlled.invalid", token: "controlled" });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const settle = (promise: Promise<unknown>) => promise.then(() => "returned", () => "cancelled");
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

// Compile the maintained main registration and preload object members. The
// boundaries fail closed if either source layout changes; no handler is copied.
const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const preload = readFileSync(new URL("./preload.ts", import.meta.url), "utf8");
function section(source: string, first: string, next: string): string {
  const start = source.indexOf(first), end = source.indexOf(next, start + first.length);
  if (start < 0 || end < 0 || source.indexOf(first, start + first.length) >= 0) throw new Error(`Native import source boundary changed: ${first}`);
  return source.slice(start, end);
}
const mainRegistration = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(
  section(main, "const sessionImportRequests =", "const sessionSearchRequests ="));
const preloadMembers = section(preload, "  listNativeSessionImports:", "  searchSessions:");

function fixture() {
  const handlers = new Map<string, Handler>(), calls: Call[] = [], destroyed = new Map<number, () => void>();
  let trusted = true, endpointLookup = async (hostId: string) => endpoint(hostId);
  let onList = async (_signal: AbortSignal): Promise<unknown> => "list";
  let onAdmission = async (_signal: AbortSignal): Promise<unknown> => "admitted";
  const lookups: string[] = [];
  const transport = {
    list: async (value: Endpoint, signal: AbortSignal) => { calls.push({ operation: "list", hostId: value.hostId, signal }); return onList(signal); },
    inspect: async (value: Endpoint, input: unknown, signal: AbortSignal) => { calls.push({ operation: "inspect", hostId: value.hostId, input, signal }); return "inspection"; },
    prepare: async (value: Endpoint, input: unknown, signal: AbortSignal) => { calls.push({ operation: "prepare", hostId: value.hostId, input, signal }); return "prepared"; },
    admit: async (value: Endpoint, input: unknown, signal: AbortSignal) => { calls.push({ operation: "admit", hostId: value.hostId, input, signal }); return onAdmission(signal); },
    outcome: async (value: Endpoint, input: unknown, signal: AbortSignal) => { calls.push({ operation: "outcome", hostId: value.hostId, input, signal }); return "pending"; },
  };
  const install = new Function("ipcMain", "SessionSearchRequests", "assertTrustedSender", "endpointFor",
    "parseNativeImportPreparationRequest", "parseNativeImportAdmissionRequest", "nativeImportCommandId",
    "requestNativeImportListing", "requestNativeImportInspection", "requestNativeImportPreparation", "requestNativeImportAdmission", "requestNativeImportStatus",
    mainRegistration) as (...dependencies: unknown[]) => void;
  install({ handle(channel: string, handler: Handler) { if (handlers.has(channel)) throw new Error(`Duplicate ${channel}`); handlers.set(channel, handler); } },
    SessionSearchRequests, () => { if (!trusted) throw new Error("Untrusted sender"); },
    async (hostId: string) => { lookups.push(hostId); return endpointLookup(hostId); },
    parseNativeImportPreparationRequest, parseNativeImportAdmissionRequest, nativeImportCommandId,
    transport.list, transport.inspect, transport.prepare, transport.admit, transport.outcome);
  if (handlers.size !== 6) throw new Error("Native import channel registration changed.");
  const bridgeFor = (owner: number): Bridge => {
    const sender = { id: owner, once(name: string, listener: () => void) { if (name !== "destroyed") throw new Error(name); destroyed.set(owner, listener); } };
    const event = { sender } as unknown as IpcMainInvokeEvent;
    const ipcRenderer = { async invoke(channel: string, ...args: unknown[]) {
      const handler = handlers.get(channel); if (!handler) throw new Error(`Missing native import handler: ${channel}`);
      return handler(event, ...args);
    } };
    return new Function("ipcRenderer", `return ({${preloadMembers}});`)(ipcRenderer) as Bridge;
  };
  return { bridgeFor, calls, lookups, close(owner: number) { destroyed.get(owner)?.(); },
    untrust() { trusted = false; }, holdEndpoint(gate: ReturnType<typeof deferred<Endpoint>>) { endpointLookup = async () => gate.promise; },
    onList(callback: typeof onList) { onList = callback; }, onAdmission(callback: typeof onAdmission) { onAdmission = callback; } };
}

test("preload maps all six channels and main rejects malformed input before endpoint lookup", async () => {
  const f = fixture(), bridge = f.bridgeFor(1);
  await expect(bridge.listNativeSessionImports("host\n", "read")).rejects.toThrow("owning host");
  await expect(bridge.prepareNativeSessionImport("host", { candidateId: "bad/slash", revision: "rev" }, "read")).rejects.toThrow();
  await expect(bridge.admitNativeSessionImport("host", { commandId: "command", preparationId: "bad/slash" })).rejects.toThrow();
  await expect(bridge.getNativeSessionImportOutcome("host", "bad/slash", "read")).rejects.toThrow();
  await expect(bridge.listNativeSessionImports("host", "bad/read")).rejects.toThrow("request identity");
  expect(f.lookups).toEqual([]); expect(f.calls).toEqual([]);
  expect(await bridge.inspectNativeSessionImport("host", "candidate", "inspect")).toBe("inspection");
  expect(await bridge.prepareNativeSessionImport("host", { candidateId: "candidate", revision: "rev" }, "prepare")).toBe("prepared");
  expect(await bridge.getNativeSessionImportOutcome("host", "command", "status")).toBe("pending");
  expect(f.calls.map(({ operation, input }) => [operation, input])).toEqual([
    ["inspect", "candidate"], ["prepare", { candidateId: "candidate", revision: "rev" }], ["outcome", "command"],
  ]);
});

test("admission rechecks sender trust after a held endpoint resolves", async () => {
  const f = fixture(), gate = deferred<Endpoint>(); f.holdEndpoint(gate);
  const pending = f.bridgeFor(1).admitNativeSessionImport("host", { commandId: "command", preparationId: "prepared" });
  await tick(); expect(f.lookups).toEqual(["host"]);
  f.untrust(); gate.resolve(endpoint("host"));
  await expect(pending).rejects.toThrow("Untrusted sender");
  expect(f.calls).toEqual([]);
});

test("read cancellation belongs to its sender and host, including replacement reads", async () => {
  const f = fixture(), waits = [deferred<unknown>(), deferred<unknown>(), deferred<unknown>(), deferred<unknown>()];
  let nextWait = 0; f.onList(async () => waits[nextWait++]!.promise);
  const first = f.bridgeFor(1), second = f.bridgeFor(2);
  const a = first.listNativeSessionImports("host-a", "old"), b = first.listNativeSessionImports("host-b", "other"), c = second.listNativeSessionImports("host-a", "foreign");
  const outcomes = [settle(a), settle(b), settle(c)]; await tick();
  expect(f.calls).toHaveLength(3);
  await first.cancelNativeSessionImportRead("host-a", "foreign");
  expect(f.calls.map(call => call.signal.aborted)).toEqual([false, false, false]);
  const replacement = first.listNativeSessionImports("host-a", "new"); outcomes.push(settle(replacement)); await tick();
  expect(f.calls.map(call => call.signal.aborted)).toEqual([true, false, false, false]);
  await first.cancelNativeSessionImportRead("host-a", "old");
  expect(f.calls[3]!.signal.aborted).toBe(false);
  await first.cancelNativeSessionImportRead("host-a", "new");
  expect(f.calls.map(call => call.signal.aborted)).toEqual([true, false, false, true]);
  f.close(1); expect(f.calls.map(call => call.signal.aborted)).toEqual([true, true, false, true]);
  for (const wait of waits) wait.resolve("list");
  expect(await Promise.all(outcomes)).toEqual(["cancelled", "cancelled", "returned", "cancelled"]);
});

test("closing or replacing a picker read cannot cancel dispatched admission or alter its command", async () => {
  const f = fixture(), admission = deferred<unknown>(), read = deferred<unknown>();
  f.onAdmission(async () => admission.promise); f.onList(async () => read.promise);
  const bridge = f.bridgeFor(3), request = { commandId: "same-command", preparationId: "prepared" };
  const pendingAdmission = bridge.admitNativeSessionImport("host", request); await tick();
  expect(f.calls.map(call => call.operation)).toEqual(["admit"]);
  const pendingRead = bridge.listNativeSessionImports("host", "picker-read"), readOutcome = settle(pendingRead); await tick();
  await bridge.cancelNativeSessionImportRead("host", "picker-read"); f.close(3);
  expect(f.calls[0]!.signal.aborted).toBe(false); expect(f.calls[1]!.signal.aborted).toBe(true);
  read.resolve("list"); expect(await readOutcome).toBe("cancelled");
  admission.resolve("admitted"); expect(await pendingAdmission).toBe("admitted");
  expect(f.calls[0]!.input).toEqual(request);
  expect(await f.bridgeFor(4).getNativeSessionImportOutcome("host", request.commandId, "follow-up")).toBe("pending");
  expect(f.calls.at(-1)).toMatchObject({ operation: "outcome", hostId: "host", input: request.commandId });
});
