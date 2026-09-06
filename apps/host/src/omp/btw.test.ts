import { expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { NativeBtwController } from "./btw";

const assistant = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], api: "fixture" as never,
  provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 });
const settle = async (controller: NativeBtwController, status: string) => {
  for (let index = 0; index < 100 && controller.get()?.status !== status; index++) await Bun.sleep(1);
  return controller.get();
};
const origin = (sessionId: string, leafId = "leaf-one") => ({
  sessionManager: { getSessionId: () => sessionId, getLeafId: () => leafId },
  async branchFromBtw() { return { cancelled: false, sessionFile: "/fixture/branched.jsonl" }; },
});

test("native btw renders the pinned prompt, streams bounded output, and makes the same identity idempotent", async () => {
  const calls: Array<{ promptText: string; signal?: AbortSignal }> = [];
  const session = { sessionId: "session-one", model: { id: "controlled" }, ...origin("session-one"), async runEphemeralTurn(args: any) {
    calls.push(args); args.onTextDelta("delta "); return { replyText: "answer", assistantMessage: assistant("answer") };
  } } as any;
  const controller = new NativeBtwController(session, (() => { let value = 10; return () => ++value; })());
  const started = controller.start({ runId: "run-one", question: "  What happened?  " });
  expect(started).toMatchObject({ runId: "run-one", sessionId: "session-one", question: "What happened?", status: "running" });
  expect((await settle(controller, "complete"))?.answer).toBe("answer");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.promptText).toContain("<btw>"); expect(calls[0]!.promptText).toContain("Question:\nWhat happened?\n</btw>");
  expect(controller.start({ runId: "run-one", question: "What happened?" }).status).toBe("complete");
  expect(calls).toHaveLength(1);
  expect(() => controller.start({ runId: "run-one", question: "Different" })).toThrow("reused with different input");
});

test("replacement and cancellation affect only the exact side request", async () => {
  const calls: Array<{ signal: AbortSignal; resolve(value: unknown): void }> = [];
  const session = { sessionId: "session-two", model: { id: "controlled" }, ...origin("session-two"), runEphemeralTurn(args: any) {
    return new Promise((resolve, reject) => { calls.push({ signal: args.signal, resolve }); args.signal.addEventListener("abort", () => reject(args.signal.reason)); });
  } } as any;
  const controller = new NativeBtwController(session);
  controller.start({ runId: "one", question: "First" });
  controller.start({ runId: "two", question: "Second" });
  expect(calls[0]!.signal.aborted).toBe(true);
  expect(controller.cancel("one")?.status).toBe("cancelled");
  expect(calls[1]!.signal.aborted).toBe(false);
  expect(controller.cancel("two")?.status).toBe("cancelled");
  expect(calls[1]!.signal.aborted).toBe(true);
  expect(controller.cancel("missing")).toBeNull();
  controller.start({ runId: "three", question: "Dispose this side request" });
  controller.dispose();
  expect(calls[2]!.signal.aborted).toBe(true);
  expect(() => controller.start({ runId: "four", question: "Cannot restart" })).toThrow("disposed");
});

test("evicted run identities never replay and the bounded identity ledger fails closed", async () => {
  let calls = 0;
  const session = { sessionId: "session-three", model: { id: "controlled" }, ...origin("session-three"), async runEphemeralTurn() {
    calls++; return { replyText: "done", assistantMessage: assistant("done") };
  } } as any;
  const controller = new NativeBtwController(session);
  for (let index = 0; index < 128; index++) {
    controller.start({ runId: `run-${index}`, question: `Question ${index}` });
    await Bun.sleep(0);
  }
  expect(calls).toBe(128);
  expect(() => controller.start({ runId: "run-0", question: "Question 0" })).toThrow("no longer inspectable");
  expect(() => controller.start({ runId: "run-128", question: "Question 128" })).toThrow("worker request capacity");
  expect(calls).toBe(128);
});

test("question, answer, and error bounds are enforced without exposing mutable snapshots", async () => {
  const session = { sessionId: "session-four", model: { id: "controlled" }, ...origin("session-four"), async runEphemeralTurn(args: any) {
    if (args.promptText.includes("empty-error")) throw new Error("");
    if (args.promptText.includes("fail")) throw new Error("x".repeat(4095) + "🙂");
    return { replyText: "x".repeat(1024 * 1024 - 1) + "🙂", assistantMessage: assistant("") };
  } } as any;
  const controller = new NativeBtwController(session);
  expect(() => controller.start({ runId: "oversize", question: "x".repeat(32 * 1024 + 1) })).toThrow("32 KiB");
  const external = controller.start({ runId: "answer", question: "answer" }); external.answer = "tampered";
  const complete = await settle(controller, "failed");
  expect(new TextEncoder().encode(complete!.answer).byteLength).toBeLessThanOrEqual(1024 * 1024);
  expect(complete).toMatchObject({ status: "failed", error: "Native /btw answer exceeded 1 MiB" });
  expect(complete!.answer).not.toBe("tampered");
  controller.start({ runId: "failure", question: "fail" });
  const failed = await settle(controller, "failed");
  expect(new TextEncoder().encode(failed!.error!).byteLength).toBeLessThanOrEqual(4096);
  expect(failed!.error).toBe("x".repeat(4095));
  controller.start({ runId: "empty-failure", question: "empty-error" });
  expect((await settle(controller, "failed"))?.error).toBe("Native /btw failed");
});

test("completed current answer promotes from its captured origin once and retains the settled receipt", async () => {
  const calls: any[] = [];
  let resolveBranch!: (value: { cancelled: boolean; sessionFile: string | undefined }) => void;
  const branch = new Promise<{ cancelled: boolean; sessionFile: string | undefined }>(resolve => { resolveBranch = resolve; });
  const raw = { ...assistant("provider answer"), providerPayload: { private: "provider state" }, content: [
    { type: "thinking" as const, thinking: "reasoning" }, { type: "redactedThinking" as const, data: "hidden" },
    { type: "text" as const, text: "provider answer" }, { type: "text" as const, text: "duplicate" },
  ] } as unknown as AssistantMessage;
  const manager = { getSessionId: () => "promotion-session", getLeafId: () => "captured-leaf" };
  const session = { sessionId: "promotion-session", model: { id: "controlled" }, sessionManager: manager,
    async runEphemeralTurn() { return { replyText: "visible answer", assistantMessage: raw }; },
    branchFromBtw(question: string, message: AssistantMessage, leafId: string, sessionId: string) {
      calls.push({ question, message, leafId, sessionId }); return branch;
    } } as any;
  const controller = new NativeBtwController(session);
  controller.start({ runId: "promote-one", question: "Use this answer" });
  await settle(controller, "complete");
  const first = controller.promote("promote-one");
  await expect(controller.promote("promote-one")).rejects.toThrow("already in progress");
  expect(() => controller.start({ runId: "replacement-during-branch", question: "Replace" })).toThrow("promotion is in progress");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ question: "Use this answer", leafId: "captured-leaf", sessionId: "promotion-session",
    message: { providerPayload: undefined, content: [{ type: "thinking", thinking: "reasoning" }, { type: "text", text: "visible answer" }] } });
  resolveBranch({ cancelled: false, sessionFile: "/fixture/promoted.jsonl" });
  expect(await first).toEqual({ cancelled: false, sessionFile: "/fixture/promoted.jsonl" });
  expect(await controller.promote("promote-one")).toEqual({ cancelled: false, sessionFile: "/fixture/promoted.jsonl" });
  expect(calls).toHaveLength(1);
});

test("promotion rejects incomplete, replaced, and stale origins without native effects", async () => {
  let leaf = "leaf-a", nativeSessionId = "stale-session", branches = 0;
  const pending: Array<(value: unknown) => void> = [];
  const session = { sessionId: "stale-session", model: { id: "controlled" },
    sessionManager: { getSessionId: () => nativeSessionId, getLeafId: () => leaf },
    runEphemeralTurn() { return new Promise(resolve => pending.push(resolve)); },
    async branchFromBtw() { branches++; return { cancelled: false, sessionFile: "/unexpected" }; } } as any;
  const controller = new NativeBtwController(session);
  await expect(controller.promote("missing")).rejects.toThrow("unknown");
  controller.start({ runId: "old", question: "Old" });
  await expect(controller.promote("old")).rejects.toThrow("not complete");
  pending[0]!({ replyText: "old answer", assistantMessage: assistant("old answer") }); await settle(controller, "complete");
  controller.start({ runId: "current", question: "Current" });
  await expect(controller.promote("old")).rejects.toThrow("replaced");
  pending[1]!({ replyText: "current answer", assistantMessage: assistant("current answer") }); await settle(controller, "complete");
  leaf = "leaf-b";
  await expect(controller.promote("current")).rejects.toThrow("changed");
  leaf = "leaf-a"; nativeSessionId = "replacement-session";
  await expect(controller.promote("current")).rejects.toThrow("changed");
  expect(branches).toBe(0);
});

test("cancelled and failed native promotion outcomes are retained without replay", async () => {
  for (const outcome of ["cancelled", "failed"] as const) {
    let calls = 0;
    const session = { sessionId: `session-${outcome}`, model: { id: "controlled" }, ...origin(`session-${outcome}`),
      async runEphemeralTurn() { return { replyText: "answer", assistantMessage: assistant("answer") }; },
      async branchFromBtw() {
        calls++;
        if (outcome === "failed") throw new Error("native transition outcome is unknown");
        return { cancelled: true, sessionFile: "/fixture/original.jsonl" };
      } } as any;
    const controller = new NativeBtwController(session);
    controller.start({ runId: `run-${outcome}`, question: "Promote" }); await settle(controller, "complete");
    if (outcome === "failed") {
      await expect(controller.promote("run-failed")).rejects.toThrow("outcome is unknown");
      await expect(controller.promote("run-failed")).rejects.toThrow("outcome is unknown");
    } else {
      expect(await controller.promote("run-cancelled")).toEqual({ cancelled: true, sessionFile: "/fixture/original.jsonl" });
      expect(await controller.promote("run-cancelled")).toEqual({ cancelled: true, sessionFile: "/fixture/original.jsonl" });
    }
    expect(calls).toBe(1);
  }
});
