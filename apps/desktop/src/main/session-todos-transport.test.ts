import { expect, test } from "bun:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { SESSION_TODOS_OWNER_HEADER, type SessionTodos, type SessionTodosResponse } from "../../../../packages/shared/src/session-todos";
import { registerSessionTodosReadHandler, requestSessionTodos } from "./session-todos-transport";
import { commandEndpoint, requestVersionedCommand } from "./command-endpoints";
import { HostRequestError } from "./host-transport";

const endpoint = { origin: "https://owner.invalid", hostId: "owner", token: "inert-token" };
const todos = (revision = "a".repeat(64)): SessionTodos => ({
  ticket: { nativeSessionId: "session/name", epoch: "worker", revision },
  phases: [{ name: "Setup", tasks: [{ content: "Install deps", status: "in_progress" }, { content: "Wire CI", status: "blocked", blocker: "Waiting for credentials" }] }],
  markdown: "## Setup\n- [~] Install deps\n- [!] Wire CI\n", nativeCommandAvailable: true, reconciliationRequired: false,
});
const response = (sessionId = "session/name"): SessionTodosResponse => ({ hostId: "owner", sessionId, todos: todos() });
const owned = (value: unknown, hostId = "owner") => Response.json(value, { headers: { [SESSION_TODOS_OWNER_HEADER]: hostId } });

test("Todos read captures its endpoint, sends the owner header, and binds the shared response owner", async () => {
  const previous = globalThis.fetch; const mutable = { ...endpoint }; const calls: unknown[] = [];
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ url, init }); mutable.origin = "https://changed.invalid"; mutable.hostId = "changed"; mutable.token = "changed";
    return owned(response());
  }) as unknown as typeof fetch;
  try {
    expect(await requestSessionTodos(mutable, "session/name")).toEqual(response());
    expect(calls).toEqual([{ url: "https://owner.invalid/v1/sessions/session%2Fname/todos", init: expect.objectContaining({
      redirect: "error", headers: { [SESSION_TODOS_OWNER_HEADER]: "owner", Authorization: "Bearer inert-token" },
    }) }]);
  } finally { globalThis.fetch = previous; }
});

test("Todos read requests and parses only the exact original durable command receipt", async () => {
  const previous = globalThis.fetch;
  const result = { commandId: "todo-1", state: todos("b".repeat(64)), output: "Started: Install deps" };
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
    expect(url).toBe("https://owner.invalid/v1/sessions/session%2Fname/todos?commandId=todo-1");
    return owned({ ...response(), receipt: { commandId: "todo-1", state: "succeeded", result } });
  }) as unknown as typeof fetch;
  try {
    expect((await requestSessionTodos(endpoint, "session/name", "todo-1")).receipt).toEqual({ commandId: "todo-1", state: "succeeded", result });
    await expect(requestSessionTodos(endpoint, "session/name", "not/a-command")).rejects.toThrow("identity");
    globalThis.fetch = (async () => owned({ ...response(), receipt: { commandId: "todo-2", state: "unknown" } })) as unknown as typeof fetch;
    await expect(requestSessionTodos(endpoint, "session/name", "todo-1")).rejects.toThrow("receipt identity");
  } finally { globalThis.fetch = previous; }
});

test("owner mismatch, malformed JSON, bodies over 16 MiB, foreign native owners and changed response owners are rejected", async () => {
  const previous = globalThis.fetch;
  try {
    const cases = [
      owned(response(), "other"),
      new Response("{", { headers: { [SESSION_TODOS_OWNER_HEADER]: "owner" } }),
      new Response(new Uint8Array(16 * 1024 * 1024 + 1), { headers: { [SESSION_TODOS_OWNER_HEADER]: "owner" } }),
      owned({ ...response(), sessionId: "other" }),
      owned({ ...response(), todos: { ...todos(), ticket: { ...todos().ticket, nativeSessionId: "other" } } }),
      owned({ ...response(), todos: { ...todos(), phases: [{ name: "Setup", tasks: [{ content: "x", status: "started" }] }] } }),
    ];
    for (const value of cases) {
      globalThis.fetch = (async () => value) as unknown as typeof fetch;
      await expect(requestSessionTodos(endpoint, "session/name")).rejects.toThrow();
    }
  } finally { globalThis.fetch = previous; }
});

test("host refusals preserve bounded codes and sanitize untrusted error text", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ error: { code: "STALE_TARGET", message: "The original session retired." } },
      { status: 409, headers: { [SESSION_TODOS_OWNER_HEADER]: "owner" } })) as unknown as typeof fetch;
    await expect(requestSessionTodos(endpoint, "session/name")).rejects.toMatchObject({ status: 409, code: "STALE_TARGET", message: "The original session retired." });
    globalThis.fetch = (async () => Response.json({ error: { code: "private-value", message: "line one\nprivate detail" } },
      { status: 500, headers: { [SESSION_TODOS_OWNER_HEADER]: "owner" } })) as unknown as typeof fetch;
    await expect(requestSessionTodos(endpoint, "session/name")).rejects.toMatchObject({ status: 500, code: undefined, message: "Native Todos read failed (500)." });
  } finally { globalThis.fetch = previous; }
});

test("registered IPC rechecks renderer trust and the exact endpoint after each asynchronous boundary", async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>();
  const ipc: Pick<IpcMain, "handle"> = { handle(channel, listener) { handlers.set(channel, listener); } };
  let trusted = true; const mutable = { origin: "https://owner.invalid", hostId: "owner", token: "inert-token" };
  registerSessionTodosReadHandler(ipc, () => { if (!trusted) throw new Error("Untrusted sender"); }, async () => mutable);
  const invoke = (commandId?: string) => handlers.get("host:session-todos-read")!({} as IpcMainInvokeEvent, "session/name", "owner", commandId);
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = (async () => { trusted = false; return owned(response()); }) as unknown as typeof fetch;
    await expect(invoke()).rejects.toThrow("Untrusted sender");
    trusted = true;
    globalThis.fetch = (async () => { mutable.token = "replacement"; return owned(response()); }) as unknown as typeof fetch;
    await expect(invoke()).rejects.toThrow("endpoint changed");
    mutable.token = "inert-token";
    globalThis.fetch = (async () => owned({ ...response(), receipt: { commandId: "todo-1", state: "absent" } })) as unknown as typeof fetch;
    expect((await invoke("todo-1") as SessionTodosResponse).receipt).toEqual({ commandId: "todo-1", state: "absent" });
    mutable.hostId = "replaced";
    await expect(invoke()).rejects.toThrow("host changed");
  } finally { globalThis.fetch = previous; }
});

test("invalid renderer identities fail before endpoint lookup or fetch", async () => {
  let lookups = 0, fetches = 0;
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>();
  const ipc: Pick<IpcMain, "handle"> = { handle(channel, listener) { handlers.set(channel, listener); } };
  registerSessionTodosReadHandler(ipc, () => {}, async () => { lookups++; return endpoint; });
  const previous = globalThis.fetch; globalThis.fetch = (async () => { fetches++; return owned(response()); }) as unknown as typeof fetch;
  try {
    for (const [sessionId, hostId, commandId] of [["", "owner"], ["session", ""], ["session\n", "owner"], ["session", "owner\0"], ["session", "owner", "bad id"]])
      await expect(handlers.get("host:session-todos-read")!({} as IpcMainInvokeEvent, sessionId, hostId, commandId)).rejects.toThrow();
    expect({ lookups, fetches }).toEqual({ lookups: 0, fetches: 0 });
  } finally { globalThis.fetch = previous; }
});

test("Todos commands select the typed v22 endpoint and only an uncoded 404 becomes unsupported", async () => {
  const envelope = { id: "todo-1", commandVersion: 22 as const, command: { type: "session.todos.mutate" as const,
    sessionId: "session", ticket: { epoch: "worker", nativeSessionId: "session", revision: "a".repeat(64) }, mutation: { action: "command" as const, text: "/todo done Install deps" } } };
  expect(commandEndpoint(envelope)).toBe("/v22/commands");
  expect(commandEndpoint({ ...envelope, commandVersion: 19 })).toBe("/v22/commands");
  expect(await requestVersionedCommand(async path => { expect(path).toBe("/v22/commands"); throw new HostRequestError("Missing", 404); }, envelope))
    .toEqual({ ok: false, commandId: "todo-1", error: { code: "TODOS_PROTOCOL_UNSUPPORTED", message: "Update the owning host to read or change native Todos. This request was not accepted." } });
  const coded = new HostRequestError("Todos refused", 404, "TODOS_REJECTED");
  await expect(requestVersionedCommand(async () => { throw coded; }, envelope)).rejects.toBe(coded);
});
