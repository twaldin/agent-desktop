import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Controlled actual-native acceptance for the U2 Codex reset-policy owner hook
 * (proposal003 N1–N5, N7–N9). Each scenario runs the pinned AgentSession, planner,
 * Settings and U1-patched AuthStorage in a disposable subprocess with a deterministic
 * injected Codex transport; the fixture's last stdout line is its raw evidence JSON.
 * Not covered here by design: cross-worker shared host admission (N6/N10, later host
 * scope), the host heartbeat cadence, and restart-retained decisions (host ledger).
 */
interface Settlement { state: "settled" | "held" | "cancelled" | "failed"; applied: number; attemptIds: string[]; refresh: "not-needed" | "complete" | "failed" }
const UNOWNED: Settlement = { state: "settled", applied: 0, attemptIds: [], refresh: "not-needed" };
async function run(scenario: string, timeoutMs = 45_000): Promise<Record<string, any>> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-reset-policy-native-")));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = Bun.spawn([process.execPath, "--no-env-file", fileURLToPath(new URL("./fixtures/native-reset-policy.ts", import.meta.url)), directory, scenario], {
      cwd: directory, stdout: "pipe", stderr: "pipe",
      env: { HOME: directory, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: directory, TERM: "dumb", NO_COLOR: "1", PI_DISABLE_DOTENV: "1", PI_NO_TITLE: "1",
        PI_TELEMETRY_DISABLED: "1", PI_CODING_AGENT_DIR: path.join(directory, "agent"), XDG_CONFIG_HOME: path.join(directory, "xdg-config"),
        XDG_DATA_HOME: path.join(directory, "xdg-data"), XDG_CACHE_HOME: path.join(directory, "xdg-cache"), XDG_STATE_HOME: path.join(directory, "xdg-state") },
    });
    deadline = setTimeout(() => child.kill(), timeoutMs);
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Native reset-policy ${scenario} fixture failed (${code}):\n${stdout}\n${stderr}`);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    // Safety boundary: no process-global network and no unowned provider route, in every scenario.
    expect(result.blockedFetches).toBe(0); expect(result.escapedTransport).toBe(0);
    return result;
  } finally { clearTimeout(deadline); await rm(directory, { recursive: true, force: true }); }
}
const finished = (result: { finished: { settlement: Settlement }[] }): Settlement[] => result.finished.map(entry => entry.settlement);
const phases = (journal: { phase: string }[]) => journal.map(entry => entry.phase);

// --- N1 default parity -------------------------------------------------------
test("N1 owner absent: sweep salvages exactly the pure planner's actions with native request ids, no prompt, floor-gated re-sweep", async () => {
  const { sweep, configUnchanged } = await run("owner-absent-sweep");
  expect(sweep.expectedActions).toEqual([{ reason: "expiring-credit", accountKey: "acct-a", attemptKey: expect.stringMatching(/^salvage\|acct-a\|\d+$/) }]);
  expect(sweep.expectedSkipped).toEqual(expect.arrayContaining([
    { accountKey: "acct-b", rule: "expiring-credit", reason: "no-expiring-credit" }, { accountKey: "acct-c", rule: "expiring-credit", reason: "window-mostly-free" }]));
  expect(sweep.consumes.map((request: { account: string }) => request.account)).toEqual(["a"]);
  expect(sweep.consumes[0].creditId).toBe("credit-a-1");
  expect(sweep.nativeRequestIdsAreUuids).toBe(true);
  expect(sweep.attemptedKeys).toEqual(sweep.expectedActions.map((action: { attemptKey: string }) => action.attemptKey));
  expect(sweep.secondSweepConsumed).toBe(0);
  expect(sweep.interactions).toBe(0);
  expect(sweep.joiningRejected).toBeString();
  expect(configUnchanged).toBe(true);
}, 60_000);

test("N1 owner absent: a blocked turn restores through the native retry pipeline and retries at once", async () => {
  const { blocked, configUnchanged } = await run("owner-absent-blocked");
  expect(blocked.streamCalls).toEqual(["usage-limit", "ok"]);
  expect(blocked.consumes).toEqual([{ account: "a", accountId: "acct-a", creditId: "credit-a-1", redeemRequestId: expect.any(String) }]);
  expect(blocked.nativeRequestIdsAreUuids).toBe(true);
  expect(blocked.retries[0]).toMatchObject({ type: "auto_retry_start", attempt: 1, delayMs: 0 });
  expect(blocked.interactions).toBe(0);
  expect(blocked.joiningRejected).toBeString();
  expect(configUnchanged).toBe(true);
}, 60_000);

test("N1 `no`: no reset-policy owner pass or spend; the blocked turn fails fast", async () => {
  const { no, configUnchanged } = await run("policy-no-blocked");
  expect(no.streamCalls).toEqual(["usage-limit"]);
  expect(no.consumes).toBe(0);
  expect(no.ownerJournal).toEqual([]);
  expect(no.retries.at(-1)).toMatchObject({ type: "auto_retry_end", success: false });
  expect(no.policy).toEqual(UNOWNED);
  expect(configUnchanged).toBe(true);
}, 60_000);

// --- N2 full pool policy ---------------------------------------------------------
test("N2 blocked pass: one native-ranked restore then eligible salvages, identical to the pure planner, exact clock and exact permits", async () => {
  const { pool } = await run("pool-blocked-restore-salvage");
  expect(pool.owner.plannerParity).toEqual([{ passId: expect.any(String), equal: true }]);
  expect(pool.planned.actions.map((action: { reason: string; accountKey: string; blockedWindows?: string[]; active: boolean }) =>
    [action.reason, action.accountKey, action.blockedWindows, action.active])).toEqual([["blocked-account", "acct-a", ["5h"], true], ["expiring-credit", "acct-b", undefined, false]]);
  expect(pool.planned.skipped).toContainEqual({ accountKey: "acct-c", rule: "expiring-credit", reason: "no-expiring-credit" });
  expect(pool.planned.plannedAtMs + pool.planned.actions[0].remainingMs).toBe(pool.expected.primaryResetAtMs);
  expect(pool.planned.plannedAtMs + pool.planned.actions[1].expiresInMs).toBe(pool.expected.creditBExpiresAtMs);
  expect(pool.consumes).toEqual([
    { account: "a", accountId: "acct-a", creditId: "credit-a-1", redeemRequestId: pool.owner.admissions[0].admission.redeemRequestId },
    { account: "b", accountId: "acct-b", creditId: "credit-b-1", redeemRequestId: pool.owner.admissions[1].admission.redeemRequestId }]);
  expect(pool.owner.guardCalls.map((call: { allowed: boolean; identity: { credentialId: number; creditId: string } }) => [call.allowed, call.identity.creditId]))
    .toEqual([[true, "credit-a-1"], [true, "credit-b-1"]]);
  expect(pool.owner.completions.map((entry: { consumeBoundary: string; result: { code: string } }) => [entry.consumeBoundary, entry.result.code]))
    .toEqual([["passed", "reset"], ["passed", "reset"]]);
  expect(finished(pool)[0]).toEqual({ state: "settled", applied: 2, attemptIds: pool.owner.admissions.map((entry: { admission: { attemptId: string } }) => entry.admission.attemptId), refresh: "complete" });
  expect(pool.streamCalls).toEqual(["usage-limit", "ok"]);
  expect(pool.config.codexResets.autoRedeem).toBe("yes");
}, 60_000);

test("N2 reserve: the blocked restore respects keepCredits while salvage ignores it", async () => {
  const { pool } = await run("pool-reserve");
  expect(pool.owner.plannerParity[0].equal).toBe(true);
  expect(pool.planned.actions.map((action: { reason: string; accountKey: string }) => [action.reason, action.accountKey])).toEqual([["expiring-credit", "acct-b"]]);
  expect(pool.planned.skipped).toContainEqual({ accountKey: "acct-a", rule: "blocked-account", reason: "reserve" });
  expect(pool.consumes.map((request: { account: string }) => request.account)).toEqual(["b"]);
  expect(pool.streamCalls).toEqual(["usage-limit", "ok"]);
}, 60_000);

test("N2 Spark: the blocked-account rule is off for a Spark model; the expiring credit is still salvaged and the cleared block lets the turn retry", async () => {
  const { pool } = await run("pool-spark");
  expect(pool.owner.plannerParity[0].equal).toBe(true);
  expect(pool.planned.skipped).toContainEqual({ accountKey: "*", rule: "blocked-account", reason: "spark-model" });
  expect(pool.planned.actions.map((action: { reason: string; accountKey: string }) => [action.reason, action.accountKey])).toEqual([["expiring-credit", "acct-a"]]);
  expect(pool.consumes.map((request: { account: string }) => request.account)).toEqual(["a"]);
  expect(pool.streamCalls).toEqual(["usage-limit", "ok"]);
}, 60_000);

test("N2 another provider: the sweep still salvages every eligible Codex account in expiry order", async () => {
  const { otherProvider } = await run("pool-other-provider-sweep");
  expect(otherProvider.owner.plannerParity[0].equal).toBe(true);
  expect(otherProvider.planned.actions.map((action: { reason: string; accountKey: string }) => [action.reason, action.accountKey]))
    .toEqual([["expiring-credit", "acct-b"], ["expiring-credit", "acct-a"]]);
  expect(otherProvider.owner.journal[0].pass).toMatchObject({ trigger: "sweep", source: "manual", provider: "plan-fixture", modelId: "base" });
  expect(otherProvider.consumes.map((request: { account: string }) => request.account)).toEqual(["b", "a"]);
  expect(otherProvider.policy).toMatchObject({ state: "settled", applied: 2, refresh: "complete" });
}, 60_000);

test("N2 live 429 without a usable report: the synthesized candidate keeps an unknown count and the owner binds the credit live", async () => {
  const { synthesized } = await run("pool-synthesized-live429");
  expect(synthesized.owner.plannerParity[0].equal).toBe(true);
  expect(synthesized.planned.actions).toHaveLength(1);
  expect(synthesized.planned.actions[0]).toMatchObject({ reason: "blocked-account", accountKey: "acct-a", active: true });
  expect(synthesized.planned.actions[0].availableCount).toBeUndefined();
  expect(synthesized.consumes).toEqual([{ account: "a", accountId: "acct-a", creditId: "credit-a-1", redeemRequestId: expect.any(String) }]);
  expect(finished(synthesized)[0]).toMatchObject({ state: "settled", applied: 1 });
  expect(synthesized.streamCalls).toEqual(["usage-limit", "ok"]);
}, 60_000);

test("N2 stale zero: the native sweep gate stays closed on a zero usage count even though live credits exist", async () => {
  const { staleZero } = await run("pool-stale-zero-gate");
  expect(staleZero.reportedCount).toBe(0);
  expect(staleZero.creditListings).toBe(0);
  expect(staleZero.sweepScheduled).toBe(false);
  expect(staleZero.ownerJournal).toEqual([]);
  expect(staleZero.consumes).toBe(0);
  expect(staleZero.policy).toEqual(UNOWNED);
}, 60_000);

test("fast-settled owned sweep with nothing to do still journals and aggregates as an empty settlement", async () => {
  const { zero } = await run("sweep-zero-actions");
  expect(phases(zero.ownerJournal)).toEqual(["started", "planned", "finished"]);
  expect(zero.admissions).toBe(0); expect(zero.consumes).toBe(0);
  expect(zero.policy).toEqual(UNOWNED);
}, 60_000);

// --- N3 exact clock and identity ------------------------------------------------
test("N3 late answer: absolute episode times never drift, and a same-email sibling in another org never substitutes", async () => {
  const { clock } = await run("clock-identity");
  expect(clock.owner.plannerParity[0].equal).toBe(true);
  expect(clock.planned.actions.map((action: { accountKey: string; active: boolean }) => [action.accountKey, action.active])).toEqual([["acct-a", true]]);
  expect(clock.planned.plannedAtMs + clock.planned.actions[0].remainingMs).toBe(clock.primaryResetAtMs);
  expect(clock.interactions).toHaveLength(1);
  expect(clock.resolutions).toEqual([{ id: clock.interactions[0].id, reason: "answered" }]);
  expect(clock.owner.guardCalls).toEqual([{ attemptId: expect.any(String), allowed: true,
    identity: expect.objectContaining({ provider: "openai-codex", credentialId: clock.credentialIds.a, accountId: "acct-a", email: "shared@example.com", creditId: "credit-a-1" }) }]);
  expect(clock.consumes).toEqual([{ account: "a", accountId: "acct-a", creditId: "credit-a-1", redeemRequestId: expect.any(String) }]);
  expect(clock.owner.persistence).toEqual([{ mode: "yes", flushed: true, persisted: "yes", project: undefined, effective: "yes", shadowed: false }]);
  expect(clock.config.codexResets.autoRedeem).toBe("yes");
  expect(clock.streamCalls).toEqual(["usage-limit", "ok"]);
}, 60_000);

test("N3 account retarget after capture: the original identity and target stay immutable and admission holds without a POST", async () => {
  const { retarget } = await run("retarget-account-started");
  expect(retarget.pinned).toBe(true);
  expect(retarget.owner.journal[0].pass.identity).toMatchObject({ accountId: "acct-a" });
  expect(retarget.planned.actions[0]).toMatchObject({ reason: "blocked-account", accountKey: "acct-a", target: expect.objectContaining({ accountId: "acct-a" }) });
  expect(retarget.identityAfter).toMatchObject({ accountId: "acct-b" });
  expect(retarget.owner.admissions).toEqual([]);
  expect(retarget.consumes).toEqual([]);
  expect(finished(retarget)[0]).toMatchObject({ state: "held", applied: 0 });
}, 60_000);

test.each(["retarget-model-started", "retarget-model-planned"])("N3 %s: preserve the original plan and hold the changed selection without admission or spend", async scenario => {
  const { retarget } = await run(scenario);
  expect(retarget.modelAfter).toBe("plan-fixture");
  expect(retarget.planned.actions).toHaveLength(1);
  expect(retarget.admissions).toBe(0); expect(retarget.consumes).toBe(0);
  expect(finished(retarget)[0]).toMatchObject({ state: "held", applied: 0 });
}, 60_000);

test("N3 guard refusal: the synchronous U1 guard returning false sends no request and the pass is held", async () => {
  const { guard } = await run("guard-refused");
  expect(guard.owner.guardCalls).toEqual([{ attemptId: expect.any(String), allowed: false, identity: expect.objectContaining({ creditId: "credit-a-1" }) }]);
  expect(guard.consumes).toBe(0);
  expect(guard.owner.completions).toEqual([expect.objectContaining({ consumeBoundary: "refused", result: expect.objectContaining({ kind: "outcome", code: "admission_rejected" }) })]);
  expect(finished(guard)[0]).toMatchObject({ state: "held", applied: 0 });
  expect(guard.attemptedKeys).toEqual([]);
  expect(guard.deferredKeys).toHaveLength(1);
  expect(guard.retries.at(-1)).toMatchObject({ type: "auto_retry_end", success: false });
}, 60_000);

test("N3 policy change between admission and the final guard is refused natively before the owner guard runs", async () => {
  const { guard } = await run("guard-policy-change");
  expect(guard.owner.guardCalls).toEqual([]);
  expect(guard.consumes).toBe(0);
  expect(guard.owner.completions).toEqual([expect.objectContaining({ consumeBoundary: "refused", result: expect.objectContaining({ code: "admission_rejected" }) })]);
  expect(finished(guard)[0]).toMatchObject({ state: "held", applied: 0 });
}, 60_000);

test("N3 credential removed before dispatch: pi-ai returns before the guard and no request is sent", async () => {
  const { guard } = await run("identity-removed");
  expect(guard.owner.guardCalls).toEqual([]);
  expect(guard.consumes).toBe(0);
  expect(guard.owner.completions).toEqual([expect.objectContaining({ consumeBoundary: "not-reached", result: expect.objectContaining({ kind: "outcome", code: "no_account" }) })]);
  expect(finished(guard)).toHaveLength(1);
}, 60_000);

// --- N4 Yes / No / dismiss --------------------------------------------------------
test("N4 Yes: one whole-plan native select with the exact native wording, verified global yes, spends, second client answer rejected", async () => {
  const { decision } = await run("decision-yes");
  expect(decision.interactions).toEqual([{ id: expect.any(String), title: expect.stringMatching(/^Spend 2 saved Codex rate-limit resets\?\n/), options: [
    { label: "Yes", description: "Redeem now and remember yes for future eligible Codex resets." }, { label: "No", description: "Do not auto-redeem saved Codex resets." }] }]);
  expect(decision.secondResponseRejected).toBe("OMP interaction is no longer pending");
  expect(decision.owner.presented).toEqual([{ passId: expect.any(String), actions: 2, answer: "Yes" }]);
  expect(phases(decision.owner.journal).slice(0, 4)).toEqual(["started", "planned", "answer", "setting-written"]);
  expect(decision.owner.journal[2].answer).toBe("Yes");
  expect(decision.owner.persistence).toEqual([{ mode: "yes", flushed: true, persisted: "yes", project: undefined, effective: "yes", shadowed: false }]);
  expect(decision.persistedAutoRedeem).toBe("yes"); expect(decision.effectiveAutoRedeem).toBe("yes");
  expect(decision.configRest).toMatchObject({ extensions: [], defaultThinkingLevel: "low", retry: expect.objectContaining({ maxDelayMs: 5000 }) });
  expect(decision.consumes.map((request: { account: string }) => request.account)).toEqual(["a", "b"]);
  expect(finished(decision)[0]).toMatchObject({ state: "settled", applied: 2 });
  expect(decision.streamCalls).toEqual(["usage-limit", "ok"]);
  expect(decision.secondFetch.consumes).toBe(2);
}, 60_000);

test("N4 No: the select answer is journaled and persisted as `no`; no spend, and later fetches run no owned pass", async () => {
  const { decision } = await run("decision-no");
  expect(decision.owner.presented[0].answer).toBe("No");
  expect(decision.owner.persistence).toEqual([{ mode: "no", flushed: true, persisted: "no", project: undefined, effective: "no", shadowed: false }]);
  expect(decision.persistedAutoRedeem).toBe("no");
  expect(decision.consumes).toEqual([]);
  expect(finished(decision)[0]).toMatchObject({ state: "settled", applied: 0, attemptIds: [] });
  expect(decision.streamCalls).toEqual(["usage-limit"]);
  expect(decision.secondFetch.ownedCheckpoints).toEqual([]);
  expect(decision.secondFetch.policy).toEqual(UNOWNED);
}, 60_000);

test("N4 dismiss: no answer, no write, no spend, pass cancelled", async () => {
  const { decision } = await run("decision-dismiss");
  expect(decision.resolutions[0].reason).toBe("cancelled");
  expect(decision.owner.presented[0].answer).toBeUndefined();
  expect(decision.owner.journal.find((entry: { phase: string }) => entry.phase === "answer").answer).toBeUndefined();
  expect(phases(decision.owner.journal)).not.toContain("setting-written");
  expect(decision.owner.persistence).toEqual([]);
  expect(decision.configUnchanged).toBe(true);
  expect(decision.consumes).toEqual([]);
  expect(finished(decision)[0]).toMatchObject({ state: "cancelled", applied: 0 });
}, 60_000);

test("N4 headless: the one-shot native notice stands in for the prompt; the owner journals no answer and nothing is spent", async () => {
  const { headless } = await run("decision-headless");
  expect(headless.notices.filter((notice: { source?: string }) => notice.source === "codex-auto-reset")).toHaveLength(1);
  expect(headless.owner.presented).toEqual([]);
  expect(phases(headless.owner.journal)).toEqual(["started", "planned", "answer", "finished"]);
  expect(headless.owner.journal[2].answer).toBeUndefined();
  expect(headless.consumes).toBe(0); expect(headless.configUnchanged).toBe(true);
  expect(finished(headless)[0]).toMatchObject({ state: "cancelled", applied: 0 });
}, 60_000);

// --- N5 real settings writes ------------------------------------------------------
test("N5 throwing save: the owner's flush fails, consent is withheld, nothing is spent and the original file is untouched", async () => {
  const { settings } = await run("settings-flush-throws");
  expect(settings.owner.persistence).toEqual([{ mode: "yes", flushed: false, flushError: expect.any(String) }]);
  expect(settings.consumes).toBe(0);
  expect(settings.streamCalls).toEqual(["usage-limit"]);
  expect(settings.persisted.codexResets.autoRedeem).toBe("unset");
  expect(finished(settings)[0]).toMatchObject({ state: "failed", applied: 0 });
}, 60_000);

test("N5 resolved flush with conflicting disk state does not authorize a spend", async () => {
  const { settings } = await run("settings-conflicting-readback");
  expect(settings.owner.persistence).toEqual([{ mode: "yes", flushed: true, persisted: "no", project: undefined, effective: "yes", shadowed: false }]);
  expect(settings.persisted.codexResets.autoRedeem).toBe("no");
  expect(settings.consumes).toBe(0);
  expect(settings.streamCalls).toEqual(["usage-limit"]);
  expect(finished(settings)[0]).toMatchObject({ state: "failed", applied: 0 });
}, 60_000);

test("N5 unrelated external edit merges: the native write keeps the concurrent key and the owner verifies yes", async () => {
  const { settings } = await run("settings-unrelated-key-merge");
  expect(settings.owner.persistence).toEqual([{ mode: "yes", flushed: true, persisted: "yes", project: undefined, effective: "yes", shadowed: false }]);
  expect(settings.persisted.defaultThinkingLevel).toBe("high");
  expect(settings.persisted.codexResets.autoRedeem).toBe("yes");
  expect(settings.consumes).toBe(1);
  expect(finished(settings)[0]).toMatchObject({ state: "settled", applied: 1 });
}, 60_000);

test("N5 project `unset` shadow: the global yes is proven, only this explicit plan is authorized, and the shadow is reported", async () => {
  const { settings } = await run("settings-project-shadow");
  expect(settings.owner.persistence).toEqual([{ mode: "yes", flushed: true, persisted: "yes", project: "unset", effective: "unset", shadowed: true }]);
  expect(settings.persisted.codexResets.autoRedeem).toBe("yes");
  expect(settings.effectiveAutoRedeem).toBe("unset");
  expect(settings.projectConfig).toBe("codexResets:\n  autoRedeem: unset\n");
  expect(settings.consumes).toBe(1);
  expect(finished(settings)[0]).toMatchObject({ state: "settled", applied: 1 });
}, 60_000);

test("N5 runtime policy change under the prompt: no write, no spend, pass held", async () => {
  const { settings } = await run("settings-runtime-change");
  expect(settings.owner.presented[0].answer).toBe("Yes");
  expect(phases(settings.owner.journal)).not.toContain("setting-written");
  expect(settings.owner.persistence).toEqual([]);
  expect(settings.configUnchanged).toBe(true);
  expect(settings.effectiveAutoRedeem).toBe("no");
  expect(settings.consumes).toBe(0);
  expect(finished(settings)[0]).toMatchObject({ state: "held", applied: 0 });
}, 60_000);

// --- N7 unknown and native defer --------------------------------------------------
test.each(["outcome-unknown-fence", "outcome-future-fence"])("N7 %s: unresolved outcomes are held, deferred and fenced without replay", async scenario => {
  const { outcome } = await run(scenario);
  expect(outcome.owner.completions[0]).toMatchObject({ consumeBoundary: "passed", result: { kind: "outcome", code: scenario === "outcome-future-fence" ? "provider_future_code" : "outcome_unknown" } });
  expect(outcome.first).toMatchObject({ state: "held", applied: 0 });
  expect(outcome.deferredAfterFirst).toEqual([{ key: expect.stringMatching(/^salvage\|acct-a\|/), deferredForMs: expect.any(Number) }]);
  expect(outcome.deferredAfterFirst[0].deferredForMs).toBeGreaterThan(29 * 60_000);
  expect(outcome.admissionsWhileDeferred).toBe(1);
  expect(outcome.stillDeferred).toMatchObject({ applied: 0 });
  expect(outcome.owner.admissions.at(-1).admission).toEqual({ kind: "hold", reason: "unknown" });
  expect(outcome.third).toMatchObject({ state: "held", applied: 0 });
  expect(outcome.consumes).toHaveLength(1);
  expect(outcome.owner.fenced).toEqual(["acct-a"]);
}, 60_000);

test("N7 known `nothing_to_reset`: deferred natively, blocked while deferred, and re-entered only by a fresh native plan afterwards", async () => {
  const { outcome } = await run("nothing-to-reset-reenter");
  expect(outcome.owner.completions[0]).toMatchObject({ consumeBoundary: "passed", result: { kind: "outcome", code: "nothing_to_reset" } });
  expect(outcome.deferredAfterFirst[0].deferredForMs).toBeGreaterThan(29 * 60_000);
  expect(outcome.admissionsWhileDeferred).toBe(1);
  expect(outcome.owner.admissions).toHaveLength(2);
  expect(outcome.owner.completions[1]).toMatchObject({ consumeBoundary: "passed", result: { kind: "outcome", code: "reset" } });
  expect(outcome.consumes.map((request: { redeemRequestId: string }) => request.redeemRequestId)).toEqual([outcome.owner.admissions[0].admission.redeemRequestId, outcome.owner.admissions[1].admission.redeemRequestId]);
  expect(outcome.third).toMatchObject({ state: "settled", applied: 1 });
  expect(outcome.owner.fenced).toEqual([]);
}, 60_000);

test.each(["outcome-throw", "outcome-timeout"])("N7 %s: the paired error completion keeps the native defer and fences the account", async scenario => {
  const { outcome } = await run(scenario, 60_000);
  expect(outcome.owner.completions[0]).toMatchObject({ consumeBoundary: "passed", result: { kind: "error", message: expect.stringContaining(scenario === "outcome-throw" ? "controlled consume transport failure" : "Abort") } });
  if (scenario === "outcome-timeout") expect(outcome.elapsedMs).toBeGreaterThanOrEqual(15_000);
  expect(outcome.policy).toMatchObject({ applied: 0 });
  expect(outcome.deferredKeys).toHaveLength(1);
  expect(outcome.owner.admissions.at(-1).admission).toEqual({ kind: "hold", reason: "unknown" });
  expect(outcome.afterFence).toMatchObject({ state: "held", applied: 0 });
  expect(outcome.consumes).toBe(1);
}, 70_000);

// --- N8 completion versus refresh ---------------------------------------------------
test("N8 refresh failure after a reset stays a reset with refresh-failed, and the turn still retries", async () => {
  const { completion } = await run("refresh-failed-retains-reset");
  expect(completion.consumes.map((request: { account: string }) => request.account)).toEqual(["a", "b"]);
  expect(finished(completion)[0]).toEqual({ state: "settled", applied: 2, attemptIds: [expect.any(String), expect.any(String)], refresh: "failed" });
  expect(completion.streamCalls).toEqual(["usage-limit", "ok"]);
}, 60_000);

test("N8 completion failure: the observed reset is retained, further dispatch stops, settlement is failed", async () => {
  const { completion } = await run("complete-throws");
  expect(completion.consumes.map((request: { account: string }) => request.account)).toEqual(["a"]);
  expect(completion.owner.completions[0]).toMatchObject({ result: { code: "reset" } });
  expect(finished(completion)[0]).toMatchObject({ state: "failed", applied: 1 });
  expect(completion.streamCalls).toEqual(["usage-limit", "ok"]);
}, 60_000);

test("N8 pre-dispatch checkpoint rejection stops the pass before any consume", async () => {
  const { completion } = await run("checkpoint-planned-throws");
  expect(phases(completion.owner.journal)).toEqual(["started", "planned", "finished"]);
  expect(completion.owner.admissions).toEqual([]); expect(completion.consumes).toEqual([]);
  expect(finished(completion)[0]).toMatchObject({ state: "failed", applied: 0 });
  expect(completion.streamCalls).toEqual(["usage-limit"]);
}, 60_000);

test("N8 admission failure stops the pass before any consume", async () => {
  const { completion } = await run("admit-throws");
  expect(completion.consumes).toEqual([]);
  expect(finished(completion)[0]).toMatchObject({ state: "failed", applied: 0 });
}, 60_000);

test("presentDecision failure after the native select withholds consent: no write, no spend", async () => {
  const { present } = await run("present-throws");
  expect(present.owner.presented[0].answer).toBe("Yes");
  expect(phases(present.owner.journal)).not.toContain("setting-written");
  expect(present.configUnchanged).toBe(true); expect(present.consumes).toBe(0);
  expect(finished(present)[0]).toMatchObject({ state: "failed", applied: 0 });
}, 60_000);

test("N8 cross-session sweep join: the second session waits for the original receipt, spends nothing, and keeps the original attribution", async () => {
  const { join } = await run("join-sweep-provenance");
  expect(join.consumes).toBe(1);
  expect(join.secondSettledBeforeRelease).toBe(false);
  const execute = join.owner.admissions.find((entry: { admission: { kind: string } }) => entry.admission.kind === "execute");
  expect(join.owner.admissions).toHaveLength(1);
  expect(join.firstPolicy).toMatchObject({ state: "settled", applied: 1, attemptIds: [execute.admission.attemptId] });
  expect(join.secondPolicy).toEqual(join.firstPolicy);
  expect(join.notices.second.filter((notice: { source?: string }) => notice.source === "codex-auto-reset")).toEqual([]);
}, 60_000);

test("N8 same-account blocked join: the joiner journals `joined` against the real original pass id, spends nothing, and still retries", async () => {
  const { join } = await run("join-blocked-provenance");
  expect(join.joinedInTime).toBe(true);
  expect(join.joined).toEqual([expect.objectContaining({ phase: "joined", originalPassId: join.originalPassId })]);
  expect(join.originalPassId).not.toBe("native-unowned");
  expect(join.consumes).toHaveLength(1);
  expect(join.streamCalls).toEqual({ first: ["usage-limit", "ok"], second: ["usage-limit", "ok"] });
  const settlements = finished(join);
  expect(settlements.map(settlement => settlement.applied).sort()).toEqual([0, 1]);
}, 60_000);

test("N8 rejected joined checkpoint retains failure separately from the original observed reset and retry", async () => {
  const { join } = await run("join-checkpoint-throws");
  expect(join.joinedInTime).toBe(true);
  expect(join.joined).toHaveLength(1);
  expect(join.joined[0].originalPassId).toBe(join.originalPassId);
  expect(join.owner.admissions).toHaveLength(1);
  expect(join.consumes).toHaveLength(1);
  expect(join.streamCalls).toEqual({ first: ["usage-limit", "ok"], second: ["usage-limit", "ok"] });
  const original = join.finished.find((entry: { passId: string }) => entry.passId === join.originalPassId);
  const joined = join.finished.find((entry: { passId: string }) => entry.passId === join.joined[0].pass.passId);
  expect(original?.settlement).toMatchObject({ state: "settled", applied: 1 });
  expect(joined?.settlement).toMatchObject({ state: "failed", applied: 0, attemptIds: [] });
  expect(join.finished).toHaveLength(2);
}, 60_000);

// --- N9 teardown ------------------------------------------------------------------------
test("N9 begin-dispose during the native select aborts it: no consent, no write, no spend", async () => {
  const { dispose } = await run("dispose-during-select");
  expect(dispose.interactions).toBe(1);
  expect(dispose.resolutions[0].reason).toBe("aborted");
  expect(dispose.owner.journal.find((entry: { phase: string }) => entry.phase === "answer").answer).toBeUndefined();
  expect(dispose.consumes).toBe(0); expect(dispose.configUnchanged).toBe(true);
  expect(finished(dispose)[0]).toMatchObject({ state: "cancelled", applied: 0 });
  expect(dispose.drained).toMatchObject({ state: "cancelled", applied: 0 });
}, 60_000);

test("N9 begin-dispose during eligibility prevents dispatch and drain waits for the pending eligibility work", async () => {
  const { dispose } = await run("dispose-during-eligibility");
  expect(dispose.drainSettledWhilePending).toBe(false);
  expect(dispose.admissions).toBe(0); expect(dispose.consumes).toBe(0);
  expect(dispose.promptSettled).toBe(true);
  expect(finished(dispose)[0]).toMatchObject({ state: "cancelled", applied: 0 });
  expect(dispose.drained).toMatchObject({ state: "cancelled", applied: 0 });
}, 60_000);

test("N9 begin-dispose during a dispatched consume: bounded consume completes against the original owner, no new dispatch, drain scoped to the session", async () => {
  const { dispose } = await run("dispose-during-consume");
  expect(dispose.reachedAccount).toBe("a");
  expect(dispose.promptSettled).toBe(true);
  expect(dispose.unrelatedDrainPrompt).toBe(true);
  expect(dispose.unrelatedDrained).toEqual(UNOWNED);
  expect(dispose.drainBlockedWhileConsumeHeld).toBe(true);
  expect(dispose.consumes.map((request: { account: string }) => request.account)).toEqual(["a"]);
  expect(dispose.owner.completions).toEqual([expect.objectContaining({ consumeBoundary: "passed", result: expect.objectContaining({ code: "reset" }) })]);
  expect(finished(dispose)[0]).toMatchObject({ state: "cancelled", applied: 1, attemptIds: [expect.any(String)] });
  expect(dispose.drained).toMatchObject({ state: "cancelled", applied: 1 });
}, 60_000);
