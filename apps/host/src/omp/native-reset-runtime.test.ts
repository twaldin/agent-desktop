import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexResetPolicySessionBinding } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry, Settings, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { OmpRuntime } from "./runtime";
import { NativeResetRuntimeOwners, type NativeResetRuntimeOwner } from "./native-reset-runtime";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const owner = (events: string[], label: string, finish?: () => void): NativeResetRuntimeOwner => ({
  checkpoint: async () => {}, presentDecision: async () => {}, admit: async () => ({ kind: "hold", reason: "owner-unavailable" }), complete: async () => {},
  beginClose: () => { events.push(`begin:${label}`); }, finish: async () => { events.push(`finish:${label}`); finish?.(); },
});

async function dirs(name: string) {
  const root = await mkdtemp(join(tmpdir(), name)); roots.push(root);
  const agentDir = join(root, "agent"), cwd = join(root, "project"); await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  return { root, agentDir, cwd };
}

test("actual OmpRuntime installs the synchronous root factory after enabling its writer and finishes after native disposal", async () => {
  const f = await dirs("reset-runtime-");
  await writeFile(join(f.agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("../omp-workers/fixtures/ask-provider.ts", import.meta.url)))}\nretry:\n  enabled: false\n`);
  const events: string[] = []; let binding!: Readonly<CodexResetPolicySessionBinding>, unavailable = false;
  const runtime = new OmpRuntime({ agentDir: f.agentDir, createResetPolicyOwner: (value, interactions) => {
    binding = value; expect(value.settings.getResetPolicySettingsWriter()).not.toBeNull();
    try { void interactions.runWithDecisionBinding(async () => {}, async () => "Yes" as const); } catch (error) { unavailable = /unavailable/.test(String(error)); }
    return owner(events, "root", () => expect(value.session.isDisposed).toBe(true));
  } });
  try {
    const session = await runtime.create({ cwd: f.cwd, model: { provider: "ask-contract", id: "controlled" }, interactions: true });
    expect(binding.session.sessionId).toBe(session.id); expect(unavailable).toBe(true);
    await session.dispose(); expect(events).toEqual(["begin:root", "finish:root"]); expect(binding.settings.getResetPolicySettingsWriter()).toBeNull();
  } finally { await runtime.dispose(); }
}, 30_000);

test("all sibling owners begin close before any channel-owning finish and child lineage uses the borrowed writer", async () => {
  const f = await dirs("reset-runtime-group-"); await writeFile(join(f.agentDir, "config.yml"), "codexResets:\n  autoRedeem: unset\n");
  const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd }), writer = await settings.enableResetPolicyPersistence();
  const childSettings = Settings.isolated({}, { resetPolicyWriter: writer });
  const auth = await discoverAuthStorage(f.agentDir), registry = new ModelRegistry(auth, join(f.agentDir, "models.yml"), { settings });
  const fake = (ownedSettings: Settings) => ({ settings: ownedSettings, modelRegistry: registry, sessionId: "controlled" }) as any;
  const events: string[] = [], group = new NativeResetRuntimeOwners({ settings, modelRegistry: registry, authStorage: auth, writer }, () => undefined,
    binding => owner(events, binding.settings === settings ? "root" : "child", () => expect(events.filter(item => item.startsWith("begin:"))).toHaveLength(2)));
  group.factory({ session: fake(settings), settings, modelRegistry: registry, authStorage: auth });
  group.factory({ session: fake(childSettings), settings: childSettings, modelRegistry: registry, authStorage: auth });
  group.beginClose(); await group.finish();
  expect(events).toEqual(["begin:root", "begin:child", "finish:root", "finish:child"]);
  childSettings.cancelPendingSaves(); settings.disableResetPolicyPersistence(); auth.close();
});

test("finish waits a held native callback and a synchronous finish throw cannot skip siblings", async () => {
  const f = await dirs("reset-runtime-held-"); await writeFile(join(f.agentDir, "config.yml"), "codexResets:\n  autoRedeem: unset\n");
  const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd }), writer = await settings.enableResetPolicyPersistence();
  const childSettings = Settings.isolated({}, { resetPolicyWriter: writer });
  const auth = await discoverAuthStorage(f.agentDir), registry = new ModelRegistry(auth, join(f.agentDir, "models.yml"), { settings });
  const fake = (owned: Settings) => ({ settings: owned, modelRegistry: registry, sessionId: "controlled" }) as any;
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); const events: string[] = [];
  const group = new NativeResetRuntimeOwners({ settings, modelRegistry: registry, authStorage: auth, writer }, () => undefined, binding => {
    const label = binding.settings === settings ? "root" : "child";
    const value = owner(events, label); if (label === "root") {
      value.checkpoint = async () => { events.push("callback:root"); await held; events.push("callback-done:root"); };
      value.finish = (() => { events.push("finish:root"); throw new Error("controlled synchronous finish"); }) as () => Promise<void>;
    }
    return value;
  });
  const rootOwner = group.factory({ session: fake(settings), settings, modelRegistry: registry, authStorage: auth });
  group.factory({ session: fake(childSettings), settings: childSettings, modelRegistry: registry, authStorage: auth });
  const callback = rootOwner.checkpoint({ phase: "started", pass: {} as never }); await Promise.resolve();
  group.beginClose(); const finishing = group.finish(); await Promise.resolve();
  expect(events).not.toContain("finish:root"); expect(events).not.toContain("finish:child"); release(); await callback;
  await expect(finishing).rejects.toThrow(/finish cleanly/);
  expect(events).toContain("finish:root"); expect(events).toContain("finish:child");
  childSettings.cancelPendingSaves(); settings.disableResetPolicyPersistence(); auth.close();
});

test("factory reentrant close cleans the returned owner and cannot move the reserved root binding", async () => {
  const f = await dirs("reset-runtime-reentrant-create-"); await writeFile(join(f.agentDir, "config.yml"), "codexResets:\n  autoRedeem: unset\n");
  const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd }), writer = await settings.enableResetPolicyPersistence();
  const auth = await discoverAuthStorage(f.agentDir), registry = new ModelRegistry(auth, join(f.agentDir, "models.yml"), { settings });
  const fake = { settings, modelRegistry: registry, sessionId: "controlled" } as any; const events: string[] = [];
  let group!: NativeResetRuntimeOwners;
  group = new NativeResetRuntimeOwners({ settings, modelRegistry: registry, authStorage: auth, writer }, () => undefined, () => { group.beginClose(); return owner(events, "reentrant"); });
  expect(() => group.factory({ session: fake, settings, modelRegistry: registry, authStorage: auth })).toThrow(/closed during factory/);
  await group.finish(); expect(events).toEqual(["begin:reentrant", "finish:reentrant"]);
  expect(() => group.factory({ session: fake, settings, modelRegistry: registry, authStorage: auth })).toThrow(/unavailable/);
  settings.disableResetPolicyPersistence(); auth.close();
});

test("finish publishes its promise before an owner synchronously reenters", async () => {
  const f = await dirs("reset-runtime-reentrant-finish-"); await writeFile(join(f.agentDir, "config.yml"), "codexResets:\n  autoRedeem: unset\n");
  const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd }), writer = await settings.enableResetPolicyPersistence();
  const auth = await discoverAuthStorage(f.agentDir), registry = new ModelRegistry(auth, join(f.agentDir, "models.yml"), { settings });
  const fake = { settings, modelRegistry: registry, sessionId: "controlled" } as any; let reentered: Promise<void> | undefined;
  let group!: NativeResetRuntimeOwners;
  group = new NativeResetRuntimeOwners({ settings, modelRegistry: registry, authStorage: auth, writer }, () => undefined, () => ({ ...owner([], "root"), finish: async () => { reentered = group.finish(); } }));
  group.factory({ session: fake, settings, modelRegistry: registry, authStorage: auth }); group.beginClose();
  const finishing = group.finish(); await finishing; expect(reentered).toBe(finishing);
  settings.disableResetPolicyPersistence(); auth.close();
});

test("actual OmpRuntime waits a held native-owner callback and still finishes after teardown error", async () => {
  const f = await dirs("reset-runtime-held-actual-");
  await writeFile(join(f.agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("../omp-workers/fixtures/ask-provider.ts", import.meta.url)))}\nretry:\n  enabled: false\n`);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let binding!: Readonly<CodexResetPolicySessionBinding>; const events: string[] = [];
  const runtime = new OmpRuntime({ agentDir: f.agentDir, createResetPolicyOwner: value => {
    binding = value; const valueOwner = owner(events, "root");
    valueOwner.checkpoint = async () => { events.push("callback"); await held; events.push("callback-done"); };
    valueOwner.beginClose = () => { events.push("begin:root"); throw new Error("controlled owner teardown failure"); };
    return valueOwner;
  } });
  try {
    const session = await runtime.create({ cwd: f.cwd, model: { provider: "ask-contract", id: "controlled" }, interactions: true });
    const callback = binding.session.codexResetPolicyOwner!.checkpoint({ phase: "started", pass: {} as never }); await Promise.resolve();
    const disposal = session.dispose(); await Promise.resolve(); expect(events).not.toContain("finish:root");
    release(); await callback; await expect(disposal).rejects.toThrow(/cleanup failed/);
    expect(events).toEqual(["callback", "begin:root", "callback-done", "finish:root"]);
  } finally { await runtime.dispose().catch(() => {}); }
}, 30_000);


test("callbacks invoked after terminal finish reject without reaching the owner", async () => {
  const f = await dirs("reset-runtime-late-callback-"); await writeFile(join(f.agentDir, "config.yml"), `codexResets:\n  autoRedeem: unset\n`);
  const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd }), writer = await settings.enableResetPolicyPersistence();
  const auth = await discoverAuthStorage(f.agentDir), registry = new ModelRegistry(auth, join(f.agentDir, "models.yml"), { settings });
  const fake = { settings, modelRegistry: registry, sessionId: "controlled" } as any; let calls = 0;
  const group = new NativeResetRuntimeOwners({ settings, modelRegistry: registry, authStorage: auth, writer }, () => undefined, () => {
    const value = owner([], "root"); value.checkpoint = async () => { calls++; }; return value;
  });
  const exposed = group.factory({ session: fake, settings, modelRegistry: registry, authStorage: auth }); group.beginClose(); await group.finish();
  await expect(exposed.checkpoint({ phase: "started", pass: {} as never })).rejects.toThrow(/finishing/); expect(calls).toBe(0);
  settings.disableResetPolicyPersistence(); auth.close();
});

test("reentrant factory cleanup retains a raw undefined begin-close throw", async () => {
  const f = await dirs("reset-runtime-undefined-"); await writeFile(join(f.agentDir, "config.yml"), `codexResets:\n  autoRedeem: unset\n`);
  const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd }), writer = await settings.enableResetPolicyPersistence();
  const auth = await discoverAuthStorage(f.agentDir), registry = new ModelRegistry(auth, join(f.agentDir, "models.yml"), { settings });
  const fake = { settings, modelRegistry: registry, sessionId: "controlled" } as any; let finished = 0;
  let group!: NativeResetRuntimeOwners;
  group = new NativeResetRuntimeOwners({ settings, modelRegistry: registry, authStorage: auth, writer }, () => undefined, () => {
    group.beginClose(); const value = owner([], "root", () => { finished++; }); value.beginClose = () => { throw undefined; }; return value;
  });
  expect(() => group.factory({ session: fake, settings, modelRegistry: registry, authStorage: auth })).toThrow(/closed during factory/);
  await expect(group.finish()).rejects.toThrow(/finish cleanly/); expect(finished).toBe(1);
  settings.disableResetPolicyPersistence(); auth.close();
});
