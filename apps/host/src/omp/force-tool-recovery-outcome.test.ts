import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { beginNativePrompt, OmpPromptAdmissionError } from "./prompt";
import { wrapForceToolRecoveryOutcome } from "./force-tool-recovery-outcome";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function nativeManager() {
  const directory = await mkdtemp(join(tmpdir(), "agent-force-recovery-outcome-"));
  directories.push(directory);
  const manager = SessionManager.create(directory, join(directory, "sessions"));
  await manager.ensureOnDisk();
  return manager;
}
// Real beginNativePrompt and native storage; dispatch is deliberately controlled.
// These cases do not execute a provider or claim SDK command-dispatch parity.
test("a recovery side effect returning false without a user entry is unknown, while completion stays false", async () => {
  const manager = await nativeManager();
  let entered = false, effects = 0;
  try {
    const original = beginNativePrompt(manager, async () => {
      entered = true; effects++;
      manager.appendCustomEntry("controlled-recovery-effect", { effects });
      return { agentInvoked: false };
    }, async () => {});
    const wrapped = wrapForceToolRecoveryOutcome(original, () => entered);
    const error = await wrapped.accepted.catch(error => error);
    expect(error).toBeInstanceOf(OmpPromptAdmissionError);
    expect(error.code).toBe("OUTCOME_UNKNOWN");
    expect(wrapped.completion).toBe(original.completion);
    expect(await wrapped.completion).toBe(false);
    expect(effects).toBe(1);
    expect(manager.getEntries().some(entry => entry.type === "message")).toBe(false);
    expect(manager.getEntries().some(entry => entry.type === "custom" && entry.customType === "controlled-recovery-effect")).toBe(true);
  } finally { await manager.close(); }
});

test("a recovery command receipt is not a user receipt and cannot authorize another replay", async () => {
  const manager = await nativeManager();
  let entered = false;
  try {
    const original = beginNativePrompt(manager, async () => {
      entered = true;
      manager.appendCustomEntry("controlled-recovery-effect", {});
      return { agentInvoked: false, handledCommand: "controlled-custom" };
    }, async () => {});
    const wrapped = wrapForceToolRecoveryOutcome(original, () => entered);
    expect(await original.accepted).toEqual({ kind: "native-command", command: "controlled-custom" });
    expect((await wrapped.accepted.catch(error => error)).code).toBe("OUTCOME_UNKNOWN");
    expect(await wrapped.completion).toBe(false);
  } finally { await manager.close(); }
});

test("throwing after a recovery side effect makes admission unknown and preserves the original completion error", async () => {
  const manager = await nativeManager();
  const originalError = new Error("Controlled command failed after its effect");
  let entered = false, effects = 0;
  try {
    const original = beginNativePrompt(manager, async () => {
      entered = true; effects++;
      manager.appendCustomEntry("controlled-recovery-effect", { effects });
      throw originalError;
    }, async () => {});
    const wrapped = wrapForceToolRecoveryOutcome(original, () => entered);
    const error = await wrapped.accepted.catch(error => error);
    expect(error.code).toBe("OUTCOME_UNKNOWN");
    expect(error.cause).toBe(originalError);
    expect(await wrapped.completion.catch(error => error)).toBe(originalError);
    expect(effects).toBe(1);
  } finally { await manager.close(); }
});

test("a definite guard refusal before native prompt entry keeps its original error and completion", async () => {
  const manager = await nativeManager();
  const refusal = Object.assign(new Error("Recovery directive ticket is stale"), { code: "FORCE_TOOL_STALE" });
  try {
    const original = beginNativePrompt(manager, async () => { throw refusal; }, async () => {});
    const wrapped = wrapForceToolRecoveryOutcome(original, () => false);
    expect(await wrapped.accepted.catch(error => error)).toBe(refusal);
    expect(wrapped.completion).toBe(original.completion);
    expect(await wrapped.completion.catch(error => error)).toBe(refusal);
    expect(manager.getEntries().some(entry => entry.type === "message")).toBe(false);
  } finally { await manager.close(); }
});

test("a flushed user receipt survives a later independent recovery completion failure", async () => {
  const manager = await nativeManager();
  const finish = Promise.withResolvers<void>(), failure = new Error("Controlled later turn failure");
  let entered = false;
  try {
    const original = beginNativePrompt(manager, async () => {
      entered = true;
      manager.appendMessage({ role: "user", content: "Retained recovery prompt", timestamp: 1 });
      await finish.promise;
      throw failure;
    }, async () => {});
    const wrapped = wrapForceToolRecoveryOutcome(original, () => entered);
    const receipt = await wrapped.accepted;
    expect(receipt?.kind).toBe("user-message");
    expect(receipt).toBe(await original.accepted);
    const disk = (await readFile(manager.getSessionFile()!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(disk.some(entry => entry.id === (receipt as { entryId: string }).entryId && entry.message?.content === "Retained recovery prompt")).toBe(true);
    let completed = false;
    void wrapped.completion.then(() => { completed = true; }, () => { completed = true; });
    await Promise.resolve(); expect(completed).toBe(false);
    finish.resolve();
    expect(await wrapped.completion.catch(error => error)).toBe(failure);
    expect(await wrapped.accepted).toBe(receipt);
  } finally { finish.resolve(); await manager.close(); }
});

test("both rejected promises are handled while the caller is still waiting to attach its observers", async () => {
  const manager = await nativeManager();
  const error = new Error("Controlled delayed observation"), unhandled: unknown[] = [];
  const listener = (value: unknown) => { unhandled.push(value); };
  process.on("unhandledRejection", listener);
  try {
    const original = beginNativePrompt(manager, async () => { throw error; }, async () => {});
    const wrapped = wrapForceToolRecoveryOutcome(original, () => true);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(unhandled).toEqual([]);
    expect((await wrapped.accepted.catch(error => error)).code).toBe("OUTCOME_UNKNOWN");
    expect(await wrapped.completion.catch(cause => cause)).toBe(error);
  } finally { process.off("unhandledRejection", listener); await manager.close(); }
});
