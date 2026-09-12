import { createRoot } from "react-dom/client";
import { useState } from "react";
import type { CommandEnvelope, CommandResult } from "../../packages/shared/src/protocol";
import type { BranchQueryObserverStatus, BranchQueryRequest, LiveBranchQuery, LiveBranchResult } from "../../packages/shared/src/branch-query-transport";
import type { GitBranch, GitStatus } from "../../packages/shared/src/workspace";
import { WorkspaceState } from "../../apps/desktop/src/renderer/workspace-state";
import { BranchSelector } from "../../apps/desktop/src/renderer/BranchSelector";
import "../../apps/desktop/src/renderer/styles.css";

const deliveries: CommandEnvelope[] = [], executed: CommandEnvelope[] = [], settings: string[] = [];
let hold = false, drop = false, release: (() => void) | undefined;
function owner(id: string, session: boolean) {
  let status: GitStatus = { branch: "main", revision: `${id}:0`, head: "a".repeat(40), upstream: null, ahead: 0, behind: 0, entries: [] };
  const names = new Set(["main", "feature/one"]), receipts = new Map<string, CommandResult>();
  const branchQueryListeners = new Set<(status: BranchQueryObserverStatus) => void>();
  const branches = (): GitBranch[] => [...names].map(name => ({ name, ref: `refs/heads/${name}`, commit: "a".repeat(40), current: name === status.branch, remote: false, upstream: null, symbolicTarget: null }));
  const liveBranchResult = (query: LiveBranchQuery): LiveBranchResult => query.type === "git.recent-branches"
    ? { type: query.type, branches: [...names] }
    : query.type === "git.default-branch" ? { type: query.type, branch: "main" } : { type: query.type, base: null };
  const data = new WorkspaceState({
    subscribe: () => () => {},
    subscribeBranchQuery: listener => { branchQueryListeners.add(listener); return () => { branchQueryListeners.delete(listener); }; },
    branchQuery: async (request: BranchQueryRequest) => {
      const view: BranchQueryObserverStatus["view"] = request.action === "release" ? { phase: "released" } : {
        phase: "ready", update: { generation: 1, requiresRecovery: false, phase: "complete", result: liveBranchResult(request.query) },
      };
      const next: BranchQueryObserverStatus = { hostId: request.hostId, subscriptionId: request.subscriptionId,
        target: structuredClone(request.target), query: structuredClone(request.query), view };
      for (const listener of branchQueryListeners) listener(structuredClone(next));
    },
    workspaceQuery: async (_target, query) => {
      if (query.type === "git.status") return { type: query.type, status };
      if (query.type === "git.branches") return { type: query.type, branches: branches() };
      if (query.type === "git.search-branches") {
        const needle = query.query.toLowerCase(), found = branches().filter(branch => branch.name.toLowerCase().includes(needle) || branch.ref.toLowerCase().includes(needle));
        return { type: query.type, branches: found.slice(0, query.limit ?? 20), limitReached: found.length >= (query.limit ?? 20) };
      }
      if (query.type === "git.resolve-checkout") return { type: query.type, target: names.has(query.expression)
        ? { kind: "branch", expression: query.expression, selection: { ref: `refs/heads/${query.expression}`, commit: "a".repeat(40) } }
        : ["HEAD", "a".repeat(40)].includes(query.expression) ? { kind: "revision", expression: query.expression, commit: "a".repeat(40) } : null };
      if (query.type === "git.resolve-revision") return { type: query.type, revision: ["HEAD", "a".repeat(40)].includes(query.expression)
        ? { expression: query.expression, commit: "a".repeat(40) } : null };
      if (query.type === "git.worktrees") return { type: query.type, worktrees: [] };
      if (query.type === "files.list") return { type: query.type, entries: [] };
      throw new Error(`Unexpected controlled query ${query.type}`);
    },
    command: async envelope => {
      deliveries.push(envelope);
      const previous = receipts.get(envelope.id); if (previous) return previous;
      const command = envelope.command;
      if (command.type !== "workspace.mutate" || (command.action.type !== "git.checkout" && command.action.type !== "git.checkout-ref" && command.action.type !== "git.checkout-revision")) throw new Error("Only checkout belongs to this fixture");
      if (command.action.expectedRevision !== status.revision) throw new Error("Fixture revision mismatch");
      if (hold) await new Promise<void>(resolve => { release = resolve; });
      const action = command.action;
      if (action.type === "git.checkout-ref" && (action.selection.localBranch !== undefined || !action.selection.ref.startsWith("refs/heads/") || action.selection.commit !== "a".repeat(40))) throw new Error("This fixture expects an exact local selection");
      if (action.type === "git.checkout-revision" && (!["HEAD", "a".repeat(40)].includes(action.revision.expression) || action.revision.commit !== "a".repeat(40))) throw new Error("Unresolved fixture revision");
      const selected = action.type === "git.checkout-revision" ? null : action.type === "git.checkout-ref" ? action.selection.ref.slice("refs/heads/".length) : action.branch;
      executed.push(envelope); if (selected !== null) names.add(selected);
      status = { ...status, branch: selected, revision: `${id}:${executed.length}` };
      const result: CommandResult = { ok: true, commandId: envelope.id, value: { type: action.type, status } };
      receipts.set(envelope.id, result);
      if (drop) { drop = false; throw new Error("Controlled lost reply after checkout"); }
      return result;
    },
  }, id, session ? { sessionId: id } : { projectId: id }, { read: async () => null, write: async () => {} });
  data.setConnected(true);
  return data;
}
const a = owner("owner-a", false), b = owner("owner-b", true);
await Promise.all([a.restore(), b.restore()]);
await Promise.all([a.loadGit(), a.loadWorktrees(), b.loadGit(), b.loadWorktrees()]);
function Fixture() {
  const [selected, setSelected] = useState(a), [variant, setVariant] = useState<"composer" | "environment">("environment");
  return <main>
    <button id="owner-a" onClick={() => setSelected(a)}>Project A</button><button id="owner-b" onClick={() => setSelected(b)}>Session B</button>
    <button id="variant" onClick={() => setVariant(value => value === "composer" ? "environment" : "composer")}>Change presentation</button>
    <div className="branch-fixture" style={{ position: "fixed", right: 16, top: 80, width: 280 }}>
      <BranchSelector workspace={selected} connected={selected.connected} variant={variant} branchPrefix="codex/" repositoryName="Fixture" onOpenGitSettings={() => settings.push(selected.hostId)}/>
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
Object.assign(window, {
  branchState: () => ({ deliveries, executed, settings, ownerA: { branch: a.status?.branch, pending: a.pending?.envelope.id }, ownerB: { branch: b.status?.branch, pending: b.pending?.envelope.id },
    active: document.activeElement?.getAttribute("aria-label"), text: document.body.innerText }),
  branchControl: (control: "hold" | "release" | "drop" | "disconnect" | "reconnect" | "owner-a" | "owner-b") => {
    if (control === "hold") hold = true;
    else if (control === "release") { hold = false; release?.(); release = undefined; }
    else if (control === "drop") drop = true;
    else if (control === "disconnect" || control === "reconnect") { a.setConnected(control === "reconnect"); b.setConnected(control === "reconnect"); }
    else document.getElementById(control)?.click();
  },
});
