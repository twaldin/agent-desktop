import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// The paired runner may select the preserved old implementation. The fixture
// and assertions are otherwise identical for both sides of the regression.
const { WorkerClient, WorkerRuntime } = await import(process.env.COMMIT_ACK_RUNTIME ?? new URL("./runtime.ts", import.meta.url).href) as typeof import("./runtime");

async function waitForExit(pid: number) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
    await Bun.sleep(10);
  }
  throw new Error("Controlled worker did not exit");
}

test("close skip branch rejects a completed response after the child already exited without disposal acknowledgement", async () => {
  const workerPath = fileURLToPath(new URL("./fixtures/commit-post-response-exit-worker.ts", import.meta.url));
  const home = await mkdtemp(join(tmpdir(), "commit-ack-closed-"));
  const client = new WorkerClient({ workerPath, startupTimeoutMs: 3000, shutdownTimeoutMs: 3000,
    environment: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", PI_DISABLE_DOTENV: "1" } });
  try {
    await client.request({ operation: "init", args: { mode: "discovery" } });
    const result = await client.request({ operation: "generateCommit", args: { cwd: "/controlled", diff: "fixture", stat: "", numstat: "" } });
    expect(result).toBeTruthy();
    await waitForExit(client.pid);
    await expect(client.close({ requireAcknowledgement: true })).rejects.toThrow("required disposal acknowledgement");
  } finally { await client.close().catch(() => {}); await rm(home, { recursive: true, force: true }); }
});

test("post-response worker death cannot release generation success without disposal acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "commit-disposal-ack-"));
  const cwd = join(root, "repo"), agentDir = join(root, "agent"), home = join(root, "home");
  await Promise.all([cwd, agentDir, home].map(path => mkdir(path)));
  const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL("./fixtures/commit-post-response-exit-worker.ts", import.meta.url)),
    startupTimeoutMs: 3000, shutdownTimeoutMs: 3000,
    environment: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: root, PI_DISABLE_DOTENV: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  try {
    await expect(runtime.generateCommit({ cwd, diff: "fixture", stat: "", numstat: "" })).rejects.toThrow("disposal acknowledgement");
  } finally { await runtime.dispose().catch(() => {}); await rm(root, { recursive: true, force: true }); }
});
