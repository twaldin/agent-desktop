import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("NativePlugins uses an isolated native directory resolver", async () => {
  // Native directory resolution is process-global; keep this fixture's profile
  // and environment changes separate from the runner and other native suites.
  const fixture = path.join(import.meta.dir, "fixtures", "native-plugins.ts");
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "agent-desktop-native-plugins-wrapper-"));
  let exitCode = -1, stdout = "", stderr = "";
  try {
    const child = Bun.spawn([process.execPath, "--no-env-file", "test", fixture], {
      cwd: path.resolve(import.meta.dir, "../../../.."),
      env: {
        HOME: path.join(sandbox, "home"),
        PATH: "/usr/bin:/bin",
        TMPDIR: sandbox,
        XDG_DATA_HOME: path.join(sandbox, "xdg-data"),
        XDG_STATE_HOME: path.join(sandbox, "xdg-state"),
        XDG_CACHE_HOME: path.join(sandbox, "xdg-cache"),
        XDG_CONFIG_HOME: path.join(sandbox, "xdg-config"),
        PI_CODING_AGENT_DIR: path.join(sandbox, "agent"),
        PI_DISABLE_DOTENV: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
});
