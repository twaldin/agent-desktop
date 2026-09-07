import { expect, test } from "bun:test";
import type {
  CommandEnvelope,
  CommandResult,
  DesktopBridge,
  NativeMcpAuthorizationResponse,
  NativeMcpAuthorizationSnapshot,
  NativeSessionMcpSnapshot,
} from "@agent-desktop/shared";
import { McpAuthorizationState } from "./mcp-authorization-state";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  values = new Map<string, string>();
  failSet = false;
  failRemove = false;
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.failSet) throw new Error("disk full"); this.values.set(key, value); }
  removeItem(key: string) { if (this.failRemove) throw new Error("disk full"); this.values.delete(key); }
}

const catalog = (): NativeSessionMcpSnapshot => ({
  epoch: "epoch-1", revision: 3, available: true, canReconnect: true, servers: [{
    name: "fixture", status: "disconnected", source: "fixture", canAuthorize: true,
    tools: [], resourceCount: null, promptCount: null,
  }],
});
const authorization = (authorizationId = "authorization-1", commandId?: string): NativeMcpAuthorizationSnapshot => ({
  authorizationId, ...(commandId ? { commandId } : {}), serverName: "fixture", status: "running", phase: "authorizing",
  credentialsStored: false, credentialWrite: "not-started", configuration: "untouched", reconnected: false,
  login: {
    loginId: authorizationId, providerId: "mcp:fixture", status: "running", startedAt: 1, updatedAt: 2,
    cancellationRequested: false, auth: { url: "https://issuer.invalid/authorize?state=opaque", callbackOnOwningHost: true },
    prompts: [{ requestId: "request-1", kind: "manual-code", message: "Paste callback", allowEmpty: false, sensitive: true }],
  },
});
const response = (value: NativeMcpAuthorizationSnapshot | null, receipt?: NativeMcpAuthorizationResponse["receipt"]): NativeMcpAuthorizationResponse => ({
  protocolVersion: 1, hostId: "host", sessionId: "session", value, ...(receipt ? { receipt } : {}),
});

function fixture(options: {
  storage?: MemoryStorage;
  command?: (envelope: CommandEnvelope) => Promise<CommandResult>;
  read?: (commandId?: string) => Promise<NativeMcpAuthorizationResponse>;
  respond?: DesktopBridge["respondSessionMcpAuthorization"];
  cancel?: DesktopBridge["cancelSessionMcpAuthorization"];
} = {}) {
  const storage = options.storage ?? new MemoryStorage();
  const commands: CommandEnvelope[] = [];
  const bridge = {
    command: async (envelope: CommandEnvelope) => {
      commands.push(envelope);
      return options.command?.(envelope) ?? { ok: true, commandId: envelope.id, value: { type: "session.mcp.authorization", authorizationId: "authorization-1" } };
    },
    getSessionMcpAuthorization: async (_sessionId: string, _hostId: string, commandId?: string) => options.read?.(commandId) ?? response(null),
    respondSessionMcpAuthorization: options.respond ?? (async () => response(authorization())),
    cancelSessionMcpAuthorization: options.cancel ?? (async () => response({ ...authorization(), status: "cancelling" })),
  } as unknown as DesktopBridge;
  return { storage, commands, bridge, state: new McpAuthorizationState(bridge, "host", "session", storage) };
}

async function settled(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await Bun.sleep(1);
  expect(predicate()).toBe(true);
}

test("duplicate start is blocked while the exact durable command remains pending", async () => {
  const deferred = Promise.withResolvers<CommandResult>();
  const value = fixture({ command: () => deferred.promise, read: async () => response(null, { commandId: "unrelated", state: "absent" }) });
  value.state.loading = false;
  const first = value.state.start(catalog(), "fixture");
  await settled(() => value.commands.length === 1);
  await value.state.start(catalog(), "fixture");
  expect(value.commands).toHaveLength(1);
  expect(value.state.pending).toBe(value.commands[0]!.id);
  deferred.resolve({ ok: false, commandId: value.commands[0]!.id, error: { code: "OUTCOME_UNKNOWN", message: "inspect" } });
  await first;
});

test("a lost start reply recovers only through its read-only receipt without generating another command", async () => {
  let startedId = "";
  const value = fixture({
    command: async envelope => { startedId = envelope.id; throw new Error("lost acknowledgement"); },
    read: async commandId => response(authorization("authorization-1", commandId), { commandId: commandId!, state: "succeeded", authorizationId: "authorization-1" }),
  });
  value.state.loading = false;
  await value.state.start(catalog(), "fixture");
  await settled(() => value.state.pending === null && value.state.value?.commandId === startedId);
  expect(value.commands).toHaveLength(1);
  expect(value.storage.values.has("mcp.authorization.host.session")).toBe(false);
});

test("private callback input is never cached and an uncertain response is not resent after reconstruction", async () => {
  const storage = new MemoryStorage();
  const replies: unknown[] = [];
  const bridgeOptions = {
    storage,
    read: async () => response(authorization()),
    respond: async (_sessionId: string, reply: unknown) => { replies.push(reply); throw new Error("connection lost after dispatch"); },
  };
  const first = fixture(bridgeOptions);
  await first.state.read();
  const privateValue = "http://127.0.0.1/callback?code=private-code&state=private-state";
  await first.state.respond({ authorizationId: "authorization-1", requestId: "request-1", response: { value: privateValue } });
  await settled(() => !first.state.writing);
  expect(replies).toHaveLength(1);
  expect(JSON.stringify([...storage.values])).not.toContain(privateValue);
  expect(storage.values.get("mcp.authorization.host.session.response")).toBe(JSON.stringify({ authorizationId: "authorization-1", requestId: "request-1" }));

  const restored = fixture(bridgeOptions);
  await restored.state.read();
  await restored.state.respond({ authorizationId: "authorization-1", requestId: "request-1", response: { value: privateValue } });
  expect(replies).toHaveLength(1);
});

test("storage failure prevents start and callback dispatch", async () => {
  const storage = new MemoryStorage();
  storage.failSet = true;
  let replies = 0;
  const value = fixture({ storage, respond: async () => { replies++; return response(authorization()); } });
  value.state.loading = false;
  await value.state.start(catalog(), "fixture");
  expect(value.commands).toHaveLength(0);
  expect(value.state.error).toContain("Nothing was sent");
  value.state.value = authorization();
  await value.state.respond({ authorizationId: "authorization-1", requestId: "request-1", response: { value: "private" } });
  expect(replies).toBe(0);
});

test("dispose ignores late reads and command replies from the abandoned navigation owner", async () => {
  const read = Promise.withResolvers<NativeMcpAuthorizationResponse>();
  const command = Promise.withResolvers<CommandResult>();
  const value = fixture({ read: () => read.promise, command: () => command.promise });
  const pendingRead = value.state.read();
  value.state.dispose();
  read.resolve(response(authorization("late-read")));
  await pendingRead;
  expect(value.state.value).toBeNull();

  const other = fixture({ command: () => command.promise });
  other.state.loading = false;
  const pendingStart = other.state.start(catalog(), "fixture");
  await settled(() => other.commands.length === 1);
  other.state.dispose();
  command.resolve({ ok: true, commandId: other.commands[0]!.id, value: { type: "session.mcp.authorization", authorizationId: "late-command" } });
  await pendingStart;
  expect(other.state.value).toBeNull();
});

test("a stale read cannot replace the authorization started after that read began", async () => {
  const oldRead = Promise.withResolvers<NativeMcpAuthorizationResponse>();
  let reads = 0;
  const value = fixture({
    read: async () => ++reads === 1 ? oldRead.promise : response(authorization("new-authorization")),
  });
  value.state.loading = false;
  const pendingRead = value.state.read();
  await value.state.start(catalog(), "fixture");
  await settled(() => value.state.value?.authorizationId === "new-authorization");
  oldRead.resolve(response(authorization("old-authorization")));
  await pendingRead;
  expect(value.state.value?.authorizationId).toBe("new-authorization");
});

test("StrictMode dispose and activate lets the new lifecycle read while the abandoned read stays stale", async () => {
  const first = Promise.withResolvers<NativeMcpAuthorizationResponse>();
  const second = Promise.withResolvers<NativeMcpAuthorizationResponse>();
  let reads = 0;
  const value = fixture({ read: () => ++reads === 1 ? first.promise : second.promise });
  const abandoned = value.state.read();
  value.state.dispose();
  value.state.activate();
  const current = value.state.read();
  second.resolve(response(authorization("current-lifecycle")));
  await current;
  first.resolve(response(authorization("abandoned-lifecycle")));
  await abandoned;
  expect(reads).toBe(2);
  expect(value.state.value?.authorizationId).toBe("current-lifecycle");
});

test("a response write settling after dispose and activate cannot publish an obsolete error or refresh", async () => {
  const send = Promise.withResolvers<NativeMcpAuthorizationResponse>();
  let reads = 0;
  const value = fixture({
    read: async () => { reads++; return response(authorization()); },
    respond: () => send.promise,
  });
  await value.state.read();
  const writing = value.state.respond({ authorizationId: "authorization-1", requestId: "request-1", response: { value: "private" } });
  await settled(() => value.state.writing);
  value.state.dispose();
  value.state.activate();
  value.state.error = "current lifecycle";
  send.reject(new Error("obsolete connection failure"));
  await writing;
  expect(value.state.error).toBe("current lifecycle");
  expect(reads).toBe(1);
});

test("a second native prompt cannot overwrite an unconfirmed response identity", async () => {
  const snapshot = authorization();
  snapshot.login.prompts.push({...snapshot.login.prompts[0]!, requestId:'request-2'});
  let calls = 0;
  const value = fixture({read:async()=>response(snapshot),respond:async()=>{calls++;throw new Error('lost acknowledgement');}});
  await value.state.read();
  await value.state.respond({authorizationId:snapshot.authorizationId,requestId:'request-1',response:{value:'first-secret'}});
  await value.state.respond({authorizationId:snapshot.authorizationId,requestId:'request-2',response:{value:'second-secret'}});
  expect(calls).toBe(1);
  expect(value.state.sent?.requestId).toBe('request-1');
  expect(JSON.stringify([...value.storage.values])).not.toContain('secret');
});

test("a damaged local receipt remains visible and blocks answers after a successful read", async () => {
  const storage = new MemoryStorage();
  storage.values.set('mcp.authorization.host.session.response','{bad');
  const value = fixture({storage,read:async()=>response(authorization())});
  await value.state.read();
  expect(value.state.responseBlocked).toBe(true);
  expect(value.state.error).toContain('cannot be read');
});
