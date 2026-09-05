import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandEnvelope, CommandResult, Draft, SessionSummary } from "../../../../packages/shared/src/protocol";
import { HostStore } from "../../../host/src/store";
import type { DraftCache } from "./drafts";
import { SubmissionController } from "./submissions";

const original: Draft = { id: "new-conversation", revision: 7, text: "Original submitted input", projectId: "project-a", model: { provider: "fixture", id: "original" }, thinkingLevel: "low", updatedAt: 10 };
const edited: Draft = { ...original, revision: 8, text: "Newer local edit", projectId: "project-b", model: { provider: "fixture", id: "edited" }, thinkingLevel: "high" };
const session: SessionSummary = { id: "session-a", hostId: "host-a", projectId: "project-a", cwd: "/fixture/project", title: "Fixture session", status: "idle", sessionFile: "/fixture/session.jsonl", model: original.model, createdAt: 1, updatedAt: 1, archived: false };
function cache(): DraftCache {
  const values = new Map<string, string>();
  return { read: key => values.get(key) ?? null, write: (key, value) => { values.set(key, value); } };
}
const hash = (envelope: CommandEnvelope) => createHash("sha256").update(JSON.stringify(envelope.command)).digest("hex");
const unknown = (envelope: CommandEnvelope): CommandResult => ({ ok: false, commandId: envelope.id, error: { code: "OUTCOME_UNKNOWN", message: "This command was pending when the service stopped." } });

describe("unknown submission outcomes", () => {
  for (const phase of ["create", "prompt", "steer"] as const) {
    test(`${phase}: real reopened command ledger keeps one identity until a matching result resolves it`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "agent-submission-unknown-"));
      let store = new HostStore(directory);
      const storage = cache(), calls: CommandEnvelope[] = [];
      let originalEnvelope: CommandEnvelope | undefined;
      let executions = 0;
      // Controlled transport, actual durable SQLite ledger. No native/provider
      // turn is run: "executions" counts newly claimed fixture operations.
      const transport = async (envelope: CommandEnvelope): Promise<CommandResult> => {
        calls.push(structuredClone(envelope));
        const claim = store.claimCommand(envelope.id, hash(envelope), envelope.command);
        if (claim.kind === "done") return claim.record.result!;
        if (claim.kind === "pending") return unknown(envelope);
        if (claim.kind === "conflict") throw new Error("Changed original envelope");
        executions++;
        if (!originalEnvelope) { originalEnvelope = structuredClone(envelope); return unknown(envelope); }
        const result: CommandResult = { ok: true, commandId: envelope.id, value: session };
        store.finishCommand(envelope.id, hash(envelope), result); return result;
      };
      const mode = phase === "steer" ? "steer" : "prompt";
      let controller = new SubmissionController(transport, "host-a", storage);
      try {
        await expect(controller.submit(original, phase === "create" ? undefined : session.id, mode)).rejects.toThrow("pending");
        expect(controller.get(original.id)?.uncertain).toBe(true);
        expect(executions).toBe(1);
        store.close(); store = new HostStore(directory);
        controller = new SubmissionController(transport, "host-a", storage);
        for (let retry = 0; retry < 2; retry++) {
          await expect(controller.submit(edited, "different-session", mode === "prompt" ? "steer" : "prompt")).rejects.toThrow("pending");
          expect(controller.get(original.id)).toMatchObject({ uncertain: true, draft: original, mode });
          expect(calls.at(-1)).toEqual(originalEnvelope);
        }
        expect(executions).toBe(1);
        const receipt: CommandResult = { ok: true, commandId: originalEnvelope!.id, value: session };
        store.finishCommand(originalEnvelope!.id, hash(originalEnvelope!), receipt);
        const accepted = await controller.submit(edited, "different-session", "prompt");
        expect(accepted).toEqual({ sessionId: session.id, submitted: original, commandId: calls.at(-1)!.id });
        expect(controller.get(original.id)).toBeUndefined();
        expect(calls.slice(0, 4).every(call => JSON.stringify(call) === JSON.stringify(originalEnvelope))).toBe(true);
        expect(executions).toBe(phase === "create" ? 2 : 1);
        if (phase === "create") expect(calls.at(-1)?.command).toMatchObject({ type: "session.prompt", sessionId: session.id, text: original.text, draft: { id: original.id, revision: original.revision } });
      } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
    });
  }
  test("pre-lookup and identity-conflict responses cannot resolve an earlier uncertain send", async () => {
    const storage = cache(), calls: CommandEnvelope[] = [];
    const codes = ["OUTCOME_UNKNOWN", "HOST_STOPPING", "COMMAND_ID_REUSED", "OUTCOME_UNKNOWN"];
    const controller = new SubmissionController(async envelope => {
      calls.push(structuredClone(envelope));
      return { ok: false, commandId: envelope.id, error: { code: codes[calls.length - 1]!, message: codes[calls.length - 1]! } };
    }, "host-a", storage);
    for (const code of codes) {
      await expect(controller.submit(calls.length ? edited : original, session.id, "prompt")).rejects.toThrow(code);
      expect(controller.get(original.id)?.uncertain).toBe(true);
      expect(controller.get(original.id)?.draft).toEqual(original);
    }
    expect(calls.every(call => JSON.stringify(call) === JSON.stringify(calls[0]))).toBe(true);
    const restored = new SubmissionController(async () => { throw new Error("Not called"); }, "host-a", storage);
    expect(restored.get(original.id)?.send).toEqual(calls[0]);
  });
  test("a definite recorded rejection resolves uncertainty and permits an edited new command", async () => {
    const calls: CommandEnvelope[] = [];
    const controller = new SubmissionController(async envelope => {
      calls.push(structuredClone(envelope));
      if (calls.length === 1) return unknown(envelope);
      if (calls.length === 2) return { ok: false, commandId: envelope.id, error: { code: "PROMPT_NOT_RECORDED", message: "Native input was not recorded" } };
      return { ok: true, commandId: envelope.id, value: session };
    }, "host-a", cache());
    await expect(controller.submit(original, session.id, "prompt")).rejects.toThrow("pending");
    await expect(controller.submit(edited, session.id, "prompt")).rejects.toThrow("not recorded");
    expect(calls[1]).toEqual(calls[0]);
    expect(controller.get(original.id)?.uncertain).toBe(false);
    await controller.submit(edited, session.id, "prompt");
    expect(calls[2]?.id).not.toBe(calls[0]?.id);
    expect(calls[2]?.command).toMatchObject({ text: edited.text, model: edited.model, draft: { id: edited.id, revision: edited.revision } });
  });
});
