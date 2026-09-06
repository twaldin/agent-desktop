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

test("native btw renders the pinned prompt, streams bounded output, and makes the same identity idempotent", async () => {
  const calls: Array<{ promptText: string; signal?: AbortSignal }> = [];
  const session = { sessionId: "session-one", model: { id: "controlled" }, async runEphemeralTurn(args: any) {
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
  const session = { sessionId: "session-two", model: { id: "controlled" }, runEphemeralTurn(args: any) {
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
  const session = { sessionId: "session-three", model: { id: "controlled" }, async runEphemeralTurn() {
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
  const session = { sessionId: "session-four", model: { id: "controlled" }, async runEphemeralTurn(args: any) {
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
