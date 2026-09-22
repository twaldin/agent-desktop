import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JOBS_FIXTURE_CHILD_AGENT, JOBS_FIXTURE_MODEL, JOBS_FIXTURE_PROVIDER } from "./fixtures/jobs-controlled";

const CONTROLLED_MODEL = `${JOBS_FIXTURE_PROVIDER}/${JOBS_FIXTURE_MODEL.id}`;

async function run(mode: "direct" | "worker") {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-session-subagents-native-")));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = Bun.spawn([process.execPath, "--no-env-file", fileURLToPath(new URL("./fixtures/subagents-native.ts", import.meta.url)), directory, mode], {
      env: { HOME: directory, PATH: process.env.PATH, TMPDIR: directory, TERM: "dumb", NO_COLOR: "1", PI_DISABLE_DOTENV: "1", PI_CODEX_WEBSOCKET: "0",
        PI_CODING_AGENT_DIR: path.join(directory, "agent") }, stdout: "pipe", stderr: "pipe",
    });
    // Real clock on purpose: it bounds a separate native child process, which fake timers cannot drive.
    deadline = setTimeout(() => child.kill(), 110_000);
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const last = stdout.trim().split("\n").at(-1);
    const parsed = (() => { try { return code === 0 && last ? JSON.parse(last) as Record<string, unknown> : undefined; } catch { return undefined; } })();
    if (process.env.SUBAGENTS_EVIDENCE_DIR) {
      const evidence = path.join(process.env.SUBAGENTS_EVIDENCE_DIR, `${mode}-${path.basename(directory)}`);
      await mkdir(evidence, { recursive: true });
      // Journal paths and lifecycle/owner facts come verbatim from the fixture's result; the raw streams are kept beside them.
      const facts = parsed && { identity: parsed.identity, live: parsed.live, idle: parsed.idle, parked: parsed.parked, replacement: parsed.replacement, revived: parsed.revived,
        aborted: parsed.aborted, foreign: parsed.foreign, independent: parsed.independent, ownerLoss: parsed.ownerLoss, cold: parsed.cold, metadata: parsed.metadata };
      await Promise.all([
        writeFile(path.join(evidence, "stdout.raw"), stdout),
        writeFile(path.join(evidence, "stderr.raw"), stderr),
        writeFile(path.join(evidence, "facts.json"), JSON.stringify(facts ?? { parsed: false }, null, 2)),
        writeFile(path.join(evidence, "receipt.json"), JSON.stringify({ code, directory, mode, fixture: "subagents-native", disposableHome: true }, null, 2)),
      ]);
    }
    if (code !== 0 || !parsed) throw new Error(`Native subagents ${mode} fixture failed (${code}):\n${stdout}\n${stderr}`);
    expect(parsed.blocked).toEqual([]);
    return parsed as Record<string, any>;
  } finally { clearTimeout(deadline); await rm(directory, { recursive: true, force: true }); }
}

test("original-root adapter over real task children: live/idle/parked/revived/aborted reads, journal replacement, foreign root isolation, owner loss and cold reopen", async () => {
  const result = await run("direct");
  expect(result.identity).toMatchObject({ ownerMatches: true, initiallyEmpty: true, initialActivity: { availability: "available", value: [] } });
  expect(result.identity.artifactsDir).toBe(result.identity.sessionFile.slice(0, -".jsonl".length));

  expect(result.live).toMatchObject({ row: { id: "child-a", status: "running", running: true }, sessionIdMatchesChildManager: true, sessionIdDiffersFromRoot: true,
    journalBelowRoot: true, parentId: "Main", childModel: { provider: JOBS_FIXTURE_PROVIDER, id: JOBS_FIXTURE_MODEL.id }, childAgentId: "child-a",
    transcript: { availability: "available", hasTask: true, truncated: false }, cwdIsProject: true, validate: "accepted",
    staleOwner: "STALE_OWNER", staleOwnerTranscript: "STALE_OWNER", fabricatedGuard: "STALE_CHILD", fabricatedSessionId: "STALE_CHILD", rejectedAction: "SUBAGENTS_REJECTED" });
  expect(result.live.activity).toEqual([{ id: "child-a", status: "running", running: true, parentId: "Main" }]);
  expect(result.files).toEqual({ notes: { text: "controlled child notes\n", truncated: false, path: "notes.txt" }, large: { chars: 256 * 1024, truncated: true },
    parentEscape: "SUBAGENTS_REJECTED", absolute: "SUBAGENTS_REJECTED", symlinkEscape: "SUBAGENTS_REJECTED", directory: "SUBAGENTS_REJECTED", missing: "ENOENT" });
  expect(result.readsAreInert).toEqual({ stillStreaming: true, stillHeld: true, transcriptsIdentical: true });

  expect(result.idle).toMatchObject({ row: { id: "child-a", status: "idle", running: false }, sameGuardAsRunning: true, sameSessionId: true, transcript: { availability: "available", hasTask: true, truncated: false } });
  expect(result.idle.transcript.roles).toContain("assistant");
  expect(result.idle.transcript.nativeIds).toBeGreaterThan(0);

  expect(result.parked).toMatchObject({ sameRef: true, refStatus: "parked", sessionNull: true, row: { id: "child-a", status: "parked", running: false },
    staleLiveTarget: "STALE_CHILD", staleLiveValidate: "STALE_CHILD", guardChanged: true, sameSessionId: true,
    transcript: { availability: "available", hasTask: true, truncated: false }, cwdFromHeader: true, validate: "accepted", file: "controlled child notes\n",
    stillParkedAfterReads: "parked", stillDetached: true, activity: [{ id: "child-a", status: "parked", running: false }] });
  expect(result.parked.transcript.roles).toContain("assistant");
  expect(result.parked.transcript.nativeIds).toBeGreaterThan(0);
  // Model metadata is read from the child journal's session_init, never inferred from the agent name.
  expect(result.parked.journal).toMatchObject({ path: result.live.childSessionFile, headerId: result.parked.row.sessionId, headerCwd: result.parked.transcript.cwd, agent: JOBS_FIXTURE_CHILD_AGENT, resolvedModel: CONTROLLED_MODEL });
  expect(result.images.childSessionId).not.toBe(result.images.rootSessionId);
  expect(result.images.parked).toEqual(result.images.live);
  expect(result.images).toMatchObject({ staleLiveTarget: "STALE_CHILD", stillDetached: true, live: { mimeType: "image/png", bytes: 68 } });

  expect(result.replacement).toEqual({ replaced: "STALE_CHILD", missing: { availability: "missing", messages: 0, reasonNamesJournal: true }, escaped: "STALE_CHILD", restored: "available" });

  expect(result.revived).toMatchObject({ differentSessionObject: true, sameRef: true, staleParkedTarget: "STALE_CHILD", row: { id: "child-a", status: "idle", running: false }, guardChanged: true, sameSessionId: true,
    transcript: { availability: "available", hasTask: true } });

  expect(result.aborted).toMatchObject({ row: { id: "child-a", status: "aborted", running: false }, refStatus: "aborted", sessionNull: true, tombstone: true, staleRevivedTarget: "STALE_CHILD",
    transcript: { availability: "available", hasTask: true } });

  expect(result.foreign).toMatchObject({ registeredLive: true, belowSecondaryRoot: true, hiddenFromPrimary: true, primaryOmitted: 0, primaryRows: 0, hiddenFromPrimaryActivity: true,
    visibleToSecondary: { id: "child-a", status: "idle", running: false }, secondaryTranscript: "available",
    staleAbortedTarget: "STALE_CHILD", crossRootTarget: "STALE_CHILD", crossRootValidate: "STALE_CHILD", crossRootFile: "STALE_CHILD", primaryJournalStillOnDisk: true });
  expect(result.foreign.foreignJournal).not.toBe(result.live.childSessionFile);

  expect(result.ownerLoss).toEqual({ retired: "STALE_OWNER", disposed: "STALE_OWNER", sessionDisposed: true, activityAfterLoss: "available" });
  expect(result.cold).toMatchObject({ reopenedSameNativeId: true, availability: "available", journalOnDisk: true });
  // Only refs the native registry still holds are listed; nothing is scanned or imported by the adapter.
  expect(result.cold.rows.length).toBe(result.cold.registryHasChild ? 1 : 0);
  expect(result.cold.omitted).toBe(0);
}, 120_000);

test("production worker RPC over the original captured native session: real task child roster, live and idle transcript, owner-bound file, independent worker and owner loss", async () => {
  const result = await run("worker");
  expect(result.identity).toMatchObject({ ownerMatches: true, initiallyEmpty: true });
  expect(result.identity.capturedSessionId).toBe(result.identity.sessionId);
  expect(result.identity.capturedPid).toBe(result.identity.workerPid);
  expect(result.identity.capturedFile).toBe(result.identity.sessionFile);
  expect(result.live).toMatchObject({ row: { id: "w-a", status: "running", running: true }, ownerId: "Main", journalOnDisk: true,
    transcript: { availability: "available", hasTask: true, truncated: false }, cwdIsProject: true, validate: "accepted",
    file: { action: "file", path: "notes.txt", text: "controlled child notes\n", truncated: false },
    staleOwner: "STALE_OWNER", fabricatedGuard: "STALE_CHILD" });
  expect(result.live.parentEscape).not.toBe("accepted");
  expect(result.live.childJournal).toBe(`${result.identity.sessionFile.slice(0, -".jsonl".length)}/w-a.jsonl`);
  expect(result.live.childSessions).toContainEqual(expect.objectContaining({ id: "w-a", agentId: "w-a" }));
  // The root finding: the actual task child must be present in the owning activity roster.
  expect(result.live.activityAgents).toContainEqual({ id: "w-a", status: "running", running: true, parentId: "Main" });
  expect(result.idle).toMatchObject({ row: { id: "w-a", status: "idle", running: false }, sameGuard: true, transcript: { availability: "available", hasTask: true } });
  expect(result.idle.journal).toMatchObject({ path: result.live.childJournal, headerId: result.idle.row.sessionId });
  expect(result.idle.activityAgents).toEqual({ availability: "available", value: [expect.objectContaining({ id: "w-a", status: "idle", running: false })] });
  expect(result.independent).toEqual({ availability: "available", rows: 0, omitted: 0, ownerDiffers: true, crossWorkerTarget: "STALE_CHILD" });
  expect(result.ownerLoss.disposedList).not.toMatch(/^accepted$/);
  expect(result.ownerLoss.journalOnDisk).toBe(true);
  expect(result.cleanupFailures).toEqual([]);
}, 120_000);
