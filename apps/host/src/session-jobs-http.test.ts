import { expect, test } from "bun:test";
import { SESSION_ACTIVITY_OWNER_HEADER } from "../../../packages/shared/src/session-activity";
import { parseSessionJobsEnvelope, type SessionJobsRequest, type SessionJobsResult, type SessionJobsSnapshot } from "../../../packages/shared/src/session-jobs";
import { NativeJobsError } from "./omp/session-jobs";
import { SessionJobsHttp, type SessionJobsHandle } from "./session-jobs-http";

const owner = { nativeSessionId: "session", epoch: "epoch-1", agentId: "Main" };
const job = { id: "bg_1", startTime: 5, guard: "guard-1" };
const snapshot: SessionJobsSnapshot = { owner, availability: "available", running: [{ target: job, type: "bash", status: "running", label: "sleep", queued: false }], recent: [],
  delivery: { queued: 0, delivering: false, pendingJobIds: [] } };
const request = (body: unknown, host = "home", method = "POST") => new Request("http://localhost/v1/sessions/session/jobs", { method, headers: { [SESSION_ACTIVITY_OWNER_HEADER]: host }, body: method === "POST" ? JSON.stringify(body) : undefined });
const cancel: SessionJobsRequest = { action: "cancel", owner, job };
const fixture = (answer: (input: SessionJobsRequest) => Promise<SessionJobsResult>) => {
  const handle: SessionJobsHandle = { nativeJobs: answer };
  const state = { current: handle as SessionJobsHandle | undefined, exists: true, lookups: 0 };
  const http = new SessionJobsHttp({ hostId: "home", sessionExists: () => state.exists, getExistingHandle: async () => { state.lookups++; return state.current; } });
  return { http, handle, state };
};
const error = async (response: Response | undefined) => ({ status: response?.status, ...(await response!.json() as { error: { code: string } }).error });

test("jobs reads refuse foreign owners, non-POST and malformed bodies before any worker lookup, and never revive a worker", async () => {
  const f = fixture(async () => ({ action: "read", snapshot }));
  expect(await error(await f.http.route(request({ action: "read" }, "other")))).toMatchObject({ status: 409, code: "OWNER_MISMATCH" });
  expect(await error(await f.http.route(request(undefined, "home", "GET")))).toMatchObject({ status: 405, code: "INVALID_JOBS_REQUEST" });
  expect(await error(await f.http.route(request({ action: "read", owner: { ...owner, nativeSessionId: "other" } })))).toMatchObject({ status: 400, code: "INVALID_JOBS_REQUEST" });
  expect(await error(await f.http.route(request({ action: "cancel", owner })))).toMatchObject({ status: 400, code: "INVALID_JOBS_REQUEST" });
  expect(f.state.lookups).toBe(0);
  f.state.current = undefined;
  expect(await error(await f.http.route(request({ action: "read" })))).toMatchObject({ status: 409, code: "OWNER_UNAVAILABLE" });
  f.state.current = { workerFailure: { message: "exit" }, nativeJobs: async () => { throw new Error("must not dispatch"); } };
  expect(await error(await f.http.route(request({ action: "read" })))).toMatchObject({ status: 409, code: "OWNER_UNAVAILABLE" });
  expect(f.state.lookups).toBe(2);
});

test("a read answered by the original worker is enveloped for the exact host and session", async () => {
  const f = fixture(async input => ({ action: "read", snapshot: { ...snapshot, owner: input.owner ?? owner } }));
  const response = (await f.http.route(request({ action: "read", owner })))!;
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get(SESSION_ACTIVITY_OWNER_HEADER)).toBe("home");
  expect(parseSessionJobsEnvelope(await response.json(), "home", "session").result).toEqual({ action: "read", snapshot });
});

test("native owner and job refusals keep their code across the worker boundary while unclassified read failures are not stale", async () => {
  const stale = fixture(async () => { throw new NativeJobsError("STALE_JOB", "This job is no longer the one you inspected."); });
  expect(await error(await stale.http.route(request({ action: "inspect", owner, job })))).toMatchObject({ status: 409, code: "STALE_JOB" });
  const remote = Object.assign(new Error("These jobs belong to another native owner generation."), { name: "NativeJobsError.STALE_OWNER" });
  const rpc = fixture(async () => { throw remote; });
  expect(await error(await rpc.http.route(request({ action: "read", owner })))).toMatchObject({ status: 409, code: "STALE_OWNER" });
  const failed = fixture(async () => { throw new Error("socket closed"); });
  expect(await error(await failed.http.route(request({ action: "read" })))).toMatchObject({ status: 500, code: "JOBS_FAILED" });
});

test("a cancel whose original worker or session is lost after dispatch is unknown even when the worker reported success", async () => {
  const replaced = fixture(async () => { replaced.state.current = { nativeJobs: async () => ({ action: "read", snapshot }) }; return { action: "cancel", snapshot, requested: true }; });
  expect(await error(await replaced.http.route(request(cancel)))).toMatchObject({ status: 500, code: "OUTCOME_UNKNOWN" });
  const retired = fixture(async () => { retired.state.exists = false; return { action: "cancel", snapshot, requested: true }; });
  expect(await error(await retired.http.route(request(cancel)))).toMatchObject({ status: 500, code: "OUTCOME_UNKNOWN" });
  const lostRead = fixture(async () => { lostRead.state.current = undefined; return { action: "read", snapshot }; });
  expect(await error(await lostRead.http.route(request({ action: "read" })))).toMatchObject({ status: 409, code: "STALE_TARGET" });
  const transport = fixture(async () => { throw new Error("socket closed"); });
  expect(await error(await transport.http.route(request(cancel)))).toMatchObject({ status: 500, code: "OUTCOME_UNKNOWN" });
  const settled = fixture(async () => ({ action: "cancel", snapshot, requested: false }));
  const envelope = parseSessionJobsEnvelope(await (await settled.http.route(request(cancel)))!.json(), "home", "session");
  expect(envelope.result).toEqual({ action: "cancel", snapshot, requested: false });
});

test("a result for another action, owner generation or target is never published as the answer", async () => {
  const action = fixture(async () => ({ action: "read", snapshot }));
  expect(await error(await action.http.route(request(cancel)))).toMatchObject({ status: 500, code: "OUTCOME_UNKNOWN" });
  const generation = fixture(async () => ({ action: "read", snapshot: { ...snapshot, owner: { ...owner, epoch: "epoch-2" } } }));
  expect(await error(await generation.http.route(request({ action: "read", owner })))).toMatchObject({ status: 500, code: "JOBS_FAILED" });
  const target = fixture(async () => ({ action: "inspect", snapshot, detail: { target: { ...job, guard: "guard-2" }, truncated: false, consumed: false } }));
  expect(await error(await target.http.route(request({ action: "inspect", owner, job })))).toMatchObject({ status: 500, code: "JOBS_FAILED" });
  const foreign = fixture(async () => ({ action: "read", snapshot: { ...snapshot, owner: { ...owner, nativeSessionId: "other" } } }));
  expect(await error(await foreign.http.route(request({ action: "read" })))).toMatchObject({ status: 409, code: "STALE_TARGET" });
});
