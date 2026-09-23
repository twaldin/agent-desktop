import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/original-admission-scenario.ts", import.meta.url));

/** Runs the scenario in its own disposable profile. The fixture owns the real
 * native originals and spawns the production worker entry; nothing is mocked. */
async function run(scenario: string): Promise<Record<string, any>> {
  const evidence = process.env.ORIGINAL_ADMISSION_EVIDENCE;
  if (evidence) await mkdir(evidence, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(evidence ?? tmpdir(), `worker-original-${scenario}-`)));
  let passed = false;
  const child = Bun.spawn([process.execPath, "--no-env-file", fixture, root, scenario], {
    cwd: root, stdout: "pipe", stderr: "pipe",
    env: { HOME: root, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: root, TERM: "dumb", NO_COLOR: "1",
      PI_DISABLE_DOTENV: "1", PI_NO_TITLE: "1", PI_TELEMETRY_DISABLED: "1",
      PI_CODING_AGENT_DIR: path.join(root, "agent"), XDG_CONFIG_HOME: path.join(root, "xdg-config"),
      XDG_DATA_HOME: path.join(root, "xdg-data"), XDG_CACHE_HOME: path.join(root, "xdg-cache"),
      XDG_STATE_HOME: path.join(root, "xdg-state") },
  });
  // Real subprocess watchdog, not a timing assumption: fake timers cannot reap
  // an actual multiprocess native scenario that hangs holding a writer lease.
  const deadline = setTimeout(() => child.kill("SIGTERM"), 150_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const result = JSON.parse(await readFile(path.join(root, "result.json"), "utf8"));
    if (code !== 0) throw new Error(`Original admission ${scenario} exited ${code}: ${JSON.stringify(result.failure)}\n${stdout}\n${stderr}`);
    // Both processes block fetch before transport; worker attempts are retained.
    expect(result.hostNetwork).toEqual([]);
    expect(result.cleanupErrors).toEqual([]);
    passed = true;
    return result;
  } finally {
    clearTimeout(deadline);
    // A failed watchdog must not leave admitted workers holding a native lease.
    let records: Array<{ pid: number; directory: string }> = [];
    try { records = (await readFile(path.join(root, "owned-pids.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch {}
    for (const record of records) {
      if (!record.directory.startsWith(root)) throw new Error("Unowned fixture PID record");
      const inspect = Bun.spawn(["/bin/ps", "-p", String(record.pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" });
      const command = await new Response(inspect.stdout).text(); await inspect.exited;
      if (command.includes(path.join(root, "blocked-production-worker.ts"))) {
        try { process.kill(record.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
    if (passed && !evidence) await rm(root, { recursive: true, force: true });
  }
}

test("a busy cooperative original is refused before any write, and its owner keeps working", async () => {
  const result = await run("busy-refusal");
  expect(result.busy.admitted).toBe(false);
  // A proven pre-effect refusal, with the native reason retained across IPC.
  expect(result.busy.error.code).toBe("ORIGINAL_SESSION_NOT_SUBMITTED");
  expect(typeof result.busy.error.reason).toBe("string");
  expect(result.busy.error.reason.length).toBeGreaterThan(0);
  // Nothing about the original moved: same bytes, same inode, same size.
  expect(result.afterBusy).toEqual(result.before);
  // The competing writer still owns the original after the refusal.
  expect(result.ownerStillWritable.ino).toBe(result.before.ino);
  expect(result.ownerStillWritable.size).toBeGreaterThan(result.before.size);
}, 180_000);

test("a released original is admitted by the production worker, keeps its identity and history, and a native write survives disposal", async () => {
  const result = await run("lifecycle");
  const binding = result.binding;
  expect(result.busy.admitted).toBe(false);
  expect(result.admitted.id).toBe(binding.nativeId);
  expect(result.admitted.sessionFile).toBe(binding.originalFile);
  expect(result.admitted.cwd).toBe(binding.recordedCwd);
  expect(result.admitted.workerPid).toBeGreaterThan(0);
  expect(result.admitted.workerPid).not.toBe(process.pid);
  expect(result.admitted.current).toBe(true);
  expect(result.admitted.messages).toBe(true);

  // A non-provider native operation wrote the same original file: native
  // echoed the requested Todos, and the file changed without being replaced.
  expect(result.mutation.markdown).toContain(result.mutation.marker);
  expect(result.afterWrite.ino).toBe(result.released.ino);
  expect(result.afterWrite.sha256).not.toBe(result.released.sha256);

  // Relocating an admitted original is refused at its owning boundary, before
  // any native work, and the live session keeps its identity and its write.
  expect(result.transition.moved).toBe(false);
  expect(result.transition.error.code).toBe("ORIGINAL_SESSION_NOT_SUBMITTED");
  expect(result.transition.error.reason).toBe("unsupported-transition");
  expect(result.afterTransition.sha256).toBe(result.afterWrite.sha256);
  expect(result.afterTransition.ino).toBe(result.afterWrite.ino);
  expect(result.afterTransition.id).toBe(binding.nativeId);
  expect(result.afterTransition.sessionFile).toBe(binding.originalFile);
  expect(result.afterTransition.cwd).toBe(binding.recordedCwd);
  expect(result.afterTransition.todos).toBe(result.mutation.markdown);

  // Disposal reaps the actual child and stops the handle being current.
  expect(result.disposal.alive).toBe(false);
  expect(result.disposal.current).toBe(false);

  // Ownership came back, so the same original is admissible again, with the
  // earlier write and the original history both still in that same file.
  expect(result.readmitted.id).toBe(binding.nativeId);
  expect(result.readmitted.sessionFile).toBe(binding.originalFile);
  expect(result.readmitted.cwd).toBe(binding.recordedCwd);
  expect(result.readmitted.todos).toBe(result.mutation.markdown);
  expect(result.readmitted.messages).toBe(true);
  expect(result.readmittedDisposal.alive).toBe(false);
}, 240_000);

test("a reviewed source that no longer matches is refused before effects and leaves the original admissible", async () => {
  const result = await run("stale-source");
  expect(result.busy.admitted).toBe(false);
  expect(result.stale.admitted).toBe(false);
  expect(result.stale.error.code).toBe("ORIGINAL_SESSION_NOT_SUBMITTED");
  expect(typeof result.stale.error.reason).toBe("string");
  expect(result.afterStale).toEqual(result.released);
  // The refused attempt released its lease, so the next admission succeeds.
  expect(result.admitted.id).toBe(result.binding.nativeId);
  expect(result.admitted.current).toBe(true);
  expect(result.disposal.alive).toBe(false);
}, 240_000);

test("runtime disposal during an in-flight admission refuses it before a writer is spawned and sheds no ownership", async () => {
  const result = await run("race-disposal");
  expect(result.race.admitted).toBe(false);
  // Disposal beat the spawn, so this is a proven no-effect refusal.
  expect(result.race.error.code).toBe("ORIGINAL_SESSION_NOT_SUBMITTED");
  expect(result.race.error.reason).toBe("runtime-disposed");
  expect(result.afterRace).toEqual(result.released);
  // Nothing was left owning the original: a live runtime still admits it.
  expect(result.admitted.id).toBe(result.binding.nativeId);
  expect(result.admitted.current).toBe(true);
  expect(result.disposal.alive).toBe(false);
  expect(result.readmitted.messages).toBe(true);
}, 240_000);

test("a startup failure after the writer lease was taken reports an unknown outcome and still returns ownership", async () => {
  const result = await run("setup-failure");
  expect(result.busy.admitted).toBe(false);
  expect(result.setupFailure.admitted).toBe(false);
  // Never downgraded to a refusal: the native writer lease had been taken.
  expect(result.setupFailure.error.code).toBe("OUTCOME_UNKNOWN");
  expect(["admitted-setup-failed", "admitted-cleanup-failed", "admission-outcome-unknown"])
    .toContain(result.setupFailure.error.reason);
  // Cleanup joined the actual close, so the original is admissible again.
  expect(result.admitted.id).toBe(result.binding.nativeId);
  expect(result.admitted.sessionFile).toBe(result.binding.originalFile);
  expect(result.admitted.messages).toBe(true);
  expect(result.disposal.alive).toBe(false);
}, 240_000);
