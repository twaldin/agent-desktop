/** Execute the complete selected cmux client with controlled sockets, never a native client or network. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";

const selectedPath = process.argv[2];
if (!selectedPath) throw new Error("Pass the exact maintained socket-client.ts source.");
const source = await readFile(selectedPath, "utf8");
const selected = source.slice(source.indexOf("const DEFAULT_CONNECT_TIMEOUT_MS"));
assert(source.indexOf("const DEFAULT_CONNECT_TIMEOUT_MS") >= 0);
const body = new Bun.Transpiler({ loader: "ts" }).transformSync(selected.replaceAll("export ", ""));
type Client = {
  readonly connectionGeneration?: number;
  connect(): Promise<void>;
  request(method: string, params: Record<string, unknown>, options?: { timeoutMs?: number; connectionGeneration?: number }): Promise<Record<string, unknown>>;
  close(): void;
};
class Socket extends EventEmitter {
  destroyed = false;
  readonly writes: string[] = [];
  readonly writeCallbacks: Array<(error?: Error) => void> = [];
  setEncoding(_encoding: string) { return this; }
  write(line: string, callback: (error?: Error) => void) { this.writes.push(line); this.writeCallbacks.push(callback); return true; }
  end() { return this; }
  destroy() { this.destroyed = true; return this; }
  respond(result: Record<string, unknown>) { this.emit("data", JSON.stringify({ ok: true, result }) + "\n"); }
}
function harness(password?: string) {
  const sockets: Socket[] = [];
  const make = new Function("randomUUID", "net", "os", "path", "ToolError", `${body}\nreturn CmuxSocketClient;`)(
    randomUUID, { createConnection() { const socket = new Socket(); sockets.push(socket); return socket; } },
    { homedir() { throw new Error("Unexpected relay credential access"); } }, {}, Error,
  ) as new (options: object) => Client;
  const client = new make({ socketPath: "/controlled/cmux.sock", password, relayId: "", relayToken: "" });
  return {
    client, sockets,
    async connect() { const pending = client.connect(); const socket = sockets.at(-1)!; socket.emit("connect"); await pending; return socket; },
    finish() { client.close(); },
  };
}
const ticks = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const failures: Array<{ name: string; message: string }> = [], passed: string[] = [];
async function scenario(name: string, run: (h: ReturnType<typeof harness>) => Promise<void>, password?: string) {
  const h = harness(password);
  try { await run(h); passed.push(name); }
  catch (error) { failures.push({ name, message: error instanceof Error ? error.stack ?? error.message : String(error) }); }
  finally { h.finish(); await ticks(); }
}
const pair = process.argv.includes("--pair");

await scenario("captured connection cannot reconnect after loss before request", async h => {
  const original = await h.connect();
  original.emit("close");
  const pending = h.client.request("surface.list", { surface_id: "original" }, { connectionGeneration: 1 }).catch(error => error as Error);
  await ticks();
  // Settle an old client's unexpected connect before assertions; do not leave a timer or promise behind.
  if (h.sockets.length > 1) { const replacement = h.sockets[1]!; replacement.emit("connect"); await ticks(); replacement.respond({ surfaces: [] }); }
  const result = await pending;
  assert.equal(h.sockets.length, 1, "an observation must not establish a replacement connection");
  assert(result instanceof Error); assert.match(result.message, /connection.*no longer available/);
  assert.equal(original.writes.length, 0);
});
await scenario("captured request waiting behind another job cannot dispatch after loss", async h => {
  const original = await h.connect();
  const first = h.client.request("surface.list", { surface_id: "first" }).catch(error => error as Error);
  await ticks();
  const waiting = h.client.request("surface.list", { surface_id: "waiting" }, { connectionGeneration: 1 }).catch(error => error as Error);
  original.respond({ surfaces: [] });
  original.emit("close"); // The reply is delivered, but the queued job has not run yet.
  await ticks();
  if (h.sockets.length > 1) { const replacement = h.sockets[1]!; replacement.emit("connect"); await ticks(); replacement.respond({ surfaces: [] }); }
  await first; const result = await waiting;
  assert.equal(h.sockets.length, 1, "queued observation cannot reconnect");
  assert.equal(original.writes.length, 1, "only the already-dispatched request is sent");
  assert(result instanceof Error); assert.match(result.message, /connection.*no longer available/);
});
await scenario("reply followed by connection loss cannot publish an observation", async h => {
  const original = await h.connect();
  const pending = h.client.request("surface.list", { surface_id: "original" }, { connectionGeneration: 1 }).catch(error => error as Error);
  await ticks(); original.respond({ surfaces: [] }); original.emit("close");
  const result = await pending;
  assert(result instanceof Error, "a result from the retired socket cannot become absence evidence");
  assert.match(result.message, /connection.*no longer available/);
  assert.equal(h.sockets.length, 1);
});

if (!pair) {
  await scenario("generation is absent before authentication and fresh after reconnect", async h => {
    assert.equal(h.client.connectionGeneration, undefined);
    const original = await h.connect(); assert.equal(h.client.connectionGeneration, 1);
    original.emit("close"); assert.equal(h.client.connectionGeneration, undefined);
    const replacement = await h.connect(); assert.equal(h.client.connectionGeneration, 2);
    const rejected = h.client.request("surface.list", {}, { connectionGeneration: 1 });
    await assert.rejects(rejected, /connection.*no longer available/);
    assert.equal(replacement.writes.length, 0);
    h.client.close(); assert.equal(h.client.connectionGeneration, undefined);
  });
  await scenario("matching current connection preserves request and successful response", async h => {
    const socket = await h.connect(); const generation = h.client.connectionGeneration;
    assert.equal(generation, 1);
    const pending = h.client.request("surface.list", { surface_id: "durable-uuid" }, { connectionGeneration: generation });
    await ticks();
    const request = JSON.parse(socket.writes[0]!);
    assert.equal(request.method, "surface.list"); assert.deepEqual(request.params, { surface_id: "durable-uuid" });
    socket.respond({ surfaces: [{ id: "durable-uuid", type: "browser" }] });
    assert.deepEqual(await pending, { surfaces: [{ id: "durable-uuid", type: "browser" }] });
    assert.equal(h.sockets.length, 1);
  });
  await scenario("ordinary callers retain automatic connection and reconnect", async h => {
    const first = h.client.request("browser.url.get", { surface_id: "original" });
    h.sockets[0]!.emit("connect"); await ticks(); h.sockets[0]!.respond({ url: "https://first.example" });
    assert.deepEqual(await first, { url: "https://first.example" });
    h.sockets[0]!.emit("close");
    const second = h.client.request("browser.url.get", { surface_id: "original" });
    h.sockets[1]!.emit("connect"); await ticks(); h.sockets[1]!.respond({ url: "https://second.example" });
    assert.deepEqual(await second, { url: "https://second.example" }); assert.equal(h.sockets.length, 2);
  });
  await scenario("invalid generations reject without connection or dispatch", async h => {
    for (const generation of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(h.client.request("surface.list", {}, { connectionGeneration: generation }), /connection.*no longer available/);
    }
    assert.equal(h.sockets.length, 0);
  });
  await scenario("old socket events do not retire or feed a replacement connection", async h => {
    const original = await h.connect();
    const prior = h.client.request("surface.list", {}); await ticks(); original.respond({ surfaces: [] }); await prior;
    original.emit("close"); const replacement = await h.connect();
    const pending = h.client.request("surface.list", {}, { connectionGeneration: 2 });
    let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
    await ticks(); original.respond({ surfaces: [] }); original.emit("error", new Error("retired socket")); original.emit("close");
    original.writeCallbacks[0]!(new Error("late write error")); await ticks();
    assert.equal(settled, false); assert.equal(h.client.connectionGeneration, 2); assert.equal(replacement.destroyed, false);
    replacement.respond({ surfaces: [{ id: "still-present" }] });
    assert.deepEqual(await pending, { surfaces: [{ id: "still-present" }] });
  });
  await scenario("serialization cannot send a guarded request after synchronous connection loss", async h => {
    const socket = await h.connect();
    await assert.rejects(h.client.request("surface.list", { toJSON() { socket.emit("close"); return { surface_id: "original" }; } }, { connectionGeneration: 1 }), /connection.*no longer available/);
    assert.equal(socket.writes.length, 0); assert.equal(h.sockets.length, 1);
  });
  await scenario("socket failure and malformed replies are errors, not successful absence", async h => {
    const original = await h.connect();
    const malformed = h.client.request("surface.list", {}, { connectionGeneration: 1 });
    original.emit("data", "not-json\n"); await assert.rejects(malformed, /Invalid cmux socket JSON/);
    const failed = h.client.request("surface.list", {}, { connectionGeneration: 1 });
    original.emit("error", new Error("connection lost")); await assert.rejects(failed, /connection lost/);
    assert.equal(h.client.connectionGeneration, undefined); assert.equal(h.sockets.length, 1);
  });
  await scenario("generation is unavailable until password handshake settles", async h => {
    const connecting = h.client.connect(); const socket = h.sockets[0]!; socket.emit("connect"); await ticks();
    assert.equal(h.client.connectionGeneration, undefined);
    await assert.rejects(h.client.request("surface.list", {}, { connectionGeneration: 1 }), /connection.*no longer available/);
    assert.deepEqual(socket.writes, ["auth fixture-password\n"]);
    socket.emit("data", "OK\n"); await connecting; assert.equal(h.client.connectionGeneration, 1);
  }, "fixture-password");
  await scenario("close during handshake cannot republish a connected generation", async h => {
    const connecting = h.client.connect(); const socket = h.sockets[0]!; socket.emit("connect"); await ticks();
    h.client.close(); await assert.rejects(connecting, /closed|changed/);
    socket.emit("data", "OK\n"); await ticks(); assert.equal(h.client.connectionGeneration, undefined);
    await assert.rejects(h.client.request("surface.list", {}, { connectionGeneration: 1 }), /closed/);
    assert.equal(h.sockets.length, 1);
  }, "fixture-password");
  await scenario("old handshake completion cannot clear a replacement handshake", async h => {
    const old = h.client.connect().catch(error => error as Error); const original = h.sockets[0]!;
    original.emit("connect"); await ticks(); original.emit("close");
    const current = h.client.connect(); const replacement = h.sockets[1]!;
    replacement.emit("connect"); await ticks(); assert((await old) instanceof Error);
    const joining = h.client.connect(); await ticks();
    // An incorrect old finally can cause a third connect. Settle it before reporting the failure.
    if (h.sockets.length > 2) { h.sockets[2]!.emit("connect"); await ticks(); h.sockets[2]!.emit("data", "OK\n"); }
    replacement.emit("data", "OK\n"); await Promise.all([current, joining]);
    assert.equal(h.sockets.length, 2); assert.deepEqual(replacement.writes, ["auth fixture-password\n"]);
    assert.equal(h.client.connectionGeneration, 1);
  }, "fixture-password");
}
console.log(JSON.stringify({ selectedPath, sourceSha256: createHash("sha256").update(source).digest("hex"), selectedBodySha256: createHash("sha256").update(selected).digest("hex"), passed, failures, limits: "Complete selected class, controlled EventEmitter/socket IO only; no installed SDK import, real socket, auth service or native surface observation." }, null, 2));
if (failures.length) process.exitCode = 1;
