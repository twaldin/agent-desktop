import type { SessionSummary } from "@agent-desktop/shared";
import { parseSessionSearchRequest, rankSessionSearchHits, type SessionSearchResult, type SessionSearchHit } from "../../../packages/shared/src/session-search";

export interface StoredSessionText { bytes: number; snippet?: string }
export type ReadStoredSession = (session: SessionSummary, query: string, signal: AbortSignal) => Promise<StoredSessionText>;
export class SessionSearchError extends Error {
  constructor(readonly code: "SEARCH_BUSY" | "SEARCH_CANCELLED", message: string) { super(message); }
}
const normalize = (text: string) => text.toLocaleLowerCase("en-US");
export const sessionSearchSnippet = (text: string, query: string) => {
  const foldedOffset = normalize(text).indexOf(normalize(query));
  if (foldedOffset < 0) throw new Error("Cannot excerpt text without the requested match.");
  // Find the actual raw occurrence before collapsing display whitespace. Map
  // case-fold expansion (e.g. capital dotted I) back to UTF16 source offsets.
  let offset = 0, folded = 0;
  for (const character of text) {
    const width = normalize(character).length;
    if (folded + width > foldedOffset) break;
    folded += width; offset += character.length;
  }
  const start = Math.max(0, offset - 60), end = Math.min(text.length, start + 237);
  const clean = text.slice(start, end).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ");
  return `${start ? "…" : ""}${clean}${end < text.length ? "…" : ""}`;
};
/** Search only the host catalog, never native directories or arbitrary client
 * paths. The reader has no session-open, worker, mutation, or provider API. */
export class SessionSearch {
  private active = 0;
  constructor(private readonly hostId: string, private readonly sessions: () => SessionSummary[], private readonly read: ReadStoredSession,
    private readonly limits = { maxFiles: 256, maxTotalBytes: 32 * 1024 * 1024, maxMs: 1500 },
    private readonly now: () => number = Date.now) {}
  async search(input: unknown, signal: AbortSignal): Promise<SessionSearchResult> {
    const request = parseSessionSearchRequest(input);
    if (this.active >= 2) throw new SessionSearchError("SEARCH_BUSY", "Chat search is busy. Try again shortly.");
    this.active++;
    try {
      const check = () => { if (signal.aborted) throw new SessionSearchError("SEARCH_CANCELLED", "Chat search was cancelled."); };
      check();
      const deadline = this.now() + this.limits.maxMs;
      const catalog = this.sessions().filter(session => session.hostId === this.hostId)
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
      const query = normalize(request.query), hits: SessionSearchHit[] = [];
      let bytes = 0, files = 0, unreadableSessions = 0, unsearchedSessions = 0;
      for (const session of catalog) {
        check();
        const base = { sessionId: session.id, title: session.title.slice(0, 1024), projectId: session.projectId, updatedAt: session.updatedAt, archived: session.archived };
        if (normalize(session.title).includes(query)) { hits.push({ ...base, match: "title" }); continue; }
        if (!request.includeContent) continue;
        if (files >= this.limits.maxFiles || bytes >= this.limits.maxTotalBytes || this.now() >= deadline) { unsearchedSessions++; continue; }
        files++;
        const budget = this.limits.maxTotalBytes - bytes;
        try {
          const stored = await this.read(session, query, signal);
          check();
          if (!Number.isSafeInteger(stored.bytes) || stored.bytes < 0 || (stored.snippet !== undefined && (typeof stored.snippet !== "string" || stored.snippet.length > 240))) throw new Error("Invalid stored search result.");
          bytes += stored.bytes;
          if (stored.snippet !== undefined) hits.push({ ...base, match: "history", snippet: stored.snippet });
        } catch {
          check();
          // A failed/changing file exhausts admission for further histories.
          // An admitted stream may exceed the byte/time admission threshold;
          // cancellation is checked at every chunk and parser yield.
          bytes += budget; unreadableSessions++;
        }
      }
      return { version: 1, hostId: this.hostId, query: request.query, includeContent: request.includeContent,
        hits: rankSessionSearchHits(hits).slice(0, request.limit), moreMatches: hits.length > request.limit,
        coverage: unreadableSessions || unsearchedSessions ? "partial" : "complete", unreadableSessions, unsearchedSessions };
    } finally { this.active--; }
  }
}
