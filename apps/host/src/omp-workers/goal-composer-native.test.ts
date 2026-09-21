import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRegistry, createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { goalControlState, type GoalMutationRequest, type GoalPromptIntent, type NativeGoalActivity } from "@agent-desktop/shared";
import type { OmpPromptOptions, OmpPromptRun, PreparedPromptImage } from "../omp";
import { NativeGoalPromptAdmission, NativeGoalPromptAdmissionError, type NativeGoalPromptPorts } from "../omp/goal-prompt";
import { ImageAttachmentStore } from "../attachments";
import { WorkerRuntime, type WorkerSession } from "./runtime";
import type { GoalComposerProviderCall } from "./fixtures/goal-composer-provider";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/hZkAAAAASUVORK5CYII=", "base64");
const vision = { provider: "goal-composer-contract", id: "vision" }, textModel = { provider: "goal-composer-contract", id: "text" };
const objective = "Ship the native Goal composer end to end";
let commands = 0;
/** Every Goal send is an original durable admission: command protocol 24 with its own identity. */
function goalSend(goal: GoalPromptIntent, extra: Omit<OmpPromptOptions, "goal" | "commandId" | "commandVersion"> = {}): OmpPromptOptions {
  return { goal, commandVersion: 24, commandId: `goal-composer-${++commands}`, ...extra };
}

type Entry = { type: string; id?: string; mode?: string; customType?: string; data?: { goal?: { id: string; objective: string; tokenBudget?: number } }; message?: { role: string; content: unknown } };

async function entries(file: string): Promise<Entry[]> {
  return (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
}
async function currentGoal(session: WorkerSession): Promise<NativeGoalActivity | null> {
  const activity = await session.getSessionActivity();
  if (activity.goal.availability !== "available") throw new Error("Native goal unavailable");
  return activity.goal.value;
}
/** Owner integration may refuse synchronously or through the accepted promise. */
async function refusal(start: () => OmpPromptRun): Promise<unknown> {
  let run: OmpPromptRun;
  try { run = start(); } catch (error) { return error; }
  const error = await run.accepted.then(() => undefined, (cause: unknown) => cause);
  await run.completion.catch(() => {});
  if (error === undefined) throw new Error("Expected the native goal submission to be refused");
  return error;
}
/** Cross-process file gate written by the worker fixture; no in-process signal exists to await. */
async function untilExists(file: string): Promise<boolean> {
  const deadline = Date.now() + 7_000;
  while (!await Bun.file(file).exists() && Date.now() < deadline) await Bun.sleep(5);
  return Bun.file(file).exists();
}

async function fixture(worker = "no-provider-worker.ts", config = "") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-goal-composer-")));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), gates = path.join(root, "gates");
  await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(gates), mkdir(path.join(root, "attachment-store"))]);
  await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("./fixtures/goal-composer-provider.ts", import.meta.url)))}\ndefaultThinkingLevel: off\nretry:\n  enabled: false\n${config}`);
  const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL(`./fixtures/${worker}`, import.meta.url)),
    environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: "dumb",
      GOAL_COMPOSER_GATES: gates, IMAGE_CONTRACT_GATES: gates, GOAL_AUTH_GATES: gates } });
  const store = new ImageAttachmentStore(path.join(root, "attachment-store"));
  const image = async (data: Uint8Array): Promise<PreparedPromptImage> => {
    const metadata = await store.putImage(createHash("sha256").update(data).digest("hex"), data);
    const verified = await store.readValidatedImage(metadata.sha256);
    return { attachment: { id: "image-1", hostId: "isolated-owner", kind: "image", name: "image-1", sha256: metadata.sha256, bytes: metadata.bytes, mimeType: metadata.mimeType }, data: verified.bytes };
  };
  const providerCall = async (call: number): Promise<GoalComposerProviderCall | undefined> => {
    const file = Bun.file(path.join(gates, `call-${call}.json`));
    return await file.exists() ? JSON.parse(await file.text()) : undefined;
  };
  return { root, cwd, gates, runtime, image, providerCall, close: async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); } };
}

test("goal-bearing plain prompt creates the durable native goal before the first provider call and keeps images and model", async () => {
  const f = await fixture();
  try {
    const session = await f.runtime.create({ cwd: f.cwd, interactions: true });
    const goal: GoalPromptIntent = { objective, tokenBudget: 1200 };
    const run = session.startPrompt(objective, goalSend(goal, { model: vision, images: [await f.image(png)] }));
    const accepted = await run.accepted;
    expect(accepted?.kind).toBe("user-message");
    expect(await run.completion).toBe(true);
    const active = await currentGoal(session);
    expect(active).toMatchObject({ objective, tokenBudget: 1200, status: "active", enabled: true, mode: "active" });
    const call = await f.providerCall(1);
    expect(call).toBeDefined();
    expect(call!.model).toBe("vision");
    expect(call!.tools).toContain("goal");
    expect(call!.sessionFile).toBe(session.sessionFile);
    expect(call!.durableGoals).toEqual([expect.objectContaining({ id: active!.id, objective, tokenBudget: 1200 })]);
    const goalContext = call!.messages.findIndex(message => message.role === "developer" && message.content.some(block => block.type === "text" && block.text.includes("<goal_context>")));
    const user = call!.messages.findIndex(message => message.role === "user");
    expect(goalContext).toBeGreaterThanOrEqual(0);
    expect(user).toBeGreaterThan(goalContext);
    const contextText = call!.messages[goalContext]!.content.map(block => block.type === "text" ? block.text : "").join("\n");
    expect(contextText).toContain(`<objective>\n${objective}\n</objective>`);
    expect(contextText).toContain("Token budget: 1200");
    if (accepted?.kind !== "user-message" || !accepted.images?.[0]) throw new Error("Missing native image admission");
    expect(accepted.images[0].sourceSha256).toBe(createHash("sha256").update(png).digest("hex"));
    expect(call!.messages[user]!.content).toEqual(expect.arrayContaining([
      { type: "text", text: objective }, { type: "image", mimeType: accepted.images[0].mimeType, sha256: accepted.images[0].nativeSha256 }]));
    expect(await f.providerCall(2)).toBeUndefined();
    const history = await entries(session.sessionFile);
    const goalEntries = history.filter(entry => entry.type === "mode_change" && entry.mode === "goal");
    const userEntries = history.filter(entry => entry.type === "message" && entry.message?.role === "user");
    expect([...new Set(goalEntries.map(entry => entry.data?.goal?.id))]).toEqual([active!.id]);
    expect(userEntries).toHaveLength(1);
    expect(goalEntries[0]!.data?.goal).toMatchObject({ id: active!.id, objective, tokenBudget: 1200 });
    expect(history.indexOf(goalEntries[0]!)).toBeLessThan(history.indexOf(userEntries[0]!));
    expect(history.filter(entry => entry.type === "custom_message" && entry.customType === "goal-mode-context")).toHaveLength(1);
  } finally { await f.close(); }
}, 30_000);

test("ordinary ownerless prompt and unbudgeted goal keep their existing shapes", async () => {
  const f = await fixture();
  try {
    const session = await f.runtime.create({ cwd: f.cwd, interactions: true });
    const plain = session.startPrompt("Plain native prompt without a goal", { model: textModel });
    expect((await plain.accepted)?.kind).toBe("user-message");
    expect(await plain.completion).toBe(true);
    expect(await currentGoal(session)).toBeNull();
    const first = await f.providerCall(1);
    expect(first!.model).toBe("text");
    expect(first!.tools).not.toContain("goal");
    expect(first!.messages.some(message => message.content.some(block => block.type === "text" && block.text.includes("<goal_context>")))).toBe(false);
    expect((await entries(session.sessionFile)).some(entry => entry.type === "mode_change")).toBe(false);
    const run = session.startPrompt(`  ${objective}\n`, goalSend({ objective }, { model: textModel }));
    expect((await run.accepted)?.kind).toBe("user-message");
    expect(await run.completion).toBe(true);
    expect(await currentGoal(session)).toMatchObject({ objective, status: "active" });
    expect((await currentGoal(session))!.tokenBudget).toBeUndefined();
    const second = await f.providerCall(2);
    expect(second!.tools).toContain("goal");
    const context = second!.messages.find(message => message.role === "developer" && message.content.some(block => block.type === "text" && block.text.includes("<goal_context>")));
    expect(context!.content.map(block => block.type === "text" ? block.text : "").join("\n")).toContain("Token budget: none");
  } finally { await f.close(); }
}, 30_000);

test("preflight refusal, slash text and an existing goal create no goal and dispatch nothing", async () => {
  const f = await fixture();
  try {
    const session = await f.runtime.create({ cwd: f.cwd, interactions: true });
    await refusal(() => session.startPrompt(objective, goalSend({ objective }, { model: { provider: "goal-composer-contract", id: "missing" } })));
    expect(await currentGoal(session)).toBeNull();
    const slash = await refusal(() => session.startPrompt("/goal", goalSend({ objective: "/goal" })));
    expect(slash).toBeInstanceOf(Error);
    const mismatch = await refusal(() => session.startPrompt("Different text", goalSend({ objective })));
    expect(mismatch).toBeInstanceOf(Error);
    const budget = await refusal(() => session.startPrompt(objective, goalSend({ objective, tokenBudget: 0 })));
    expect(budget).toBeInstanceOf(Error);
    expect(await currentGoal(session)).toBeNull();
    expect(await f.providerCall(1)).toBeUndefined();
    expect((await entries(session.sessionFile)).some(entry => entry.type === "mode_change" || entry.type === "message")).toBe(false);
    const created = await session.mutateGoal({ requestId: "existing", controlEpoch: "goal-composer", observedAt: Date.now(),
      goalFingerprint: createHash("sha256").update(goalControlState(null)).digest("hex"), expectedGoal: null,
      mutation: { type: "create", objective: "Existing panel goal", tokenBudget: 50 } } satisfies GoalMutationRequest);
    const existing = await refusal(() => session.startPrompt(objective, goalSend({ objective }, { model: textModel })));
    expect((existing as Error).name).toBe("GoalPromptRejected");
    // Main's shared boundary refuses stale protocol before the module is reached.
    await refusal(() => session.startPrompt(objective, { goal: { objective }, model: textModel, commandVersion: 23, commandId: "stale-protocol" }));
    expect(await currentGoal(session)).toMatchObject({ id: created!.id, objective: "Existing panel goal", tokenBudget: 50 });
    expect(await f.providerCall(1)).toBeUndefined();
    // Ordinary text still reaches the existing goal session unchanged.
    const plain = session.startPrompt("Continue the existing goal", { model: textModel });
    expect((await plain.accepted)?.kind).toBe("user-message");
    expect(await plain.completion).toBe(true);
    expect((await f.providerCall(1))!.messages.some(message => message.content.some(block => block.type === "text" && block.text.includes("Existing panel goal")))).toBe(true);
    expect([...new Set((await entries(session.sessionFile)).filter(entry => entry.type === "mode_change" && entry.mode === "goal").map(entry => entry.data?.goal?.id))]).toEqual([created!.id]);
  } finally { await f.close(); }
}, 30_000);

test("abort during credential preflight creates no goal and the same intent can be resent", async () => {
  const f = await fixture("goal-auth-worker.ts");
  try {
    const session = await f.runtime.create({ cwd: f.cwd, interactions: true });
    await writeFile(path.join(f.gates, "hold-auth"), "");
    const run = session.startPrompt(objective, goalSend({ objective, tokenBudget: 300 }, { model: textModel }));
    expect(await untilExists(path.join(f.gates, "auth.started"))).toBe(true);
    const stopping = session.abort();
    await writeFile(path.join(f.gates, "auth.release"), "");
    await stopping;
    await expect(run.accepted).rejects.toThrow();
    await expect(run.completion).rejects.toThrow();
    expect(await currentGoal(session)).toBeNull();
    expect(await f.providerCall(1)).toBeUndefined();
    expect((await entries(session.sessionFile)).some(entry => entry.type === "mode_change")).toBe(false);
    await rm(path.join(f.gates, "hold-auth"));
    const retry = session.startPrompt(objective, goalSend({ objective, tokenBudget: 300 }, { model: textModel }));
    expect((await retry.accepted)?.kind).toBe("user-message");
    expect(await retry.completion).toBe(true);
    expect(await currentGoal(session)).toMatchObject({ objective, tokenBudget: 300, status: "active" });
    expect((await f.providerCall(1))!.tools).toContain("goal");
  } finally { await f.close(); }
}, 30_000);

test("uncertifiable persistence after native goal creation is OUTCOME_UNKNOWN and a retry cannot recreate or dispatch", async () => {
  const f = await fixture("image-failure-worker.ts");
  try {
    const session = await f.runtime.create({ cwd: f.cwd, interactions: true });
    await writeFile(path.join(f.gates, "fail-flush"), "");
    const run = session.startPrompt(objective, goalSend({ objective, tokenBudget: 700 }, { model: textModel }));
    await expect(run.accepted).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", name: "NativeGoalPromptAdmissionError" });
    await expect(run.completion).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    const goal = await currentGoal(session);
    expect(goal).toMatchObject({ objective, tokenBudget: 700, status: "active" });
    expect(await f.providerCall(1)).toBeUndefined();
    await rm(path.join(f.gates, "fail-flush"));
    const retry = await refusal(() => session.startPrompt(objective, goalSend({ objective, tokenBudget: 700 }, { model: textModel })));
    expect((retry as Error).name).toBe("GoalPromptRejected");
    expect(await currentGoal(session)).toMatchObject({ id: goal!.id });
    expect(await f.providerCall(1)).toBeUndefined();
    expect((await entries(session.sessionFile)).filter(entry => entry.type === "mode_change" && entry.mode === "goal")).toHaveLength(1);
    expect((await entries(session.sessionFile)).some(entry => entry.type === "message")).toBe(false);
  } finally { await f.close(); }
}, 30_000);
test("abort after durable Goal creation retains the goal and refuses both admission and completion", async () => {
  const f = await fixture("goal-composer-worker.ts");
  try {
    const session = await f.runtime.create({ cwd: f.cwd, interactions: true });
    await writeFile(path.join(f.gates, "hold-goal"), "");
    const run = session.startPrompt(objective, goalSend({ objective }, { model: textModel }));
    expect(await untilExists(path.join(f.gates, "goal-durable"))).toBe(true);
    const stopping = session.abort();
    expect(await untilExists(path.join(f.gates, "abort-entered"))).toBe(true);
    await writeFile(path.join(f.gates, "goal-release"), "");
    await stopping;
    await expect(run.accepted).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await expect(run.completion).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(await currentGoal(session)).toMatchObject({ objective, status: "paused", enabled: false });
    expect(await f.providerCall(1)).toBeUndefined();
    expect((await entries(session.sessionFile)).some(entry => entry.type === "message")).toBe(false);
  } finally { await f.close(); }
}, 30_000);


// In-process module contract against the actual native session, manager and
// goal runtime; the owner ports are controlled here.
async function nativeFixture(config = "extensions: []\n") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-goal-prompt-")));
  const cwd = path.join(root, "project"), agentDir = path.join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  await writeFile(path.join(agentDir, "config.yml"), config);
  const manager = SessionManager.create(cwd, path.join(root, "sessions"));
  const settings = await Settings.loadReadOnly({ cwd, agentDir });
  const authStorage = await discoverAuthStorage(agentDir);
  const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
  const model = modelRegistry.getAll().find(candidate => candidate.api === "openai-completions");
  if (!model) throw new Error("Pinned native catalog must expose an openai-completions model");
  const { session } = await createAgentSession({ cwd, agentDir, sessionManager: manager, authStorage, modelRegistry, model,
    agentRegistry: new AgentRegistry(), settings, hasUI: false, interactivePrompts: false, extensions: [] });
  const activations: string[][] = [];
  let current = true, suppressionResets = 0, activationFailure: Error | undefined;
  const ports: NativeGoalPromptPorts = {
    assertCurrent: () => { if (!current) throw new Error("The original prompt admission retired."); },
    activateTools: async previousTools => {
      if (activationFailure) throw activationFailure;
      activations.push([...previousTools]);
      await session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
    },
    resetSuppression: () => { suppressionResets++; },
  };
  const admission = (intent: unknown) => new NativeGoalPromptAdmission(session, manager, intent, ports);
  return { session, manager, ports, admission, retire() { current = false; }, failActivation(error: Error) { activationFailure = error; },
    get activations() { return activations; }, get suppressionResets() { return suppressionResets; },
    async close() { try { await session.dispose(); } finally { authStorage.close(); await rm(root, { recursive: true, force: true }); } } };
}

test("module initializes the native goal in InteractiveMode order and refuses a second goal", async () => {
  const f = await nativeFixture();
  try {
    const before = f.session.getEnabledToolNames().filter(name => name !== "goal");
    const admission = f.admission({ objective, tokenBudget: 42 });
    admission.prepare(`${objective} `);
    expect(admission.intent).toEqual({ objective, tokenBudget: 42 });
    expect(f.session.getGoalModeState()).toBeUndefined();
    await admission.initialize();
    expect(admission.initialized).toBe(true);
    const state = f.session.getGoalModeState();
    expect(state).toMatchObject({ enabled: true, mode: "active", goal: { id: admission.goalId, objective, tokenBudget: 42, status: "active" } });
    expect(f.session.getEnabledToolNames()).toContain("goal");
    expect(f.activations).toEqual([before]);
    expect(admission.previousTools).toEqual(before);
    expect(f.suppressionResets).toBe(1);
    // Durable before any assistant message: the lazy file was forced onto disk.
    const durable = (await readFile(f.session.sessionFile!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(durable.filter(entry => entry.type === "mode_change" && entry.mode === "goal").map(entry => entry.data.goal.id)).toEqual([admission.goalId]);
    await expect(admission.initialize()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(f.session.getGoalModeState()?.goal.id).toBe(admission.goalId);
    expect(() => f.admission({ objective: "Another objective" }).prepare("Another objective")).toThrow();
    expect(() => admission.prepare(objective)).toThrow();
    // A completing goal still owns tool restoration until the host finalizes it.
    f.session.setGoalModeState({ ...state!, enabled: false, mode: "exiting", reason: "completed", goal: { ...state!.goal, status: "complete" } });
    expect(() => f.admission({ objective: "Another objective" }).prepare("Another objective")).toThrow();
    f.session.setGoalModeState(state);
    // Native createGoal permits a fresh goal over a dropped one; so does the module.
    await f.session.goalRuntime.dropGoal();
    await f.session.setActiveToolsByName(before);
    const fresh = f.admission({ objective: "Another objective", tokenBudget: 7 });
    fresh.prepare("Another objective");
    await fresh.initialize();
    expect(fresh.goalId).not.toBe(admission.goalId);
    expect(f.session.getGoalModeState()).toMatchObject({ enabled: true, goal: { id: fresh.goalId, objective: "Another objective", tokenBudget: 7, status: "active" } });
    expect(f.activations).toEqual([before, before]);
    expect(f.manager.getEntries().filter(entry => entry.type === "mode_change").map(entry => entry.mode)).toEqual(["goal", "none", "goal"]);
  } finally { await f.close(); }
}, 20_000);

test("module rejects disabled goals, native modes, slash text and invalid intent before any mutation", async () => {
  const f = await nativeFixture();
  try {
    expect(() => f.admission({ objective }).prepare("/goal " + objective)).toThrow();
    expect(() => f.admission({ objective }).prepare("  /skill:review")).toThrow();
    expect(() => f.admission({ objective }).prepare("Other text")).toThrow();
    expect(() => f.admission({ objective: "   " }).prepare("   ")).toThrow();
    expect(() => f.admission({ objective, tokenBudget: -5 }).prepare(objective)).toThrow();
    expect(() => f.admission({ objective, extra: true }).prepare(objective)).toThrow();
    expect(() => f.admission(undefined).prepare(objective)).toThrow();
    f.manager.appendModeChange("plan");
    expect(() => f.admission({ objective }).prepare(objective)).toThrow();
    f.manager.appendModeChange("none");
    const armed = f.admission({ objective });
    armed.prepare(objective);
    f.session.setVibeModeState({ enabled: true });
    await expect(armed.initialize()).rejects.toThrow();
    f.session.setVibeModeState(undefined);
    expect(armed.attempted).toBe(false);
    expect(f.session.getGoalModeState()).toBeUndefined();
    expect(f.activations).toEqual([]);
    expect(f.session.getEnabledToolNames()).not.toContain("goal");
    expect(f.manager.getEntries().some(entry => entry.type === "mode_change" && entry.mode === "goal")).toBe(false);
  } finally { await f.close(); }
  const disabled = await nativeFixture("extensions: []\ngoal:\n  enabled: false\n");
  try {
    expect(() => disabled.admission({ objective }).prepare(objective)).toThrow();
    expect(disabled.session.getGoalModeState()).toBeUndefined();
  } finally { await disabled.close(); }
}, 20_000);

test("module fences retired owner and session identity before createGoal without marking a mutation", async () => {
  const f = await nativeFixture();
  try {
    const retired = f.admission({ objective });
    retired.prepare(objective);
    f.retire();
    const failure = await retired.initialize().then(() => undefined, (error: unknown) => error);
    expect(failure).not.toBeInstanceOf(NativeGoalPromptAdmissionError);
    expect(retired.attempted).toBe(false);
    expect(retired.failure(new Error("later"))).toMatchObject({ message: "later" });
    expect(f.session.getGoalModeState()).toBeUndefined();
  } finally { await f.close(); }
  const g = await nativeFixture();
  try {
    const moved = g.admission({ objective });
    moved.prepare(objective);
    const originalFile = g.session.sessionFile;
    await g.manager.newSession();
    expect(g.session.sessionFile).not.toBe(originalFile);
    await expect(moved.initialize()).rejects.toThrow();
    expect(moved.attempted).toBe(false);
    expect(g.session.getGoalModeState()).toBeUndefined();
    expect(g.activations).toEqual([]);
    expect(g.manager.getEntries().some(entry => entry.type === "mode_change")).toBe(false);
  } finally { await g.close(); }
}, 20_000);

test("module wraps any failure after createGoal as OUTCOME_UNKNOWN with inspection guidance and never rolls back", async () => {
  const f = await nativeFixture();
  try {
    const admission = f.admission({ objective, tokenBudget: 9 });
    admission.prepare(objective);
    f.failActivation(new Error("Controlled tool activation fault"));
    const failure = await admission.initialize().then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(NativeGoalPromptAdmissionError);
    const unknown = failure as NativeGoalPromptAdmissionError;
    expect(unknown).toMatchObject({ code: "OUTCOME_UNKNOWN", step: "tools", objective, sessionFile: f.session.sessionFile, goalId: f.session.getGoalModeState()?.goal.id });
    expect((unknown.cause as Error).message).toBe("Controlled tool activation fault");
    expect(admission.attempted).toBe(true);
    expect(admission.initialized).toBe(false);
    expect(f.suppressionResets).toBe(0);
    expect(f.session.getGoalModeState()).toMatchObject({ goal: { objective, tokenBudget: 9, status: "active" } });
    expect(admission.failure(unknown)).toBe(unknown);
    const rewrapped = admission.failure(new Error("owner catch")) as NativeGoalPromptAdmissionError;
    expect(rewrapped).toBeInstanceOf(NativeGoalPromptAdmissionError);
    expect(rewrapped.code).toBe("OUTCOME_UNKNOWN");
    const duplicate = await admission.initialize().then(() => undefined, (error: unknown) => error);
    expect(duplicate).toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(f.manager.getEntries().filter(entry => entry.type === "mode_change" && entry.mode === "goal")).toHaveLength(1);
  } finally { await f.close(); }
}, 20_000);
