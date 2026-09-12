import * as Dialog from "@radix-ui/react-dialog";
import { useId, useLayoutEffect, useRef, useState } from "react";
import type { PullRequestDetailResult } from "../../../../packages/shared/src/pull-requests";
import type { PullRequestWritesBridge, PullRequestWriteAction, PullRequestInlineSelection, PullRequestDiscussionTarget } from "../../../../packages/shared/src/pull-request-write";
import { pullRequestComposerKey, type PullRequestComposer } from "../pull-request-composer-state";
import type { PullRequestComposers } from "./pull-request-composers";

interface ComposerPresentation { label: string; trigger: string; textareaLabel: string; bodyless: boolean }
const COMPOSER_PRESENTATION: Record<PullRequestWriteAction | "review", ComposerPresentation> = {
  comment: { label: "Post comment", trigger: "Post comment", textareaLabel: "Pull request comment", bodyless: false },
  review: { label: "Submit review", trigger: "Submit review", textareaLabel: "Review comment", bodyless: false },
  review_comment: { label: "Submit review", trigger: "Submit review", textareaLabel: "Review comment", bodyless: false },
  approve: { label: "Submit review", trigger: "Submit review", textareaLabel: "Review comment", bodyless: false },
  request_changes: { label: "Submit review", trigger: "Submit review", textareaLabel: "Review comment", bodyless: false },
  inline_comment: { label: "Add inline comment", trigger: "Add inline comment", textareaLabel: "Inline pull request comment", bodyless: false },
  reply: { label: "Post reply", trigger: "Reply", textareaLabel: "Pull request reply", bodyless: false },
  update: { label: "Save changes", trigger: "Edit", textareaLabel: "Edit pull request comment", bodyless: false },
  delete: { label: "Delete comment", trigger: "Delete comment", textareaLabel: "", bodyless: true },
  resolve: { label: "Resolve conversation", trigger: "Resolve conversation", textareaLabel: "", bodyless: true },
  unresolve: { label: "Unresolve conversation", trigger: "Unresolve conversation", textareaLabel: "", bodyless: true },
};

const message = (error: unknown) => error instanceof Error ? error.message : "The submission could not be confirmed. Your text is preserved.";
export function PullRequestComposerForm({ hostId, detail, mode, enabled, bridge, composers, onSubmitted, openExternal, action, target, inline, initialBody = "", savedDraft, recoveryEnabled = enabled }: {
  hostId: string; detail: PullRequestDetailResult; mode: PullRequestComposer["mode"]; enabled: boolean;
  action?: PullRequestWriteAction; target?: PullRequestDiscussionTarget; inline?: PullRequestInlineSelection; initialBody?: string; savedDraft?: PullRequestComposer; recoveryEnabled?: boolean;
  bridge?: PullRequestWritesBridge; composers: PullRequestComposers; onSubmitted(): void; openExternal(url: string): Promise<void>;
}) {
  const initial: PullRequestComposer = savedDraft ?? { hostId, accountId: detail.account.id, pullRequest: detail.summary.pullRequest,
    mode, action: action ?? (mode === "review" ? "review_comment" : "comment"), body: initialBody, ...(target ? { target } : {}), ...(inline ? { inline, expectedHeadOid: detail.summary.headOid } : {}) };
  const { label, trigger, bodyless, textareaLabel } = COMPOSER_PRESENTATION[mode === "review" ? "review" : initial.action];
  const revision = mode === "discussion" || mode === "inline" ? detail.revision : detail.summary.headOid;
  const key = pullRequestComposerKey(initial), entry = composers.get(key) ?? initial;
  const busy = composers.busy(key), unresolved = Boolean(entry.request && entry.receipt?.outcome !== "succeeded");
  const [error, setError] = useState<string>(), [open, setOpen] = useState(false);
  const owner = useRef({ enabled, bridge, key, head: detail.summary.headOid, alive: true, generation: 0 });
  useLayoutEffect(() => {
    owner.current = { enabled, bridge, key, head: detail.summary.headOid, alive: true, generation: owner.current.generation + 1 };
    return () => { owner.current.alive = false; owner.current.generation++; composers.invalidate(key); };
  }, [enabled, bridge, key, detail.summary.headOid, revision, composers]);
  const textarea = useRef<HTMLTextAreaElement>(null), radioName = useId();
  useLayoutEffect(() => {
    if (mode === "comment" && textarea.current) { textarea.current.style.height = "auto"; textarea.current.style.height = `${Math.min(192, Math.max(72, textarea.current.scrollHeight))}px`; }
  }, [entry.body, mode]);
  function edit(change: Partial<Pick<PullRequestComposer, "body" | "action">>) {
    try { composers.edit({ ...entry, ...change }); setError(undefined); } catch (cause) { setError(message(cause)); }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(undefined);
    const original = { ...owner.current };
    const current = () => original.enabled && !!original.bridge && owner.current.alive && owner.current.generation === original.generation;
    try {
      if (!current() || !bridge) throw new Error("Reconnect to this pull request’s host and account before submitting.");
      if (mode === "review" && entry.action !== "approve" && !entry.body.trim()) throw new Error(entry.action === "request_changes" ? "Add a comment before requesting changes" : "Add a comment before submitting the review");
      if (!composers.get(key)) composers.edit(entry);
      const receipt = await composers.submit(key, original.head, bridge, current);
      if (!current()) return;
      if (receipt.outcome === "succeeded") { setOpen(false); onSubmitted(); }
    } catch (cause) { if (owner.current.alive && owner.current.key === key) setError(message(cause)); }
  }
  async function inspect() {
    if (!bridge) return;
    const generation = owner.current.generation;
    try {
      const result = await composers.inspect(key, bridge, () => recoveryEnabled && owner.current.alive && owner.current.generation === generation);
      if (!owner.current.alive || owner.current.generation !== generation) return;
      setError(result ? undefined : "This host has no saved reservation for the request. Inspect GitHub before starting a new attempt.");
      if (result?.outcome === "succeeded") onSubmitted();
    } catch (cause) { if (owner.current.alive && owner.current.generation === generation) setError(message(cause)); }
  }
  const recovery = <>
    {entry.receipt && <p role="status">{entry.receipt.message}</p>}
    {unresolved && <div className="pull-request-submission-recovery">
      <p>The original request and your text are saved. It will not be posted again automatically.</p>
      <button type="button" disabled={busy || !recoveryEnabled || !bridge} onClick={() => void inspect()}>Check submission status</button>
      <button type="button" onClick={() => void openExternal(detail.summary.url)}>Inspect on GitHub</button>
      <button type="button" disabled={busy} onClick={() => { try { composers.startFresh(key); setError(undefined); } catch (cause) { setError(message(cause)); } }}>I checked GitHub; start a new attempt</button>
    </div>}
    {error && <p role="alert">{error}</p>}
  </>;
  const form = <form className="pull-request-composer" onSubmit={event => void submit(event)} aria-busy={busy}>
    {mode === "review" && <fieldset disabled={busy || unresolved}>
      <legend>Review decision</legend><div className="pull-request-review-decisions">
        {([['review_comment', 'Comment'], ['approve', 'Approve'], ['request_changes', 'Request changes']] as const).map(([value, label]) =>
          <label key={value}><input type="radio" name={radioName} checked={entry.action === value} onChange={() => edit({ action: value })}/>{label}</label>)}
      </div>
    </fieldset>}
    {!bodyless && <label><span className={mode === "comment" ? "sr-only" : undefined}>{textareaLabel}</span>
      <textarea ref={textarea} disabled={busy || unresolved} rows={mode === "review" ? 4 : 3} autoFocus={mode === "review"}
        placeholder={mode === "comment" ? "Leave a comment…" : entry.action === "approve" ? "Optional comment" : "Add a comment…"}
        value={entry.body} onChange={event => edit({ body: event.currentTarget.value })}
        onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); if (!busy && !unresolved) event.currentTarget.form?.requestSubmit(); } }}/>
    </label>}
    {inline && <p>{inline.path} · {inline.startLine !== undefined ? `${inline.startSide}:${inline.startLine}–` : ""}{inline.side}:{inline.line}</p>}
    {recovery}
    {!enabled && <p role="status">{savedDraft ? "Refresh the original selection before submitting. Your saved request and text are preserved." : "Reconnect to the original host and GitHub account to submit. Your text is preserved."}</p>}
    <footer>{mode !== "comment" && <button className="secondary-button" type="button" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>}
      <button className="primary-button" type="submit" disabled={!enabled || !bridge || busy || unresolved || (mode === "comment" || mode === "inline" || mode === "discussion") && !bodyless && !entry.body.trim()}>{busy ? "Submitting…" : label}</button>
    </footer>
  </form>;
  if (mode === "comment") return form;
  return <Dialog.Root open={open} onOpenChange={next => { if (!busy) {
      if (next && entry.receipt?.outcome === "succeeded") composers.edit({ ...entry, action: initial.action, body: initialBody });
      setOpen(next); setError(undefined);
    } }}>
    <Dialog.Trigger asChild><button className={mode === "review" ? "primary-button" : "secondary-button"} disabled={!enabled && !unresolved && !entry.body}>{trigger}</button></Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="pull-request-review-overlay"/><Dialog.Content className="pull-request-review-dialog"
      onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
      <Dialog.Title>{action === "update" ? "Edit comment" : label}</Dialog.Title>
      <Dialog.Description>{action === "delete" ? "This comment will be permanently deleted from GitHub" : mode === "discussion" ? "This action applies to the original GitHub conversation and your current permissions." : "The comment or review applies only if the displayed head commit still matches."}</Dialog.Description>
      {form}
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
