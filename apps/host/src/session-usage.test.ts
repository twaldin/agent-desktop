import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HostStore } from "./store";
import { SessionUsageService } from "./session-usage";
import { ResetAccountAdmissions, type ResetAccountAdmission } from "./session-reset-admission";
import { SessionUsageHttp } from "./session-usage-http";
import type { WorkerSession } from "./omp-workers/runtime";
import type { NativeUsageResult } from "./omp/session-usage";
import type { SessionUsageCommand } from "../../../packages/shared/src/session-usage";
import type { CommandResult } from "@agent-desktop/shared";
const directories: string[] = [], stores: HostStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
const key = "a".repeat(64);
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "usage-journal-")); directories.push(dir);
  const store = new HostStore(dir); stores.push(store);
  let calls = 0, reads = 0, nativeResult: NativeUsageResult = { state: "settled", outcome: "reset" };
  let redeem: () => Promise<NativeUsageResult> = async () => nativeResult, onPrepare: () => void = () => {};
  const handle = { id: "session", cwd: dir, sessionFile: path.join(dir, "native.jsonl"),
    readUsage: async () => { reads++; return null; },
    prepareUsageReset: async () => { onPrepare(); return { ticket: "private-ticket", epoch: "epoch", accountKey: key, confirmation: {
      account: { accountRef: "account", accountId: "exact", active: true }, credit: { title: "Saved reset" }, expiresAt: Date.now() + 300_000,
    } }; }, redeemUsageReset: async () => { calls++; return redeem(); },
  } as unknown as WorkerSession;
  let owner: WorkerSession | undefined = handle;
  const options = { store, existing: async () => owner, open: async () => { if (!owner) throw new Error(); return owner; }, ordered: <T>(_id: string, run: () => Promise<T>) => run(), assertActive() {} };
  const service = new SessionUsageService(options);
  const send = async (id: string, command: SessionUsageCommand): Promise<CommandResult> => {
    const hash = createHash("sha256").update(JSON.stringify(command)).digest("hex"), claim = store.claimCommand(id, hash, command);
    if (claim.kind === "done") return claim.record.result!;
    if (claim.kind !== "claimed") return { ok: false, commandId: id, error: { code: "OUTCOME_UNKNOWN", message: "Unknown" } };
    let result: CommandResult;
    try { const receipt = command.type === "session.usage.reset.prepare" ? await service.prepare(id, command) : await service.answer(id, command); result = { ok: true, commandId: id, value: { type: "session.usage.reset", receipt } }; }
    catch { result = { ok: false, commandId: id, error: { code: "OUTCOME_UNKNOWN", message: "Unknown" } }; }
    try { return store.finishCommand(id, hash, result).result!; } catch { return { ok: false, commandId: id, error: { code: "OUTCOME_UNKNOWN", message: "Unsettled" } }; }
  };
  return { service, options, store, handle, send, calls: () => calls, reads: () => reads, replace: () => { owner = undefined; }, restore: () => { owner = handle; }, setResult: (value: NativeUsageResult) => { nativeResult = value; }, setRedeem: (value: () => Promise<NativeUsageResult>) => { redeem = value; }, setOnPrepare: (value: () => void) => { onPrepare = value; } };
}
const prepare: SessionUsageCommand = { type: "session.usage.reset.prepare", sessionId: "session", epoch: "epoch", revision: "revision", accountRef: "account" };
const answer = (confirm = true): SessionUsageCommand => ({ type: "session.usage.reset.respond", sessionId: "session", operationId: "prepare", confirm });
test("two clients answer one durable intent once; cached inspect neither opens nor contacts the worker", async () => {
  const f = await fixture(); await f.send("prepare", prepare);
  let release!: (result: NativeUsageResult) => void; f.setRedeem(() => new Promise(resolve => { release = resolve; }));
  const first = f.send("answer", answer()); await new Promise(resolve => setTimeout(resolve, 0));
  const second = await f.send("other-answer", answer()); expect(second.ok && second.value && "type" in second.value && second.value.type === "session.usage.reset" && second.value.receipt.state).toBe("dispatching");
  expect((await f.service.read("session", "cached")).reset?.state).toBe("dispatching"); expect(f.reads()).toBe(0);
  release({ state: "settled", outcome: "reset" }); const done = await first; expect(f.calls()).toBe(1);
  expect(await f.send("answer", answer())).toEqual(done);
  expect((await f.service.read("session", "cached")).reset?.outcome).toBe("reset");
});
test("cancel and worker replacement cannot consume or recreate an original ticket", async () => {
  const f = await fixture(); await f.send("prepare", prepare); await f.send("cancel", answer(false)); await f.send("late-confirm", answer()); expect(f.calls()).toBe(0);
  await f.send("new", prepare); const restarted = new SessionUsageService(f.options);
  const result = await restarted.answer("after-restart", { sessionId: "session", operationId: "new", confirm: true });
  expect(result.state).toBe("rejected"); expect(f.calls()).toBe(0);
});
test("original command inspection cannot be replaced by another client's newer confirmation", async () => {
  const f = await fixture(); await f.send("prepare", prepare); await f.send("cancel", answer(false)); await f.send("newer", prepare);
  expect((await f.service.read("session", "cached")).reset?.operationId).toBe("newer");
  const original = await f.service.read("session", "cached", "cancel");
  expect(original.command?.state).toBe("done"); expect(original.reset?.operationId).toBe("prepare"); expect(original.reset?.state).toBe("cancelled");
});
test("unknown native outcome fences the account across sessions and restart", async () => {
  const f = await fixture(); f.setResult({ state: "unknown" }); await f.send("prepare", prepare); await f.send("answer", answer());
  const restarted = new SessionUsageService(f.options);
  expect((await restarted.read("session", "cached")).reset?.state).toBe("unknown");
  await expect(restarted.prepare("replacement", prepare)).rejects.toThrow();
  expect(new ResetAccountAdmissions(f.store).inspect(key)?.state).toBe("unknown"); expect(f.calls()).toBe(1);
});
test("failed generic journal settlement remains unknown and blocks another credit", async () => {
  const f = await fixture(); await f.send("prepare", prepare);
  const finish = f.store.finishCommand.bind(f.store); f.store.finishCommand = () => { throw new Error("disk full"); };
  expect((await f.send("answer", answer())).ok).toBe(false); f.store.finishCommand = finish;
  expect((await f.service.read("session", "cached")).reset?.state).toBe("unknown");
  expect(f.service.admissions.inspect(key)?.state).toBe("unknown"); await expect(f.service.prepare("replacement", prepare)).rejects.toThrow(); expect(f.calls()).toBe(1);
});
test("failed dispatch-marker write sends nothing and its earlier account fence remains unknown", async () => {
  const f = await fixture(); await f.send("prepare", prepare); const write = f.store.writeMetadata.bind(f.store);
  f.store.writeMetadata = (key, value) => { if (key === "usage-reset.v1:prepare") throw new Error("fixture write failure"); write(key, value); };
  await f.send("answer", answer()); f.store.writeMetadata = write;
  expect(f.calls()).toBe(0); expect((await f.service.read("session", "cached")).reset?.state).toBe("unknown");
  await f.send("another-answer", answer()); expect(f.calls()).toBe(0);
});
test("account generations invalidate stale preparation and unknown cannot be upgraded", async () => {
  const f = await fixture(), admissions = f.service.admissions;
  const revision = admissions.revision(); const first = admissions.admit({ key, operationId: "automatic" });
  expect(() => admissions.assertRevision(revision)).toThrow(); expect(() => admissions.admit({ key, operationId: "manual" })).toThrow();
  admissions.settle(key, "automatic", "settled"); expect(() => admissions.admit({ key, operationId: "stale" })).toThrow();
  admissions.admit({ key, expectedGeneration: first.generation, operationId: "fresh" }); admissions.settle(key, "fresh", "unknown");
  expect(() => admissions.settle(key, "fresh", "settled")).toThrow();
});
const otherKey = "b".repeat(64), thirdKey = "c".repeat(64);
const respond = (operationId: string): SessionUsageCommand => ({ type: "session.usage.reset.respond", sessionId: "session", operationId, confirm: true });
const receipt = (result: CommandResult) => result.ok && result.value && "type" in result.value && result.value.type === "session.usage.reset" ? result.value.receipt : undefined;
test("a shared-authority admission during preparation discards the manual prepare; the untouched account stays usable", async () => {
  const f = await fixture(), shared = new ResetAccountAdmissions(f.store);
  let automatic!: ResetAccountAdmission;
  f.setOnPrepare(() => { automatic = shared.admit({ key: otherKey, operationId: "automatic" }); f.setOnPrepare(() => {}); });
  expect((await f.send("prepare", prepare)).ok).toBe(false);
  expect((await f.service.read("session", "cached")).reset).toBeNull();
  expect((await f.service.read("session", "cached", "prepare")).reset).toBeNull();
  expect(f.calls()).toBe(0);
  expect(receipt(await f.send("fresh", prepare))?.state).toBe("prepared");
  expect(receipt(await f.send("fresh-answer", respond("fresh")))?.outcome).toBe("reset");
  expect(f.calls()).toBe(1);
  expect(shared.inspect(otherKey)).toMatchObject({ generation: automatic.generation, operationId: "automatic", state: "dispatching" });
});
test("an unknown fence on another account neither blocks nor is released by this account's manual reset", async () => {
  const f = await fixture(), shared = new ResetAccountAdmissions(f.store);
  const foreign = shared.admit({ key: otherKey, operationId: "automatic" }); shared.settle(otherKey, "automatic", "unknown");
  await f.send("prepare", prepare);
  expect(receipt(await f.send("answer", answer()))?.outcome).toBe("reset"); expect(f.calls()).toBe(1);
  expect(shared.inspect(otherKey)).toMatchObject({ generation: foreign.generation, operationId: "automatic", state: "unknown" });
  expect(f.service.admissions.inspect(key)?.state).toBe("settled");
  f.setResult({ state: "unknown" }); await f.send("second", prepare); await f.send("second-answer", respond("second"));
  expect(f.service.admissions.inspect(key)?.state).toBe("unknown");
  expect(shared.admit({ key: thirdKey, operationId: "later" }).state).toBe("dispatching");
});
test("a prepared manual credit is rejected without dispatch once a shared authority has spent the account", async () => {
  const f = await fixture(), shared = new ResetAccountAdmissions(f.store);
  await f.send("prepare", prepare);
  const spent = shared.admit({ key, operationId: "automatic" }); shared.settle(key, "automatic", "settled");
  const rejected = await f.send("answer", answer());
  expect(receipt(rejected)?.state).toBe("rejected"); expect(receipt(rejected)?.outcome).toBe("admission_rejected"); expect(f.calls()).toBe(0);
  expect(shared.inspect(key)).toMatchObject({ generation: spent.generation, operationId: "automatic", state: "settled" });
  const view = await f.service.read("session", "cached", "answer");
  expect(view.command?.state).toBe("done"); expect(view.reset?.state).toBe("rejected");
  await f.send("next", prepare);
  expect(receipt(await f.send("next-answer", respond("next")))?.outcome).toBe("reset"); expect(f.calls()).toBe(1);
});
test("worker loss after admission sends nothing and releases the account for a fresh preparation", async () => {
  const f = await fixture(); await f.send("prepare", prepare);
  const assertActive = f.options.assertActive; f.options.assertActive = () => { f.replace(); };
  const rejected = await f.send("answer", answer()); f.options.assertActive = assertActive; f.restore();
  expect(receipt(rejected)?.state).toBe("rejected"); expect(f.calls()).toBe(0);
  expect(f.service.admissions.inspect(key)?.state).toBe("settled");
  expect(await f.send("answer", answer())).toEqual(rejected);
  await f.send("next", prepare);
  expect(receipt(await f.send("next-answer", respond("next")))?.outcome).toBe("reset"); expect(f.calls()).toBe(1);
});
test("failed admission persistence retains a rejected receipt, sends nothing and leaves the account usable", async () => {
  const f = await fixture(); await f.send("prepare", prepare); const write = f.store.writeMetadata.bind(f.store);
  f.store.writeMetadata = (k, value) => { if (k === `reset-admission.v1:account:${key}`) throw new Error("fixture write failure"); write(k, value); };
  const rejected = await f.send("answer", answer()); f.store.writeMetadata = write;
  expect(receipt(rejected)?.state).toBe("rejected"); expect(receipt(rejected)?.outcome).toBe("admission_rejected"); expect(f.calls()).toBe(0);
  expect(await f.send("answer", answer())).toEqual(rejected);
  expect((await f.service.read("session", "cached", "answer")).command?.state).toBe("done");
  expect(f.service.admissions.inspect(key)).toBeUndefined();
  await f.send("next", prepare);
  expect(receipt(await f.send("next-answer", respond("next")))?.outcome).toBe("reset"); expect(f.calls()).toBe(1);
});
test("failed settlement persistence retains the answer receipt, keeps the account fenced and never replays the credit", async () => {
  const f = await fixture(); await f.send("prepare", prepare); const write = f.store.writeMetadata.bind(f.store);
  let armed = false; f.setRedeem(async () => { armed = true; return { state: "settled", outcome: "reset" }; });
  f.store.writeMetadata = (k, value) => { if (armed && k === `reset-admission.v1:account:${key}`) throw new Error("fixture write failure"); write(k, value); };
  const first = await f.send("answer", answer()); f.store.writeMetadata = write;
  expect(receipt(first)?.state).toBe("unknown"); expect(receipt(first)?.outcome).toBeUndefined(); expect(f.calls()).toBe(1);
  expect(await f.send("answer", answer())).toEqual(first); expect(f.calls()).toBe(1);
  expect((await f.service.read("session", "cached", "answer")).command?.state).toBe("done");
  expect(f.service.admissions.inspect(key)?.state).not.toBe("settled");
  await expect(f.service.prepare("replacement", prepare)).rejects.toThrow();
  const restarted = new SessionUsageService(f.options);
  await expect(restarted.prepare("replacement", prepare)).rejects.toThrow(); expect(f.calls()).toBe(1);
});
test("authenticated usage adapter rejects foreign ownership and unbounded bodies before any read", async () => {
  let reads = 0; const http = new SessionUsageHttp({ hostId: "host", sessionExists: () => true, read: async sessionId => { reads++; return { version: 1, hostId: "host", sessionId, snapshot: null, reset: null }; } });
  const url = "http://host/v1/sessions/session/usage";
  expect((await http.route(new Request(url)))?.status).toBe(409);
  expect((await http.route(new Request(url, { method: "POST", headers: { "X-Agent-Host-Id": "host" }, body: "x".repeat(129) })))?.status).toBe(413);
  expect((await http.route(new Request(url, { method: "POST", headers: { "X-Agent-Host-Id": "host" }, body: JSON.stringify({ mode: "credits", credentialId: 1 }) })))?.status).toBe(400);
  expect(reads).toBe(0);
});
