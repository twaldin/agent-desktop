import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, renameSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "./store";
import { McpOwnerHttp } from "./mcp-owner-http";
import type { WorkerMcpOwner } from "./omp-workers/runtime";
import { SESSION_MCP_OWNER_HEADER, type McpOwnerRequest } from "@agent-desktop/shared";
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(value => { resolve = value; }); return { promise, resolve }; };
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mcp-owner-http-"))), cwd = join(root, "directory"); mkdirSync(cwd);
  const store = new HostStore(join(root, "state")), calls: string[] = [];
  const handle: WorkerMcpOwner = { id: "owner", cwd, workerPid: 123, workerFailure: undefined,
    read: async () => { calls.push("read"); return { available: true, canOpenApps: true, epoch: "native", revision: 1, servers: [] }; },
    interactions: async () => [], respond: async () => {}, request: async request => ({ type: "closed", channelId: request.channelId }),
    subscribe: () => () => {}, subscribeWorkerFailure: () => () => {}, dispose: async () => { calls.push("dispose"); } };
  const ready = deferred<WorkerMcpOwner>();
  const http = new McpOwnerHttp(store, cwd, { createMcpOwner: async owner => { calls.push(`create:${owner.cwd}`); return ready.promise; } });
  const send = async (input: McpOwnerRequest, hostId = store.host.id) => (await http.route(new Request("http://fixture/v1/mcp-owners", { method: "POST", headers: { [SESSION_MCP_OWNER_HEADER]: hostId }, body: JSON.stringify(input) })))!;
  return { root, cwd, store, calls, handle, ready, http, send, cleanup: async () => { ready.resolve(handle); await http.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}
test("host retirement waits for an in-flight native acquisition and prevents same-ID replay", async () => {
  const f = fixture(), request = { type: "acquire" as const, ownerId: "owner", target: { projectId: null } };
  try {
    const opening = f.send(request); while (!f.calls.length) await Bun.sleep(1);
    const closing = f.send({ ...request, type: "retire" }); await Bun.sleep(1);
    f.ready.resolve(f.handle);
    expect((await opening).status).toBe(503); expect((await closing).status).toBe(200);
    expect(f.calls).toEqual([`create:${f.cwd}`, "dispose"]);
    expect((await f.send(request)).status).toBe(503); expect(f.calls).toHaveLength(2);
  } finally { await f.cleanup(); }
});
test("foreign input and retired-before-open requests never create a worker; directory replacement latches retirement", async () => {
  const f = fixture(), request = { type: "acquire" as const, ownerId: "owner", target: { projectId: null } };
  try {
    expect((await f.send(request, "foreign-host")).status).toBe(409);
    await f.send({ ...request, ownerId: "pre-retired", type: "retire" });
    expect((await f.send({ ...request, ownerId: "pre-retired" })).status).toBe(503); expect(f.calls).toEqual([]);
    f.ready.resolve(f.handle); const response = await (await f.send(request)).json();
    expect(response.value.cwd).toBe(f.cwd); expect(f.store.listSessions()).toEqual([]);
    renameSync(f.cwd, `${f.cwd}-old`); mkdirSync(f.cwd);
    expect((await f.send({ type: "read", ownerId: "owner", epoch: response.value.epoch })).status).toBe(503);
    await f.http.dispose(); expect(f.calls.filter(value => value === "dispose")).toHaveLength(1);
    expect(f.calls.filter(value => value === "read")).toHaveLength(1);
  } finally { await f.cleanup(); }
});
