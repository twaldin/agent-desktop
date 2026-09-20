import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  CodexResetPolicyOwner,
  CodexResetPolicyOwnerFactory,
  CodexResetPolicySessionBinding,
  CreateAgentSessionOptions,
} from "@oh-my-pi/pi-coding-agent";
import {
  AgentRegistry,
  createAgentSession,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
  Settings,
} from "@oh-my-pi/pi-coding-agent";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Binding = Parameters<NonNullable<CreateAgentSessionOptions["codexResetPolicyOwnerFactory"]>>[0];
const exactBinding: Equal<Binding, Readonly<CodexResetPolicySessionBinding>> = true;
const factorySignature: CodexResetPolicyOwnerFactory = binding => { void binding.session; return owner(); };
const exactBinder: Equal<AgentSession["bindCodexResetPolicyOwner"], (owner: CodexResetPolicyOwner, factory: CodexResetPolicyOwnerFactory) => void> = true;
// @ts-expect-error A reset-policy owner factory is synchronous.
const invalidAsyncFactory: CodexResetPolicyOwnerFactory = async () => owner();
// @ts-expect-error A partial object cannot be assigned as the durable owner.
const invalidOwnerFactory: CodexResetPolicyOwnerFactory = () => ({ checkpoint: async () => {} });
void [exactBinding, factorySignature, exactBinder, invalidAsyncFactory, invalidOwnerFactory];

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

const owner = () => ({
  checkpoint: async () => {},
  presentDecision: async () => {},
  admit: async () => ({ kind: "denied" as const, reason: "controlled fixture" }),
  complete: async () => {},
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "reset-owner-factory-")); roots.push(root);
  const cwd = join(root, "project"), agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const settings = await Settings.loadReadOnly({ cwd, agentDir });
  const authStorage = await discoverAuthStorage(agentDir);
  const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.yml"), { settings });
  const agentRegistry = new AgentRegistry();
  const base = {
    cwd, agentDir, settings, authStorage, modelRegistry, agentRegistry,
    sessionManager: SessionManager.inMemory(cwd), disableExtensionDiscovery: true,
    enableMCP: false, enableIrc: false, enableLsp: false, toolNames: [], hasUI: false,
  };
  return { ...base, cleanup: () => authStorage.close() };
}

describe("original-session reset-policy owner factory", () => {
  test("binds exactly once to the exact original live objects before returning", async () => {
    const f = await fixture(); let calls = 0; let binding: any; const createdOwner = owner();
    const factory = (value: any) => {
      calls++; binding = value; expect(Object.isFrozen(value)).toBe(true);
      expect(f.agentRegistry.list()).toHaveLength(1); expect(f.agentRegistry.list()[0]?.session).toBeNull();
      return createdOwner;
    };
    const { session } = await createAgentSession({ ...f, codexResetPolicyOwnerFactory: factory });
    try {
      expect(calls).toBe(1); expect(binding.session).toBe(session); expect(binding.settings).toBe(f.settings);
      expect(binding.modelRegistry).toBe(f.modelRegistry); expect(binding.authStorage).toBe(f.authStorage);
      expect(session.codexResetPolicyOwner).toBe(createdOwner); expect(session.codexResetPolicyOwnerFactory).toBe(factory);
      expect(() => session.bindCodexResetPolicyOwner(owner(), factory)).toThrow(/already bound/);
    } finally { await session.dispose(); f.cleanup(); }
  });

  test("preserves ownerless and direct-owner session behavior", async () => {
    const f = await fixture(); const direct = owner();
    const ownerless = await createAgentSession({ ...f, sessionManager: SessionManager.inMemory(f.cwd), agentId: "factory-ownerless" });
    const owned = await createAgentSession({ ...f, sessionManager: SessionManager.inMemory(f.cwd), agentId: "factory-direct", codexResetPolicyOwner: direct });
    try {
      expect(ownerless.session.codexResetPolicyOwner).toBeUndefined(); expect(ownerless.session.codexResetPolicyOwnerFactory).toBeUndefined();
      expect(owned.session.codexResetPolicyOwner).toBe(direct); expect(owned.session.codexResetPolicyOwnerFactory).toBeUndefined();
    } finally { await Promise.all([ownerless.session.dispose(), owned.session.dispose()]); f.cleanup(); }
  });

  test("rejects direct owner plus factory before invoking the factory", async () => {
    const f = await fixture(); let calls = 0;
    await expect(createAgentSession({ ...f, codexResetPolicyOwner: owner(), codexResetPolicyOwnerFactory: () => { calls++; return owner(); } })).rejects.toThrow(/either/);
    expect(calls).toBe(0); expect(f.agentRegistry.list()).toHaveLength(0); f.cleanup();
  });

  test("factory throw disposes the constructed session and unregisters it", async () => {
    const f = await fixture(); let captured: any;
    await expect(createAgentSession({ ...f, codexResetPolicyOwnerFactory: binding => { captured = binding.session; throw new Error("controlled factory failure"); } })).rejects.toThrow("controlled factory failure");
    expect(captured?.isDisposed).toBe(true); expect(f.agentRegistry.list()).toHaveLength(0); f.cleanup();
  });

  test("malformed owner is rejected through the same SDK cleanup path", async () => {
    const f = await fixture(); let captured: any;
    await expect(createAgentSession({ ...f, codexResetPolicyOwnerFactory: binding => { captured = binding.session; return {} as any; } })).rejects.toThrow(/checkpoint/);
    expect(captured?.isDisposed).toBe(true); expect(f.agentRegistry.list()).toHaveLength(0); f.cleanup();
  });

  test("Promise factory is rejected synchronously and its later rejection is observed", async () => {
    const f = await fixture(); let captured: any; let unhandled = false;
    const listener = () => { unhandled = true; }; process.on("unhandledRejection", listener);
    try {
      await expect(createAgentSession({ ...f, codexResetPolicyOwnerFactory: ((binding: any) => { captured = binding.session; return Promise.reject(new Error("controlled async rejection")); }) as any })).rejects.toThrow(/synchronously/);
      await Bun.sleep(0); expect(unhandled).toBe(false); expect(captured?.isDisposed).toBe(true); expect(f.agentRegistry.list()).toHaveLength(0);
    } finally { process.off("unhandledRejection", listener); f.cleanup(); }
  });

  test("two cold children bind distinct owners and one revived child binds a new instance", async () => {
    AgentRegistry.resetGlobalForTests();
    const f = await fixture(); const globalRegistry = AgentRegistry.global(); const bindings: any[] = [], owners: any[] = [];
    const factory = (binding: any) => { bindings.push(binding); const value = owner(); owners.push(value); return value; };
    const parent = await createAgentSession({ ...f, sessionManager: SessionManager.inMemory(f.cwd), agentId: "factory-parent", codexResetPolicyOwnerFactory: factory });
    const { AgentLifecycleManager } = await import("@oh-my-pi/pi-coding-agent/registry/agent-lifecycle");
    const { createPersistedSubagentReviverFactory } = await import("@oh-my-pi/pi-coding-agent/task/persisted-revive");
    const lifecycle = new AgentLifecycleManager(globalRegistry);
    lifecycle.setPersistedSubagentReviverFactory(createPersistedSubagentReviverFactory({ session: parent.session, authStorage: f.authStorage, modelRegistry: f.modelRegistry, settings: f.settings, enableLsp: false, codexResetPolicyOwnerFactory: factory }), 0);
    const child = async (id: string) => {
      const manager = SessionManager.create(f.cwd, join(f.cwd, id));
      manager.appendSessionInit({ systemPrompt: `controlled ${id}`, task: "no provider", tools: [], restrictToolNames: true, spawns: "" });
      await manager.ensureOnDisk(); await manager.flush(); const sessionFile = manager.getSessionFile()!; await manager.close();
      globalRegistry.register({ id, displayName: id, kind: "sub", parentId: "Main", session: null, sessionFile, status: "parked" });
      return lifecycle.ensureLive(id);
    };
    let first: any, second: any, revived: any;
    try {
      first = await child("factory-child-a"); second = await child("factory-child-b");
      expect(bindings.map(item => item.session)).toEqual([parent.session, first, second]); expect(owners[1]).not.toBe(owners[2]);
      await lifecycle.park("factory-child-a"); revived = await lifecycle.ensureLive("factory-child-a");
      expect(revived).not.toBe(first); expect(bindings[3].session).toBe(revived); expect(owners[3]).not.toBe(owners[1]);
    } finally {
      await lifecycle.dispose(); await parent.session.dispose(); AgentRegistry.resetGlobalForTests(); f.cleanup();
    }
  });

  test("two actual sessions get distinct owners from the same inherited factory", async () => {
    const f = await fixture(); const sessions: any[] = []; const owners: any[] = [];
    const factory = (binding: any) => { sessions.push(binding.session); const value = owner(); owners.push(value); return value; };
    const first = await createAgentSession({ ...f, sessionManager: SessionManager.inMemory(f.cwd), agentId: "factory-a", codexResetPolicyOwnerFactory: factory });
    const second = await createAgentSession({ ...f, sessionManager: SessionManager.inMemory(f.cwd), agentId: "factory-b", codexResetPolicyOwnerFactory: factory });
    try { expect(sessions).toEqual([first.session, second.session]); expect(owners[0]).not.toBe(owners[1]); expect(first.session.codexResetPolicyOwner).toBe(owners[0]); expect(second.session.codexResetPolicyOwner).toBe(owners[1]); }
    finally { await Promise.all([first.session.dispose(), second.session.dispose()]); f.cleanup(); }
  });
});
