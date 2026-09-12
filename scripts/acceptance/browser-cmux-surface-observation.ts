/** Actual selected client + reader, controlled transport only. No SDK/socket launch. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";

const [clientPath, readerPath] = process.argv.slice(2);
if (!clientPath || !readerPath) throw new Error("Pass selected socket client and surface reader");
const clientSource = await readFile(clientPath, "utf8"), readerSource = await readFile(readerPath, "utf8");
const clientOffset = clientSource.indexOf("const DEFAULT_CONNECT_TIMEOUT_MS");
assert(clientOffset >= 0);
const transform = (s: string) => new Bun.Transpiler({ loader: "ts" }).transformSync(s.replace(/^import type .*;\n/gm, "").replaceAll("export ", ""));
type Snapshot = { readonly surfaceId: string; readonly workspaceId: string; readonly windowId: string | null };
type Reader = { inspect(id: string): Promise<Snapshot> };
type Client = { connect(): Promise<void>; close(): void; readonly connectionGeneration?: number; request(method: string, params: object, options?: object): Promise<object> };
const capture = new Function(`${transform(readerSource)}\nreturn captureCmuxSurfaceObservation;`)() as (client: Client, timeout: number) => Reader;
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", C = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const ticks = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
class Socket extends EventEmitter {
  destroyed = false; writes: string[] = [];
  setEncoding(_s: string) { return this; }
  write(raw: string, _cb: (error?: Error) => void) { this.writes.push(raw); return true; }
  end() { return this; } destroy() { this.destroyed = true; return this; }
  reply(value: unknown) { this.emit("data", JSON.stringify(value) + "\n"); }
}
function harness() {
  const sockets: Socket[] = [], timers = new Map<number, { callback: () => void; ms: number }>(); let timerId = 0;
  const NativeClient = new Function("randomUUID", "net", "os", "path", "ToolError", "setTimeout", "clearTimeout",
    `${transform(clientSource.slice(clientOffset))}\nreturn CmuxSocketClient;`)(randomUUID,
    { createConnection() { const socket = new Socket(); sockets.push(socket); return socket; } },
    { homedir() { throw new Error("Unexpected credentials"); } }, {}, Error,
    (callback: () => void, ms: number) => { timers.set(++timerId, { callback, ms }); return timerId; },
    (id: number) => { timers.delete(id); }) as new (opts: object) => Client;
  const client = new NativeClient({ socketPath: "/controlled/cmux.sock", relayId: "", relayToken: "" });
  return {
    client, sockets, timers,
    async connect() { const ready = client.connect(); const socket = sockets.at(-1)!; socket.emit("connect"); await ready; return socket; },
    async read(reader: Reader, id = A) {
      const promise = reader.inspect(id).catch(error => error as Error); await ticks();
      const socket = sockets.at(-1)!;
      const wire = JSON.parse(socket.writes.at(-1)!) as { id: string; method: string; params: object };
      return { promise, socket, wire };
    },
    finish() { client.close(); timers.clear(); },
  };
}
const inventory = (surfaces: unknown = [{ id: A, type: "browser" }], workspace: unknown = B, window: unknown = C) => ({ workspace_id: workspace, window_id: window, surfaces });
const passes: string[] = [], failures: Array<{ name: string; error: string }> = [];
async function scenario(name: string, run: (h: ReturnType<typeof harness>) => Promise<void>) {
  const h = harness(); try { await run(h); passes.push(name); }
  catch (error) { failures.push({ name, error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
  finally { h.finish(); await ticks(); }
}
await scenario("capture cannot acquire a disconnected client or accept invalid timeouts", async h => {
  assert.throws(() => capture(h.client, 100), /connection/); assert.equal(h.sockets.length, 0);
  await h.connect();
  for (const ms of [0, -1, NaN, Infinity]) assert.throws(() => capture(h.client, ms), /timeout/);
  assert.equal(h.sockets[0]!.writes.length, 0);
});
await scenario("surface-only UUID read includes hidden deferred browser without URL materialization", async h => {
  await h.connect(); const reader = capture(h.client, 321);
  const read = await h.read(reader, A.toUpperCase());
  assert.equal(read.wire.method, "surface.list"); assert.deepEqual(read.wire.params, { surface_id: A });
  assert.equal([...h.timers.values()].some(timer => timer.ms === 321), true);
  read.socket.reply({ id: read.wire.id, ok: true, result: inventory([{ id: A.toUpperCase(), type: "browser", title: "", focused: false, selected_in_pane: false, pane_id: null }]) });
  assert.deepEqual(await read.promise, { surfaceId: A, workspaceId: B, windowId: C });
  assert.equal(read.socket.writes.length, 1); assert.equal(h.sockets.length, 1);
});
await scenario("current owner and window-Dock identity come from exact surface query", async h => {
  await h.connect(); const reader = capture(h.client, 100);
  for (const [workspace, window] of [[B, null], [C, C], [B, C]] as const) {
    const read = await h.read(reader); read.socket.reply({ id: read.wire.id, ok: true, result: inventory(undefined, workspace, window) });
    assert.deepEqual(await read.promise, { surfaceId: A, workspaceId: workspace, windowId: window });
    assert.deepEqual(read.wire.params, { surface_id: A });
  }
});
await scenario("invalid selectors never query default workspace or create a surface", async h => {
  await h.connect(); const reader = capture(h.client, 100);
  for (const id of ["", "surface:1", "PAGE1", "about:blank", " " + A, "window-dock", undefined, 4]) {
    await assert.rejects(reader.inspect(id as string), /UUID/);
  }
  assert.equal(h.sockets[0]!.writes.length, 0); assert.equal(h.sockets.length, 1);
});
await scenario("well-formed other rows are tolerated but missing or nonbrowser target is not absence", async h => {
  await h.connect(); const reader = capture(h.client, 100);
  for (const type of ["terminal", "filepreview", "extensionBrowser", "future-panel"]) {
    const read = await h.read(reader); read.socket.reply({ id: read.wire.id, ok: true, result: inventory([{ id: B, type }, { id: A, type: "browser" }]) });
    assert.deepEqual(await read.promise, { surfaceId: A, workspaceId: B, windowId: C });
  }
  for (const rows of [[], [{ id: B, type: "browser" }], [{ id: A, type: "terminal" }]]) {
    const read = await h.read(reader); read.socket.reply({ id: read.wire.id, ok: true, result: inventory(rows) });
    const result = await read.promise; assert(result instanceof Error); assert.match(result.message, /missing|not a browser/);
  }
});
await scenario("complete inventory must validate including malformed later rows and normalized duplicates", async h => {
  await h.connect(); const reader = capture(h.client, 100);
  const invalid = [
    inventory([], undefined, C), inventory([], B, undefined), inventory([], "workspace:1", C), inventory([], B, 4),
    inventory(null), inventory([{ id: A, type: "browser" }, null]),
    inventory([{ id: A, type: "browser" }, { id: A.toUpperCase(), type: "browser" }]),
    inventory([{ id: A, type: "browser" }, { id: B, type: "" }]),
    inventory([{ id: A, type: "browser" }, { id: "surface:2", type: "terminal" }]),
  ];
  // Explicitly remove required keys; default parameters above produce valid UUIDs.
  delete (invalid[0] as Partial<ReturnType<typeof inventory>>).workspace_id;
  delete (invalid[1] as Partial<ReturnType<typeof inventory>>).window_id;
  for (const value of invalid) {
    const read = await h.read(reader); read.socket.reply({ id: read.wire.id, ok: true, result: value });
    const result = await read.promise; assert(result instanceof Error); assert.match(result.message, /inventory/);
  }
});
await scenario("correlated not-found remains structured server evidence, no false closed success", async h => {
  await h.connect(); const reader = capture(h.client, 100);
  for (const code of ["not_found", "unavailable", "invalid_params", "permission_denied"]) {
    const read = await h.read(reader); read.socket.reply({ id: read.wire.id, ok: false, error: { code, message: "Workspace not found", data: { selector: A } } });
    const result = await read.promise; assert(result instanceof Error);
    assert.equal((result as Error & { code?: string }).code, code);
    assert.deepEqual((result as Error & { data?: unknown }).data, { selector: A });
    assert.equal(read.socket.destroyed, false);
  }
  const read = await h.read(reader); read.socket.reply({ id: read.wire.id, ok: true, result: inventory() });
  assert.deepEqual(await read.promise, { surfaceId: A, workspaceId: B, windowId: C });
});
await scenario("replacement connection cannot satisfy retained reader or revive queued reads", async h => {
  const original = await h.connect(); const reader = capture(h.client, 100);
  const first = await h.read(reader); const queued = reader.inspect(B).catch(error => error as Error);
  original.emit("close"); const current = await h.connect();
  original.reply({ id: first.wire.id, ok: true, result: inventory() });
  assert(await first.promise instanceof Error); assert(await queued instanceof Error);
  await assert.rejects(reader.inspect(A), /connection/); assert.equal(current.writes.length, 0);
  // A deliberate fresh capture is usable; the retained historical reader is not rebound.
  const fresh = await h.read(capture(h.client, 100)); current.reply({ id: fresh.wire.id, ok: true, result: inventory() });
  assert.deepEqual(await fresh.promise, { surfaceId: A, workspaceId: B, windowId: C });
  assert.equal(h.sockets.length, 2);
});
await scenario("connection loss after response suppresses both positive and negative evidence", async h => {
  for (const ok of [true, false]) {
    await h.connect(); const read = await h.read(capture(h.client, 100));
    read.socket.reply(ok ? { id: read.wire.id, ok, result: inventory() } : { id: read.wire.id, ok, error: { code: "not_found", message: "Workspace not found" } });
    read.socket.emit("close"); const result = await read.promise;
    assert(result instanceof Error); assert.match(result.message, /connection/); assert.equal((result as Error & { code?: string }).code, undefined);
  }
});
await scenario("reader rechecks loss after the actual client has already settled", async h => {
  const request = h.client.request.bind(h.client);
  h.client.request = async (...args) => {
    try { return await request(...args); }
    finally { h.sockets.at(-1)!.emit("close"); }
  };
  for (const ok of [true, false]) {
    await h.connect(); const read = await h.read(capture(h.client, 100));
    read.socket.reply(ok ? { id: read.wire.id, ok, result: inventory() } : { id: read.wire.id, ok, error: { code: "not_found", message: "Workspace not found" } });
    const result = await read.promise; assert(result instanceof Error); assert.match(result.message, /Original cmux observation connection/);
    assert.equal((result as Error & { code?: string }).code, undefined);
  }
});
await scenario("foreign checked response retires stream without querying a replacement", async h => {
  await h.connect(); const read = await h.read(capture(h.client, 100));
  read.socket.reply({ id: "foreign", ok: true, result: inventory() });
  const result = await read.promise; assert(result instanceof Error); assert.equal(read.socket.destroyed, true); assert.equal(h.sockets.length, 1);
});
await scenario("timeout rejects read, retires original stream, and never automatically retries", async h => {
  await h.connect(); const read = await h.read(capture(h.client, 731));
  const timer = [...h.timers.values()].find(t => t.ms === 731); assert(timer); timer.callback();
  const result = await read.promise; assert(result instanceof Error); assert.equal(read.socket.destroyed, true);
  assert.equal(read.socket.writes.length, 1); assert.equal(h.sockets.length, 1);
});
console.log(JSON.stringify({ selected: [clientPath, readerPath].map((path, i) => ({ path, sha256: createHash("sha256").update([clientSource, readerSource][i]!).digest("hex") })), passes, failures, counts: { pass: passes.length, fail: failures.length }, evidence: "Actual selected reader/client with controlled sockets, timer callbacks and errors; no native socket/runtime, no server incarnation or absence authority." }, null, 2));
if (failures.length) process.exitCode = 1;
