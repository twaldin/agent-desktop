import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PullRequests, type GhRunner, type GhRunResult } from "./pull-requests";
import { HostStore } from "./store";
import type { PullRequestWriteRequest } from "../../../packages/shared/src/pull-request-write";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const ok = (data: unknown): GhRunResult => ({ stdout: JSON.stringify(data), stderr: "", exitCode: 0, overflow: false, timedOut: false });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => resolve = done); return { promise, resolve }; }
async function fixture(options: { head?: string; user?: string; write?: (body: Record<string, unknown>, signal?: AbortSignal) => Promise<GhRunResult>; credentialGate?: Promise<void> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pr-submission-")), store = new HostStore(directory), db = new Database(join(directory, "state.sqlite"));
  const calls: { args: string[]; input?: string; token?: string }[] = [];
  const runner: GhRunner = async (_path, args, config) => {
    calls.push({ args: [...args], input: config.input, token: config.env?.GH_TOKEN });
    if (args[0] === "auth" && args[1] === "status") return ok({ hosts: { "github.com": [{ login: "octocat", active: true, state: "success" }] } });
    if (args[0] === "auth" && args[1] === "token") { await options.credentialGate; return { ...ok(null), stdout: "private-fixture-token\n" }; }
    if (args[1] === "user") return ok({ login: options.user ?? "octocat" });
    if (args[1] === "graphql") return ok({ data: { viewer: { login: "octocat" }, repository: { pullRequest: { headRefOid: options.head ?? "a".repeat(40) } } } });
    const body = JSON.parse(config.input!);
    // The actual record must exist before the external POST runner is entered.
    const reserved = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM metadata WHERE key LIKE 'pull-request-write.v1:%'").get()!.count;
    expect(reserved).toBeGreaterThanOrEqual(calls.filter(call => call.args[1]?.includes("/reviews") || call.args[1]?.includes("/comments")).length);
    return options.write ? options.write(body, config.signal) : ok({ id: 123, user: { login: "octocat" }, html_url: "https://github.com/owner/repo/pull/42#issuecomment-123", commit_id: body.commit_id, state: body.event === "APPROVE" ? "APPROVED" : body.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED" });
  };
  const service = new PullRequests({ hostId: store.host.id, writes: store.pullRequestWrites, ghPath: process.execPath, runner, env: {} });
  cleanup.push(async () => { await service.dispose().catch(() => {}); db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const accounts = await service.read({ type: "accounts", refresh: true });
  if (accounts.type !== "accounts") throw new Error("No fixture accounts");
  const request: PullRequestWriteRequest = { requestId: "original-request-0001", accountId: accounts.availability.accounts[0]!.id, pullRequest: { hostname: "github.com", owner: "owner", repository: "repo", number: 42 }, action: "comment", expectedHeadOid: "a".repeat(40), body: "Comment with `quotes` and\nnew lines" };
  const writes = () => calls.filter(call => call.args[1]?.includes("/comments") || call.args[1]?.includes("/reviews"));
  return { service, store, db, directory, request, calls, writes };
}
test("comments and three review decisions post exact JSON with selected credentials and commit after durable claim", async () => {
  const f = await fixture();
  for (const action of ["comment", "review_comment", "approve", "request_changes"] as const) {
    const request = { ...f.request, action, requestId: `original-${action}-request`, body: action === "approve" ? "" : f.request.body };
    const result = await f.service.submit(request);
    expect(result.outcome).toBe("succeeded"); expect(f.store.pullRequestWrites.get(request)?.receipt).toEqual(result);
    const call = f.writes().at(-1)!;
    expect(call.args).toEqual(["api", `repos/owner/repo/${action === "comment" ? "issues/42/comments" : "pulls/42/reviews"}`, "--hostname", "github.com", "--input", "-"]);
    expect(call.token).toBe("private-fixture-token");
    expect(JSON.parse(call.input!)).toEqual(action === "comment" ? { body: request.body } : { body: request.body, event: action === "approve" ? "APPROVE" : action === "request_changes" ? "REQUEST_CHANGES" : "COMMENT", commit_id: request.expectedHeadOid });
  }
});
test("double submission joins one dispatch and reopen never replays even an interrupted attempt", async () => {
  const entered = gate(), release = gate();
  const f = await fixture({ write: async () => { entered.resolve(); await release.promise; return ok({ id: 123, user: { login: "octocat" }, html_url: "https://github.com/owner/repo/pull/42#issuecomment-123" }); } });
  const first = f.service.submit(f.request); await entered.promise;
  const second = f.service.submit(structuredClone(f.request));
  expect(f.service.status(f.request)?.outcome).toBe("pending");
  release.resolve(); expect(await first).toEqual(await second); expect(f.writes()).toHaveLength(1);
  const reopened = new HostStore(f.directory);
  const other = new PullRequests({ hostId: reopened.host.id, writes: reopened.pullRequestWrites, ghPath: process.execPath, runner: async () => { throw new Error("must not dispatch after reopen"); } });
  try {
    expect((await other.submit(f.request)).outcome).toBe("succeeded");
    const interrupted = { ...f.request, requestId: "interrupted-original-request" };
    reopened.pullRequestWrites.claim(interrupted);
    expect((await other.submit(interrupted)).outcome).toBe("unknown");
  } finally { await other.dispose(); reopened.close(); }
});
test("wrong account and changed head fail before POST and preserve text", async () => {
  for (const options of [{ user: "replacement" }, { head: "b".repeat(40) }]) {
    const f = await fixture(options), result = await f.service.submit({ ...f.request, action: "review_comment" });
    expect(result.outcome).toBe("failed"); expect(result.request.body).toBe(f.request.body); expect(f.writes()).toHaveLength(0);
  }
});
test("disconnecting caller after claim does not abandon the original operation or admit duplicate POST", async () => {
  const entered = gate(), release = gate();
  const f = await fixture({ write: async () => { entered.resolve(); await release.promise; return ok({ id: 123, user: { login: "octocat" }, html_url: "https://github.com/owner/repo/pull/42#issuecomment-123" }); } });
  const controller = new AbortController(), operation = f.service.submit(f.request, controller.signal); await entered.promise;
  controller.abort(); release.resolve();
  expect((await operation).outcome).toBe("succeeded"); expect(f.writes()).toHaveLength(1);
});
test("dispatched invalid payload and timeout stay unknown; failure to save is retained by shutdown", async () => {
  for (const write of [async () => ok({ html_url: "https://foreign.invalid" }), async () => ({ ...ok(null), timedOut: true })]) {
    const f = await fixture({ write });
    expect((await f.service.submit(f.request)).outcome).toBe("unknown");
    expect((await f.service.submit(f.request)).outcome).toBe("unknown"); expect(f.writes()).toHaveLength(1);
  }
  const f = await fixture();
  f.db.exec("CREATE TRIGGER pr_save_failure BEFORE UPDATE ON metadata WHEN NEW.key LIKE 'pull-request-write.v1:%' BEGIN SELECT RAISE(ABORT,'receipt disk failure'); END");
  await expect(f.service.submit(f.request)).rejects.toThrow("receipt disk failure");
  expect(f.service.status(f.request)?.outcome).toBe("unknown");
  await expect(f.service.dispose()).rejects.toThrow("could not be saved");
});
test("shutdown waits for dispatched process settlement and durably marks uncertain outcome", async () => {
  const entered = gate(), release = gate();
  const f = await fixture({ write: async () => { entered.resolve(); await release.promise; return ok(null); } });
  const operation = f.service.submit(f.request); await entered.promise;
  let disposed = false; const drain = f.service.dispose().then(() => { disposed = true; });
  await Promise.resolve(); expect(disposed).toBe(false); release.resolve();
  expect((await operation).outcome).toBe("unknown"); await drain;
  expect(f.store.pullRequestWrites.get(f.request)?.receipt?.outcome).toBe("unknown");
});

test("ordinary comments retain pinned no-head-check behavior while reviews bind the displayed head", async () => {
  const f = await fixture({ head: "b".repeat(40) });
  expect((await f.service.submit(f.request)).outcome).toBe("succeeded");
  expect(f.writes()).toHaveLength(1);
  expect(f.calls.some(call => call.args[1] === "graphql")).toBe(false);
});
test("queued submissions stay bounded and serialized; rejected changed input never reaches GitHub", async () => {
  const entered = gate(), release = gate();
  const f = await fixture({ write: async () => { entered.resolve(); await release.promise; return ok({ id: 1, user: { login: "octocat" }, html_url: "https://github.com/owner/repo/pull/42#issuecomment-1" }); } });
  const first = f.service.submit(f.request); await entered.promise;
  const queued = Array.from({ length: 15 }, (_, index) => f.service.submit({ ...f.request, requestId: `queued-original-request-${index}` }));
  const overflow = f.service.submit({ ...f.request, requestId: "overflow-original-request" }).then(() => undefined, error => error);
  const changed = f.service.submit({ ...f.request, body: "changed original body" }).then(() => undefined, error => error);
  const overflowError = await overflow, changedError = await changed, heldDispatches = f.writes().length;
  // Settle the original held operation before comparing results, including on the old/failed path.
  release.resolve(); const receipts = await Promise.all([first, ...queued]);
  expect(heldDispatches).toBe(1); expect(overflowError?.code).toBe("BUSY"); expect(changedError).toBeInstanceOf(Error);
  expect(receipts.map(item => item.outcome)).toEqual(Array(16).fill("succeeded"));
  expect(f.writes()).toHaveLength(16);
  expect(f.writes().every(call => JSON.parse(call.input!).body === f.request.body)).toBe(true);
  expect(f.store.pullRequestWrites.get({ ...f.request, requestId: "overflow-original-request" })).toBeUndefined();
});
