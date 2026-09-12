import { createRoot } from "react-dom/client";
import { useReducer, useState } from "react";
import type { CommandEnvelope, CommandResult } from "../../packages/shared/src/protocol";
import type { GitSelectionSummary, GitSubmissionIntent, GitSubmissionReceipt } from "../../packages/shared/src/git-submissions";
import type { GitActionContext, GitBranch, GitStatus } from "../../packages/shared/src/workspace";
import type { WorkspaceQuery, WorkspaceQueryResult } from "../../packages/shared/src/workspace-protocol";
import { GitSubmissionDialog } from "../../apps/desktop/src/renderer/GitSubmissionDialog";
import { WorkspaceState } from "../../apps/desktop/src/renderer/workspace-state";
import "../../apps/desktop/src/renderer/styles.css";

const statusA: GitStatus = {
  branch: "main", head: "1111111111111111111111111111111111111111", upstream: "origin/main", ahead: 1, behind: 0,
  revision: "status-r1", entries: [{ path: "src/example.ts", indexStatus: "M", worktreeStatus: "M", kind: "tracked", submodule: false }],
};
const destinationA = {
  remote: "origin", targetRef: "refs/heads/main", requiresUpstreamSetup: false, revision: "destination-r1",
  localTrackingRef: "refs/remotes/origin/main", commitsAhead: 1, commitsBehind: 0,
};
const contextA: GitActionContext = { status: statusA, revision: "context-r1", push: { state: "available", destination: destinationA, alternatives: [], freshness: "local-config-and-refs" } };
const statusB: GitStatus = {
  ...statusA, branch: "feature/context", head: "2222222222222222222222222222222222222222", upstream: "origin/feature/context", revision: "status-r2",
};
const destinationB = {
  ...destinationA, targetRef: "refs/heads/feature/context", revision: "destination-r2", localTrackingRef: "refs/remotes/origin/feature/context",
};
const contextB: GitActionContext = { status: statusB, revision: "context-r2", push: { state: "available", destination: destinationB, alternatives: [], freshness: "local-config-and-refs" } };
let currentStatus = statusA, currentContext = contextA, holdNextStatus = false;
let releaseStatus: (() => void) | undefined;
let summaryMode: "normal" | "zero" | "fail" = "normal", holdNextStagedSummary = false;
let releaseSummary: (() => void) | undefined;
const branches: GitBranch[] = [
  { name: "main", ref: "refs/heads/main", commit: statusA.head!, current: true, remote: false, upstream: "origin/main", symbolicTarget: null },
  { name: "feature/context", ref: "refs/heads/feature/context", commit: statusB.head!, current: false, remote: false, upstream: "origin/feature/context", symbolicTarget: null },
];
const queries: WorkspaceQuery[] = [], commands: CommandEnvelope[] = [], submissions: GitSubmissionIntent[] = [], closes: string[] = [];
let receipt: GitSubmissionReceipt | null = null;
let notify: ((event: { type: "workspace"; hostId: string; target: { projectId: string } }) => void) | undefined;

function selectionSummary(contextRevision: string, selectionMode: GitSelectionSummary["selectionMode"]): GitSelectionSummary {
  const reviewedRevision = contextRevision === contextB.revision ? contextB.status.revision : contextA.status.revision;
  if (summaryMode === "zero") return { selectionMode, reviewedRevision, selectedTree: `tree-zero-${contextRevision}-${selectionMode}`, additions: 0, deletions: 0, binaryFiles: 0, files: 0 };
  return { selectionMode, reviewedRevision, selectedTree: `tree-${contextRevision}-${selectionMode}`, additions: selectionMode === "staged" ? 1 : 2, deletions: selectionMode === "staged" ? 0 : 1, binaryFiles: 0, files: 1 };
}

const data = new WorkspaceState({
  subscribe: listener => { notify = listener as typeof notify; return () => { notify = undefined; }; },
  workspaceQuery: async (_target, query): Promise<WorkspaceQueryResult> => {
    queries.push(query);
    if (query.type === "git.action-context") return { type: query.type, context: currentContext };
    if (query.type === "git.submission") return { type: query.type, receipt };
    if (query.type === "git.worktrees") return { type: query.type, worktrees: [] };
    if (query.type === "git.branches") return { type: query.type, branches };
    if (query.type === "git.status") {
      if (holdNextStatus) {
        holdNextStatus = false;
        return new Promise<WorkspaceQueryResult>(resolve => { releaseStatus = () => { releaseStatus = undefined; resolve({ type: query.type, status: currentStatus }); }; });
      }
      return { type: query.type, status: currentStatus };
    }
    if (query.type === "git.selection-summary") {
      if (summaryMode === "fail") throw new Error("Controlled selection summary unavailable");
      const summary = selectionSummary(query.contextRevision, query.selectionMode);
      if (holdNextStagedSummary && query.selectionMode === "staged") {
        holdNextStagedSummary = false;
        return new Promise<WorkspaceQueryResult>(resolve => { releaseSummary = () => { releaseSummary = undefined; resolve({ type: query.type, contextRevision: query.contextRevision, summary: { ...summary, additions: 99, deletions: 98 } }); }; });
      }
      return { type: query.type, contextRevision: query.contextRevision, summary };
    }
    throw new Error(`Unexpected controlled query ${query.type}`);
  },
  command: async (envelope): Promise<CommandResult> => { commands.push(envelope); throw new Error("The dialog fixture does not execute workspace mutations"); },
}, "fixture-host", { projectId: "fixture-project" }, { read: async () => null, write: async () => {} });
data.setConnected(true);
await data.restore();

function partialReceipt(): GitSubmissionReceipt {
  return {
    commandId: "partial-command", hostId: data.hostId, target: data.target as { projectId: string }, operation: "commit-and-push",
    revision: 4, phase: "completed", outcome: "failed", cancelRequested: false,
    commit: { commit: "2222222222222222222222222222222222222222", summary: "Committed fixture selection", reviewedTree: "tree-a", committedTree: "tree-a", publishedIndexTree: "tree-a" },
    push: { outcome: "failed", sourceCommit: "2222222222222222222222222222222222222222", remote: "origin", targetRef: "refs/heads/main", upstreamRequested: true,
      applied: { remote: "confirmed", upstream: "failed" }, summary: "Remote push confirmed; upstream setup failed.", errorCode: "UPSTREAM_CONFIG_FAILED" },
    error: { code: "UPSTREAM_CONFIG_FAILED", message: "The commit and remote push completed, but upstream setup failed." }, createdAt: 1, updatedAt: 2,
  };
}

function Fixture() {
  const [open, setOpen] = useState(false), [, redraw] = useReducer(value => value + 1, 0);
  return <main>
    <button id="submission-trigger" onClick={() => setOpen(true)}>Open Commit or push</button>
    <button id="fixture-redraw" onClick={redraw}>Fixture redraw</button>
    {open && <GitSubmissionDialog data={data} supported branchPrefix="codex/" onOpenGitSettings={() => {}}
      onSubmit={intent => submissions.push(intent)} onClose={() => { closes.push("close"); setOpen(false); }}/>} 
  </main>;
}

createRoot(document.getElementById("root")!).render(<Fixture/>);
function element(selector: string) { const value = document.querySelector<HTMLElement>(selector); if (!value) throw new Error(`Missing ${selector}`); return value; }
Object.assign(window, {
  gitSubmissionState: () => {
    const dialog = document.querySelector<HTMLDialogElement>(".git-submission-dialog"), box = dialog?.getBoundingClientRect();
    return {
      open: Boolean(dialog?.open), activeId: (document.activeElement as HTMLElement | null)?.id ?? null,
      activeLabel: document.activeElement?.getAttribute("aria-label") ?? null,
      activeText: document.activeElement?.textContent?.trim() ?? null,
      branchText: document.querySelector<HTMLElement>('[aria-label="Commit to"]')?.textContent?.trim() ?? null,
      dialog: box ? { left: box.left, right: box.right, width: box.width, top: box.top, bottom: box.bottom } : null,
      viewport: { width: innerWidth, height: innerHeight }, commands: commands.length, submissions: [...submissions], closes: closes.length,
      statusRevision: data.status?.revision ?? null, contextRevision: data.gitActionContext?.revision ?? null,
      loading: [...data.loading],
      message: document.querySelector<HTMLTextAreaElement>(".git-submission-message")?.value ?? null,
      include: document.querySelector<HTMLInputElement>(".git-submission-selection input")?.checked ?? null,
      totalsLabel: document.querySelector<HTMLElement>(".git-submission-totals")?.getAttribute("aria-label") ?? null,
      newBranch: document.querySelector<HTMLInputElement>(".git-submission-new-branch input")?.value ?? null,
      selected: [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].map(item => ({ text: item.textContent?.trim(), selected: item.getAttribute("aria-selected"), disabled: item.getAttribute("aria-disabled"), reason: item.parentElement?.getAttribute("title") ?? null })),
      text: document.body.innerText,
      partialSurface: Boolean(document.querySelector(".git-submission-receipt,[data-git-submission-receipt]")),
    };
  },
  gitSubmissionTarget: (selector: string, text?: string) => {
    const candidates = [...document.querySelectorAll<HTMLElement>(selector)].filter(value => value.getClientRects().length && !value.matches(":disabled,[aria-disabled=true]"));
    const value = text === undefined ? candidates[0] : candidates.find(value => value.textContent?.includes(text));
    if (!value) throw new Error(`Missing visible target ${selector} ${text ?? ""}`); const box = value.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  },
  gitSubmissionControl: (action: "redraw" | "compositionstart" | "compositionend" | "partial" | "mismatch" | "match" | "delay-staged-summary" | "release-summary" | "zero-summary" | "fail-summary") => {
    if (action === "redraw") (document.getElementById("fixture-redraw") as HTMLButtonElement).click();
    else if (action === "compositionstart" || action === "compositionend") element(".git-submission-message").dispatchEvent(new CompositionEvent(action, { bubbles: true }));
    else if (action === "partial") { receipt = partialReceipt(); data.gitSubmission = receipt; notify?.({ type: "workspace", hostId: data.hostId, target: data.target as { projectId: string } }); (document.getElementById("fixture-redraw") as HTMLButtonElement).click(); }
    else if (action === "mismatch") {
      currentContext = contextB; currentStatus = statusB; holdNextStatus = true;
      void data.loadGit(); void data.loadGitActionContext();
    } else if (action === "match") {
      if (!releaseStatus) throw new Error("No delayed Git status query is awaiting release");
      releaseStatus();
    } else if (action === "delay-staged-summary") {
      summaryMode = "normal"; holdNextStagedSummary = true;
    } else if (action === "release-summary") {
      if (!releaseSummary) throw new Error("No delayed selection summary query is awaiting release");
      releaseSummary();
    } else {
      summaryMode = action === "zero-summary" ? "zero" : "fail";
    }
  },
});
