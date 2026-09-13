import { expect, test } from "bun:test";
import React from "react";
import { useForceTool } from "./use-force-tool";
import type { ForceToolOwner, ForceToolPorts, ForceToolRead, ForceToolSnapshot } from "./force-tool-state";

const owner = { hostId: "host-a", sessionId: "session-a" };
function snapshot(target = owner, pending = false): ForceToolSnapshot {
  return { epoch: "epoch", revision: 1, nativeSessionId: target.sessionId,
    model: { provider: "controlled", id: "model", api: "openai-completions" },
    availability: { state: "supported", reason: "Controlled hook fixture" },
    tools: [{ name: "read", available: true }], canArm: true, canCancel: pending,
    directives: pending ? [{ id: "directive", toolName: "read", phase: "pending-tool", requeued: false }] : [] };
}
function ports(pending = false) {
  const reads: Array<{ owner: ForceToolOwner; resolve(value: ForceToolRead): void }> = [];
  const cancellations: ForceToolOwner[] = [], insertions: ForceToolOwner[] = [];
  const value: ForceToolPorts = {
    read(target) { return new Promise(resolve => { reads.push({ owner: { ...target }, resolve }); }); },
    async cancel(target) { cancellations.push({ ...target }); return snapshot(target); },
    insertDraft(target) { insertions.push({ ...target }); },
    async recoverPrompt() { throw new Error("Recovery is outside these hook lifecycle cases"); },
  };
  return { value, reads, cancellations, insertions,
    answer(index: number, next = snapshot(reads[index]!.owner, pending)) {
      const request = reads[index]!;
      request.resolve({ protocolVersion: 1, ...request.owner, value: next });
    } };
}

type Input = { owner: ForceToolOwner; ports: ForceToolPorts; connected: boolean; active: boolean; draftText: string };
type Effect = { phase: "layout" | "passive"; deps: readonly unknown[]; setup(): void | (() => void); cleanup?: () => void };
const equal = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
/** Actual hook + actual ForceToolState, using the repository's controlled React
 * dispatcher convention. This models commit boundaries, not mounted React/IPC.
 * Abandoned renders publish neither memo slots nor effect dependencies. */
function fixture(initialPorts: ForceToolPorts) {
  let committed: Input = { owner, ports: initialPorts, connected: true, active: true, draftText: "" };
  let memos: Array<{ deps: readonly unknown[]; value: unknown }> = [];
  const effects = new Map<number, Effect>();
  let value: ReturnType<typeof useForceTool>;
  const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } })
    .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  function cleanup(phase: Effect["phase"]) {
    for (const effect of effects.values()) if (effect.phase === phase) { effect.cleanup?.(); effect.cleanup = undefined; }
  }
  function setup(effect: Effect) { effect.cleanup = effect.setup() || undefined; }
  function render(change: Partial<Input> = {}, commit = true) {
    const input = { ...committed, ...change }, nextMemos = memos.slice(), pending = new Map<number, Effect>();
    let cursor = 0;
    function effect(phase: Effect["phase"], setup: Effect["setup"], deps: readonly unknown[]) {
      const index = cursor++, previous = effects.get(index);
      if (!previous || !equal(previous.deps, deps)) pending.set(index, { phase, setup, deps });
    }
    const dispatcher = {
      useMemo(factory: () => unknown, deps: readonly unknown[]) {
        const index = cursor++, previous = nextMemos[index];
        if (!previous || !equal(previous.deps, deps)) nextMemos[index] = { deps, value: factory() };
        return nextMemos[index]!.value;
      },
      useSyncExternalStore(_subscribe: unknown, get: () => unknown) { cursor++; return get(); },
      useLayoutEffect(setup: Effect["setup"], deps: readonly unknown[]) { effect("layout", setup, deps); },
      useEffect(setup: Effect["setup"], deps: readonly unknown[]) { effect("passive", setup, deps); },
    };
    const previous = internals.H; internals.H = dispatcher;
    let rendered: ReturnType<typeof useForceTool>;
    try { rendered = useForceTool(input.owner, input.ports, input); } finally { internals.H = previous; }
    if (!commit) return;
    committed = input; memos = nextMemos; value = rendered;
    for (const phase of ["layout", "passive"] as const) {
      for (const [index, next] of pending) if (next.phase === phase) effects.get(index)?.cleanup?.();
      for (const [index, next] of pending) if (next.phase === phase) { effects.set(index, next); setup(next); }
    }
  }
  render();
  return { render, get state() { return value.state; },
    unmountLayout() { cleanup("layout"); },
    strictReplay() {
      cleanup("layout"); cleanup("passive");
      for (const phase of ["layout", "passive"] as const) for (const effect of effects.values()) if (effect.phase === phase) setup(effect);
    },
    dispose() { cleanup("layout"); cleanup("passive"); effects.clear(); },
  };
}
async function settle() { for (let i = 0; i < 6; i++) await Promise.resolve(); }

test("speculative ports cannot redirect committed reads or cancellation; committed replacement can", async () => {
  const a = ports(true), b = ports(true), f = fixture(a.value);
  try {
    a.answer(0); await settle();
    f.render({ ports: b.value, draftText: "abandoned edit" }, false);
    expect(f.state.getSnapshot().latestDraft).toBe("");
    await f.state.cancel("directive");
    expect(a.cancellations).toEqual([owner]); expect(b.cancellations).toEqual([]);
    const read = f.state.refresh();
    expect(a.reads.map(r => r.owner)).toEqual([owner, owner]); expect(b.reads).toHaveLength(0);
    a.answer(1); await read;
    f.render({ ports: b.value });
    const replacement = f.state.refresh();
    expect(b.reads.map(r => r.owner)).toEqual([owner]); b.answer(0); await replacement;
    await f.state.cancel("directive"); expect(b.cancellations).toEqual([owner]);
    const nextOwner = { hostId: "host-b", sessionId: "session-b" };
    f.render({ owner: nextOwner });
    expect(b.reads.map(r => r.owner)).toEqual([owner, nextOwner]);
    b.answer(1); await settle(); expect(f.state.getSnapshot().snapshot?.nativeSessionId).toBe(nextOwner.sessionId);
  } finally { f.dispose(); }
});

test("layout unmount invalidates a held read before passive cleanup or its late callback", async () => {
  const p = ports(), f = fixture(p.value);
  try {
    expect(p.reads).toHaveLength(1); expect(f.state.getSnapshot().loading).toBe(true);
    f.unmountLayout();
    p.answer(0); await settle();
    expect(f.state.getSnapshot()).toMatchObject({ connected: false, active: false, fresh: false, loading: false, snapshot: null });
    await f.state.refresh(); expect(p.reads).toHaveLength(1);
  } finally { f.dispose(); }
});

test("StrictMode cleanup/setup rejects the earlier read and leaves the committed hook usable", async () => {
  const p = ports(), f = fixture(p.value);
  try {
    f.strictReplay(); expect(p.reads).toHaveLength(2);
    p.answer(0, { ...snapshot(), revision: 9 }); await settle();
    expect(f.state.getSnapshot().snapshot).toBeNull();
    p.answer(1); await settle();
    expect(f.state.getSnapshot()).toMatchObject({ connected: true, active: true, fresh: true, snapshot: { revision: 1 } });
    f.state.select("read"); f.state.setPrompt("Read the file");
    expect(f.state.prepare()).toBe(true); expect(p.insertions).toEqual([owner]);
  } finally { f.dispose(); }
});

test("committed draft-only edits preserve the held read and do not trigger another refresh", async () => {
  const p = ports(), f = fixture(p.value);
  try {
    f.render({ draftText: "New composer text" });
    expect(f.state.getSnapshot().latestDraft).toBe("New composer text"); expect(p.reads).toHaveLength(1);
    p.answer(0); await settle(); f.render();
    expect(f.state.getSnapshot()).toMatchObject({ latestDraft: "New composer text", fresh: true, snapshot: { revision: 1 } });
    f.render({ draftText: "Later edit" });
    expect(f.state.getSnapshot().latestDraft).toBe("Later edit"); expect(p.reads).toHaveLength(1);
    expect(p.cancellations).toEqual([]); expect(p.insertions).toEqual([]);
  } finally { f.dispose(); }
});
