import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandResult, GoalMutation, GoalMutationReceipt, HostCommand, NativeGoalActivity, SessionSummary } from "@agent-desktop/shared";
import { SESSION_ACTIVITY_OWNER_HEADER } from "@agent-desktop/shared";
import { startHost } from "./server";

const model = { provider: "steer-contract", id: "controlled" };

async function fixture(options: { goalProvider?: boolean } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-goal-http-native-")));
  const dataDirectory = path.join(root, "data"), agentDirectory = path.join(root, "agent"), project = path.join(root, "project"), gates = path.join(root, "gates");
  await Promise.all([dataDirectory, agentDirectory, project, gates].map(directory => mkdir(directory, { recursive: true })));
  const extension = options.goalProvider
    ? `  - ${JSON.stringify(fileURLToPath(new URL("./omp-workers/fixtures/goal-provider.ts", import.meta.url)))}`
    : `  - ${JSON.stringify(fileURLToPath(new URL("./omp-workers/fixtures/steer-provider.ts", import.meta.url)))}\n  - ${JSON.stringify(fileURLToPath(new URL("./omp-workers/fixtures/interaction-extension.ts", import.meta.url)))}`;
  await writeFile(path.join(agentDirectory, "config.yml"), `extensions:\n${extension}\nretry:\n  enabled: false\n`);
  const workerPath = path.join(root, "goal-worker.ts");
  await writeFile(workerPath, `process.env.STEER_CONTRACT_GATES = ${JSON.stringify(gates)};\nawait import(${JSON.stringify(fileURLToPath(new URL("./omp-workers/fixtures/no-provider-worker.ts", import.meta.url))) });\n`);
  const hostOptions = { dataDirectory, agentDirectory, discoveryDirectory: project, workerPath, tailscale: false };
  let host = await startHost(hostOptions);
  const request = (route: string, init: RequestInit = {}) => fetch(`${host.connection.origin}${route}`, { ...init,
    headers: { Authorization: `Bearer ${host.connection.token}`, [SESSION_ACTIVITY_OWNER_HEADER]: host.connection.hostId, ...init.headers } });
  const command = async (command: HostCommand): Promise<CommandResult> => {
    const response = await request("/v3/commands", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: crypto.randomUUID(), command }) });
    expect(response.status).toBe(200); return response.json() as Promise<CommandResult>;
  };
  const wait = async (check: () => boolean | Promise<boolean>, message: string, timeout = 8_000) => {
    const deadline = Date.now() + timeout;
    while (!await check() && Date.now() < deadline) await Bun.sleep(10);
    if (!await check()) throw new Error(`Timed out waiting for ${message}`);
  };
  const started = (call: number) => Bun.file(path.join(gates, `${call}.started`)).exists();
  const release = (call: number) => writeFile(path.join(gates, `${call}.release`), "");
  const mutateGoal = async (sessionId: string, mutation: GoalMutation): Promise<GoalMutationReceipt> => {
    const activityResponse = await request(`/v1/sessions/${sessionId}/activity`); expect(activityResponse.status).toBe(200);
    const activity = await activityResponse.json() as { goal: { availability: string; value: NativeGoalActivity | null }; goalControlTicket: object };
    const response = await request(`/v1/sessions/${sessionId}/goal-control`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), ...activity.goalControlTicket,
        expectedGoal: activity.goal.value ? { id: activity.goal.value.id, updatedAt: activity.goal.value.updatedAt } : null, mutation }) });
    expect(response.status).toBe(200); return response.json() as Promise<GoalMutationReceipt>;
  };
  const setModel = async (sessionId: string) => {
    const controls = await (await request(`/v2/sessions/${sessionId}/controls`)).json() as { revision: string };
    const response = await request(`/v2/sessions/${sessionId}/controls`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: controls.revision, operation: "model",
        model: options.goalProvider ? { provider: "goal-contract", id: "controlled" } : model }) });
    expect(response.status).toBe(200);
  };
  return { root, gates, options: hostOptions, request, command, mutateGoal, setModel, wait, started, release,
    get host() { return host; }, restart: async () => { await host.stop(); host = await startHost(hostOptions); },
    close: async () => { await host.stop(); await rm(root, { recursive: true, force: true }); } };
}

async function createSession(f: Awaited<ReturnType<typeof fixture>>): Promise<SessionSummary> {
  const result = await f.command({ type: "session.create", projectId: null, cwd: f.options.discoveryDirectory });
  if (!result.ok || !result.value || !("sessionFile" in result.value)) throw new Error("Expected native session creation");
  return result.value as SessionSummary;
}

test("authenticated host goal control drives zero-client native continuation, drafts, suppression and running mutations", async () => {
  const f = await fixture();
  try {
    const session = await createSession(f);
    await f.setModel(session.id);
    const setup = await f.command({ type: "session.prompt", sessionId: session.id, text: "Select controlled native model" });
    if (!setup.ok) throw new Error(`Initial native prompt failed: ${setup.error.code}: ${setup.error.message}`);
    await f.wait(() => f.started(1), "initial controlled turn"); await f.release(1);
    await f.wait(() => f.host.store.getSession(session.id)?.status === "idle", "initial turn settlement");
    await f.wait(() => f.host.store.eventsAfter(0, 1000).some(event => event.type === "notification" && event.notification.id.startsWith(`completion:${session.id}:command:`)), "prompt completion notification");
    expect(f.host.snapshot().notifications).toEqual([]);

    const draftId = `session:${session.id}`;
    expect((await f.command({ type: "draft.put", draft: { id: draftId, text: "Unsent operator work", projectId: null, model }, expectedRevision: 0 })).ok).toBe(true);
    const created = await f.mutateGoal(session.id, { type: "create", objective: "Exercise real owning-host continuation", tokenBudget: 1000 });
    expect(created.outcome).toBe("completed");
    await Bun.sleep(1_050); expect(await f.started(2)).toBe(false);
    expect((await f.command({ type: "draft.put", draft: { id: draftId, text: "", projectId: null, model }, expectedRevision: 1 })).ok).toBe(true);
    await f.wait(() => f.started(2), "automatic continuation without websocket clients");
    expect(f.host.store.getSession(session.id)?.status).toBe("running");
    await f.release(2); await f.wait(() => f.host.store.getSession(session.id)?.status === "idle", "continuation settlement");
    await f.wait(() => f.host.store.eventsAfter(0, 1000).some(event => event.type === "notification" && event.notification.id.startsWith(`completion:${session.id}:goal:${created.goal!.id}:entry:`)), "goal continuation notification");
    await f.wait(() => f.host.store.getSession(session.id)?.goalContinuation?.blocked === "no-tools", "no-tool checkpoint");
    await Bun.sleep(1_050); expect(await f.started(3)).toBe(false);
    const entries = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(entries.some(entry => entry.type === "custom_message" && entry.customType === "goal-continuation" && entry.display === false)).toBe(true);
    const transcript = await (await f.request(`/v1/sessions/${session.id}/messages`)).json() as Array<{ text?: string }>;
    expect(JSON.stringify(transcript)).not.toContain("goal-continuation");
    expect(transcript.some(message => message.text?.includes("Goal mode active. Objective below"))).toBe(false);

    const askingResponse = f.request("/v3/commands", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: crypto.randomUUID(), command: { type: "session.prompt", sessionId: session.id, text: "/bridge-contract" } }) });
    const interactions = async () => (await (await f.request(`/v1/sessions/${session.id}/interactions`)).json()) as Array<{ id: string }>;
    await f.wait(async () => (await interactions()).length === 1, "native pending ask");
    await f.wait(() => f.host.snapshot().notifications?.some(notification => notification.kind === "question") === true, "generic native question notification");
    expect(f.host.snapshot().notifications?.some(notification => notification.kind === "permission")).toBe(false);
    await Bun.sleep(1_050);
    expect(await interactions()).toHaveLength(1);
    expect(await f.started(3)).toBe(false);
    for (const value of ["First", true, "input", "edited"] as const) {
      await f.wait(async () => (await interactions()).length === 1, "next native interaction");
      const current = (await interactions())[0]!;
      expect((await f.request(`/v1/sessions/${session.id}/interactions`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interactionId: current.id, response: { value } }) })).status).toBe(200);
    }
    expect((await (await askingResponse).json() as CommandResult).ok).toBe(true);
    await f.wait(() => f.host.snapshot().notifications?.length === 0, "resolved native question notifications");

    const running = await f.command({ type: "session.prompt", sessionId: session.id, text: "Pause without aborting this native turn" });
    expect(running.ok).toBe(true); await f.wait(() => f.started(3), "running turn for pause");
    const paused = await f.mutateGoal(session.id, { type: "pause" }); expect(paused).toMatchObject({ outcome: "completed", goal: { status: "paused" } });
    expect(f.host.store.getSession(session.id)?.status).toBe("running"); await f.release(3);
    await f.wait(() => f.host.store.getSession(session.id)?.status === "idle", "uninterrupted paused turn settlement");
    const resumed = await f.mutateGoal(session.id, { type: "resume" }); expect(resumed.outcome).toBe("completed");
    const dropping = await f.command({ type: "session.prompt", sessionId: session.id, text: "Drop without aborting this native turn" });
    expect(dropping.ok).toBe(true); await f.wait(() => f.started(4), "running turn for drop");
    expect(await f.mutateGoal(session.id, { type: "drop" })).toMatchObject({ outcome: "completed", goal: null });
    expect(f.host.store.getSession(session.id)?.status).toBe("running"); await f.release(4);
    await f.wait(() => f.host.store.getSession(session.id)?.status === "idle", "uninterrupted dropped turn settlement");
  } finally { await f.close(); }
}, 60_000);

test("an in-flight native continuation remains blocked across owning-host restart", async () => {
  const f = await fixture();
  try {
    const session = await createSession(f);
    await f.setModel(session.id);
    const setup = await f.command({ type: "session.prompt", sessionId: session.id, text: "Select controlled native model" });
    if (!setup.ok) throw new Error(`Initial native prompt failed: ${setup.error.code}: ${setup.error.message}`);
    await f.wait(() => f.started(1), "initial controlled turn"); await f.release(1);
    await f.wait(() => f.host.store.getSession(session.id)?.status === "idle", "initial settlement");
    expect((await f.mutateGoal(session.id, { type: "create", objective: "Do not replay uncertain continuation" })).outcome).toBe("completed");
    await f.wait(() => f.started(2), "in-flight continuation");
    expect(f.host.store.getSession(session.id)?.goalContinuation?.blocked).toBe("in-flight");
    await f.restart();
    expect(f.host.store.getSession(session.id)?.goalContinuation?.blocked).toBe("in-flight");
    await rm(path.join(f.gates, "1.started"), { force: true }); await Bun.sleep(1_050);
    expect(await f.started(1)).toBe(false);
  } finally { await f.close(); }
}, 60_000);

test("HTTP transcript hides continuation prompts and exposes persisted native goal completion", async () => {
  const f = await fixture({ goalProvider: true });
  try {
    const session = await createSession(f); await f.setModel(session.id);
    const draftId = `session:${session.id}`;
    expect((await f.command({ type: "draft.put", draft: { id: draftId, text: "Hold automatic continuation", projectId: null,
      model: { provider: "goal-contract", id: "controlled" } }, expectedRevision: 0 })).ok).toBe(true);
    const objective = "Complete through persisted native goal evidence";
    expect(await f.mutateGoal(session.id, { type: "create", objective, tokenBudget: 100 })).toMatchObject({ outcome: "completed" });
    expect((await f.command({ type: "session.prompt", sessionId: session.id, text: "Complete through the actual native goal tool" })).ok).toBe(true);
    await f.wait(() => f.host.store.getSession(session.id)?.status === "idle", "native goal completion settlement");
    const response = await f.request(`/v1/sessions/${session.id}/messages`); expect(response.status).toBe(200);
    const transcript = await response.json() as Array<{ role: string; goalCompletion?: { entryId: string; objective: string; tokensUsed: number; tokenBudget?: number; timeUsedSeconds: number } }>;
    const completion = transcript.find(message => message.goalCompletion)?.goalCompletion;
    expect(completion).toMatchObject({ objective, tokenBudget: 100 });
    expect(completion?.entryId.length).toBeGreaterThan(0);
    expect(Number.isSafeInteger(completion?.tokensUsed)).toBe(true);
    expect(Number.isSafeInteger(completion?.timeUsedSeconds)).toBe(true);
    expect(JSON.stringify(transcript)).not.toContain("goal-continuation");
    const entries = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(entries.filter(entry => entry.type === "custom" && entry.customType === "goal-completed")).toHaveLength(1);
    expect(entries.some(entry => entry.id === completion?.entryId)).toBe(true);
  } finally { await f.close(); }
}, 60_000);
