import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { expect, test } from "bun:test";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import { TranscriptMirror } from "./transcript";

const notice = () => ({ role: "custom", customType: "async-result", display: true, timestamp: 42,
  content: "<system-notice>Original result, not a new instruction from the user.</system-notice>",
  details: { jobs: [{ jobId: "worker-a", type: "task", durationMs: 1234, privatePayload: "do-not-project" },
    { jobId: "bg_2", type: "bash", durationMs: 61_000 }], privateData: "do-not-project" } });
const project = (message: unknown) => new TranscriptMirror().snapshot([message], [{ id: "native-notice", message }])[0]!;

test("native completion metadata preserves the actual content and ignores private result payloads", () => {
  const source = notice(), value = project(source);
  expect(value).toMatchObject({ nativeId: "native-notice", text: source.content, backgroundJobs: [
    { jobId: "worker-a", type: "task", duration: "1.2s" }, { jobId: "bg_2", type: "bash", duration: "1m1s" },
  ] });
  expect(JSON.stringify(value)).not.toContain("do-not-project");
  source.details.jobs[0]!.jobId = "replacement";
  expect(value.backgroundJobs?.[0]?.jobId).toBe("worker-a");
});

test("pending native events and saved display copies retain the same completion identity", () => {
  const mirror = new TranscriptMirror(), source = notice();
  mirror.accept({ type: "message_end", message: source } as unknown as AgentSessionEvent);
  source.details.jobs[0]!.jobId = "mutated-after-event";
  const pending = mirror.snapshot([], [])[0]!;
  expect(pending.backgroundJobs?.[0]?.jobId).toBe("worker-a");
  const original = notice();
  const saved = mirror.snapshot([original], [{ id: "native-notice", message: original }])[0]!;
  expect(saved.backgroundJobs).toEqual(pending.backgroundJobs);
  expect(saved.id).toBe(pending.id);
  expect(project(original).backgroundJobs).toEqual(saved.backgroundJobs);
});

test("legacy single-job notices and missing optional fields match the native fallback", () => {
  expect(project({ ...notice(), details: { jobId: "old-job", type: "eval", durationMs: 0 } }).backgroundJobs)
    .toEqual([{ jobId: "old-job", type: "eval", duration: "0ms" }]);
  expect(project({ ...notice(), details: undefined }).backgroundJobs).toEqual([{ jobId: "unknown", type: "job" }]);
  expect(project({ ...notice(), details: { jobs: [], jobId: "single" } }).backgroundJobs).toEqual([{ jobId: "single", type: "job" }]);
});

test("text lookalikes and malformed or excessive metadata cannot become completion rows", () => {
  for (const message of [{ ...notice(), role: "assistant" }, { ...notice(), customType: "other" },
    { ...notice(), display: undefined }, { ...notice(), details: { jobs: [null] } },
    { ...notice(), details: { jobs: new Array(2) } },
    { ...notice(), details: { jobs: Array.from({ length: 257 }, () => ({ jobId: "x" })) } }]) {
    expect(project(message).backgroundJobs).toBeUndefined();
    expect(project(message).text).toBe(message.content);
  }
  expect(new TranscriptMirror().snapshot([{ ...notice(), display: false }], [])).toEqual([]);
});

test("unsafe optional scalars are omitted without exposing arbitrary objects", () => {
  expect(project({ ...notice(), details: { jobs: [{ jobId: { token: "private" }, type: "unexpected", durationMs: NaN },
    { jobId: "valid", type: "bash", durationMs: -1 }] } }).backgroundJobs)
    .toEqual([{ jobId: "unknown", type: "job" }, { jobId: "valid", type: "bash" }]);
});


test("a native custom completion reopens from its actual session journal without losing content or identity", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-desktop-job-notice-"));
  let manager = SessionManager.create(directory, path.join(directory, "sessions"));
  try {
    await manager.ensureOnDisk();
    const source = notice();
    const id = manager.appendCustomMessageEntry(source.customType, source.content, source.display, source.details, "agent", source.timestamp);
    await manager.flush();
    const file = manager.getSessionFile()!;
    await manager.close(); manager = await SessionManager.open(file);
    const entry = manager.getBranch().find(entry => entry.id === id);
    if (entry?.type !== "custom_message") throw new Error("Saved native notice is missing");
    const message = { role: "custom", customType: entry.customType, content: entry.content, display: entry.display, details: entry.details, timestamp: Date.parse(entry.timestamp) };
    const messages = manager.buildSessionContext({ transcript: true, collapseCompactedHistory: false, keepDanglingToolCalls: true }).messages;
    const saved = new TranscriptMirror().snapshot(messages, [{ id, message }]).find(item => item.nativeId === id)!;
    expect(saved.text).toBe(source.content);
    expect(saved.backgroundJobs).toEqual(project(source).backgroundJobs);
    expect(saved.id).toBe(project(source).id);
    expect(saved.lifecycle).toBe("complete");
    expect(JSON.stringify(saved)).not.toContain("do-not-project");
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test("malformed pending metadata stays ordinary and returned snapshots cannot mutate retained completion rows", () => {
  const mirror = new TranscriptMirror(), source = notice();
  mirror.accept({ type: "message_end", message: { ...source, details: { jobs: [null] } } } as unknown as AgentSessionEvent);
  expect(mirror.snapshot([], [])[0]?.backgroundJobs).toBeUndefined();
  const live = new TranscriptMirror();
  live.accept({ type: "message_end", message: source } as unknown as AgentSessionEvent);
  live.snapshot([], [])[0]!.backgroundJobs![0]!.jobId = "caller-mutation";
  expect(live.snapshot([], [])[0]?.backgroundJobs?.[0]?.jobId).toBe("worker-a");
});
