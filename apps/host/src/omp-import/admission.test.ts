import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

for (const scenario of ["receipt-and-resume", "stale-preparation", "lost-dispatcher", "dispose-during-open"]) {
  test(`real original-session admission service: ${scenario}`, async () => {
    const evidence = process.env.ORIGINAL_ADMISSION_EVIDENCE;
    if (evidence) await mkdir(evidence, { recursive: true });
    const root = await realpath(await mkdtemp(path.join(evidence ?? tmpdir(), `original-admission-${scenario}-`)));
    const argv = [process.execPath, fileURLToPath(new URL("./fixtures/original-admission.ts", import.meta.url)), root, scenario];
    const child = Bun.spawn(argv, { cwd: root, env: { HOME: root, TMPDIR: root, PATH: process.env.PATH,
      PI_CODING_AGENT_DIR: path.join(root, "agent"), TERM: "dumb" }, stdout: "pipe", stderr: "pipe" });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 65_000);
    try {
      const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      await writeFile(path.join(root, "raw-run.json"), JSON.stringify({ argv, status, stdout, stderr }, null, 2));
      expect(status, `${scenario}: ${stderr}\n${stdout}\nOriginal evidence: ${root}`).toBe(0);
      if (!evidence) await rm(root, { recursive: true, force: true });
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    }
  }, 70_000);
}
