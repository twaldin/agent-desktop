/** Executes selected maintained parent/child bodies with controlled clients and native close.
 * No child, SDK, IPC, browser, timer or process is started. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { WorkerBrowserCloses, requestWorkerBrowserClose, type WorkerBrowserCloseResult } from "../../apps/host/src/omp-browser/close";
import type { BrowserFrameTarget } from "../../packages/shared/src/browser";

const entryPath = "apps/host/src/omp-workers/entry.ts", parentPath = "apps/host/src/omp-workers/runtime.ts";
const entry = await readFile(entryPath, "utf8"), parent = await readFile(parentPath, "utf8");
function slice(source: string, begin: string, end?: string) {
  const start = source.indexOf(begin), finish = end ? source.indexOf(end, start) : source.length;
  assert(start >= 0 && finish > start); return source.slice(start, finish);
}
const disposal = slice(entry, "function disposeNativeOwners()", "async function shutdown(");
const dispatch = slice(entry, "async function request(", 'process.on("message"');
const runtimeBody = slice(parent, "export class WorkerRuntime {").replace("export class", "class");
const transpile = (text: string) => new Bun.Transpiler({ loader: "ts" }).transformSync(text);
const checks: string[] = [];
const target = { workerPid: 777, name: "desktop-one", targetId: "native-one" };
interface Response { id: string; ok: boolean; value?: unknown; error?: { message: string } }
interface ChildHarness {
  request(input: { type: "request"; id: string; operation: "closeBrowserTab"; args: { target: BrowserFrameTarget } } | { type: "request"; id: string; operation: "dispose" }): Promise<void>;
  disposeNativeOwners(): Promise<void>;
  pending(): { exitCode: number } | undefined;
}
for (const kind of ["session", "draft"] as const) for (const failure of [false, true]) {
  const events: string[] = [], responses: Response[] = [];
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<unknown>();
  const owner = { id: kind + "-owner", dispose: async () => { events.push("owner-dispose"); if (failure) throw new Error("owner cleanup failed"); } };
  const browserCloses = new WorkerBrowserCloses(target.workerPid, () => owner, async () => ({
    BROWSER_TAB_OWNER_CLOSE_VERSION: 1,
    releaseTabForOwner: async (ownerId, selected) => {
      events.push("native-close"); assert.equal(ownerId, owner.id); assert.deepEqual(selected, { name: target.name, targetId: target.targetId });
      entered.resolve(); return released.promise;
    },
  }));
  const state = { session: kind === "session" ? owner : undefined, browserOwner: kind === "draft" ? owner : undefined,
    runtime: { dispose: async () => { events.push("runtime-dispose"); if (failure) throw new Error("runtime cleanup failed"); } } };
  const child = new Function("state", "browserCloses", "browserObservations", "send", "snapshot", "remoteError", "setTimeout", "process", transpile(`
    let {session,browserOwner,runtime} = state;
    let nativeDisposal, commitAbort, commitGeneration, pendingDispose;
    const browserReservations = { dispose: async () => {} };
    let stopping = false, activeRequests = 0, promotionInFlight = false, promotedOwnerRetired = false;
    ${disposal}
    ${dispatch}
    return { request, disposeNativeOwners, pending: () => pendingDispose };
  `))(state, browserCloses, { dispose: async () => {} }, (message: Response) => responses.push(message), () => undefined,
    (error: Error) => ({ message: error.message }), () => 1, { exit: () => { throw new Error("No process exit in controlled fixture"); } }) as ChildHarness;
  const close = child.request({ type: "request", id: "close", operation: "closeBrowserTab", args: { target } });
  await entered.promise;
  const retire = child.request({ type: "request", id: "retire", operation: "dispose" });
  await Promise.resolve(); assert.deepEqual(events, ["native-close"]); assert.equal(responses.length, 0);
  const repeated = child.disposeNativeOwners().then(() => undefined, (error: AggregateError) => error);
  if (failure) released.reject(new Error("tab cleanup failed"));
  else released.resolve({ ownerSessionId: owner.id, name: target.name, targetId: target.targetId, released: true });
  await close; await retire;
  assert.equal(responses.find(item => item.id === "close")?.ok, !failure);
  assert.equal(responses.find(item => item.id === "retire")?.ok, !failure);
  assert.equal(child.pending()?.exitCode, failure ? 1 : 0);
  assert.deepEqual(events, kind === "draft" ? ["native-close", "owner-dispose", "runtime-dispose"] : ["native-close", "runtime-dispose"]);
  const repeatedResult = await repeated;
  if (failure) {
    assert(repeatedResult instanceof AggregateError);
    const flatten = (error: Error): string[] => error instanceof AggregateError ? error.errors.flatMap(flatten) : [error.message];
    assert.deepEqual(flatten(repeatedResult), kind === "draft" ? ["tab cleanup failed", "owner cleanup failed", "runtime cleanup failed"] : ["tab cleanup failed", "runtime cleanup failed"]);
  } else assert.equal(repeatedResult, undefined);
  checks.push(`actual child request/dispose ${kind} ${failure ? "failure drains every cleanup and reports failure" : "confirmation precedes retirement acknowledgement"}`);
}

interface Handle { closeBrowserTab(target: BrowserFrameTarget): Promise<WorkerBrowserCloseResult>; dispose(): Promise<void> }
interface Runtime { create(options: unknown): Promise<Handle>; createBrowserOwner(owner: { id: string; cwd: string }): Promise<Handle>; dispose(): Promise<void> }
for (const mode of ["session", "draft"] as const) {
  const calls: Array<{ operation: string; args?: unknown }> = [];
  let ownerId = "";
  class Client {
    pid = target.workerPid;
    snapshot: { id: string; sessionFile: string; cwd: string } | undefined;
    async request(operation: { operation: string; args?: { owner?: { id: string; cwd: string }; target?: BrowserFrameTarget } }) {
      calls.push(operation);
      if (operation.operation === "init") {
        ownerId = mode === "session" ? "session-owner" : operation.args!.owner!.id;
        if (mode === "session") this.snapshot = { id: ownerId, sessionFile: "/controlled/session.jsonl", cwd: "/canonical" };
        return { ownerId, cwd: operation.args?.owner?.cwd };
      }
      assert.equal(operation.operation, "closeBrowserTab"); assert.deepEqual(operation.args, { target });
      return { ...target, ownerId, released: true };
    }
    async close() {}
    subscribe() { return () => {}; }
  }
  const requireDirectory = async (cwd: string) => cwd === "/controlled" ? "/canonical" : cwd;
  const Runtime = new Function("WorkerClient", "realpath", "requireDirectory", "path", "requestWorkerBrowserClose", `${transpile(runtimeBody)}\nreturn WorkerRuntime;`)(
    Client,
    async (cwd: string) => cwd,
    requireDirectory,
    path,
    requestWorkerBrowserClose,
  ) as new (options: unknown) => Runtime;
  const runtime = new Runtime({}), handle = mode === "session" ? await runtime.create({ cwd: "/controlled" }) : await runtime.createBrowserOwner({ id: "draft-owner", cwd: "/controlled" });
  assert.deepEqual(await handle.closeBrowserTab(target), { ...target, ownerId, released: true });
  await assert.rejects(handle.closeBrowserTab({ ...target, workerPid: 1 }), /stale or invalid/);
  assert.deepEqual(calls.map(item => item.operation), ["init", "closeBrowserTab"]);
  assert.equal((calls[0]?.args as { owner?: { cwd: string }; options?: { cwd: string } }).owner?.cwd ?? (calls[0]?.args as { options?: { cwd: string } }).options?.cwd, "/canonical");
  await handle.dispose(); await runtime.dispose(); checks.push(`actual WorkerRuntime ${mode} handle uses shared confirmed close and rejects foreign PID before request`);
}
console.log(JSON.stringify({ checks, sources: Object.fromEntries([[entryPath, entry], [parentPath, parent]].map(([name, source]) => [name, new Bun.CryptoHasher("sha256").update(source!).digest("hex")])),
  selected: Object.fromEntries(Object.entries({ disposal, dispatch, runtimeBody }).map(([name, source]) => [name, new Bun.CryptoHasher("sha256").update(source).digest("hex")])),
  limits: "Actual selected maintained entry functions and parent class; controlled native loader, owner, runtime, response and client. No IPC, native import, worker process, real timer, browser, host route, UI or installed acceptance." }, null, 2));
