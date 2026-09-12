import { expect, test } from "bun:test";
import { WorkerBrowserCloses, requestWorkerBrowserClose } from "./close";

const target = { workerPid: 731, name: "desktop-one", targetId: "target-one" };
const outcome = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }));
function fixture() {
  let owner = { id: "owner-one" };
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<unknown>();
  const calls: unknown[] = [];
  const api = { BROWSER_TAB_OWNER_CLOSE_VERSION: 1, releaseTabForOwner: async (id: string, value: unknown) => {
    calls.push({ id, value }); entered.resolve(); return release.promise;
  } };
  const closes = new WorkerBrowserCloses(target.workerPid, () => owner, async () => api);
  return { closes, calls, api, entered, release, replace() { owner = { id: owner.id }; },
    confirm() { release.resolve({ ownerSessionId: "owner-one", name: target.name, targetId: target.targetId, released: true }); } };
}

test("close waits for the captured native target and retirement drains its confirmation", async () => {
  const h = fixture(), input = { ...target }; const operation = h.closes.close(input);
  input.name = "replacement"; input.targetId = "replacement";
  await h.entered.promise;
  let finished = false; const closing = h.closes.dispose().then(() => { finished = true; });
  await Promise.resolve(); expect(finished).toBe(false);
  expect(h.calls).toEqual([{ id: "owner-one", value: { name: target.name, targetId: target.targetId } }]);
  await expect(h.closes.close(target)).rejects.toThrow("stopping");
  h.confirm(); expect(await operation).toEqual({ ...target, ownerId: "owner-one", released: true });
  await closing; await h.closes.dispose(); expect(finished).toBe(true); expect(h.calls).toHaveLength(1);
});

test("native close failure reaches both the request and retained retirement drain", async () => {
  const h = fixture(), operation = outcome(h.closes.close(target)); await h.entered.promise;
  const closing = outcome(h.closes.dispose()); h.release.reject(new Error("native cleanup failed"));
  expect((await operation).error?.message).toBe("native cleanup failed");
  const error = (await closing).error as AggregateError;
  expect(error.errors.map((value: Error) => value.message)).toEqual(["native cleanup failed"]);
  await expect(h.closes.dispose()).rejects.toThrow("cleanup failed"); expect(h.calls).toHaveLength(1);
});

for (const transition of ["replacement", "retirement"] as const) test(`held module import rejects ${transition} before native close`, async () => {
  const h = fixture(), imported = Promise.withResolvers<typeof h.api>(), loading = Promise.withResolvers<void>();
  let owner = { id: "same-id" };
  const closes = new WorkerBrowserCloses(target.workerPid, () => owner, () => { loading.resolve(); return imported.promise; });
  const operation = outcome(closes.close(target)); await loading.promise;
  let closing: Promise<void> | undefined;
  if (transition === "replacement") owner = { id: "same-id" }; else closing = closes.dispose();
  imported.resolve(h.api);
  expect((await operation).error?.name).toBe("BrowserActionRejected");
  await closing; await closes.dispose(); expect(h.calls).toHaveLength(0);
});

test("reentrant loader retirement sees the operation and cannot dispatch it", async () => {
  const h = fixture(), owner = { id: "owner-one" }; let closing: Promise<void> | undefined;
  const closes = new WorkerBrowserCloses(target.workerPid, () => owner, async () => { closing = closes.dispose(); return h.api; });
  await expect(closes.close(target)).rejects.toThrow("before close admission");
  await closing; expect(h.calls).toHaveLength(0);
});

test("wrong worker or malformed target never loads the native module", async () => {
  let loads = 0; const closes = new WorkerBrowserCloses(target.workerPid, () => ({ id: "owner-one" }), async () => { loads++; return {}; });
  for (const input of [{ ...target, workerPid: 1 }, { ...target, name: "" }, { ...target, targetId: "\0" }]) {
    await expect(closes.close(input)).rejects.toThrow("stale or invalid");
  }
  await closes.dispose(); expect(loads).toBe(0);
});

for (const version of [undefined, 2]) test(`native version ${version} fails closed without a legacy close fallback`, async () => {
  const h = fixture(), owner = { id: "owner-one" };
  const closes = new WorkerBrowserCloses(target.workerPid, () => owner, async () => ({ ...h.api, BROWSER_TAB_OWNER_CLOSE_VERSION: version }));
  await expect(closes.close(target)).rejects.toThrow("does not support");
  await closes.dispose(); expect(h.calls).toHaveLength(0);
});

test("unconfirmed or foreign native results cannot escape as success", async () => {
  for (const change of [{ ownerSessionId: "other" }, { name: "other" }, { targetId: "other" }, { released: false }]) {
    const h = fixture(), operation = outcome(h.closes.close(target)); await h.entered.promise;
    h.release.resolve({ ownerSessionId: "owner-one", name: target.name, targetId: target.targetId, released: true, ...change });
    expect((await operation).error).toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await h.closes.dispose();
  }
});

test("daemon validates and copies the exact close envelope and confirmation", async () => {
  const gate = Promise.withResolvers<unknown>(); let calls = 0;
  const client = { pid: target.workerPid, request: async (operation: { operation: "closeBrowserTab"; args: { target: typeof target } }) => {
    calls++; expect(operation).toEqual({ operation: "closeBrowserTab", args: { target } });
    operation.args.target.name = "wire-copy-change"; return gate.promise;
  } };
  const input = { ...target }, closing = requestWorkerBrowserClose(client, "owner-one", input);
  expect(input).toEqual(target); input.name = "caller-change";
  gate.resolve({ ...target, ownerId: "owner-one", released: true });
  expect(await closing).toEqual({ ...target, ownerId: "owner-one", released: true }); expect(calls).toBe(1);
  await expect(requestWorkerBrowserClose(client, "owner-one", { ...target, workerPid: 1 })).rejects.toThrow("stale or invalid");
  expect(calls).toBe(1);
});

test("daemon rejects stale PID/owner/target and missing close acknowledgements", async () => {
  for (const change of [undefined, { ownerId: "other" }, { workerPid: 1 }, { name: "other" }, { targetId: "other" }, { released: false }]) {
    const result = change === undefined ? undefined : { ...target, ownerId: "owner-one", released: true, ...change };
    const operation = outcome(requestWorkerBrowserClose({ pid: target.workerPid, request: async () => result }, "owner-one", target));
    expect((await operation).error).toMatchObject({ code: "OUTCOME_UNKNOWN" });
  }
});
