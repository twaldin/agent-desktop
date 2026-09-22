import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { TranscriptMessage } from "../../../../packages/shared/src/protocol";
import type { SessionSubagentRow, SessionSubagentTarget } from "../../../../packages/shared/src/session-subagents";
import { Icon } from "./Icons";
import { TranscriptMessages } from "./Transcript";
import { TranscriptCode } from "./MarkdownText";
import type { AttachmentMediaContext } from "./attachment-media";
import type { TranscriptLinkActions } from "./transcript-links";
import { resolveTranscriptImageReference, type TranscriptImagePresentation } from "./transcript-image-source";
import { findSubagentRow, initialSessionSubagentsView, openRefusal, SessionSubagentsState, subagentMediaContext, subagentRowKey, type SessionSubagentDetail, type SessionSubagentsBridge, type SessionSubagentsView } from "./session-subagents-state";
import "./subagents.css";

export interface SubagentsPanelProps { bridge: SessionSubagentsBridge; hostId: string; sessionId: string; connected: boolean; active: boolean; media: AttachmentMediaContext }
type Controls = Pick<SessionSubagentsState, "refresh" | "reload" | "open" | "back" | "openFile" | "closePreview" | "openExternal" | "image">;

/** Read-only browse of the native session's owned subagents inside one dock panel: list, child conversation, nested
 * file preview. Hiding or unmounting only stops reads; nothing here resumes, messages or stops a child. */
export function SubagentsPanel({ bridge, hostId, sessionId, connected, active, media }: SubagentsPanelProps) {
  const state = useMemo(() => new SessionSubagentsState(bridge), [bridge]);
  useLayoutEffect(() => { state.configure({ hostId, sessionId, connected, active }); }, [state, hostId, sessionId, connected, active]);
  useEffect(() => () => state.stop(), [state]);
  const stored = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
  // A host/session change must not paint the previous owner's rows even for one frame; the effect reconfigures after this render.
  const view = stored.hostId === hostId && stored.sessionId === sessionId ? stored : initialSessionSubagentsView(hostId, sessionId, state.supported, connected, active);
  return <SubagentsPanelContent view={view} state={state} media={media}/>;
}

const statusLabels: Record<SessionSubagentRow["status"], string> = { running: "Running", idle: "Idle", parked: "Parked", aborted: "Aborted" };
const statusTitles: Record<SessionSubagentRow["status"], string> = {
  running: "The native agent is still working.",
  idle: "The native agent finished its last turn and is idle. This is not a claim that its task succeeded.",
  parked: "The native registry parked this agent. Only its owner can revive it; nothing here does.",
  aborted: "The native agent was aborted.",
};

/** Whole seconds, minutes, hours or days since `timestamp`; matches the pinned "22h" / "0s" row trailer. */
export function subagentAge(timestamp: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86400)}d`;
}
/** Model recorded on the latest assistant message; the roster itself carries no model field. */
export function latestSubagentModel(messages: TranscriptMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const metadata = messages[index]!.assistant;
    if (metadata?.model) return metadata.provider ? `${metadata.provider}/${metadata.model}` : metadata.model;
  }
  return undefined;
}

/** Shared rendering path for prop-driven tests; `state` supplies the controls. */
export function SubagentsPanelContent({ view, state, media, now = Date.now() }: { view: SessionSubagentsView; state: Controls; media: AttachmentMediaContext; now?: number }) {
  const root = useRef<HTMLElement>(null);
  // Back returns keyboard focus to the row that was opened; a row that left the roster hands focus to the list itself.
  const opened = useRef<string>(undefined), wasOpen = useRef(false);
  const detailKey = view.detail ? subagentRowKey(view.detail.target) : undefined;
  if (detailKey) opened.current = detailKey;
  useEffect(() => {
    if (wasOpen.current && !detailKey && root.current) {
      const key = opened.current, rows = root.current.querySelectorAll<HTMLButtonElement>("button[data-subagent-key]");
      const row = key === undefined ? undefined : Array.from(rows).find(candidate => candidate.dataset.subagentKey === key);
      (row ?? root.current.querySelector<HTMLElement>(".session-subagents-list"))?.focus({ preventScroll: true });
    }
    wasOpen.current = !!detailKey;
  }, [detailKey]);
  return <section ref={root} className="session-subagents" aria-label="Subagents" data-supported={view.supported} data-connected={view.connected} data-stale={view.stale} data-view={view.detail ? "detail" : "list"} aria-busy={view.reading}>
    {view.detail ? <SubagentDetail view={view} detail={view.detail} state={state} media={media} now={now}/> : <SubagentList view={view} state={state} now={now}/>}
  </section>;
}

function Note({ kind, children, alert = false }: { kind: string; children: ReactNode; alert?: boolean }) {
  return <p className={`session-subagents-note${alert ? " session-subagents-error" : ""}`} data-kind={kind} role={alert ? "alert" : "status"}>{children}</p>;
}

function ListNotes({ view, state }: { view: SessionSubagentsView; state: Pick<Controls, "refresh" | "reload"> }) {
  const list = view.list;
  return <>
    {!view.supported && <Note kind="unsupported">Subagents are unavailable through this desktop bridge.</Note>}
    {view.supported && !view.connected && !list && <Note kind="offline">Offline · subagents cannot be read until this host reconnects.</Note>}
    {view.loading && <Note kind="loading">Loading subagents…</Note>}
    {view.error && !view.ownerChanged && <Note kind="error" alert>{view.error}</Note>}
    {view.stale && list && <div className="session-subagents-stale" data-kind={view.ownerChanged ? "owner-changed" : "stale"} role="status">
      <p><strong>Stale.</strong> {view.ownerChanged ? "The native session behind this list was replaced on the host. These rows belong to the original native session and are kept as read; nothing retargets automatically."
        : `Showing the last roster read from the original native session${view.error ? "; the latest read failed" : view.connected ? "; a fresh read is pending" : " while this host is offline"}.`}</p>
      {view.connected && view.error && !view.ownerChanged && <button type="button" onClick={() => void state.refresh()}>Retry read</button>}
      {view.connected && view.ownerChanged && <button type="button" onClick={() => void state.reload()}>Read current native session</button>}
    </div>}
    {list?.availability === "unavailable" && <Note kind="unavailable">{list.reason ?? "The native session does not expose its subagents."}</Note>}
  </>;
}

function SubagentList({ view, state, now }: { view: SessionSubagentsView; state: Pick<Controls, "refresh" | "reload" | "open">; now: number }) {
  const list = view.list, available = list?.availability === "available" ? list : undefined;
  const refusal = openRefusal(view);
  const active = available?.rows.filter(row => row.running) ?? [], done = available?.rows.filter(row => !row.running) ?? [];
  const row = (item: SessionSubagentRow) => <li key={subagentRowKey(item.target)}>
    <button type="button" className="session-subagents-row" data-subagent-key={subagentRowKey(item.target)} data-subagent-id={item.target.id} data-subagent-status={item.status} data-subagent-stale={view.stale || undefined}
      disabled={!!refusal} title={refusal ?? statusTitles[item.status]} onClick={() => void state.open(item.target)}>
      <span className="session-subagents-avatar" aria-hidden="true">{item.displayName.trim().charAt(0).toUpperCase() || "·"}</span>
      <span className="session-subagents-row-main">
        <span className="session-subagents-name">{item.displayName}</span>
        {item.running && item.activity && <span className="session-subagents-activity">{item.activity}</span>}
      </span>
      {!item.running && <span className="session-subagents-status">{statusLabels[item.status]}</span>}
      <time className="session-subagents-time" dateTime={new Date(item.lastActivity).toISOString()} title={new Date(item.lastActivity).toLocaleString()}>{subagentAge(item.lastActivity, now)}{item.running ? "" : " ago"}</time>
    </button>
  </li>;
  return <div className="session-subagents-list" role="group" aria-label="Subagents" tabIndex={-1}>
    <ListNotes view={view} state={state}/>
    {available && <>
      <h3 className="session-subagents-heading">Active · {active.length}</h3>
      {active.length ? <ul className="session-subagents-rows" data-group="active">{active.map(row)}</ul> : <p className="session-subagents-empty" data-kind="no-active">No active subagents</p>}
      <h3 className="session-subagents-heading" title="Not running. Each row shows the native status; Done is not a claim that the task succeeded.">Done · {done.length}</h3>
      {done.length ? <ul className="session-subagents-rows" data-group="done">{done.map(row)}</ul> : <p className="session-subagents-empty" data-kind="no-done">No finished or parked subagents</p>}
      {available.omitted > 0 && <Note kind="omitted">{available.omitted} more {available.omitted === 1 ? "subagent is" : "subagents are"} not listed: the roster limit was reached or their original journal identity could not be verified.</Note>}
    </>}
  </div>;
}

function SubagentDetail({ view, detail, state, media, now }: { view: SessionSubagentsView; detail: SessionSubagentDetail; state: Controls; media: AttachmentMediaContext; now: number }) {
  const { target } = detail, key = subagentRowKey(target), listed = findSubagentRow(view.list, target), row = listed ?? detail.row;
  const transcript = detail.transcript, messages = transcript?.messages, cwd = transcript?.cwd;
  const model = messages ? latestSubagentModel(messages) : undefined;
  const ownerKey = `${view.hostId}:${view.sessionId}:${key}:${view.connected}`;
  // Every child-bound action captures this exact target; the state re-checks the current selection when each reply lands.
  const childMedia = useMemo(() => subagentMediaContext(state, target, media), [state, key, media]);
  const linkActions = useMemo<TranscriptLinkActions>(() => ({
    cwd, ownerKey,
    images: { ownerKey, resolve: resolveSubagentImage },
    openFile: file => state.openFile(target, file.path),
    openExternal: url => state.openExternal(target, url),
  }), [state, key, cwd, ownerKey]);
  const heading = useRef<HTMLDivElement>(null), hadPreview = useRef(false);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!back.current?.closest("[inert]")) back.current?.focus({ preventScroll: true }); }, [key]);
  useEffect(() => { if (hadPreview.current && !detail.preview) heading.current?.focus({ preventScroll: true }); hadPreview.current = !!detail.preview; }, [detail.preview]);
  return <div className="session-subagents-detail" role="group" aria-label={`Subagent ${row.displayName}`} data-subagent-key={key} data-subagent-status={row.status} data-detail-state={detail.state} data-detail-stale={detail.stale || undefined}>
    <div ref={heading} className="session-subagents-detail-head" tabIndex={-1}>
      <button ref={back} type="button" className="icon-button session-subagents-back" aria-label="Back to subagents" title="Back to subagents" onClick={() => state.back()}><Icon name="browserBack"/></button>
      <span className="session-subagents-avatar" aria-hidden="true">{row.displayName.trim().charAt(0).toUpperCase() || "·"}</span>
      <span className="session-subagents-name" title={row.displayName}>{row.displayName}</span>
      <span className="session-subagents-status" title={statusTitles[row.status]}>{statusLabels[row.status]}</span>
      {model && <span className="session-subagents-model" title="Model recorded on the latest assistant message of this child">Uses {model}</span>}
      <time className="session-subagents-time" dateTime={new Date(row.lastActivity).toISOString()} title={new Date(row.lastActivity).toLocaleString()}>{subagentAge(row.lastActivity, now)}{row.running ? "" : " ago"}</time>
    </div>
    {detail.preview ? <SubagentPreview preview={detail.preview} state={state} targetKey={key}/> : <div className="session-subagents-transcript-scroll" tabIndex={0} aria-label={`Conversation of ${row.displayName}`}>
      <div className="transcript session-subagents-transcript">
        {detail.state === "pending" && <Note kind="loading">Reading this subagent's conversation…</Note>}
        {detail.state === "failed" && <Note kind="error" alert>{detail.error}</Note>}
        {detail.stale && transcript && <Note kind="stale"><strong>Stale.</strong> Showing the last conversation read from this child{detail.error ? `; the latest read failed: ${detail.error}` : view.connected ? "" : " while this host is offline"}.</Note>}
        {view.list?.availability === "available" && !listed && <Note kind="orphan">This subagent is no longer listed by the native session; showing it as last read.</Note>}
        {transcript?.availability === "missing" && <Note kind="missing">{transcript.reason ?? "The native session has no conversation log for this subagent."}</Note>}
        {transcript?.availability === "unavailable" && <Note kind="unavailable">{transcript.reason ?? "This subagent's conversation cannot be read from the native session."}</Note>}
        {transcript?.truncated && <Note kind="truncated">Only part of this conversation could be read; the host caps a subagent transcript.</Note>}
        {transcript?.availability === "available" && !transcript.truncated && !messages?.length && <Note kind="empty">This subagent has no messages yet.</Note>}
        {messages && messages.length > 0 && <TranscriptMessages messages={messages} contextKey={`${view.hostId}:${view.sessionId}:${key}`} connected={view.connected} linkActions={linkActions} images={{ media: childMedia, hostId: view.hostId, sessionId: target.sessionId }}/>}
        {row.running && transcript?.availability === "available" && <div className="working-state" role="status"><span className="working-dot"/>Working…</div>}
      </div>
    </div>}
  </div>;
}

/** Inline data images render; path images have no child-bound byte route, so they stay honestly unavailable. */
function resolveSubagentImage(href: string): TranscriptImagePresentation {
  const reference = resolveTranscriptImageReference(href);
  if (reference.kind === "data") return { source: { key: reference.url, load: async () => ({ url: reference.url, release() {} }) } };
  return { unavailableReason: reference.kind === "unavailable" ? reference.reason : "Images referenced by path are unavailable in this read-only subagent view." };
}

function SubagentPreview({ preview, state, targetKey }: { preview: NonNullable<SessionSubagentDetail["preview"]>; state: Pick<Controls, "closePreview">; targetKey: string }) {
  const extension = preview.path.slice(preview.path.lastIndexOf("/") + 1).split(".").at(-1) ?? "";
  return <div className="session-subagents-preview" role="region" aria-label={`Preview of ${preview.path}`} data-preview-state={preview.state} data-preview-truncated={preview.truncated || undefined}>
    <div className="session-subagents-preview-head">
      <button type="button" className="icon-button session-subagents-back" aria-label="Back to subagent conversation" title="Back to subagent conversation" onClick={() => state.closePreview()}><Icon name="browserBack"/></button>
      <code className="session-subagents-preview-path" title={preview.path}>{preview.path}</code>
      <span className="session-subagents-readonly">Read-only</span>
    </div>
    {preview.state === "pending" && <Note kind="loading">Reading {preview.path}…</Note>}
    {preview.state === "failed" && <Note kind="error" alert>{preview.error}</Note>}
    {preview.truncated && <Note kind="truncated">Truncated to the host's preview limit.</Note>}
    {preview.state === "ready" && <div className="session-subagents-preview-body"><TranscriptCode code={preview.text ?? ""} language={extension.length > 0 && extension.length <= 12 ? extension : "plaintext"} blockKey={`subagent-file:${targetKey}:${preview.path}`} title={preview.path} copyAction="Copy file contents"/></div>}
  </div>;
}
