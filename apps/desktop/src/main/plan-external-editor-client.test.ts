import { afterEach, expect, test } from "bun:test";
import type { PlanExternalEditorObservation, PlanExternalEditorRequest } from "../../../../packages/shared/src/plan-external-editor";
import { SESSION_PLAN_OWNER_HEADER } from "../../../../packages/shared/src/session-plan";
import { cancelPlanExternalEditor, recoverPlanExternalEditor, requestPlanExternalEditorCapabilities,
  requestPlanExternalEditorList, requestPlanExternalEditorStatus, startPlanExternalEditor } from "./plan-external-editor-client";

const endpoint = { origin: "https://owner.invalid", hostId: "owner", token: "inert-token" };
const input: PlanExternalEditorRequest = { requestId: "10000000-0000-4000-8000-000000000001",
  controlEpoch: "20000000-0000-4000-8000-000000000002", sessionId: "session/name",
  ticket: { epoch: "epoch", nativeSessionId: "native", revision: "a".repeat(64) }, reviewId: "review",
  reviewRevision: "b".repeat(64), documentRevision: "document", edit: { kind: "plan" } };
const pending = (): PlanExternalEditorObservation => ({ protocolVersion: 1, hostId: "owner", request: input, state: "pending",
  terminalId: "30000000-0000-4000-8000-000000000003" });
const unknown = (): PlanExternalEditorObservation => ({ ...pending(), state: "settled",
  result: { outcome: "unknown", message: "Inspect retained output." } });
const response = (value: unknown, init: ResponseInit = {}) => Response.json(value,
  { ...init, headers: { [SESSION_PLAN_OWNER_HEADER]: "owner", ...init.headers } });
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("capability, paginated list, and four command-keyed operations use only the captured owner endpoint and exact request body", async () => {
  const mutable = { ...endpoint }, calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ url: String(url), init }); mutable.origin = "https://changed.invalid"; mutable.hostId = "changed"; mutable.token = "changed";
    const action = String(url).split("/").at(-1)!;
    if (action === "capabilities") return response({ protocolVersion: 1, hostId: "owner", controlEpoch: input.controlEpoch, available: true });
    if (action.startsWith("list")) return response({ protocolVersion: 1, hostId: "owner", sessionId: input.sessionId, items: [] });
    if (action === "recovery") return response({ observation: unknown(), content: "retained\bcontent" });
    return response(pending());
  }) as unknown as typeof fetch;
  expect(await requestPlanExternalEditorCapabilities(mutable, input.sessionId)).toMatchObject({ available: true, hostId: "owner" });
  expect(await requestPlanExternalEditorList({ ...endpoint }, input.sessionId, input.requestId)).toEqual({ protocolVersion: 1, hostId: "owner", sessionId: input.sessionId, items: [] });
  // Each operation gets a fresh mutable object because capture intentionally
  // freezes the endpoint only for one request.
  for (const invoke of [startPlanExternalEditor, requestPlanExternalEditorStatus, cancelPlanExternalEditor])
    expect(await invoke({ ...endpoint }, input)).toEqual(pending());
  expect(await recoverPlanExternalEditor({ ...endpoint }, input)).toEqual({ observation: unknown(), content: "retained\bcontent" });
  expect(calls.map(call => [new URL(call.url).pathname, call.init?.method])).toEqual([
    ["/v1/sessions/session%2Fname/plan/editor/capabilities", "GET"],
    ["/v1/sessions/session%2Fname/plan/editor/list", "GET"],
    ["/v1/sessions/session%2Fname/plan/editor/start", "POST"],
    ["/v1/sessions/session%2Fname/plan/editor/status", "POST"],
    ["/v1/sessions/session%2Fname/plan/editor/cancel", "POST"],
    ["/v1/sessions/session%2Fname/plan/editor/recovery", "POST"],
  ]);
  expect(new URL(calls[1]!.url).searchParams.get("cursor")).toBe(input.requestId);
  for (const call of calls) {
    expect(call.init).toEqual(expect.objectContaining({ redirect: "error",
      headers: expect.objectContaining({ [SESSION_PLAN_OWNER_HEADER]: "owner", Authorization: "Bearer inert-token" }) }));
    if (call.init?.method === "POST") expect(JSON.parse(String(call.init.body))).toEqual(input);
  }
});

test("request and response ownership is parsed before effects or publication", async () => {
  let fetches = 0;
  globalThis.fetch = (async () => { fetches++; return response(pending()); }) as unknown as typeof fetch;
  await expect(startPlanExternalEditor(endpoint, { ...input, path: "/private/plan.md" })).rejects.toThrow("keys");
  await expect(startPlanExternalEditor(endpoint, { ...input, environment: { TOKEN: "hidden" } })).rejects.toThrow("keys");
  await expect(requestPlanExternalEditorCapabilities(endpoint, "bad\nowner")).rejects.toThrow("owning conversation");
  expect(fetches).toBe(0);
  globalThis.fetch = (async () => Response.json(pending(), { headers: { [SESSION_PLAN_OWNER_HEADER]: "other" } })) as unknown as typeof fetch;
  await expect(requestPlanExternalEditorStatus(endpoint, input)).rejects.toMatchObject({ status: 409, code: "OWNER_MISMATCH" });
  globalThis.fetch = (async () => response({ ...pending(), request: { ...input, documentRevision: "changed" } })) as unknown as typeof fetch;
  await expect(requestPlanExternalEditorStatus(endpoint, input)).rejects.toThrow("request");
});

test("bounded errors remain typed while malformed, invalid UTF-8, and escaping-overbound bodies are refused", async () => {
  globalThis.fetch = (async () => response({ error: { code: "STALE_TARGET", message: "The original session retired." } }, { status: 409 })) as unknown as typeof fetch;
  await expect(cancelPlanExternalEditor(endpoint, input)).rejects.toMatchObject({ status: 409, code: "STALE_TARGET", message: "The original session retired." });
  globalThis.fetch = (async () => response({ error: { code: "private-code", message: "line\nprivate" } }, { status: 500 })) as unknown as typeof fetch;
  await expect(cancelPlanExternalEditor(endpoint, input)).rejects.toMatchObject({ status: 500, code: undefined, message: "Native Plan editor request failed (500)." });
  for (const body of ["{", new Uint8Array([0xff])]) {
    globalThis.fetch = (async () => new Response(body, { headers: { [SESSION_PLAN_OWNER_HEADER]: "owner" } })) as unknown as typeof fetch;
    await expect(requestPlanExternalEditorStatus(endpoint, input)).rejects.toThrow("Invalid or oversized");
  }
  globalThis.fetch = (async () => new Response(new ReadableStream({ start(controller) {
    const chunk = new Uint8Array(1024 * 1024); for (let i = 0; i < 60; i++) controller.enqueue(chunk); controller.close();
  } }), { headers: { [SESSION_PLAN_OWNER_HEADER]: "owner" } })) as unknown as typeof fetch;
  await expect(recoverPlanExternalEditor(endpoint, input)).rejects.toThrow("Invalid or oversized");
});
