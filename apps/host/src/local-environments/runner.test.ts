import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLocalEnvironmentScript, type LocalEnvironmentRunInput } from "./runner";

const roots: string[] = [];
function root() { const path = mkdtempSync(join(tmpdir(), "agent-desktop-environment-runner-")); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const baseEnvironment = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, LOCAL_ENV_REMOVE: "old", PRIVATE_UNCHANGED: "must-not-be-public", MULTILINE: "before\nvalue" });
function input(script: string, overrides: Partial<LocalEnvironmentRunInput> = {}): LocalEnvironmentRunInput {
  const sourceRoot = root(), worktreeRoot = root();
  return { cwd: worktreeRoot, sourceRoot, worktreeRoot, script, lifecycle: "setup", baseEnvironment: baseEnvironment(), shell: { executable: "/bin/bash" }, ...overrides };
}

async function until(check: () => boolean, label: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await Bun.sleep(10);
  }
}

function processExists(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (cause) { return (cause as NodeJS.ErrnoException).code !== "ESRCH"; }
}

test("setup runs once, injects owned paths and returns only allowed exported environment changes", async () => {
  const marker = join(root(), "setup-count"), output: string[] = [], originalHome = process.env.HOME;
  const run = input([
    `[ "$CODEX_SOURCE_TREE_PATH" = "$AGENT_SOURCE_TREE_PATH" ]`,
    `[ "$CODEX_WORKTREE_PATH" = "$AGENT_WORKTREE_PATH" ]`,
    `printf 'once\\n' >> ${quote(marker)}`,
    "export LOCAL_ENV_ADDED='added value'",
    "unset LOCAL_ENV_REMOVE",
    "export HOME='/attempted-relocation'",
    "export CODEX_HOME='/attempted-relocation'",
    "export PI_CODING_AGENT_DIR='/attempted-relocation'",
    "export AGENT_DESKTOP_DATA_DIR='/attempted-relocation'",
    "export MULTILINE='after\nvalue'",
    "printf 'visible stdout'",
    "printf 'visible stderr' >&2",
  ].join("\n"), { onOutput: event => output.push(Buffer.from(event.chunk).toString("utf8")) });
  const result = await runLocalEnvironmentScript(run);
  expect(result).toMatchObject({ status: "succeeded", exitCode: 0, stdout: "visible stdout", stderr: "visible stderr", outputTruncated: false,
    environmentDelta: { version: 1, set: { LOCAL_ENV_ADDED: "added value" }, unset: ["LOCAL_ENV_REMOVE"] } });
  expect(readFileSync(marker, "utf8")).toBe("once\n");
  const publicResult = { ...result, environmentDelta: undefined };
  expect(JSON.stringify(publicResult)).not.toContain("must-not-be-public");
  expect(output.join("")).not.toContain("must-not-be-public");
  expect(process.env.HOME).toBe(originalHome);
});

test("cleanup never returns an environment delta and a nonzero exit is failed", async () => {
  const cleanup = await runLocalEnvironmentScript(input("export CLEANUP_ONLY=hidden\nprintf cleanup", { lifecycle: "cleanup" }));
  expect(cleanup).toMatchObject({ status: "succeeded", exitCode: 0, stdout: "cleanup", environmentDelta: null });
  const failure = await runLocalEnvironmentScript(input("printf failed >&2\nexit 7"));
  expect(failure).toMatchObject({ status: "failed", exitCode: 7, stderr: "failed", environmentDelta: null });
});

test("setup captures exported state when the sourced script exits explicitly", async () => {
  const result = await runLocalEnvironmentScript(input("export EXPLICIT_EXIT=value\nexit 0"));
  expect(result).toMatchObject({ status: "succeeded", exitCode: 0, environmentDelta: { set: { EXPLICIT_EXIT: "value" } } });
});

test("pipefail turns an early pipeline error into failure before later script lines", async () => {
  const result = await runLocalEnvironmentScript(input("false | true\nprintf should-not-run"));
  expect(result.status).toBe("failed"); expect(result.exitCode).not.toBe(0); expect(result.stdout).toBe("");
});

test("timeout and abort terminate the owned shell process group including a child", async () => {
  const unrelated = Bun.spawn(["/bin/sleep", "5"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    for (const mode of ["timed-out", "aborted"] as const) {
      const pidFile = join(root(), `${mode}.pid`), controller = new AbortController();
      const running = runLocalEnvironmentScript(input(`trap '' TERM\nsleep 30 &\necho $! > ${quote(pidFile)}\nwait`, {
        timeoutMs: mode === "timed-out" ? 100 : 5_000, signal: controller.signal,
      }));
      await until(() => existsSync(pidFile), `${mode} child pid`);
      const childPid = Number(readFileSync(pidFile, "utf8").trim());
      if (mode === "aborted") controller.abort();
      const result = await running;
      expect(result).toMatchObject({ status: "cancelled", cancelReason: mode, environmentDelta: null });
      await until(() => !processExists(childPid), `${mode} child termination`);
      expect(unrelated.exitCode).toBeNull();
    }
  } finally {
    if (unrelated.exitCode === null) unrelated.kill("SIGKILL");
    await unrelated.exited;
  }
});

test("timeout kills a background child after its parent shell exits zero", async () => {
  const pidFile = join(root(), "exited-parent.pid"), started = performance.now();
  const running = runLocalEnvironmentScript(input(`sleep 30 &\necho $! > ${quote(pidFile)}\nexit 0`, { timeoutMs: 100 }));
  await until(() => existsSync(pidFile), "background child pid");
  const childPid = Number(readFileSync(pidFile, "utf8").trim());
  let result: Awaited<typeof running> | undefined, failure: unknown;
  try { result = await Promise.race([running, Bun.sleep(2_000).then(() => { throw new Error("runner remained open after timeout"); })]); }
  catch (cause) { failure = cause; }
  finally {
    if (processExists(childPid)) { try { process.kill(childPid, "SIGKILL"); } catch {} }
    await Promise.race([running.catch(() => undefined), Bun.sleep(1_000)]);
  }
  if (failure) throw failure;
  expect(result).toMatchObject({ status: "cancelled", cancelReason: "timed-out", exitCode: 0 });
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(processExists(childPid)).toBeFalse();
});

test("stdout and stderr share one truthful output byte limit", async () => {
  const events: Array<{ bytes: number; truncated: boolean }> = [];
  const result = await runLocalEnvironmentScript(input("printf 1234567890\nprintf abcdef >&2", {
    maxOutputBytes: 12,
    onOutput: event => events.push({ bytes: event.chunk.byteLength, truncated: event.truncated }),
  }));
  expect(result).toMatchObject({ status: "succeeded", stdout: "1234567890", stderr: "ab", outputTruncated: true });
  expect(events.reduce((total, event) => total + event.bytes, 0)).toBe(12);
  expect(events.some(event => event.truncated)).toBeTrue();
});

test("cwd must remain inside its owned worktree", async () => {
  const run = input("true"), outside = root();
  await expect(runLocalEnvironmentScript({ ...run, cwd: outside })).rejects.toThrow("inside the owned worktree root");
  await expect(runLocalEnvironmentScript({ ...run, shell: { executable: "/bin/fish" } })).rejects.toThrow("Unsupported local environment shell");
});
