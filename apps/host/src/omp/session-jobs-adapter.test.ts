import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function run() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-session-jobs-adapter-")));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/session-jobs-adapter.ts", import.meta.url)), directory], {
      env: { HOME: directory, PATH: process.env.PATH, TMPDIR: tmpdir(), TERM: "dumb", PI_DISABLE_DOTENV: "1",
        PI_CODING_AGENT_DIR: path.join(directory, "agent") }, stdout: "pipe", stderr: "pipe",
    });
    // Real clock on purpose: it bounds a separate native child process, which fake timers cannot drive.
    deadline = setTimeout(() => child.kill(), 30_000);
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (process.env.NATIVE_JOBS_EVIDENCE) {
      const evidence = path.join(process.env.NATIVE_JOBS_EVIDENCE, path.basename(directory));
      await mkdir(evidence, { recursive: true });
      await Promise.all([
        writeFile(path.join(evidence, "stdout.raw"), stdout),
        writeFile(path.join(evidence, "stderr.raw"), stderr),
        writeFile(path.join(evidence, "receipt.json"), JSON.stringify({ code, directory, fixture: "session-jobs-adapter", disposableHome: true }, null, 2)),
      ]);
    }
    if (code !== 0) throw new Error(`Native jobs adapter fixture failed (${code}):\n${stdout}\n${stderr}`);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(result.blockedFetches).toBe(0); expect(result.configUnchanged).toBe(true); return result;
  } finally { clearTimeout(deadline); await rm(directory, { recursive: true, force: true }); }
}

test("native jobs adapter scopes to the original owner, projects queued honestly, requests cancellation without claiming settlement, never consumes, and outlives no id reuse or disposal", async () => {
  const result = await run();
  expect(result.foreign).toEqual({ hidden: true, ownerId: "Main", agentId: "Main" });
  expect(result.queued).toEqual({ parked: true, started: false });
  expect(result.cancel).toEqual({ requested: true, abortedBeforeSettle: true, settledLater: true, second: false });
  expect(result.inspect).toEqual({ inspections: 3, consumed: false, pending: true, truncated: true, errorText: "boom" });
  expect(result.nativeDelivery.consumedAfterDelivery).toBe(true);
  expect(result.nativeDelivery.controlledProviderCalls).toBeGreaterThan(0);
  expect(result.reuse).toMatchObject({ sameId: true, guardChanged: true });
  expect(result.overflow).toEqual({ refused: true, untouched: 101 });
  expect(result.disposed).toEqual({ retired: true });
}, 35_000);
