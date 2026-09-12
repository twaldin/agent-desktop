import type { GitRepositoryChange, GitActionContext, GitSubmissionIntent, GitSubmissionReceipt, GitSubmissionTarget } from "@agent-desktop/shared";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { HostStore, GitSubmissionAdvance } from "./store";
import type { WorkerRuntime } from "./omp-workers/runtime";
import { readGitActionContext } from "./workspace/git-action-context";
import { WorkspaceError, type PreparedGitCommitSelection, type WorkspaceService } from "./workspace/service";

const execute = promisify(execFile);
interface Owner { workspace: WorkspaceService; ownerCwd: string; ownerStamp: string; assertCurrent(): void }
export interface GitSubmissionDependencies {
  resolve(target: GitSubmissionTarget): Promise<Owner>;
  generate: WorkerRuntime["generateCommit"];
  changed(target: GitSubmissionTarget, repositoryChange?: GitRepositoryChange, gitRoot?: string): void;
  reserveBranch(cwd: string): () => void;
}

/** One original command owns generation and its subsequent Git side effects. */
export class WorkspaceSubmissions {
  private active = new Map<string, { abort: AbortController; completion: Promise<GitSubmissionReceipt> }>();
  private stopping = false;
  constructor(private store: HostStore, private dependencies: GitSubmissionDependencies) {}

  submit(id: string, hash: string, target: GitSubmissionTarget, intent: GitSubmissionIntent): Promise<GitSubmissionReceipt> {
    const existing = this.active.get(id);
    if (existing) return existing.completion;
    const receipt = this.store.beginGitSubmission(id, hash);
    if (receipt.outcome !== "pending") return Promise.resolve(receipt);
    if (this.stopping) return Promise.resolve(this.store.finishGitSubmission(id, hash, receipt.revision, {
      outcome: "failed", error: { code: "HOST_STOPPING", message: "The host stopped before this submission started. No Git operation was dispatched." },
    }));
    const abort = new AbortController();
    const completion = this.run(id, hash, target, structuredClone(intent), abort.signal);
    this.active.set(id, { abort, completion });
    void completion.finally(() => this.active.delete(id)).catch(() => {});
    return completion;
  }

  cancel(target: GitSubmissionTarget, id: string): GitSubmissionReceipt {
    const receipt = this.store.requestGitSubmissionCancel(target, id);
    this.active.get(id)?.abort.abort(new Error("Commit submission cancelled."));
    this.dependencies.changed(target);
    return receipt;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    // Git dispatch is never replayed or user-aborted. Generation can stop safely.
    for (const active of this.active.values()) active.abort.abort(new WorkspaceError("HOST_STOPPING", "The host stopped before the next Git operation."));
    await Promise.allSettled([...this.active.values()].map(value => value.completion));
  }

  private async run(id: string, hash: string, target: GitSubmissionTarget, intent: GitSubmissionIntent, signal: AbortSignal): Promise<GitSubmissionReceipt> {
    let gitRoot: string | undefined;
    const current = () => this.store.getGitSubmission(target, id)!;
    const advance = (update: GitSubmissionAdvance) => {
      const next = this.store.advanceGitSubmission(id, hash, current().revision, update);
      this.dependencies.changed(target, undefined, gitRoot); return next;
    };
    const checkCancelled = () => {
      if (current().cancelRequested) throw new WorkspaceError("GIT_SUBMISSION_CANCELLED", "The submission was cancelled before the next Git operation.");
      if (signal.aborted) throw signal.reason;
    };
    let prepared: PreparedGitCommitSelection | undefined;
    let dispatched = false;
    let partial: GitSubmissionAdvance = {};
    try {
      checkCancelled();
      const owner = await this.dependencies.resolve(target), workspace = owner.workspace;
      gitRoot = workspace.cwd;
      const configuration = await configFingerprint(workspace.cwd);
      let context = await readGitActionContext(workspace);
      if (context.revision !== intent.contextRevision || configuration !== await configFingerprint(workspace.cwd)) {
        throw new WorkspaceError("GIT_CHANGED", "Git changed after review. Refresh before submitting.");
      }
      const initialHead = context.status.head;
      if (intent.operation !== "commit" && !findDestination(context, intent.destination, intent.branch)) throw new WorkspaceError("GIT_CHANGED", "The selected push destination changed after review.");
      const recovery = { ownerCwd: owner.ownerCwd, ownerStamp: owner.ownerStamp, gitRoot: workspace.cwd };
      const assertOwner = async () => {
        const fresh = await this.dependencies.resolve(target);
        if (fresh.ownerCwd !== owner.ownerCwd || fresh.ownerStamp !== owner.ownerStamp || fresh.workspace.cwd !== workspace.cwd) {
          throw new WorkspaceError("WORKSPACE_CHANGED", "This project or session moved to another workspace. Reopen its review.");
        }
      };
      advance({ recovery });

      if (intent.operation !== "push") {
        const switchBranch = intent.branch && (intent.branch.create || intent.branch.name !== context.status.branch);
        advance({ ...(switchBranch ? {} : { phase: "preparing" as const }), progress: "Preparing selected changes" });
        prepared = await workspace.prepareCommitSelection(intent.selectionMode, context.status.revision);
        advance({ recovery: { ...recovery, privateIndexPath: prepared.privateIndexPath } });
        checkCancelled();
        if (switchBranch && intent.branch) {
          if (!intent.branch.create) {
            const branch = (await workspace.branches()).find(branch => !branch.remote && branch.name === intent.branch!.name);
            if (!branch || branch.commit !== initialHead) throw new WorkspaceError("GIT_BRANCH_REVIEW_REQUIRED", "Switch to that branch and review its changes before committing.");
          }
          await assertOwner(); await prepared.assertCurrent(); checkCancelled();
          const release = this.dependencies.reserveBranch(workspace.cwd);
          try {
            advance({ phase: "branch", progress: "Changing branch" }); dispatched = true;
            let status;
            try { status = await workspace.checkout(intent.branch.name, context.status.revision, intent.branch.create, owner.assertCurrent); }
            catch (error) {
              if (error instanceof WorkspaceError && error.code !== "OUTCOME_UNKNOWN") dispatched = false;
              throw error;
            }
            partial.branch = { before: context.status.branch, after: intent.branch.name, head: status.head };
            advance(partial); dispatched = false;
          } finally { release(); }
          const old = prepared;
          advance({ phase: "preparing", progress: "Verifying selected changes" });
          context = await readGitActionContext(workspace);
          try { prepared = await workspace.prepareCommitSelection(intent.selectionMode, context.status.revision); }
          finally { await old.dispose(); }
          advance({ recovery: { ...recovery, privateIndexPath: prepared.privateIndexPath } });
          if (context.status.head !== initialHead || prepared.selectedTree !== old.selectedTree) throw new WorkspaceError("GIT_CHANGED", "The branch change altered the selected changes. Review them before continuing.");
        }
        let message = intent.message;
        if (!message.trim()) {
          advance({ phase: "generating", progress: "Generating commit message" });
          const generated = await this.dependencies.generate({ cwd: workspace.cwd, diff: prepared.diff, stat: prepared.stat, numstat: prepared.numstat }, {
            signal, onProgress: progress => { if (!current().cancelRequested) advance({ progress: progress.slice(0, 4096) }); },
          });
          if (generated.validationError || generated.stagedAll || !generated.message?.trim() || generated.message.length > 1_000_000 || generated.message.includes("\0")) {
            throw new WorkspaceError("COMMIT_GENERATION_INVALID", "OMP did not produce a valid commit message for the selected changes.");
          }
          message = generated.message; advance({ generatedMessage: message });
        }
        await assertOwner(); checkCancelled(); await prepared.assertCurrent(); checkCancelled();
        advance({ phase: "committing", progress: "Committing selected changes" }); dispatched = true;
        try { partial.commit = await workspace.commitPreparedSelection(prepared, message, owner.assertCurrent); }
        catch (error) {
          // The consumer owns dispatch classification, including hooks and index
          // publication. Its definite failures must not become uncertain here.
          if (error instanceof WorkspaceError && error.code !== "OUTCOME_UNKNOWN") dispatched = false;
          throw error;
        }
        advance(partial); dispatched = false;
      }

      if (intent.operation !== "commit") {
        await assertOwner(); checkCancelled();
        if (configuration !== await configFingerprint(workspace.cwd)) throw new WorkspaceError("GIT_CHANGED", "Push configuration changed during submission. The completed commit is preserved.");
        context = await readGitActionContext(workspace);
        const sourceCommit = partial.commit?.commit ?? initialHead;
        if (!sourceCommit || context.status.head !== sourceCommit || !context.status.branch) throw new WorkspaceError("GIT_CHANGED", "The source branch or commit changed before push.");
        const destination = destinations(context).find(value => value.remote === intent.destination?.remote && value.targetRef === intent.destination?.targetRef);
        if (!destination) throw new WorkspaceError("GIT_CHANGED", "The selected destination is no longer available.");
        advance({ phase: "pushing", progress: "Pushing commit" }); dispatched = true;
        try { partial.push = await workspace.pushPreparedDestination({ contextRevision: context.revision, sourceCommit, branch: context.status.branch, destination }, owner.assertCurrent); }
        catch (error) {
          // Push returns a partial receipt after dispatch. WorkspaceErrors here
          // describe failed pre-dispatch review/configuration checks.
          if (error instanceof WorkspaceError && error.code !== "OUTCOME_UNKNOWN") dispatched = false;
          throw error;
        }
        advance(partial); dispatched = false;
        if (partial.push.outcome !== "succeeded") return this.store.finishGitSubmission(id, hash, current().revision, {
          ...partial, outcome: partial.push.outcome, error: { code: partial.push.errorCode ?? "GIT_PUSH_FAILED", message: partial.push.summary },
        });
      }
      return this.store.finishGitSubmission(id, hash, current().revision, { ...partial, outcome: "succeeded" });
    } catch (error) {
      const code = error instanceof WorkspaceError ? error.code : "GIT_SUBMISSION_FAILED";
      const outcome = dispatched || code === "OUTCOME_UNKNOWN" ? "unknown" : current().cancelRequested || code === "GIT_SUBMISSION_CANCELLED" ? "cancelled" : "failed";
      return this.store.finishGitSubmission(id, hash, current().revision, { ...partial, outcome,
        error: { code: outcome === "unknown" ? "OUTCOME_UNKNOWN" : code,
          message: outcome === "unknown" ? "A Git operation may have applied. Inspect this original submission before trying again."
            : code === "GIT_SUBMISSION_FAILED" ? "The submission could not finish. Any confirmed Git operations are preserved below."
            : error instanceof Error ? error.message : "Git submission failed." },
      });
    } finally {
      if (prepared) await prepared.dispose().catch(error => {
        // An uncertain consumer deliberately retains its private index.
        if (!(error instanceof WorkspaceError && error.code === "OUTCOME_UNKNOWN")) console.error("Git preparation cleanup failed; its recorded recovery path was retained.");
      });
      this.dependencies.changed(target, undefined, gitRoot);
    }
  }
}

function destinations(context: GitActionContext) { return context.push.state === "available" ? [context.push.destination, ...context.push.alternatives] : context.push.alternatives; }
function findDestination(context: GitActionContext, selection: GitSubmissionIntent["destination"], branch?: GitSubmissionIntent["branch"]) {
  if (!selection) return undefined;
  return destinations(context).find(value => {
    if (value.remote !== selection.remote || value.revision !== selection.revision) return false;
    if (value.targetRef === selection.targetRef && value.requiresUpstreamSetup === selection.requiresUpstreamSetup) return true;
    return branch && branch.name !== context.status.branch && selection.targetRef === `refs/heads/${branch.name}` && selection.requiresUpstreamSetup;
  });
}
/** Hash effective local config without exposing credential-bearing values. */
async function configFingerprint(cwd: string): Promise<string> {
  try {
    const result = await execute("git", ["--no-pager", "-C", cwd, "config", "--null", "--list", "--includes"], { encoding: "buffer", timeout: 5000, maxBuffer: 1024 * 1024 });
    return createHash("sha256").update(result.stdout).digest("hex");
  } catch { throw new WorkspaceError("GIT_FAILED", "Git push configuration could not be read."); }
}
