import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import type { SessionSummary } from "@agent-desktop/shared";
import { HostStore } from "./store";
import type { WorkerSession } from "./omp-workers/runtime";
import { SessionExportService } from "./session-export";
import { SessionExportHttp } from "./session-export-http";
import { parseCommandEnvelope } from "./validation";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "html-export-service-")));
  let store = new HostStore(root); cleanup.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const source: SessionSummary = { id: "source", hostId: store.host.id, projectId: null, cwd: root, title: "Saved", status: "idle", sessionFile: join(root, "source.jsonl"), model: null, createdAt: 1, updatedAt: 1, archived: false };
  await writeFile(source.sessionFile, JSON.stringify({ type: "session", version: 3, id: source.id, cwd: root, timestamp: new Date().toISOString() }) + "\n");
  store.upsertSession(source);
  let calls = 0, current = true, output = "", effect = async (path: string) => { await writeFile(path, "<!doctype html><title>Native fixture output</title>"); };
  const handle = { id: source.id, sessionFile: source.sessionFile, cwd: root, isStreaming: false, hasPostPromptWork: false, exportSession: async (input: { outputPath: string }) => { calls++; output = input.outputPath; await effect(input.outputPath); } } as unknown as WorkerSession;
  const service = () => new SessionExportService({ store, dataDirectory: root, current: async () => current, busy: () => false });
  let exports = service();
  const claim = () => store.claimCommand("command", "hash", { type: "session.export", sessionId: source.id, theme: "web" });
  async function run() { const c = claim(); if (c.kind === "done") return c.record.result!; if (c.kind === "pending") return { ok: false as const, commandId: "command", error: { code: "OUTCOME_UNKNOWN", message: "Not replayed" } }; const result = await exports.export("command", source.id, "web", handle); store.finishCommand("command", "hash", result); return result; }
  return { root, source, handle, claim, run, get store() { return store; }, get exports() { return exports; }, get calls() { return calls; }, get output() { return output; }, effect(value: typeof effect) { effect = value; }, retire() { current = false; }, reopen() { store.close(); store = new HostStore(root); exports = service(); } };
}
test("durable duplicates and lost response return one immutable owner-bound artifact across restart", async () => {
  const f = await fixture(), first = await f.run();
  expect(await f.run()).toEqual(first); expect(f.calls).toBe(1);
  const before = await f.exports.artifact(f.source.id, "command");
  expect(before.receipt).not.toHaveProperty("path"); expect(before.receipt).not.toHaveProperty("sessionFile");
  f.reopen(); expect(await f.run()).toEqual(first); expect(f.calls).toBe(1);
  expect((await f.exports.artifact(f.source.id, "command")).bytes).toEqual(before.bytes);
  const http = new SessionExportHttp(f.store.host.id, f.exports), url = `http://host/v1/sessions/source/exports/command/file`;
  expect((await http.route(new Request(url)))?.status).toBe(409);
  const response = await http.route(new Request(url, { headers: { "X-Agent-Host-Id": f.store.host.id } }));
  expect(response?.status).toBe(200); expect(response?.headers.get("Content-Type")).toBe("application/octet-stream");
  expect(await response?.text()).toContain("Native fixture output");
  await writeFile(f.output, "changed"); await expect(f.exports.artifact(f.source.id, "command")).rejects.toThrow("hash");
});
test("lost worker ACK and pending journal restart remain unknown without reexport", async () => {
  const f = await fixture(); f.effect(async path => { await writeFile(path, "native completed"); throw new Error("Lost ACK"); });
  await expect(f.run()).rejects.toThrow("unknown"); expect(f.calls).toBe(1);
  f.reopen(); expect(f.exports.status(f.source.id, "command").state).toBe("unknown");
  expect(await f.run()).toMatchObject({ ok: false, error: { code: "OUTCOME_UNKNOWN" } }); expect(f.calls).toBe(1);
  await expect(f.exports.artifact(f.source.id, "command")).rejects.toThrow("completed");
});
test("worker replacement, native identity changes and client paths refuse before exporter dispatch", async () => {
  const f = await fixture(); f.retire(); await expect(f.run()).rejects.toThrow("original native session"); expect(f.calls).toBe(0);
  expect(() => parseCommandEnvelope({ id: "x", commandVersion: 20, command: { type: "session.export", sessionId: "source", theme: "web", cwd: "/foreign" } })).toThrow();
  expect(() => parseCommandEnvelope({ id: "x", commandVersion: 20, command: { type: "session.export", sessionId: "source", theme: "web", sessionFile: "/foreign" } })).toThrow();
});
test("symlink output and private directory replacement never become readable receipts", async () => {
  const f = await fixture(), outside = join(f.root, "outside.html"); await writeFile(outside, "retain outside");
  f.effect(async path => { await symlink(outside, path); });
  await expect(f.run()).rejects.toThrow("unknown"); expect(await readFile(outside, "utf8")).toBe("retain outside");
  await expect(f.exports.artifact(f.source.id, "command")).rejects.toThrow();
});
test("oversized output stays unconfirmed; original command is never repeated", async () => {
  const f = await fixture(); f.effect(async path => { const file = Bun.file(path); await Bun.write(file, new Uint8Array(32 * 1024 * 1024 + 1)); });
  await expect(f.run()).rejects.toThrow("unknown"); expect(f.calls).toBe(1); expect(await f.run()).toMatchObject({ ok: false });
});
test("private directory replacement refuses after the native boundary", async () => {
  const f = await fixture();
  f.effect(async path => {
    await writeFile(path, "original export");
    const directory = dirname(path), moved = directory + "-retained";
    const { rename } = await import("node:fs/promises");
    await rename(directory, moved); await mkdir(directory, { mode: 0o700 }); await writeFile(path, "replacement export");
  });
  await expect(f.run()).rejects.toThrow("unknown"); await expect(f.exports.artifact(f.source.id, "command")).rejects.toThrow();
  expect(f.store.readMetadata<{ failure: string }>("session-export.v1:command")?.failure).toContain("directory changed");
});
test("worker retirement after writing does not publish the abandoned native artifact", async () => {
  const f = await fixture(); f.effect(async path => { await writeFile(path, "completed before retirement"); f.retire(); });
  await expect(f.run()).rejects.toThrow("unknown"); expect(f.exports.status(f.source.id, "command").state).toBe("unknown");
  expect(f.calls).toBe(1); await expect(f.exports.artifact(f.source.id, "command")).rejects.toThrow();
});
test("same-header replacement of the native source file is rejected by file identity", async () => {
  const f = await fixture();
  f.effect(async path => {
    const { rename } = await import("node:fs/promises");
    const original = await readFile(f.source.sessionFile);
    await writeFile(path, "completed"); await rename(f.source.sessionFile, f.source.sessionFile + ".retained"); await writeFile(f.source.sessionFile, original);
  });
  await expect(f.run()).rejects.toThrow("unknown"); expect(f.calls).toBe(1);
  expect(f.store.readMetadata<{ failure: string }>("session-export.v1:command")?.failure).toContain("file was replaced");
});
test("native write errors retain private diagnostics and an unconfirmed receipt", async () => {
  const f = await fixture(); f.effect(async () => { throw new Error("controlled native write error"); });
  await expect(f.run()).rejects.toThrow("unknown");
  expect(f.exports.status(f.source.id, "command").state).toBe("unknown");
  expect(f.store.readMetadata<{ failure: string }>("session-export.v1:command")?.failure).toBe("controlled native write error");
});
