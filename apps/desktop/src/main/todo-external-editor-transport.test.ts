import { afterEach, expect, test } from "bun:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { TodoExternalEditorObservation, TodoExternalEditorRequest } from "../../../../packages/shared/src/todo-external-editor";
import { SESSION_TODOS_OWNER_HEADER } from "../../../../packages/shared/src/session-todos";
import { registerTodoExternalEditorHandlers } from "./todo-external-editor-transport";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const input: TodoExternalEditorRequest = { requestId: "10000000-0000-4000-8000-000000000001",
  controlEpoch: "20000000-0000-4000-8000-000000000002", sessionId: "session/name",
  ticket: { epoch: "worker", nativeSessionId: "session/name", revision: "a".repeat(64) } };
const pending = (): TodoExternalEditorObservation => ({ protocolVersion: 1, hostId: "owner", request: input, state: "pending",
  terminalId: "30000000-0000-4000-8000-000000000003" });
const unknown = (): TodoExternalEditorObservation => ({ ...pending(), state: "settled", result: { outcome: "unknown" } });
function fixture(endpoint = { origin: "https://owner.invalid", hostId: "owner", token: "inert-token" }) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>();
  const ipc: Pick<IpcMain, "handle"> = { handle(channel, listener) { handlers.set(channel, listener); } };
  let trusted = true, checks = 0, lookups = 0;
  registerTodoExternalEditorHandlers(ipc, () => { checks++; if (!trusted) throw new Error("Untrusted sender"); }, async () => { lookups++; return endpoint; });
  return { handlers, endpoint, counts: () => ({ checks, lookups }), trust(value: boolean) { trusted = value; } };
}
const owned = (value: unknown) => Response.json(value, { headers: { [SESSION_TODOS_OWNER_HEADER]: "owner" } });

test("six handlers parse first and use one captured owner endpoint through the returned receipt", async () => {
  const f = fixture(), calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("capabilities")) return owned({ protocolVersion: 1, hostId: "owner", controlEpoch: input.controlEpoch, available: true });
    if (String(url).includes("/list")) return owned({ protocolVersion: 1, hostId: "owner", sessionId: input.sessionId, items: [] });
    if (String(url).endsWith("recovery")) return owned({ observation: unknown(), content: "retained", source: "completed-output" });
    return owned(pending());
  }) as unknown as typeof fetch;
  const event = {} as IpcMainInvokeEvent;
  expect(await f.handlers.get("host:todo-editor-capabilities")!(event, input.sessionId, "owner")).toMatchObject({ available: true });
  expect(await f.handlers.get("host:todo-editor-list")!(event, input.sessionId, "owner", input.requestId)).toMatchObject({ items: [] });
  for (const action of ["start", "status", "cancel"]) expect(await f.handlers.get(`host:todo-editor-${action}`)!(event, input, "owner")).toEqual(pending());
  expect(await f.handlers.get("host:todo-editor-recovery")!(event, input, "owner")).toEqual({ observation: unknown(), content: "retained", source: "completed-output" });
  expect(f.counts()).toEqual({ checks: 18, lookups: 6 });
  expect(calls.every(call => call.url.startsWith("https://owner.invalid/v1/sessions/session%2Fname/todos/editor/"))).toBe(true);
  expect(calls.every(call => (call.init?.headers as Record<string, string>)[SESSION_TODOS_OWNER_HEADER] === "owner")).toBe(true);
});

test("invalid renderer values are rejected before endpoint lookup or fetch", async () => {
  const f = fixture(); let fetches = 0;
  globalThis.fetch = (async () => { fetches++; return owned(pending()); }) as unknown as typeof fetch;
  const event = {} as IpcMainInvokeEvent;
  await expect(f.handlers.get("host:todo-editor-start")!(event, { ...input, command: "code" }, "owner")).rejects.toThrow("keys");
  await expect(f.handlers.get("host:todo-editor-capabilities")!(event, "bad\nconversation", "owner")).rejects.toThrow("conversation");
  await expect(f.handlers.get("host:todo-editor-list")!(event, input.sessionId, "owner", "bad-cursor")).rejects.toThrow("identity");
  await expect(f.handlers.get("host:todo-editor-status")!(event, input, "bad\0host")).rejects.toThrow("host");
  expect({ ...f.counts(), fetches }).toEqual({ checks: 4, lookups: 0, fetches: 0 });
});

test("trust and live endpoint identity are checked after lookup and after a held response without relookup", async () => {
  const event = {} as IpcMainInvokeEvent;
  {
    const f = fixture(); let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    globalThis.fetch = (async () => { await held; return owned(pending()); }) as unknown as typeof fetch;
    const operation = f.handlers.get("host:todo-editor-status")!(event, input, "owner");
    while (f.counts().lookups !== 1) await Bun.sleep(0);
    f.trust(false); release();
    await expect(operation).rejects.toThrow("Untrusted sender");
    expect(f.counts().lookups).toBe(1);
  }
  {
    const endpoint = { origin: "https://owner.invalid", hostId: "owner", token: "inert-token" }, f = fixture(endpoint);
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(String(url)).toStartWith("https://owner.invalid/");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer inert-token");
      endpoint.token = "replacement"; return owned(pending());
    }) as unknown as typeof fetch;
    await expect(f.handlers.get("host:todo-editor-start")!(event, input, "owner")).rejects.toThrow("endpoint changed");
    expect(f.counts()).toEqual({ checks: 3, lookups: 1 });
  }
});
