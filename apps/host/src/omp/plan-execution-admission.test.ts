import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("native Plan approval/refinement admission preserves exact message attribution, queued drain, abort, and disposal", async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-plan-execution-admission-")));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = Bun.spawn([process.execPath,
      fileURLToPath(new URL("./fixtures/plan-execution-admission-native.ts", import.meta.url)), directory], {
      env: { HOME: directory, PATH: process.env.PATH, TMPDIR: tmpdir(), TERM: "dumb", PI_DISABLE_DOTENV: "1",
        PI_CODING_AGENT_DIR: path.join(directory, "agent") }, stdout: "pipe", stderr: "pipe",
    });
    deadline = setTimeout(() => child.kill(), 30_000);
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Native Plan execution admission fixture failed (${code}):\n${stdout}\n${stderr}`);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(result).toEqual({ requestCount: 8, approval: "developer", refinement: "user", queued: "developer",
      removed: "not-entered", fastProposalSerialized: true, interrupted: "developer", localCommand: "native-plan-command",
      effectFailure: "rejected", staleFlush: "rejected", configUnchanged: true,
      unknownErrorCode: "OUTCOME_UNKNOWN" });
  } finally { clearTimeout(deadline); await rm(directory, { recursive: true, force: true }); }
}, 35_000);
