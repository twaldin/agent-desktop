import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerFailureError, WorkerRuntime, type WorkerFailure } from "./runtime";
import type { OmpInteraction } from "../omp";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Worker contract cleanup failed");
});

async function isolatedRuntime(onWorkerFailure?: (failure: WorkerFailure) => void, shutdownTimeoutMs?: number) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-worker-contract-")));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const agentDir = path.join(directory, ".omp", "agent");
  const cwd = path.join(directory, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd);
  await writeFile(path.join(agentDir, "config.yml"), "extensions: []\n");
  const runtime = new WorkerRuntime({
    agentDir, onWorkerFailure,
    workerPath: fileURLToPath(new URL("./fixtures/no-provider-worker.ts", import.meta.url)),
    // Full override: no user provider credentials, broker address, profile,
    // config roots or user extensions enter these lifecycle contracts.
    environment: {
      HOME: directory, PATH: process.env.PATH, TMPDIR: tmpdir(),
      PI_CODING_AGENT_DIR: agentDir, TERM: "dumb",
    },
    startupTimeoutMs: 30_000, shutdownTimeoutMs,
  });
  cleanups.push(() => runtime.dispose());
  return { runtime, directory, cwd, agentDir };
}

async function seedAuth(directory: string, agentDir: string, mode: "key" | "oauth") {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/seed-auth.ts", import.meta.url)), agentDir, mode], {
    env: { HOME: directory, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: "dumb" },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`Native fixture setup failed: ${stderr}`);
}

describe("actual Bun worker lifecycle without provider calls", () => {
  test("composer metadata resolves native default roles and thinking in the selected project without creating a session", async () => {
    const { runtime, directory, cwd, agentDir } = await isolatedRuntime();
    await seedAuth(directory, agentDir, "key");
    const initial = await runtime.getComposerCatalog(cwd, { refresh: true });
    const candidates = initial.models.filter(model => model.provider === "openai" && model.available && model.thinkingLevels?.includes("high") && model.thinkingLevels.includes("low"));
    expect(candidates.length).toBeGreaterThan(1);
    const [first, second] = candidates;
    const global = `extensions: []\nmodelRoles:\n  default: [openai/${first!.id}:high]\n`;
    await writeFile(path.join(agentDir, "config.yml"), global);
    let result = await runtime.getComposerCatalog(cwd, { refresh: true });
    expect(result.default).toMatchObject({ source: "configured-role", model: { id: first!.id, provider: "openai" }, thinkingLevel: "high", effectiveThinkingLevel: "high" });
    await mkdir(path.join(cwd, ".omp"));
    const project = `modelRoles:\n  default: [openai/${second!.id}:low]\ndisabledProviders: [anthropic]\n`;
    await writeFile(path.join(cwd, ".omp", "config.yml"), project);
    result = await runtime.getComposerCatalog(cwd, { refresh: true });
    expect(result.default).toMatchObject({ source: "configured-role", model: { id: second!.id, provider: "openai" }, thinkingLevel: "low", effectiveThinkingLevel: "low" });
    expect(result.models.find(model => model.provider === "anthropic")?.disabledInSettings).toBe(true);
    const other = path.join(directory, "other-project"); await mkdir(other);
    expect((await runtime.getComposerCatalog(other)).default.model?.id).toBe(first!.id);
    expect(await readFile(path.join(agentDir, "config.yml"), "utf8")).toBe(global);
    expect(await readFile(path.join(cwd, ".omp", "config.yml"), "utf8")).toBe(project);
    expect(JSON.stringify(result)).not.toContain("contract-api-key");
    expect(await Array.fromAsync(new Bun.Glob("**/*.jsonl").scan({ cwd: directory, absolute: true }))).toHaveLength(0);
    await writeFile(path.join(cwd, ".omp", "config.yml"), project + "enabledModels: [no-such-provider/no-such-model]\n");
    expect((await runtime.getComposerCatalog(cwd, { refresh: true })).default).toEqual({ model: null, source: "unavailable", approvalMode: "yolo" });
  }, 60_000);
  test("host-owned permission intent applies on native creation, mutation and resume without writing native settings", async () => {
    const { runtime, cwd, agentDir } = await isolatedRuntime();
    const config = "extensions: []\ntools:\n  approvalMode: write\n";
    await writeFile(path.join(agentDir, "config.yml"), config);
    expect((await runtime.getComposerCatalog(cwd)).default.approvalMode).toBe("write");
    const session = await runtime.create({ cwd, approvalOverride: "always-ask", interactions: true });
    let controls = await session.getControls();
    expect(controls.durableApprovalOverride).toBe("always-ask");
    expect(controls.settings.find(item => item.path === "tools.approvalMode")).toMatchObject({ effective: "always-ask", origin: "runtime" });
    expect(controls.overrides).toContain("tools.approvalMode");
    const changed = await session.setApprovalOverride("yolo", controls.revision);
    await expect(session.setApprovalOverride("write", controls.revision)).rejects.toThrow("changed");
    expect(changed.durableApprovalOverride).toBe("yolo");
    expect(await readFile(path.join(agentDir, "config.yml"), "utf8")).toBe(config);
    await session.dispose();
    const reopened = await runtime.open({ sessionFile: session.sessionFile, approvalOverride: "always-ask", interactions: true });
    controls = await reopened.getControls();
    expect(controls.durableApprovalOverride).toBe("always-ask");
    expect(controls.settings.find(item => item.path === "tools.approvalMode")?.effective).toBe("always-ask");
    controls = await reopened.setApprovalOverride(undefined, controls.revision);
    expect(controls.durableApprovalOverride).toBeUndefined();
    expect(controls.overrides).not.toContain("tools.approvalMode");
    expect(controls.settings.find(item => item.path === "tools.approvalMode")?.effective).toBe("write");
    expect(await readFile(path.join(agentDir, "config.yml"), "utf8")).toBe(config);
  }, 40_000);
  test("a handled native slash command admits its real side effect without a fabricated user message", async () => {
    const { runtime, cwd, agentDir } = await isolatedRuntime();
    const extension = fileURLToPath(new URL("./fixtures/admission-extension.ts", import.meta.url));
    await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(extension)}\n`);
    const session = await runtime.create({ cwd, interactions: true });
    const run = session.startPrompt("/admission-contract first");
    const receipt = await run.accepted;
    const entries = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(entries.filter(entry => entry.type === "custom" && entry.customType === "admission-contract")).toHaveLength(1);
    expect(entries.some(entry => entry.type === "message" && entry.message.role === "user")).toBe(false);
    expect(receipt).toEqual({ kind: "native-command", command: "admission-contract" });
    expect(await run.completion).toBe(false);
  }, 30_000);
  test("native command errors retain partial effects without inventing successful admission", async () => {
    const { runtime, cwd, agentDir } = await isolatedRuntime();
    const extension = fileURLToPath(new URL("./fixtures/admission-extension.ts", import.meta.url));
    await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(extension)}\n`);
    const notices: unknown[] = [];
    const session = await runtime.create({ cwd, interactions: true, onEvent: event => { notices.push(event); } });
    for (const suffix of ["before", "after"]) {
      const run = session.startPrompt(`/admission-contract throw-${suffix}`);
      await expect(run.accepted).rejects.toThrow(`failed ${suffix} side effect`);
      await expect(run.completion).rejects.toThrow(`failed ${suffix} side effect`);
    }
    const entries = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(entries.filter(entry => entry.customType === "admission-contract").map(entry => entry.data.args)).toEqual(["throw-after"]);
    expect(entries.some(entry => entry.type === "message")).toBe(false);
    expect(JSON.stringify(notices)).toContain("failed before side effect");
    expect(JSON.stringify(notices)).toContain("failed after side effect");
    expect(session.workerFailure).toBeUndefined();
  }, 30_000);
  test("unsupported native builtin dispatch and model preflight reject before command side effects", async () => {
    const { runtime, cwd, agentDir } = await isolatedRuntime();
    const extension = fileURLToPath(new URL("./fixtures/admission-extension.ts", import.meta.url));
    await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(extension)}\n`);
    const session = await runtime.create({ cwd, interactions: true });
    const unsupported = session.startPrompt("/move /unadmitted-destination");
    await expect(unsupported.accepted).rejects.toThrow("not connected to the desktop command dispatcher");
    await expect(unsupported.completion).rejects.toThrow("not connected to the desktop command dispatcher");
    const preflight = session.startPrompt("/admission-contract must-not-run", { model: { provider: "missing-provider", id: "missing-model" } });
    await expect(preflight.accepted).rejects.toThrow("OMP model is not available");
    await expect(preflight.completion).rejects.toThrow("OMP model is not available");
    const entries = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(entries.some(entry => entry.customType === "admission-contract" || entry.type === "message")).toBe(false);
    expect(session.cwd).toBe(cwd);
  }, 30_000);
  test("native custom commands distinguish consumed results, errors and a real forwarded user prompt", async () => {
    const { runtime, cwd, agentDir, directory } = await isolatedRuntime();
    const commandDirectory = path.join(agentDir, "commands", "admission"); await mkdir(commandDirectory, { recursive: true });
    const effects = path.join(directory, "custom-command-effects");
    await writeFile(path.join(commandDirectory, "index.ts"), `import { appendFileSync } from "node:fs";
export default () => [
  { name: "custom-local", description: "Native custom contract", execute(args) { appendFileSync(${JSON.stringify(effects)}, JSON.stringify(args) + "\\n"); } },
  { name: "custom-error", description: "Native custom error contract", execute() { throw new Error("Native custom contract error"); } },
  { name: "custom-prompt", description: "Native custom prompt contract", execute() { return "Forwarded native custom contract input"; } }
];\n`);
    const session = await runtime.create({ cwd, interactions: true });
    const local = session.startPrompt('/custom-local "two words"');
    expect(await local.accepted).toEqual({ kind: "native-command", command: "custom-local" });
    expect(await local.completion).toBe(false);
    expect(await readFile(effects, "utf8")).toBe('["two words"]\n');
    const failed = session.startPrompt("/custom-error");
    await expect(failed.accepted).rejects.toThrow("Native custom contract error");
    await expect(failed.completion).rejects.toThrow("Native custom contract error");
    await seedAuth(directory, agentDir, "key");
    const model = (await runtime.listModels(cwd)).find(model => model.provider === "openai")!;
    const controls = await session.getControls();
    await session.mutateControls({ expectedRevision: controls.revision, operation: "override", path: "retry.enabled", value: false });
    // Fetch is disabled in the actual worker: this verifies native admission and
    // error handling, not provider inference or an invented model response.
    for (const text of ["Ordinary native contract input", "/custom-prompt"]) {
      const turn = session.startPrompt(text, { model });
      const receipt = await turn.accepted;
      expect(receipt?.kind).toBe("user-message");
      await session.abort();
      await turn.completion;
      const expected = text === "/custom-prompt" ? "Forwarded native custom contract input" : text;
      expect((await session.getMessages()).some(message => message.role === "user" && message.text === expected)).toBe(true);
    }
  }, 30_000);
  test("dispose cancels a real worker while native extension import is still initializing", async () => {
    const { runtime, cwd, agentDir } = await isolatedRuntime(undefined, 500);
    let expectedCleanupFailure: unknown;
    const cleanup = cleanups.pop()!;
    cleanups.push(async () => {
      try { await cleanup(); }
      catch (error) { if (error !== expectedCleanupFailure) throw error; }
    });
    const marker = path.join(agentDir, "stalled-import-pid");
    const extension = path.join(agentDir, "stalled-import.ts");
    await writeFile(extension, `await Bun.write(${JSON.stringify(marker)}, String(process.pid));\nawait new Promise<void>(() => {});\nexport default function() {}\n`);
    await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(extension)}\n`);
    const creating = runtime.create({ cwd }).then(() => undefined, error => error);
    let workerPid: number | undefined;
    const readyDeadline = Date.now() + 5000;
    while (!workerPid && Date.now() < readyDeadline) {
      try { workerPid = Number(await readFile(marker, "utf8")); } catch { await Bun.sleep(20); }
    }
    expect(workerPid).toBeGreaterThan(0);
    const started = Date.now();
    const disposing = runtime.dispose().catch(error => error);
    const result = await Promise.race([disposing, Bun.sleep(2000).then(() => "shutdown timed out")]);
    expectedCleanupFailure = result;
    expect(result).not.toBe("shutdown timed out");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await creating).toBeInstanceOf(Error);
    expect(() => process.kill(workerPid!, 0)).toThrow();
    // Bounded cancellation reports its incomplete native cleanup honestly.
    expect(result).toBeInstanceOf(AggregateError);
  }, 10_000);
  test("discovery refresh replaces stale native settings and model configuration", async () => {
    const { runtime, cwd, agentDir } = await isolatedRuntime();
    const before = await runtime.listModels(cwd);
    const selected = before.find(model => model.provider === "openai")!;
    expect(selected.disabledInSettings).toBe(false);
    await writeFile(path.join(agentDir, "config.yml"), "extensions: []\ndisabledProviders: [openai]\n");
    let refreshed = await runtime.listModels(cwd, { refresh: true });
    expect(refreshed.find(model => model.provider === "openai")?.disabledInSettings).toBe(true);
    expect(refreshed.find(model => model.provider === "openai")?.available).toBe(false);
    await mkdir(path.join(cwd, ".omp"));
    await writeFile(path.join(cwd, ".omp", "config.yml"), "disabledProviders: [anthropic]\n");
    refreshed = await runtime.listModels(cwd, { refresh: true });
    expect(refreshed.find(model => model.provider === "anthropic")?.disabledInSettings).toBe(true);
    const disabledChoice = refreshed.find(model => model.provider === "anthropic")!;
    await expect(runtime.create({ cwd, model: disabledChoice })).rejects.toThrow("disabled");
    for (const name of ["Contract first model name", "Contract updated model name"]) {
      await writeFile(path.join(agentDir, "models.yml"), JSON.stringify({ providers: { openai: { modelOverrides: { [selected.id]: { name } } } } }));
      const capabilities = await runtime.listModelCapabilities(cwd, { refresh: true });
      expect(capabilities.find(model => model.provider === "openai" && model.id === selected.id)?.name).toBe(name);
      expect(capabilities.find(model => model.provider === "anthropic")?.capabilities.disabledInSettings).toBe(true);
    }
  }, 90_000);
  test("native session controls persist thinking/tiers while runtime setting overrides remain session-local", async () => {
    const { runtime, cwd, agentDir } = await isolatedRuntime();
    const session = await runtime.create({ cwd });
    let controls = await session.getControls();
    expect(controls.settings).toHaveLength(484);
    const originalRevision = controls.revision;
    for (const operation of ["override", "clear-override"] as const) await expect(session.mutateControls({ expectedRevision: controls.revision, operation, path: "tools.approvalMode", ...(operation === "override" ? { value: "always-ask" } : {}) } as Parameters<typeof session.mutateControls>[0])).rejects.toThrow("durable approval path");
    controls = await session.mutateControls({ expectedRevision: controls.revision, operation: "override", path: "retry.enabled", value: false });
    expect(controls.settings.find(setting => setting.path === "retry.enabled")?.effective).toBe(false);
    expect(controls.overrides).toContain("retry.enabled");
    await expect(session.mutateControls({ expectedRevision: originalRevision, operation: "thinking", level: "auto" })).rejects.toThrow("changed");
    await expect(session.mutateControls({ expectedRevision: controls.revision, operation: "service-tier", family: "anthropic", tier: "flex" })).rejects.toThrow("Unsupported native service tier");
    controls = await session.mutateControls({ expectedRevision: controls.revision, operation: "service-tier", family: "openai", tier: "scale" });
    expect(controls.serviceTiers.openai).toBe("scale");
    controls = await session.mutateControls({ expectedRevision: controls.revision, operation: "thinking", level: "auto" });
    expect(controls.thinkingLevel).toBe("auto");
    expect(await readFile(path.join(agentDir, "config.yml"), "utf8")).toBe("extensions: []\n");
    const nativeFile = session.sessionFile;
    await session.dispose();
    const resumed = await runtime.open({ sessionFile: nativeFile });
    const restored = await resumed.getControls();
    expect(restored.serviceTiers.openai).toBe("scale");
    expect(restored.thinkingLevel).toBe("auto");
    expect(restored.overrides).toEqual([]);
    expect(restored.settings.find(setting => setting.path === "retry.enabled")?.effective).toBe(true);
    expect(restored.settings.find(setting => setting.path === "tools.approvalMode")?.effective).toBe("yolo");
    const capabilities = await runtime.listModelCapabilities(cwd);
    expect(capabilities.length).toBeGreaterThan(0);
    const reasoning = capabilities.find(model => model.thinking?.efforts.length);
    expect(reasoning?.thinkingSelectors).toContain("auto");
    expect(reasoning?.thinkingSelectors).toContain("off");
    for (const model of capabilities) {
      expect(Object.hasOwn(model, "headers")).toBe(false);
      expect(Object.hasOwn(model, "baseUrl")).toBe(false);
      expect(model.excludedSensitiveFields).toContain("compat.extraBody");
    }
  }, 90_000);
  test("actual native permission gate prevents a write until explicit approval", async () => {
    const { directory, agentDir, cwd } = await isolatedRuntime();
    await writeFile(path.join(agentDir, "config.yml"), "extensions: []\ntools:\n  approvalMode: always-ask\n");
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/permission-scenario.ts", import.meta.url)), agentDir, cwd], {
      env: { HOME: directory, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: "dumb" },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Native permission fixture failed: ${stderr}`);
    expect(stdout).toContain("actual native write denied then explicitly approved");
    expect(await readFile(path.join(cwd, "permission-contract.txt"), "utf8")).toBe("native tool wrote after explicit approval\n");
  }, 60_000);
  test("cross-process native auth changes refresh discovery and each session selects its own account", async () => {
    const { runtime, cwd, agentDir, directory } = await isolatedRuntime();
    const before = await runtime.listModels(cwd);
    const choice = before.find(model => model.provider === "openai")!;
    expect(choice.authenticated).toBe(false);
    // Create before auth is written, proving the existing worker sees updates.
    const first = await runtime.create({ cwd });
    await seedAuth(directory, agentDir, "oauth");
    const after = await runtime.listModels(cwd, { refresh: true });
    expect(after.find(model => model.provider === choice.provider && model.id === choice.id)?.authenticated).toBe(true);
    await first.setModel({ provider: choice.provider, id: choice.id });
    const second = await runtime.create({ cwd, model: choice });
    const accounts = await first.listAccountChoices();
    expect(accounts.sessionId).toBe(first.id); expect(accounts.providerId).toBe("openai");
    expect(accounts.accounts).toHaveLength(2);
    const [a, b] = accounts.accounts;
    expect((await first.pinAccount(a.credentialId)).accounts.find(account => account.active)?.credentialId).toBe(a.credentialId);
    expect((await second.pinAccount(b.credentialId)).accounts.find(account => account.active)?.credentialId).toBe(b.credentialId);
    expect((await first.listAccountChoices()).accounts.find(account => account.active)?.credentialId).toBe(a.credentialId);
    const nativeFile = first.sessionFile;
    await first.dispose();
    const resumed = await runtime.open({ sessionFile: nativeFile });
    expect((await resumed.listAccountChoices()).accounts.find(account => account.active)?.credentialId).toBe(a.credentialId);
    expect((await resumed.releaseAccountForReselection()).accounts.some(account => account.active)).toBe(false);
    await expect(resumed.pinAccount(999_999)).rejects.toThrow("unavailable");
    expect(JSON.stringify(await resumed.listAccountChoices())).not.toMatch(/contract-access|contract-refresh/);
  }, 90_000);

  test("native extension questions cross IPC, survive listener detach, and resolve only once", async () => {
    const { runtime, cwd, agentDir, directory } = await isolatedRuntime();
    const extension = fileURLToPath(new URL("./fixtures/interaction-extension.ts", import.meta.url));
    await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(extension)}\n`);
    const arrivals: OmpInteraction[] = [];
    const firstEvent = Promise.withResolvers<OmpInteraction>();
    const session = await runtime.create({ cwd, interactions: true, onEvent: event => {
      if (event.type === "extension_interaction_requested") {
        arrivals.push(event.interaction); firstEvent.resolve(event.interaction);
      }
    } });
    // The already-created session must recognize a new key on prompt admission.
    const model = (await runtime.listModels(cwd)).find(model => model.provider === "openai")!;
    await seedAuth(directory, agentDir, "key");
    const run = session.startPrompt("/bridge-contract", { model });
    const waitFor = async (method: string) => {
      for (let i = 0; i < 200; i++) {
        const pending = await session.listInteractions();
        if (pending[0]?.method === method) return pending[0];
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`Native contract never requested ${method}`);
    };
    const selected = await waitFor("select");
    expect((await firstEvent.promise).id).toBe(selected.id);
    expect(arrivals.some(event => event.id === selected.id)).toBe(true);
    await expect(session.respondInteraction(selected.id, { value: "forged" })).rejects.toThrow("not a native OMP option");
    await expect(session.pinAccount(1)).rejects.toThrow("busy");
    const unsubscribe = session.subscribe(() => {}); unsubscribe();
    expect((await session.listInteractions())[0].id).toBe(selected.id);
    await session.respondInteraction(selected.id, { value: "Second" });
    await expect(session.respondInteraction(selected.id, { value: "First" })).rejects.toThrow("no longer pending");
    await session.respondInteraction((await waitFor("confirm")).id, { value: false });
    await session.respondInteraction((await waitFor("input")).id, { value: "Entered text" });
    await session.respondInteraction((await waitFor("editor")).id, { value: "Edited text" });
    // Slash command handled natively; there is no model turn or user message.
    expect(await run.accepted).toEqual({ kind: "native-command", command: "bridge-contract" }); await run.completion;
    expect(await session.listInteractions()).toEqual([]);
    const entries = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const result = entries.find(entry => entry.type === "custom" && entry.customType === "bridge-contract-result");
    expect(result.data).toEqual({ selected: "Second", confirmed: false, input: "Entered text", edited: "Edited text" });
    expect(session.workerFailure).toBeUndefined();
  }, 60_000);

  test("session_start waits after identity is returned, and abort prevents later prompt dispatch", async () => {
    const { runtime, cwd, agentDir } = await isolatedRuntime();
    const extension = fileURLToPath(new URL("./fixtures/startup-extension.ts", import.meta.url));
    await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(extension)}\n`);
    const request = Promise.withResolvers<OmpInteraction>();
    const session = await runtime.create({ cwd, interactions: true, onEvent: event => {
      if (event.type === "extension_interaction_requested") request.resolve(event.interaction);
    } });
    expect(session.id).toBeTruthy(); expect(await session.listInteractions()).toEqual([]);
    const run = session.startPrompt("/startup-contract");
    const pending = await request.promise;
    expect(pending.title).toBe("Contract startup");
    expect((await session.listInteractions())[0].id).toBe(pending.id);
    await session.abort();
    await expect(run.accepted).rejects.toThrow("aborted before native acceptance");
    await expect(run.completion).rejects.toThrow("aborted before native acceptance");
    expect(await session.listInteractions()).toEqual([]);
    expect(await readFile(session.sessionFile, "utf8")).not.toContain("startup-command-dispatched");
    const retry = session.startPrompt("/startup-contract");
    expect(await retry.accepted).toEqual({ kind: "native-command", command: "startup-contract" }); await retry.completion;
    expect(await readFile(session.sessionFile, "utf8")).toContain("startup-command-dispatched");
    expect(session.workerFailure).toBeUndefined();
  }, 60_000);
  test("starts a real worker, creates a native file, and resumes its original identity", async () => {
    const { runtime, cwd, agentDir } = await isolatedRuntime();
    const created = await runtime.create({ cwd });
    expect(created.workerPid).not.toBe(process.pid);
    expect(created.workerPid).toBeGreaterThan(0);
    expect(created.sessionFile.startsWith(path.join(agentDir, "sessions"))).toBe(true);
    const physicalEntries = (await readFile(created.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(physicalEntries[0].type).toBe("title");
    const header = physicalEntries.find(entry => entry.type === "session");
    expect(header.id).toBe(created.id);
    expect(header.cwd).toBe(cwd);
    expect(await created.getMessages()).toEqual([]);
    await expect(runtime.open({ sessionFile: created.sessionFile })).rejects.toThrow("already open");
    const identity = { id: created.id, sessionFile: created.sessionFile, cwd: created.cwd };
    const pid = created.workerPid;
    await created.dispose();
    expect(() => process.kill(pid, 0)).toThrow();
    const resumed = await runtime.open({ sessionFile: identity.sessionFile });
    expect(resumed.id).toBe(identity.id);
    expect(resumed.sessionFile).toBe(identity.sessionFile);
    expect(resumed.cwd).toBe(identity.cwd);
    expect(resumed.workerPid).not.toBe(pid);
    expect(await resumed.getMessages()).toEqual([]);
  }, 60_000);

  test("killing one actual worker fails its handle while the other remains usable", async () => {
    const failed = Promise.withResolvers<WorkerFailure>();
    const { runtime, cwd, directory } = await isolatedRuntime(failure => failed.resolve(failure));
    const secondCwd = path.join(directory, "second-project");
    await mkdir(secondCwd);
    const first = await runtime.create({ cwd });
    const second = await runtime.create({ cwd: secondCwd });
    expect(first.workerPid).not.toBe(second.workerPid);
    process.kill(first.workerPid, "SIGKILL");
    const failure = await failed.promise;
    expect(failure.type).toBe("worker_failure");
    expect(failure.sessionId).toBe(first.id);
    expect(first.workerFailure?.pid).toBe(first.workerPid);
    await expect(first.getMessages()).rejects.toBeInstanceOf(WorkerFailureError);
    expect(await second.getMessages()).toEqual([]);
    expect(second.workerFailure).toBeUndefined();
    const nativeFile = first.sessionFile;
    const nativeId = first.id;
    await first.dispose();
    const recovered = await runtime.open({ sessionFile: nativeFile });
    expect(recovered.id).toBe(nativeId);
    expect(await recovered.getMessages()).toEqual([]);
    expect(await second.getMessages()).toEqual([]);
  }, 90_000);

  test("preflight rejection crosses IPC without an acceptance receipt or invented transcript", async () => {
    const { runtime, cwd } = await isolatedRuntime();
    const session = await runtime.create({ cwd });
    const run = session.startPrompt("contract input that must not reach a provider", {
      model: { provider: "missing-contract-provider", id: "missing-contract-model" },
    });
    await expect(run.accepted).rejects.toThrow("OMP model is not available");
    await expect(run.completion).rejects.toThrow("OMP model is not available");
    expect(await session.getMessages()).toEqual([]);
    expect(session.workerFailure).toBeUndefined();
  }, 60_000);

  test("failed native startup cleans up and does not poison the next worker", async () => {
    const { runtime, cwd } = await isolatedRuntime();
    await expect(runtime.create({ cwd, thinkingLevel: "invalid-contract-thinking" })).rejects.toThrow("Unknown OMP thinking level");
    const session = await runtime.create({ cwd });
    expect(await session.getMessages()).toEqual([]);
  }, 60_000);

  test("discovery stays in a separate worker and exposes only safe model metadata", async () => {
    const { runtime, cwd } = await isolatedRuntime();
    const models = await runtime.listModels(cwd);
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(Object.keys(model).sort()).toEqual([
        "authenticated", "available", "contextWindow", "disabledInSettings", "id", "input", "maxTokens", "name", "provider", "reasoning", "thinkingLevels",
      ]);
    }
    const session = await runtime.create({ cwd });
    expect(await session.getMessages()).toEqual([]);
    expect((await runtime.listModels(cwd)).length).toBe(models.length);
  }, 60_000);
});
