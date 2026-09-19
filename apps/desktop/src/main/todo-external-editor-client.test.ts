import { afterEach, expect, test } from "bun:test";
import type { TodoExternalEditorObservation, TodoExternalEditorRequest } from "../../../../packages/shared/src/todo-external-editor";
import { SESSION_TODOS_OWNER_HEADER } from "../../../../packages/shared/src/session-todos";
import { cancelTodoExternalEditor, recoverTodoExternalEditor, requestTodoExternalEditorCapabilities,
  requestTodoExternalEditorList, requestTodoExternalEditorStatus, startTodoExternalEditor } from "./todo-external-editor-client";

const endpoint = { origin: "https://owner.invalid", hostId: "owner", token: "inert-token" };
const input: TodoExternalEditorRequest = { requestId: "10000000-0000-4000-8000-000000000001",
  controlEpoch: "20000000-0000-4000-8000-000000000002", sessionId: "session/name",
  ticket: { epoch: "worker", nativeSessionId: "session/name", revision: "a".repeat(64) } };
const pending = (): TodoExternalEditorObservation => ({ protocolVersion: 1, hostId: "owner", request: input, state: "pending",
  terminalId: "30000000-0000-4000-8000-000000000003" });
const unknown = (): TodoExternalEditorObservation => ({ ...pending(), state: "settled",
  result: { outcome: "unknown", message: "Inspect retained output." } });
const response = (value: unknown, init: ResponseInit = {}) => Response.json(value,
  { ...init, headers: { [SESSION_TODOS_OWNER_HEADER]: "owner", ...init.headers } });
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("capability, paginated list, and four command-keyed operations use only the captured owner endpoint and exact request body", async () => {
  const mutable = { ...endpoint }, calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ url: String(url), init }); mutable.origin = "https://changed.invalid"; mutable.hostId = "changed"; mutable.token = "changed";
    const action = String(url).split("/").at(-1)!;
    if (action === "capabilities") return response({ protocolVersion: 1, hostId: "owner", controlEpoch: input.controlEpoch, available: true });
    if (action.startsWith("list")) return response({ protocolVersion: 1, hostId: "owner", sessionId: input.sessionId, items: [] });
    if (action === "recovery") return response({ observation: unknown(), content: "retained\bcontent", source: "completed-output" });
    return response(pending());
  }) as unknown as typeof fetch;
  expect(await requestTodoExternalEditorCapabilities(mutable, input.sessionId)).toMatchObject({ available: true, hostId: "owner" });
  expect(await requestTodoExternalEditorList({ ...endpoint }, input.sessionId, input.requestId)).toEqual({ protocolVersion: 1, hostId: "owner", sessionId: input.sessionId, items: [] });
  // Each operation gets a fresh mutable object because capture intentionally
  // freezes the endpoint only for one request.
  for (const invoke of [startTodoExternalEditor, requestTodoExternalEditorStatus, cancelTodoExternalEditor])
    expect(await invoke({ ...endpoint }, input)).toEqual(pending());
  expect(await recoverTodoExternalEditor({ ...endpoint }, input)).toEqual({ observation: unknown(), content: "retained\bcontent", source: "completed-output" });
  expect(calls.map(call => [new URL(call.url).pathname, call.init?.method])).toEqual([
    ["/v1/sessions/session%2Fname/todos/editor/capabilities", "GET"],
    ["/v1/sessions/session%2Fname/todos/editor/list", "GET"],
    ["/v1/sessions/session%2Fname/todos/editor/start", "POST"],
    ["/v1/sessions/session%2Fname/todos/editor/status", "POST"],
    ["/v1/sessions/session%2Fname/todos/editor/cancel", "POST"],
    ["/v1/sessions/session%2Fname/todos/editor/recovery", "POST"],
  ]);
  expect(new URL(calls[1]!.url).searchParams.get("cursor")).toBe(input.requestId);
  for (const call of calls) {
    expect(call.init).toEqual(expect.objectContaining({ redirect: "error",
      headers: expect.objectContaining({ [SESSION_TODOS_OWNER_HEADER]: "owner", Authorization: "Bearer inert-token" }) }));
    if (call.init?.method === "POST") expect(JSON.parse(String(call.init.body))).toEqual(input);
  }
});

test("request and response ownership is parsed before effects or publication", async () => {
  let fetches = 0;
  globalThis.fetch = (async () => { fetches++; return response(pending()); }) as unknown as typeof fetch;
  await expect(startTodoExternalEditor(endpoint, { ...input, path: "/private/plan.md" })).rejects.toThrow("keys");
  await expect(startTodoExternalEditor(endpoint, { ...input, environment: { TOKEN: "hidden" } })).rejects.toThrow("keys");
  await expect(requestTodoExternalEditorCapabilities(endpoint, "bad\nowner")).rejects.toThrow("owning conversation");
  expect(fetches).toBe(0);
  globalThis.fetch = (async () => Response.json(pending(), { headers: { [SESSION_TODOS_OWNER_HEADER]: "other" } })) as unknown as typeof fetch;
  await expect(requestTodoExternalEditorStatus(endpoint, input)).rejects.toMatchObject({ status: 409, code: "OWNER_MISMATCH" });
  globalThis.fetch = (async () => response({ ...pending(), request: { ...input, ticket: { ...input.ticket, revision: "changed" } } })) as unknown as typeof fetch;
  await expect(requestTodoExternalEditorStatus(endpoint, input)).rejects.toThrow("request");
});

test("bounded errors remain typed while malformed, invalid UTF-8, and escaping-overbound bodies are refused", async () => {
  globalThis.fetch = (async () => response({ error: { code: "STALE_TARGET", message: "The original session retired." } }, { status: 409 })) as unknown as typeof fetch;
  await expect(cancelTodoExternalEditor(endpoint, input)).rejects.toMatchObject({ status: 409, code: "STALE_TARGET", message: "The original session retired." });
  globalThis.fetch = (async () => response({ error: { code: "private-code", message: "line\nprivate" } }, { status: 500 })) as unknown as typeof fetch;
  await expect(cancelTodoExternalEditor(endpoint, input)).rejects.toMatchObject({ status: 500, code: undefined, message: "Native Todo editor request failed (500)." });
  for (const body of ["{", new Uint8Array([0xff])]) {
    globalThis.fetch = (async () => new Response(body, { headers: { [SESSION_TODOS_OWNER_HEADER]: "owner" } })) as unknown as typeof fetch;
    await expect(requestTodoExternalEditorStatus(endpoint, input)).rejects.toThrow("Invalid or oversized");
  }
  globalThis.fetch = (async () => new Response(new ReadableStream({ start(controller) {
    const chunk = new Uint8Array(1024 * 1024); for (let i = 0; i < 60; i++) controller.enqueue(chunk); controller.close();
  } }), { headers: { [SESSION_TODOS_OWNER_HEADER]: "owner" } })) as unknown as typeof fetch;
  await expect(recoverTodoExternalEditor(endpoint, input)).rejects.toThrow("Invalid or oversized");
});
