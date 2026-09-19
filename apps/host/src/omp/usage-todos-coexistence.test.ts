import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
for (const mode of ["direct", "worker"] as const) test(`actual ${mode} native Usage/Todo admission remains exclusive and recovers after settlement`, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "usage-todos-coexistence-")));
  const argv = [process.execPath, fileURLToPath(new URL("./fixtures/usage-todos-coexistence.ts", import.meta.url)), directory, mode];
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = Bun.spawn(argv, { env: { HOME: directory, PATH: process.env.PATH, TMPDIR: directory, TERM: "dumb", PI_DISABLE_DOTENV: "1", PI_CODING_AGENT_DIR: path.join(directory, "agent") }, stdout: "pipe", stderr: "pipe" });
    deadline = setTimeout(() => child.kill(), 30_000);
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Usage/Todo fixture ${JSON.stringify(argv)} failed (${code}):\n${stdout}\n${stderr}`);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(result.freshTodoCommits).toBe(2); expect(result.refusals).toHaveLength(2);
    expect(result.reverseRefused).toBe(mode === "direct"); expect(result.providerReads).toBe(mode === "direct" ? 3 : 2);
    if (mode === "direct") expect(result.refusals).toEqual(["TODOS_REJECTED", "TODOS_REJECTED"]);
  } finally { clearTimeout(deadline); await rm(directory, { recursive: true, force: true }); }
}, 35_000);
