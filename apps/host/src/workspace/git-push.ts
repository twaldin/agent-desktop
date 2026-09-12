import type { GitActionContext, GitPushDestination, GitStatus } from "@agent-desktop/shared";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readGitActionContext } from "./git-action-context";
import { WorkspaceError } from "./service";
const execute = promisify(execFile);

export interface GitPreparedPushInput { contextRevision: string; sourceCommit: string; branch: string; destination: GitPushDestination }
export interface GitPreparedPushResult {
  outcome: "succeeded" | "failed" | "unknown"; sourceCommit: string; remote: string; targetRef: string; upstreamRequested: boolean;
  applied: { remote: "confirmed" | "rejected" | "unknown"; upstream: "not-requested" | "configured" | "failed" | "unknown" };
  summary: string; errorCode?: string;
}
interface Reader { cwd: string; gitStatus(): Promise<GitStatus> }
export interface GitPushRun { ok: boolean; stdout: Buffer; stderr: Buffer; timeout: boolean; overflow: boolean; exitCode: number | null }
export type GitPushRunner = (cwd: string, args: string[], timeout: number) => Promise<GitPushRun>;
export const defaultGitPushRunner: GitPushRunner = run;

export async function pushPreparedDestination(workspace: Reader, input: GitPreparedPushInput, timeoutMs = 30_000, runner: GitPushRunner = run, beforeDispatch?: () => void): Promise<GitPreparedPushResult> {
  validate(input);
  const first = await readGitActionContext(workspace), current = await readGitActionContext(workspace);
  if (JSON.stringify(first) !== JSON.stringify(current) || current.revision !== input.contextRevision
    || current.status.branch !== input.branch || current.status.head !== input.sourceCommit || !find(current, input.destination)) {
    throw new WorkspaceError("GIT_CHANGED", "Git branch, HEAD, or push destination changed after review.");
  }
  const mirror = await config(workspace.cwd, `remote.${input.destination.remote}.mirror`, timeoutMs, runner, true);
  if (mayEnable(mirror)) throw new WorkspaceError("PUSH_CONFIG_UNSUPPORTED", "Mirror push configuration cannot be used for a single-branch push.");
  const base = { sourceCommit: input.sourceCommit, remote: input.destination.remote, targetRef: input.destination.targetRef,
    upstreamRequested: input.destination.requiresUpstreamSetup };
  // Explicit --no-follow-tags plus one full SHA refspec prevents configured
  // tag, matching, force, mirror, or default-ref expansion.
  beforeDispatch?.();
  const pushed = await runner(workspace.cwd, ["push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no", "--", input.destination.remote,
    `${input.sourceCommit}:${input.destination.targetRef}`], timeoutMs);
  if (!pushed.ok) {
    if (pushed.timeout || pushed.overflow) return { ...base, outcome: "unknown", applied: { remote: "unknown", upstream: "not-requested" }, summary: "The push outcome could not be confirmed.", errorCode: pushed.timeout ? "GIT_TIMEOUT" : "GIT_OUTPUT_TOO_LARGE" };
    if (rejected(pushed)) return { ...base, outcome: "failed", applied: { remote: "rejected", upstream: "not-requested" }, summary: "The remote rejected the selected branch update.", errorCode: "PUSH_REJECTED" };
    return { ...base, outcome: "unknown", applied: { remote: "unknown", upstream: "not-requested" }, summary: "The push outcome could not be confirmed.", errorCode: pushed.timeout ? "GIT_TIMEOUT" : pushed.overflow ? "GIT_OUTPUT_TOO_LARGE" : "PUSH_UNCONFIRMED" };
  }
  if (!confirmed(pushed, input.destination.targetRef)) return { ...base, outcome: "unknown", applied: { remote: "unknown", upstream: "not-requested" }, summary: "Git returned without one exact destination receipt.", errorCode: "PUSH_UNCONFIRMED" };
  if (!input.destination.requiresUpstreamSetup) return { ...base, outcome: "succeeded", applied: { remote: "confirmed", upstream: "not-requested" }, summary: "Push completed." };
  const headValue = await inspect(workspace.cwd, ["rev-parse", "--verify", "HEAD"], timeoutMs, runner);
  const branchValue = await inspect(workspace.cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], timeoutMs, runner);
  if (headValue === null || branchValue === null) return { ...base, outcome: "unknown", applied: { remote: "confirmed", upstream: "unknown" }, summary: "Push completed, but local branch inspection failed.", errorCode: "UPSTREAM_UNCONFIRMED" };
  if (headValue !== input.sourceCommit || branchValue !== input.branch) return { ...base, outcome: "failed", applied: { remote: "confirmed", upstream: "failed" }, summary: "Push completed, but the local branch changed before upstream configuration.", errorCode: "GIT_CHANGED" };
  const remoteSet = await runner(workspace.cwd, ["config", "--local", "--replace-all", `branch.${input.branch}.remote`, input.destination.remote], timeoutMs);
  if (!remoteSet.ok) return configFailure(base, remoteSet);
  const mergeSet = await runner(workspace.cwd, ["config", "--local", "--replace-all", `branch.${input.branch}.merge`, input.destination.targetRef], timeoutMs);
  if (!mergeSet.ok) return configFailure(base, mergeSet);
  let configuredRemote: string | null, configuredMerge: string | null;
  try {
    configuredRemote = await config(workspace.cwd, `branch.${input.branch}.remote`, timeoutMs, runner, false);
    configuredMerge = await config(workspace.cwd, `branch.${input.branch}.merge`, timeoutMs, runner, false);
  } catch {
    return { ...base, outcome: "unknown", applied: { remote: "confirmed", upstream: "unknown" }, summary: "Push completed, but upstream configuration could not be inspected.", errorCode: "UPSTREAM_UNCONFIRMED" };
  }
  if (configuredRemote !== input.destination.remote || configuredMerge !== input.destination.targetRef) return { ...base, outcome: "unknown", applied: { remote: "confirmed", upstream: "unknown" }, summary: "Push completed, but upstream configuration could not be verified.", errorCode: "UPSTREAM_UNCONFIRMED" };
  return { ...base, outcome: "succeeded", applied: { remote: "confirmed", upstream: "configured" }, summary: "Push completed and upstream configured." };
}
function validate(input: GitPreparedPushInput) {
  if (!input || !/^[a-f0-9]{64}$/.test(input.contextRevision) || !/^[a-f0-9]{40,64}$/.test(input.sourceCommit) || !input.branch
    || !input.destination?.remote || !input.destination.targetRef.startsWith("refs/heads/") || !/^[a-f0-9]{64}$/.test(input.destination.revision)) throw new WorkspaceError("INVALID_PUSH", "An exact reviewed Git push destination is required.");
}
function find(context: GitActionContext, wanted: GitPushDestination) { const all = context.push.state === "available" ? [context.push.destination, ...context.push.alternatives] : context.push.alternatives; return all.some(value => value.remote === wanted.remote && value.targetRef === wanted.targetRef && value.requiresUpstreamSetup === wanted.requiresUpstreamSetup && value.revision === wanted.revision); }
async function run(cwd: string, args: string[], timeout: number): Promise<GitPushRun> { try { const value = await execute("git", ["--no-pager", "--literal-pathspecs", "-c", "color.ui=false", "-C", cwd, ...args], { encoding: "buffer", timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }); return { ok: true, stdout: value.stdout, stderr: value.stderr, timeout: false, overflow: false, exitCode: 0 }; } catch (cause) { const error = cause as { killed?: boolean; code?: unknown; stdout?: Buffer; stderr?: Buffer }; return { ok: false, stdout: error.stdout ?? Buffer.alloc(0), stderr: error.stderr ?? Buffer.alloc(0), timeout: error.killed === true, overflow: error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", exitCode: typeof error.code === "number" ? error.code : null }; } }
function statusLines(result: GitPushRun) { return result.stdout.toString("utf8").split(/\r?\n/).filter(line => /^[=*!+\- ]\t/.test(line)); }
function rejected(result: GitPushRun) { const lines = statusLines(result); return lines.length === 1 && lines[0]!.startsWith("!\t") && /\[(?:rejected|remote rejected)\]/.test(lines[0]!); }
function confirmed(result: GitPushRun, targetRef: string) { const lines = statusLines(result); return lines.length === 1 && !lines[0]!.startsWith("!") && lines[0]!.split("\t")[1]?.endsWith(`:${targetRef}`) === true; }
function mayEnable(value: string | null) { return value !== null && !["false", "no", "off", "0"].includes(value.toLowerCase()); }
async function inspect(cwd: string, args: string[], timeout: number, runner: GitPushRunner) { const value = await runner(cwd, args, timeout); return value.ok ? value.stdout.toString("utf8").trim() : null; }
async function config(cwd: string, key: string, timeout: number, runner: GitPushRunner, absenceAllowed: boolean) { const value = await runner(cwd, ["config", "--get", key], timeout); if (value.ok) return value.stdout.toString("utf8").trim(); if (absenceAllowed && value.exitCode === 1 && !value.stdout.length && !value.stderr.length) return null; throw new WorkspaceError(value.timeout ? "GIT_TIMEOUT" : value.overflow ? "GIT_OUTPUT_TOO_LARGE" : "GIT_FAILED", "Git configuration could not be read safely."); }
function configFailure(base: Omit<GitPreparedPushResult, "outcome" | "applied" | "summary" | "errorCode">, result: GitPushRun): GitPreparedPushResult { return result.timeout || result.overflow ? { ...base, outcome: "unknown", applied: { remote: "confirmed", upstream: "unknown" }, summary: "Push completed, but upstream configuration is unconfirmed.", errorCode: result.timeout ? "GIT_TIMEOUT" : "GIT_OUTPUT_TOO_LARGE" } : { ...base, outcome: "failed", applied: { remote: "confirmed", upstream: "failed" }, summary: "Push completed, but upstream configuration failed.", errorCode: "UPSTREAM_CONFIG_FAILED" }; }
