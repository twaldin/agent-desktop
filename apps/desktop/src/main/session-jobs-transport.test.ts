import { expect, test } from "bun:test";
import { SESSION_ACTIVITY_OWNER_HEADER } from "../../../../packages/shared/src/session-activity";
import type { SessionJobsRequest, SessionJobsResult, SessionJobsSnapshot } from "../../../../packages/shared/src/session-jobs";
import { SessionJobsHttp, type SessionJobsHandle } from "../../../host/src/session-jobs-http";
import { HostRequestError } from "./host-transport";
import { requestSessionJobs } from "./session-jobs-transport";

const owner = { nativeSessionId: "session/name", epoch: "epoch-1", agentId: "Main" };
const job = { id: "bg_1", startTime: 5, guard: "guard-1" };
const snapshot: SessionJobsSnapshot = { owner, availability: "available", running: [{ target: job, type: "task", status: "running", label: "Index", queued: true, agentId: "Indexer" }],
  recent: [], delivery: { queued: 1, delivering: true, nextRetryAt: 9, pendingJobIds: ["bg_0"] } };

/** The production host route answers over loopback; only the loaded worker handle is scripted. */
function host(hostId: string, answer: (input: SessionJobsRequest) => Promise<SessionJobsResult>) {
  const seen: { path: string; method: string; owner: string | null; authorized: boolean; body: unknown }[] = [];
  const handle: SessionJobsHandle = { nativeJobs: answer };
  const route = new SessionJobsHttp({ hostId, sessionExists: id => id === "session/name", getExistingHandle: async () => handle });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    seen.push({ path: new URL(request.url).pathname, method: request.method, owner: request.headers.get(SESSION_ACTIVITY_OWNER_HEADER),
      authorized: request.headers.get("authorization") === "Bearer inert-token", body: await request.clone().json().catch(() => undefined) });
    return await route.route(request) ?? new Response("Missing", { status: 404 });
  } });
  return { seen, endpoint: { origin: server.url.origin, hostId: "owner", token: "inert-token" }, stop: () => server.stop(true) };
}

test("jobs requests reach the owning host route as one authenticated POST and return the bound envelope", async () => {
  const f = host("owner", async input => input.action === "cancel" ? { action: "cancel", snapshot, requested: true } : { action: "read", snapshot });
  try {
    const envelope = await requestSessionJobs(f.endpoint, "session/name", { action: "read" });
    expect(envelope).toEqual({ protocolVersion: 1, hostId: "owner", sessionId: "session/name", result: { action: "read", snapshot } });
    const cancel = await requestSessionJobs(f.endpoint, "session/name", { action: "cancel", owner, job });
    expect(cancel.result).toEqual({ action: "cancel", snapshot, requested: true });
    expect(f.seen).toEqual([
      { path: "/v1/sessions/session%2Fname/jobs", method: "POST", owner: "owner", authorized: true, body: { action: "read" } },
      { path: "/v1/sessions/session%2Fname/jobs", method: "POST", owner: "owner", authorized: true, body: { action: "cancel", owner, job } },
    ]);
  } finally { f.stop(); }
});

test("host refusals keep their bounded code and a cancel is never resubmitted", async () => {
  let dispatched = 0;
  const f = host("owner", async () => { dispatched++; throw Object.assign(new Error("This job is no longer the one you inspected."), { name: "NativeJobsError.STALE_JOB" }); });
  try {
    const failure = await requestSessionJobs(f.endpoint, "session/name", { action: "cancel", owner, job }).catch(error => error as HostRequestError);
    expect(failure).toBeInstanceOf(HostRequestError);
    expect(failure).toMatchObject({ status: 409, code: "STALE_JOB", message: "This job is no longer the one you inspected." });
    expect(dispatched).toBe(1);
    await expect(requestSessionJobs(f.endpoint, "other", { action: "read" })).rejects.toMatchObject({ status: 409, code: "STALE_TARGET" });
  } finally { f.stop(); }
});

test("responses from another host, another conversation or another owner generation are rejected", async () => {
  const foreign = host("other", async () => ({ action: "read", snapshot }));
  try { await expect(requestSessionJobs(foreign.endpoint, "session/name", { action: "read" })).rejects.toMatchObject({ code: "OWNER_MISMATCH" }); }
  finally { foreign.stop(); }
  const generation = host("owner", async () => ({ action: "read", snapshot: { ...snapshot, owner: { ...owner, epoch: "epoch-2" } } }));
  try {
    expect((await requestSessionJobs(generation.endpoint, "session/name", { action: "read" })).result.snapshot.owner.epoch).toBe("epoch-2");
    await expect(requestSessionJobs(generation.endpoint, "session/name", { action: "read", owner })).rejects.toThrow();
    expect(generation.seen).toHaveLength(2);
  } finally { generation.stop(); }
  await expect(requestSessionJobs({ origin: "http://127.0.0.1:1", hostId: "owner" }, "session/name", { action: "read", owner: { ...owner, nativeSessionId: "other" } })).rejects.toThrow("another conversation");
  await expect(requestSessionJobs({ origin: "http://127.0.0.1:1", hostId: "owner" }, "session/name", { action: "cancel", owner })).rejects.toThrow("Invalid native jobs");
});

test("the endpoint is captured before the request so a connection change cannot retarget it", async () => {
  const f = host("owner", async () => ({ action: "read", snapshot }));
  try {
    const mutable = { ...f.endpoint };
    const previous = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => { mutable.origin = "http://127.0.0.1:1"; mutable.hostId = "changed"; mutable.token = "changed"; return previous(...args); }) as typeof fetch;
    try { expect((await requestSessionJobs(mutable, "session/name", { action: "read" })).hostId).toBe("owner"); }
    finally { globalThis.fetch = previous; }
    expect(f.seen).toEqual([expect.objectContaining({ owner: "owner", authorized: true })]);
  } finally { f.stop(); }
});
