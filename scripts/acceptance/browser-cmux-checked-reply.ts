/** Whole selected cmux client, controlled socket/credential/timer boundaries only. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
const selectedPath = process.argv[2];
if (!selectedPath) throw new Error("Pass the exact selected socket-client.ts");
const source = await readFile(selectedPath, "utf8"), offset = source.indexOf("const DEFAULT_CONNECT_TIMEOUT_MS"); assert(offset >= 0);
const selected = source.slice(offset), body = new Bun.Transpiler({ loader: "ts" }).transformSync(selected.replaceAll("export ", ""));
type Options = { timeoutMs?: number; connectionGeneration?: number; checkedReply?: boolean };
type Client = { connect(): Promise<void>; close(): void; readonly connectionGeneration?: number; request(method: string, params: Record<string, unknown>, opts?: Options): Promise<Record<string, unknown>> };
class Socket extends EventEmitter {
  destroyed = false; writes: string[] = [];
  setEncoding(_value: string) { return this; }
  write(raw: string, _cb: (error?: Error) => void) { this.writes.push(raw); return true; }
  end() { return this; } destroy() { this.destroyed = true; return this; }
  reply(value: unknown) { this.emit("data", JSON.stringify(value) + "\n"); }
}
const ticks = async () => { for (let i = 0; i < 18; i++) await Promise.resolve(); };
function harness() {
  const sockets: Socket[] = [], timers = new Map<number, () => void>(); let next = 0;
  const Class = new Function("randomUUID", "net", "os", "path", "ToolError", "setTimeout", "clearTimeout", `${body}\nreturn CmuxSocketClient;`)(
    randomUUID, { createConnection() { const s = new Socket(); sockets.push(s); return s; } },
    { homedir() { throw new Error("Unexpected credentials"); } }, {}, Error,
    (fn: () => void) => { timers.set(++next, fn); return next; }, (id: number) => { timers.delete(id); },
  ) as new (options: object) => Client;
  const client = new Class({ socketPath: "/controlled/cmux.sock", relayId: "", relayToken: "" });
  return {
    client, sockets, timers,
    async connect() { const ready = client.connect(); const socket = sockets.at(-1)!; socket.emit("connect"); await ready; return socket; },
    async request(params: Record<string, unknown> = { surface_id: "exact" }, checked = true) {
      const promise = client.request("surface.list", params, { connectionGeneration: client.connectionGeneration, checkedReply: checked }).catch(error => error as Error);
      await ticks(); const socket = sockets.at(-1)!; return { promise, socket, wire: JSON.parse(socket.writes.at(-1)!) as { id: string; method: string; params: Record<string, unknown> } };
    },
    finish() { client.close(); timers.clear(); },
  };
}
const passed: string[] = [], failures: Array<{ name: string; error: string }> = [];
async function scenario(name: string, run: (h: ReturnType<typeof harness>) => Promise<void>) {
  const h = harness(); try { await h.connect(); await run(h); passed.push(name); }
  catch (error) { failures.push({ name, error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
  finally { h.finish(); await ticks(); }
}
await scenario("foreign success cannot satisfy checked request or leave its stream reusable", async h => {
  const { promise, socket, wire } = await h.request(); socket.reply({ id: wire.id + "-foreign", ok: true, result: { surfaces: [] } });
  const result = await promise; assert(result instanceof Error, "foreign response must not succeed"); assert.match(result.message, /identity mismatch/);
  assert.equal(socket.destroyed, true); assert.equal(h.client.connectionGeneration, undefined);
  const next = await h.connect(); const valid = await h.request();
  socket.reply({ id: valid.wire.id, ok: true, result: { foreign: true } });
  next.reply({ id: valid.wire.id, ok: true, result: { original: true } }); assert.deepEqual(await valid.promise, { original: true });
});
await scenario("matching server failure retains structured code and nested metadata", async h => {
  const { promise, socket, wire } = await h.request();
  socket.reply({ id: wire.id, ok: false, error: { code: "not_found", message: "Workspace not found", data: { surface_id: "exact", nested: [1, 2] }, details: { retry: false } } });
  const result = await promise; assert(result instanceof Error); const error = result as Error & { code?: string; data?: unknown; details?: unknown };
  assert.equal(error.code, "not_found"); assert.deepEqual(error.data, { surface_id: "exact", nested: [1, 2] }); assert.deepEqual(error.details, { retry: false });
  assert.equal(error.message, 'not_found: Workspace not found details={"retry":false}'); assert.equal(socket.destroyed, false);
  const valid = await h.request(); socket.reply({ id: valid.wire.id, ok: true, result: { surfaces: [] } }); assert.deepEqual(await valid.promise, { surfaces: [] });
});
await scenario("queued checked request retains caller's original nested params", async h => {
  const first = await h.request({ blocker: true }, false);
  const params = { surface_id: "original", nested: { ids: ["A"] } };
  const waiting = h.client.request("surface.list", params, { connectionGeneration: 1, checkedReply: true }).catch(error => error as Error);
  params.surface_id = "replacement"; params.nested.ids[0] = "B";
  first.socket.reply({ ok: true, result: {} }); await first.promise; await ticks();
  const wire = JSON.parse(first.socket.writes[1]!) as { id: string; params: object };
  first.socket.reply({ id: wire.id, ok: true, result: {} }); await waiting;
  assert.deepEqual(wire.params, { surface_id: "original", nested: { ids: ["A"] } });
  assert.equal(first.socket.writes.length, 2);
});
await scenario("matching error delivered before socket loss cannot survive as server evidence", async h => {
  const { promise, socket, wire } = await h.request();
  socket.reply({ id: wire.id, ok: false, error: { code: "not_found", message: "Workspace not found" } }); socket.emit("close");
  const result = await promise; assert(result instanceof Error); assert.match(result.message, /connection.*no longer available/);
  assert.equal((result as Error & { code?: string }).code, undefined); assert.equal(h.sockets.length, 1);
});
if (!process.argv.includes("--pair")) {
  await scenario("valid correlated success keeps socket and original method", async h => {
    const { promise, socket, wire } = await h.request(); assert.equal(wire.method, "surface.list"); assert.deepEqual(wire.params, { surface_id: "exact" });
    socket.reply({ id: wire.id, ok: true, result: { surfaces: [{ id: "exact", type: "browser" }] } });
    assert.deepEqual(await promise, { surfaces: [{ id: "exact", type: "browser" }] }); assert.equal(h.client.connectionGeneration, 1); assert.equal(socket.destroyed, false);
  });
  await scenario("malformed envelopes retire original stream and never return typed not-found", async h => {
    const cases = [
      (_id: string) => ({ ok: true, result: {} }),
      (id: string) => ({ id, ok: true, result: null }),
      (id: string) => ({ id, ok: true, result: [] }),
      (id: string) => ({ id, ok: "true", result: {} }),
      (id: string) => ({ id, ok: true, result: {}, error: { code: "not_found", message: "gone" } }),
      (id: string) => ({ id, ok: false, result: {}, error: { code: "not_found", message: "gone" } }),
      (id: string) => ({ id, ok: false, error: null }),
      (id: string) => ({ id, ok: false, error: { code: 4, message: "not found" } }),
      (id: string) => ({ id, ok: false, error: { code: "not_found", message: "" } }),
      (id: string) => ({ id: id + "other", ok: false, error: { code: "not_found", message: "Workspace not found" } }),
      (_id: string) => [],
    ];
    for (let i = 0; i < cases.length; i++) {
      if (i > 0) await h.connect(); const { promise, socket, wire } = await h.request(); socket.reply(cases[i]!(wire.id));
      const result = await promise; assert(result instanceof Error); assert.match(result.message, /checked cmux|Checked cmux/);
      assert.equal((result as Error & { code?: string }).code, undefined); assert.equal(socket.destroyed, true);
    }
  });
  await scenario("legacy id-less success and error formatting remain unchanged", async h => {
    for (const value of [undefined, null, {}, []]) {
      const read = await h.request({}, false); read.socket.reply({ ok: true, result: value }); assert.deepEqual(await read.promise, value ?? {});
    }
    const read = await h.request({}, false); read.socket.reply({ ok: false, error: { code: "denied", message: "No access", details: { why: "policy" } } });
    const result = await read.promise; assert(result instanceof Error); assert.equal(result.message, 'denied: No access details={"why":"policy"}'); assert.equal(read.socket.destroyed, false);
  });
  await scenario("checked requests require valid original generation before allocation", async h => {
    const socket = h.sockets[0]!;
    for (const opts of [{ checkedReply: true }, { checkedReply: true, connectionGeneration: 0 }, { checkedReply: true, connectionGeneration: 2 }, { checkedReply: null, connectionGeneration: 1 }]) {
      await assert.rejects(h.client.request("surface.list", {}, opts as Options), /generation|connection|option/);
    }
    assert.equal(socket.writes.length, 0); assert.equal(h.sockets.length, 1);
  });
  await scenario("checked serialization rejects unsupported params and observes connection loss", async h => {
    const socket = h.sockets[0]!;
    for (const params of [[], null, { toJSON() { return undefined; } }]) {
      await assert.rejects(h.client.request("surface.list", params as unknown as Record<string, unknown>, { checkedReply: true, connectionGeneration: 1 }));
    }
    await assert.rejects(h.client.request("surface.list", { toJSON() { socket.emit("close"); return { surface_id: "original" }; } }, { checkedReply: true, connectionGeneration: 1 }), /connection/);
    assert.equal(socket.writes.length, 0); assert.equal(h.sockets.length, 1);
  });
  await scenario("queued checked read cannot reconnect behind failed protocol", async h => {
    const first = await h.request();
    const waiting = h.client.request("surface.list", { surface_id: "next" }, { checkedReply: true, connectionGeneration: 1 }).catch(error => error as Error);
    first.socket.reply({ id: first.wire.id + "wrong", ok: true, result: {} });
    const [a, b] = await Promise.all([first.promise, waiting]); assert(a instanceof Error); assert(b instanceof Error); assert.match(b.message, /connection/);
    assert.equal(first.socket.writes.length, 1); assert.equal(h.sockets.length, 1);
  });
  await scenario("malformed JSON retires checked stream; explicit new connection stays separate", async h => {
    const read = await h.request(); read.socket.emit("data", "{malformed\n");
    const result = await read.promise; assert(result instanceof Error); assert.match(result.message, /JSON/); assert.equal(read.socket.destroyed, true);
    const current = await h.connect(); assert.equal(h.client.connectionGeneration, 2); assert.equal(current.destroyed, false);
    read.socket.emit("data", "ERROR: stale\n"); assert.equal(h.client.connectionGeneration, 2);
  });
}
console.log(JSON.stringify({ selectedPath, sha256: createHash("sha256").update(source).digest("hex"), bytes: Buffer.byteLength(source), completeSuffixSha256: createHash("sha256").update(selected).digest("hex"), passed, failures, counts: { pass: passed.length, fail: failures.length }, evidence: "Controlled sockets/credentials/timers; no SDK import or runtime. Correlated not-found is server evidence, not physical absence." }, null, 2));
if (failures.length) process.exitCode = 1;
