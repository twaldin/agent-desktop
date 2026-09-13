import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("pinned native Google metadata reaches SDK initial and existing-session models without provider I/O", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "top-k-native-metadata-")));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project");
  await mkdir(agentDir); await mkdir(cwd);
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/top-k-native-metadata.ts", import.meta.url)), agentDir, cwd], {
      cwd: root, env: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: "dumb" },
      stdout: "pipe", stderr: "pipe",
    });
    deadline = setTimeout(() => child?.kill(), 80_000);
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(status, stderr).toBe(0);
    expect(stdout).toContain("native Top K metadata contracts passed");
  } finally {
    if (deadline) clearTimeout(deadline);
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
