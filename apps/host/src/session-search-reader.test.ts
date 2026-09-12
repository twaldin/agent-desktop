import { expect, test } from "bun:test";
import { searchSessionStream } from "./session-search-stream";
const search = (content: string, id: string, query: string) => searchSessionStream((async function* () { yield new TextEncoder().encode(content); })(), id, query, new AbortController().signal);
const header = { type: "session", version: 3, id: "native-id", timestamp: "2026-09-08T00:00:00Z", cwd: "/project" };
const journal = (...entries: unknown[]) => [header, ...entries].map(entry => JSON.stringify(entry)).join("\n");
const message = (id: string, role: string, content: unknown, parentId: string | null = null) => ({ type: "message", id, parentId, timestamp: header.timestamp, message: { role, content } });
test("native parser includes persisted branches and precompaction user/assistant text without tools or thinking", async () => {
  const content = journal(message("a", "user", "old prompt"), message("b", "assistant", [{ type: "text", text: "old answer" }, { type: "thinking", thinking: "private reasoning" }], "a"),
    { type: "compaction", id: "c", parentId: "b", summary: "summary" }, message("d", "user", [{ type: "image", data: "blob-data" }, { type: "text", text: "other branch" }], "a"), message("e", "toolResult", [{ type: "text", text: "tool output" }], "d"));
  for (const query of ["old prompt", "old answer", "other branch"]) expect((await search(content, "native-id", query)).snippet).toBe(query);
  for (const query of ["private reasoning", "tool output", "blob-data"]) expect((await search(content, "native-id", query)).snippet).toBeUndefined();
});
test("incomplete/invalid or differently owned native journals are not empty-success searches", async () => {
  await expect(search(journal(message("a", "user", "hello")), "different-id", "hello")).rejects.toThrow();
  await expect(search(journal() + "\n{bad-json", "native-id", "hello")).rejects.toThrow();
  await expect(search(JSON.stringify({ ...header, version: 99999 }), "native-id", "hello")).rejects.toThrow();
  await expect(search("", "native-id", "hello")).rejects.toThrow();
});
