import type { GitActionContext, GitPushDestination, GitPushUnavailableReason, GitStatus } from "@agent-desktop/shared";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { WorkspaceError, type WorkspaceService } from "./service";

const execute = promisify(execFile);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const PUSH_URL_TIMEOUT_MS = 5_000;
const PUSH_URL_MAX_BYTES = 1024 * 1024;

interface LocalPushSnapshot {
  head: Awaited<ReturnType<VcsGitRepo["head"]>>;
  remotes: string[];
  branchRemote: string | null;
  branchMerge: string | null;
  branchPushRemote: string | null;
  remotePushDefault: string | null;
  pushDefault: string;
  upstreamLocalRef: string | null;
  selectedRemotePushConfigured: boolean;
  selectedRemotePushHash: string | null;
  selectedRemoteMirror: string | null;
  destinations: GitPushDestination[];
  selectedRemote: string | null;
  selectedTargetRef: string | null;
  unavailableReason: GitPushUnavailableReason | null;
  signature: string;
}

/**
 * Read the owner-bound local Git state needed by Commit-or-push. This performs
 * no fetch, push, config write, or other network operation. Remote freshness is
 * limited to locally cached refs.
 */
export async function readGitActionContext(
  workspace: Pick<WorkspaceService, "cwd" | "gitStatus">,
  signal?: AbortSignal,
): Promise<GitActionContext> {
  const repo = vcs.requireGit(workspace.cwd);
  if (await realpath(repo.info().repoRoot) !== workspace.cwd) {
    throw new WorkspaceError("GIT_ROOT_OUTSIDE_WORKSPACE", "Select the repository root before reading Git action context.");
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await workspace.gitStatus();
    const first = await readLocalPushSnapshot(repo, workspace.cwd, before, signal);
    const after = await workspace.gitStatus();
    const second = await readLocalPushSnapshot(repo, workspace.cwd, after, signal);
    if (headMatchesStatus(first.head, before) && headMatchesStatus(second.head, after)
      && sameStatus(before, after) && first.signature === second.signature) return assemble(after, second);
  }
  throw new WorkspaceError("GIT_CHANGED", "Git branch, status, or push configuration kept changing during inspection. Refresh before continuing.");
}

async function readLocalPushSnapshot(
  repo: VcsGitRepo,
  root: string,
  status: GitStatus,
  signal?: AbortSignal,
): Promise<LocalPushSnapshot> {
  const branch = status.branch;
  const keys = branch ? [
    `branch.${branch}.remote`,
    `branch.${branch}.merge`,
    `branch.${branch}.pushRemote`,
    "remote.pushDefault",
    "push.default",
  ] : ["remote.pushDefault", "push.default"];
  // pi-natives exposes one repository handle. Keep its reads serialized so a
  // context snapshot never depends on native calls being re-entrant.
  const head = await repo.head(signal);
  const remotesRaw = await repo.remoteList(signal);
  const values: Array<string | null | undefined> = [];
  for (const key of keys) values.push(await repo.configGet(key, signal));
  const upstreamLocalRef = branch ? await readUpstreamLocalRef(root, signal) : null;
  const remotes = [...new Set(remotesRaw)].sort();
  const configured = new Map(keys.map((key, index) => [key, configuredValue(values[index])]));
  const branchRemote = branch ? configured.get(`branch.${branch}.remote`) ?? null : null;
  const branchMerge = branch ? configured.get(`branch.${branch}.merge`) ?? null : null;
  const branchPushRemote = branch ? configured.get(`branch.${branch}.pushRemote`) ?? null : null;
  const remotePushDefault = configured.get("remote.pushDefault") ?? null;
  const pushDefault = configured.get("push.default") ?? "simple";

  let selectedRemote: string | null = null;
  let selectedTargetRef: string | null = null;
  let unavailableReason: GitPushUnavailableReason | null = null;
  let selectedRemotePushConfigured = false;
  let selectedRemotePushHash: string | null = null;
  let selectedRemoteMirror: string | null = null;
  if (status.head == null || head.commit == null || head.kind === "unborn") unavailableReason = "unborn-head";
  else if (branch == null || head.kind !== "ref" || head.branch !== branch || head.commit !== status.head) unavailableReason = "detached-head";
  else {
    const explicitRemote = branchPushRemote ?? remotePushDefault ?? branchRemote;
    if (explicitRemote != null) {
      if (explicitRemote !== "." && remotes.includes(explicitRemote)) selectedRemote = explicitRemote;
      else unavailableReason = "missing-remote";
    } else if (remotes.includes("origin")) selectedRemote = "origin";
    else if (remotes.length === 1) selectedRemote = remotes[0]!;
    else unavailableReason = remotes.length === 0 ? "missing-remote" : "ambiguous-remote";
    if (selectedRemote) {
      selectedTargetRef = pushTarget(branch, pushDefault, branchRemote, branchMerge, selectedRemote);
      if (!selectedTargetRef) unavailableReason = "push-target-unresolved";
      const remotePush = await repo.configGet(`remote.${selectedRemote}.push`, signal);
      selectedRemotePushConfigured = remotePush != null;
      selectedRemotePushHash = selectedRemotePushConfigured ? hash(remotePush) : null;
      selectedRemoteMirror = configuredValue(await repo.configGet(`remote.${selectedRemote}.mirror`, signal));
      // A configured remote refspec may select several branches and mirror mode
      // deliberately does so. The single-branch UI must require an explicit
      // destination instead of pretending those defaults are equivalent.
      if (selectedRemotePushConfigured || gitBooleanMayEnable(selectedRemoteMirror)) {
        selectedTargetRef = null;
        unavailableReason = "push-target-unresolved";
      }
    }
  }

  const validDestinations: Array<GitPushDestination | null> = [];
  for (const remote of remotes) validDestinations.push(await destination(repo, root, status, remote,
    remote === selectedRemote && selectedTargetRef ? selectedTargetRef : branch ? `refs/heads/${branch}` : null,
    Boolean(branch && (!branchRemote || !branchMerge)), upstreamLocalRef, signal));
  const destinations = validDestinations.filter((value): value is GitPushDestination => value != null);
  if (selectedRemote && selectedTargetRef && !destinations.some(value => value.remote === selectedRemote && value.targetRef === selectedTargetRef)) {
    unavailableReason = "push-target-unresolved";
  }
  const signature = hash({
    head, remotes, branchRemote, branchMerge, branchPushRemote, remotePushDefault, pushDefault, upstreamLocalRef,
    selectedRemotePushConfigured, selectedRemotePushHash, selectedRemoteMirror,
    destinations: destinations.map(value => value.revision), selectedRemote, selectedTargetRef, unavailableReason,
  });
  return { head, remotes, branchRemote, branchMerge, branchPushRemote, remotePushDefault, pushDefault, upstreamLocalRef,
    selectedRemotePushConfigured, selectedRemotePushHash, selectedRemoteMirror,
    destinations, selectedRemote, selectedTargetRef, unavailableReason, signature };
}

function assemble(status: GitStatus, snapshot: LocalPushSnapshot): GitActionContext {
  const selected = snapshot.selectedRemote && snapshot.selectedTargetRef
    ? snapshot.destinations.find(value => value.remote === snapshot.selectedRemote && value.targetRef === snapshot.selectedTargetRef)
    : undefined;
  const alternatives = snapshot.destinations.filter(value => value !== selected);
  const revision = hash({ status, pushSnapshot: snapshot.signature });
  if (selected && snapshot.unavailableReason == null) {
    return { status, revision, push: { state: "available", destination: selected, alternatives, freshness: "local-config-and-refs" } };
  }
  return { status, revision, push: { state: "unavailable", reason: snapshot.unavailableReason ?? "push-target-unresolved",
    alternatives: snapshot.destinations, freshness: "local-config-and-refs" } };
}

function pushTarget(branch: string, mode: string, branchRemote: string | null, branchMerge: string | null, selectedRemote: string): string | null {
  const current = `refs/heads/${branch}`;
  const hasUpstream = branchRemote != null && branchMerge?.startsWith("refs/heads/") === true;
  switch (mode) {
    case "current": return current;
    case "upstream": return hasUpstream && branchRemote === selectedRemote ? branchMerge : null;
    case "simple":
      if (!hasUpstream) return current;
      // A distinct pushRemote is not constrained by the fetch upstream's
      // branch name. Git simple mode sends the same-named current branch.
      if (branchRemote !== selectedRemote) return current;
      return branchMerge === current ? current : null;
    case "nothing":
    case "matching": return null;
    default: return null;
  }
}

async function destination(
  repo: VcsGitRepo,
  root: string,
  status: GitStatus,
  remote: string,
  targetRef: string | null,
  requiresUpstreamSetup: boolean,
  upstreamLocalRef: string | null,
  signal?: AbortSignal,
): Promise<GitPushDestination | null> {
  if (!targetRef?.startsWith("refs/heads/") || status.head == null) return null;
  const pushUrlHash = await effectivePushUrlHash(root, remote, signal);
  if (!pushUrlHash) return null;
  let localTrackingRef: string | null = null;
  let commitsAhead: number | null = null;
  let commitsBehind: number | null = null;
  const branchRemote = status.branch ? configuredValue(await repo.configGet(`branch.${status.branch}.remote`, signal)) : null;
  const branchMerge = status.branch ? configuredValue(await repo.configGet(`branch.${status.branch}.merge`, signal)) : null;
  if (branchRemote === remote && branchMerge === targetRef && upstreamLocalRef) {
    if (await repo.refExists(upstreamLocalRef, signal)) {
      localTrackingRef = upstreamLocalRef;
      commitsAhead = status.ahead;
      commitsBehind = status.behind;
    }
  }
  const revision = hash({ statusRevision: status.revision, branch: status.branch, head: status.head, remote, targetRef,
    requiresUpstreamSetup, localTrackingRef, commitsAhead, commitsBehind, pushUrlHash });
  return { remote, targetRef, requiresUpstreamSetup, revision, localTrackingRef, commitsAhead, commitsBehind };
}

async function readUpstreamLocalRef(root: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const result = await execute("git", ["--no-pager", "--literal-pathspecs", "-c", "color.ui=false", "-C", root,
      "rev-parse", "--verify", "--quiet", "--symbolic-full-name", "@{upstream}"], {
      encoding: "buffer", timeout: PUSH_URL_TIMEOUT_MS, maxBuffer: 4096, signal,
    });
    const value = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout).trim();
    if (!value) return null;
    if (value.startsWith("refs/") && !/[\0\r\n]/.test(value)) return value;
    throw new WorkspaceError("GIT_FAILED", "Git returned an invalid upstream reference.");
  } catch (cause) {
    if (signal?.aborted) throw cause;
    const failure = cause as { code?: unknown; stdout?: Buffer };
    if (failure.code === 1 && !failure.stdout?.length) return null;
    throw new WorkspaceError("GIT_FAILED", "Git could not read the configured upstream reference.");
  }
}

async function effectivePushUrlHash(root: string, remote: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const result = await execute("git", ["--no-pager", "--literal-pathspecs", "-c", "color.ui=false", "-C", root,
      "remote", "get-url", "--push", "--all", remote], {
      encoding: "buffer", timeout: PUSH_URL_TIMEOUT_MS, maxBuffer: PUSH_URL_MAX_BYTES, signal,
    });
    if (!result.stdout.length) return null;
    return createHash("sha256").update(result.stdout).digest("hex");
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new WorkspaceError("GIT_FAILED", "Git could not read the configured push URL.");
  }
}

function configuredValue(value: string | null | undefined): string | null {
  return value == null ? null : value.trim();
}

function gitBooleanMayEnable(value: string | null): boolean {
  if (value == null) return false;
  return !["false", "no", "off", "0"].includes(value.toLowerCase());
}

function sameStatus(left: GitStatus, right: GitStatus): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function headMatchesStatus(head: LocalPushSnapshot["head"], status: GitStatus): boolean {
  if (status.head == null) return head.commit == null && status.branch != null
    && (head.kind === "unborn" || head.kind === "ref" && head.branch === status.branch);
  if (status.branch == null) return head.kind === "detached" && head.commit === status.head;
  return head.kind === "ref" && head.branch === status.branch && head.commit === status.head;
}
