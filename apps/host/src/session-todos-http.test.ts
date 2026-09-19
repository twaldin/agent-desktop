import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostStore } from "./store";
import { SessionTodosHttp, mutateSessionTodos, projectTodoJournalReceipt, type SessionTodosOwner } from "./session-todos-http";
import { SESSION_TODOS_OWNER_HEADER, parseSessionTodosResponse, type SessionTodos, type TodoMutationRequest, type TodoMutationResult } from "../../../packages/shared/src/session-todos";
import { parseCommandEnvelope } from "./validation";

const state: SessionTodos = { ticket: { nativeSessionId: "session", epoch: "owner", revision: "revision" }, phases: [], markdown: "# Todos\n", nativeCommandAvailable: true, reconciliationRequired: false };
const mutation: TodoMutationRequest = { sessionId: "session", ticket: state.ticket, mutation: { action: "command", text: "/todo append work" } };
const result: TodoMutationResult = { commandId: "edit", state, output: "Added work" };
const request = (query = "", owner = "home", method = "GET") => new Request(`http://localhost/v1/sessions/session/todos${query}`, { method, headers: { [SESSION_TODOS_OWNER_HEADER]: owner } });
const owner = (): SessionTodosOwner => ({ getTodos: async () => state, mutateTodos: async () => result });

test("Todos mutation requires explicit version22 on its own endpoint, not a Plan protocol upgrade", () => {
  const envelope = { id: "edit", commandVersion: 22, command: { type: "session.todos.mutate" as const, ...mutation } };
  expect(parseCommandEnvelope(envelope, 22).command).toEqual(envelope.command);
  expect(() => parseCommandEnvelope(envelope, 20)).toThrow();
  expect(() => parseCommandEnvelope({ ...envelope, commandVersion: 20 }, 22)).toThrow();
  expect(() => parseCommandEnvelope({ ...envelope, commandVersion: undefined }, 22)).toThrow();
  expect(() => parseCommandEnvelope({ ...envelope, command: { type: "session.prompt", sessionId: "session", text: "Hello" } }, 22)).toThrow();
});

test("Todos reads refuse foreign owners and client paths; an unloaded owner is not created", async () => {
  let lookups = 0;
  const service = new SessionTodosHttp({ hostId: "home", sessionExists: () => true, existing: async () => { lookups++; return undefined; }, receipt: (_, commandId) => ({ commandId, state: "absent" }) });
  expect((await service.route(request("", "other")))?.status).toBe(409);
  expect((await service.route(request("", "home", "POST")))?.status).toBe(405);
  expect((await service.route(request("?path=/tmp/TODO.md")))?.status).toBe(400);
  expect((await service.route(request("?commandId=a&commandId=b")))?.status).toBe(400);
  expect(lookups).toBe(0);
  const response = (await service.route(request()))!;
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(parseSessionTodosResponse(await response.json(), "home", "session").todos).toBeNull();
  expect(lookups).toBe(1);
});

test("a replaced worker cannot publish its held Todos read or be adopted by that read", async () => {
  const entered = Promise.withResolvers<void>(), held = Promise.withResolvers<SessionTodos>();
  const original = { ...owner(), getTodos: () => { entered.resolve(); return held.promise; } };
  let current = original as SessionTodosOwner, replacementReads = 0;
  const service = new SessionTodosHttp({ hostId: "home", sessionExists: () => true, existing: async () => current, receipt: (_, commandId) => ({ commandId, state: "absent" }) });
  const pending = service.route(request());
  await entered.promise;
  current = { ...owner(), getTodos: async () => { replacementReads++; return state; } };
  held.resolve(state);
  expect(parseSessionTodosResponse(await (await pending)!.json(), "home", "session").todos).toBeNull();
  expect(replacementReads).toBe(0);
});

test("pre-dispatch owner replacement is rejected; post-dispatch replacement is unknown without replay", async () => {
  let mutations = 0;
  const entered = Promise.withResolvers<void>(), held = Promise.withResolvers<TodoMutationResult>();
  const original = { ...owner(), mutateTodos: () => { mutations++; entered.resolve(); return held.promise; } };
  const replacement = { ...owner(), mutateTodos: async () => { mutations += 100; return result; } };
  let current = original as SessionTodosOwner, reads = 0;
  const replacedBefore = { sessionExists: () => true, existing: async () => ++reads === 1 ? original : replacement };
  await expect(mutateSessionTodos(replacedBefore, "edit", mutation)).rejects.toMatchObject({ code: "TODOS_REJECTED" });
  expect(mutations).toBe(0);
  const pending = mutateSessionTodos({ sessionExists: () => true, existing: async () => current }, "edit", mutation);
  await entered.promise; current = replacement; held.resolve(result);
  await expect(pending).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  expect(mutations).toBe(1);
});

test("worker transport loss stays unknown while explicit native refusal remains rejected", async () => {
  const original = owner();
  original.mutateTodos = async () => { throw new Error("worker disconnected after send"); };
  const owners = { sessionExists: () => true, existing: async () => original };
  await expect(mutateSessionTodos(owners, "edit", mutation)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  original.mutateTodos = async () => { throw Object.assign(new Error("stale revision"), { code: "TODOS_REJECTED" }); };
  await expect(mutateSessionTodos(owners, "edit", mutation)).rejects.toMatchObject({ code: "TODOS_REJECTED" });
});

test("durable receipt survives lost response and restart; orphaned pending is never retried", async () => {
  const directory = await mkdtemp(join(tmpdir(), "todos-journal-"));
  let store = new HostStore(directory);
  try {
    const command = { type: "session.todos.mutate" as const, ...mutation };
    store.claimCommand("edit", "hash", command);
    store.claimCommand("unacknowledged", "other", command);
    store.finishCommand("edit", "hash", { ok: true, commandId: "edit", value: { type: "session.todos.mutate", result } });
    store.close(); store = new HostStore(directory);
    expect(store.claimCommand("edit", "hash", command).kind).toBe("done");
    expect(store.claimCommand("unacknowledged", "other", command).kind).toBe("pending");
    const service = new SessionTodosHttp({ hostId: "home", sessionExists: () => true, existing: async () => undefined,
      receipt: (sessionId, commandId) => projectTodoJournalReceipt(store.getCommand(commandId), sessionId, commandId, false) });
    const inspected = parseSessionTodosResponse(await (await service.route(request("?commandId=edit")))!.json(), "home", "session", "edit");
    expect(inspected.todos).toBeNull(); expect(inspected.receipt).toEqual({ commandId: "edit", state: "succeeded", result });
    expect(projectTodoJournalReceipt(store.getCommand("unacknowledged"), "session", "unacknowledged", false).state).toBe("unknown");
    expect(projectTodoJournalReceipt(store.getCommand("edit"), "other-session", "edit", false).state).toBe("absent");
    expect(store.claimCommand("edit", "different-content", command).kind).toBe("conflict");
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("receipt classification never turns a generic error or foreign success into definite failure or success", () => {
  const base = { id: "edit", requestHash: "hash", command: { type: "session.todos.mutate" as const, ...mutation }, state: "done" as const, createdAt: 1, updatedAt: 2 };
  const failed = (code: string) => projectTodoJournalReceipt({ ...base, result: { ok: false, commandId: "edit", error: { code, message: "failure" } } }, "session", "edit", false);
  expect(failed("TODOS_REJECTED").state).toBe("failed");
  expect(failed("COMMAND_FAILED").state).toBe("unknown");
  expect(failed("OUTCOME_UNKNOWN").state).toBe("unknown");
  expect(projectTodoJournalReceipt({ ...base, result: { ok: true, commandId: "edit", value: { type: "session.todos.mutate", result: { ...result, state: { ...state, ticket: { ...state.ticket, epoch: "replacement" } } } } } }, "session", "edit", false).state).toBe("unknown");
});
