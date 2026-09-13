import { expect, test } from "bun:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { SESSION_PLAN_OWNER_HEADER, type PlanDocumentReadRequest, type PlanDocumentResponse, type SessionPlanResponse } from "../../../../packages/shared/src/session-plan";
import { registerPlanReadHandler, requestPlanDocumentSection, requestSessionPlan } from "./plan-transport";
import { commandEndpoint, requestVersionedCommand } from "./command-endpoints";
import { HostRequestError } from "./host-transport";

const endpoint = { origin: "https://owner.invalid", hostId: "owner", token: "inert-token" };
const response = (sessionId = "session/name"): SessionPlanResponse => ({
  protocolVersion: 1, hostId: "owner", sessionId,
  value: { ticket: { epoch: "epoch", nativeSessionId: "native", revision: "a".repeat(64) }, mode: "off", enabled: true,
    canToggle: true, review: null, executionChoices: [] },
});
const documentRequest: PlanDocumentReadRequest = { sessionId: "session/name",
  ticket: { epoch: "epoch", nativeSessionId: "native", revision: "a".repeat(64) }, reviewId: "review",
  reviewRevision: "b".repeat(64), selection: { documentRevision: "document-revision", renderColumns: 80, sectionId: "section-one" } };
const documentResponse: PlanDocumentResponse = { protocolVersion: 1, hostId: "owner", sessionId: "session/name",
  ticket: documentRequest.ticket, reviewId: documentRequest.reviewId, reviewRevision: documentRequest.reviewRevision,
  value: { ...documentRequest.selection, level: 1, title: "Section one", annotationCount: 0,
    rows: [{ rowId: "row-one", text: "Rendered native row", truncated: false, annotationIds: [] }], annotations: [] } };

test("Plan document transport captures its endpoint and binds the exact native selection response", async () => {
  const previous = globalThis.fetch, mutable = { ...endpoint }; let observed: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    observed = { url: String(url), init }; mutable.origin = "https://changed.invalid"; mutable.hostId = "changed";
    return Response.json(documentResponse, { headers: { [SESSION_PLAN_OWNER_HEADER]: "owner" } });
  }) as unknown as typeof fetch;
  try {
    expect(await requestPlanDocumentSection(mutable, documentRequest)).toEqual(documentResponse);
    const url = new URL(observed!.url); expect(`${url.origin}${url.pathname}`).toBe("https://owner.invalid/v1/sessions/session%2Fname/plan/section");
    expect(JSON.parse(url.searchParams.get("request")!)).toEqual(documentRequest);
    expect(observed!.init).toEqual(expect.objectContaining({ redirect: "error",
      headers: { [SESSION_PLAN_OWNER_HEADER]: "owner", Authorization: "Bearer inert-token" } }));
  } finally { globalThis.fetch = previous; }
});

test("Plan document transport rejects malformed requests and stale response owners or selections", async () => {
  const previous = globalThis.fetch; let fetches = 0;
  try {
    globalThis.fetch = (async () => { fetches++; return Response.json(documentResponse,
      { headers: { [SESSION_PLAN_OWNER_HEADER]: "owner" } }); }) as unknown as typeof fetch;
    for (const raw of [
      { ...documentRequest, selection: { ...documentRequest.selection, renderColumns: 241 } },
      { ...documentRequest, selection: { ...documentRequest.selection, sectionId: "" } },
      { ...documentRequest, reviewRevision: "stale" },
    ]) await expect(requestPlanDocumentSection(endpoint, raw)).rejects.toThrow();
    expect(fetches).toBe(0);
    for (const value of [
      { ...documentResponse, sessionId: "other" },
      { ...documentResponse, reviewId: "other" },
      { ...documentResponse, value: { ...documentResponse.value, renderColumns: 120 } },
      { ...documentResponse, value: { ...documentResponse.value, sectionId: "other" } },
    ]) {
      globalThis.fetch = (async () => Response.json(value, { headers: { [SESSION_PLAN_OWNER_HEADER]: "owner" } })) as unknown as typeof fetch;
      await expect(requestPlanDocumentSection(endpoint, documentRequest)).rejects.toThrow();
    }
  } finally { globalThis.fetch = previous; }
});

test("Plan document IPC rechecks renderer trust and endpoint identity after held transport", async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>();
  const ipc: Pick<IpcMain, "handle"> = { handle(channel, listener) { handlers.set(channel, listener); } };
  let trusted = true; const mutable = { origin: "https://owner.invalid", hostId: "owner", token: "inert-token" };
  registerPlanReadHandler(ipc, () => { if (!trusted) throw new Error("Untrusted sender"); }, async () => mutable);
  const invoke = () => handlers.get("host:plan-document-section")!({} as IpcMainInvokeEvent, documentRequest, "owner");
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = (async () => { trusted = false; return Response.json(documentResponse,
      { headers: { [SESSION_PLAN_OWNER_HEADER]: "owner" } }); }) as unknown as typeof fetch;
    await expect(invoke()).rejects.toThrow("Untrusted sender");
    trusted = true;
    globalThis.fetch = (async () => { mutable.token = "replacement"; return Response.json(documentResponse,
      { headers: { [SESSION_PLAN_OWNER_HEADER]: "owner" } }); }) as unknown as typeof fetch;
    await expect(invoke()).rejects.toThrow("endpoint changed");
  } finally { globalThis.fetch = previous; }
});

test("Plan read captures its endpoint, sends the owner header, and binds the shared response owner", async () => {
  const previous = globalThis.fetch; const mutable = { ...endpoint }; const calls: unknown[] = [];
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ url, init }); mutable.origin = "https://changed.invalid"; mutable.hostId = "changed"; mutable.token = "changed";
    return Response.json(response(), { headers: { [SESSION_PLAN_OWNER_HEADER]: "owner" } });
  }) as unknown as typeof fetch;
  try {
    expect(await requestSessionPlan(mutable, "session/name")).toEqual(response());
    expect(calls).toEqual([{ url: "https://owner.invalid/v1/sessions/session%2Fname/plan", init: expect.objectContaining({
      redirect: "error", headers: { [SESSION_PLAN_OWNER_HEADER]: "owner", Authorization: "Bearer inert-token" },
    }) }]);
  } finally { globalThis.fetch = previous; }
});

test("Plan read requests and parses only the exact original durable decision receipt", async () => {
  const previous = globalThis.fetch;
  const receipt = { commandId: "decision-1", reviewId: "review", reviewRevision: "b".repeat(64), action: "save" as const,
    outcome: "unknown" as const, artifact: "written" as const, transition: "unknown" as const, execution: "not-requested" as const,
    savedDestination: "/owner/plan.md" };
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
    expect(url).toBe("https://owner.invalid/v1/sessions/session%2Fname/plan?commandId=decision-1");
    return Response.json({ ...response(), decisionReceipt: { commandId: "decision-1", state: "unknown",
      value: { type: "session.plan.mutate", receipt } } },
      { headers: { [SESSION_PLAN_OWNER_HEADER]: "owner" } });
  }) as unknown as typeof fetch;
  try {
    expect((await requestSessionPlan(endpoint, "session/name", "decision-1")).decisionReceipt).toEqual({ commandId: "decision-1", state: "unknown",
      value: { type: "session.plan.mutate", receipt } });
    await expect(requestSessionPlan(endpoint, "session/name", "not/a-command")).rejects.toThrow("identity");
  } finally { globalThis.fetch = previous; }
});

test("owner mismatch, malformed JSON, oversized bodies, and changed response owners are rejected", async () => {
  const previous = globalThis.fetch;
  try {
    const cases = [
      Response.json(response(), { headers: { [SESSION_PLAN_OWNER_HEADER]: "other" } }),
      new Response("{", { headers: { [SESSION_PLAN_OWNER_HEADER]: "owner" } }),
      new Response(new Uint8Array(12 * 1024 * 1024 + 1), { headers: { [SESSION_PLAN_OWNER_HEADER]: "owner" } }),
      Response.json({ ...response(), sessionId: "other" }, { headers: { [SESSION_PLAN_OWNER_HEADER]: "owner" } }),
    ];
    for (const value of cases) {
      globalThis.fetch = (async () => value) as unknown as typeof fetch;
      await expect(requestSessionPlan(endpoint, "session/name")).rejects.toThrow();
    }
  } finally { globalThis.fetch = previous; }
});

test("host refusals preserve bounded codes and sanitize untrusted error text", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ error: { code: "STALE_TARGET", message: "The original session retired." } },
      { status: 409, headers: { [SESSION_PLAN_OWNER_HEADER]: "owner" } })) as unknown as typeof fetch;
    await expect(requestSessionPlan(endpoint, "session/name")).rejects.toMatchObject({ status: 409, code: "STALE_TARGET", message: "The original session retired." });
    globalThis.fetch = (async () => Response.json({ error: { code: "private-value", message: "line one\nprivate detail" } },
      { status: 500, headers: { [SESSION_PLAN_OWNER_HEADER]: "owner" } })) as unknown as typeof fetch;
    await expect(requestSessionPlan(endpoint, "session/name")).rejects.toMatchObject({ status: 500, code: undefined, message: "Native Plan read failed (500)." });
  } finally { globalThis.fetch = previous; }
});

test("registered IPC rechecks renderer trust and the exact endpoint after each asynchronous boundary", async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>();
  const ipc: Pick<IpcMain, "handle"> = { handle(channel, listener) { handlers.set(channel, listener); } };
  let trusted = true; const mutable = { origin: "https://owner.invalid", hostId: "owner" };
  registerPlanReadHandler(ipc, () => { if (!trusted) throw new Error("Untrusted sender"); }, async () => mutable);
  const invoke = () => handlers.get("host:plan-read")!({} as IpcMainInvokeEvent, "session/name", "owner");
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = (async () => { trusted = false; return Response.json(response(), { headers: { [SESSION_PLAN_OWNER_HEADER]: "owner" } }); }) as unknown as typeof fetch;
    await expect(invoke()).rejects.toThrow("Untrusted sender");
    trusted = true;
    globalThis.fetch = (async () => { mutable.origin = "https://changed.invalid"; return Response.json(response(), { headers: { [SESSION_PLAN_OWNER_HEADER]: "owner" } }); }) as unknown as typeof fetch;
    await expect(invoke()).rejects.toThrow("endpoint changed");
  } finally { globalThis.fetch = previous; }
});

test("invalid renderer identities fail before endpoint lookup or fetch", async () => {
  let lookups = 0, fetches = 0;
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>();
  const ipc: Pick<IpcMain, "handle"> = { handle(channel, listener) { handlers.set(channel, listener); } };
  registerPlanReadHandler(ipc, () => {}, async () => { lookups++; return endpoint; });
  const previous = globalThis.fetch; globalThis.fetch = (async () => { fetches++; return Response.json(response()); }) as unknown as typeof fetch;
  try {
    for (const [sessionId, hostId] of [["", "owner"], ["session", ""], ["session\n", "owner"], ["session", "owner\0"]])
      await expect(handlers.get("host:plan-read")!({} as IpcMainInvokeEvent, sessionId, hostId)).rejects.toThrow("owning");
    expect({ lookups, fetches }).toEqual({ lookups: 0, fetches: 0 });
  } finally { globalThis.fetch = previous; }
});

test("Plan commands select the typed v19 endpoint and only an uncoded 404 becomes unsupported", async () => {
  const envelope = { id: "decision-1", commandVersion: 19 as const, command: { type: "session.plan.control" as const,
    sessionId: "session", ticket: { epoch: "worker", nativeSessionId: "native", revision: "a".repeat(64) }, action: "toggle" as const } };
  expect(commandEndpoint(envelope)).toBe("/v19/commands");
  expect(await requestVersionedCommand(async path => { expect(path).toBe("/v19/commands"); throw new HostRequestError("Missing", 404); }, envelope))
    .toEqual({ ok: false, commandId: "decision-1", error: { code: "PLAN_PROTOCOL_UNSUPPORTED", message: "Update the owning host to review or change native Plan state. This request was not accepted." } });
  const coded = new HostRequestError("Plan refused", 404, "PLAN_REFUSED");
  await expect(requestVersionedCommand(async () => { throw coded; }, envelope)).rejects.toBe(coded);
});

test("Plan document commands select v20 while existing Plan commands retain v19 compatibility", async () => {
  const document = { id: "document-1", commandVersion: 20 as const, command: { type: "session.plan.mutate" as const,
    sessionId: "session", ticket: { epoch: "worker", nativeSessionId: "native", revision: "a".repeat(64) },
    reviewId: "review", reviewRevision: "b".repeat(64), mutation: { action: "document" as const, renderColumns: 120,
      documentAction: { kind: "undo" as const, expectedDocumentRevision: "document-revision" } } } };
  expect(commandEndpoint(document)).toBe("/v20/commands");
  expect(commandEndpoint({ ...document, commandVersion: 19 })).toBe("/v20/commands");
  expect(commandEndpoint({ ...document, command: { ...document.command, mutation: { action: "edit" as const, content: "# Plan" } } })).toBe("/v20/commands");
  expect(commandEndpoint({ ...document, commandVersion: 19, command: { ...document.command, mutation: { action: "edit" as const, content: "# Plan" } } })).toBe("/v19/commands");
  expect(await requestVersionedCommand(async path => { expect(path).toBe("/v20/commands"); throw new HostRequestError("Missing", 404); }, document))
    .toEqual({ ok: false, commandId: "document-1", error: { code: "PLAN_DOCUMENT_PROTOCOL_UNSUPPORTED",
      message: "Update the owning host to change the native Plan document. This request was not accepted." } });
});
