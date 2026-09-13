import type { NativeTerminalHistory } from "../../../../packages/shared/src/terminals";

export type NativeHistorySectionId = "history" | "screen" | "savedNormalScreen";
export interface NativeHistorySearchSection {
  id: NativeHistorySectionId;
  label: string;
  text: string;
  /** Flat UTF-16 start/end pairs; avoids allocating a result object per occurrence. */
  ranges: number[];
  firstMatch: number;
}
export interface NativeHistorySearch {
  key: string;
  sections: NativeHistorySearchSection[];
  total: number;
}
export interface NativeHistorySelection { key: string; index: number }
export interface NativeHistoryMatch extends NativeHistorySelection { section: NativeHistorySectionId; start: number; end: number }

/** Literal, case-insensitive, non-overlapping matches in each captured section.
 * Escaping the query exposes no regex language; Unicode matching keeps offsets
 * in the original text instead of changing them through lower-case expansion. */
export function findNativeHistory(hostId: string, capture: Readonly<NativeTerminalHistory>, query: string): NativeHistorySearch {
  const key = JSON.stringify([hostId, capture.terminalId, capture.serverGeneration, capture.revision, capture.capturedAt, query]);
  const sections: NativeHistorySearchSection[] = [];
  const longest = Math.max(capture.history.length, capture.screen?.length ?? 0, capture.savedNormalScreen?.length ?? 0);
  const pattern = query === "" || query.length > longest ? undefined : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  let total = 0;
  const add = (id: NativeHistorySectionId, label: string, text: string) => {
    const ranges: number[] = [], firstMatch = total;
    if (pattern && query.length <= text.length) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(text); match; match = pattern.exec(text)) ranges.push(match.index, match.index + match[0].length);
    }
    total += ranges.length / 2;
    sections.push({ id, label, text, ranges, firstMatch });
  };
  add("history", "Native scrollback text", capture.history);
  if (capture.screen !== undefined) add("screen", "Captured native screen", capture.screen);
  if (capture.savedNormalScreen) add("savedNormalScreen", "Saved normal screen", capture.savedNormalScreen);
  return { key, sections, total };
}

/** A cursor from another owner, capture or query never selects a stale offset. */
export function activeNativeHistoryMatch(search: NativeHistorySearch, selection?: NativeHistorySelection): NativeHistoryMatch | undefined {
  if (!search.total) return;
  const requested = selection?.key === search.key ? selection.index : 0;
  const index = ((requested % search.total) + search.total) % search.total;
  for (const section of search.sections) {
    const offset = (index - section.firstMatch) * 2;
    if (offset >= 0 && offset < section.ranges.length)
      return { key: search.key, index, section: section.id, start: section.ranges[offset]!, end: section.ranges[offset + 1]! };
  }
}

export function stepNativeHistoryMatch(search: NativeHistorySearch, selection: NativeHistorySelection | undefined, direction: 1 | -1): NativeHistorySelection | undefined {
  const current = activeNativeHistoryMatch(search, selection);
  if (!current) return;
  return { key: search.key, index: (current.index + direction + search.total) % search.total };
}
