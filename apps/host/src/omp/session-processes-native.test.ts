import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("actual session worker owns process read/control epochs across move, disposal and reopen", async () => {
  const root = await realpath(await mkdtemp("/tmp/adpw-"));
  const child = Bun.spawn([process.execPath, "--no-env-file", fileURLToPath(new URL("./fixtures/processes-native.ts", import.meta.url)), root], {
    env: { HOME: root, PATH: process.env.PATH, TMPDIR: root, PI_DISABLE_DOTENV: "1", PI_CODING_AGENT_DIR: path.join(root, "agent"), TERM: "dumb", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 90_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (process.env.NATIVE_PROCESSES_EVIDENCE) {
      const evidence = path.join(process.env.NATIVE_PROCESSES_EVIDENCE, path.basename(root));
      await mkdir(evidence, { recursive: true });
      await Promise.all([writeFile(path.join(evidence, "stdout.raw"), stdout), writeFile(path.join(evidence, "stderr.raw"), stderr),
        writeFile(path.join(evidence, "receipt.json"), JSON.stringify({ code, root, disposableHome: true, worker: "actual", providerRequests: false }, null, 2))]);
    }
    if (code !== 0) throw new Error(`Process worker fixture (${code}):\n${stdout}\n${stderr}`);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(result.facts).toHaveLength(7); expect(result.blocked).toEqual([]); expect(result.survivors).toEqual([]); expect(result.cleanupErrors).toEqual([]);
  } finally { clearTimeout(timer); await rm(root, { recursive: true, force: true }); }
}, 100_000);
