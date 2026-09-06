import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { goalControlState, type GoalMutationRequest, type NativeGoalActivity } from "@agent-desktop/shared";
import { WorkerRuntime, type WorkerSession } from "./runtime";

const model = { provider: "steer-contract", id: "controlled" };
function mutation(goal: NativeGoalActivity | null, type: "create" | "pause" | "drop", suffix: string): GoalMutationRequest {
  return { requestId: `goal-controller-${suffix}`, controlEpoch: "goal-controller-native", observedAt: Date.now(),
    goalFingerprint: createHash("sha256").update(goalControlState(goal)).digest("hex"),
    expectedGoal: goal ? { id: goal.id, updatedAt: goal.updatedAt } : null,
    mutation: type === "create" ? { type, objective: "Continue until native completion", tokenBudget: 100 } : { type } };
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-goal-controller-")));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), gates = path.join(root, "gates");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("./fixtures/steer-provider.ts", import.meta.url)))}\n  - ${JSON.stringify(fileURLToPath(new URL("./fixtures/interaction-extension.ts", import.meta.url)))}\nretry:\n  enabled: false\n`);
  const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL("./fixtures/goal-auth-worker.ts", import.meta.url)),
    environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir,
      STEER_CONTRACT_GATES: gates, GOAL_AUTH_GATES: gates, TERM: "dumb" } });
  const session = await runtime.create({ cwd, interactions: true });
  await session.setModel(model);
  const started = async (call: number) => {
    const file = Bun.file(path.join(gates, `${call}.started`)), deadline = Date.now() + 7000;
    while (!await file.exists() && Date.now() < deadline) await Bun.sleep(5);
    expect(await file.exists()).toBe(true);
  };
  return { root, gates, runtime, session, started, close: async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); } };
}

async function currentGoal(session: WorkerSession): Promise<NativeGoalActivity | null> {
  const activity = await session.getSessionActivity();
  if (activity.goal.availability !== "available") throw new Error("Native goal unavailable");
  return activity.goal.value;
}

test("native continuation admits an internal hidden turn and suppresses the next no-tool continuation", async () => {
  const f = await fixture();
  try {
    const goal = await f.session.mutateGoal(mutation(null, "create", "create"));
    await Bun.sleep(1050);
    expect((await currentGoal(f.session))!.timeUsedSeconds).toBeGreaterThanOrEqual(1);
    expect((await f.session.getGoalContinuationEligibility()).eligible).toBe(true);
    const run = f.session.startGoalContinuation(goal!.id);
    const accepted = await run.accepted; await f.started(1);
    expect(accepted.goalId).toBe(goal!.id);
    await writeFile(path.join(f.gates, "1.release"), "");
    expect(await run.completion).toEqual({ goalId: goal!.id, hadToolCalls: false, suppressedNext: true });
    expect(await f.session.getGoalContinuationEligibility()).toEqual({ eligible: false, reason: "suppressed-no-tools" });
    const entries = (await readFile(f.session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(entries.some(entry => entry.id === accepted.entryId && entry.type === "custom_message" && entry.customType === "goal-continuation" && entry.display === false)).toBe(true);
  } finally { await f.close(); }
}, 30_000);

for (const stop of ["abort", "dispose"] as const) test(`${stop} during continuation auth admission cannot append or dispatch the hidden native prompt`, async () => {
  const f = await fixture();
  try {
    const goal = await f.session.mutateGoal(mutation(null, "create", `${stop}-auth-create`));
    expect(await f.session.getGoalContinuationEligibility()).toMatchObject({ eligible: true });
    await writeFile(path.join(f.gates, "hold-auth"), "");
    const run = f.session.startGoalContinuation(goal!.id);
    const authStarted = path.join(f.gates, "auth.started");
    for (let index = 0; index < 1000 && !await Bun.file(authStarted).exists(); index++) await Bun.sleep(5);
    expect(await Bun.file(authStarted).exists()).toBe(true);
    const stopping = stop === "abort" ? f.session.abort() : f.session.dispose();
    await writeFile(path.join(f.gates, "auth.release"), ""); await stopping;
    await expect(run.accepted).rejects.toThrow(); await expect(run.completion).rejects.toThrow();
    await Bun.sleep(50);
    const entries = (await readFile(f.session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(entries.some(entry => entry.type === "custom_message" && entry.customType === "goal-continuation")).toBe(false);
    expect(await Bun.file(path.join(f.gates, "1.started")).exists()).toBe(false);
  } finally { await f.close(); }
}, 30_000);

test("native goal tool completion keeps exiting state through its report then finalizes once", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-goal-complete-turn-")));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("./fixtures/goal-provider.ts", import.meta.url)))}\nretry:\n  enabled: false\n`);
  const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL("./fixtures/no-provider-worker.ts", import.meta.url)),
    environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: "dumb" } });
  try {
    const session = await runtime.create({ cwd, interactions: true });
    await session.setModel({ provider: "goal-contract", id: "controlled" });
    const goal = await session.mutateGoal(mutation(null, "create", "complete-create"));
    const run = session.startPrompt("Complete through the actual native goal tool"); await run.accepted;
    expect(await run.completion).toBe(true);
    expect(await currentGoal(session)).toBeNull();
    const entries = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(entries.filter(entry => entry.type === "custom" && entry.customType === "goal-completed")).toHaveLength(1);
    expect(entries.find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "goal")
      ?.message.content?.[0]?.text).toContain("Goal achieved. Report final budget usage");
    expect(entries.slice(-2).map(entry => [entry.type, entry.mode ?? entry.customType])).toEqual([["mode_change", "none"], ["custom", "goal-completed"]]);
    expect(goal?.status).toBe("active");
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("native pause and drop settle between tool executions without interrupting a running turn", async () => {
  const f = await fixture();
  try {
    let goal = await f.session.mutateGoal(mutation(null, "create", "create-running"));
    const asking = f.session.startPrompt("/bridge-contract");
    for (let index = 0; index < 100 && !(await f.session.listInteractions()).length; index++) await Bun.sleep(5);
    await expect(f.session.mutateGoal(mutation(goal, "pause", "pause-ask"))).rejects.toThrow("active tool, approval, ask, or admission");
    for (const value of ["First", true, "input", "edited"] as const) {
      for (let index = 0; index < 100 && !(await f.session.listInteractions()).length; index++) await Bun.sleep(5);
      const interaction = (await f.session.listInteractions())[0]!;
      await f.session.respondInteraction(interaction.id, { value } as never);
    }
    expect((await asking.accepted)?.kind).toBe("native-command"); await asking.completion;
    const run = f.session.startPrompt("Keep the controlled native turn running"); await run.accepted; await f.started(1);
    goal = await f.session.mutateGoal(mutation(goal, "pause", "pause-running"));
    expect(goal).toMatchObject({ status: "paused", enabled: false });
    await writeFile(path.join(f.gates, "1.release"), ""); await run.completion;
    const blocked = f.session.startGoalContinuation(goal!.id);
    await expect(blocked.accepted).rejects.toThrow("not eligible: inactive");
    await expect(blocked.completion).rejects.toThrow("not eligible: inactive");
    expect(await f.session.mutateGoal(mutation(goal, "drop", "drop-idle"))).toBeNull();
  } finally { await f.close(); }
}, 30_000);
