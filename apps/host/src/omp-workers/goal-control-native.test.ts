import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { SESSION_ACTIVITY_OWNER_HEADER, goalControlState, parseGoalMutationReceipt, type GoalMutation, type GoalMutationRequest, type NativeGoalActivity } from "@agent-desktop/shared";
import { WorkerRuntime } from "./runtime";
import { GoalControlHttp } from "../goal-control-http";

const epoch = "native-goal-test";
function request(mutation: GoalMutation, goal: NativeGoalActivity | null, suffix: string): GoalMutationRequest {
  return { requestId: `request-${suffix}`, controlEpoch: epoch, observedAt: Date.now(),
    goalFingerprint: createHash("sha256").update(goalControlState(goal)).digest("hex"),
    expectedGoal: goal ? { id: goal.id, updatedAt: goal.updatedAt } : null, mutation };
}

test("actual native worker mutates, flushes, and reopens goal state without a provider", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-goal-control-")));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), sessions = path.join(root, "sessions");
  await Promise.all([agentDir, cwd, sessions].map(directory => mkdir(directory)));
  const manager = SessionManager.create(cwd, sessions); await manager.ensureOnDisk();
  const sessionFile = manager.getSessionFile()!; await manager.close();
  const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL("./fixtures/no-provider-worker.ts", import.meta.url)),
    environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: "dumb" } });
  try {
    const opened = await runtime.open({ sessionFile });
    const changed: string[] = [];
    const unsubscribe = opened.subscribe(event => { if ("activityChanged" in event && event.activityChanged) changed.push(event.type); });
    const http = new GoalControlHttp({ hostId: "owner", sessionExists: id => id === opened.id, getHandle: async () => opened,
      getExistingHandle: async () => opened, ordered: async (_id, operation) => operation() });
    const createRequest: GoalMutationRequest = { requestId: "request-create", ...http.ticket(await opened.getSessionActivity())!, expectedGoal: null,
      mutation: { type: "create", objective: "Ship native goal controls", tokenBudget: 1200 } };
    const createResponse = await http.route(new Request(`http://host/v1/sessions/${encodeURIComponent(opened.id)}/goal-control`, { method: "POST",
      headers: { [SESSION_ACTIVITY_OWNER_HEADER]: "owner" }, body: JSON.stringify(createRequest) }));
    expect(createResponse?.status).toBe(200);
    const createReceipt = parseGoalMutationReceipt(await createResponse!.json(), { hostId: "owner", sessionId: opened.id, requestId: createRequest.requestId });
    expect(createReceipt.outcome).toBe("completed");
    const retryResponse = await http.route(new Request(`http://host/v1/sessions/${encodeURIComponent(opened.id)}/goal-control`, { method: "POST",
      headers: { [SESSION_ACTIVITY_OWNER_HEADER]: "owner" }, body: JSON.stringify(createRequest) }));
    expect(await retryResponse!.json()).toEqual(createReceipt);
    const created = createReceipt.goal;
    if (createReceipt.outcome !== "completed" || !created) throw new Error("Native goal creation was not completed");
    expect(created).toMatchObject({ objective: "Ship native goal controls", status: "active", enabled: true, mode: "active", tokenBudget: 1200, tokensUsed: 0 });
    const afterCreate = (await readFile(sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(afterCreate.at(-1)).toMatchObject({ type: "mode_change", mode: "goal", data: { goal: { id: created!.id, tokenBudget: 1200 } } });
    expect(afterCreate.filter(entry => entry.type === "mode_change" && entry.mode === "goal")).toHaveLength(1);

    const budgeted = await opened.mutateGoal(request({ type: "setBudget", tokenBudget: 2400 }, created, "budget"));
    expect(budgeted).toMatchObject({ id: created!.id, tokenBudget: 2400, tokensUsed: 0, status: "active" });
    const paused = await opened.mutateGoal(request({ type: "pause" }, budgeted, "pause"));
    expect(paused).toMatchObject({ id: created!.id, enabled: false, status: "paused", tokenBudget: 2400 });
    const resumed = await opened.mutateGoal(request({ type: "resume" }, paused, "resume"));
    expect(resumed).toMatchObject({ id: created!.id, enabled: true, status: "active", tokenBudget: 2400 });
    const replacement = await opened.mutateGoal(request({ type: "replace", objective: "Replacement objective" }, resumed, "replace"));
    expect(replacement).toMatchObject({ objective: "Replacement objective", enabled: true, status: "active", tokensUsed: 0 });
    expect(replacement!.id).not.toBe(created!.id);
    expect(await opened.mutateGoal(request({ type: "drop" }, replacement, "drop"))).toBeNull();
    const afterDrop = (await readFile(sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(afterDrop.at(-1)).toMatchObject({ type: "mode_change", mode: "none" });
    expect(changed.filter(type => type === "goal_updated").length).toBeGreaterThanOrEqual(6);

    const durable = await opened.mutateGoal(request({ type: "create", objective: "Persist paused goal" }, null, "durable"));
    const durablePaused = await opened.mutateGoal(request({ type: "pause" }, durable, "durable-pause"));
    unsubscribe(); await opened.dispose();
    const reopened = await runtime.open({ sessionFile });
    expect((await reopened.getSessionActivity()).goal).toEqual({ availability: "available", value: durablePaused });
    await expect(reopened.mutateGoal(request({ type: "setBudget", tokenBudget: 2 }, created, "stale"))).rejects.toMatchObject({ name: "GoalMutationRejected" });
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
