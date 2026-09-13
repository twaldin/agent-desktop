import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PlanExternalEditorEdit, PlanExternalEditorRequest } from "../../../../packages/shared/src/plan-external-editor";
import type { SessionPlan } from "../../../../packages/shared/src/session-plan";
import { WorkerRuntime, type WorkerSession } from "./runtime";

const workerPath = fileURLToPath(new URL("./fixtures/plan-external-editor-worker.ts", import.meta.url));

async function fixture(scenario = "normal") {
  const root = await mkdtemp(path.join(tmpdir(), "agent-desktop-plan-external-editor-worker-"));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), temporary = path.join(root, "tmp");
  await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(temporary)]);
  await writeFile(path.join(agentDir, "config.yml"), ["extensions: []", "plan:", "  enabled: true",
    "  defaultOnStartup: false", "defaultThinkingLevel: low", "modelRoles:",
    "  default: [plan-editor-runtime/controlled]", "  plan: [plan-editor-runtime/controlled:low]", ""].join("\n"));
  await writeFile(path.join(agentDir, "models.yml"), JSON.stringify({ providers: { "plan-editor-runtime": {
    api: "openai-completions", baseUrl: "https://plan-editor-runtime.invalid/v1", auth: "none", models: [{
      id: "controlled", name: "Controlled native Plan editor runtime", reasoning: false, input: ["text"], contextWindow: 128000,
      maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  } } }));
  const runtime = new WorkerRuntime({ agentDir, workerPath, environment: {
    HOME: root, PATH: process.env.PATH, TMPDIR: temporary, TERM: "dumb", PI_DISABLE_DOTENV: "1", PI_CODING_AGENT_DIR: agentDir,
    VISUAL: "fixture-editor --wait", EDITOR: "fixture-fallback-editor", PLAN_EDITOR_ENV_MARKER: "private-ipc-only",
    PLAN_EDITOR_REPLY_SCENARIO: scenario,
  }, startupTimeoutMs: 30_000, shutdownTimeoutMs: 10_000 });
  return { root, agentDir, cwd, runtime };
}

async function enterAndReview(session: WorkerSession, name = "external-editor-worker-plan.md"): Promise<SessionPlan> {
  let state = await session.getPlan();
  if (state.mode !== "active") state = (await session.controlPlan({ sessionId: session.id, ticket: state.ticket, action: "toggle" })).state;
  const run = session.startPrompt(`[write-plan:${name}] Preserve the exact worker-owned input.`);
  expect(await run.accepted).toMatchObject({ kind: "user-message" }); expect(await run.completion).toBeTrue();
  state = await session.getPlan();
  return (await session.controlPlan({ sessionId: session.id, ticket: state.ticket, action: "review" })).state;
}

function request(session: WorkerSession, state: SessionPlan, edit: PlanExternalEditorEdit = { kind: "plan" }): PlanExternalEditorRequest {
  if (!state.review?.document) throw new Error(`Missing Plan editor review owner: ${JSON.stringify(state)}`);
  return { requestId: randomUUID(), controlEpoch: randomUUID(), sessionId: session.id, ticket: state.ticket,
    reviewId: state.review.id, reviewRevision: state.review.revision,
    documentRevision: state.review.document.documentRevision, edit };
}

test("actual worker selects the original Plan editor owner and keeps command/environment private to IPC", async () => {
  const { root, cwd, runtime } = await fixture();
  let session: WorkerSession | undefined;
  try {
    session = await runtime.create({ cwd, model: { provider: "plan-editor-runtime", id: "controlled" } });
    expect(await session.getPlanExternalEditorAvailable()).toBe(true);
    const state = await enterAndReview(session);
    const input = request(session, state);
    const prepared = await session.preparePlanExternalEditor(input);
    expect(prepared).toMatchObject({ request: input, nativeSessionId: session.id, sessionFile: session.sessionFile, cwd: await realpath(cwd),
      content: "# External editor worker Plan\nPreserve the exact worker-owned input.\n", extension: ".md",
      trimTrailingNewline: false, editorCommand: "fixture-editor --wait" });
    expect(prepared.environment).toMatchObject({ HOME: root, TMPDIR: path.join(root, "tmp"),
      PLAN_EDITOR_ENV_MARKER: "private-ipc-only" });
    expect(JSON.stringify(await session.getPlan())).not.toContain("fixture-editor --wait");
    expect(JSON.stringify(await session.getPlan())).not.toContain("private-ipc-only");

    const retired = session;
    const retiredId = retired.id;
    await retired.dispose(); session = undefined;
    const retiredAt = performance.now();
    await expect(retired.preparePlanExternalEditor(input)).rejects.toThrow(/stopp|disposed|closed|worker/i);
    await expect(retired.getPlanExternalEditorAvailable()).rejects.toThrow(/stopp|disposed|closed|worker/i);
    expect(performance.now() - retiredAt).toBeLessThan(500);
    session = await runtime.create({ cwd, model: { provider: "plan-editor-runtime", id: "controlled" } });
    expect(session.id).not.toBe(retiredId);
    await expect(session.preparePlanExternalEditor(input)).rejects.toThrow(/target changed|owner|session/i);
  } finally {
    await session?.dispose().catch(() => {}); await runtime.dispose(); await rm(root, { recursive: true, force: true });
  }
}, 90_000);

test.each([
  ["wrong-cwd", /worker changed during preparation/i],
  ["oversized-environment", /environment exceeds its bound/i],
  ["invalid-availability", /capability could not be confirmed/i],
] as const)("actual worker rejects %s external-editor replies", async (scenario, expected) => {
  const { root, cwd, runtime } = await fixture(scenario);
  let session: WorkerSession | undefined;
  try {
    session = await runtime.create({ cwd, model: { provider: "plan-editor-runtime", id: "controlled" } });
    if (scenario === "invalid-availability") {
      await expect(session.getPlanExternalEditorAvailable()).rejects.toThrow(expected);
      return;
    }
    const state = await enterAndReview(session);
    await expect(session.preparePlanExternalEditor(request(session, state))).rejects.toThrow(expected);
  } finally {
    await session?.dispose().catch(() => {}); await runtime.dispose(); await rm(root, { recursive: true, force: true });
  }
}, 90_000);
