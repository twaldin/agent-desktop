import { expect, test } from "bun:test";
import type { AgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";

const { NativeSteerAdmission } = await import(process.env.STEER_DRAIN_MODULE ?? "./steer");

test("a failed native queue cleanup cannot finish drain while another dispatch is held", async () => {
  // Actual admission adapter with controlled native callback boundaries. No
  // provider, native process or physical cleanup claim.
  const held = Promise.withResolvers<void>();
  const queue: Array<{ role: "user"; content: string; timestamp: number }> = [];
  const agent = { state: { messages: [] }, steer(message: typeof queue[number]) { queue.push(message); },
    followUp(message: typeof queue[number]) { queue.push(message); }, peekSteeringQueue: () => queue,
    peekFollowUpQueue: () => [], replaceQueues() { throw new Error("queue cleanup failed"); }, subscribe: () => () => {} };
  const session = { agent, isStreaming: true, hasPostPromptWork: false,
    async steer(text: string) { if (text === "held") { await held.promise; throw new Error("cancelled held dispatch"); }
      agent.steer({ role: "user", content: text, timestamp: 1 }); },
    async settleInFlightMessagePersistence() {} };
  const manager = { getBranch: () => [], flush: async () => {} };
  const admission = new NativeSteerAdmission(session as unknown as AgentSession, manager as unknown as SessionManager);
  admission.subscribeQueue(() => { throw new Error("queue observer failed"); });
  let premature = false;
  try {
    admission.start("cleanup failure", "steer");
    admission.start("held", "steer");
    let settled = false;
    const drain = admission.settleCancelled("retiring").then(() => ({ error: undefined }), (error: unknown) => ({ error }))
      .then((result: { error: unknown }) => { settled = true; return result; });
    await new Promise<void>(resolve => setImmediate(resolve));
    premature = settled;
    held.resolve();
    const result = await drain;
    expect(premature).toBe(false);
    expect(result.error).toBeInstanceOf(AggregateError);
    expect((result.error as AggregateError).errors.map(error => (error as Error).message)).toContain("queue cleanup failed");
    // The failure was delivered to this drain. A later Stop must not report it
    // again after all original work has settled.
    await expect(admission.settleCancelled("later stop")).resolves.toBeUndefined();
  } finally { held.resolve(); admission.close(); }
});
