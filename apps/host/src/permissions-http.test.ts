import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("permission HTTP admission persists and restores intent through real worker receipt loss", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agent-desktop-permission-http-")));
  const child = Bun.spawn({ cmd: [process.execPath, fileURLToPath(new URL("./fixtures/permissions-http.ts", import.meta.url))],
    env: { HOME: directory, PATH: process.env.PATH, TMPDIR: tmpdir(), TERM: "dumb", CONTRACT_DIRECTORY: directory, PI_CODING_AGENT_DIR: join(directory, "native") },
    stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text();
  const deadline = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const code = await child.exited;
    if (code !== 0) throw new Error(`Isolated permission HTTP contract failed: ${await errors}`);
    expect(await output).toContain("permission HTTP native admission and recovery passed");
  } finally {
    clearTimeout(deadline); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    await rm(directory, { recursive: true, force: true });
  }
}, 70_000);
