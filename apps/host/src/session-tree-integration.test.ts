import { test, expect } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
for (const [name, file] of [["worker", "omp-workers/fixtures/session-tree-worker.ts"], ["authenticated HTTP", "fixtures/session-tree-http.ts"]]) {
  test(`native conversation tree through production ${name}`, async () => {
    const evidence = process.env.AGENT_DESKTOP_TREE_TEST_EVIDENCE;
    if (evidence) await mkdir(evidence, { recursive: true });
    const root = await mkdtemp(path.join(evidence ?? tmpdir(), "native-tree-integration-"));
    const argv = [process.execPath, path.join(import.meta.dir, file!), root];
    const child = Bun.spawn(argv, { env: { HOME: root, PATH: process.env.PATH, TMPDIR: root, PI_CODING_AGENT_DIR: path.join(root, "agent"), TERM: "dumb" }, stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await writeFile(path.join(root, "raw-run.json"), JSON.stringify({ argv, status, stdout, stderr }, null, 2));
    expect(status, `${stderr}\n${stdout}\nRetained fixture: ${root}`).toBe(0);
  }, 30_000);
}
