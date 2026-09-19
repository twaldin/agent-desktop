import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function run(scenario: string) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-session-todos-native-")));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/session-todos-native.ts", import.meta.url)), directory, scenario], {
      env: { HOME: directory, PATH: process.env.PATH, TMPDIR: tmpdir(), TERM: "dumb", PI_DISABLE_DOTENV: "1",
        PI_CODING_AGENT_DIR: path.join(directory, "agent") }, stdout: "pipe", stderr: "pipe",
    });
    // Real clock on purpose: it bounds a separate native child process, which fake timers cannot drive.
    deadline = setTimeout(() => child.kill(), 30_000);
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Native Todos ${scenario} fixture failed (${code}):\n${stdout}\n${stderr}`);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(result.blockedFetches).toBe(0); expect(result.configUnchanged).toBe(true); return result;
  } finally { clearTimeout(deadline); await rm(directory, { recursive: true, force: true }); }
}

test("native branch entries, user-attributed reminders, agent updates, structured actions and restart recovery", async () => {
  const { lifecycle, reopen } = await run("lifecycle");
  expect(lifecycle.entries).toBe(9); expect(lifecycle.reminders).toBe(9);
  expect(lifecycle.finalPhases).toEqual([{ name: "Reopen", tasks: [{ content: "Survives restart", status: "pending" }] }]);
  expect(reopen.phases).toEqual(lifecycle.finalPhases); expect(reopen.sameRevision).toBe(true);
}, 35_000);

test("busy, ticket, malformed, oversized and asynchronous import races refuse before any native side effect", async () => {
  const { guards } = await run("guards");
  expect(guards.entries).toBe(6);
}, 35_000);

test("an extension /todo shadows the native command but not the structured edit", async () => {
  const { shadowed } = await run("shadowed");
  expect(shadowed).toEqual({ nativeCommandAvailable: false, structuredEditCommitted: true });
}, 35_000);

test.each(["flush-failed", "retired-after-commit"])("%s latches an unknown outcome that is never replayed", async scenario => {
  const { unknown } = await run(scenario);
  expect(unknown).toEqual({ scenario, reconciliationRequired: true, entries: 2, recovered: ["Durable before failure", "Uncertain outcome"] });
}, 35_000);
