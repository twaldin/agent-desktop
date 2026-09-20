import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentSession,
  CodexResetPolicyOwner,
  CodexResetPolicySessionBinding,
  CodexResetPolicySessionLifecycleListener,
  CreateAgentSessionOptions,
} from "@oh-my-pi/pi-coding-agent";
import {
  AgentRegistry,
  createAgentSession,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
  Settings,
  logger,
} from "@oh-my-pi/pi-coding-agent";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type FactoryBinding = Parameters<NonNullable<CreateAgentSessionOptions["codexResetPolicyOwnerFactory"]>>[0];
const exactBinding: Equal<FactoryBinding, Readonly<CodexResetPolicySessionBinding>> = true;
const listener: CodexResetPolicySessionLifecycleListener = { beginClose() {}, drained() {} };
void [exactBinding, listener];

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

function gate<T>() {
  return Promise.withResolvers<T>();
}

function owner(checkpoint: CodexResetPolicyOwner["checkpoint"] = async () => {}): CodexResetPolicyOwner {
  return {
    checkpoint,
    presentDecision: async () => {},
    admit: async () => ({ kind: "denied", reason: "controlled lifecycle fixture" }),
    complete: async () => {},
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "reset-policy-session-lifecycle-")); roots.push(root);
  const cwd = join(root, "project"), agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const settings = await Settings.loadReadOnly({ cwd, agentDir });
  const authStorage = await discoverAuthStorage(agentDir);
  const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.yml"), { settings });
  const base = {
    cwd, agentDir, settings, authStorage, modelRegistry,
    sessionManager: SessionManager.inMemory(cwd), disableExtensionDiscovery: true,
    enableMCP: false, enableIrc: false, enableLsp: false, toolNames: [], hasUI: false,
  };
  return { ...base, cleanup: () => authStorage.close() };
}

function observe(binding: Readonly<CodexResetPolicySessionBinding>, events: string[]) {
  return binding.registerLifecycle({
    beginClose() { events.push("beginClose"); },
    drained() { events.push("drained"); },
  });
}

describe("exact-session reset-policy lifecycle", () => {
  test("publishes synchronous close once and terminal drain once", async () => {
    const f = await fixture(); const events: string[] = [];
    const created = await createAgentSession({ ...f, codexResetPolicyOwnerFactory: binding => {
      expect(Object.isFrozen(binding)).toBe(true); observe(binding, events); return owner();
    } });
    created.session.beginDispose();
    expect(events).toEqual(["beginClose"]);
    created.session.beginDispose();
    await created.session.drainCodexResetPolicy(); await Bun.sleep(0);
    expect(events).toEqual(["beginClose", "drained"]);
    await created.session.dispose(); f.cleanup();
  });

  test("does not report drained across held report IO or the awaited finished checkpoint", async () => {
    const f = await fixture(); const events: string[] = [];
    const report = gate<null>(); const finish = gate<void>(); const started = gate<void>(); const reachedFinish = gate<void>();
    f.authStorage.fetchUsageReports = (() => report.promise) as typeof f.authStorage.fetchUsageReports;
    const created = await createAgentSession({ ...f, codexResetPolicyOwnerFactory: binding => {
      observe(binding, events);
      return owner(async event => {
        events.push(event.phase);
        if (event.phase === "started") started.resolve();
        if (event.phase === "finished") { reachedFinish.resolve(); await finish.promise; }
      });
    } });
    const fetched = created.session.fetchUsageReports();
    await started.promise;
    created.session.beginDispose();
    expect(events).toEqual(["started", "beginClose"]);
    report.resolve(null); await reachedFinish.promise;
    expect(events).toEqual(["started", "beginClose", "finished"]);
    finish.resolve(); await fetched; await created.session.drainCodexResetPolicy(); await Bun.sleep(0);
    expect(events).toEqual(["started", "beginClose", "finished", "drained"]);
    await created.session.dispose(); f.cleanup();
  });

  test("synchronous close can release an owner barrier that the terminal drain awaits", async () => {
    const f = await fixture(); const events: string[] = [];
    const held = gate<void>(); const started = gate<void>();
    f.authStorage.fetchUsageReports = (async () => null) as typeof f.authStorage.fetchUsageReports;
    const created = await createAgentSession({ ...f, codexResetPolicyOwnerFactory: binding => {
      binding.registerLifecycle({ beginClose() { events.push("beginClose"); held.resolve(); }, drained() { events.push("drained"); } });
      return owner(async event => {
        events.push(event.phase);
        if (event.phase === "started") { started.resolve(); await held.promise; }
      });
    } });
    const fetched = created.session.fetchUsageReports(); await started.promise;
    created.session.beginDispose();
    expect(events.slice(0, 2)).toEqual(["started", "beginClose"]);
    await fetched; await created.session.drainCodexResetPolicy(); await Bun.sleep(0);
    expect(events.at(-1)).toBe("drained");
    await created.session.dispose(); f.cleanup();
  });

  test("factory setup failure still closes and drains its exact constructed session", async () => {
    const f = await fixture(); const events: string[] = []; let captured: AgentSession | undefined;
    await expect(createAgentSession({ ...f, codexResetPolicyOwnerFactory: binding => {
      captured = binding.session; observe(binding, events); return {} as CodexResetPolicyOwner;
    } })).rejects.toThrow(/checkpoint/);
    await Bun.sleep(0);
    expect(captured?.isDisposed).toBe(true);
    expect(events).toEqual(["beginClose", "drained"]);
    f.cleanup();
  });

  test("unsubscribe is identity-local and late registration replays terminal state", async () => {
    const f = await fixture(); const first: string[] = [], removed: string[] = [], late: string[] = [];
    let binding!: Readonly<CodexResetPolicySessionBinding>;
    const created = await createAgentSession({ ...f, codexResetPolicyOwnerFactory: value => {
      binding = value; observe(value, first); const unsubscribe = observe(value, removed); unsubscribe(); return owner();
    } });
    created.session.beginDispose(); await created.session.drainCodexResetPolicy(); await Bun.sleep(0);
    const unsubscribeLate = observe(binding, late); unsubscribeLate();
    expect(first).toEqual(["beginClose", "drained"]); expect(removed).toEqual([]);
    expect(late).toEqual(["beginClose", "drained"]);
    await created.session.dispose(); f.cleanup();
  });

  test("duplicate listener registrations unsubscribe independently", async () => {
    const f = await fixture(); const events: string[] = [];
    const shared = { beginClose() { events.push("beginClose"); }, drained() { events.push("drained"); } };
    let removeFirst!: () => void;
    const created = await createAgentSession({ ...f, codexResetPolicyOwnerFactory: binding => {
      removeFirst = binding.registerLifecycle(shared); binding.registerLifecycle(shared); return owner();
    } });
    removeFirst(); created.session.beginDispose(); await created.session.drainCodexResetPolicy(); await Bun.sleep(0);
    expect(events).toEqual(["beginClose", "drained"]);
    await created.session.dispose(); f.cleanup();
  });

  test("one listener can remove a later listener before its copied-snapshot turn", async () => {
    const f = await fixture(); const events: string[] = []; let removeLater!: () => void;
    const created = await createAgentSession({ ...f, codexResetPolicyOwnerFactory: binding => {
      binding.registerLifecycle({ beginClose() { events.push("first-close"); removeLater(); }, drained() { events.push("first-drained"); } });
      removeLater = binding.registerLifecycle({ beginClose: () => events.push("removed-close"), drained: () => events.push("removed-drained") });
      return owner();
    } });
    created.session.beginDispose(); await created.session.drainCodexResetPolicy(); await Bun.sleep(0);
    expect(events).toEqual(["first-close", "first-drained"]);
    await created.session.dispose(); f.cleanup();
  });

  test("captures callback identities at registration", async () => {
    const f = await fixture(); const events: string[] = [];
    const mutable = { beginClose() { events.push("original-close"); }, drained() { events.push("original-drained"); } };
    const created = await createAgentSession({ ...f, codexResetPolicyOwnerFactory: binding => { binding.registerLifecycle(mutable); return owner(); } });
    mutable.beginClose = () => events.push("replacement-close"); mutable.drained = () => events.push("replacement-drained");
    await created.session.dispose();
    expect(events).toEqual(["original-close", "original-drained"]);
    f.cleanup();
  });

  test("reentrant registration gets each reached phase once", async () => {
    const f = await fixture(); const events: string[] = []; let binding!: Readonly<CodexResetPolicySessionBinding>;
    const created = await createAgentSession({ ...f, codexResetPolicyOwnerFactory: value => {
      binding = value;
      value.registerLifecycle({
        beginClose() {
          events.push("outer-close");
          binding.registerLifecycle({ beginClose: () => events.push("inner-close"), drained: () => events.push("inner-drained") });
        },
        drained: () => events.push("outer-drained"),
      });
      return owner();
    } });
    created.session.beginDispose(); await created.session.drainCodexResetPolicy(); await Bun.sleep(0);
    binding.registerLifecycle({ beginClose: () => events.push("late-close"), drained: () => events.push("late-drained") });
    expect(events).toEqual(["outer-close", "inner-close", "outer-drained", "inner-drained", "late-close", "late-drained"]);
    await created.session.dispose(); f.cleanup();
  });

  test("throwing listeners do not skip siblings and disposal reports then completes", async () => {
    const f = await fixture(); const events: string[] = [];
    const warnings = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const created = await createAgentSession({ ...f, codexResetPolicyOwnerFactory: binding => {
        binding.registerLifecycle({ beginClose() { events.push("bad-close"); throw false; }, drained() { events.push("bad-drained"); throw undefined; } });
        binding.registerLifecycle({ beginClose: () => events.push("good-close"), drained: () => events.push("good-drained") });
        return owner();
      } });
      await created.session.dispose();
      expect(events).toEqual(["bad-close", "good-close", "bad-drained", "good-drained"]);
      expect(warnings.mock.calls.some(call => String(call[0]).includes("terminal lifecycle failed"))).toBe(true);
    } finally { warnings.mockRestore(); f.cleanup(); }
  });

  test("late replay reports throwing callbacks after terminal settlement", async () => {
    const f = await fixture(); let binding!: Readonly<CodexResetPolicySessionBinding>;
    const created = await createAgentSession({ ...f, codexResetPolicyOwnerFactory: value => { binding = value; return owner(); } });
    await created.session.dispose(); await Bun.sleep(0);
    const warnings = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      binding.registerLifecycle({ beginClose() { throw new Error("late close"); }, drained() { throw new Error("late drain"); } });
      expect(warnings.mock.calls.filter(call => String(call[0]).includes("Late Codex reset-policy lifecycle"))).toHaveLength(2);
    } finally { warnings.mockRestore(); f.cleanup(); }
  });

  test("parked and cold-revived children each publish their own terminal lifecycle", async () => {
    AgentRegistry.resetGlobalForTests();
    const f = await fixture(); const globalRegistry = AgentRegistry.global();
    const lifecycles = new Map<AgentSession, string[]>();
    const factory = (binding: Readonly<CodexResetPolicySessionBinding>) => {
      const events: string[] = []; lifecycles.set(binding.session, events); observe(binding, events); return owner();
    };
    const parent = await createAgentSession({ ...f, sessionManager: SessionManager.inMemory(f.cwd), agentId: "lifecycle-parent", codexResetPolicyOwnerFactory: factory });
    const { AgentLifecycleManager } = await import("@oh-my-pi/pi-coding-agent/registry/agent-lifecycle");
    const { createPersistedSubagentReviverFactory } = await import("@oh-my-pi/pi-coding-agent/task/persisted-revive");
    const lifecycle = new AgentLifecycleManager(globalRegistry);
    lifecycle.setPersistedSubagentReviverFactory(createPersistedSubagentReviverFactory({
      session: parent.session, authStorage: f.authStorage, modelRegistry: f.modelRegistry,
      settings: f.settings, enableLsp: false, codexResetPolicyOwnerFactory: factory,
    }), 0);
    const manager = SessionManager.create(f.cwd, join(f.cwd, "lifecycle-child"));
    manager.appendSessionInit({ systemPrompt: "controlled lifecycle child", task: "no provider", tools: [], restrictToolNames: true, spawns: "" });
    await manager.ensureOnDisk(); await manager.flush(); const sessionFile = manager.getSessionFile()!; await manager.close();
    globalRegistry.register({ id: "lifecycle-child", displayName: "lifecycle-child", kind: "sub", parentId: "Main", session: null, sessionFile, status: "parked" });
    let first: AgentSession | undefined, revived: AgentSession | undefined;
    try {
      first = await lifecycle.ensureLive("lifecycle-child"); await lifecycle.park("lifecycle-child");
      expect(lifecycles.get(first)).toEqual(["beginClose", "drained"]);
      revived = await lifecycle.ensureLive("lifecycle-child"); expect(revived).not.toBe(first);
      expect(lifecycles.get(revived)).toEqual([]);
      await lifecycle.release("lifecycle-child"); expect(lifecycles.get(revived)).toEqual(["beginClose", "drained"]);
      expect(lifecycles.get(parent.session)).toEqual([]);
    } finally {
      await lifecycle.dispose(); await parent.session.dispose(); AgentRegistry.resetGlobalForTests(); f.cleanup();
    }
  });
});
