import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Icon } from "./Icons";
import type { GitCheckoutRefusal } from "../../../../packages/shared/src/checkout-refusal";
import type { GitSubmissionIntent } from "../../../../packages/shared/src/git-submissions";
import { GitSubmissionDialog, GitSubmissionReceiptView } from "./GitSubmissionDialog";
import { continueBranchSwitch } from "./branch-switch-continuation";
import type { WorkspaceState } from "./workspace-state";
import { retainWorkspace } from "./workspace-lease";
import { BranchSwitchChanges } from "./BranchSwitchChanges";
import { BranchSwitchContent } from "./BranchSwitchContent";
import "./branch-switch-dialog.css";

export interface BranchSwitchRequest { data: WorkspaceState; refusal: GitCheckoutRefusal }

/** Mounted by App for the active owner, independently of either branch menu.
 * Closing a working dialog hides it; navigation/unmount cancels continuation,
 * not an already-admitted native commit or checkout. */
export function BranchSwitchDialog({ request, supported, branchPrefix, onOpenGitSettings, onClose, isCurrent }: {
  request: BranchSwitchRequest; supported: boolean; branchPrefix: string; onOpenGitSettings(): void; onClose(): void; isCurrent(): boolean;
}) {
  const { data } = request;
  const [refusal, setRefusal] = useState(request.refusal);
  const [phase, setPhase] = useState<"conflict" | "commit" | "working" | "error">("conflict");
  const [work, setWork] = useState<{ kind: "commit" | "checkout"; id: string }>();
  const [error, setError] = useState<string>();
  const [hidden, setHidden] = useState(false);
  const [, redraw] = useReducer(value => value + 1, 0);
  const alive = useRef(false), following = useRef(false), submitting = useRef(false), invalidated = useRef(false);
  const primary = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useLayoutEffect(() => {
    const off = data.subscribe(() => {
      // A committed controller loss cannot revive a continuation merely because
      // reconnect is batched before the next App render.
      if (!data.connected) { invalidated.current = true; setError("Connection interrupted. Inspect the original operation before switching branches."); setPhase("error"); }
      redraw();
    });
    return off;
  }, [data]);
  useEffect(() => retainWorkspace(data), [data]);
  const current = () => alive.current && !invalidated.current && isCurrent() && data.connected;
  const blocked = !supported ? "Update the owning host to commit these changes." : !data.connected ? "Reconnect to this host." : data.cacheWarning
    ?? (!data.restored || data.busy || data.pending ? "Wait for the original workspace operation." : undefined);
  function finish() { alive.current = false; onClose(); }
  async function submit(intent: GitSubmissionIntent) {
    if (!current() || submitting.current) return;
    submitting.current = true; setError(undefined); setPhase("working");
    try {
      const id = await data.mutateCommand({ type: "git.submit", intent: structuredClone(intent) }, 10, current);
      if (!current()) return;
      if (!id) { setError("The commit was not submitted. Refresh before trying again."); setPhase("error"); return; }
      setWork({ kind: "commit", id });
    } catch (cause) { if (current()) { setError(String(cause)); setPhase("error"); } }
  }
  useEffect(() => {
    if (phase !== "working" || !work || following.current || !current()) return;
    if (work.kind === "checkout") {
      if (data.mutationReceipt?.commandId === work.id) { finish(); return; }
      if (data.checkoutRefusal?.commandId === work.id) { setRefusal(data.checkoutRefusal); submitting.current = false; setWork(undefined); setPhase("conflict"); setHidden(false); return; }
      if (data.pending?.envelope.id === work.id || data.busy) return;
      setError(data.errors.action ?? "The original checkout was not confirmed."); setPhase("error"); return;
    }
    const receipt = data.gitSubmission;
    if (data.busy || data.pending?.envelope.id === work.id) return;
    if (receipt?.commandId === work.id && (receipt.outcome === "pending" || receipt.outcome === "unknown")) return;
    if (!receipt || receipt.commandId !== work.id || receipt.outcome !== "succeeded" || !receipt.commit) {
      setError(receipt?.commandId === work.id ? receipt.error?.message ?? "No successful commit was confirmed. The branch was not switched." : data.errors.action ?? "The original commit was not confirmed."); setPhase("error"); return;
    }
    following.current = true;
    void continueBranchSwitch(data, refusal, work.id, receipt, current).then(id => {
      if (!current()) return;
      if (id) setWork({ kind: "checkout", id });
      else { setError("The checkout was not admitted. Inspect the workspace before switching."); setPhase("error"); }
    }, cause => { if (current()) { setError(cause instanceof Error ? cause.message : String(cause)); setPhase("error"); } })
      .finally(() => { following.current = false; if (alive.current) redraw(); });
  });

  if (phase === "commit") return <GitSubmissionDialog data={data} supported={supported} branchPrefix={branchPrefix}
    onOpenGitSettings={onOpenGitSettings} onSubmit={intent => { void submit(intent); }} onClose={finish}/>;
  if (hidden) return null;
  const paths = refusal.error.checkoutConflict.conflictedPaths;
  const branch = refusal.action.type === "git.checkout" ? refusal.action.branch : refusal.action.type === "git.checkout-ref"
    ? refusal.action.selection.localBranch ?? refusal.action.selection.ref.replace(/^refs\/heads\//, "") : refusal.action.revision.expression;
  const close = () => { if (phase === "working") setHidden(true); else finish(); };
  return <Dialog.Root open onOpenChange={open => { if (!open) close(); }}><Dialog.Portal>
    <Dialog.Overlay className="branch-switch-overlay"/>
    <BranchSwitchContent className="branch-switch-dialog" onOpenAutoFocus={event => { event.preventDefault(); if (current()) primary.current?.focus({ preventScroll: true }); }}
      onCloseAutoFocus={event => event.preventDefault()}>
    <button className="branch-switch-close" type="button" aria-label="Close dialog" onClick={close}><Icon name="close"/></button>
    <form onSubmit={event => { event.preventDefault(); if (phase === "conflict" && !blocked) { setPhase("commit"); setError(undefined); } }}>
      <header><Dialog.Title>Commit changes to switch branch</Dialog.Title></header>
      <Dialog.Description asChild><div className="branch-switch-description">
        {phase === "conflict" ? <BranchSwitchChanges data={data} paths={paths} branch={branch}/>
          : <><p role="status">{error ?? (work?.kind === "checkout" ? "Switching branch…" : "Waiting for the original commit…")}</p>
            {work?.kind === "commit" && data.gitSubmission?.commandId === work.id && <GitSubmissionReceiptView data={data}/>}
            {work && data.pending?.envelope.id === work.id && <button type="button" disabled={data.busy || !data.connected} onClick={() => void data.retry()}>Retry original workspace command</button>}
            {work?.kind === "checkout" && data.errors.action && <p role="alert">{data.errors.action}</p>}
          </>}
        {blocked && phase === "conflict" && <p role="status">{blocked}</p>}
      </div></Dialog.Description>
      <footer><button type="button" className="secondary-button" ref={phase === "conflict" && !blocked ? undefined : primary} onClick={close}>{phase === "conflict" ? "Cancel" : "Close"}</button>
        {phase === "conflict" && <button ref={blocked ? undefined : primary} type="submit" className="primary-button" disabled={Boolean(blocked)}>Commit and switch branch…</button>}
      </footer>
    </form>
  </BranchSwitchContent></Dialog.Portal></Dialog.Root>;
}
