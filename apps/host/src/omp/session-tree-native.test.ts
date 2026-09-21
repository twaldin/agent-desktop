import { test, expect } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const evidence = process.env.AGENT_DESKTOP_TREE_TEST_EVIDENCE;
for (const scenario of ["held-hook-stop", "held-controller-stop", "held-controller-dispose", "lifecycle", "cancelled-hook", "ask", "summary", "after-tree-hook", "entry-kinds", "fresh-owner", "flush-failure"]) {
  test(`real pinned native conversation tree: ${scenario}`, async () => {
    if (evidence) await mkdir(evidence, { recursive: true });
    const root = await mkdtemp(path.join(evidence ?? tmpdir(), `native-tree-${scenario}-`));
    const argv = [process.execPath, path.join(import.meta.dir, "fixtures/session-tree-native.ts"), root, scenario];
    const child = Bun.spawn(argv, { env: { HOME: root, TMPDIR: root, PATH: process.env.PATH, PI_CODING_AGENT_DIR: path.join(root, "agent"), TERM: "dumb" }, stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await writeFile(path.join(root, "raw-run.json"), JSON.stringify({ argv, status, stdout, stderr }, null, 2));
    expect(status, `${scenario}: ${stderr}\n${stdout}\nRetained fixture: ${root}`).toBe(0);
  }, 30_000);
}
