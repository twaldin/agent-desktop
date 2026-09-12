/** Execute exact selected cmux class with held crypto callbacks and controlled sockets/timers. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
const selectedPath = process.argv[2];
if (!selectedPath) throw new Error("Pass the exact selected cmux socket-client.ts");
const source = await readFile(selectedPath, "utf8");
const offset = source.indexOf("const DEFAULT_CONNECT_TIMEOUT_MS"); assert(offset >= 0);
const selected = source.slice(offset), body = new Bun.Transpiler({ loader: "ts" }).transformSync(selected.replaceAll("export ", ""));
type Client = { connect(): Promise<void>; close(): void; readonly connectionGeneration?: number; request(method: string, params: object, opts?: { connectionGeneration?: number }): Promise<object> };
class Socket extends EventEmitter {
  destroyed = false; readonly writes: string[] = []; readonly callbacks: Array<(error?: Error) => void> = [];
  setEncoding(_encoding: string) { return this; }
  write(line: string, callback: (error?: Error) => void) { this.writes.push(line); this.callbacks.push(callback); return true; }
  end() { return this; } destroy() { this.destroyed = true; return this; }
  line(value: unknown) { this.emit("data", JSON.stringify(value) + "\n"); }
}
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; }
const ticks = async () => { for (let i = 0; i < 18; i++) await Promise.resolve(); };
function harness(password?: string) {
  const sockets: Socket[] = [], imports: Array<ReturnType<typeof deferred<object>>> = [], signs: Array<{ gate: ReturnType<typeof deferred<ArrayBuffer>>; message: string; key: object }> = [];
  const timers = new Map<number, () => void>(); let timerId = 0; const pending: Promise<void | Error>[] = [];
  const subtle = {
    importKey(format: string, bytes: Uint8Array, algorithm: unknown, extractable: boolean, usages: string[]) {
      assert.equal(format, "raw"); assert.deepEqual([...bytes], [0xaa]); assert.deepEqual(algorithm, { name: "HMAC", hash: "SHA-256" }); assert.equal(extractable, false); assert.deepEqual(usages, ["sign"]);
      const gate = deferred<object>(); imports.push(gate); return gate.promise;
    },
    sign(algorithm: string, key: object, bytes: Uint8Array) {
      assert.equal(algorithm, "HMAC"); const gate = deferred<ArrayBuffer>(); signs.push({ gate, key, message: new TextDecoder().decode(bytes) }); return gate.promise;
    },
  };
  const Class = new Function("randomUUID", "net", "os", "path", "ToolError", "globalThis", "setTimeout", "clearTimeout", `${body}\nreturn CmuxSocketClient;`)(
    randomUUID, { createConnection(options: unknown) { assert.deepEqual(options, { host: "127.0.0.1", port: 55123 }); const s = new Socket(); sockets.push(s); return s; } },
    { homedir() { throw new Error("Unexpected personal credential lookup"); } }, {}, Error, { crypto: { subtle } },
    (fn: () => void) => { timers.set(++timerId, fn); return timerId; }, (id: number) => { timers.delete(id); },
  ) as new (opts: object) => Client;
  const client = new Class({ socketPath: "localhost:55123", relayId: "fixture-relay", relayToken: "aa", password });
  return {
    client, sockets, imports, signs, timers,
    start() { const p = client.connect().catch(e => e instanceof Error ? e : new Error(String(e))); pending.push(p); return p; },
    async challenge(nonce: string) { await ticks(); const socket = sockets.at(-1)!; socket.emit("connect"); await ticks(); socket.line({ protocol: "cmux-relay-auth", version: 1, relay_id: "fixture-relay", nonce }); await ticks(); return socket; },
    async key(index: number) { imports[index]!.resolve({ key: index }); await ticks(); },
    async mac(index: number) { const bytes = new Uint8Array([index + 1]); signs[index]!.gate.resolve(bytes.buffer); await ticks(); },
    fireCurrentTimers() { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); },
    async finish() {
      client.close();
      for (let round = 0; round < 4; round++) { imports.forEach((g, i) => g.resolve({ key: i })); signs.forEach(s => s.gate.resolve(new Uint8Array([1]).buffer)); await ticks(); }
      for (const fn of timers.values()) fn(); timers.clear(); await Promise.all(pending);
    },
  };
}
const passed: string[] = [], failures: Array<{ name: string; message: string }> = [];
async function scenario(name: string, test: (h: ReturnType<typeof harness>) => Promise<void>, password?: string) {
  const h = harness(password);
  try { await test(h); passed.push(name); }
  catch (error) { failures.push({ name, message: error instanceof Error ? error.stack ?? error.message : String(error) }); }
  finally { await h.finish(); }
}
async function overlap(h: ReturnType<typeof harness>, hold: "import" | "sign", expire: boolean) {
  const old = h.start(); const a = await h.challenge("challenge-A");
  if (hold === "sign") { await h.key(0); assert.equal(h.signs.length, 1); }
  a.emit("close"); const current = h.start(); const b = await h.challenge("challenge-B");
  assert.equal(h.imports.length, 2); assert.equal(h.client.connectionGeneration, undefined);
  if (hold === "import") { await h.key(0); if (h.signs.length) await h.mac(0); }
  else await h.mac(0);
  const foreignWrites = [...b.writes];
  if (expire && foreignWrites.length) h.fireCurrentTimers();
  else if (foreignWrites.length) { b.line({ ok: true }); await ticks(); } // Settle old bad auth, not manufacture a passing observation.
  const destroyedByOld = b.destroyed;
  await h.key(1); const bSign = h.signs.findIndex(s => s.message.includes("challenge-B"));
  if (bSign >= 0) await h.mac(bSign);
  if (!b.destroyed && b.writes.length > foreignWrites.length) b.line({ ok: true });
  await ticks();
  const oldResult = await old, currentResult = await current;
  if (expire) assert.equal(destroyedByOld, false, "old authentication read timeout must not destroy replacement B");
  else assert.deepEqual(foreignWrites, [], "challenge-A authentication must never be written onto B");
  assert(oldResult instanceof Error); assert.match(oldResult.message, /connection changed/);
  assert.equal(currentResult, undefined); assert.equal(h.client.connectionGeneration, 1); assert.equal(h.sockets.length, 2);
  assert.equal(b.writes.length, 1); assert.equal(h.timers.size, 0);
  const read = h.client.request("surface.list", { surface_id: "retained-original" }, { connectionGeneration: 1 }); await ticks();
  b.line({ ok: true, result: { surfaces: [{ id: "retained-original" }] } });
  assert.deepEqual(await read, { surfaces: [{ id: "retained-original" }] });
}
await scenario("relay importKey A held across replacement cannot write A auth on B", h => overlap(h, "import", false));
await scenario("relay sign A held across replacement cannot write A auth on B", h => overlap(h, "sign", false));
await scenario("retired relay authentication cannot install a timeout that destroys B", h => overlap(h, "sign", true));
if (!process.argv.includes("--pair")) {
  await scenario("matching relay handshake and optional password preserve configured protocol", async h => {
    const pending = h.start(), socket = await h.challenge("same-owner");
    await h.key(0); assert.equal(h.signs[0]!.message, "relay_id=fixture-relay\nnonce=same-owner\nversion=1");
    await h.mac(0); assert.deepEqual(JSON.parse(socket.writes[0]!), { relay_id: "fixture-relay", mac: "01" }); assert.equal(h.client.connectionGeneration, undefined);
    socket.line({ ok: true }); await ticks(); assert.equal(socket.writes[1], "auth fixture-password\n");
    socket.emit("data", "OK\n"); assert.equal(await pending, undefined); assert.equal(h.client.connectionGeneration, 1); assert.equal(h.timers.size, 0);
  }, "fixture-password");
  await scenario("dispose during cryptography rejects before auth or new waiter", async h => {
    const pending = h.start(), socket = await h.challenge("closed"); await h.key(0); h.client.close(); await h.mac(0);
    assert((await pending) instanceof Error); assert.equal(socket.writes.length, 0); assert.equal(h.timers.size, 0); assert.equal(h.client.connectionGeneration, undefined);
  });
  await scenario("import failure from retired A cannot clear B handshake or start a third socket", async h => {
    const old = h.start(), a = await h.challenge("A"); a.emit("close"); const current = h.start(), b = await h.challenge("B");
    h.imports[0]!.reject(new Error("crypto failed")); await ticks(); assert.match((await old as Error).message, /crypto failed/);
    const joining = h.start(); await ticks(); assert.equal(h.sockets.length, 2);
    await h.key(1); await h.mac(0); b.line({ ok: true }); await Promise.all([current, joining]); assert.equal(h.client.connectionGeneration, 1);
  });
  await scenario("relay challenge response loss rejects before cryptography", async h => {
    const pending = h.start(); await ticks(); const socket = h.sockets[0]!; socket.emit("connect"); await ticks();
    socket.line({ protocol: "cmux-relay-auth", version: 1, relay_id: "fixture-relay", nonce: "gone" }); socket.emit("close");
    await ticks(); assert((await pending) instanceof Error); assert.equal(h.imports.length, 0); assert.equal(socket.writes.length, 0);
  });
  await scenario("replayed cleared timer cannot destroy current healthy connection", async h => {
    const pending = h.start(); await ticks(); const socket = h.sockets[0]!; socket.emit("connect"); await ticks();
    const challengeTimer = [...h.timers.values()][0]!;
    socket.line({ protocol: "cmux-relay-auth", version: 1, relay_id: "fixture-relay", nonce: "live" }); await ticks();
    await h.key(0); await h.mac(0); socket.line({ ok: true }); assert.equal(await pending, undefined);
    challengeTimer(); assert.equal(socket.destroyed, false); assert.equal(h.client.connectionGeneration, 1);
  });
}
console.log(JSON.stringify({ selectedPath, sourceSha256: createHash("sha256").update(source).digest("hex"), selectedBodySha256: createHash("sha256").update(selected).digest("hex"), passed, failures, scope: "Complete selected class, controlled sockets/crypto/timers only; no configured credentials, native relay or installed SDK execution" }, null, 2));
if (failures.length) process.exitCode = 1;
