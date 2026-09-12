import { expect, test } from "bun:test";
import { rankSessionSearchHits, type SessionSearchHit } from "./session-search";
type Hit = SessionSearchHit & { hostId: string; hostName: string };
const hit = (hostId: string, sessionId: string, match: "title" | "history", updatedAt: number): Hit => ({ hostId, hostName: hostId, sessionId, match, updatedAt,
  title: sessionId, projectId: null, archived: false, ...(match === "history" ? { snippet: "history needle" } : {}) });

test("federated limit retains older title hits ahead of newer history across hosts", () => {
  const title = hit("work", "older-title", "title", 1);
  const newer = Array.from({ length: 9 }, (_, i) => hit("home", `history-${i}`, "history", i + 9));
  const merged = [...newer, title], before = JSON.stringify(merged);
  const selected = rankSessionSearchHits(merged).slice(0, 9);
  expect(selected[0]).toEqual(title); expect(selected).toHaveLength(9);
  expect(selected.slice(1).map(value => value.updatedAt)).toEqual([17, 16, 15, 14, 13, 12, 11, 10]);
  expect(JSON.stringify(merged)).toBe(before);
});
test("each match class orders by recency, with stable owner-qualified ties", () => {
  const values = [hit("z", "same", "title", 1), hit("a", "same", "title", 1), hit("b", "recent", "title", 2), hit("a", "history", "history", 90)];
  expect(rankSessionSearchHits(values).map(value => [value.hostId, value.sessionId])).toEqual([["b", "recent"], ["a", "same"], ["z", "same"], ["a", "history"]]);
});
