import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YAML } from "bun";
import { Settings, type ResetPolicySettingsWriter } from "@oh-my-pi/pi-coding-agent/config/settings";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(source = "theme: custom\nother:\n  retained: value\ncodexResets:\n  autoRedeem: no\n  minBlockedMinutes: 60\n  keepCredits: 2\n  salvageHorizonHours: 12\n") {
  const root = await mkdtemp(join(tmpdir(), "reset-settings-writer-")); roots.push(root);
  const agentDir = join(root, "agent"), cwd = join(root, "project");
  await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
  await writeFile(join(agentDir, "config.yml"), source);
  return { root, agentDir, cwd, config: join(agentDir, "config.yml") };
}

const paths = ["codexResets.autoRedeem", "codexResets.minBlockedMinutes", "codexResets.keepCredits", "codexResets.salvageHorizonHours"] as const;
const parse = async (file: string) => YAML.parse(await readFile(file, "utf8")) as Record<string, any>;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe("reset-policy Settings writer", () => {
  test("persists only reset settings from read-only Settings and reports exact layers separately", async () => {
    const f = await fixture();
    const overlay = join(f.root, "overlay.yml");
    await writeFile(overlay, "codexResets:\n  autoRedeem: no\n");
    const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd, configFiles: [overlay], overrides: { "codexResets.keepCredits": 9 } });
    const writer = await settings.enableResetPolicyPersistence();
    settings.set("codexResets.autoRedeem", "yes"); settings.set("codexResets.minBlockedMinutes", 180);
    await settings.flush();

    const saved = await parse(f.config);
    expect(saved).toMatchObject({ theme: "custom", other: { retained: "value" }, codexResets: { autoRedeem: "yes", minBlockedMinutes: 180, keepCredits: 2, salvageHorizonHours: 12 } });
    const capture = settings.capturePersistedReadback(paths), snapshot = await capture.read();
    expect(capture.writable).toBe(false);
    expect(capture.resetPolicyWriter).toEqual({ available: true, targetId: writer.targetId });
    expect(snapshot.global["codexResets.autoRedeem"]).toBe("yes");
    expect(snapshot.overlay["codexResets.autoRedeem"]).toBe("no");
    expect(snapshot.runtime["codexResets.keepCredits"]).toBe(9);
    expect(snapshot.effective).toMatchObject({ "codexResets.autoRedeem": "no", "codexResets.keepCredits": 9 });
    expect((await readdir(f.agentDir)).sort()).toEqual(["config.yml", "config.yml.lock"]);
    settings.disableResetPolicyPersistence();
  });

  test("shares one original target across two children while retaining all inherited overrides", async () => {
    const f = await fixture();
    const root = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
    const writer = await root.enableResetPolicyPersistence();
    const inherited = { "codexResets.autoRedeem": "no", "codexResets.minBlockedMinutes": 90, "codexResets.keepCredits": 4, "codexResets.salvageHorizonHours": 6 } as const;
    const first = Settings.isolated(inherited, { resetPolicyWriter: writer });
    const second = Settings.isolated(inherited, { resetPolicyWriter: writer });
    expect(paths.map(path => first.get(path))).toEqual(["no", 90, 4, 6]);
    expect(paths.map(path => second.get(path))).toEqual(["no", 90, 4, 6]);

    first.set("codexResets.autoRedeem", "yes");
    second.set("codexResets.keepCredits", 7);
    await Promise.all([first.flush(), second.flush()]);
    expect((await parse(f.config)).codexResets).toEqual({ autoRedeem: "yes", minBlockedMinutes: 60, keepCredits: 7, salvageHorizonHours: 12 });
    expect(first.get("codexResets.keepCredits")).toBe(4);
    expect(second.get("codexResets.autoRedeem")).toBe("no");
    root.disableResetPolicyPersistence();
  });

  test("reads the writer-bound global reset settings from a child without relabeling its own scope", async () => {
    const f = await fixture();
    const root = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
    const writer = await root.enableResetPolicyPersistence();
    root.set("codexResets.autoRedeem", "yes"); await root.flush();

    const child = Settings.isolated({ "codexResets.autoRedeem": "no", "codexResets.keepCredits": 9 }, { resetPolicyWriter: writer });
    child.set("codexResets.salvageHorizonHours", 24); await child.flush();
    const capture = child.capturePersistedReadback([...paths, "shellPath"]);
    const snapshot = await capture.read();

    expect(capture.agentDir).toBe(child.getAgentDir());
    expect(capture.agentDir).not.toBe(f.agentDir);
    expect(capture.resetPolicyWriter).toEqual({ available: true, targetId: writer.targetId });
    expect(snapshot.global).toMatchObject({
      "codexResets.autoRedeem": "yes",
      "codexResets.keepCredits": 2,
      "codexResets.salvageHorizonHours": 24,
    });
    expect(snapshot.global.shellPath).toBeUndefined();
    expect(snapshot.runtime).toMatchObject({ "codexResets.autoRedeem": "no", "codexResets.keepCredits": 9 });
    expect(snapshot.effective).toMatchObject({ "codexResets.autoRedeem": "no", "codexResets.keepCredits": 9 });
    root.disableResetPolicyPersistence();
  });

  test("keeps ordinary read-only and in-memory Settings non-persistent without a writer", async () => {
    const f = await fixture();
    const readOnly = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
    readOnly.set("codexResets.autoRedeem", "yes"); await readOnly.flush();
    const isolated = Settings.isolated({ "codexResets.keepCredits": 8 });
    isolated.set("codexResets.keepCredits", 9); await isolated.flush();
    expect((await parse(f.config)).codexResets).toMatchObject({ autoRedeem: "no", keepCredits: 2 });
    expect(readOnly.capturePersistedReadback(paths).resetPolicyWriter).toEqual({ available: false, targetId: null });
    expect(() => Settings.isolated({}, { resetPolicyWriter: { agentDir: f.agentDir, targetId: "forged" } as ResetPolicySettingsWriter })).toThrow("Invalid");
  });

  test("rejects a same-key conflict but merges disjoint external edits", async () => {
    const f = await fixture();
    const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
    await settings.enableResetPolicyPersistence();
    settings.set("codexResets.autoRedeem", "yes");
    await writeFile(f.config, "theme: external\nother:\n  retained: changed\ncodexResets:\n  autoRedeem: unset\n  minBlockedMinutes: 60\n  keepCredits: 2\n  salvageHorizonHours: 12\n");
    await expect(settings.flush()).rejects.toThrow("conflict: codexResets.autoRedeem");
    expect((await parse(f.config)).codexResets.autoRedeem).toBe("unset");
    expect(() => settings.disableResetPolicyPersistence()).toThrow("pending changes");
    const restored = await parse(f.config); restored.codexResets.autoRedeem = "no"; await writeFile(f.config, YAML.stringify(restored));
    await settings.flush();
    settings.disableResetPolicyPersistence();

    const disjoint = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
    await disjoint.enableResetPolicyPersistence();
    disjoint.set("codexResets.keepCredits", 5);
    const external = await parse(f.config); external.other.retained = "newer";
    await writeFile(f.config, YAML.stringify(external));
    await disjoint.flush();
    expect(await parse(f.config)).toMatchObject({ other: { retained: "newer" }, codexResets: { keepCredits: 5 } });
    disjoint.disableResetPolicyPersistence();
  });

  test("pins the original physical target and rejects a retargeted config symlink", async () => {
    const f = await fixture();
    const first = join(f.root, "first.yml"), second = join(f.root, "second.yml");
    await writeFile(first, await readFile(f.config)); await writeFile(second, "codexResets:\n  autoRedeem: unset\n");
    await unlink(f.config); await symlink(first, f.config);
    const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
    await settings.enableResetPolicyPersistence(); settings.set("codexResets.autoRedeem", "yes");
    await unlink(f.config); await symlink(second, f.config);
    await expect(settings.flush()).rejects.toThrow("target changed");
    expect((await parse(first)).codexResets.autoRedeem).toBe("no");
    expect((await parse(second)).codexResets.autoRedeem).toBe("unset");
    await unlink(f.config); await symlink(first, f.config); await settings.flush();
    settings.disableResetPolicyPersistence();
  });

  test("refuses child readback when the writer target is retargeted or unreadable", async () => {
    const f = await fixture();
    const first = join(f.root, "first.yml"), second = join(f.root, "second.yml");
    await writeFile(first, await readFile(f.config)); await writeFile(second, "codexResets:\n  autoRedeem: unset\n");
    await unlink(f.config); await symlink(first, f.config);
    const root = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
    const writer = await root.enableResetPolicyPersistence();
    const child = Settings.isolated({}, { resetPolicyWriter: writer });
    const capture = child.capturePersistedReadback(paths);

    await unlink(f.config); await symlink(second, f.config);
    await expect(capture.read()).rejects.toThrow("target changed");

    await unlink(f.config); await symlink(first, f.config);
    await unlink(first); await mkdir(first);
    await expect(capture.read()).rejects.toThrow("target is unreadable");
    root.disableResetPolicyPersistence();
  });

  test("uses the config.yaml target already selected by read-only loading", async () => {
    const f = await fixture(); const yamlTarget = join(f.agentDir, "config.yaml"); await rename(f.config, yamlTarget);
    const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
    await settings.enableResetPolicyPersistence(); settings.set("codexResets.autoRedeem", "yes"); await settings.flush();
    expect((await parse(yamlTarget)).codexResets.autoRedeem).toBe("yes");
    expect(await readdir(f.agentDir)).not.toContain("config.yml");
    settings.disableResetPolicyPersistence();
  });

  test("shares compatible root bindings and rejects a foreign logical binding to the same physical file", async () => {
    const f = await fixture();
    const first = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
    const second = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
    const firstWriter = await first.enableResetPolicyPersistence(), secondWriter = await second.enableResetPolicyPersistence();
    expect(secondWriter).toBe(firstWriter);
    second.set("codexResets.minBlockedMinutes", 240); await first.flush();
    expect((await parse(f.config)).codexResets.minBlockedMinutes).toBe(240);

    const foreignAgentDir = join(f.root, "foreign-agent"); await mkdir(foreignAgentDir);
    await symlink(f.config, join(foreignAgentDir, "config.yml"));
    const foreign = await Settings.loadReadOnly({ agentDir: foreignAgentDir, cwd: f.cwd });
    await expect(foreign.enableResetPolicyPersistence()).rejects.toThrow("incompatible writer binding");
    second.disableResetPolicyPersistence(); // A borrower cannot dispose the original writer.
    expect(first.getResetPolicySettingsWriter()).toBe(firstWriter);
    first.disableResetPolicyPersistence();
  });

  test("rejects an enable whose Settings scope changes while target capture is awaiting", async () => {
    const f = await fixture(); const moved = join(f.root, "moved"); await mkdir(moved);
    const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
    const enabling = settings.enableResetPolicyPersistence();
    await settings.reloadForCwd(moved);
    await expect(enabling).rejects.toThrow("scope changed while binding");
    expect(settings.getResetPolicySettingsWriter()).toBeNull();
  });

  test("retains write failures and refuses disposal while a flush is in flight", async () => {
    const f = await fixture();
    const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
    await settings.enableResetPolicyPersistence(); settings.set("codexResets.keepCredits", 11);
    await unlink(f.config); await mkdir(f.config);
    await expect(settings.flush()).rejects.toThrow("unreadable");
    await rm(f.config, { recursive: true }); await writeFile(f.config, "codexResets:\n  keepCredits: 2\n");

    const locked = deferred(), release = deferred();
    const blocker = withFileLock(f.config, async () => { locked.resolve(); await release.promise; });
    await locked.promise;
    const flushing = settings.flush(); await Promise.resolve();
    expect(() => settings.disableResetPolicyPersistence()).toThrow("in-flight flush");
    release.resolve(); await blocker; await flushing;
    expect((await parse(f.config)).codexResets.keepCredits).toBe(11);
    settings.disableResetPolicyPersistence();
  });

  test("retains a same-key edit made after the first write serialized", async () => {
    const f = await fixture();
    const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
    await settings.enableResetPolicyPersistence(); settings.set("codexResets.keepCredits", 5);
    const serialized = deferred(), release = deferred(), realOpen = fs.promises.open.bind(fs.promises);
    const open = spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await realOpen(...args);
      if (String(args[0]).includes("config.yml.") && args[1] === "wx") {
        const realWrite = handle.writeFile.bind(handle);
        handle.writeFile = async (...writeArgs: Parameters<typeof handle.writeFile>) => {
          const result = await realWrite(...writeArgs); serialized.resolve(); await release.promise; return result;
        };
      }
      return handle;
    });
    try {
      const firstFlush = settings.flush(); await serialized.promise;
      settings.set("codexResets.keepCredits", 7); release.resolve(); await firstFlush;
      expect((await parse(f.config)).codexResets.keepCredits).toBe(5);
      await settings.flush();
      expect((await parse(f.config)).codexResets.keepCredits).toBe(7);
    } finally { open.mockRestore(); }
    settings.disableResetPolicyPersistence();
  });

  test("preserves the writer across cwd changes and makes disposal and failed readback explicit", async () => {
    const f = await fixture(); const otherCwd = join(f.root, "other"); await mkdir(otherCwd);
    const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
    const writer = await settings.enableResetPolicyPersistence();
    await settings.reloadForCwd(otherCwd);
    expect(settings.getResetPolicySettingsWriter()).toBe(writer);
    settings.set("codexResets.salvageHorizonHours", 24); await settings.flush();
    expect((await parse(f.config)).codexResets.salvageHorizonHours).toBe(24);

    const child = Settings.isolated({}, { resetPolicyWriter: writer });
    const captured = child.capturePersistedReadback(paths);
    settings.disableResetPolicyPersistence();
    expect(() => child.set("codexResets.autoRedeem", "yes")).toThrow("disposed");
    await expect(captured.read()).rejects.toThrow("scope changed");
  });
});
