import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("actual host enforces local administration and closes a controlled remote socket on revoke", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "device-access-server-")));
  const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "fixtures/device-access-server.ts")], {
    cwd: home, env: { HOME: home, TMPDIR: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", PI_CODING_AGENT_DIR: join(home, "agent"), PI_DISABLE_DOTENV: "1" }, stdout: "pipe", stderr: "pipe",
  });
  const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text();
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30000);
  try { expect(await child.exited, await errors).toBe(0); expect(await output).toContain("isolated device policy HTTP, remote restriction and event revocation passed"); }
  finally { clearTimeout(timeout); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } await rm(home, { recursive: true, force: true }); }
}, 40000);
