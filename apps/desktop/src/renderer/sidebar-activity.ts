import type { HostState, SessionSummary } from "../../../../packages/shared/src/protocol";
import { sessionUnreadKey } from "./session-read-state";
export interface SidebarActivityItem { session: SessionSummary; hostName: string; reason: "Awaiting response" | "Running" | "Unread" }
/** The pinned activity control shows unread, active or awaiting-response chats.
 * Only native session and notification state contributes; no hosted activity is invented. */
export function sidebarActivity(groups: readonly { hostState: HostState }[], unread: ReadonlySet<string>): SidebarActivityItem[] {
  const items: SidebarActivityItem[] = [];
  for (const { hostState } of groups) {
    const waiting = new Set((hostState.notifications ?? []).filter(item => item.state === "open" && (item.kind === "permission" || item.kind === "question")).map(item => item.sessionId));
    for (const session of hostState.sessions) {
      if (session.archived) continue;
      const reason = waiting.has(session.id) ? "Awaiting response" : session.status === "running" ? "Running" : unread.has(sessionUnreadKey(session.hostId, session.id)) ? "Unread" : undefined;
      if (reason) items.push({ session, hostName: hostState.host.name, reason });
    }
  }
  const priority = { "Awaiting response": 0, "Running": 1, "Unread": 2 } as const;
  return items.sort((a, b) => priority[a.reason] - priority[b.reason] || b.session.updatedAt - a.session.updatedAt || sessionUnreadKey(a.session.hostId, a.session.id).localeCompare(sessionUnreadKey(b.session.hostId, b.session.id)));
}
