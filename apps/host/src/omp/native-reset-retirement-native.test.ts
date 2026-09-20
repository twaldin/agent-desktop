import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Actual-native acceptance for exact-session child owner retirement. Each
 * scenario runs the public `NativeResetRuntimeOwners` factory against real
 * pinned SDK sessions in a disposable subprocess: a TaskExecutor child that is
 * lifecycle-parked and executor-revived, a persisted cold revive, and two vibe
 * worker siblings. Child owners are the real `NativeResetChannelOwner` over a
 * real `ResetPolicyChannel`/`ResetPolicyHostChannel` pair with controlled host
 * replies; pass evidence contexts are controlled because the fixture model is a
 * local non-Codex provider. Capacity is saturated with controlled exact-binding
 * peers (labelled `peer`, not native sessions) while one real child drains.
 * The fixture's last stdout line is its raw evidence JSON.
 */
interface Hold { capacity?: string; drained: boolean; retired: number; disposed: boolean }
interface HeldRetirement {
  usageHeldAt: number; finishedHeldAt: number; duringUsageHold: Hold; duringFinishedHold: Hold;
  afterRetirement: { capacity?: string; drained: boolean; retired: number };
  policy: { state: string }; lateCall: string; lateReachedHost: boolean; lateCaptured: boolean;
}
interface OwnerEvidence { index: number; kind: "root" | "child" | "peer"; agentId: string | null; sessionId: string; sameObjectAsEarlier: boolean; sameIdAsEarlier: boolean; lifecycle: { seq: number; phase: string }[]; retired: number; captures: number }
interface HostEntry { seq: number; nativeSessionId: string; passId: string; kind: string; phase?: string }

async function run(scenario: string, timeoutMs = 60_000): Promise<Record<string, any>> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-reset-retirement-native-")));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = Bun.spawn([process.execPath, "--no-env-file", fileURLToPath(new URL("../omp-workers/fixtures/retirement-native.ts", import.meta.url)), directory, scenario], {
      cwd: directory, stdout: "pipe", stderr: "pipe",
      env: { HOME: directory, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: directory, TERM: "dumb", NO_COLOR: "1", PI_DISABLE_DOTENV: "1", PI_NO_TITLE: "1",
        PI_TELEMETRY_DISABLED: "1", PI_CODING_AGENT_DIR: path.join(directory, "agent"), XDG_CONFIG_HOME: path.join(directory, "xdg-config"),
        XDG_DATA_HOME: path.join(directory, "xdg-data"), XDG_CACHE_HOME: path.join(directory, "xdg-cache"), XDG_STATE_HOME: path.join(directory, "xdg-state") },
    });
    // Subprocess watchdog only: every awaited condition inside the fixture is an event, never elapsed time.
    deadline = setTimeout(() => child.kill(), timeoutMs);
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Native retirement ${scenario} fixture failed (${code}):\n${stdout}\n${stderr}`);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    // Safety boundary in every scenario: no process-global network, no host transport failure.
    expect(result.blockedFetches).toBe(0); expect(result.hostErrors).toEqual([]);
    return result;
  } finally { clearTimeout(deadline); await rm(directory, { recursive: true, force: true }); }
}

const nativeOwners = (result: Record<string, any>): OwnerEvidence[] => (result.owners as OwnerEvidence[]).filter(owner => owner.kind !== "peer");
const phaseSeq = (owner: OwnerEvidence, phase: string) => owner.lifecycle.find(entry => entry.phase === phase)?.seq ?? Number.NaN;

/** A real owned provider read, then the awaited finished checkpoint, each held across the exact beginClose without drain or retirement. */
function expectHeldAcrossNativeDrain(held: HeldRetirement, owner: OwnerEvidence, host: HostEntry[]) {
  const beginClose = phaseSeq(owner, "beginClose"), drained = phaseSeq(owner, "drained"), retired = phaseSeq(owner, "retired");
  expect(held.usageHeldAt).toBeLessThan(beginClose);
  expect(held.duringUsageHold).toMatchObject({ drained: false, retired: 0, disposed: true });
  expect(beginClose).toBeLessThan(held.finishedHeldAt);
  expect(held.duringFinishedHold).toMatchObject({ drained: false, retired: 0, disposed: true });
  // The finished checkpoint is a wrapper call accepted after close and before the native drain.
  const finished = host.filter(entry => entry.nativeSessionId === owner.sessionId && entry.phase === "finished").map(entry => entry.seq);
  expect(finished.some(seq => seq > beginClose && seq < drained)).toBe(true);
  expect(drained).toBeLessThan(retired);
  expect(held.afterRetirement).toMatchObject({ drained: true, retired: 1 });
  expect(owner.retired).toBe(1);
  // Late calls after the native drain never reach the owner, the capture or the host.
  expect(held.lateCall).not.toBe("resolved"); expect(held.lateReachedHost).toBe(false); expect(held.lateCaptured).toBe(false);
}

function expectRootPinned(result: Record<string, any>) {
  const [root, ...children] = nativeOwners(result);
  expect(root!.kind).toBe("root"); expect(root!.index).toBe(1);
  expect(result.root.retiredBeforeFinish).toBe(0); expect(result.root.retiredAfterFinish).toBe(1);
  const rootRetired = phaseSeq(root!, "retired");
  expect(phaseSeq(root!, "beginClose")).toBeLessThan(phaseSeq(root!, "drained")); expect(phaseSeq(root!, "drained")).toBeLessThan(rootRetired);
  for (const child of children) { expect(child.kind).toBe("child"); expect(phaseSeq(child, "retired")).toBeLessThan(phaseSeq(root!, "beginClose")); }
  expect(result.root.lifecycle.map((entry: { phase: string }) => entry.phase)).toEqual(["beginClose", "drained", "retired"]);
}

test("actual task child: held native drain keeps its slot at MAX capacity, executor revive rebinds the same session id as a new object, cold revive retires, root stays pinned", async () => {
  const result = await run("task-revive");
  const { task } = result; const owners = nativeOwners(result); const host = result.hostJournal as HostEntry[];
  expect(owners.map(owner => owner.agentId)).toEqual(["Main", "retire-task", "retire-task", "cold-child"]);
  const [, child, revived, cold] = owners;
  // Capacity: root + one live child + 126 controlled peers; the held child keeps its slot until native drained.
  expect(task.peersAccepted).toBe(126); expect(task.saturationRefusal).toBe("refused");
  expect(task.child.duringUsageHold.capacity).toBe("refused"); expect(task.child.duringFinishedHold.capacity).toBe("refused");
  expect(task.child.afterRetirement.capacity).toBe("accepted"); expect(task.secondReclaim).toBe("refused");
  expect(task.parked).toEqual({ status: "parked", sessionNull: true });
  expectHeldAcrossNativeDrain(task.child, child!, host);
  // Executor revive: same transcript session id, different exact object, independent owner.
  expect(task.revivedSessionId).toBe(task.childSessionId);
  expect(task.revivedBinding).toMatchObject({ sameObjectAsEarlier: false, sameIdAsEarlier: true });
  expect(revived!.index).not.toBe(child!.index); expect(revived!.sessionId).toBe(child!.sessionId);
  expectHeldAcrossNativeDrain(task.revived, revived!, host);
  // Persisted cold revive through the root-scoped reviver factory.
  expect(cold!.sessionId).toBe(task.coldSessionId); expect(cold!.sessionId).not.toBe(child!.sessionId);
  expectHeldAcrossNativeDrain(task.cold, cold!, host);
  expect(task.childPasses).toEqual(["checkpoint:started", "checkpoint:finished", "checkpoint:started", "checkpoint:finished"]);
  expect(task.coldPasses).toEqual(["checkpoint:started", "checkpoint:finished"]);
  // Root still owns a pass on the shared channel after every child retired; whole-owner finish is clean.
  expect(task.rootPasses).toEqual(["checkpoint:started", "checkpoint:finished"]); expect(task.rootAfter.state).toBe("held");
  expect(host.filter(entry => entry.nativeSessionId === owners[0]!.sessionId).every(entry => entry.seq > phaseSeq(cold!, "retired"))).toBe(true);
  expect(result.finish).toEqual({ ok: true });
  expectRootPinned(result);
}, 90_000);

test("actual vibe workers: a killed sibling retires alone while the live sibling and root keep the shared channel", async () => {
  const result = await run("vibe-siblings");
  const { vibe } = result; const owners = nativeOwners(result); const host = result.hostJournal as HostEntry[];
  expect(owners.map(owner => owner.agentId)).toEqual(["Main", "vibe-a", "vibe-b"]);
  const [, a, b] = owners;
  expectHeldAcrossNativeDrain(vibe.a, a!, host);
  expect(vibe.siblingStateBeforePass).toEqual({ retired: 0, drained: false, disposed: false });
  expect(vibe.siblingPassSeqs.length).toBe(4); expect(vibe.siblingPassSeqs.every((seq: number) => seq > vibe.aRetiredSeq)).toBe(true);
  expect(vibe.rootPassSeqs.length).toBe(2); expect(vibe.rootPassSeqs.every((seq: number) => seq > vibe.aRetiredSeq)).toBe(true);
  expect(vibe.siblingAfter.state).toBe("held"); expect(vibe.rootAfter.state).toBe("held");
  expectHeldAcrossNativeDrain(vibe.b, b!, host);
  expect(vibe.aPasses).toEqual(["checkpoint:started", "checkpoint:finished"]);
  expect(vibe.bPasses).toEqual(["checkpoint:started", "checkpoint:finished", "checkpoint:started", "checkpoint:finished"]);
  expect(result.finish).toEqual({ ok: true });
  expectRootPinned(result);
}, 90_000);

test("actual task child: a failing local cleanup still retires once, frees the slot and is retained by the group finish", async () => {
  const result = await run("retained-error");
  const { retained } = result; const owners = nativeOwners(result); const host = result.hostJournal as HostEntry[];
  expect(owners.map(owner => owner.agentId)).toEqual(["Main", "retire-failing"]);
  expect(retained.peersAccepted).toBe(126);
  expect(retained.child.duringUsageHold.capacity).toBe("refused"); expect(retained.child.afterRetirement.capacity).toBe("accepted");
  expectHeldAcrossNativeDrain(retained.child, owners[1]!, host);
  expect(retained.child.policy.state).toBe("failed"); expect(retained.disposals).toBe(1);
  expect(retained.rootAfter.state).toBe("held");
  expect(result.finish.ok).toBe(false);
  expect(result.finish.messages).toContain("controlled retirement cleanup failure");
  expectRootPinned(result);
}, 90_000);
