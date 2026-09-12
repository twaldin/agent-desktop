import { spawn } from "node:child_process";
import type { GitBranch } from "@agent-desktop/shared";
import { WorkspaceError } from "./service";

const normalize = (value: string) => value.toLowerCase().replace(/[-_/.\s]+/g, " ").trim();
export function branchSearchPatterns(remote: boolean, terms: readonly string[]): string[] {
  if (!remote) return ["refs/heads"];
  const longest = [...terms].filter(term => term.length >= 2 && /^[a-z0-9]+$/.test(term)).sort((a, b) => b.length - a.length)[0];
  if (!longest) return ["refs/remotes"];
  const pattern = Array.from(longest, char => char === "k" ? "[kKK]" : /[a-z]/.test(char) ? `[${char}${char.toUpperCase()}]` : char).join("");
  return [`refs/remotes/**/*${pattern}*`, `refs/remotes/**/*${pattern}*/**`];
}

/** Checkout collapses remote short names; starting-state presentation preserves
 * full remote refs. Neither mode resolves a selection or fetches a remote. */
export async function searchGitBranches(cwd: string, query: string, limit: number, timeoutMs: number, signal?: AbortSignal, preserveRemoteRefs = false): Promise<{ branches: GitBranch[]; limitReached: boolean }> {
  const terms = normalize(query).split(" ").filter(Boolean), branches: GitBranch[] = [], localNames = new Set<string>();
  const cap = Math.max(1, Math.min(limit, 20));
  signal?.throwIfAborted();
  if (!terms.length) return { branches, limitReached: false };
  for (const remote of [false, true]) {
    const seen = new Set<string>();
    await readRefs(cwd, remote, terms, timeoutMs, signal, line => {
      const fields = line.split("\0"), [ref, commit, head, upstream, symbolicTarget] = fields;
      if (fields.length !== 5 || !ref || !commit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))
        throw new WorkspaceError("GIT_FAILED", "Git returned an invalid branch search record.");
      const prefix = remote ? "refs/remotes/" : "refs/heads/";
      if (!ref.startsWith(prefix)) throw new WorkspaceError("GIT_FAILED", "Git returned a branch outside the requested namespace.");
      const qualified = ref.slice(prefix.length), slash = qualified.indexOf("/");
      const shortName = remote ? slash < 0 ? "" : qualified.slice(slash + 1) : qualified;
      const name = remote && preserveRemoteRefs ? qualified : shortName;
      const identity = remote && preserveRemoteRefs ? ref : shortName;
      if (!shortName || remote && shortName === "HEAD" || seen.has(identity) || remote && localNames.has(shortName)
        || !terms.every(term => normalize(name).includes(term))) return false;
      seen.add(identity);
      if (!remote) localNames.add(shortName);
      branches.push({ name, ref, commit, remote, current: head === "*", upstream: upstream || null, symbolicTarget: symbolicTarget || null });
      return branches.length >= cap;
    });
    signal?.throwIfAborted();
    if (branches.length >= cap) break;
  }
  // Stopping at the native cap cannot establish whether an additional match
  // exists. Expose cap attainment rather than inventing a hasMore result.
  return { branches, limitReached: branches.length >= cap };
}

/** Drain and reap each child before starting the next namespace. Cap stop is
 * successful; caller abort, timeout, malformed output and Git failure are not. */
function readRefs(cwd: string, remote: boolean, terms: string[], timeoutMs: number, signal: AbortSignal | undefined, record: (line: string) => boolean): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-lazy-fetch", "--no-pager", "--literal-pathspecs", "-c", "color.ui=false", "-C", cwd, "for-each-ref", "--sort=-committerdate",
      ...branchSearchPatterns(remote, terms), "--format=%(refname)%00%(objectname)%00%(HEAD)%00%(upstream:short)%00%(symref)"],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "", detail = "", stderrBytes = 0, capped = false, failure: unknown, killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 250);
    };
    const fail = (cause: unknown) => { failure ??= cause; stop(); };
    const aborted = () => fail(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
    const timer = setTimeout(() => fail(new WorkspaceError("GIT_TIMEOUT", "Branch search exceeded its time limit.")), timeoutMs);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
    const accept = (line: string) => {
      if (Buffer.byteLength(line, "utf8") > 1024 * 1024) throw new WorkspaceError("GIT_OUTPUT_TOO_LARGE", "A branch search record exceeds 1 MiB.");
      return record(line);
    };
    const consume = (text: string, final = false) => {
      pending += text;
      let end: number;
      while (!failure && !capped && (end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (line && accept(line)) { capped = true; stop(); }
      }
      if (!failure && !capped && final && pending) { if (accept(pending)) capped = true; pending = ""; }
      if (!capped && Buffer.byteLength(pending, "utf8") > 1024 * 1024) throw new WorkspaceError("GIT_OUTPUT_TOO_LARGE", "A branch search record exceeds 1 MiB.");
    };
    child.stdout.on("data", (bytes: Buffer) => {
      if (failure || capped) return;
      try { consume(decoder.decode(bytes, { stream: true })); }
      catch (cause) { fail(cause instanceof WorkspaceError ? cause : new WorkspaceError("INVALID_GIT_ENCODING", "Git branch output is not valid UTF-8.")); }
    });
    child.stderr.on("data", (bytes: Buffer) => {
      stderrBytes += bytes.length; detail += bytes.toString("utf8").slice(0, Math.max(0, 32_000 - detail.length));
      if (stderrBytes > 8 * 1024 * 1024) fail(new WorkspaceError("GIT_OUTPUT_TOO_LARGE", "Git branch error output exceeds 8 MiB."));
    });
    child.on("error", cause => fail(new WorkspaceError("GIT_FAILED", cause.message)));
    child.on("close", (code, termination) => {
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", aborted);
      if (signal?.aborted) { reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError")); return; }
      if (failure) { reject(failure); return; }
      if (!capped && (code !== 0 || termination)) { reject(new WorkspaceError("GIT_FAILED", detail.trim() || "Git branch search failed.")); return; }
      try { if (!capped) consume(decoder.decode(), true); resolve(); }
      catch (cause) { reject(cause instanceof WorkspaceError ? cause : new WorkspaceError("INVALID_GIT_ENCODING", "Git branch output is not valid UTF-8.")); }
    });
  });
}
