import { expect, test } from "bun:test";
import type { NativeTerminalHistory } from "../../../../packages/shared/src/terminals";
import { activeNativeHistoryMatch, findNativeHistory, stepNativeHistoryMatch } from "./native-terminal-history-find";

const capture = (patch: Partial<NativeTerminalHistory> = {}): NativeTerminalHistory => ({
  terminalId: "terminal", serverGeneration: "generation", revision: "revision", capturedAt: 1,
  cols: 80, rows: 24, live: true, history: "needle", screen: "needle", savedNormalScreen: "needle", truncated: true, ...patch,
});

test("literal case-insensitive matches retain original Unicode offsets across all capture sections", () => {
  const source = capture({ history: "\tİ 😀 A.[x]\r\nA.[x]  ", screen: "a.[x]", savedNormalScreen: "A.[x]" });
  const search = findNativeHistory("owner", source, "a.[x]");
  expect(search.total).toBe(4);
  const first = activeNativeHistoryMatch(search)!;
  expect([first.section, first.start, first.end]).toEqual(["history", 6, 11]);
  expect(source.history.slice(first.start, first.end)).toBe("A.[x]");
  expect(activeNativeHistoryMatch(search, { key: search.key, index: 2 })?.section).toBe("screen");
  expect(activeNativeHistoryMatch(search, { key: search.key, index: 3 })?.section).toBe("savedNormalScreen");
});

test("section boundaries are not fabricated text and whitespace is a real literal query", () => {
  expect(findNativeHistory("owner", capture({ history: "ab", screen: "cd", savedNormalScreen: undefined }), "b\nc").total).toBe(0);
  const spaces = capture({ history: "a a", screen: " a", savedNormalScreen: " " });
  expect(findNativeHistory("owner", spaces, " ").total).toBe(3);
  const empty = findNativeHistory("owner", spaces, "");
  expect(empty.total).toBe(0);
  expect(activeNativeHistoryMatch(empty)).toBeUndefined();
  expect(stepNativeHistoryMatch(empty, undefined, 1)).toBeUndefined();
});

test("navigation wraps and a refreshed or different owned capture cannot reuse old offsets", () => {
  const source = capture(), search = findNativeHistory("owner", source, "needle");
  const last = stepNativeHistoryMatch(search, undefined, -1)!;
  expect(activeNativeHistoryMatch(search, last)?.section).toBe("savedNormalScreen");
  expect(activeNativeHistoryMatch(search, stepNativeHistoryMatch(search, last, 1))?.section).toBe("history");
  const refreshed = findNativeHistory("owner", capture({ revision: "new", history: "prefix needle", screen: "needle" }), "needle");
  expect(activeNativeHistoryMatch(refreshed, last)).toMatchObject({ index: 0, section: "history", start: 7 });
  const restarted = findNativeHistory("owner", capture({ serverGeneration: "restarted" }), "needle");
  expect(activeNativeHistoryMatch(restarted, last)?.index).toBe(0);
  const otherOwner = findNativeHistory("other-owner", source, "needle");
  expect(activeNativeHistoryMatch(otherOwner, last)?.index).toBe(0);
});
