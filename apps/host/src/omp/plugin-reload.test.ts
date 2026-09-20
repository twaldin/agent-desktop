import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OmpRuntime } from "./runtime";

test("explicit plugin toggles use the isolated native registry and report reload failures after the committed mutation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-desktop-plugin-reload-"));
  try {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../omp-workers/fixtures/plugin-reload-native.ts")], {
      cwd: path.resolve(import.meta.dir, "../../../.."), env: { ...process.env, FIXTURE_ROOT: root }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ disabled: "Disabled fixture@local", disabledValue: false, enabled: "Enabled fixture@local", enabledValue: true, reloads: 2 });
    expect(result.failed).toContain("Plugin error: controlled reload failure");
    expect(result.failed).not.toContain("Disabled fixture@local");
    expect(result.failedValue).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an actual native session reloads its original discovery owner and records durable command output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-desktop-plugin-session-"));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  await writeFile(path.join(agentDir, "config.yml"), "retry:\n  enabled: false\n");
  const runtime = new OmpRuntime({ agentDir });
  try {
    const session = await runtime.create({ cwd, interactions: true });
    try {
      const run = session.startPrompt("/reload-plugins");
      expect(await run.accepted).toMatchObject({ kind: "native-command", command: "reload-plugins", output: "Plugins reloaded." });
      expect(await run.completion).toBe(false);
      expect(await readFile(session.sessionFile, "utf8")).toContain("Plugins reloaded.");
    } finally {
      await session.dispose();
    }
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
