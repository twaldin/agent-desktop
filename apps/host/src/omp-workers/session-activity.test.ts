import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
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
    // The session file contains a native goal entry, but the headless adapter does not
    // restore goal mode state yet. The read-only activity bridge must not invent it.
    expect(activity.goal).toEqual({ availability: "available", value: null });
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
