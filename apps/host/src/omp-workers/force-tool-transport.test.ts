import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerRuntime } from "./runtime";

const workerPath = fileURLToPath(new URL("./fixtures/force-tool-entry.ts", import.meta.url));

async function fixture(extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "force-tool-worker-"));
  const agentDir = join(root, "agent"), cwd = join(root, "project");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  const runtime = new WorkerRuntime({ agentDir, workerPath, startupTimeoutMs: 3_000, shutdownTimeoutMs: 3_000,
    environment: { HOME: root, PATH: process.env.PATH, TMPDIR: root, PI_CODING_AGENT_DIR: agentDir, PI_DISABLE_DOTENV: "1", ...extra } });
  try {
    const session = await runtime.create({ cwd });
    return { session, close: async () => { await runtime.dispose().catch(() => {}); await rm(root, { recursive: true, force: true }); } };
  } catch (error) {
    await runtime.dispose().catch(() => {}); await rm(root, { recursive: true, force: true }); throw error;
  }
}

const forceOptions = {
  commandId: "command-1", commandVersion: 18 as const,
  forceTool: { epoch: "epoch-1", expectedRevision: 3, toolName: "bash" },
};

test("ordinary command admission preserves colon-bearing identities through both worker boundaries", async () => {
  const f = await fixture({ FORCE_TOOL_PROMPT: "ordinary" });
  try {
    const run = f.session.startPrompt("/automation-flow scheduled", {
      commandId: "automation:run-id:prompt", commandVersion: 18,
    });
    await expect(run.accepted).resolves.toEqual({ kind: "native-command", command: "automation-flow" });
    await expect(run.completion).resolves.toBe(false);
    expect(run.forceToolReceipt).toBeUndefined();
  } finally { await f.close(); }
});

test("real worker entry validates force state/cancellation and publishes an accepted receipt before continuation", async () => {
  const f = await fixture();
  try {
    expect(await f.session.getForceTool()).toMatchObject({ epoch: "epoch-1", revision: 3, canArm: true, canCancel: true });
    expect(await f.session.cancelForceTool({ ticket: { epoch: "epoch-1", revision: 3 }, directiveId: "directive-1" }))
      .toMatchObject({ cancelledDirectiveId: "directive-1", state: { directives: [], canCancel: false } });
    const run = f.session.startPrompt("controlled force admission", forceOptions);
    expect(run.forceToolReceipt).toBeUndefined();
    expect(await run.accepted).toEqual({ kind: "user-message", entryId: "entry-1" });
    expect(run.forceToolReceipt).toEqual({ commandId: "command-1", epoch: "epoch-1", directiveId: "directive-1",
      toolName: "bash", arm: "armed", prompt: "recorded", promptEntryId: "entry-1" });
    Object.assign(run.forceToolReceipt!, { arm: "unknown" });
    expect(run.forceToolReceipt?.arm).toBe("armed");
    expect(await run.completion).toBe(true);
  } finally { await f.close(); }
});

test("a rejected native admission preserves its typed receipt independently of the sanitized remote error", async () => {
  const f = await fixture({ FORCE_TOOL_PROMPT: "rejected" });
  try {
    const run = f.session.startPrompt("controlled rejected force admission", forceOptions);
    const error = await run.accepted.catch(value => value) as Error & { forceToolReceipt?: unknown };
    expect(error).toMatchObject({ name: "NativeAdmissionError", forceToolReceipt: { commandId: "command-1", arm: "armed", prompt: "recorded" } });
    expect(error.forceToolReceipt).toEqual(run.forceToolReceipt);
    Object.assign(error.forceToolReceipt!, { prompt: "unknown" });
    expect(run.forceToolReceipt?.prompt).toBe("recorded");
    await expect(run.completion).rejects.toThrow("Native admission failed");
  } finally { await f.close(); }
});

test("real entry rejects malformed receipts and the parent rejects identity-changed IPC receipts and state", async () => {
  const malformed = await fixture({ FORCE_TOOL_PROMPT: "untyped" });
  try {
    const run = malformed.session.startPrompt("controlled malformed receipt", forceOptions);
    await expect(run.accepted).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(run.forceToolReceipt).toBeUndefined();
  } finally { await malformed.close(); }

  const raw = await fixture({ FORCE_TOOL_RAW_CHILD: "1" });
  try {
    await expect(raw.session.getForceTool()).rejects.toThrow("Invalid native force-tool keys");
    const run = raw.session.startPrompt("controlled changed identity", forceOptions);
    await expect(run.accepted).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(run.forceToolReceipt).toBeUndefined();
    expect(await run.completion).toBe(true);
  } finally { await raw.close(); }
});

test("worker loss keeps force admission outcome unknown without manufacturing an unarmed receipt", async () => {
  const f = await fixture({ FORCE_TOOL_PROMPT: "lost" });
  try {
    const run = f.session.startPrompt("controlled lost force admission", forceOptions);
    await expect(run.accepted).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(run.forceToolReceipt).toBeUndefined();
    await expect(run.completion).rejects.toBeTruthy();
  } finally { await f.close(); }
});

test("lost or malformed force cancellation delivery is unknown while native refusal remains regular", async () => {
  for (const mode of ["lost", "malformed"]) {
    const f = await fixture({ FORCE_TOOL_CANCEL: mode });
    try {
      await expect(f.session.cancelForceTool({ ticket: { epoch: "epoch-1", revision: 3 }, directiveId: "directive-1" }))
        .rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    } finally { await f.close(); }
  }

  const refused = await fixture({ FORCE_TOOL_CANCEL: "refused" });
  try {
    const error = await refused.session.cancelForceTool({ ticket: { epoch: "epoch-1", revision: 3 }, directiveId: "directive-1" }).catch(value => value);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: "Controlled native cancellation refusal" });
    expect(error).not.toHaveProperty("code", "OUTCOME_UNKNOWN");
  } finally { await refused.close(); }
});
