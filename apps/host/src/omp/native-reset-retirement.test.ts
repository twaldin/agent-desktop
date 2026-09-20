import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { AgentSession, CodexResetPolicySessionBinding, CodexResetPolicySessionLifecycleListener } from "@oh-my-pi/pi-coding-agent";
import { discoverAuthStorage, ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { NativeResetRuntimeOwners, type NativeResetRuntimeOwner } from "./native-reset-runtime";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
// Cross a task boundary after synchronously publishing native lifecycle phases;
// this drains their promise continuations without waiting for wall-clock time.
const tick = () => setImmediate();

async function fixture(create?: (binding: Readonly<CodexResetPolicySessionBinding>, events: string[]) => NativeResetRuntimeOwner) {
  const root = await mkdtemp("/tmp/reset-retirement-");
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"); await mkdir(agentDir);
  const settings = await Settings.loadReadOnly({ agentDir, cwd: root });
  const writer = await settings.enableResetPolicyPersistence();
  const auth = await discoverAuthStorage(agentDir);
  const registry = new ModelRegistry(auth, join(agentDir, "models.yml"), { settings });
  cleanup.push(async () => { settings.disableResetPolicyPersistence(); auth.close(); });
  const events: string[] = [];
  const group = new NativeResetRuntimeOwners({ settings, writer, authStorage: auth, modelRegistry: registry }, () => undefined,
    binding => create?.(binding, events) ?? lifecycleOwner(binding.session.sessionId, events));
  function session(id: string, originalRoot = false, holdDrain = false) {
    const ownedSettings = originalRoot ? settings : Settings.isolated({}, { resetPolicyWriter: writer });
    const listeners = new Set<Readonly<CodexResetPolicySessionLifecycleListener>>();
    const drain = Promise.withResolvers<void>();
    let closing = false, drained = false;
    const native = {
      settings: ownedSettings, modelRegistry: registry, sessionId: id,
      get isDisposed() { return closing; },
      beginDispose() {
        if (closing) return; closing = true;
        for (const listener of listeners) listener.beginClose();
        if (!holdDrain) signalDrained();
      },
      async drainCodexResetPolicy() { await drain.promise; return { state: "settled" }; },
    } as unknown as AgentSession;
    function signalDrained() {
      if (drained) return; drained = true; drain.resolve();
      for (const listener of [...listeners]) listener.drained();
    }
    const binding: Readonly<CodexResetPolicySessionBinding> = { session: native, settings: ownedSettings, modelRegistry: registry, authStorage: auth,
      registerLifecycle(listener) {
        listeners.add(listener);
        if (closing) listener.beginClose();
        if (drained) listener.drained();
        return () => { listeners.delete(listener); };
      } };
    return { binding, native, signalDrained, close: () => native.beginDispose() };
  }
  return { group, session, events };
}

function lifecycleOwner(id: string, events: string[]): NativeResetRuntimeOwner {
  return {
    async checkpoint() { events.push(`request:${id}`); }, async presentDecision() {},
    async admit() { return { kind: "hold", reason: "owner-unavailable" }; }, async complete() {},
    beginSessionClose() { events.push(`local-close:${id}`); },
    async retireSession() { events.push(`retire:${id}`); },
    beginClose() { events.push(`whole-close:${id}`); },
    async finish() { events.push(`whole-finish:${id}`); },
  };
}

const started = { phase: "started" as const, pass: {} as never };

test("sequential exact-session child churn reuses capacity beyond 128 while the original root stays pinned", async () => {
  const f = await fixture(), original = f.session("root", true);
  const rootOwner = f.group.factory(original.binding);
  for (let index = 0; index < 260; index++) {
    const child = f.session("same-native-id");
    f.group.factory(child.binding); child.close(); await tick();
  }
  await rootOwner.checkpoint(started);
  expect(f.events.filter(value => value === "retire:same-native-id")).toHaveLength(260);
  expect(f.events).not.toContain("local-close:root");
  expect(f.events).not.toContain("whole-close:root");
  expect(f.events).not.toContain("whole-finish:root");
  expect(f.events.at(-1)).toBe("request:root");
  f.group.beginClose(); await f.group.finish();
  expect(f.events.filter(value => value === "whole-finish:root")).toHaveLength(1);
});

test("live and retiring capacity stays occupied through native drain and local cleanup", async () => {
  const cleanupStarted = Promise.withResolvers<void>(), cleanupRelease = Promise.withResolvers<void>();
  const f = await fixture((binding, events) => {
    const owner = lifecycleOwner(binding.session.sessionId, events);
    if (binding.session.sessionId === "held") owner.retireSession = async () => {
      cleanupStarted.resolve(); await cleanupRelease.promise; events.push("retire:held");
    };
    return owner;
  });
  f.group.factory(f.session("root", true).binding);
  const held = f.session("held", false, true); f.group.factory(held.binding);
  for (let index = 0; index < 126; index++) f.group.factory(f.session(`live-${index}`).binding);
  held.close(); await tick();
  expect(() => f.group.factory(f.session("overflow-native").binding)).toThrow();
  expect(f.events).not.toContain("retire:held");
  held.signalDrained(); await cleanupStarted.promise;
  expect(() => f.group.factory(f.session("overflow-local").binding)).toThrow();
  cleanupRelease.resolve(); await tick();
  const replacement = f.group.factory(f.session("replacement").binding);
  await replacement.checkpoint(started);
  expect(f.events.at(-1)).toBe("request:replacement");
  await f.group.finish();
});

test("whole shutdown joins every child drain and local cleanup before the root alone finishes", async () => {
  const cleanupStarted = Promise.withResolvers<void>(), cleanupRelease = Promise.withResolvers<void>();
  const f = await fixture((binding, events) => {
    const owner = lifecycleOwner(binding.session.sessionId, events);
    if (binding.session.sessionId === "first") owner.retireSession = async () => {
      cleanupStarted.resolve(); await cleanupRelease.promise; events.push("retire:first");
    };
    return owner;
  });
  f.group.factory(f.session("root", true).binding);
  const first = f.session("first", false, true), second = f.session("second", false, true);
  f.group.factory(first.binding); const secondOwner = f.group.factory(second.binding);
  const finishing = f.group.finish();
  expect(f.group.finish()).toBe(finishing);
  await tick();
  expect(f.events).toEqual(["whole-close:root", "local-close:first", "local-close:second"]);
  // A prestarted native pass can still deliver factual callbacks after finish
  // was requested, until its exact native drained notification.
  await secondOwner.checkpoint({ phase: "finished", pass: {} as never, settlement: {} as never });
  first.signalDrained(); await cleanupStarted.promise;
  second.signalDrained(); await tick();
  expect(f.events).toContain("retire:second");
  expect(f.events).not.toContain("whole-finish:root");
  cleanupRelease.resolve(); await finishing;
  expect(f.events.filter(value => value.startsWith("whole-finish:"))).toEqual(["whole-finish:root"]);
  expect(f.events.indexOf("whole-finish:root")).toBeGreaterThan(f.events.indexOf("retire:first"));
  expect(f.events.indexOf("whole-finish:root")).toBeGreaterThan(f.events.indexOf("retire:second"));
});

test("a child cleanup failure releases only its settled slot and remains visible at root finish", async () => {
  const failure = new Error("controlled local cleanup failure");
  const f = await fixture((binding, events) => {
    const owner = lifecycleOwner(binding.session.sessionId, events);
    if (binding.session.sessionId === "bad") owner.retireSession = async () => { throw failure; };
    return owner;
  });
  const rootOwner = f.group.factory(f.session("root", true).binding);
  const bad = f.session("bad"); f.group.factory(bad.binding); bad.close(); await tick();
  const sibling = f.group.factory(f.session("sibling").binding);
  await rootOwner.checkpoint(started); await sibling.checkpoint(started);
  expect(f.events.slice(-2)).toEqual(["request:root", "request:sibling"]);
  const result = await f.group.finish().catch(error => error);
  expect(result).toBeInstanceOf(AggregateError); expect(result.errors).toContain(failure);
  expect(f.events.filter(value => value === "whole-finish:root")).toHaveLength(1);
  expect(f.events).toContain("retire:sibling");
});

test("factory failure keeps its exact native slot until drain and cannot replace the pinned root", async () => {
  const failure = new Error("controlled child factory failure");
  const f = await fixture((binding, events) => {
    if (binding.session.sessionId === "failed") throw failure;
    return lifecycleOwner(binding.session.sessionId, events);
  });
  const root = f.session("root", true), rootOwner = f.group.factory(root.binding);
  for (let index = 0; index < 126; index++) f.group.factory(f.session(`live-${index}`).binding);
  const failed = f.session("failed", false, true);
  expect(() => f.group.factory(failed.binding)).toThrow(failure);
  expect(failed.native.isDisposed).toBe(true);
  expect(() => f.group.factory(f.session("overflow").binding)).toThrow();
  failed.signalDrained(); await tick();
  f.group.factory(f.session("replacement").binding);
  await rootOwner.checkpoint(started);
  expect(f.events.at(-1)).toBe("request:root");
  const result = await f.group.finish().catch(error => error);
  expect(result.errors).toContain(failure);
  expect(f.events.filter(value => value.startsWith("whole-finish:"))).toEqual(["whole-finish:root"]);
});

test("duplicate exact bindings and retired callbacks cannot impersonate a revived same-id object", async () => {
  const f = await fixture();
  f.group.factory(f.session("root", true).binding);
  const original = f.session("revived"), originalOwner = f.group.factory(original.binding);
  expect(() => f.group.factory(original.binding)).toThrow();
  original.close(); await tick();
  expect(() => f.group.factory(original.binding)).toThrow();
  const replacement = f.session("revived"), replacementOwner = f.group.factory(replacement.binding);
  await expect(originalOwner.checkpoint(started)).rejects.toThrow();
  await replacementOwner.checkpoint(started);
  expect(f.events.filter(value => value === "request:revived")).toHaveLength(1);
  expect(f.events.filter(value => value === "retire:revived")).toHaveLength(1);
  await f.group.finish();
  expect(f.events.filter(value => value === "retire:revived")).toHaveLength(2);
});

test("a terminal registration replay never creates an owner or loses its reserved capacity", async () => {
  const f = await fixture();
  f.group.factory(f.session("root", true).binding);
  const stale = f.session("already-drained"); stale.close();
  expect(() => f.group.factory(stale.binding)).toThrow();
  await tick();
  for (let index = 0; index < 127; index++) f.group.factory(f.session(`live-${index}`).binding);
  expect(f.events).not.toContain("local-close:already-drained");
  expect(f.events).not.toContain("retire:already-drained");
  expect(() => f.group.factory(f.session("overflow").binding)).toThrow();
  await expect(f.group.finish()).rejects.toThrow();
  expect(f.events.filter(value => value === "whole-finish:root")).toHaveLength(1);
});

test("synchronous factory reentry reserves root identity and creating capacity before outward work", async () => {
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture((binding, events) => {
    if (binding.session.sessionId === "root") {
      for (let index = 0; index < 127; index++) f.group.factory(f.session(`nested-${index}`).binding);
      expect(() => f.group.factory(f.session("overflow").binding)).toThrow();
    }
    return lifecycleOwner(binding.session.sessionId, events);
  });
  const rootOwner = f.group.factory(f.session("root", true).binding);
  await rootOwner.checkpoint(started);
  expect(f.events.at(-1)).toBe("request:root");
  await f.group.finish();
  expect(f.events.filter(value => value.startsWith("retire:"))).toHaveLength(127);
  expect(f.events.filter(value => value.startsWith("whole-finish:"))).toEqual(["whole-finish:root"]);
});

test("throwing lifecycle registration joins exact native drain and retains the original error", async () => {
  const f = await fixture();
  f.group.factory(f.session("root", true).binding);
  const child = f.session("registration-failed", false, true), failure = new Error("controlled registration failure");
  const broken = { ...child.binding, registerLifecycle() { throw failure; } };
  expect(() => f.group.factory(broken)).toThrow(failure);
  expect(child.native.isDisposed).toBe(true);
  const finishing = f.group.finish(); await tick();
  expect(f.events).not.toContain("whole-finish:root");
  child.signalDrained();
  const result = await finishing.catch(error => error);
  expect(result.errors).toContain(failure);
  expect(f.events.filter(value => value.startsWith("whole-finish:"))).toEqual(["whole-finish:root"]);
});

test("policy callback rejection reaches its caller without inventing a lifecycle cleanup failure", async () => {
  const refused = new Error("controlled policy authority refusal");
  const f = await fixture((binding, events) => ({
    ...lifecycleOwner(binding.session.sessionId, events),
    async checkpoint() { throw refused; },
  }));
  const rootOwner = f.group.factory(f.session("root", true).binding);
  await expect(rootOwner.checkpoint(started)).rejects.toBe(refused);
  await f.group.finish();
  expect(f.events.filter(value => value === "whole-finish:root")).toHaveLength(1);
});
