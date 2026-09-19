import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installUsageTodosFetch } from "./usage-todos-controlled-fetch";
const directory = process.argv[2]!, mode = process.argv[3]!;
assert.equal(process.env.HOME, directory); assert(["direct", "worker"].includes(mode));
installUsageTodosFetch(directory);
const agentDir = path.join(directory, "agent"), cwd = path.join(directory, "project");
await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
await writeFile(path.join(directory, "calls"), "");
await writeFile(path.join(agentDir, "config.yml"), "extensions: []\ncodexResets:\n  autoRedeem: yes\n");
await writeFile(path.join(agentDir, "models.yml"), JSON.stringify({ providers: { "usage-todos-fixture": {
  api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", auth: "none", models: [{ id: "base", name: "Nonexecuting fixture", reasoning: false,
    input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
const { discoverAuthStorage } = await import("@oh-my-pi/pi-coding-agent");
const auth = await discoverAuthStorage(agentDir);
await auth.set("openai-codex", { type: "oauth", accountId: "fixture-account", orgId: "fixture-org", email: "fixture@fixture.invalid",
  access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 86_400_000 }); auth.close();
const { OmpRuntime } = await import("../runtime");
const { WorkerRuntime } = await import("../../omp-workers/runtime");
const runtime = mode === "direct" ? new OmpRuntime({ agentDir }) : new WorkerRuntime({ agentDir,
  workerPath: fileURLToPath(new URL("./usage-todos-worker.ts", import.meta.url)), environment: { HOME: directory, PATH: process.env.PATH,
    TMPDIR: directory, TERM: "dumb", PI_DISABLE_DOTENV: "1", PI_CODING_AGENT_DIR: agentDir, USAGE_TODOS_FIXTURE_DIRECTORY: directory } });
const session = await runtime.create({ cwd, model: { provider: "usage-todos-fixture", id: "base" } });
const results: { mode: string; refusals: string[]; freshTodoCommits: number; reverseRefused: boolean; providerReads?: number } = { mode, refusals: [], freshTodoCommits: 0, reverseRefused: false };
try {
  for (const refresh of ["reports", "credits"] as const) {
    const before = await session.getTodos(), bytes = await readFile(session.sessionFile, "utf8");
    await writeFile(path.join(directory, "gate"), refresh);
    const pending = session.readUsage(refresh);
    const deadline = Date.now() + 10_000;
    while (!(await access(path.join(directory, `started-${refresh}`)).then(() => true, () => false))) {
      assert(Date.now() < deadline, "native report/credit fetch reached controlled hold"); await new Promise(resolve => setTimeout(resolve, 5));
    }
    try {
      await assert.rejects(session.mutateTodos(`held-${refresh}`, { sessionId: session.id, ticket: before.ticket,
        mutation: { action: "command", text: `/todo append Must refuse ${refresh}` } }), (error: unknown) => {
        assert(error instanceof Error); results.refusals.push((error as Error & { code?: string }).code ?? error.name); return true;
      });
      assert.equal(await readFile(session.sessionFile, "utf8"), bytes, "held native Usage must prevent all Todo journal writes");
    } finally { await writeFile(path.join(directory, `released-${refresh}`), "release"); }
    const snapshot = await pending; assert(snapshot); assert(refresh === "reports" ? snapshot.reports.length > 0 : snapshot.credits.length === 1);
    assert.equal(results.refusals.at(-1), "TODOS_REJECTED", "an acknowledged pre-dispatch refusal must not strand the Todos UI in unknown");
    await writeFile(path.join(directory, "gate"), "");
    const fresh = await session.getTodos(); assert.deepEqual(fresh.phases, before.phases);
    const committed = await session.mutateTodos(`fresh-${refresh}`, { sessionId: session.id, ticket: fresh.ticket,
      mutation: { action: "command", text: `/todo append After ${refresh}` } });
    assert(committed.state.phases.some(phase => phase.name === "After" && phase.tasks.some(task => task.content.toLowerCase() === refresh))); results.freshTodoCommits++;
  }
  if (mode === "direct") {
    // A real file import reserves Todos synchronously before its awaited open/read.
    // Calling Usage in this same turn deterministically observes that reservation.
    await writeFile(path.join(cwd, "import.md"), "# Imported\n- [ ] Held native import\n");
    const state = await session.getTodos();
    const pending = session.mutateTodos("reverse-import", { sessionId: session.id, ticket: state.ticket, mutation: { action: "command", text: "/todo import import.md" } });
    await assert.rejects(session.readUsage("credits"), /busy/i); results.reverseRefused = true;
    await pending; assert((await session.getTodos()).markdown.includes("Held native import"));
    assert((await session.readUsage("credits"))?.credits.length === 1);
  }
  const calls = (await readFile(path.join(directory, "calls"), "utf8")).trim().split("\n");
  assert(calls.every(value => !value.includes("consume"))); results.providerReads = calls.length;
  console.log(JSON.stringify(results));
} finally { await session.dispose(); await runtime.dispose(); }
