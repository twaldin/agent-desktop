export interface CommandMenuRecentCandidate {
  hostId: string; sessionId: string; updatedAt: number; pinned?: boolean; pinnedPosition?: number;
}
/** Pinned7982 zQo returns at most nine combined: pinned preference order first,
 * then newest remaining chats. Host identity remains part of every destination. */
export function commandMenuRecents<T extends CommandMenuRecentCandidate>(entries: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const entry of entries) { const key = JSON.stringify([entry.hostId, entry.sessionId]); if (!unique.has(key)) unique.set(key, entry); }
  const tie = (a: T, b: T) => a.sessionId.localeCompare(b.sessionId) || a.hostId.localeCompare(b.hostId);
  const pinned = [...unique.values()].filter(entry => entry.pinned).sort((a, b) => (a.pinnedPosition ?? Number.MAX_SAFE_INTEGER) - (b.pinnedPosition ?? Number.MAX_SAFE_INTEGER) || tie(a, b)).slice(0, 9);
  const recent = [...unique.values()].filter(entry => !entry.pinned).sort((a, b) => b.updatedAt - a.updatedAt || tie(a, b)).slice(0, 9 - pinned.length);
  return [...pinned, ...recent];
}
