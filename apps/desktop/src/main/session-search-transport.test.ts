import { afterEach, expect, test } from "bun:test";
import { SESSION_SEARCH_OWNER_HEADER, type SessionSearchResult } from "@agent-desktop/shared";
import { requestSessionSearch } from "./session-search-transport";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const endpoint = { origin: "http://unused.invalid", hostId: "owner", token: "test-token" };
const request = { query: " needle ", includeContent: true, limit: 9 };
const result: SessionSearchResult = { version: 1, hostId: "owner", query: "needle", includeContent: true, hits: [], coverage: "complete", moreMatches: false, unreadableSessions: 0, unsearchedSessions: 0 };
const response = (value: unknown, status = 200, owner = "owner") => Response.json(value, { status, headers: { [SESSION_SEARCH_OWNER_HEADER]: owner } });
test("search encodes the query and checks both authenticated owner header and body", async () => {
  let calls = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    expect(String(url)).toBe("http://unused.invalid/v1/sessions/search?query=needle&content=true&limit=9");
    const headers = new Headers(init?.headers);
    expect(headers.get(SESSION_SEARCH_OWNER_HEADER)).toBe("owner"); expect(headers.get("Authorization")).toBe("Bearer test-token");
    expect(init?.redirect).toBe("error"); expect(init?.signal).toBeInstanceOf(AbortSignal);
    return response(result);
  }) as unknown as typeof fetch;
  expect(await requestSessionSearch(endpoint, request)).toEqual(result); expect(calls).toBe(1);
});
test("uncoded missing endpoint is unsupported while coded failures and unauthorized stay failures", async () => {
  for (const [status, body, code] of [[404, { error: "Not found" }, "SESSION_SEARCH_UNSUPPORTED"], [404, { error: { code: "SESSION_NOT_FOUND", message: "Missing owner" } }, "SESSION_NOT_FOUND"], [401, { error: "Unauthorized" }, undefined], [429, { error: { code: "SEARCH_BUSY", message: "Busy" } }, "SEARCH_BUSY"]] as const) {
    globalThis.fetch = (async () => response(body, status)) as unknown as typeof fetch;
    await expect(requestSessionSearch(endpoint, request)).rejects.toMatchObject({ status, ...(code ? { code } : {}) });
  }
});
test("rejects wrong owner, wrong query, duplicate IDs and falsely complete coverage", async () => {
  globalThis.fetch = (async () => response(result, 200, "foreign")) as unknown as typeof fetch;
  await expect(requestSessionSearch(endpoint, request)).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
  const hit = { sessionId: "s", title: "title", projectId: null, updatedAt: 1, archived: false, match: "title" };
  for (const bad of [{ ...result, hostId: "foreign" }, { ...result, query: "old" }, { ...result, hits: [hit, hit] }, { ...result, unreadableSessions: 1 }, { ...result, includeContent: false }, { ...result, hits: [{ ...hit, match: "history" }] }]) {
    globalThis.fetch = (async () => response(bad)) as unknown as typeof fetch;
    await expect(requestSessionSearch(endpoint, request)).rejects.toThrow();
  }
});
test("bounded partial search remains visible as partial and invalid input never fetches", async () => {
  let calls = 0;
  const partial: SessionSearchResult = { ...result, coverage: "partial", unreadableSessions: 1, unsearchedSessions: 2 };
  globalThis.fetch = (async () => { calls++; return response(partial); }) as unknown as typeof fetch;
  expect(await requestSessionSearch(endpoint, request)).toEqual(partial);
  await expect(requestSessionSearch(endpoint, { ...request, query: "" })).rejects.toThrow(); expect(calls).toBe(1);
});

test("caller cancellation reaches fetch and oversized/error foreign bodies are rejected", async () => {
  const controller = new AbortController(); let observed!: AbortSignal;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => { observed = init!.signal!; return response(result); }) as unknown as typeof fetch;
  await requestSessionSearch(endpoint, request, controller.signal);
  controller.abort(); expect(observed.aborted).toBe(true);
  let cancelled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array(65 * 1024)); }, cancel() { cancelled = true; } }), { headers: { [SESSION_SEARCH_OWNER_HEADER]: "owner" } })) as unknown as typeof fetch;
  await expect(requestSessionSearch(endpoint, request)).rejects.toThrow("oversized"); expect(cancelled).toBe(true);
  globalThis.fetch = (async () => response({ error: "foreign" }, 401, "foreign")) as unknown as typeof fetch;
  await expect(requestSessionSearch(endpoint, request)).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
});
