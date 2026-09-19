import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { WorkerRuntime } from "./runtime";

async function fixture(mode: string) {
  const root = await mkdtemp(join(tmpdir(), "todos-worker-fault-")), agentDir = join(root, "agent"), cwd = join(root, "project"), effects = join(root, "effects");
  await Promise.all([mkdir(agentDir), mkdir(cwd), writeFile(effects, "")]);
  const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL("./fixtures/session-todos-fault-worker.ts", import.meta.url)),
    startupTimeoutMs: 3000, shutdownTimeoutMs: 3000, environment: { HOME: root, PATH: process.env.PATH, TMPDIR: root, PI_CODING_AGENT_DIR: agentDir, PI_DISABLE_DOTENV: "1", TODOS_FAULT: mode, TODOS_EFFECT_LOG: effects } });
  try {
    const session = await runtime.create({ cwd });
    return { session, effects: () => readFile(effects, "utf8"), close: async () => { try { await runtime.dispose(); } catch { /* a crashed fault worker cannot acknowledge disposal */ } await rm(root, { recursive: true, force: true }); } };
  } catch (error) { await runtime.dispose().catch(() => {}); await rm(root, { recursive: true, force: true }); throw error; }
}

test("post-effect unclassified worker errors, worker loss and foreign receipts remain unknown without replay", async () => {
  for (const mode of ["unclassified", "lost", "foreign-receipt"]) {
    const f = await fixture(mode);
    try {
      const state = await f.session.getTodos();
      await expect(f.session.mutateTodos("edit", { sessionId: "session", ticket: state.ticket, mutation: { action: "command", text: "/todo rm" } })).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      expect(await f.effects()).toBe("effect\n");
    } finally { await f.close(); }
  }
}, 15000);

test("explicit worker refusal and a disposed owner reject without dispatching effects", async () => {
  const f = await fixture("rejected");
  try {
    const state = await f.session.getTodos();
    const request = { sessionId: "session", ticket: state.ticket, mutation: { action: "command" as const, text: "/todo rm" } };
    await expect(f.session.mutateTodos("edit", request)).rejects.toMatchObject({ code: "TODOS_REJECTED" });
    expect(await f.effects()).toBe("");
    await f.session.dispose();
    await expect(f.session.mutateTodos("after-dispose", request)).rejects.toMatchObject({ code: "TODOS_REJECTED" });
    expect(await f.effects()).toBe("");
  } finally { await f.close(); }
});
