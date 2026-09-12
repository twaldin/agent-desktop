/** Read-only catalog-owned chat search. History hits may be on an earlier
 * branch or before compaction; selecting a hit never changes the native leaf. */
export const SESSION_SEARCH_OWNER_HEADER = "x-agent-desktop-search-owner";
export interface SessionSearchRequest { query: string; includeContent: boolean; limit: number }
export interface SessionSearchHit {
  sessionId: string;
  title: string;
  projectId: string | null;
  updatedAt: number;
  archived: boolean;
  match: "title" | "history";
  snippet?: string;
}
/** Keep one ordering across the owning host and the federated desktop result
 * set. Apply any result limit only after this ranking. */
export function rankSessionSearchHits<T extends SessionSearchHit & { hostId?: string }>(hits: readonly T[]): T[] {
  return [...hits].sort((a, b) => Number(a.match === "history") - Number(b.match === "history")
    || b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId) || (a.hostId ?? "").localeCompare(b.hostId ?? ""));
}
export interface SessionSearchResult {
  version: 1;
  hostId: string;
  query: string;
  includeContent: boolean;
  hits: SessionSearchHit[];
  /** Coverage of matching-session determination, not bytes read: a title match
   * already establishes a result without reading that session's history. */
  coverage: "complete" | "partial";
  moreMatches: boolean;
  /** Non-title-matching sessions whose content could not be searched. No paths or file errors leave the host. */
  unreadableSessions: number;
  unsearchedSessions: number;
}
export function parseSessionSearchRequest(value: unknown): SessionSearchRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid chat search request.");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["query", "includeContent", "limit"].includes(key))
    || typeof v.query !== "string" || !v.query.trim() || v.query.length > 256 || /[\x00-\x1f\x7f]/.test(v.query)
    || typeof v.includeContent !== "boolean" || !Number.isInteger(v.limit) || (v.limit as number) < 1 || (v.limit as number) > 9)
    throw new Error("Use a nonempty chat query up to 256 characters and a result limit from 1 to 9.");
  return { query: v.query.trim(), includeContent: v.includeContent, limit: v.limit as number };
}
export function parseSessionSearchResult(value: unknown, hostId: string, request: SessionSearchRequest): SessionSearchResult {
  if (!value || typeof value !== "object") throw new Error("Invalid chat search response.");
  const v = value as SessionSearchResult;
  const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  if (v.version !== 1 || v.hostId !== hostId || v.query !== request.query || v.includeContent !== request.includeContent
    || !["complete", "partial"].includes(v.coverage) || typeof v.moreMatches !== "boolean"
    || !count(v.unreadableSessions) || !count(v.unsearchedSessions)
    || (v.coverage === "complete" && (v.unreadableSessions !== 0 || v.unsearchedSessions !== 0))
    || !Array.isArray(v.hits) || v.hits.length > request.limit) throw new Error("Chat search response does not match the requested owner or query.");
  const ids = new Set<string>();
  for (const hit of v.hits) {
    if (!hit || typeof hit.sessionId !== "string" || !hit.sessionId || hit.sessionId.length > 200 || ids.has(hit.sessionId)
      || typeof hit.title !== "string" || hit.title.length > 1024 || (hit.projectId !== null && typeof hit.projectId !== "string")
      || !Number.isFinite(hit.updatedAt) || typeof hit.archived !== "boolean" || !["title", "history"].includes(hit.match)
      || (hit.match === "history" && (!request.includeContent || typeof hit.snippet !== "string"))
      || (hit.snippet !== undefined && (typeof hit.snippet !== "string" || hit.snippet.length > 240))) throw new Error("Invalid chat search hit.");
    ids.add(hit.sessionId);
  }
  return v;
}
