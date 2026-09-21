import { expect, test } from "bun:test";
import { TURN_REVIEW_OWNER_HEADER, type TurnReview } from "@agent-desktop/shared";
import { requestTurnReview } from "./turn-review-transport";

const endpoint = { origin: "https://owner.invalid", hostId: "owner" };
const limit = 8 * 1024 * 1024;
const value: TurnReview = { sessionId: "session", revision: "revision", state: "unavailable", reason: "", selected: null, files: [], patch: "" };
function envelope(bytes?: number): Uint8Array {
  const body = { hostId: "owner", sessionId: "session", value: { ...value } };
  if (bytes !== undefined) body.value.reason = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(body)));
  return Buffer.from(JSON.stringify(body));
}
function streamed(bytes: Uint8Array, owner = "owner") {
  let offset = 0, cancelled = 0, closed = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) { closed = true; controller.close(); return; }
      const next = Math.min(bytes.length, offset + 1024 * 1024);
      controller.enqueue(bytes.subarray(offset, next)); offset = next;
    },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 });
  return { response: new Response(stream, { headers: { [TURN_REVIEW_OWNER_HEADER]: owner } }), state: () => ({ offset, cancelled, closed }) };
}
async function withResponse(response: Response, check: () => Promise<void>) {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
  try { await check(); } finally { globalThis.fetch = previous; }
}

test("recorded review accepts a complete streamed response at the byte limit", async () => {
  const body = envelope(limit), read = streamed(body);
  expect(body.byteLength).toBe(limit);
  await withResponse(read.response, async () => {
    const result = await requestTurnReview(endpoint, "session");
    expect(result.sessionId).toBe("session");
    expect(result.reason?.length).toBe(limit - envelope().byteLength);
    expect(read.state()).toEqual({ offset: limit, cancelled: 0, closed: true });
  });
});

test("recorded review rejects and cancels a valid JSON response one byte over the limit", async () => {
  const read = streamed(envelope(limit + 1));
  await withResponse(read.response, async () => {
    await expect(requestTurnReview(endpoint, "session")).rejects.toThrow("8 MiB response limit");
    expect(read.state()).toEqual({ offset: limit + 1, cancelled: 1, closed: false });
  });
});

test("foreign-owner stream is cancelled without reading or accepting its payload", async () => {
  const read = streamed(envelope(), "other");
  await withResponse(read.response, async () => {
    await expect(requestTurnReview(endpoint, "session")).rejects.toThrow("another host");
    expect(read.state()).toEqual({ offset: 0, cancelled: 1, closed: false });
  });
});

test("bounded errors preserve host refusal and successful-schema validation", async () => {
  const headers = { [TURN_REVIEW_OWNER_HEADER]: "owner" };
  await withResponse(Response.json({ error: "Original owner retired" }, { status: 409, headers }), async () => {
    await expect(requestTurnReview(endpoint, "session")).rejects.toThrow("Original owner retired");
  });
  await withResponse(Response.json({ hostId: "owner", sessionId: "session", value: {} }, { headers }), async () => {
    await expect(requestTurnReview(endpoint, "session")).rejects.toThrow("Invalid recorded file inventory");
  });
  await withResponse(new Response("{", { headers }), async () => {
    await expect(requestTurnReview(endpoint, "session")).rejects.toThrow();
  });
});
