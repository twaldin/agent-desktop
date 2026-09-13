import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionPlanHttp } from "./session-plan-http";
import { projectPlanDecisionJournalReceipt } from "./session-plan-http";
import { HostStore } from "./store";
import { MAX_PLAN_CONTENT_BYTES, parsePlanDocumentResponse, parseSessionPlanResponse, SESSION_PLAN_OWNER_HEADER,
  type PlanDocumentReadRequest, type SessionPlan } from "../../../packages/shared/src/session-plan";

const request = (query = "", owner = "home", method = "GET") => new Request(`http://localhost/v1/sessions/session/plan${query}`,
  { method, headers: { [SESSION_PLAN_OWNER_HEADER]: owner } });
const plan: SessionPlan = { ticket: { epoch: "worker", nativeSessionId: "session", revision: "a".repeat(64) },
  mode: "paused", enabled: true, canToggle: true, review: null, executionChoices: [] };
const documentRequest: PlanDocumentReadRequest = { sessionId: "session", ticket: plan.ticket, reviewId: "review",
  reviewRevision: "b".repeat(64), selection: { documentRevision: "document-revision", renderColumns: 80, sectionId: "section-one" } };
const documentSection = { ...documentRequest.selection, level: 1, title: "Section one", annotationCount: 1,
  rows: [{ rowId: "row-one", text: "Rendered native row", truncated: false, annotationIds: ["annotation-one"] }],
  annotations: [{ annotationId: "annotation-one", note: "Check this row", target: { kind: "line" as const, rowId: "row-one" } }] };
const sectionRequest = (input: unknown = documentRequest, owner = "home", method = "GET", target = "session") =>
  new Request(`http://localhost/v1/sessions/${encodeURIComponent(target)}/plan/section?${new URLSearchParams({ request: JSON.stringify(input) })}`,
    { method, headers: { [SESSION_PLAN_OWNER_HEADER]: owner } });

test("Plan document section read uses only the existing exact owner and returns a bounded no-store projection", async () => {
  let existingReads = 0, sectionReads = 0;
  const owner = { getPlan: async () => plan, getPlanDocumentSection: async (input: PlanDocumentReadRequest) => {
    sectionReads++; expect(input).toEqual(documentRequest); return documentSection;
  } };
  const service = new SessionPlanHttp({ hostId: "home", sessionExists: id => id === "session",
    receipt: (_, commandId) => ({ commandId, state: "absent" }), existing: async id => {
      existingReads++; expect(id).toBe("session"); return owner;
    } });
  const response = (await service.route(sectionRequest()))!;
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get(SESSION_PLAN_OWNER_HEADER)).toBe("home");
  expect(parsePlanDocumentResponse(await response.json(), "home", documentRequest).value).toEqual(documentSection);
  expect({ existingReads, sectionReads }).toEqual({ existingReads: 2, sectionReads: 1 });
});

test("Plan document section validates ownership, method, target, and complete native selection before reading a worker", async () => {
  let reads = 0;
  const service = new SessionPlanHttp({ hostId: "home", sessionExists: () => true,
    receipt: (_, commandId) => ({ commandId, state: "absent" }), existing: async () => { reads++; return undefined; } });
  expect((await service.route(sectionRequest(documentRequest, "work")))?.status).toBe(409);
  expect((await service.route(sectionRequest(documentRequest, "home", "POST")))?.status).toBe(405);
  expect((await service.route(sectionRequest(documentRequest, "home", "GET", "other")))?.status).toBe(400);
  for (const input of [
    { ...documentRequest, selection: { ...documentRequest.selection, renderColumns: 19 } },
    { ...documentRequest, selection: { ...documentRequest.selection, documentRevision: "" } },
    { ...documentRequest, selection: { ...documentRequest.selection, sectionId: "" } },
    { ...documentRequest, reviewRevision: "stale" },
  ]) expect((await service.route(sectionRequest(input)))?.status).toBe(400);
  expect(reads).toBe(0);
  expect((await service.route(sectionRequest()))?.status).toBe(409);
  expect(reads).toBe(1);
});

test("Plan document section refuses a retired or replaced worker after a held read without returning its projection", async () => {
  for (const change of ["retire", "replace"] as const) {
    const held = Promise.withResolvers<typeof documentSection>();
    const first = { getPlan: async () => plan, getPlanDocumentSection: () => held.promise };
    const replacement = { getPlan: async () => plan, getPlanDocumentSection: async () => documentSection };
    let exists = true, current = first;
    const service = new SessionPlanHttp({ hostId: "home", sessionExists: () => exists,
      receipt: (_, commandId) => ({ commandId, state: "absent" }), existing: async () => current });
    const pending = service.route(sectionRequest());
    if (change === "retire") exists = false; else current = replacement;
    held.resolve(documentSection);
    const response = (await pending)!;
    expect(response.status).toBe(409); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).not.toContain("Rendered native row");
  }
});

test("Plan document section refuses an oversized native projection without leaking partial rows", async () => {
  const oversized = { ...documentSection,
    rows: [{ rowId: "row-one", text: "private-row".repeat(200_000), truncated: false, annotationIds: ["annotation-one"] }] };
  const owner = { getPlan: async () => plan, getPlanDocumentSection: async () => oversized };
  const service = new SessionPlanHttp({ hostId: "home", sessionExists: () => true,
    receipt: (_, commandId) => ({ commandId, state: "absent" }), existing: async () => owner });
  const response = (await service.route(sectionRequest()))!, body = await response.text();
  expect(response.status).toBe(409); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(body).not.toContain("private-row"); expect(body).toContain("PLAN_DOCUMENT_UNAVAILABLE");
});

test("Plan inspection rejects foreign ownership, write methods, and client read paths before accessing a worker", async () => {
  let reads = 0;
  const service = new SessionPlanHttp({ hostId: "home", sessionExists: () => true,
    receipt: (_, commandId) => ({ commandId, state: "absent" }),
    existing: async () => { reads++; return undefined; } });
  expect((await service.route(request("", "work")))?.status).toBe(409);
  expect((await service.route(request("", "home", "POST")))?.status).toBe(405);
  for (const query of ["?path=/foreign/plan.md", "?commandId=", "?commandId=a&commandId=b", "?commandId=a/b"])
    expect((await service.route(request(query)))?.status).toBe(400);
  expect(reads).toBe(0);
  const absent = await service.route(request());
  const value = parseSessionPlanResponse(await absent!.json(), "home", "session");
  expect(value.value).toBeNull(); expect(value.unavailable).toContain("no loaded"); expect(reads).toBe(1);
});

test("Plan read returns the complete original state and refuses a session removed during its pending read", async () => {
  let exists = true;
  const held = Promise.withResolvers<SessionPlan>();
  const owner = { getPlan: () => held.promise };
  const service = new SessionPlanHttp({ hostId: "home", sessionExists: () => exists,
    receipt: (_, commandId) => ({ commandId, state: "absent" }),
    existing: async () => owner });
  const read = service.route(request());
  exists = false; held.resolve(plan);
  expect((await read)?.status).toBe(409);
  exists = true;
  const response = (await service.route(request()))!;
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(parseSessionPlanResponse(await response.json(), "home", "session").value).toEqual(plan);
});

test("Plan read refuses a worker replaced while its held native read is pending", async () => {
  const held = Promise.withResolvers<SessionPlan>();
  const first = { getPlan: () => held.promise }, replacement = { getPlan: async () => plan };
  let current = first;
  const service = new SessionPlanHttp({ hostId: "home", sessionExists: () => true,
    receipt: (_, commandId) => ({ commandId, state: "absent" }), existing: async () => current });
  const read = service.route(request());
  current = replacement; held.resolve(plan);
  const parsed = parseSessionPlanResponse(await (await read)!.json(), "home", "session");
  expect(parsed.value).toBeNull(); expect(parsed.unavailable).toContain("could not be read");
});

test("Malformed worker state and operational read failures remain unavailable without leaking native errors", async () => {
  const service = new SessionPlanHttp({ hostId: "home", sessionExists: () => true,
    receipt: (_, commandId) => ({ commandId, state: "absent" }),
    existing: async () => ({ getPlan: async () => { throw new Error("private credential failure"); } }) });
  const response = (await service.route(request()))!;
  const body = await response.text(); expect(body).not.toContain("private credential");
  expect(parseSessionPlanResponse(JSON.parse(body), "home", "session").value).toBeNull();
  const malformed = new SessionPlanHttp({ hostId: "home", sessionExists: () => true,
    receipt: (_, commandId) => ({ commandId, state: "absent" }),
    existing: async () => ({ getPlan: async () => ({ ...plan, ticket: { ...plan.ticket, revision: "malformed" } }) }) });
  const invalid = (await malformed.route(request()))!;
  expect(parseSessionPlanResponse(await invalid.json(), "home", "session").value).toBeNull();
});

test("actual durable Plan mutation commands expose only their exact original receipt without loading a worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "plan-journal-")), store = new HostStore(root);
  const ticket = plan.ticket;
  const command = { type: "session.plan.mutate" as const, sessionId: "session", ticket, reviewId: "review", reviewRevision: ticket.revision,
    mutation: { action: "edit" as const, content: "updated" } };
  const receipt = { commandId: "decision", reviewId: "review", reviewRevision: ticket.revision, action: "edit" as const,
    outcome: "applied" as const, artifact: "written" as const, transition: "unchanged" as const, execution: "not-requested" as const };
  try {
    expect(store.claimCommand("decision", "hash", command).kind).toBe("claimed");
    expect(projectPlanDecisionJournalReceipt(store.getCommand("decision"), "session", "decision", true).state).toBe("pending");
    expect(projectPlanDecisionJournalReceipt(store.getCommand("decision"), "session", "decision", false).state).toBe("unknown");
    expect(projectPlanDecisionJournalReceipt(store.getCommand("decision"), "other", "decision", true).state).toBe("absent");
    store.finishCommand("decision", "hash", { ok: true, commandId: "decision", value: { type: "session.plan.mutate", receipt } });
    const service = new SessionPlanHttp({ hostId: "home", sessionExists: () => true,
      receipt: (sessionId, commandId) => projectPlanDecisionJournalReceipt(store.getCommand(commandId), sessionId, commandId, false),
      existing: async () => undefined });
    const response = (await service.route(request("?commandId=decision")))!;
    const parsed = parseSessionPlanResponse(await response.json(), "home", "session", "decision");
    expect(parsed.value).toBeNull(); expect(parsed.decisionReceipt).toEqual({ commandId: "decision", state: "succeeded",
      value: { type: "session.plan.mutate", receipt } });
    expect((await service.route(request("?commandId=missing")))?.status).toBe(200);
    expect(parseSessionPlanResponse(await (await service.route(request("?commandId=missing")))!.json(), "home", "session", "missing").decisionReceipt)
      .toEqual({ commandId: "missing", state: "absent" });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("only explicit pre-effect refusal is failed; other errors and corrupt success remain unknown", () => {
  const base = { id: "decision", requestHash: "hash", command: { type: "session.plan.mutate" as const, sessionId: "session",
    ticket: plan.ticket, reviewId: "review", reviewRevision: plan.ticket.revision, mutation: { action: "edit" as const, content: "value" } },
    state: "done" as const, createdAt: 1, updatedAt: 2 };
  for (const code of ["PLAN_NOT_LOADED", "PLAN_NOT_READY", "PLAN_REJECTED"])
    expect(projectPlanDecisionJournalReceipt({ ...base, result: { ok: false, commandId: "decision", error: { code, message: "definite refusal" } } }, "session", "decision", false).state).toBe("failed");
  expect(projectPlanDecisionJournalReceipt({ ...base, result: { ok: false, commandId: "decision", error: { code: "COMMAND_FAILED", message: "unbounded" } } }, "session", "decision", false).state).toBe("unknown");
  expect(projectPlanDecisionJournalReceipt({ ...base, result: { ok: false, commandId: "decision", error: { code: "OUTCOME_UNKNOWN", message: "lost" } } }, "session", "decision", false).state).toBe("unknown");
  expect(projectPlanDecisionJournalReceipt({ ...base, result: { ok: true, commandId: "decision", value: { type: "session.plan.mutate", receipt: { commandId: "other" } as never } } }, "session", "decision", false))
    .toEqual({ commandId: "decision", state: "unknown" });
});

test("successful control journal values preserve their command discriminator and exact native state", () => {
  const command = { type: "session.plan.control" as const, sessionId: "session", ticket: plan.ticket, action: "toggle" as const };
  const entry = { id: "toggle", requestHash: "hash", command, state: "done" as const, createdAt: 1, updatedAt: 2,
    result: { ok: true as const, commandId: "toggle", value: { type: "session.plan.control" as const, state: plan, cancelled: true as const } } };
  expect(projectPlanDecisionJournalReceipt(entry, "session", "toggle", false)).toEqual({ commandId: "toggle", state: "succeeded",
    value: { type: "session.plan.control", state: plan, cancelled: true } });
});

test("an escaped full-state control receipt exceeding the response bound retains only an honest unknown owner", async () => {
  const oversized = { ...plan, review: { id: "review", revision: plan.ticket.revision, title: "Large", reference: "local://PLAN.md",
    content: "\n".repeat(MAX_PLAN_CONTENT_BYTES), status: "ready" as const, canKeepContext: true } };
  const service = new SessionPlanHttp({ hostId: "home", sessionExists: () => true, existing: async () => undefined,
    receipt: (_, commandId) => ({ commandId, state: "succeeded", value: { type: "session.plan.control", state: oversized } }) });
  const response = (await service.route(request("?commandId=large")))!, body = await response.text();
  expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(12 * 1024 * 1024);
  const parsed = parseSessionPlanResponse(JSON.parse(body), "home", "session", "large");
  expect(parsed.value).toBeNull(); expect(parsed.decisionReceipt).toEqual({ commandId: "large", state: "unknown" });
});

test("Plan inspection exposes a durable execution continuation even when its worker and review are unavailable", async () => {
  const continuation = { originSessionId: "session", executionOwnerId: "destination", originalCommandId: "approve",
    latestAttemptId: "retry-one", state: "ready" as const };
  const service = new SessionPlanHttp({ hostId: "home", sessionExists: () => true, existing: async () => undefined,
    continuation: id => id === "session" ? continuation : undefined,
    receipt: (_, commandId) => ({ commandId, state: "absent" }) });
  const parsed = parseSessionPlanResponse(await (await service.route(request()))!.json(), "home", "session");
  expect(parsed.value).toBeNull(); expect(parsed.executionContinuation).toEqual(continuation);
});

test("retry receipts bind the attempt and original decision without rewriting the original receipt", () => {
  const command = { type: "session.plan.execution.retry" as const, sessionId: "destination", originSessionId: "origin",
    originalCommandId: "approve", expectedAttemptId: "approve" };
  const base = { id: "retry", requestHash: "hash", command, state: "done" as const, createdAt: 1, updatedAt: 2 };
  const value = { type: "session.plan.execution.retry" as const, originalCommandId: "approve", attemptId: "retry", execution: "not-entered" as const };
  expect(projectPlanDecisionJournalReceipt({ ...base, result: { ok: true, commandId: "retry", value } }, "destination", "retry", false))
    .toEqual({ commandId: "retry", state: "succeeded", value });
  expect(projectPlanDecisionJournalReceipt({ ...base, result: { ok: true, commandId: "retry",
    value: { ...value, originalCommandId: "other" } } }, "destination", "retry", false).state).toBe("unknown");
  expect(projectPlanDecisionJournalReceipt({ ...base, result: { ok: true, commandId: "retry",
    value: { ...value, attemptId: "other" } } }, "destination", "retry", false).state).toBe("unknown");
});
