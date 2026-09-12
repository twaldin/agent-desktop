import { expect, test } from "bun:test";
import type { DesktopEvent } from "../../../../packages/shared/src/protocol";
import type { PreferencesSnapshotV2 } from "../../../../packages/shared/src/preferences-v2";
import { CommandKeymapState } from "./command-keymap-state";
import { observeCommandKeymap } from "./command-keymap-observer";

function fixture() {
  let listener: ((event: DesktopEvent) => void) | undefined;
  let reads = 0;
  let next: () => Promise<PreferencesSnapshotV2> = async () => ({ version: 2, records: [] });
  const bridge = {
    command: async () => { throw new Error("Observer must not dispatch commands"); },
    getPreferencesV2: () => { reads++; return next(); },
    subscribe: (value: (event: DesktopEvent) => void) => { listener = value; return () => { listener = undefined; }; },
  };
  const cache = new Map<string, string>();
  const state = new CommandKeymapState("primary", bridge, {
    read: async key => cache.get(key) ?? null, write: async (key, value) => { cache.set(key, value); },
  }, { read: () => null, write: () => { throw new Error("Observer must not write receipts"); } });
  state.setConnection("local", true, { commandVersion: 11, snapshotVersion: 2 });
  const observer = observeCommandKeymap(state, bridge);
  return { state, observer, reads: () => reads, setNext: (value: typeof next) => { next = value; }, emit: (hostId?: string) => listener?.({ type: "preferences", sequence: 1, hostId }) };
}
function snapshot(counter: number): PreferencesSnapshotV2 {
  return { version: 2, records: [{ key: "general.commandKeymap", deleted: false,
    value: { version: 1, platform: "mac", overrides: [] },
    revision: { counter, actor: "00000000-0000-4000-8000-000000000001", opId: "00000000-0000-4000-8000-000000000002" },
  }] };
}
test("preference events during a read cause one trailing authoritative read without command replay", async () => {
  const f = fixture();
  let release!: (value: PreferencesSnapshotV2) => void;
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  f.setNext(() => { started(); return new Promise(resolve => { release = resolve; }); });
  const first = f.observer.refresh(); await began;
  f.emit("other"); expect(f.reads()).toBe(1);
  f.emit("local"); f.emit();
  f.setNext(async () => snapshot(2)); release(snapshot(1));
  await first;
  expect(f.reads()).toBe(2); expect(f.state.record?.revision.counter).toBe(2);
  f.observer.stop(); f.emit("local"); await f.observer.refresh();
  expect(f.reads()).toBe(2);
});
test("stopping observation cancels a queued reread and offline restoration makes no host request", async () => {
  const f = fixture(); f.state.setConnection("local", false, { commandVersion: 11, snapshotVersion: 2 });
  await f.observer.refresh(); expect(f.reads()).toBe(0);
  f.state.setConnection("local", true, { commandVersion: 11, snapshotVersion: 2 });
  let release!: (value: PreferencesSnapshotV2) => void;
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  f.setNext(() => { started(); return new Promise(resolve => { release = resolve; }); });
  const read = f.observer.refresh(); await began;
  f.emit("local"); f.observer.stop(); release(snapshot(1)); await read;
  expect(f.reads()).toBe(1);
});
