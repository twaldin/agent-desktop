// A controlled pause after a real durable Goal write, before prompt dispatch.
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
globalThis.fetch = Object.assign(async () => { throw new Error("Outbound fetch is disabled in the Goal admission contract"); }, { preconnect: () => {} }) as typeof fetch;
const { SessionManager } = await import("@oh-my-pi/pi-coding-agent/session/session-manager");
const original = SessionManager.prototype.flush;
SessionManager.prototype.flush = async function () {
  await original.call(this);
  const gates = process.env.GOAL_COMPOSER_GATES!;
  if (existsSync(path.join(gates, "hold-goal")) && this.getEntries().some(entry => entry.type === "mode_change" && entry.mode === "goal")) {
    writeFileSync(path.join(gates, "goal-durable"), "");
    const deadline = Date.now() + 10_000;
    while (!existsSync(path.join(gates, "goal-release"))) {
      if (Date.now() > deadline) throw new Error("Controlled Goal durability gate timed out");
      await Bun.sleep(5);
    }
  }
};
const { AgentSession } = await import("@oh-my-pi/pi-coding-agent");
const abort = AgentSession.prototype.abort;
AgentSession.prototype.abort = async function (...args) {
  writeFileSync(path.join(process.env.GOAL_COMPOSER_GATES!, "abort-entered"), "");
  return abort.apply(this, args);
};
await import("../entry");
