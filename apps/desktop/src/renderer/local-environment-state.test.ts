import { expect, test } from "bun:test";
import { serializeLocalEnvironment, type CommandEnvelope, type CommandResult, type LocalEnvironmentCatalogItem, type LocalEnvironmentConfig } from "@agent-desktop/shared";
import type { OfflineCache } from "./offline-cache";
import { LocalEnvironmentState } from "./local-environment-state";

const revision = (character: string) => character.repeat(64);
const environment = (name: string, script = "echo setup"): LocalEnvironmentConfig => ({ version: 1, name, setup: { script } });
const item = (path: string, name = "Project", currentRevision = revision("a")): LocalEnvironmentCatalogItem => ({ type: "environment", configPath: path, revision: currentRevision, environment: environment(name) });

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(check: () => boolean, label: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await Bun.sleep(5);
  }
}

function memoryCache() {
  const values = new Map<string, string>();
  let write: ((key: string, value: string) => void | Promise<void>) | undefined;
  const cache: OfflineCache = {
    read: key => Promise.resolve(values.get(key) ?? null),
    async write(key, value) { await write?.(key, value); values.set(key, value); },
  };
  return { cache, values, setWriter(value?: typeof write) { write = value; } };
}

function bridgeFixture() {
  const commands: CommandEnvelope[] = [], queries: Array<{ target: unknown; query: unknown; hostId?: string }> = [], listeners: Array<(event: any) => void> = [];
  let catalog: LocalEnvironmentCatalogItem[] = [];
  let queryImpl: ((target: any, query: any, hostId?: string) => Promise<any>) | undefined;
  let commandImpl: ((envelope: CommandEnvelope, hostId?: string) => Promise<CommandResult>) | undefined;
  const bridge = {
    workspaceQuery(target: any, query: any, hostId?: string) {
      queries.push({ target, query, hostId });
      return queryImpl?.(target, query, hostId) ?? Promise.resolve({ type: "environments.list", environments: catalog });
    },
    command(envelope: CommandEnvelope, hostId?: string) {
      commands.push(envelope);
      return commandImpl?.(envelope, hostId) ?? Promise.reject(new Error("Unexpected command"));
    },
    subscribe(listener: (event: any) => void) { listeners.push(listener); return () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); }; },
  };
  return { bridge: bridge as any, commands, queries, listeners, setCatalog(value: LocalEnvironmentCatalogItem[]) { catalog = value; }, setQuery(value: typeof queryImpl) { queryImpl = value; }, setCommand(value: typeof commandImpl) { commandImpl = value; } };
}

test("catalog and edits restore offline in an unambiguous host/project partition", async () => {
  const storage = memoryCache(), bridge = bridgeFixture(), path = "/owned/project/.agent-desktop/environments/project.toml";
  bridge.setCatalog([item(path)]);
  const online = new LocalEnvironmentState(bridge.bridge, "host:a", "project:b", storage.cache);
  await online.restore(); online.connected = true; await online.refresh(); await online.open(path);
  await until(() => JSON.parse(storage.values.get(online.cacheKey) ?? "null")?.selected === path, "cached catalog and edit");
  const offline = new LocalEnvironmentState(bridgeFixture().bridge, "host:a", "project:b", storage.cache);
  await offline.restore();
  expect(offline).toMatchObject({ connected: false, restored: true, selected: path, items: [{ type: "environment", configPath: path }] });
  expect(offline.editor).toMatchObject({ configPath: path, expectedRevision: revision("a"), dirty: false });
  const other = new LocalEnvironmentState(bridgeFixture().bridge, "host", "a:project:b", storage.cache);
  expect(other.cacheKey).not.toBe(online.cacheKey);
  await other.restore(); expect(other.items).toEqual([]);
});

test("malformed cache is quarantined visibly without bricking a new edit", async () => {
  const storage = memoryCache(), bridge = bridgeFixture();
  const state = new LocalEnvironmentState(bridge.bridge, "host", "project", storage.cache);
  storage.values.set(state.cacheKey, JSON.stringify({ version: 1, items: [], edits: [["new", { configPath: "/wrong", raw: 4 }]] }));
  await state.restore();
  expect(state.restored).toBeTrue(); expect(state.cacheWarning).toContain("recovery needs attention"); expect(state.edits.size).toBe(0);
  state.create();
  expect(state).toMatchObject({ selected: "new", editor: { configPath: null, dirty: true } });
});

test("a late broken-file read cannot steal selection from a newer create action", async () => {
  const storage = memoryCache(), bridge = bridgeFixture(), reading = deferred<any>(), path = "/owned/project/broken.toml";
  bridge.setQuery(async (_target, query) => query.type === "file.read" ? reading.promise : { type: "environments.list", environments: [] });
  const state = new LocalEnvironmentState(bridge.bridge, "owner", "project", storage.cache);
  await state.restore(); state.items = [{ type: "error", configPath: path, revision: revision("b"), error: "invalid TOML" }];
  const opening = state.open(path); state.create();
  reading.resolve({ type: "file.read", path, content: { kind: "text", revision: revision("b"), text: "name='late'" } });
  await opening;
  expect(state.selected).toBe("new"); expect(state.edits.has(path)).toBeFalse();
  expect(bridge.queries[0]).toEqual({ target: { projectId: "project" }, query: { type: "file.read", path }, hostId: "owner" });
});

test("workspace events and definite command errors stay scoped to their exact host and project", async () => {
  const storage = memoryCache(), bridge = bridgeFixture();
  const state = new LocalEnvironmentState(bridge.bridge, "owner", "project", storage.cache, "local");
  await state.restore(); state.connected = true; state.start();
  bridge.listeners[0]?.({ type: "workspace", hostId: "other", target: { projectId: "project" } });
  bridge.listeners[0]?.({ type: "workspace", hostId: "owner", target: { projectId: "other-project" } });
  await Bun.sleep(10); expect(bridge.queries).toHaveLength(0);
  bridge.listeners[0]?.({ type: "workspace", hostId: "owner", target: { projectId: "project" } });
  await until(() => bridge.queries.length === 1, "owned workspace refresh");
  expect(bridge.queries[0]).toMatchObject({ target: { projectId: "project" }, hostId: "owner" });
  state.stop(); bridge.queries.length = 0;

  bridge.setCommand(async envelope => ({ ok: false, commandId: envelope.id, error: { code: "INVALID_COMMAND", message: "Save rejected" } }));
  state.create(); state.edit(environment("Rejected")); await state.save();
  expect(state).toMatchObject({ pending: undefined, error: "Save rejected" });
  expect(bridge.queries).toHaveLength(0);
});

test("unknown save retries its exact command while newer editor text remains unsaved", async () => {
  const storage = memoryCache(), bridge = bridgeFixture(), first = deferred<CommandResult>();
  bridge.setCommand(envelope => bridge.commands.length === 1 ? first.promise : Promise.resolve({ ok: true, commandId: envelope.id, value: { type: "environment.save", result: { type: "saved", configPath: "/owned/saved.toml", revision: revision("c"), environment: environment("Saved") } } }));
  const state = new LocalEnvironmentState(bridge.bridge, "owner", "project", storage.cache);
  await state.restore(); state.connected = true; state.create(); state.edit(environment("Original", "echo original"));
  const saving = state.save(); await until(() => bridge.commands.length === 1, "first save command");
  const originalEnvelope = bridge.commands[0]!;
  state.edit(environment("Newer", "echo newer"));
  first.resolve({ ok: false, commandId: originalEnvelope.id, error: { code: "OUTCOME_UNKNOWN", message: "receipt lost" } });
  await saving;
  expect(JSON.stringify(state.pending?.envelope)).toBe(JSON.stringify(originalEnvelope)); expect(state.error).toContain("original request");
  await until(() => storage.values.get(state.cacheKey)?.includes("Newer") === true, "durable newer edit and pending receipt");
  const restarted = new LocalEnvironmentState(bridge.bridge, "owner", "project", storage.cache);
  await restarted.restore(); restarted.connected = true;
  expect(JSON.stringify(restarted.pending?.envelope)).toBe(JSON.stringify(originalEnvelope));
  await restarted.retry();
  expect(bridge.commands).toHaveLength(2); expect(bridge.commands[1]).toEqual(originalEnvelope);
  expect(restarted).toMatchObject({ pending: undefined, selected: "/owned/saved.toml", notice: "Saved. Newer edits remain unsaved.", editor: { dirty: true, expectedRevision: revision("c") } });
  expect(restarted.config).toMatchObject({ name: "Newer", setup: { script: "echo newer" } });
});

test("a failed completion cache write rolls back identity and retains concurrent edits for exact retry after restart", async () => {
  const storage = memoryCache(), bridge = bridgeFixture(), remote = item("/owned/conflict.toml", "Remote", revision("d"));
  const completionWrite = deferred<void>();
  let response: "conflict" | "saved" = "conflict", blockCompletedWrite = false, completionStarted = false;
  storage.setWriter((_key, raw) => {
    if (blockCompletedWrite && bridge.commands.length >= 2 && !raw.includes('"pending"') && !completionStarted) {
      completionStarted = true;
      return completionWrite.promise;
    }
  });
  bridge.setCommand(async envelope => response === "conflict"
    ? { ok: true, commandId: envelope.id, value: { type: "environment.save", result: { type: "conflict", configPath: "/owned/conflict.toml", expectedRevision: null, current: remote, attempted: { raw: (envelope.command as any).action.raw, environment: environment("Mine") } } } }
    : { ok: true, commandId: envelope.id, value: { type: "environment.save", result: { type: "saved", configPath: "/owned/saved.toml", revision: revision("e"), environment: environment("Mine") } } });
  const state = new LocalEnvironmentState(bridge.bridge, "owner", "project", storage.cache);
  await state.restore(); state.connected = true; state.create(); state.edit(environment("Mine")); await state.save();
  expect(state).toMatchObject({ pending: undefined, error: "The environment changed on its host. Both versions are preserved.", editor: { conflict: { type: "environment", environment: { name: "Remote" } } } });
  expect(state.config?.name).toBe("Mine");
  state.keepEdit(); response = "saved"; blockCompletedWrite = true;
  const saving = state.save();
  await until(() => completionStarted, "blocked completion cache write");
  const retained = bridge.commands.at(-1)!;
  state.edit(environment("Newer after cache failure", "echo newer"));
  completionWrite.reject(new Error("disk full"));
  await saving;
  expect(JSON.stringify(state.pending?.envelope)).toBe(JSON.stringify(retained)); expect(state.error).toContain("original request");
  expect(state).toMatchObject({ selected: "new", editor: { configPath: null, expectedRevision: revision("d"), dirty: true } });
  await until(() => {
    const cached = storage.values.get(state.cacheKey);
    return cached?.includes("Newer after cache failure") === true && cached.includes('"pending"');
  }, "rolled-back receipt and newer edit cache");

  const restarted = new LocalEnvironmentState(bridge.bridge, "owner", "project", storage.cache);
  await restarted.restore(); restarted.connected = true;
  expect(restarted.cacheWarning).toBeUndefined();
  expect(JSON.stringify(restarted.pending?.envelope)).toBe(JSON.stringify(retained));
  expect(restarted).toMatchObject({ selected: "new", editor: { configPath: null, expectedRevision: revision("d"), dirty: true } });
  expect(restarted.config).toMatchObject({ name: "Newer after cache failure", setup: { script: "echo newer" } });
  await restarted.retry();
  expect(bridge.commands.at(-1)).toEqual(retained);
  expect(restarted).toMatchObject({ pending: undefined, selected: "/owned/saved.toml", notice: "Saved. Newer edits remain unsaved.", editor: { dirty: true, expectedRevision: revision("e") } });
  expect(restarted.config).toMatchObject({ name: "Newer after cache failure", setup: { script: "echo newer" } });
});

test("a failed completion cache write restores an existing file revision before restart retry", async () => {
  const storage = memoryCache(), bridge = bridgeFixture(), path = "/owned/existing.toml", completionWrite = deferred<void>();
  let completionStarted = false;
  storage.setWriter((_key, raw) => {
    if (bridge.commands.length === 1 && !raw.includes('"pending"') && !completionStarted) {
      completionStarted = true;
      return completionWrite.promise;
    }
  });
  bridge.setCommand(async envelope => ({ ok: true, commandId: envelope.id, value: { type: "environment.save", result: { type: "saved", configPath: path, revision: revision("b"), environment: environment("First update") } } }));
  const state = new LocalEnvironmentState(bridge.bridge, "owner", "project", storage.cache);
  await state.restore(); state.connected = true; state.items = [item(path, "Before", revision("a"))]; await state.open(path);
  state.edit(environment("First update"));
  const saving = state.save();
  await until(() => completionStarted, "existing-file completion cache write");
  const retained = bridge.commands[0]!;
  state.edit(environment("Second update"));
  completionWrite.reject(new Error("disk full"));
  await saving;
  expect(state.editor).toMatchObject({ configPath: path, expectedRevision: revision("a"), dirty: true });
  await until(() => storage.values.get(state.cacheKey)?.includes("Second update") === true && storage.values.get(state.cacheKey)?.includes('"pending"') === true, "restored existing revision cache");

  const restarted = new LocalEnvironmentState(bridge.bridge, "owner", "project", storage.cache);
  await restarted.restore(); restarted.connected = true;
  expect(JSON.stringify(restarted.pending?.envelope)).toBe(JSON.stringify(retained));
  expect(restarted.editor).toMatchObject({ configPath: path, expectedRevision: revision("a"), dirty: true });
  await restarted.retry();
  expect(bridge.commands.at(-1)).toEqual(retained);
  expect(restarted.editor).toMatchObject({ configPath: path, expectedRevision: revision("b"), dirty: true });
  expect(restarted.config?.name).toBe("Second update");
});
