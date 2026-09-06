import { expect, test } from "bun:test";
import { BtwService } from "./btw";
import type { NativeBtwSnapshot } from "@agent-desktop/shared";

const session = { id: "s", archived: false, status: "running" };
const value = (status: NativeBtwSnapshot["status"] = "running"): NativeBtwSnapshot => ({ runId: "r", sessionId: "s", question: "q", status, answer: status === "complete" ? "answer" : "", startedAt: 1, updatedAt: 2, ...(status === "failed" ? { error: "failed" } : {}) });
function fixture(existing: { getBtw(): Promise<NativeBtwSnapshot | null>; startBtw(input: { runId: string; question: string }): Promise<NativeBtwSnapshot>; cancelBtw(runId: string): Promise<NativeBtwSnapshot | null> } | undefined = undefined) {
  let saved: NativeBtwSnapshot | null = null; const writes: Array<NativeBtwSnapshot | null> = [];
  const service = new BtwService({ session: id => id === "s" ? session : undefined, read: () => saved, write: (_id, next) => { saved = next; writes.push(next); }, getHandle: async () => { if (!existing) throw new Error("worker unavailable"); return existing; }, getExistingHandle: async () => existing });
  return { service, writes, get saved() { return saved; }, set saved(next: NativeBtwSnapshot | null) { saved = next; } };
}

test("start durably records intent before native admission and preserves failed outcome", async () => {
  const f = fixture({ getBtw: async () => null, startBtw: async () => { throw new Error("lost receipt"); }, cancelBtw: async () => null });
  await expect(f.service.start("s", { runId: "new", question: "question" })).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  expect(f.writes.length).toBe(2); expect(f.saved?.runId).toBe("new"); expect(f.saved?.status).toBe("failed");
});

test("snapshot refreshes an existing worker but never opens a missing worker", async () => {
  const f = fixture({ getBtw: async () => value("complete"), startBtw: async () => value(), cancelBtw: async () => null }); f.saved = value();
  expect((await f.service.snapshot("s"))?.status).toBe("complete");
  const lost = fixture(); lost.saved = value(); expect((await lost.service.snapshot("s"))?.status).toBe("failed"); expect(lost.writes.at(-1)?.error).toContain("will not be replayed");
});

test("cancel requires the exact current run and an existing worker", async () => {
  const f = fixture(); f.saved = value(); await expect(f.service.cancel("s", "r")).rejects.toThrow("unavailable");
  const wrong = fixture({ getBtw: async () => null, startBtw: async () => value(), cancelBtw: async () => value("cancelled") }); wrong.saved = value(); await expect(wrong.service.cancel("s", "other")).rejects.toThrow("no longer current");
  const cancelled = fixture({ getBtw: async () => null, startBtw: async () => value(), cancelBtw: async () => value("cancelled") }); cancelled.saved = value(); expect((await cancelled.service.cancel("s", "r"))?.status).toBe("cancelled");
});

test("archived and foreign sessions are rejected before worker access", async () => {
  const f = fixture(); await expect(f.service.start("missing", { runId: "r", question: "q" })).rejects.toThrow("does not exist");
  const archived = fixture(); session.archived = true; await expect(archived.service.start("s", { runId: "r", question: "q" })).rejects.toThrow("Archived"); session.archived = false;
});

test("a worker replacement after composer validation rejects before intent or native dispatch", async () => {
  let starts = 0;
  const checked = { getBtw: async () => null, startBtw: async () => { starts++; return value(); }, cancelBtw: async () => null };
  const replacement = { getBtw: async () => null, startBtw: async () => { starts++; return value(); }, cancelBtw: async () => null };
  let saved: NativeBtwSnapshot | null = null, writes = 0;
  const service = new BtwService({ session: id => id === "s" ? session : undefined, read: () => saved,
    write: (_id, next) => { saved = next; writes++; }, getHandle: async () => replacement, getExistingHandle: async () => replacement });
  await expect(service.start("s", { runId: "checked-run", question: "question" }, checked)).rejects.toThrow("changed before admission");
  expect(starts).toBe(0); expect(writes).toBe(0); expect(saved).toBeNull();
});
