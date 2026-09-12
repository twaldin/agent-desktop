import { describe, expect, test } from "bun:test";
import { parseQueuedSubmissionReceipt } from "./queued-submissions";

const base = { version: 1, commandId: "command", hostId: "host", sessionId: "session", delivery: "follow-up",
  phase: "queued", outcome: "pending", revision: 2, createdAt: 10, updatedAt: 11 } as const;

describe("queued submission receipt", () => {
  test("accepts the exact pending and final state relationships", () => {
    expect(parseQueuedSubmissionReceipt(base)).toEqual(base);
    expect(parseQueuedSubmissionReceipt({ ...base, phase: "settled", outcome: "succeeded", entryId: "entry", revision: 3 })).toMatchObject({ outcome: "succeeded", entryId: "entry" });
    expect(parseQueuedSubmissionReceipt({ ...base, phase: "settled", outcome: "unknown", message: "inspect", revision: 3 })).toMatchObject({ outcome: "unknown" });
  });
  test("rejects contradictory or incomplete receipts", () => {
    expect(() => parseQueuedSubmissionReceipt({ ...base, phase: "settled" })).toThrow();
    expect(() => parseQueuedSubmissionReceipt({ ...base, outcome: "succeeded" })).toThrow();
    expect(() => parseQueuedSubmissionReceipt({ ...base, phase: "settled", outcome: "succeeded" })).toThrow();
    expect(() => parseQueuedSubmissionReceipt({ ...base, entryId: "unexpected" })).toThrow();
    expect(() => parseQueuedSubmissionReceipt({ ...base, extra: "not allowed" })).toThrow();
  });
});
