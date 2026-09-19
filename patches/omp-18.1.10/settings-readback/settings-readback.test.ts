import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(global = "codexResets:\n  autoRedeem: no\n  keepCredits: 2\n") {
  const root = await mkdtemp(join(tmpdir(), "settings-readback-")); roots.push(root);
  const agentDir = join(root, "agent"), cwd = join(root, "project");
  await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
  await writeFile(join(agentDir, "config.yml"), global);
  return { root, agentDir, cwd };
}

const paths = ["codexResets.autoRedeem", "codexResets.keepCredits"] as const;

describe("Settings persisted readback", () => {
  test("reads an exact writable global update without mutating the live instance", async () => {
    const f = await fixture();
    const settings = await Settings.loadIsolated({ agentDir: f.agentDir, cwd: f.cwd });
    let changes = 0; settings.onEffectiveChange(() => changes++);
    settings.set("codexResets.autoRedeem", "yes");
    const capture = settings.capturePersistedReadback(paths);
    const storage = settings.getStorage(), beforeProject = settings.getProjectSettings();
    await settings.flush(); const changesBeforeRead = changes;
    const snapshot = await capture.read();
    expect(capture.writable).toBe(true);
    expect(snapshot.global).toEqual({ "codexResets.autoRedeem": "yes", "codexResets.keepCredits": 2 });
    expect(snapshot.effective).toEqual(snapshot.global);
    expect(snapshot.projectDiscoveryStatus).toBe("warning-free");
    expect(settings.getStorage()).toBe(storage);
    expect(settings.getProjectSettings()).toEqual(beforeProject);
    expect(changes).toBe(changesBeforeRead);
    settings.cancelPendingSaves();
  });

  test("exposes read-only no-write instead of accepting a no-op flush", async () => {
    const f = await fixture();
    const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
    settings.set("codexResets.autoRedeem", "yes");
    const capture = settings.capturePersistedReadback(paths);
    await settings.flush();
    const snapshot = await capture.read();
    expect(capture.writable).toBe(false);
    expect(settings.get("codexResets.autoRedeem")).toBe("yes");
    expect(snapshot.global["codexResets.autoRedeem"]).toBe("no");
  });

  test("preserves captured overlays and runtime overrides and ignores later process env", async () => {
    const f = await fixture();
    const overlay = join(f.root, "overlay.yml"), foreign = join(f.root, "foreign.yml");
    await writeFile(overlay, "codexResets:\n  autoRedeem: no\n");
    await writeFile(foreign, "codexResets:\n  autoRedeem: yes\n");
    const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd, configFiles: [overlay], overrides: { "codexResets.keepCredits": 7 } });
    const capture = settings.capturePersistedReadback(paths);
    const previous = process.env.PI_CONFIG_FILES; process.env.PI_CONFIG_FILES = foreign;
    try {
      const snapshot = await capture.read();
      expect(snapshot.global["codexResets.autoRedeem"]).toBe("no");
      expect(snapshot.effective).toEqual({ "codexResets.autoRedeem": "no", "codexResets.keepCredits": 7 });
    } finally {
      if (previous === undefined) delete process.env.PI_CONFIG_FILES; else process.env.PI_CONFIG_FILES = previous;
    }
  });

  test("retains child cwd identity and exposes project and runtime shadow values exactly", async () => {
    const f = await fixture("codexResets:\n  autoRedeem: yes\n  keepCredits: 2\n");
    await mkdir(join(f.cwd, ".claude"), { recursive: true });
    await writeFile(join(f.cwd, ".claude", "settings.json"), JSON.stringify({ codexResets: { autoRedeem: "no" } }));
    const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd, overrides: { "codexResets.keepCredits": 5 } });
    const capture = settings.capturePersistedReadback(paths);
    const snapshot = await capture.read();
    expect(snapshot.cwd).toBe(f.cwd);
    expect(snapshot.project["codexResets.autoRedeem"]).toBe("no");
    expect(snapshot.effective).toEqual({ "codexResets.autoRedeem": "no", "codexResets.keepCredits": 5 });

    const unset = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd, overrides: { "codexResets.autoRedeem": "unset" } });
    const unsetSnapshot = await unset.capturePersistedReadback(paths).read();
    expect(unsetSnapshot.global["codexResets.autoRedeem"]).toBe("yes");
    expect(unsetSnapshot.project["codexResets.autoRedeem"]).toBe("no");
    expect(unsetSnapshot.effective["codexResets.autoRedeem"]).toBe("unset");
  });

  test("reports a conflicting persisted same-key value and retains unrelated global keys", async () => {
    const f = await fixture("theme: custom\ncodexResets:\n  autoRedeem: no\n  keepCredits: 2\n");
    const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
    const capture = settings.capturePersistedReadback(paths);
    await writeFile(join(f.agentDir, "config.yml"), "theme: custom\ncodexResets:\n  autoRedeem: yes\n  keepCredits: 2\n");
    const snapshot = await capture.read();
    expect(snapshot.global["codexResets.autoRedeem"]).toBe("yes");
    expect(await readFile(join(f.agentDir, "config.yml"), "utf8")).toContain("theme: custom");
    expect(settings.get("codexResets.autoRedeem")).toBe("no");
  });

  test("marks surfaced provider failures incomplete and does not overstate silent-provider coverage", async () => {
    const f = await fixture();
    await mkdir(join(f.cwd, ".claude"), { recursive: true });
    await writeFile(join(f.cwd, ".claude", "settings.json"), "{ malformed");
    const warned = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
    expect((await warned.capturePersistedReadback(paths).read()).projectDiscoveryStatus).toBe("incomplete");

    await writeFile(join(f.cwd, ".claude", "settings.json"), "{}");
    await mkdir(join(f.cwd, ".codex"), { recursive: true });
    await writeFile(join(f.cwd, ".codex", "config.toml"), "invalid = [");
    const silent = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
    expect((await silent.capturePersistedReadback(paths).read()).projectDiscoveryStatus).toBe("warning-free");
    // Codex's provider logs and drops malformed TOML without returning a capability warning.
    // Therefore `warning-free` is deliberately not named or documented as complete.
  });

  test("rejects changed live scope and invalid persisted input without quarantine", async () => {
    const f = await fixture();
    const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
    const changed = settings.capturePersistedReadback(paths);
    settings.override("codexResets.keepCredits", 9);
    await expect(changed.read()).rejects.toThrow("scope changed");

    const invalid = settings.capturePersistedReadback(paths);
    const config = join(f.agentDir, "config.yml"); await writeFile(config, "codexResets: [invalid\n");
    await expect(invalid.read()).rejects.toThrow("Settings config is invalid");
    expect(await readFile(config, "utf8")).toBe("codexResets: [invalid\n");
  });
});
