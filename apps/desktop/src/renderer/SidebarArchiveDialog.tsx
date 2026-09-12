import { useEffect, useRef, useState } from "react";
import type { HostState } from "../../../../packages/shared/src/protocol";
import type { HostOption } from "./host-catalog";

interface ArchiveTarget { hostId: string; sessionId: string }
export interface SidebarArchiveSelection {
  name: string;
  targets: ArchiveTarget[];
  opener: HTMLElement | null;
}
interface Props {
  selection: SidebarArchiveSelection;
  groups: { host: HostOption; hostState: HostState }[];
  onArchive?(sessionId: string, hostId: string, archived: boolean): Promise<boolean>;
  onDismiss(): void;
}

/** Owns one confirmed batch, retaining only unsuccessful original targets for retry. */
export function SidebarArchiveDialog(props: Props) {
  const [remaining, setRemaining] = useState(props.selection.targets);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const dialog = useRef<HTMLDialogElement>(null);
  const running = useRef(false);
  const latest = useRef(props); latest.current = props;
  useEffect(() => {
    const element = dialog.current, opener = props.selection.opener;
    element?.showModal();
    return () => { element?.close(); if (opener?.isConnected) opener.focus(); };
  }, [props.selection]);
  async function archiveAll() {
    if (running.current || !latest.current.onArchive) return;
    running.current = true; setPending(true); setError(undefined);
    const failed: ArchiveTarget[] = [];
    for (const target of remaining) {
      const current = latest.current;
      const group = current.groups.find(group => group.hostState.host.id === target.hostId);
      const session = group?.hostState.sessions.find(session => session.id === target.sessionId);
      if (!session || session.archived) continue;
      if (group?.host.availability !== "available") { failed.push(target); continue; }
      try { if (await current.onArchive?.(target.sessionId, target.hostId, true) !== true) failed.push(target); }
      catch { failed.push(target); }
    }
    running.current = false;
    if (!failed.length) { latest.current.onDismiss(); return; }
    setRemaining(failed); setPending(false);
    setError(`${failed.length} chat${failed.length === 1 ? "" : "s"} could not be archived. Reconnect or resolve the host error, then retry.`);
  }
  return <dialog ref={dialog} className="app-dialog" onCancel={event => { if (running.current) event.preventDefault(); else props.onDismiss(); }}>
    <div className="dialog-header"><h2>Archive all chats?</h2></div>
    <p>Archive {remaining.length} chats in {props.selection.name}? You can reopen them from Archived chats.</p>
    {error && <p role="alert">{error}</p>}
    <div className="dialog-footer"><button className="secondary-button" disabled={pending} onClick={props.onDismiss}>Cancel</button><button className="primary-button" disabled={pending || !remaining.length} onClick={() => void archiveAll()}>{pending ? "Archiving…" : error ? "Retry failed chats" : "Archive chats"}</button></div>
  </dialog>;
}
