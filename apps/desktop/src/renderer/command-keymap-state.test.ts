import { expect, test } from "bun:test";
import type { CommandEnvelope, CommandResult } from "../../../../packages/shared/src/protocol";
import type { PreferencesSnapshotV2 } from "../../../../packages/shared/src/preferences-v2";
import { CommandKeymapState } from "./command-keymap-state";

function memory() { const values = new Map<string, string>(); return { values, read: (key: string) => values.get(key) ?? null, write: (key: string, value: string) => values.set(key, value) }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(ownerKey = "window-a") {
  const cached = memory(), cache = { values: cached.values, read: async (key: string) => cached.read(key), write: async (key: string, value: string) => { cached.write(key, value); } }, receipts = memory(); let snapshot: PreferencesSnapshotV2 = { version: 2, records: [] };
  const calls: CommandEnvelope[] = []; let next: (envelope: CommandEnvelope) => Promise<CommandResult> = async envelope => ({ ok: false, commandId: envelope.id, error: { code: "OUTCOME_UNKNOWN", message: "lost" } });
  const bridge = { getPreferencesV2: async () => structuredClone(snapshot), command: async (envelope: CommandEnvelope) => { calls.push(envelope); return next(envelope); } };
  const state = new CommandKeymapState(ownerKey, bridge, cache, receipts); state.setConnection("host", true, { commandVersion: 11, snapshotVersion: 2 });
  return { bridge, cache, receipts, calls, state, setSnapshot: (value: PreferencesSnapshotV2) => { snapshot = value; }, setNext: (value: typeof next) => { next = value; } };
}

test("number edits require capability, retain original receipts and recover committed layout", async () => {
  const f = fixture();
  await f.state.submit({ type: "number-target", target: "sidebar" });
  expect(f.calls).toHaveLength(0); expect(f.state.error).toContain("Update");
  f.state.setConnection("host", true, { commandVersion: 11, snapshotVersion: 2, numberTargetVersion: 1 });
  f.setNext(async () => { throw new Error("reply lost"); });
  await f.state.submit({ type: "number-target", target: "sidebar" });
  expect(f.calls).toHaveLength(1); const original = f.calls[0]!;
  expect(f.state.primaryNumberShortcutTarget).toBe("tabs");
  const restored = new CommandKeymapState("window-a", f.bridge, f.cache, f.receipts);
  expect(restored.pending?.id).toBe(original.id);
  restored.setConnection("host", true, { commandVersion: 11, snapshotVersion: 2 });
  await restored.retry(); expect(f.calls).toHaveLength(1);
  restored.setConnection("host", true, { commandVersion: 11, snapshotVersion: 2, numberTargetVersion: 1 });
  const record = { key: "general.commandKeymap" as const, deleted: false as const, value: { version: 2 as const, platform: "mac" as const, primaryNumberShortcutTarget: "sidebar" as const, overrides: [{ command: "thread1", keys: [] }] }, revision: { counter: 1, actor: crypto.randomUUID(), opId: crypto.randomUUID() } };
  f.setNext(async envelope => ({ ok: true, commandId: envelope.id, value: { type: "preferences.keymap.mutate", preference: record } } as CommandResult));
  await restored.retry();
  expect(f.calls[1]!.id).toBe(original.id); expect(restored.pending).toBeUndefined();
  expect(restored.primaryNumberShortcutTarget).toBe("sidebar");
  const reopened = new CommandKeymapState("window-a", f.bridge, f.cache, f.receipts);
  reopened.setConnection("host", false, undefined); await reopened.restore();
  expect(reopened.primaryNumberShortcutTarget).toBe("sidebar");
  expect(reopened.record).toEqual(record); expect(f.calls).toHaveLength(2);
});

test("stale number target requires explicit rebase onto the complete newest binding revision", async () => {
  const f = fixture(); f.state.setConnection("host", true, { commandVersion: 11, snapshotVersion: 2, numberTargetVersion: 1 });
  f.setNext(async envelope => ({ ok: false, commandId: envelope.id, error: { code: "STALE_KEYBINDINGS", message: "changed" } }));
  await f.state.submit({ type: "number-target", target: "sidebar" });
  expect(f.state.staleEdit).toEqual({ type: "number-target", target: "sidebar" });
  const revision = { counter: 8, actor: crypto.randomUUID(), opId: crypto.randomUUID() };
  f.setSnapshot({ version: 2, records: [{ key: "general.commandKeymap", deleted: false, value: { version: 1, platform: "mac", overrides: [{ command: "thread1", keys: [] }] }, revision }] });
  await f.state.refresh(); expect(f.calls).toHaveLength(1);
  await f.state.rebase();
  expect(f.calls).toHaveLength(2); expect(f.calls[1]!.id).not.toBe(f.calls[0]!.id);
  expect((f.calls[1] as any).command.mutation).toEqual({ expectedRevision: revision, edit: { type: "number-target", target: "sidebar" } });
});

test("writes receipt before dispatch and retains an ambiguous original envelope for explicit retry", async () => {
  const f = fixture(); let observed: string | null = null;
  f.setNext(async envelope => { observed = f.receipts.read(f.state.pendingKey); throw new Error("transport lost"); });
  await f.state.submit({ type: "command", commandId: "search", update: { type: "set", accelerator: "Command+J" } });
  expect(observed).not.toBeNull(); expect(observed!).toContain('"commandVersion":11'); expect(f.calls).toHaveLength(1); const id = f.calls[0]!.id;
  await f.state.retry(); expect(f.calls[1]!.id).toBe(id);
});

test("definite stale result preserves edit, refreshes separately, and rebase creates a new revision command", async () => {
  const f = fixture(); f.setNext(async envelope => ({ ok: false, commandId: envelope.id, error: { code: "STALE_KEYBINDINGS", message: "changed" } }));
  await f.state.submit({ type: "command", commandId: "search", update: { type: "set", accelerator: "Command+J" } });
  expect(f.state.pending).toBeUndefined(); expect(f.state.staleEdit).toMatchObject({ type: "command", commandId: "search" }); expect(f.receipts.read(f.state.pendingKey)).toContain('"stale":true');
  const revision = { counter: 4, actor: crypto.randomUUID(), opId: crypto.randomUUID() };
  f.setSnapshot({ version: 2, records: [{ key: "general.commandKeymap", deleted: false, value: { version: 1, platform: "mac", overrides: [{ command: "future-command", keys: ["Command+U"] }] }, revision }] });
  f.setNext(async envelope => ({ ok: true, commandId: envelope.id, value: { type: "preferences.keymap.mutate", preference: { key: "general.commandKeymap", deleted: false, value: { version: 1, platform: "mac", overrides: [{ command: "future-command", keys: ["Command+U"] }, { command: "search", keys: ["Command+J"] }] }, revision: { counter: 5, actor: crypto.randomUUID(), opId: crypto.randomUUID() } } } } as CommandResult));
  await f.state.rebase();
  expect(f.calls).toHaveLength(2); expect((f.calls[1] as any).command.mutation.expectedRevision).toEqual(revision); expect(f.state.record?.deleted).toBe(false);
});

test("cache and receipt failures fail closed before dispatch, and older hosts do not load v2", async () => {
  const cached = fixture(); cached.cache.write = async () => { throw new Error("cache full"); };
  await cached.state.submit({ type: "reset-all" }); expect(cached.calls).toHaveLength(0); expect(cached.state.error).toContain("cache full");
  const f = fixture(); f.receipts.write = () => { throw new Error("receipt full"); };
  await f.state.submit({ type: "reset-all" }); expect(f.calls).toHaveLength(0); expect(f.state.error).toContain("receipt full");
  const old = new CommandKeymapState("old-window", { command: f.state as any }, f.cache, memory()); old.setConnection("old", true, undefined); await old.refresh(); expect(old.error).toContain("Update the owning host");
});

test("a deferred durable cache write admits exactly one shortcut command", async () => {
  const f = fixture(); const writeStarted = deferred<void>(), release = deferred<void>(); let writes = 0;
  f.cache.write = async () => { writes++; writeStarted.resolve(); await release.promise; };
  const first = f.state.submit({ type: "reset-all" });
  await writeStarted.promise;
  const second = f.state.submit({ type: "command", commandId: "search", update: { type: "set", accelerator: "Command+J" } });
  expect(f.calls).toHaveLength(0);
  release.resolve();
  await Promise.all([first, second]);
  expect(writes).toBe(1);
  expect(f.calls).toHaveLength(1);
  expect(f.state.pending?.id).toBe(f.calls[0]!.id);
});

test("submit restores the existing scoped revision and persists a confirmed record before clearing its receipt", async () => {
  const f = fixture();
  const revision = { counter: 4, actor: crypto.randomUUID(), opId: crypto.randomUUID() };
  f.cache.values.set("agent-desktop:command-keymap:v2:window-a:host", JSON.stringify({ version: 2, records: [{ key: "general.commandKeymap", deleted: false, value: { version: 1, platform: "mac", overrides: [] }, revision }] }));
  const confirmedRevision = { counter: 5, actor: crypto.randomUUID(), opId: crypto.randomUUID() };
  f.setNext(async envelope => ({ ok: true, commandId: envelope.id, value: { type: "preferences.keymap.mutate", preference: { key: "general.commandKeymap", deleted: false, value: { version: 1, platform: "mac", overrides: [{ command: "search", keys: ["Command+J"] }] }, revision: confirmedRevision } } } as CommandResult));
  await f.state.submit({ type: "command", commandId: "search", update: { type: "set", accelerator: "Command+J" } });
  expect((f.calls[0] as any).command.mutation.expectedRevision).toEqual(revision);
  expect(JSON.parse((await f.cache.read("agent-desktop:command-keymap:v2:window-a:host"))!).records[0].revision).toEqual(confirmedRevision);
  expect(f.receipts.read(f.state.pendingKey)).toBe("");
});

test("a malformed confirmed receipt retains the original durable command", async () => {
  const f = fixture();
  f.setNext(async envelope => ({ ok: true, commandId: envelope.id, value: { type: "preferences.keymap.mutate", preference: { key: "general.commandKeymap", deleted: false } } } as CommandResult));
  await f.state.submit({ type: "reset-all" });
  expect(f.state.pending?.id).toBe(f.calls[0]!.id);
  expect(f.receipts.read(f.state.pendingKey)).toContain(f.calls[0]!.id);
  expect(f.state.error).toContain("original command was retained");
});

test("a contradictory durable edit is retained for recovery instead of replayed", async () => {
  const f = fixture();
  await f.state.submit({ type: "command", commandId: "search", update: { type: "set", accelerator: "Command+J" } });
  const saved = JSON.parse(f.receipts.read(f.state.pendingKey)!);
  saved.edit = { type: "reset-all" };
  f.receipts.write(f.state.pendingKey, JSON.stringify(saved));
  const restored = new CommandKeymapState("window-a", f.bridge, f.cache, f.receipts);
  expect(restored.receiptRecoveryError).toContain("disagrees with its command");
  expect(f.receipts.read(f.state.pendingKey)).toContain('"reset-all"');
});

test("delayed cache data and omitted remote records cannot erase a newer owner or tombstone", async () => {
  const f = fixture(); let completeRead!: (value: string | null) => void;
  const originalRead = f.cache.read;
  f.cache.read = async () => await new Promise<string | null>(resolve => { completeRead = resolve; });
  const restoring = f.state.restore();
  f.state.setConnection("other-host", true, { commandVersion: 11, snapshotVersion: 2 });
  completeRead(JSON.stringify({ version: 2, records: [{ key: "general.commandKeymap", deleted: false, value: { version: 1, platform: "mac", overrides: [] }, revision: { counter: 1, actor: crypto.randomUUID(), opId: crypto.randomUUID() } }] }));
  await restoring;
  expect(f.state.record).toBeUndefined();
  f.cache.read = originalRead;

  const tombstone: PreferencesSnapshotV2["records"][number] = { key: "general.commandKeymap", deleted: true, revision: { counter: 2, actor: crypto.randomUUID(), opId: crypto.randomUUID() } };
  f.setSnapshot({ version: 2, records: [tombstone] });
  await f.state.refresh();
  f.setSnapshot({ version: 2, records: [] });
  await f.state.refresh();
  expect(f.state.record).toMatchObject({ deleted: true, revision: tombstone.revision });
});

test("a new-owner refresh does not join the previous owner's in-flight request", async () => {
  const f = fixture(); const oldStarted = deferred<void>(), oldResponse = deferred<PreferencesSnapshotV2>(), newStarted = deferred<void>(); let reads = 0;
  f.bridge.getPreferencesV2 = async () => {
    reads++;
    if (reads === 1) { oldStarted.resolve(); return await oldResponse.promise; }
    newStarted.resolve();
    return { version: 2, records: [] };
  };
  const oldRefresh = f.state.refresh();
  await oldStarted.promise;
  f.state.setConnection("new-host", true, { commandVersion: 11, snapshotVersion: 2 });
  const newRefresh = f.state.refresh();
  await newStarted.promise;
  expect(reads).toBe(2);
  oldResponse.resolve({ version: 2, records: [] });
  await Promise.all([oldRefresh, newRefresh]);
  expect(f.state.hostId).toBe("new-host");
});

test("a delayed retry confirmation cannot regress the serialized offline snapshot", async () => {
  const f = fixture();
  await f.state.submit({ type: "reset-all" });
  const commandStarted = deferred<void>(), commandResult = deferred<CommandResult>();
  const firstWrite = deferred<void>(), secondWrite = deferred<void>();
  const writes: Array<{ value: string; done: ReturnType<typeof deferred<void>> }> = [];
  f.cache.write = async (_key: string, value: string) => {
    const done = deferred<void>(); writes.push({ value, done });
    if (writes.length === 1) firstWrite.resolve(); else secondWrite.resolve();
    await done.promise;
  };
  f.setNext(async () => { commandStarted.resolve(); return await commandResult.promise; });
  const retrying = f.state.retry();
  await commandStarted.promise;
  const revision2 = { counter: 2, actor: crypto.randomUUID(), opId: crypto.randomUUID() };
  f.setSnapshot({ version: 2, records: [{ key: "general.commandKeymap", deleted: false, value: { version: 1, platform: "mac", overrides: [] }, revision: revision2 }] });
  const refreshing = f.state.refresh();
  await firstWrite.promise;
  const revision3 = { counter: 3, actor: crypto.randomUUID(), opId: crypto.randomUUID() };
  commandResult.resolve({ ok: true, commandId: f.state.pending!.id, value: { type: "preferences.keymap.mutate", preference: { key: "general.commandKeymap", deleted: false, value: { version: 1, platform: "mac", overrides: [] }, revision: revision3 } } } as CommandResult);
  writes[0]!.done.resolve();
  await secondWrite.promise;
  expect(JSON.parse(writes[0]!.value).records[0].revision).toEqual(revision2);
  expect(JSON.parse(writes[1]!.value).records[0].revision).toEqual(revision3);
  writes[1]!.done.resolve();
  await Promise.all([retrying, refreshing]);
});

test("a retained stale edit requires rebase or explicit dismissal", async () => {
  const f = fixture();
  f.setNext(async envelope => ({ ok: false, commandId: envelope.id, error: { code: "STALE_KEYBINDINGS", message: "changed" } }));
  await f.state.submit({ type: "reset-all" });
  await f.state.submit({ type: "command", commandId: "search", update: { type: "set", accelerator: "Command+J" } });
  expect(f.calls).toHaveLength(1);
  expect(f.state.error).toContain("Rebase or dismiss");
  f.state.dismissStale();
  expect(f.state.staleEdit).toBeUndefined();
  expect(f.receipts.read(f.state.pendingKey)).toBe("");
});

test("separate persisted window owners retain independent ambiguous receipts for one host", async () => {
  const rawCache = memory(), receipts = memory();
  const cache = { read: async (key: string) => rawCache.read(key), write: async (key: string, value: string) => { rawCache.write(key, value); } };
  const calls: CommandEnvelope[] = [];
  const bridge = {
    getPreferencesV2: async (): Promise<PreferencesSnapshotV2> => ({ version: 2, records: [] }),
    command: async (envelope: CommandEnvelope): Promise<CommandResult> => {
      calls.push(envelope);
      return { ok: false, commandId: envelope.id, error: { code: "OUTCOME_UNKNOWN", message: "lost" } };
    },
  };
  const left = new CommandKeymapState("window-left", bridge, cache, receipts);
  const right = new CommandKeymapState("window-right", bridge, cache, receipts);
  left.setConnection("host", true, { commandVersion: 11, snapshotVersion: 2 });
  right.setConnection("host", true, { commandVersion: 11, snapshotVersion: 2 });
  await left.submit({ type: "reset-all" });
  await right.submit({ type: "command", commandId: "search", update: { type: "set", accelerator: "Command+J" } });
  expect(left.pendingKey).not.toBe(right.pendingKey);
  expect(receipts.read(left.pendingKey)).toContain(left.pending!.id);
  expect(receipts.read(right.pendingKey)).toContain(right.pending!.id);

  const restoredLeft = new CommandKeymapState("window-left", bridge, cache, receipts);
  const restoredRight = new CommandKeymapState("window-right", bridge, cache, receipts);
  expect(restoredLeft.pending?.id).toBe(left.pending!.id);
  expect(restoredRight.pending?.id).toBe(right.pending!.id);
  expect(calls).toHaveLength(2);
});

test("authoritative refresh recovers unresolved cache restoration before exposing effective bindings", async () => {
  const f = fixture();
  f.cache.read = async () => { throw new Error("Unreadable cache"); };
  expect(f.state.loaded).toBe(false);
  await f.state.restore();
  expect(f.state.loaded).toBe(false);
  expect(f.state.cacheWarning).toContain("Unreadable cache");
  expect(await f.state.refresh()).toBe(true);
  expect(f.state.loaded).toBe(true);
  expect(f.calls).toHaveLength(0);
});

test("close cannot discard an admitted edit awaiting cache durability or replay a retained receipt", async () => {
  const f = fixture(), started = deferred<void>(), release = deferred<void>();
  f.cache.write = async () => { started.resolve(); await release.promise; };
  const edit = f.state.submit({ type: "reset-all" });
  await started.promise;
  expect(f.state.prepareWindowClose(new AbortController().signal)).toBe(false);
  expect(f.calls).toHaveLength(0);
  release.resolve(); await edit;
  expect(f.state.pending).toBeDefined();
  const original = f.state.pending!.id;
  expect(f.receipts.read(f.state.pendingKey)).toContain(original);
  expect(f.state.prepareWindowClose(new AbortController().signal)).toBe(true);
  expect(f.calls).toHaveLength(1);
  expect(f.state.pending?.id).toBe(original);
  const canceled = new AbortController(); canceled.abort();
  expect(f.state.prepareWindowClose(canceled.signal)).toBe(false);
});
