import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AgentRegistry,
  createAgentSession,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
  Settings,
} from "@oh-my-pi/pi-coding-agent";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "reset-writer-propagation-")); roots.push(root);
  const cwd = join(root, "project"), agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  await writeFile(join(agentDir, "config.yml"), "{}\n");
  const settings = await Settings.loadReadOnly({ cwd, agentDir, overrides: {
    "codexResets.keepCredits": 7,
    "codexResets.salvageHorizonHours": 19,
  }});
  const writer = await settings.enableResetPolicyPersistence();
  const authStorage = await discoverAuthStorage(agentDir);
  const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.yml"), { settings });
  return { root, cwd, agentDir, settings, writer, authStorage, modelRegistry };
}

describe("reset-policy writer child propagation", () => {
  test("shared task/vibe child-settings constructor preserves effective overrides and borrows the exact writer", async () => {
    const f = await fixture();
    try {
      const child = createSubagentSettings(f.settings, { "codexResets.minBlockedMinutes": 23 });
      expect(child.getResetPolicySettingsWriter()).toBe(f.writer);
      expect(child.get("codexResets.keepCredits")).toBe(7);
      expect(child.get("codexResets.salvageHorizonHours")).toBe(19);
      expect(child.get("codexResets.minBlockedMinutes")).toBe(23);
      child.set("codexResets.autoRedeem", "yes"); await child.flush();
      expect(await readFile(join(f.agentDir, "config.yml"), "utf8")).toContain('autoRedeem: "yes"');
      child.set("codexResets.keepCredits", 11); await child.flush();
      expect(f.settings.getResetPolicySettingsWriter()).toBe(f.writer);
      expect(await readFile(join(f.agentDir, "config.yml"), "utf8")).toContain("keepCredits: 11");
    } finally { f.authStorage.close(); }
  });

  test("actual child cleanup does not dispose the borrowed writer", async () => {
    const f = await fixture(); const childSettings = createSubagentSettings(f.settings);
    const { session } = await createAgentSession({ cwd: f.cwd, agentDir: f.agentDir, settings: childSettings,
      authStorage: f.authStorage, modelRegistry: f.modelRegistry, sessionManager: SessionManager.inMemory(f.cwd),
      agentId: "writer-child", disableExtensionDiscovery: true, enableMCP: false, enableIrc: false,
      enableLsp: false, toolNames: [], hasUI: false });
    await session.dispose();
    try {
      expect(f.settings.getResetPolicySettingsWriter()).toBe(f.writer);
      f.settings.set("codexResets.autoRedeem", "no"); await f.settings.flush();
      expect(await readFile(join(f.agentDir, "config.yml"), "utf8")).toContain('autoRedeem: "no"');
    } finally { f.authStorage.close(); }
  });

  test("cold revival rebuilds child settings with the same borrowed writer", async () => {
    AgentRegistry.resetGlobalForTests(); const f = await fixture(); const registry = AgentRegistry.global();
    const parent = await createAgentSession({ cwd: f.cwd, agentDir: f.agentDir, settings: f.settings,
      authStorage: f.authStorage, modelRegistry: f.modelRegistry, agentRegistry: registry,
      sessionManager: SessionManager.inMemory(f.cwd), agentId: "writer-parent", disableExtensionDiscovery: true,
      enableMCP: false, enableIrc: false, enableLsp: false, toolNames: [], hasUI: false });
    const { AgentLifecycleManager } = await import("@oh-my-pi/pi-coding-agent/registry/agent-lifecycle");
    const { createPersistedSubagentReviverFactory } = await import("@oh-my-pi/pi-coding-agent/task/persisted-revive");
    const lifecycle = new AgentLifecycleManager(registry);
    lifecycle.setPersistedSubagentReviverFactory(createPersistedSubagentReviverFactory({ session: parent.session,
      authStorage: f.authStorage, modelRegistry: f.modelRegistry, settings: f.settings, enableLsp: false }), 0);
    const manager = SessionManager.create(f.cwd, join(f.cwd, "cold"));
    manager.appendSessionInit({ systemPrompt: "controlled", task: "no provider", tools: [], restrictToolNames: true, spawns: "" });
    await manager.ensureOnDisk(); await manager.flush(); const sessionFile = manager.getSessionFile()!; await manager.close();
    registry.register({ id: "writer-cold", displayName: "writer-cold", kind: "sub", parentId: "Main", session: null, sessionFile, status: "parked" });
    try {
      const child = await lifecycle.ensureLive("writer-cold");
      expect(child.settings.getResetPolicySettingsWriter()).toBe(f.writer);
      expect(child.settings.get("codexResets.keepCredits")).toBe(7);
      await lifecycle.park("writer-cold");
      expect(f.settings.getResetPolicySettingsWriter()).toBe(f.writer);
    } finally { await lifecycle.dispose(); await parent.session.dispose(); AgentRegistry.resetGlobalForTests(); f.authStorage.close(); }
  });
});
