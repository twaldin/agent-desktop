import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WorkerRuntime } from "./runtime";

const execute = promisify(execFile);
async function fixture(worker: string, hold?: string) {
  const root = await mkdtemp(join(tmpdir(), "agent-commit-worker-"));
  const cwd = join(root, "repository"), agentDir = join(root, "agent");
  const environment = { HOME: join(root, "home"), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: root,
    PI_DISABLE_DOTENV: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    COMMIT_WORKER_PID: join(root, "pid"), COMMIT_WORKER_FETCH: join(root, "fetch"),
    COMMIT_WORKER_STAGE: join(root, "stage"), COMMIT_WORKER_HOLD: hold };
  await Promise.all([cwd, agentDir, environment.HOME].map(path => mkdir(path)));
  const runtime = new WorkerRuntime({ agentDir, environment, workerPath: fileURLToPath(new URL(`./fixtures/${worker}`, import.meta.url)), shutdownTimeoutMs: 3000 });
  return { root, cwd, environment, runtime, cleanup: async () => { try { await runtime.dispose(); } finally { await rm(root, { recursive: true, force: true }); } } };
}
async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await readFile(path, "utf8").catch(() => undefined);
    if (value) return value;
    await Bun.sleep(20);
  }
  throw new Error(`Fixture did not reach ${path}`);
}
function exited(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
}

test("dedicated native generation worker returns supplied diff result and exits without a session or fetch", async () => {
  const f = await fixture("commit-worker-probe.ts");
  const git = async (...args: string[]) => (await execute("git", args, { cwd: f.cwd, env: f.environment, timeout: 10_000 })).stdout;
  try {
    await git("init", "-q", "--initial-branch=main");
    await git("config", "user.name", "Worker Contract"); await git("config", "user.email", "fixture@example.invalid");
    await git("config", "commit.gpgSign", "false"); await git("config", "core.hooksPath", join(f.root, "empty-hooks"));
    await writeFile(join(f.cwd, "source.js"), "const value=1;\n"); await git("add", "."); await git("commit", "-qm", "base");
    await writeFile(join(f.cwd, "source.js"), "const value = 1;\n");
    const index = await readFile(join(f.cwd, ".git/index")), head = await git("rev-parse", "HEAD");
    const input = { cwd: f.cwd, diff: await git("diff"), stat: await git("diff", "--stat"), numstat: await git("diff", "--numstat") };
    const pending = f.runtime.generateCommit(input);
    input.cwd = "/not-the-owner"; input.diff = "mutated";
    expect(await pending).toMatchObject({ stagedAll: false, commit: { type: "style", summary: "reformatted source.js" }, message: "style: reformatted source.js" });
    expect(exited(Number(await readFile(f.environment.COMMIT_WORKER_PID, "utf8")))).toBe(true);
    expect(await stat(f.environment.COMMIT_WORKER_FETCH).then(() => true, () => false)).toBe(false);
    expect(await stat(join(f.root, "agent/sessions")).then(() => true, () => false)).toBe(false);
    expect(await readFile(join(f.cwd, ".git/index"))).toEqual(index);
    expect(await git("rev-parse", "HEAD")).toBe(head);
  } finally { await f.cleanup(); }
}, 20_000);

for (const hold of ["startup", "generation"] as const) test(`generation cancellation during ${hold} reaps its dedicated process (protocol fixture)`, async () => {
  const f = await fixture("commit-cancel-worker.ts", hold), abort = new AbortController(), progress: string[] = [];
  const observedProgress = Promise.withResolvers<void>();
  let progressDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const settled = f.runtime.generateCommit({ cwd: f.cwd, diff: "fixture", stat: "", numstat: "" }, { signal: abort.signal, onProgress: text => { progress.push(text); observedProgress.resolve(); } })
      .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    expect(await waitForFile(f.environment.COMMIT_WORKER_STAGE)).toBe(hold);
    if (hold === "generation") await Promise.race([observedProgress.promise, new Promise<never>((_resolve, reject) => {
      progressDeadline = setTimeout(() => reject(new Error("Generation progress was not delivered")), 5000);
    })]);
    const pid = Number(await readFile(f.environment.COMMIT_WORKER_PID, "utf8"));
    abort.abort(new Error("Stop generation"));
    const result = await settled;
    expect(result.error?.message).toBe("Stop generation");
    expect(result.value).toBeUndefined();
    expect(exited(pid)).toBe(true);
    expect(progress).toEqual(hold === "generation" ? ["Controlled generation pending"] : []);
  } finally { clearTimeout(progressDeadline); await f.cleanup(); }
}, 15_000);

test("a pre-aborted generation does not spawn a worker", async () => {
  const f = await fixture("commit-cancel-worker.ts"), abort = new AbortController();
  try {
    abort.abort(new Error("Already canceled"));
    await expect(f.runtime.generateCommit({ cwd: f.cwd, diff: "fixture", stat: "", numstat: "" }, { signal: abort.signal })).rejects.toThrow("Already canceled");
    expect(await stat(f.environment.COMMIT_WORKER_PID).then(() => true, () => false)).toBe(false);
  } finally { await f.cleanup(); }
});
