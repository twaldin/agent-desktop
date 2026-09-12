import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import type { DesktopBridge } from "../../../../packages/shared/src/protocol";
import { QueuedMessagesState } from "./queued-messages-state";
import { Icon } from "./Icons";
import { QueuedMessageIcon, QueuedSendNowIcon } from "./queued-message-icons";
import "./queued-messages.css";

export function QueuedMessages({ bridge, hostId, sessionId, connected, archived }: {
  bridge: DesktopBridge; hostId: string; sessionId: string; connected: boolean; archived: boolean;
}) {
  const queue = useMemo(() => new QueuedMessagesState(bridge, hostId, sessionId), [bridge, hostId, sessionId, connected]);
  const view = useSyncExternalStore(queue.subscribe, queue.snapshot);
  useLayoutEffect(() => { if (connected) queue.start(); return () => queue.stop(); }, [queue, connected]);
  if (!connected || (!view.snapshot?.messages.length && !view.error)) return null;
  const disabled = archived || view.busy || view.loading || Boolean(view.error);
  const rows = view.snapshot?.messages ?? [];
  function move(index: number, direction: -1 | 1) {
    const next = rows.map(row => row.id), other = index + direction;
    if (other < 0 || other >= next.length || rows[index]?.lane !== rows[other]?.lane || !view.snapshot) return;
    [next[index], next[other]] = [next[other]!, next[index]!];
    void queue.mutate({ type: "reorder", expectedRevision: view.snapshot.revision, messageIds: next });
  }
  return <section className="queued-messages" aria-label="Queued messages" aria-busy={view.busy}>
    {view.error && <div className="inline-error" role="alert"><span>{view.error}</span><button type="button" disabled={view.busy} onClick={() => void queue.refresh()}>Refresh queue</button></div>}
    <ol>{rows.map((row, index) => <li key={row.id} className="queued-message" data-queue-id={row.id}>
      <span className="queued-message-marker" aria-label={row.lane === "steer" ? "Steering message" : "Follow-up message"}><QueuedMessageIcon/></span>
      <span className="queued-message-text" title={row.text}>{row.text || "Image attachment"}{row.imageCount > 0 && <span className="queued-message-images"> · {row.imageCount} {row.imageCount === 1 ? "image" : "images"}</span>}</span>
      <div className="queued-message-actions">
        <button type="button" className="icon-button small queue-up" aria-label="Move queued message up" title="Move up" disabled={disabled || index === 0 || rows[index - 1]?.lane !== row.lane} onClick={() => move(index, -1)}><Icon name="arrow"/></button>
        <button type="button" className="icon-button small queue-down" aria-label="Move queued message down" title="Move down" disabled={disabled || index === rows.length - 1 || rows[index + 1]?.lane !== row.lane} onClick={() => move(index, 1)}><Icon name="arrow"/></button>
        {row.promotable && <button type="button" className="icon-button small" aria-label="Send queued message now" title="Send now" disabled={disabled} onClick={() => void queue.mutate({ type: "promote", expectedRevision: view.snapshot!.revision, messageId: row.id })}><QueuedSendNowIcon/><span>Send now</span></button>}
        <button type="button" className="icon-button small" aria-label="Delete queued message" title="Delete queued message" disabled={disabled || !row.removable} onClick={() => void queue.mutate({ type: "remove", expectedRevision: view.snapshot!.revision, messageId: row.id })}><Icon name="trash"/></button>
      </div>
    </li>)}</ol>
  </section>;
}
