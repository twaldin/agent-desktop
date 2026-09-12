import { expect, test } from "bun:test";
import type { SessionSummary } from "@agent-desktop/shared";
import { SessionSearch } from "./session-search";
const session = (id: string, title = id, hostId = "owner"): SessionSummary => ({ id, title, hostId, projectId: null, cwd: "/project", sessionFile: `/native/${id}.jsonl`, createdAt: 1, updatedAt: Number(id) || 1, archived: false, status: "idle", model: null });
const input = { query: "needle", includeContent: true, limit: 9 };
const signal = () => new AbortController().signal;
const limits = { maxFiles: 2, maxTotalBytes: 100, maxMs: 100 };

test("searches owned stored history, ranks titles first, and never reads foreign or already matched files", async () => {
  const reads: string[] = [];
  const search = new SessionSearch("owner", () => [session("1", "Needle title"), session("9"), session("3", "needle foreign", "foreign")], async s => { reads.push(s.id); return { bytes: 10, snippet: "old branch needle content" }; });
  const result = await search.search(input, signal());
  expect(reads).toEqual(["9"]);
  expect(result.hits.map(hit => [hit.sessionId, hit.match])).toEqual([["1", "title"], ["9", "history"]]);
  expect(result.hits[1]?.snippet).toBe("old branch needle content");
  expect(result.coverage).toBe("complete");
  expect(result.hostId).toBe("owner");
});
test("metadata-only root query performs no history read and caps ranked results", async () => {
  let reads = 0;
  const search = new SessionSearch("owner", () => [session("1", "needle"), session("2", "needle"), session("3")], async () => { reads++; throw new Error(); });
  const result = await search.search({ ...input, includeContent: false, limit: 1 }, signal());
  expect(reads).toBe(0); expect(result.hits.map(h => h.sessionId)).toEqual(["2"]); expect(result.moreMatches).toBe(true); expect(result.coverage).toBe("complete");
});
test("failed/changing histories remain explicit partial results and consume the read budget", async () => {
  const reads: string[] = [];
  const search = new SessionSearch("owner", () => [session("1"), session("2"), session("3", "needle")], async s => { reads.push(s.id); throw new Error("private path must not leave host"); }, limits);
  const result = await search.search(input, signal());
  expect(reads).toEqual(["2"]); expect(result.unreadableSessions).toBe(1); expect(result.unsearchedSessions).toBe(1);
  expect(result.coverage).toBe("partial"); expect(result.hits.map(h => h.sessionId)).toEqual(["3"]); expect(JSON.stringify(result)).not.toContain("private path");
});
test("time and file caps mark unsearched histories while still checking title matches", async () => {
  let clock = 0, reads = 0;
  const search = new SessionSearch("owner", () => [session("3"), session("2"), session("1", "needle")], async () => { reads++; clock = 101; return { bytes: 1}; }, limits, () => clock);
  const result = await search.search(input, signal());
  expect(reads).toBe(1); expect(result.unsearchedSessions).toBe(1); expect(result.hits[0]?.sessionId).toBe("1"); expect(result.coverage).toBe("partial");
});
test("one admitted large journal may exceed the byte threshold; later histories wait rather than losing its match", async () => {
  const reads: Array<[string, string]> = [];
  const search = new SessionSearch("owner", () => [session("3"), session("2"), session("1", "needle title")], async (value, query) => {
    reads.push([value.id, query]); return { bytes: 200, snippet: "late needle" };
  }, limits);
  const result = await search.search({ ...input, query: " NEEDLE " }, signal());
  expect(reads).toEqual([["3", "needle"]]);
  expect(result.hits.map(hit => hit.sessionId)).toEqual(["1", "3"]);
  expect(result.hits[1]?.snippet).toBe("late needle");
  expect(result.unsearchedSessions).toBe(1); expect(result.unreadableSessions).toBe(0);
});
test("cancellation rejects instead of producing an empty success and releases concurrency", async () => {
  const controller = new AbortController(); let reads = 0;
  const search = new SessionSearch("owner", () => [session("1")], async () => { reads++; controller.abort(); return { bytes: 1, snippet: "needle" }; });
  await expect(search.search(input, controller.signal)).rejects.toMatchObject({ code: "SEARCH_CANCELLED" });
  expect((await search.search({ ...input, includeContent: false }, signal())).coverage).toBe("complete"); expect(reads).toBe(1);
});
test("two admitted searches bound concurrency; completion admits a later search", async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const search = new SessionSearch("owner", () => [session("1")], async () => { await hold; return { bytes: 1}; });
  const first = search.search(input, signal()), second = search.search(input, signal());
  await expect(search.search(input, signal())).rejects.toMatchObject({ code: "SEARCH_BUSY" });
  release(); await Promise.all([first, second]);
  expect((await search.search(input, signal())).coverage).toBe("complete");
});
test("invalid query and limits cannot reach the catalog or reader", async () => {
  let calls = 0;
  const search = new SessionSearch("owner", () => { calls++; return []; }, async () => { throw new Error(); });
  for (const value of [{ ...input, query: "" }, { ...input, query: "a\u0000b" }, { ...input, limit: 10 }, { ...input, includeContent: 1 }, { ...input, path: "/private" }]) await expect(search.search(value, signal())).rejects.toThrow();
  expect(calls).toBe(0);
});
