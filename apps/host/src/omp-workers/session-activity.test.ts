import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { WorkerRuntime } from "./runtime";

test("native activity preserves supported-empty and unsupported capabilities across reopen", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-session-activity-")));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), sessions = path.join(root, "sessions");
  await Promise.all([agentDir, cwd, sessions].map(directory => mkdir(directory)));
  const goal = { id: "goal-native-contract", objective: "Preserve exact native goal state", status: "paused" as const, tokenBudget: 1200,
    tokensUsed: 345, timeUsedSeconds: 67, createdAt: 1_788_000_000_000, updatedAt: 1_788_000_067_000 };
  const manager = SessionManager.create(cwd, sessions);
  manager.appendModeChange("goal_paused", { goal }); await manager.ensureOnDisk();
  const sessionFile = manager.getSessionFile()!; await manager.close();
  const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL("./fixtures/no-provider-worker.ts", import.meta.url)),
    environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: "dumb" } });
  try {
    const opened = await runtime.open({ sessionFile }), activity = await opened.getSessionActivity();
    expect(activity.goal).toEqual({ availability: "available", value: { ...goal, enabled: false, mode: "active" } });
    expect(opened.activity).toEqual(activity);
    expect(activity.jobs.availability).toBe("available");
    if (activity.jobs.availability === "available") expect(activity.jobs.value).toMatchObject({ running: [], recent: [], delivery: { queued: 0, delivering: false, pendingJobIds: [] } });
    expect(activity.agents).toEqual({ availability: "available", value: [] });
    expect(activity.sources).toMatchObject({ availability: "unsupported" });
    await opened.dispose();
    const reopened = await runtime.open({ sessionFile });
    expect(await reopened.getSessionActivity()).toEqual(activity);
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("cold reopen uses native lifecycle to pause an active goal once", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-active-goal-")));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), sessions = path.join(root, "sessions");
  await Promise.all([agentDir, cwd, sessions].map(directory => mkdir(directory)));
  const goal = { id: "goal-active-contract", objective: "Resume through native goal lifecycle", status: "active" as const, tokenBudget: 2400,
    tokensUsed: 789, timeUsedSeconds: 123, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_123_000 };
  const manager = SessionManager.create(cwd, sessions);
  manager.appendModeChange("goal", { goal }); await manager.ensureOnDisk();
  const sessionFile = manager.getSessionFile()!; await manager.close();
  const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL("./fixtures/no-provider-worker.ts", import.meta.url)),
    environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: "dumb" } });
  try {
    const opened = await runtime.open({ sessionFile }), activity = await opened.getSessionActivity();
    expect(activity.goal.availability).toBe("available");
    if (activity.goal.availability !== "available") throw new Error("Native goal activity unavailable");
    const { updatedAt: _previousUpdatedAt, ...preserved } = goal;
    expect(activity.goal.value).toMatchObject({ ...preserved, status: "paused", enabled: false, mode: "active" });
    expect(activity.goal.value?.updatedAt).toBeGreaterThan(goal.updatedAt);
    const pausedUpdatedAt = activity.goal.value!.updatedAt;
    await opened.dispose();
    const afterFirst = (await readFile(sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(afterFirst.filter(entry => entry.type === "mode_change" && entry.mode === "goal_paused")).toHaveLength(1);
    const reopened = await runtime.open({ sessionFile }), restored = await reopened.getSessionActivity();
    expect(restored.goal).toEqual({ availability: "available", value: { ...goal, status: "paused", updatedAt: pausedUpdatedAt, enabled: false, mode: "active" } });
    await reopened.dispose();
    const afterSecond = (await readFile(sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(afterSecond.filter(entry => entry.type === "mode_change" && entry.mode === "goal_paused")).toHaveLength(1);
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("malformed native goal mode is cleared instead of reconstructed", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-invalid-goal-")));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), sessions = path.join(root, "sessions");
  await Promise.all([agentDir, cwd, sessions].map(directory => mkdir(directory)));
  const manager = SessionManager.create(cwd, sessions);
  manager.appendModeChange("goal_paused", { goal: { id: "incomplete", objective: "Missing native accounting fields" } }); await manager.ensureOnDisk();
  const sessionFile = manager.getSessionFile()!; await manager.close();
  const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL("./fixtures/no-provider-worker.ts", import.meta.url)),
    environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: "dumb" } });
  try {
    const opened = await runtime.open({ sessionFile });
    expect((await opened.getSessionActivity()).goal).toEqual({ availability: "available", value: null });
    await opened.dispose();
    const entries = (await readFile(sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(entries.filter(entry => entry.type === "mode_change").at(-1)?.mode).toBe("none");
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
