import { afterEach, describe, expect, test } from "bun:test";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalManager, type TerminalManagerOptions } from "./manager";
import type { TerminalInfo } from "../../../../packages/shared/src/terminals";

const directories: string[] = [];
const managers: TerminalManager[] = [];
afterEach(async () => { const results = await Promise.allSettled(managers.splice(0).map(manager => manager.shutdown())); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); const failed = results.find(result => result.status === "rejected"); if (failed?.status === "rejected") throw failed.reason; });
async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) { if (Date.now() >= deadline) throw new Error("Timed out waiting for actual terminal state"); await Bun.sleep(10); }
}
const output = (manager: TerminalManager, id: string) => manager.replay(id).chunks.map(chunk => chunk.data).join("");
async function fixture(options: TerminalManagerOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "agent-desktop-terminal-")); directories.push(cwd);
  const manager = new TerminalManager({ shell: { application: "/bin/bash", args: ["--noprofile", "--norc", "-i"], environment: { HISTFILE: "/dev/null", BASH_ENV: "/dev/null", ENV: "/dev/null", PS1: "", BASH_SILENCE_DEPRECATION_WARNING: "1" } }, ...options }); managers.push(manager);
  return { cwd, manager, target: { projectId: crypto.randomUUID() } };
}
async function create(value: Awaited<ReturnType<typeof fixture>>, options: { cols?: number; rows?: number } = {}): Promise<TerminalInfo> {
  const terminal = await value.manager.create({ cwd: value.cwd, target: value.target, ...options });
  const marker = `READY_${crypto.randomUUID()}`;
  value.manager.write(terminal.id, `set +H; stty -echo; printf '\\n${marker}\\n'\r`);
  await until(() => output(value.manager, terminal.id).includes(`\r\n${marker}\r\n`));
  return terminal;
}
async function run(manager: TerminalManager, id: string, command: string): Promise<string> {
  const cursor = manager.replay(id).lastSequence;
  const marker = `DONE_${crypto.randomUUID()}`;
  manager.write(id, `${command}; printf '\\n${marker}\\n'\r`);
  try { await until(() => manager.replay(id, cursor).chunks.map(chunk => chunk.data).join("").includes(marker)); }
  catch (error) { throw new Error(`${error}\nControlled fixture output: ${JSON.stringify(manager.replay(id, cursor))}`); }
  return manager.replay(id, cursor).chunks.map(chunk => chunk.data).join("");
}
function processAbsent(pid: number): boolean { return new TextDecoder().decode(Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" }).stdout).trim() === ""; }

describe("real pinned Bun PTY terminals", () => {
  test("raw binary input reaches an actual terminal program without UTF-8 re-encoding", async () => {
    const value = await fixture(); const terminal = await create(value);
    await writeFile(join(value.cwd, "binary-input.mjs"), `process.stdin.setRawMode(true); process.stdin.resume();\nlet input = Buffer.alloc(0); process.stdin.on("data", chunk => { input = Buffer.concat([input, chunk]); if (input.length >= 8) { process.stdout.write("BINARY_HEX:" + input.toString("hex") + "\\n"); process.stdin.setRawMode(false); process.exit(0); } });\nprocess.stdout.write("BINARY_READY\\n");\n`);
    const executable = "'" + process.execPath.replaceAll("'", "'\\''") + "'";
    value.manager.write(terminal.id, `${executable} binary-input.mjs\r`);
    await until(() => output(value.manager, terminal.id).includes("BINARY_READY"));
    value.manager.write(terminal.id, Uint8Array.from([0, 3, 27, 127, 128, 193, 254, 255]));
    await until(() => output(value.manager, terminal.id).includes("BINARY_HEX:00031b7f80c1feff"));
    expect(output(value.manager, terminal.id)).toContain("BINARY_HEX:00031b7f80c1feff");
    expect(await run(value.manager, terminal.id, "printf 'BINARY_SHELL_SURVIVES\\n'")).toContain("BINARY_SHELL_SURVIVES");
  });

  test("split UTF-8 and a final output burst are drained before marking exit", async () => {
    const value = await fixture();
    await writeFile(join(value.cwd, "final-output.mjs"), `process.stdout.write(Buffer.from([0xf0, 0x9f])); await Bun.sleep(10); process.stdout.write(Buffer.from([0x9a, 0x80]));\nprocess.stdout.write("Z".repeat(250000) + "FINAL_OUTPUT_DRAINED");\n`);
    const manager = new TerminalManager({ shell: { application: process.execPath, args: [join(value.cwd, "final-output.mjs")] } }); managers.push(manager);
    const terminal = await manager.create({ cwd: value.cwd, target: value.target });
    await until(() => manager.get(terminal.id).status === "exited");
    const text = output(manager, terminal.id);
    expect(text).toBe("🚀" + "Z".repeat(250000) + "FINAL_OUTPUT_DRAINED");
    expect(manager.get(terminal.id).exitCode).toBe(0);
  });
  test("interactive shell uses owning cwd, accepts input, preserves ANSI and reports actual exit", async () => {
    const value = await fixture(); const terminal = await create(value, { cols: 91, rows: 33 });
    expect(terminal.status).toBe("running"); expect(terminal.pid).toBeGreaterThan(0);
    expect(await run(value.manager, terminal.id, "test -t 0 && test -t 1 && printf 'REAL_TTY\\n'; pwd; stty size; printf '\\033[31mRED\\033[0m\\n'; printf 'disk readback' > result.txt")).toContain("REAL_TTY");
    expect(output(value.manager, terminal.id)).toContain(await realpath(value.cwd));
    expect(output(value.manager, terminal.id)).toContain("33 91");
    expect(output(value.manager, terminal.id)).toContain("\x1b[31mRED\x1b[0m");
    expect(await readFile(join(value.cwd, "result.txt"), "utf8")).toBe("disk readback");
    value.manager.write(terminal.id, "exit 7\r");
    await until(() => value.manager.get(terminal.id).status === "exited");
    expect(value.manager.get(terminal.id)).toMatchObject({ exitCode: 7, cancelled: false });
    await until(() => processAbsent(terminal.pid!));
    expect(() => value.manager.write(terminal.id, "echo forbidden\r")).toThrow("not running");
    value.manager.forget(terminal.id); expect(value.manager.list()).toEqual([]);
  });

  test("foreground ANSI program receives SIGWINCH with accepted dimensions", async () => {
    const value = await fixture(); const terminal = await create(value, { cols: 1, rows: 1 });
    expect(terminal).toMatchObject({ cols: 20, rows: 5 });
    await writeFile(join(value.cwd, "resize-program.mjs"), `const output = process.stdout;\nprocess.on("SIGWINCH", () => output.write("\\x1b[2J\\x1b[HWINDOW:" + output.rows + " " + output.columns + "\\n"));\nprocess.stdin.on("data", data => { if (data.toString().trim() === "quit") { output.write("\\x1b[?1049lPROGRAM_EXIT\\n"); process.exit(0); } });\noutput.write("\\x1b[?1049hPROGRAM_READY\\n");\n`);
    const executable = "'" + process.execPath.replaceAll("'", "'\\''") + "'";
    value.manager.write(terminal.id, `${executable} resize-program.mjs\r`);
    await until(() => output(value.manager, terminal.id).includes("\x1b[?1049hPROGRAM_READY"));
    expect(value.manager.resize(terminal.id, 111, 44)).toMatchObject({ cols: 111, rows: 44 });
    try { await until(() => output(value.manager, terminal.id).includes("WINDOW:44 111")); }
    catch (error) { throw new Error(`${error}\nControlled resize fixture output: ${JSON.stringify(output(value.manager, terminal.id))}`); }
    value.manager.write(terminal.id, "quit\r");
    await until(() => output(value.manager, terminal.id).includes("\x1b[?1049lPROGRAM_EXIT"));
    expect(value.manager.resize(terminal.id, 2000, 2000)).toMatchObject({ cols: 400, rows: 200 });
    expect(await run(value.manager, terminal.id, "stty size")).toContain("200 400");
  });

  test("two independent shells retain state while subscribers detach and reconnect", async () => {
    const value = await fixture(); const first = await create(value); const second = await create(value);
    expect(first.pid).not.toBe(second.pid);
    await run(value.manager, first.id, "export TERMINAL_FIXTURE=first");
    await run(value.manager, second.id, "export TERMINAL_FIXTURE=second");
    const seen: string[] = [];
    const detach = value.manager.subscribe(event => { if (event.type === "output") seen.push(event.chunk.data); });
    const cursor = value.manager.replay(first.id).lastSequence;
    detach();
    value.manager.write(first.id, "sleep .05; printf '%s' \"$TERMINAL_FIXTURE\" > detached.txt; printf 'DETACHED_FINISHED\\n'\r");
    await until(async () => await readFile(join(value.cwd, "detached.txt"), "utf8").catch(() => "") === "first");
    await until(() => output(value.manager, first.id).includes("DETACHED_FINISHED"));
    expect(seen).toEqual([]);
    const replay = value.manager.replay(first.id, cursor);
    expect(replay.chunks.map(chunk => chunk.data).join("")).toContain("DETACHED_FINISHED");
    expect(replay.truncated).toBe(false);
    expect(value.manager.get(first.id).pid).toBe(first.pid);
    expect(value.manager.replay(first.id, replay.lastSequence).chunks).toEqual([]);
    const detachAgain = value.manager.subscribe(event => { if (event.type === "output") seen.push(event.chunk.data); });
    expect(await run(value.manager, second.id, "printf 'OWN:%s\\n' \"$TERMINAL_FIXTURE\"")).toContain("OWN:second");
    expect(seen.join("")).toContain("OWN:second"); detachAgain();
    await value.manager.close(first.id);
    expect(await run(value.manager, second.id, "printf 'OTHER_SHELL_SURVIVES\\n'")).toContain("OTHER_SHELL_SURVIVES");
    expect(value.manager.list(value.target)).toHaveLength(2);
  });

  test("bounded output evicts whole sequenced chunks without corrupting UTF-8", async () => {
    const value = await fixture({ maximumOutputBytes: 4096 }); const terminal = await create(value);
    await run(value.manager, terminal.id, "printf '\\360\\237\\232\\200%.0s' {1..3000}");
    const replay = value.manager.replay(terminal.id);
    const bytes = replay.chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.data, "utf8"), 0);
    expect(bytes).toBeLessThanOrEqual(4096);
    expect(replay.firstSequence).toBeGreaterThan(1);
    expect(replay.truncated).toBe(true);
    expect(replay.chunks.map(chunk => chunk.data).join("")).not.toContain("\uFFFD");
    expect(replay.chunks.map(chunk => chunk.sequence)).toEqual([...replay.chunks.map(chunk => chunk.sequence)].sort((a, b) => a - b));
    expect(value.manager.replay(terminal.id, replay.lastSequence)).toMatchObject({ chunks: [], truncated: false });
  });

  test("raw Ctrl-C interrupts the foreground command while preserving the interactive shell", async () => {
    const value = await fixture(); const terminal = await create(value);
    value.manager.write(terminal.id, "printf 'BEFORE_SLEEP\\n'; sleep 30\r");
    await until(() => output(value.manager, terminal.id).includes("BEFORE_SLEEP"));
    value.manager.write(terminal.id, "\x03");
    expect(await run(value.manager, terminal.id, "printf 'AFTER_INTERRUPT\\n'")).toContain("AFTER_INTERRUPT");
    expect(value.manager.get(terminal.id)).toMatchObject({ pid: terminal.pid, status: "running" });
  });

  test("a failed subscriber is diagnosed and detached without killing a shell or hiding removal", async () => {
    const errors: string[] = [];
    const value = await fixture({ onListenerError: error => { errors.push(error.message); } });
    const events: string[] = [];
    value.manager.subscribe(() => { throw new Error("Controlled subscriber failure"); });
    value.manager.subscribe(event => { events.push(event.type); });
    const terminal = await create(value);
    expect(await run(value.manager, terminal.id, "printf 'STILL_RUNNING\\n'")).toContain("STILL_RUNNING");
    expect(errors).toEqual(["Controlled subscriber failure"]);
    await value.manager.close(terminal.id); value.manager.forget(terminal.id);
    expect(events).toContain("removed");
    expect(events).toContain("output");
  });

  test("explicit close and host shutdown terminate owned shell children and reap PTY children", async () => {
    const value = await fixture(); const first = await create(value); const second = await create(value);
    const result = await run(value.manager, first.id, "sleep 30 & printf 'CHILD_PID:%s\\n' \"$!\"");
    const childPid = Number(/CHILD_PID:(\d+)/.exec(result)?.[1]);
    expect(childPid).toBeGreaterThan(0);
    const child = Process.fromPid(childPid)!; expect(child.status()).toBe(ProcessStatus.Running);
    const closed = await value.manager.close(first.id);
    expect(closed).toMatchObject({ status: "exited", cancelled: true });
    await until(() => child.status() === "exited");
    await until(() => processAbsent(first.pid!) && processAbsent(childPid));
    expect(value.manager.get(second.id).status).toBe("running");
    await value.manager.shutdown();
    expect(value.manager.get(second.id)).toMatchObject({ status: "exited", cancelled: true });
    await until(() => processAbsent(second.pid!));
    await expect(value.manager.create({ cwd: value.cwd, target: value.target })).rejects.toMatchObject({ code: "TERMINALS_STOPPING" });
  });

  test("native startup failure and resource/input limits remain explicit", async () => {
    const bad = await fixture({ shell: { application: "/no-such-agent-desktop-test-shell", args: [] } });
    await expect(bad.manager.create({ cwd: bad.cwd, target: bad.target })).rejects.toMatchObject({ code: "TERMINAL_START_FAILED" });
    expect(bad.manager.list()[0]).toMatchObject({ status: "error", pid: null });
    const value = await fixture({ maximumRunning: 1, maximumRetained: 1 }); const terminal = await create(value);
    await expect(value.manager.create({ cwd: value.cwd, target: value.target })).rejects.toMatchObject({ code: "TERMINAL_LIMIT" });
    expect(() => value.manager.forget(terminal.id)).toThrow("Close this terminal");
    expect(() => value.manager.write(terminal.id, "x".repeat(65_537))).toThrow("64 KiB");
    expect(() => value.manager.resize(terminal.id, 0, 24)).toThrow("Columns");
    await value.manager.close(terminal.id);
    await expect(value.manager.create({ cwd: value.cwd, target: value.target })).rejects.toMatchObject({ code: "TERMINAL_HISTORY_LIMIT" });
    value.manager.forget(terminal.id);
    expect((await create(value)).status).toBe("running");
  });
});

test("setup exports belong to one actual shell and never enter terminal metadata or the daemon", async () => {
  const value = await fixture({ shell: { application: "/bin/bash", args: ["--noprofile", "--norc", "-i"], environment: {
    HISTFILE: "/dev/null", BASH_ENV: "/dev/null", ENV: "/dev/null", PS1: "", BASH_SILENCE_DEPRECATION_WARNING: "1",
    ENVIRONMENT_TERMINAL_VALUE: "base", ENVIRONMENT_TERMINAL_REMOVE: "base", TERM: "xterm-256color",
  } } });
  const cwd = await realpath(value.cwd);
  const daemonBefore = { value: process.env.ENVIRONMENT_TERMINAL_VALUE, remove: process.env.ENVIRONMENT_TERMINAL_REMOVE };
  const environment = { sourceRoot: cwd, worktreeRoot: cwd, environmentDelta: {
    version: 1 as const, set: { ENVIRONMENT_TERMINAL_VALUE: "session-only ' $() `quoted`\nsecond line", TERM: "invalid-project-term" }, unset: ["ENVIRONMENT_TERMINAL_REMOVE"],
  } };
  const first = await value.manager.create({ cwd, target: { sessionId: crypto.randomUUID() } }, environment);
  const second = await create(value);
  await run(value.manager, first.id, "set +H; stty -echo; printf '%s\\n' \"$ENVIRONMENT_TERMINAL_VALUE\" \"${ENVIRONMENT_TERMINAL_REMOVE-unset}\" \"$CODEX_WORKTREE_PATH\" \"$TERM\" > first-env.txt");
  await run(value.manager, second.id, "printf '%s\\n' \"$ENVIRONMENT_TERMINAL_VALUE\" \"${ENVIRONMENT_TERMINAL_REMOVE-unset}\" \"${CODEX_WORKTREE_PATH-unset}\" > second-env.txt");
  expect(await readFile(join(cwd, "first-env.txt"), "utf8")).toBe(`${environment.environmentDelta.set.ENVIRONMENT_TERMINAL_VALUE}\nunset\n${cwd}\nxterm-256color\n`);
  expect(await readFile(join(cwd, "second-env.txt"), "utf8")).toBe("base\nbase\nunset\n");
  expect(JSON.stringify(value.manager.list())).not.toContain("session-only");
  expect(JSON.stringify(value.manager.list())).not.toContain("environmentDelta");
  expect({ value: process.env.ENVIRONMENT_TERMINAL_VALUE, remove: process.env.ENVIRONMENT_TERMINAL_REMOVE }).toEqual(daemonBefore);
  await expect(value.manager.create({ cwd, target: value.target }, { ...environment, worktreeRoot: await realpath(tmpdir()) })).rejects.toThrow("different worktree");
  expect(value.manager.list()).toHaveLength(2);
});
