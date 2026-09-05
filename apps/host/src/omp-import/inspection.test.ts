import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
test("original native sessions are readable without mutation, stock writers ignore advisory locks, and cooperative handoff preserves identity", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-import-contract-")));
  try {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/ownership-scenario.ts", import.meta.url)), root], { cwd: root,
      env: { HOME: root, PI_CODING_AGENT_DIR: path.join(root, "agent"), SHELL: "/bin/sh", PATH: process.env.PATH, TMPDIR: tmpdir(), TERM: "dumb" }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Isolated native ownership contract failed: ${stderr}`);
    expect(stdout).toContain("native original-session ownership contracts passed");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
