import { expect, test } from "bun:test";
import {
  parsePlanExternalEditorCapabilities,
  parsePlanExternalEditorList,
  parsePlanExternalEditorObservation,
  parsePlanExternalEditorRecovery,
  type PlanExternalEditorObservation,
  type PlanExternalEditorRequest,
} from "../../../packages/shared/src/plan-external-editor";
import { MAX_PLAN_CONTENT_BYTES, SESSION_PLAN_OWNER_HEADER } from "../../../packages/shared/src/session-plan";
import { PlanExternalEditorHttp, type PlanExternalEditorHttpAction } from "./plan-external-editor-http";

const hostId = "home", controlEpoch = "20000000-0000-0000-0000-000000000002";
const input: PlanExternalEditorRequest = {
  requestId: "10000000-0000-0000-0000-000000000001",
  controlEpoch,
  sessionId: "session",
  ticket: { epoch: "plan-epoch", nativeSessionId: "native-session", revision: "a".repeat(64) },
  reviewId: "review",
  reviewRevision: "b".repeat(64),
  documentRevision: "document-revision",
  edit: { kind: "plan" },
};
const pending = (): PlanExternalEditorObservation => ({ protocolVersion: 1, hostId, request: input, state: "pending",
  terminalId: "30000000-0000-0000-0000-000000000003" });
const unknown = (): PlanExternalEditorObservation => ({ ...pending(), state: "settled", result: { outcome: "unknown",
  message: "Inspect retained output." } });
const request = (action: PlanExternalEditorHttpAction, options: { method?: string; owner?: string; body?: unknown; query?: string } = {}) =>
  new Request(`http://localhost/v1/sessions/session/plan/editor/${action}${options.query ?? ""}`, {
    method: options.method ?? (action === "capabilities" || action === "list" ? "GET" : "POST"),
    headers: { [SESSION_PLAN_OWNER_HEADER]: options.owner ?? hostId },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

function fixture() {
  const calls = { capabilities: 0, list: 0, start: 0, observe: 0, cancel: 0, recovery: 0 };
  let exists = true, capabilityGate: Promise<void> = Promise.resolve(), cancelGate: Promise<void> = Promise.resolve();
  let listCursor: string | undefined;
  let observation: PlanExternalEditorObservation = pending(), recoveryContent: string | undefined;
  const service = {
    capabilities: async (sessionId: string) => { calls.capabilities++; expect(sessionId).toBe("session"); await capabilityGate;
      return { protocolVersion: 1 as const, hostId, controlEpoch, available: true }; },
    list: (sessionId: string, cursor?: string) => { calls.list++; expect(sessionId).toBe("session"); listCursor = cursor;
      return { protocolVersion: 1 as const, hostId, sessionId, items: [observation] }; },
    start: (value: PlanExternalEditorRequest) => { calls.start++; expect(value).toEqual(input); return observation; },
    observe: (value: PlanExternalEditorRequest) => { calls.observe++; expect(value).toEqual(input); return observation; },
    cancel: async (value: PlanExternalEditorRequest) => { calls.cancel++; expect(value).toEqual(input); await cancelGate; return observation; },
    recovery: (value: PlanExternalEditorRequest) => { calls.recovery++; expect(value).toEqual(input); return recoveryContent; },
  };
  const http = new PlanExternalEditorHttp({ hostId, sessionExists: id => exists && id === "session", service });
  return { http, calls, retire: () => { exists = false; }, setObservation: (value: PlanExternalEditorObservation) => { observation = value; },
    setRecovery: (value: string | undefined) => { recoveryContent = value; },
    holdCapability: (value: Promise<void>) => { capabilityGate = value; }, holdCancel: (value: Promise<void>) => { cancelGate = value; },
    listCursor: () => listCursor };
}

test("capability GET binds the host and original session without exposing editor launch details", async () => {
  const f = fixture(), response = await f.http.route(request("capabilities"), "session", "capabilities");
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get(SESSION_PLAN_OWNER_HEADER)).toBe(hostId);
  expect(parsePlanExternalEditorCapabilities(await response.json(), hostId)).toEqual({ protocolVersion: 1, hostId, controlEpoch, available: true });
  expect(f.calls).toEqual({ capabilities: 1, list: 0, start: 0, observe: 0, cancel: 0, recovery: 0 });
});

test("start, status, and cancel accept only the exact path-bound shared request", async () => {
  const f = fixture();
  for (const action of ["start", "status", "cancel"] as const) {
    const response = await f.http.route(request(action, { body: input }), "session", action);
    expect(response.status).toBe(200);
    expect(parsePlanExternalEditorObservation(await response.json(), hostId, input)).toEqual(pending());
  }
  expect(f.calls).toMatchObject({ start: 1, observe: 1, cancel: 1 });
});

test("owner, method, query, body, and session mismatches are refused before editor effects", async () => {
  const f = fixture(), changed = { ...input, sessionId: "other" };
  expect((await f.http.route(request("start", { owner: "work", body: input }), "session", "start")).status).toBe(409);
  expect((await f.http.route(request("start", { method: "GET" }), "session", "start")).status).toBe(405);
  expect((await f.http.route(request("start", { body: input, query: "?command=/private/editor" }), "session", "start")).status).toBe(400);
  expect((await f.http.route(request("start", { body: changed }), "session", "start")).status).toBe(400);
  expect((await f.http.route(request("start", { body: { ...input, command: "private-editor" } }), "session", "start")).status).toBe(400);
  expect((await f.http.route(request("start", { body: input }), "other", "start")).status).toBe(400);
  expect(f.calls).toEqual({ capabilities: 0, list: 0, start: 0, observe: 0, cancel: 0, recovery: 0 });
});

test("capability refuses a session retired while its original inspection is pending", async () => {
  const capability = Promise.withResolvers<void>(), first = fixture(); first.holdCapability(capability.promise);
  const capabilityRead = first.http.route(request("capabilities"), "session", "capabilities");
  first.retire(); capability.resolve();
  expect((await capabilityRead).status).toBe(409);

  expect(first.calls.capabilities).toBe(1);
});

test("start rechecks the original session after a held body before launching", async () => {
  const f = fixture(), body = Promise.withResolvers<Uint8Array | undefined>();
  const stream = new ReadableStream<Uint8Array>({ pull: async controller => {
    const value = await body.promise;
    if (value) controller.enqueue(value);
    controller.close();
  } });
  const pendingStart = f.http.route(new Request("http://localhost/v1/sessions/session/plan/editor/start", {
    method: "POST", headers: { [SESSION_PLAN_OWNER_HEADER]: hostId }, body: stream,
  }), "session", "start");
  f.retire(); body.resolve(new TextEncoder().encode(JSON.stringify(input)));
  expect((await pendingStart).status).toBe(409);
  expect(f.calls.start).toBe(0);
});

test("status, cancellation, and recovery remain bound to a durable job after its session leaves the catalog", async () => {
  const f = fixture(); f.setObservation(unknown()); f.setRecovery("retained edited Plan"); f.retire();
  const status = await f.http.route(request("status", { body: input }), "session", "status");
  expect(parsePlanExternalEditorObservation(await status.json(), hostId, input)).toEqual(unknown());
  const cancel = await f.http.route(request("cancel", { body: input }), "session", "cancel");
  expect(parsePlanExternalEditorObservation(await cancel.json(), hostId, input)).toEqual(unknown());
  const recovery = await f.http.route(request("recovery", { body: input }), "session", "recovery");
  expect(parsePlanExternalEditorRecovery(await recovery.json(), hostId, input)).toEqual({ observation: unknown(), content: "retained edited Plan" });
  expect(f.calls).toMatchObject({ start: 0, observe: 2, cancel: 1, recovery: 1 });
});

test("list discovers durable exact-session jobs after retirement and strictly binds its optional cursor", async () => {
  const f = fixture(); f.retire();
  const listed = await f.http.route(request("list"), "session", "list");
  expect(parsePlanExternalEditorList(await listed.json(), hostId, "session").items).toEqual([pending()]);
  const cursor = input.requestId;
  expect((await f.http.route(request("list", { query: `?cursor=${cursor}` }), "session", "list")).status).toBe(200);
  expect(f.listCursor()).toBe(cursor);
  expect((await f.http.route(request("list", { query: "?cursor=invalid" }), "session", "list")).status).toBe(400);
  expect((await f.http.route(request("list", { query: `?cursor=${cursor}&path=/private/file` }), "session", "list")).status).toBe(400);
  expect((await f.http.route(request("list", { method: "POST", body: input }), "session", "list")).status).toBe(405);
  expect(f.calls.list).toBe(2);
});

test("explicit recovery returns only bounded output for the exact unknown observation", async () => {
  const f = fixture(); f.setObservation(unknown()); f.setRecovery("retained edited Plan");
  const response = await f.http.route(request("recovery", { body: input }), "session", "recovery");
  expect(response.status).toBe(200);
  expect(parsePlanExternalEditorRecovery(await response.json(), hostId, input)).toEqual({ observation: unknown(), content: "retained edited Plan" });
  expect(f.calls).toMatchObject({ observe: 1, recovery: 1 });

  f.setRecovery("x".repeat(MAX_PLAN_CONTENT_BYTES + 1));
  const oversized = await f.http.route(request("recovery", { body: input }), "session", "recovery");
  expect(oversized.status).toBe(409);
  expect(await oversized.text()).not.toContain("xxxxx");
});

test("malformed service output and private operational failures are sanitized", async () => {
  const malformed = fixture(); malformed.setObservation({ ...pending(), hostId: "other" });
  expect((await malformed.http.route(request("status", { body: input }), "session", "status")).status).toBe(409);
  const service = { capabilities: async () => { throw new Error("private VISUAL command"); }, list: () => { throw new Error("private list"); },
    start: () => { throw new Error("private argv"); },
    observe: () => pending(), cancel: async () => pending(), recovery: () => undefined };
  const http = new PlanExternalEditorHttp({ hostId, sessionExists: () => true, service });
  for (const [action, req] of [["capabilities", request("capabilities")], ["start", request("start", { body: input })]] as const) {
    const response = await http.route(req, "session", action), body = await response.text();
    expect(response.status).toBe(409); expect(body).not.toContain("private");
  }
});
