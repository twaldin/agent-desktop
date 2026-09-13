import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function run(scenario: string) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-plan-native-")));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/plan-native.ts", import.meta.url)), directory, scenario], {
      env: { HOME: directory, PATH: process.env.PATH, TMPDIR: tmpdir(), TERM: "dumb", PI_DISABLE_DOTENV: "1",
        PI_CODING_AGENT_DIR: path.join(directory, "agent") }, stdout: "pipe", stderr: "pipe",
    });
    deadline = setTimeout(() => child.kill(), 25_000);
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Native plan ${scenario} fixture failed (${code}):\n${stdout}\n${stderr}`);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(result.blockedFetches).toBe(0); expect(result.configUnchanged).toBe(true);
    return result;
  } finally { clearTimeout(deadline); await rm(directory, { recursive: true, force: true }); }
}

test("native plan entry, local write/propose, latest review, paused/off toggle, and tool/model/queue preservation", async () => {
  const { lifecycle } = await run("lifecycle");
  expect(lifecycle.entered.mode).toBe("active"); expect(lifecycle.paused.mode).toBe("paused");
  expect(lifecycle.review.planFilePath).toBe("local://newer-plan.md");
  expect(lifecycle.proposal.tool).toBe("propose"); expect(lifecycle.confirmations).toBe(3);
  expect(lifecycle.modes).toEqual(["plan", "plan_paused", "plan", "plan_paused", "none"]);
}, 30_000);

test("actual native journal reopen restores explicitly and preserves the journal model despite a changed plan role", async () => {
  const { restore } = await run("restore");
  expect(restore.before.restorationRequired).toBe(true);
  expect(restore.after.restoration).toBe("journal-model-preserved"); expect(restore.after.model.id).toBe("planner");
  expect(restore.after.nativeSessionId).toBe(restore.before.nativeSessionId);
}, 30_000);

test("native settings/mode conflicts, real extension winner, local artifact and proposal lifetime guards", async () => {
  const { guards } = await run("guards");
  expect(guards).toEqual({ customCalls: 0, disabled: true, goalAndVibe: true, shadowAndAlias: true, localArtifact: true, unrelatedHandler: true });
}, 30_000);

test("retired owner after actual native tool activation cannot continue into model, handler or journal mutation", async () => {
  const { owner } = await run("owner");
  expect(owner).toEqual({ outcome: "unknown", model: "base", journalUnchanged: true, stateNeedsReconciliation: true });
}, 30_000);

test("unavailable plan role preserves explicit model changes and same-model thinking does not reset the native model", async () => {
  const { models } = await run("models");
  expect(models.unavailableWarning).toContain("no available model");
  expect(models.explicitSelectionPreserved).toBe(true); expect(models.sameModelResets).toBe(0);
}, 30_000);

test("a foreign proposal lifetime acquired during native activation is preserved without rollback into that lifetime", async () => {
  const { handler } = await run("handler");
  expect(handler).toEqual({ outcome: "unknown", model: "base", journalUnchanged: true, stateNeedsReconciliation: true });
}, 30_000);
