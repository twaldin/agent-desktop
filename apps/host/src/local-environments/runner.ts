import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { isProtectedLocalEnvironmentKey, type LocalEnvironmentEnvironmentDelta } from "./environment";

export type { LocalEnvironmentEnvironmentDelta } from "./environment";

export type LocalEnvironmentLifecycle = "setup" | "cleanup";
export type LocalEnvironmentOutputStream = "stdout" | "stderr";

export interface LocalEnvironmentShell {
  executable: string;
  args?: string[];
}

export interface LocalEnvironmentRunInput {
  cwd: string;
  sourceRoot: string;
  worktreeRoot: string;
  script: string;
  lifecycle: LocalEnvironmentLifecycle;
  baseEnvironment?: Record<string, string | undefined>;
  shell?: LocalEnvironmentShell;
  signal?: AbortSignal;
  onOutput?: (event: { stream: LocalEnvironmentOutputStream; chunk: Uint8Array; truncated: boolean }) => void;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface LocalEnvironmentRunResult {
  status: "succeeded" | "failed" | "cancelled";
  cancelReason?: "aborted" | "timed-out";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: number;
  finishedAt: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  /** Host-private. Transport and logs must omit these values. */
  environmentDelta: LocalEnvironmentEnvironmentDelta | null;
}

const defaultTimeoutMs = 10 * 60 * 1000;
const defaultOutputBytes = 1024 * 1024;
const maximumScriptBytes = 1024 * 1024;
const maximumEnvironmentBytes = 4 * 1024 * 1024;
const supportedShells = new Set(["sh", "bash", "dash", "ksh", "zsh"]);

function boundedInteger(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) throw new Error(`${label} must be an integer between 1 and ${maximum}.`);
  return resolved;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function ownedDirectory(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute.`);
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) throw new Error(`${label} must be a directory.`);
  return canonical;
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function resolveShell(shell?: LocalEnvironmentShell): Required<LocalEnvironmentShell> {
  const executable = shell?.executable ?? process.env.SHELL ?? (existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh");
  if (!isAbsolute(executable)) throw new Error("Local environment shell must be an absolute path.");
  if (!supportedShells.has(basename(executable))) throw new Error(`Unsupported local environment shell: ${basename(executable)}.`);
  const args = shell?.args ?? [];
  const pipefail = spawnSync(executable, [...args, "-c", "set -o pipefail"], { stdio: "ignore", timeout: 2_000 });
  if (pipefail.status !== 0 || pipefail.error) throw new Error(`Local environment shell ${basename(executable)} does not support pipefail.`);
  return { executable, args };
}

function environmentMap(source: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(source).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]));
}

function parseEnvironment(raw: Buffer): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of raw.toString("utf8").replace(/^\uFEFF/, "").split("\0")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const key = entry.slice(0, separator);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) result[key] = entry.slice(separator + 1);
  }
  return result;
}

async function readBoundedEnvironment(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(maximumEnvironmentBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximumEnvironmentBytes) throw new Error("Captured local environment exceeds 4 MiB.");
    return buffer.subarray(0, length);
  } finally { await file.close(); }
}

function environmentDelta(before: Record<string, string>, after: Record<string, string>): LocalEnvironmentEnvironmentDelta | null {
  const set: Record<string, string> = {}, unset: string[] = [];
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (isProtectedLocalEnvironmentKey(key) || before[key]?.includes("\n") || after[key]?.includes("\n")) continue;
    if (!(key in after)) unset.push(key);
    else if (before[key] !== after[key]) set[key] = after[key];
  }
  return Object.keys(set).length || unset.length ? { version: 1, set, unset } : null;
}

function terminateProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try { process.kill(-pid, signal); return true; }
  catch { return false; }
}

/** Run one sourced POSIX environment lifecycle script without logging captured environment values. */
export async function runLocalEnvironmentScript(input: LocalEnvironmentRunInput): Promise<LocalEnvironmentRunResult> {
  if (process.platform === "win32") throw new Error("Local environment scripts are not supported on Windows yet.");
  if (input.lifecycle !== "setup" && input.lifecycle !== "cleanup") throw new Error("Invalid local environment lifecycle.");
  if (Buffer.byteLength(input.script) > maximumScriptBytes) throw new Error("Local environment script exceeds 1 MiB.");
  const timeoutMs = boundedInteger(input.timeoutMs, defaultTimeoutMs, 30 * 60 * 1000, "Local environment timeout");
  const maxOutputBytes = boundedInteger(input.maxOutputBytes, defaultOutputBytes, 8 * 1024 * 1024, "Local environment output limit");
  const shell = resolveShell(input.shell);
  const [cwd, sourceRoot, worktreeRoot] = await Promise.all([
    ownedDirectory(input.cwd, "Local environment cwd"),
    ownedDirectory(input.sourceRoot, "Local environment source root"),
    ownedDirectory(input.worktreeRoot, "Local environment worktree root"),
  ]);
  if (!inside(worktreeRoot, cwd)) throw new Error("Local environment cwd must be inside the owned worktree root.");
  const startedAt = Date.now();
  if (input.signal?.aborted) return { status: "cancelled", cancelReason: "aborted", exitCode: null, signal: null, startedAt, finishedAt: Date.now(), stdout: "", stderr: "", outputTruncated: false, environmentDelta: null };

  const temporary = await mkdtemp(join(tmpdir(), "agent-desktop-local-environment-"));
  const scriptPath = join(temporary, "environment-script.sh");
  const wrapperPath = join(temporary, "environment-wrapper.sh");
  const beforePath = join(temporary, "before.env");
  const afterPath = join(temporary, "after.env");
  const captureSetup = input.lifecycle === "setup";
  const wrapper = [
    "umask 077",
    "set -eo pipefail",
    ...(captureSetup ? [
      `/usr/bin/env -0 > ${shellQuote(beforePath)}`,
      `after_capture_path=${shellQuote(afterPath)}`,
      `trap 'code=$?; if [ "$code" -eq 0 ]; then /usr/bin/env -0 > "$after_capture_path"; fi' EXIT`,
    ] : []),
    `. ${shellQuote(scriptPath)}`,
  ].join("\n");

  try {
    await Promise.all([
      writeFile(scriptPath, input.script, { mode: 0o600 }), writeFile(wrapperPath, wrapper, { mode: 0o600 }),
      ...(captureSetup ? [writeFile(beforePath, "", { mode: 0o600 }), writeFile(afterPath, "", { mode: 0o600 })] : []),
    ]);
    const environment = environmentMap(input.baseEnvironment ?? process.env);
    Object.assign(environment, {
      CODEX_SOURCE_TREE_PATH: sourceRoot, CODEX_WORKTREE_PATH: worktreeRoot,
      AGENT_SOURCE_TREE_PATH: sourceRoot, AGENT_WORKTREE_PATH: worktreeRoot,
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let retainedBytes = 0, outputTruncated = false, cancelReason: "aborted" | "timed-out" | undefined;
    const retain = (stream: LocalEnvironmentOutputStream, chunk: Buffer) => {
      const available = Math.max(0, maxOutputBytes - retainedBytes), kept = chunk.subarray(0, available);
      retainedBytes += kept.length;
      if (kept.length < chunk.length) outputTruncated = true;
      if (kept.length) (stream === "stdout" ? stdout : stderr).push(Buffer.from(kept));
      try { input.onOutput?.({ stream, chunk: new Uint8Array(kept), truncated: kept.length < chunk.length }); } catch {}
    };
    const child = spawn(shell.executable, [...shell.args, wrapperPath], {
      cwd, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", chunk => retain("stdout", Buffer.from(chunk)));
    child.stderr.on("data", chunk => retain("stderr", Buffer.from(chunk)));
    let closed = false;
    const completionPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(resolve => {
      child.once("error", error => { closed = true; resolve({ code: null, signal: null, error }); });
      child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); });
    });
    let escalation: Promise<void> | undefined;
    const terminate = (signal: NodeJS.Signals) => {
      if (child.pid && terminateProcessGroup(child.pid, signal)) return;
      try { child.kill(signal); } catch {}
    };
    const cancel = (reason: "aborted" | "timed-out") => {
      if (cancelReason || closed) return;
      cancelReason = reason;
      terminate("SIGTERM");
      escalation = new Promise(resolve => setTimeout(() => { terminate("SIGKILL"); resolve(); }, 250));
    };
    const abort = () => cancel("aborted");
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) cancel("aborted");
    const timeout = setTimeout(() => cancel("timed-out"), timeoutMs);
    const completion = await completionPromise;
    clearTimeout(timeout); input.signal?.removeEventListener("abort", abort); if (escalation) await escalation;
    if (completion.error) retain("stderr", Buffer.from(completion.error.message));
    const status = cancelReason ? "cancelled" : completion.code === 0 ? "succeeded" : "failed";
    let delta: LocalEnvironmentEnvironmentDelta | null = null;
    if (status === "succeeded" && captureSetup) {
      const [before, after] = await Promise.all([readBoundedEnvironment(beforePath), readBoundedEnvironment(afterPath)]);
      delta = environmentDelta(parseEnvironment(before), parseEnvironment(after));
    }
    return {
      status, ...(cancelReason ? { cancelReason } : {}), exitCode: completion.code, signal: completion.signal,
      startedAt, finishedAt: Date.now(), stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"),
      outputTruncated, environmentDelta: delta,
    };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
