import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerRuntime } from "../omp-workers/runtime";

async function runDirectRuntime() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-plan-runtime-")));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/plan-runtime.ts", import.meta.url)), directory], {
      env: { HOME: directory, PATH: process.env.PATH, TMPDIR: tmpdir(), TERM: "dumb", PI_DISABLE_DOTENV: "1",
        PI_CODING_AGENT_DIR: path.join(directory, "manual", "agent") }, stdout: "pipe", stderr: "pipe",
    });
    deadline = setTimeout(() => child.kill(), 25_000);
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`OmpRuntime Plan fixture failed (${code}):\n${stdout}\n${stderr}`);
    return JSON.parse(stdout.trim().split("\n").at(-1)!);
  } finally { clearTimeout(deadline); await rm(directory, { recursive: true, force: true }); }
}

test("actual OmpRuntime Plan reads, slash transitions, startup defaults, and reopen use the native journal", async () => {
  const result = await runDirectRuntime();
  expect(result.blockedFetches).toBe(0);
  expect(result.lifecycle).toEqual({ initial: "off", transitions: ["active", "paused", "off", "active"], restored: "active" });
  expect(result.startup).toBe("active"); expect(result.disabled).toBe("off");
  expect(result.journalModes).toEqual(["plan", "plan_paused", "none", "plan", "plan"]);
}, 30_000);

test("the actual worker getPlan bridge returns the owning runtime state without mutating its journal", async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-plan-worker-")));
  const agentDir = path.join(directory, "agent"), cwd = path.join(directory, "project");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  await writeFile(path.join(agentDir, "config.yml"), "extensions: []\nplan:\n  enabled: true\n  defaultOnStartup: false\nmodelRoles:\n  default: [plan-fixture/base]\n  plan: [plan-fixture/base:low]\n");
  await writeFile(path.join(agentDir, "models.yml"), JSON.stringify({ providers: { "plan-fixture": {
    api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", auth: "none", models: [{
      id: "base", name: "Local non-executing Plan model", reasoning: true, input: ["text"], contextWindow: 128000,
      maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  } } }));
  const runtime = new WorkerRuntime({
    agentDir, workerPath: fileURLToPath(new URL("../omp-workers/fixtures/no-provider-worker.ts", import.meta.url)),
    environment: { HOME: directory, PATH: process.env.PATH, TMPDIR: tmpdir(), TERM: "dumb", PI_DISABLE_DOTENV: "1", PI_CODING_AGENT_DIR: agentDir },
    startupTimeoutMs: 30_000, shutdownTimeoutMs: 10_000,
  });
  try {
    const session = await runtime.create({ cwd, model: { provider: "plan-fixture", id: "base" } });
    const beforeBytes = await readFile(session.sessionFile, "utf8");
    const first = await session.getPlan(), second = await session.getPlan();
    expect(first).toEqual(second); expect(first).toMatchObject({ mode: "off", enabled: true });
    expect(await readFile(session.sessionFile, "utf8")).toBe(beforeBytes);
    const run = session.startPrompt("/plan"); expect(await run.completion).toBe(false);
    expect(await session.getPlan()).toMatchObject({ mode: "active", enabled: true });
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 45_000);
