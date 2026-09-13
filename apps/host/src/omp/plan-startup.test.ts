import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// One isolated child consumes the actual installed public helper, its original
// compatibility export, Settings, SessionManager and durable native history.
// No AgentSession, model prompt, provider, native UI or retained state is used.
if (process.argv[2] === "--plan-startup-fixture") {
  const directory = process.argv[3]!;
  assert.equal(process.env.HOME, directory);
  assert.equal(process.cwd(), directory);
  let fetchAttempts = 0;
  globalThis.fetch = Object.assign(async () => {
    fetchAttempts++; throw new Error("Network is disabled in the native startup consumer fixture");
  }, { preconnect: () => { throw new Error("Preconnect is disabled in the native startup consumer fixture"); } }) as typeof fetch;
  const { shouldEnterPlanModeOnStartup } = await import("@oh-my-pi/pi-coding-agent/plan-mode/startup");
  const { shouldEnterPlanModeOnStartup: originalExport } = await import("@oh-my-pi/pi-coding-agent/modes/interactive-mode");
  const { SessionManager } = await import("@oh-my-pi/pi-coding-agent/session/session-manager");
  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  assert.equal(originalExport, shouldEnterPlanModeOnStartup, "old public import must reference the same extracted function");
  const cwd = path.join(directory, "project"); await mkdir(cwd, { recursive: true });
  const outcomes: Array<{ name: string; enter: boolean; contextMessages: number }> = [];
  const names = ["fresh", "default-disabled", "plan-disabled", "metadata", "explicit-none", "paused", "message", "custom-message", "branch-summary", "compaction"];
  for (const name of names) {
    const manager = SessionManager.create(cwd, path.join(directory, "sessions"));
    const settings = Settings.isolated({ "plan.enabled": name !== "plan-disabled", "plan.defaultOnStartup": name !== "default-disabled" });
    try {
      if (name === "metadata") manager.appendCustomEntry("fixture-extension-metadata", { state: "not conversation context" });
      if (name === "explicit-none") manager.appendModeChange("none");
      if (name === "paused") manager.appendModeChange("plan_paused");
      if (name === "message") manager.appendMessage({ role: "user", content: "Actual native user context", timestamp: 1 });
      if (name === "custom-message") manager.appendCustomMessageEntry("fixture-message", "Actual extension conversation context", false);
      if (name === "branch-summary") manager.branchWithSummary(null, "Actual native branch summary");
      if (name === "compaction") {
        const retained = manager.appendCustomEntry("fixture-retained-metadata", {});
        manager.appendCompaction("Actual native compacted conversation summary", undefined, retained, 10);
      }
      await manager.ensureOnDisk(); await manager.flush();
      const file = manager.getSessionFile()!, before = await readFile(file, "utf8"), entriesBefore = JSON.stringify(manager.getEntries());
      const expected = name === "fresh" || name === "metadata";
      assert.equal(shouldEnterPlanModeOnStartup(manager, settings), expected, name);
      assert.equal(originalExport(manager, settings), expected, `${name} compatibility`);
      assert.equal(JSON.stringify(manager.getEntries()), entriesBefore, `${name} read-only entries`);
      assert.equal(await readFile(file, "utf8"), before, `${name} read-only journal`);
      const contextMessages = manager.buildSessionContext().messages.length;
      if (["message", "custom-message", "branch-summary", "compaction"].includes(name)) assert.ok(contextMessages > 0, `${name} must contain actual resolved native context`);
      const reopened = await SessionManager.open(file);
      try { assert.equal(shouldEnterPlanModeOnStartup(reopened, settings), expected, `${name} actual journal reopen`); }
      finally { await reopened.close(); }
      outcomes.push({ name, enter: expected, contextMessages });
    } finally { await manager.close(); }
  }
  assert.equal(fetchAttempts, 0);
  process.stdout.write(JSON.stringify({ outcomes, fetchAttempts, compatibilityExportIdentical: true }) + "\n");
} else {
  const { expect, test } = await import("bun:test");
  test("extracted native launch default preserves compatibility and actual fresh, metadata, mode and conversation context semantics", async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-plan-startup-")));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const child = Bun.spawn([process.execPath, fileURLToPath(import.meta.url), "--plan-startup-fixture", directory], {
        cwd: directory, env: { HOME: directory, PATH: process.env.PATH, TMPDIR: tmpdir(), TERM: "dumb", PI_DISABLE_DOTENV: "1",
          PI_CODING_AGENT_DIR: path.join(directory, "agent") }, stdout: "pipe", stderr: "pipe",
      });
      timeout = setTimeout(() => child.kill(), 25_000);
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (code !== 0) throw new Error(`Native startup consumer failed (${code}):\n${stdout}\n${stderr}`);
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(result.fetchAttempts).toBe(0); expect(result.compatibilityExportIdentical).toBe(true);
      expect(result.outcomes.map((entry: { name: string; enter: boolean }) => [entry.name, entry.enter])).toEqual([
        ["fresh", true], ["default-disabled", false], ["plan-disabled", false], ["metadata", true], ["explicit-none", false],
        ["paused", false], ["message", false], ["custom-message", false], ["branch-summary", false], ["compaction", false],
      ]);
    } finally { clearTimeout(timeout); await rm(directory, { recursive: true, force: true }); }
  }, 30_000);
}
