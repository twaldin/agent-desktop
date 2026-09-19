import { expect, test } from "bun:test";
import { MAX_TODO_BYTES, parseTodoPhases, parseTodoMutationRequest, parseSessionTodosResponse, type SessionTodos } from "./session-todos";

const state: SessionTodos = { ticket: { nativeSessionId: "session", epoch: "worker", revision: "r" }, phases: [], markdown: "# Todos\n", nativeCommandAvailable: true, reconciliationRequired: false };
const request = { sessionId: "session", ticket: state.ticket, mutation: { action: "edit" as const, markdown: "# Phase\n- [!] Blocked <!-- blocker: Waiting -->\n" } };

test("native phases preserve order, all five states and blocker without normalization", () => {
  const tasks = (["pending", "in_progress", "completed", "abandoned", "blocked"] as const).map((status, index) => ({ content: `Task ${index}`, status, ...(status === "blocked" ? { blocker: "Waiting for approval" } : {}) }));
  const phases = [{ name: "Phase", tasks }, { name: "Empty", tasks: [] }];
  expect(parseTodoPhases(phases)).toEqual(phases);
  expect(parseTodoPhases([])).toEqual([]);
});

test("malformed or oversized native state refuses the entire projection", () => {
  expect(() => parseTodoPhases([{ name: "Phase", tasks: [{ content: "Task", status: "invented" }] }])).toThrow();
  expect(() => parseTodoPhases([{ name: "Phase", tasks: [{ content: "Task", status: "blocked", blocker: 7 }] }])).toThrow();
  expect(() => parseTodoPhases([{ name: "Phase", tasks: [{ content: "😀".repeat(MAX_TODO_BYTES / 4), status: "pending" }] }])).toThrow();
  expect(() => parseTodoPhases([{ name: "Phase", tasks: Array.from({ length: 10001 }, () => ({ content: "Task", status: "pending" })) }])).toThrow();
});

test("mutation parser keeps exact Markdown but rejects mixed actions, non-Todo commands and byte overflow", () => {
  expect(parseTodoMutationRequest(request).mutation).toEqual(request.mutation);
  expect(() => parseTodoMutationRequest({ ...request, mutation: { action: "command", text: "/todo rm", markdown: "" } })).toThrow();
  expect(() => parseTodoMutationRequest({ ...request, sessionId: "other" })).toThrow();
  expect(() => parseTodoMutationRequest({ ...request, mutation: { action: "command", text: "/todo-other rm" } })).toThrow();
  expect(() => parseTodoMutationRequest({ ...request, mutation: { action: "edit", markdown: "😀".repeat(MAX_TODO_BYTES / 4 + 1) } })).toThrow();
});

test("response and receipt must belong to the exact host, session and requested command", () => {
  const response = { hostId: "home", sessionId: "session", todos: state };
  expect(parseSessionTodosResponse(response, "home", "session").todos?.markdown).toBe("# Todos\n");
  expect(() => parseSessionTodosResponse(response, "work", "session")).toThrow();
  expect(() => parseSessionTodosResponse({ ...response, todos: { ...state, ticket: { ...state.ticket, nativeSessionId: "other" } } }, "home", "session")).toThrow();
  expect(() => parseSessionTodosResponse({ ...response, receipt: { commandId: "other", state: "pending" } }, "home", "session", "edit")).toThrow();
  expect(() => parseSessionTodosResponse({ ...response, receipt: { commandId: "edit", state: "succeeded" } }, "home", "session", "edit")).toThrow();
  expect(() => parseSessionTodosResponse({ ...response, receipt: { commandId: "edit", state: "succeeded", result: {
    commandId: "edit", output: "", state: { ...state, ticket: { ...state.ticket, nativeSessionId: "other" } },
  } } }, "home", "session", "edit")).toThrow();
});
