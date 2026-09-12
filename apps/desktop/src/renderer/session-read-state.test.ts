import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { HostStore } from "../../../host/src/store";
import { PreferencesStore } from "../../../host/src/preferences/store";
import type { CommandEnvelope, CommandResult, SessionSummary } from "../../../../packages/shared/src/protocol";
import { parsePreferenceChange } from "../../../../packages/shared/src/preferences";
import { isUnreadSessionEvent, sessionReadKey } from "../../../../packages/shared/src/session-read";
import { PreferencesState } from "./preferences-state";
import { SessionReadState } from "./session-read-state";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "session-read-")); const store = new HostStore(directory);
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const session: SessionSummary = { id: crypto.randomUUID(), hostId: store.host.id, projectId: null, cwd: directory, title: "Task", status: "idle", sessionFile: join(directory, "session.jsonl"), model: null, createdAt: 1, updatedAt: 1, archived: false };
  store.upsertSession(session);
  const native = new PreferencesStore(store), receipts = new Map<string, string>(), deliveries: string[] = [], results = new Map<string, CommandResult>();
  let hold: Promise<void> | undefined, drop = false;
  const bridge = { getPreferences: async () => native.snapshot(), subscribe: () => () => {}, command: async (envelope: CommandEnvelope): Promise<CommandResult> => {
    deliveries.push(envelope.id); await hold;
    if (results.has(envelope.id)) return results.get(envelope.id)!;
    if (envelope.command.type !== "preferences.put") throw new Error("Unexpected command");
    const result: CommandResult = { ok: true, commandId: envelope.id, value: { type: "preferences.put", preference: native.put(envelope.command.change) } };
    results.set(envelope.id, result); if (drop) { drop = false; throw new Error("Lost read-mark acknowledgement"); } return result;
  } };
  const cache = { read: async (key: string) => receipts.get(key) ?? null, write: async (key: string, value: string) => { receipts.set(key, value); } };
  const pending = { read: (key: string) => receipts.get(key) ?? null, write: (key: string, value: string) => { receipts.set(key, value); } };
  const preferences = new PreferencesState(bridge, cache, pending); preferences.setConnection(store.host.id, true);
  const reads = new SessionReadState(preferences);
  const activity = (event: unknown = { type: "agent_end", messages: [] }) => store.appendEvent({ type: "runtime", sessionId: session.id, event }, isUnreadSessionEvent(event));
  return { directory, store, native, session, preferences, reads, activity, deliveries, bridge, cache, pending, hold: (value?: Promise<void>) => { hold = value; }, drop: () => { drop = true; } };
}
test("native output cursor is durable, while user/catalog/tool chatter does not mark a conversation unread", () => {
  const f = fixture();
  for (const event of [{ type: "agent_start" }, { type: "tool_execution_end" }, { type: "message_end", message: { role: "user" } }, { type: "queued_messages_changed" }]) f.activity(event);
  expect(f.store.getSession(f.session.id)?.activitySequence).toBeUndefined();
  const output = f.activity({ type: "message_end", message: { role: "assistant" } });
  expect(f.store.getSession(f.session.id)?.activitySequence).toBe(output.sequence);
  expect(f.store.getSession(f.session.id)?.updatedAt).toBe(1);
  const reopened = new HostStore(f.directory); cleanup.push(() => reopened.close());
  expect(reopened.getSession(f.session.id)?.activitySequence).toBe(output.sequence);
  expect(reopened.eventsAfter(output.sequence - 1)[0]?.sequence).toBe(output.sequence);
});
test("event and attention cursor commit atomically on storage failure", () => {
  const f = fixture(), db = new Database(join(f.directory, "state.sqlite")); cleanup.push(() => db.close());
  const before = f.store.lastEventSequence;
  db.exec("CREATE TRIGGER reject_read_cursor BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'read cursor disk failure'); END");
  expect(() => f.activity()).toThrow("read cursor disk failure");
  expect(f.store.lastEventSequence).toBe(before); expect(f.store.getSession(f.session.id)?.activitySequence).toBeUndefined();
});
test("original host/session marks survive reopening and do not cross equal session IDs on another host", async () => {
  const f = fixture(); await f.preferences.refresh(); f.activity(); const current = f.store.getSession(f.session.id)!;
  expect(f.reads.isUnread(current)).toBe(true); expect(await f.reads.mark(current, false)).toBe(true);
  const reopened = new PreferencesState(f.bridge, f.cache, f.pending); reopened.setConnection(f.store.host.id, true); await reopened.refresh();
  const reads = new SessionReadState(reopened);
  expect(reads.isUnread(current)).toBe(false);
  expect(reads.isUnread({ ...current, hostId: crypto.randomUUID() })).toBe(true);
  expect(await reads.mark(current, true)).toBe(true); expect(reads.isUnread(current)).toBe(true);
});
test("a held mark captures only seen output and cannot hide new output while its acknowledgement is pending", async () => {
  const f = fixture(); await f.preferences.refresh(); f.activity(); const seen = f.store.getSession(f.session.id)!;
  let release!: () => void; f.hold(new Promise<void>(resolve => { release = resolve; }));
  const marking = f.reads.mark(seen, false);
  f.activity(); const newer = f.store.getSession(f.session.id)!;
  release(); expect(await marking).toBe(true);
  expect(f.reads.isUnread(seen)).toBe(false); expect(f.reads.isUnread(newer)).toBe(true);
  expect(f.preferences.get(sessionReadKey(seen.hostId, seen.id))?.sequence).toBe(seen.activitySequence);
});
test("lost read-mark receipt survives restart and checks the original command instead of minting another", async () => {
  const f = fixture(); await f.preferences.refresh(); f.activity(); const current = f.store.getSession(f.session.id)!;
  f.drop(); expect(await f.reads.mark(current, false)).toBe(false); expect(f.preferences.pending).toHaveLength(1);
  const original = f.deliveries[0];
  const reopened = new PreferencesState(f.bridge, f.cache, f.pending); reopened.setConnection(f.store.host.id, true); await reopened.refresh();
  const reads = new SessionReadState(reopened); await reads.retry();
  expect(f.deliveries).toEqual([original!, original!]); expect(reopened.pending).toHaveLength(0); expect(reads.isUnread(current)).toBe(false);
});
test("offline remote sessions can be marked through the local replica; unavailable local storage does not fake success", async () => {
  const f = fixture(); await f.preferences.refresh(); const remote = { ...f.session, hostId: crypto.randomUUID(), activitySequence: 7 };
  expect(await f.reads.mark(remote, false)).toBe(true); expect(f.reads.isUnread(remote)).toBe(false);
  f.preferences.setConnection(f.store.host.id, false);
  expect(await f.reads.mark(remote, true)).toBe(false); expect(f.reads.isUnread(remote)).toBe(false);
  expect(f.reads.error).toContain("Cached conversations remain readable"); expect(f.deliveries).toHaveLength(1);
});
test("failed admission has no retry receipt and an existing matching mark cannot hide a lost acknowledgement", async () => {
  const f = fixture(); await f.preferences.refresh(); f.activity(); const current = f.store.getSession(f.session.id)!;
  expect(await f.reads.mark(current, false)).toBe(true);
  f.preferences.setConnection(f.store.host.id, false);
  expect(await f.reads.mark(current, true)).toBe(false);
  const failure = f.reads.error;
  await f.reads.retry(); expect(f.reads.error).toBe(failure); expect(f.deliveries).toHaveLength(1);
  f.preferences.setConnection(f.store.host.id, true);
  await f.reads.retry(); expect(f.reads.error).toBe(failure); expect(f.deliveries).toHaveLength(1);
  f.reads.dismissError(); expect(f.reads.error).toBeUndefined();
  f.drop(); expect(await f.reads.mark(current, false)).toBe(false);
  expect(f.reads.isUnread(current)).toBe(false); expect(f.preferences.pending).toHaveLength(1);
  await f.reads.retry(); expect(f.preferences.pending).toHaveLength(0); expect(f.reads.error).toBeUndefined();
  expect(f.deliveries[1]).toBe(f.deliveries[2]);
});
test("read preference validation rejects foreign key shape, unsafe cursor and accidental extra fields", () => {
  const key = sessionReadKey(crypto.randomUUID(), crypto.randomUUID());
  expect(parsePreferenceChange({ key, value: { sequence: 0, unread: true } })).toEqual({ key, value: { sequence: 0, unread: true } });
  for (const value of [{ sequence: -1, unread: true }, { sequence: 1.5, unread: false }, { sequence: 0, unread: "false" }, { sequence: 0, unread: false, hostId: "ignored" }]) expect(() => parsePreferenceChange({ key, value })).toThrow();
  expect(() => parsePreferenceChange({ key: "session.read.path/task", value: { sequence: 0, unread: false } })).toThrow();
});

// Commit and focus delivery are controlled here; the composed Sidebar fixture mounts React.
import React from "react";
import { useSessionReadState } from "./use-session-read-state";
function readHook(f: ReturnType<typeof fixture>) {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window"), oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  let focused = true;
  const win = new EventTarget(), doc = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => focused });
  Object.defineProperty(globalThis, "window", { configurable: true, value: win }); Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  let selected = f.store.getSession(f.session.id)!, visible = true, loaded = false, cursor = 0;
  const slots: any[] = [], cleanups = new Map<number, () => void>(); let effects: (() => void)[] = [];
  let owner!: SessionReadState;
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher = {
    useMemo(factory: () => unknown, deps: readonly unknown[]) { const i = cursor++, prior = slots[i]; if (!prior || !deps.every((value, at) => Object.is(value, prior.deps[at]))) slots[i] = { deps, value: factory() }; return slots[i].value; },
    useRef(initial: unknown) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useState(initial: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], (value: unknown) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useReducer(_reducer: unknown, initial: unknown) { cursor++; return [initial, () => {}]; },
    useEffect(fn: () => void | (() => void), deps: readonly unknown[]) { const i = cursor++, prior = slots[i]; if (prior && deps.length === prior.length && deps.every((value, at) => Object.is(value, prior[at]))) return; effects.push(() => { cleanups.get(i)?.(); cleanups.delete(i); const close = fn(); if (close) cleanups.set(i, close); slots[i] = deps; }); },
  };
  function render(next: { selected?: SessionSummary; visible?: boolean; loaded?: boolean } = {}) {
    selected = next.selected ?? selected; visible = next.visible ?? visible; loaded = next.loaded ?? loaded; cursor = 0; effects = [];
    const previous = internals.H; internals.H = dispatcher;
    try { owner = useSessionReadState(f.preferences, selected, visible, loaded); } finally { internals.H = previous; }
    for (const effect of effects) effect();
  }
  cleanup.push(() => { for (const close of cleanups.values()) close(); if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else Reflect.deleteProperty(globalThis, "window"); if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument); else Reflect.deleteProperty(globalThis, "document"); });
  return { render, get owner() { return owner; }, focus(value: boolean) { focused = value; win.dispatchEvent(new Event(value ? "focus" : "blur")); render(); }, async settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); render(); } };
}
test("actual read hook waits for loaded foreground content and preserves explicit unread until new content or a new view", async () => {
  const f = fixture(); await f.preferences.refresh(); f.activity(); const first = f.store.getSession(f.session.id)!;
  const hook = readHook(f); hook.render(); await hook.settle();
  expect(f.deliveries).toHaveLength(0); expect(hook.owner.isUnread(first)).toBe(true);
  hook.render({ loaded: true }); await hook.settle(); expect(hook.owner.isUnread(first)).toBe(false);
  expect(await hook.owner.mark(first, true)).toBe(true); hook.render(); await hook.settle(); expect(hook.owner.isUnread(first)).toBe(true);
  f.activity(); const second = f.store.getSession(f.session.id)!;
  hook.render({ selected: second, loaded: false }); await hook.settle(); expect(hook.owner.isUnread(second)).toBe(true);
  hook.focus(false); hook.render({ loaded: true }); await hook.settle(); expect(hook.owner.isUnread(second)).toBe(true);
  hook.focus(true); await hook.settle(); expect(hook.owner.isUnread(second)).toBe(false);
  hook.render({ visible: false }); f.activity(); const third = f.store.getSession(f.session.id)!;
  hook.render({ selected: third }); await hook.settle(); expect(hook.owner.isUnread(third)).toBe(true);
  hook.render({ visible: true }); await hook.settle(); expect(hook.owner.isUnread(third)).toBe(false);
});

import { HostCatalog } from "./host-catalog";
import type { HostState } from "../../../../packages/shared/src/protocol";
test("durable activity events update only their original catalog row and older snapshots cannot erase it", () => {
  const f = fixture(), catalog = new HostCatalog(undefined);
  const state: HostState = { protocolVersion: 1, host: f.store.host, projects: [], sessions: [f.session], drafts: [], models: [], lastEventSequence: 0 };
  catalog.ingest({ type: "state", sequence: 0, state });
  catalog.ingest({ type: "runtime", sequence: 1, sessionId: f.session.id, hostId: crypto.randomUUID(), sessionActivity: true, event: { type: "agent_end" } });
  expect(catalog.records.get(f.session.hostId)?.state?.sessions[0]?.activitySequence).toBeUndefined();
  catalog.ingest({ type: "runtime", sequence: 2, sessionId: f.session.id, hostId: f.session.hostId, event: { type: "tool_execution_end" } });
  expect(catalog.records.get(f.session.hostId)?.state?.sessions[0]?.activitySequence).toBeUndefined();
  catalog.ingest({ type: "runtime", sequence: 3, sessionId: f.session.id, hostId: f.session.hostId, sessionActivity: true, event: { type: "agent_end" } });
  expect(catalog.records.get(f.session.hostId)?.state?.sessions[0]?.activitySequence).toBe(3);
  catalog.ingest({ type: "state", sequence: 2, state });
  catalog.ingest({ type: "interactions", sequence: 1, sessionId: f.session.id, hostId: f.session.hostId, sessionActivity: true });
  expect(catalog.records.get(f.session.hostId)?.state?.sessions[0]?.activitySequence).toBe(3);
  expect(catalog.records.get(f.session.hostId)?.state?.sessions[0]?.title).toBe("Task");
  expect(catalog.records.get(f.session.hostId)?.state?.models).toEqual([]);
});
