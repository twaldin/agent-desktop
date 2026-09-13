import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostCommand } from "../../../packages/shared/src/protocol";
import type { ForceToolState } from "../../../packages/shared/src/force-tool";
import { HostStore } from "./store";
import { assertForceToolRecoveryCommand } from "./force-tool-recovery";

test("recovery uses the original durable receipt and prompt, not caller-selected replacement input", () => {
  const directory = mkdtempSync(join(tmpdir(), "force-recovery-journal-"));
  let store = new HostStore(directory);
  const original: Extract<HostCommand, { type: "session.prompt" }> = { type: "session.prompt", sessionId: "session",
    text: "/force:read inspect the file", model: { provider: "openai", id: "model" }, thinkingLevel: "high" };
  const state: ForceToolState = { epoch: "owner", revision: 3, nativeSessionId: "native", model: null,
    availability: { state: "supported", reason: "fixture native state" }, tools: [{ name: "read", available: true }],
    directives: [{ id: "directive", commandId: "original", toolName: "read", phase: "pending-tool", requeued: false }], canArm: true, canCancel: true };
  const recovery: typeof original = { ...original, text: "inspect the file", forceRecovery: { epoch: "owner", expectedRevision: 3, directiveId: "directive" } };
  try {
    store.claimCommand("original", "hash", original);
    store.finishCommand("original", "hash", { ok: false, commandId: "original", error: { code: "COMMAND_FAILED", message: "pre-prompt failure" },
      forceToolReceipt: { commandId: "original", epoch: "owner", directiveId: "directive", toolName: "read", arm: "armed", prompt: "not-recorded" } });
    store.close(); store = new HostStore(directory);
    expect(() => assertForceToolRecoveryCommand(recovery, state, id => store.getCommand(id))).not.toThrow();
    for (const changed of [
      { ...recovery, text: "replacement" }, { ...recovery, sessionId: "foreign" },
      { ...recovery, thinkingLevel: "low" }, { ...recovery, model: { provider: "openai", id: "other" } },
    ]) expect(() => assertForceToolRecoveryCommand(changed, state, id => store.getCommand(id))).toThrow("does not authorize");
    expect(() => assertForceToolRecoveryCommand(recovery, { ...state, revision: 4 }, id => store.getCommand(id))).toThrow();
    expect(() => assertForceToolRecoveryCommand(recovery, state, () => undefined)).toThrow();
    const saved = store.getCommand("original")!;
    for (const prompt of ["unknown", "recorded"] as const) {
      expect(() => assertForceToolRecoveryCommand(recovery, state, () => ({ ...saved, result: { ...saved.result!,
        forceToolReceipt: { ...saved.result!.forceToolReceipt!, prompt, ...(prompt === "recorded" ? { promptEntryId: "entry" } : {}) } } }))).toThrow();
    }
    expect(() => assertForceToolRecoveryCommand(recovery, state, () => ({ ...saved, state: "pending" }))).toThrow();
    // A preceding native directive is not a reason to reorder or reject this
    // recovery. Native FIFO still decides which choice the next turn serves.
    const preceding = { ...state.directives[0]!, id: "earlier", commandId: "another" };
    expect(() => assertForceToolRecoveryCommand(recovery, { ...state, directives: [preceding, ...state.directives] }, id => store.getCommand(id))).not.toThrow();
    expect(store.getCommand("original")).toEqual(saved);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
