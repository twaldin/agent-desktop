import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep, dirname } from "node:path";
import type { ModifierReleaseResult, NativeModifier } from "@agent-desktop/shared";

export function resolveModifierMonitor(root: string): string {
  if (!isAbsolute(root)) throw new Error("Modifier monitor root must be absolute.");
  const owner = realpathSync(root), path = realpathSync(join(owner, "native/modifier-release"));
  const child = relative(owner, path), stat = statSync(path);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child) || !stat.isFile() || !(stat.mode & 0o111)) {
    throw new Error("Modifier monitor is missing or outside the app.");
  }
  return path;
}

type MonitorChild = ChildProcessByStdio<null, Readable, null>;
type SpawnMonitor = (path: string, args: string[]) => MonitorChild;
const spawnMonitor: SpawnMonitor = (path, args) => spawn(path, args, {
  cwd: dirname(path), env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "ignore"], detached: false,
});

/** A result is trusted only after a valid response AND clean child close. Cancellation
 * waits for close too, so a replacement never overlaps an unreaped predecessor. */
export function watchNativeModifier(path: string, modifier: NativeModifier, signal: AbortSignal,
  launch: SpawnMonitor = spawnMonitor, limits = { watchMs: 600_000, killMs: 250 }): Promise<ModifierReleaseResult> {
  if (signal.aborted) return Promise.resolve("cancelled");
  return new Promise(resolve => {
    let child: MonitorChild;
    try { child = launch(path, [modifier]); } catch { resolve("unavailable"); return; }
    let output = "", invalid = false, stopping = false, cancelled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      killTimer = setTimeout(() => child.kill("SIGKILL"), limits.killMs);
      child.kill("SIGTERM");
    };
    const abort = () => { cancelled = true; stop(); };
    const timeout = setTimeout(() => { invalid = true; stop(); }, limits.watchMs);
    const data = (chunk: Buffer | string) => {
      if (invalid) return;
      output += chunk.toString();
      if (Buffer.byteLength(output) > 64) { invalid = true; output = ""; stop(); }
    };
    const error = () => { invalid = true; stop(); };
    const close = (code: number | null) => {
      clearTimeout(timeout); clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
      child.stdout.removeListener("data", data);
      child.removeListener("error", error);
      resolve(cancelled ? "cancelled" : !invalid && !stopping && code === 0 && output === "up\n" ? "released" : "unavailable");
    };
    child.stdout.on("data", data);
    child.once("error", error);
    child.once("close", close);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

type LaunchWatch = (modifier: NativeModifier, signal: AbortSignal) => Promise<ModifierReleaseResult>;
interface Watch { id: string; modifier: NativeModifier; abort: AbortController; done: Promise<ModifierReleaseResult> }

/** IPC owners are WebContents IDs, never a renderer-supplied host/window ID. */
export class ModifierReleaseWatches {
  private readonly watches = new Map<number, Watch>();
  private disposed = false;
  private pauses = 0;
  constructor(private readonly launch: LaunchWatch) {}
  watch(owner: number, id: unknown, modifier: unknown): Promise<ModifierReleaseResult> {
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(id) || typeof modifier !== "string" || !["meta", "control", "alt"].includes(modifier)) {
      return Promise.reject(new Error("Invalid modifier release request."));
    }
    if (this.disposed || this.pauses) return Promise.resolve("unavailable");
    const previous = this.watches.get(owner);
    if (previous?.id === id) return previous.modifier === modifier ? previous.done : Promise.reject(new Error("Modifier request ID already used."));
    previous?.abort.abort();
    const abort = new AbortController();
    const watch: Watch = { id, modifier: modifier as NativeModifier, abort, done: Promise.resolve("cancelled") };
    watch.done = (previous?.done ?? Promise.resolve()).then(async () => {
      if (abort.signal.aborted || this.disposed || this.pauses) return "cancelled" as const;
      try { return await this.launch(modifier as NativeModifier, abort.signal); } catch { return "unavailable" as const; }
    }).finally(() => { if (this.watches.get(owner) === watch) this.watches.delete(owner); });
    this.watches.set(owner, watch);
    return watch.done;
  }
  cancel(owner: number, id?: unknown): void {
    const watch = this.watches.get(owner);
    if (watch && (id === undefined || id === watch.id)) watch.abort.abort();
  }
  /** Reversible quit preparation: no admission until the owner releases the pause. */
  async pauseAndDrain(): Promise<() => void> {
    this.pauses++;
    const pending = [...this.watches.values()];
    for (const watch of pending) watch.abort.abort();
    await Promise.all(pending.map(watch => watch.done));
    let released = false;
    return () => { if (!released) { released = true; this.pauses--; } };
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    const pending = [...this.watches.values()];
    for (const watch of pending) watch.abort.abort();
    await Promise.all(pending.map(watch => watch.done));
  }
}
