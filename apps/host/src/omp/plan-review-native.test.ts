import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function run(scenario: string) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-plan-review-native-")));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/plan-review-native.ts", import.meta.url)), directory, scenario], {
      env: { HOME: directory, PATH: process.env.PATH, TMPDIR: tmpdir(), TERM: "dumb", PI_DISABLE_DOTENV: "1",
        PI_CODING_AGENT_DIR: path.join(directory, "agent") }, stdout: "pipe", stderr: "pipe",
    });
    deadline = setTimeout(() => child.kill(), 30_000);
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Native Plan review ${scenario} fixture failed (${code}):\n${stdout}\n${stderr}`);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(result.blockedFetches).toBe(0); expect(result.configUnchanged).toBe(true); return result;
  } finally { clearTimeout(deadline); await rm(directory, { recursive: true, force: true }); }
}

test("native proposal event, revisioned edit/refine lifecycle, and legacy native references", async () => {
  const { review } = await run("review");
  expect(review.editedRevision).not.toBe(review.firstRevision);
  expect(review.recoveredRevision).not.toBe(review.editedRevision);
  expect(review.externalBytesPreserved).toBe(true);
  expect(review.legacyRelative).toBe("legacy-relative-plan.md");
  expect(review.legacyAbsolute).toEndWith("legacy-absolute-plan.md");
}, 35_000);

test("native keep, fresh phase handoff, rebound execution preparation, and save/new-session", async () => {
  const { decisions } = await run("keep-fresh-save");
  expect(decisions).toEqual({ keep: "execution", fresh: "fresh", phaseB: "fresh", save: "new-session", freshIdentityChanged: true });
}, 35_000);

test.each(["compact-ok", "compact-cancel", "compact-failed"])("native %s preserves its distinct decision outcome", async scenario => {
  const { compact } = await run(scenario);
  expect(compact.outcome).toBe(scenario === "compact-cancel" ? "cancelled" : scenario.replace("compact-", ""));
  expect(compact.mode).toBe("off"); expect(compact.review).toBeNull();
  if (scenario === "compact-failed") {
    expect(compact.message).toContain("controlled compaction failure before provider transport");
    expect(compact.modelId).toBe("planner"); expect(compact.restoredFailure).toBe(true);
  } else if (scenario === "compact-cancel") expect(compact.modelId).toBe("base");
}, 35_000);

test("native fresh and save cancellation create no replacement or execution", async () => {
  const { cancel } = await run("new-session-cancel");
  expect(cancel).toEqual({ fresh: "cancelled", freshMode: "off", freshReview: null,
    save: "cancelled", saveMode: "off", saveReview: null, sameIdentity: true });
}, 35_000);

test("an uncertain owner-host save write is latched for reconciliation", async () => {
  const { saveFailure } = await run("save-write-failed");
  expect(saveFailure).toEqual({ transition: "unknown", reconciliationRequired: true });
}, 35_000);
