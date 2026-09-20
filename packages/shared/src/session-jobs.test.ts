import { expect, test } from "bun:test";
import { assertSessionJobsResultMatches, parseSessionJobsEnvelope, parseSessionJobsResult, parseSessionJobsSnapshot, SESSION_JOBS_MAX_OUTPUT_CHARS,
  type SessionJobRow, type SessionJobsResult, type SessionJobsSnapshot } from "./session-jobs";

const owner = { nativeSessionId: "session", epoch: "epoch-1", agentId: "Main" };
const row = (id: string, status: SessionJobRow["status"], queued = false): SessionJobRow => ({ target: { id, startTime: 10, guard: `guard-${id}` }, type: "bash", status, label: "sleep", queued });
const snapshot = (running: SessionJobRow[] = [row("bg_1", "running")], recent: SessionJobRow[] = [row("bg_2", "completed")]): SessionJobsSnapshot =>
  ({ owner, availability: "available", running, recent, delivery: { queued: 0, delivering: false, pendingJobIds: [] } });

test("queued is a flag on running rows and rows stay in their native list without duplicates", () => {
  expect(parseSessionJobsSnapshot(snapshot([row("bg_1", "running", true)]))).toEqual(snapshot([row("bg_1", "running", true)]));
  expect(() => parseSessionJobsSnapshot(snapshot([], [row("bg_2", "completed", true)]))).toThrow();
  expect(() => parseSessionJobsSnapshot(snapshot([], [row("bg_2", "running")]))).toThrow();
  expect(() => parseSessionJobsSnapshot(snapshot([row("bg_1", "running")], [row("bg_1", "failed")]))).toThrow();
  expect(() => parseSessionJobsSnapshot({ owner, availability: "unavailable", reason: "no manager", running: [] })).toThrow();
});

test("control results require the manager they came from and bounded retained output", () => {
  const unavailable = { owner, availability: "unavailable" as const, reason: "no manager" };
  expect(parseSessionJobsResult({ action: "read", snapshot: unavailable }).snapshot.availability).toBe("unavailable");
  expect(() => parseSessionJobsResult({ action: "cancel", snapshot: unavailable, requested: false })).toThrow();
  const detail = { target: row("bg_2", "completed").target, resultText: "x".repeat(SESSION_JOBS_MAX_OUTPUT_CHARS), truncated: true, consumed: false };
  expect(parseSessionJobsResult({ action: "inspect", snapshot: snapshot(), detail })).toEqual({ action: "inspect", snapshot: snapshot(), detail });
  expect(() => parseSessionJobsResult({ action: "inspect", snapshot: snapshot(), detail: { ...detail, resultText: `${detail.resultText}x` } })).toThrow();
  expect(() => parseSessionJobsResult({ action: "inspect", snapshot: snapshot(), detail, requested: true })).toThrow();
});

test("envelope binds host, session and the native owner it reports", () => {
  const result: SessionJobsResult = { action: "read", snapshot: snapshot() };
  const envelope = { protocolVersion: 1, hostId: "home", sessionId: "session", result };
  expect(parseSessionJobsEnvelope(envelope, "home", "session")).toEqual(envelope as never);
  expect(() => parseSessionJobsEnvelope(envelope, "work", "session")).toThrow();
  expect(() => parseSessionJobsEnvelope(envelope, "home", "other")).toThrow();
  expect(() => parseSessionJobsEnvelope({ ...envelope, result: { ...result, snapshot: { ...snapshot(), owner: { ...owner, nativeSessionId: "other" } } } }, "home", "session")).toThrow();
});

test("a result answers only the request it was dispatched for", () => {
  const read: SessionJobsResult = { action: "read", snapshot: snapshot() };
  assertSessionJobsResultMatches({ action: "read" }, read);
  assertSessionJobsResultMatches({ action: "read", owner }, read);
  expect(() => assertSessionJobsResultMatches({ action: "read", owner: { ...owner, epoch: "epoch-2" } }, read)).toThrow();
  expect(() => assertSessionJobsResultMatches({ action: "read", owner: { nativeSessionId: "session", epoch: "epoch-1" } }, read)).toThrow();
  const job = row("bg_2", "completed").target;
  expect(() => assertSessionJobsResultMatches({ action: "cancel", owner, job }, read)).toThrow();
  const inspect: SessionJobsResult = { action: "inspect", snapshot: snapshot(), detail: { target: job, truncated: false, consumed: false } };
  assertSessionJobsResultMatches({ action: "inspect", owner, job }, inspect);
  expect(() => assertSessionJobsResultMatches({ action: "inspect", owner, job: { ...job, guard: "other" } }, inspect)).toThrow();
});
