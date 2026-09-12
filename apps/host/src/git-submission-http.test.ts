import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("HTTP v10 uses native owned generation and durable no-replay receipts in an isolated host", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "compound-http-"))), home = join(root, "home"); await mkdir(home);
  try {
    const child = Bun.spawn([process.execPath, new URL("./fixtures/git-submission-http.ts", import.meta.url).pathname], {
      cwd: root, env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: root, PI_DISABLE_DOTENV: "1",
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", COMPOUND_HTTP_ROOT: root,
        COMMIT_WORKER_PID: join(root, "worker-pid"), COMMIT_WORKER_FETCH: join(root, "unexpected-fetch") },
      stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 45_000);
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); clearTimeout(timer);
    if (code !== 0) throw new Error(`Isolated HTTP fixture exited ${code}\n${stdout}\n${stderr}`);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(result).toEqual({ checks: 9, nativeGeneratedMessage: "style: reformatted source.js", sessions: 0, fetchSentinel: false, commitsIncludingBase: 2 });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 50_000);
