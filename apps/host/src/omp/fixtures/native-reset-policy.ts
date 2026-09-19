// Controlled actual-native fixture for the U2 Codex reset-policy owner hook
// (proposal003 N1–N5, N7–N9 native scope). Runs in a disposable subprocess whose
// HOME/PI_CODING_AGENT_DIR/TMPDIR/XDG dirs all point at the temporary root. The
// process-global fetch/preconnect are fail-closed and counted before any native
// import; provider traffic exists only through the pinned AuthStorage `usageFetch`
// transport injected below and the session's controlled `agent.streamFn`. Real
// pinned AgentSession, planner, Settings and (U1-patched) AuthStorage are used;
// no private method is patched and no provider, broker, profile or GUI is touched.
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssistantMessage, ResetCreditConsumeIdentity } from "@oh-my-pi/pi-ai";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AgentSession, AgentSessionEvent, AuthStorage, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import type { CodexAutoRedeemCoordinator, CodexResetPlan } from "@oh-my-pi/pi-coding-agent/session/codex-auto-reset";
import type {
  CodexResetPolicyOwner, NativeResetAnswer, ResetAdmission, ResetCheckpoint, ResetObservation, ResetPermit, ResetPlanSnapshot,
} from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type { OmpBridgeEvent, OmpInteraction } from "@agent-desktop/shared";
import type { OmpInteractionBridge } from "../interactions";

let blockedFetches = 0;
const blockedNetworkAttempts: { kind: "fetch" | "preconnect"; url: string }[] = [];
function recordBlockedNetwork(kind: "fetch" | "preconnect", input: Request | URL | string): never {
  if (kind === "fetch") blockedFetches++;
  const url = new URL(input instanceof Request ? input.url : String(input));
  blockedNetworkAttempts.push({ kind, url: `${url.origin}${url.pathname}` });
  throw new Error(`Network ${kind} is disabled in the native reset-policy fixture`);
}
globalThis.fetch = Object.assign(async (input: Request | URL | string) => recordBlockedNetwork("fetch", input),
  { preconnect: (input: URL | string) => recordBlockedNetwork("preconnect", input) }) as typeof fetch;

const directory = process.argv[2]!, scenario = process.argv[3]!;
assert.ok(directory && scenario, "usage: native-reset-policy.ts <root> <scenario>");
assert.equal(process.env.HOME, directory);
const agentDir = path.join(directory, "agent"), cwd = path.join(directory, "project");
assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir);
await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });

// ---------------------------------------------------------------------------
// Scenario configuration (settings written to the disposable global config.yml)
// ---------------------------------------------------------------------------
type AutoRedeem = "unset" | "yes" | "no";
interface ScenarioConfig { autoRedeem: AutoRedeem; keepCredits?: number }
const configs: Record<string, ScenarioConfig> = {
  "owner-absent-sweep": { autoRedeem: "yes" }, "owner-absent-blocked": { autoRedeem: "yes" }, "policy-no-blocked": { autoRedeem: "no" },
  "pool-blocked-restore-salvage": { autoRedeem: "yes" }, "pool-reserve": { autoRedeem: "yes", keepCredits: 1 }, "pool-spark": { autoRedeem: "yes" },
  "pool-other-provider-sweep": { autoRedeem: "yes" }, "pool-synthesized-live429": { autoRedeem: "yes" }, "pool-stale-zero-gate": { autoRedeem: "yes" },
  "sweep-zero-actions": { autoRedeem: "yes" }, "report-binding-sweep-order": { autoRedeem: "yes" },
  "report-binding-fetch-error": { autoRedeem: "yes" }, "report-binding-start-error": { autoRedeem: "yes" },
  "clock-identity": { autoRedeem: "unset" }, "retarget-account-started": { autoRedeem: "yes" }, "retarget-model-planned": { autoRedeem: "yes" },
  "retarget-model-started": { autoRedeem: "yes" },
  "guard-refused": { autoRedeem: "yes" }, "guard-policy-change": { autoRedeem: "yes" }, "identity-removed": { autoRedeem: "yes" },
  "decision-yes": { autoRedeem: "unset" }, "decision-no": { autoRedeem: "unset" }, "decision-dismiss": { autoRedeem: "unset" }, "decision-headless": { autoRedeem: "unset" },
  "settings-flush-throws": { autoRedeem: "unset" }, "settings-unrelated-key-merge": { autoRedeem: "unset" }, "settings-project-shadow": { autoRedeem: "unset" },
  "settings-runtime-change": { autoRedeem: "unset" },
  "settings-conflicting-readback": { autoRedeem: "unset" },
  "outcome-unknown-fence": { autoRedeem: "yes" }, "outcome-throw": { autoRedeem: "yes" }, "outcome-timeout": { autoRedeem: "yes" }, "nothing-to-reset-reenter": { autoRedeem: "yes" },
  "outcome-future-fence": { autoRedeem: "yes" },
  "refresh-failed-retains-reset": { autoRedeem: "yes" }, "complete-throws": { autoRedeem: "yes" }, "checkpoint-planned-throws": { autoRedeem: "yes" },
  "present-throws": { autoRedeem: "unset" }, "admit-throws": { autoRedeem: "yes" },
  "join-sweep-provenance": { autoRedeem: "yes" }, "join-blocked-provenance": { autoRedeem: "yes" },
  "join-checkpoint-throws": { autoRedeem: "yes" },
  "dispose-during-select": { autoRedeem: "unset" }, "dispose-during-eligibility": { autoRedeem: "yes" }, "dispose-during-consume": { autoRedeem: "yes" },
};
const config = configs[scenario];
assert.ok(config, `Unknown native reset-policy scenario: ${scenario}`);
const configPath = path.join(agentDir, "config.yml");
const configText = [
  "extensions: []", "defaultThinkingLevel: low", "retry:", "  enabled: true", "  maxRetries: 3", "  baseDelayMs: 1", "  maxDelayMs: 5000",
  "  modelFallback: false", "  usageAwareFallback: false", "codexResets:", `  autoRedeem: ${config.autoRedeem}`,
  `  keepCredits: ${config.keepCredits ?? 0}`, "  salvageHorizonHours: 12", "  minBlockedMinutes: 60", "",
].join("\n");
await writeFile(configPath, configText);
const originalConfigBytes = await readFile(configPath);
if (scenario === "settings-project-shadow") {
  await mkdir(path.join(cwd, ".omp"), { recursive: true });
  await writeFile(path.join(cwd, ".omp", "config.yml"), "codexResets:\n  autoRedeem: unset\n");
}
await writeFile(path.join(agentDir, "models.yml"), JSON.stringify({ providers: { "plan-fixture": {
  api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", auth: "none", models: [{ id: "base", name: "Local non-executing base", reasoning: false,
    input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));

// Dynamic imports on purpose: native modules run discovery at load time and must
// only load after the outbound guard above (same convention as plan-native.ts).
const native = await import("@oh-my-pi/pi-coding-agent");
const { AgentRegistry, AuthStorage: NativeAuthStorage, createAgentSession, ModelRegistry: NativeModelRegistry, SessionManager: NativeSessionManager,
  Settings: NativeSettings, SqliteAuthCredentialStore } = native;
const { defaultCodexAutoRedeemCoordinator, isTerminalRedeemOutcome, overlayLiveResetCredits, planCodexResetRedemptions,
  planCodexResetRedemptionsWithReportRevision } = await import("@oh-my-pi/pi-coding-agent/session/codex-auto-reset");
const { invalidate: invalidateFsCache } = await import("@oh-my-pi/pi-coding-agent/capability/fs");
const { AssistantMessageEventStream } = await import("@oh-my-pi/pi-ai/utils/event-stream");
const { pickSoonestExpiringCredit } = await import("@oh-my-pi/pi-ai/usage/openai-codex-reset");
const { getAgentDbPath } = await import("@oh-my-pi/pi-utils");
const { OmpInteractionBridge: Bridge } = await import("../interactions");
const { initializeDesktopExtensions } = await import("../extensions");

// ---------------------------------------------------------------------------
// Deterministic Codex transport behind AuthStorage.usageFetch
// ---------------------------------------------------------------------------
// Whole seconds: the Codex wire carries `reset_at` in seconds, so absolute-time equalities round-trip exactly.
const base = Math.floor(Date.now() / 1000) * 1000;
const HOUR = 3_600_000;
type ConsumeMode = "reset" | "nothing_to_reset" | "already_redeemed" | "malformed" | "future" | "throw" | "hang";
interface FixtureCredit { id: string; expiresAtMs: number; status: "available" | "redeemed" }
interface FixtureAccount {
  key: string; accountId: string; email: string; orgId?: string; credentialId?: number;
  usage: { mode: "healthy" | "blocked" | "error"; primaryUsed: number; weeklyUsed: number; primaryResetAtMs: number; weeklyResetAtMs: number; reportedCount?: number };
  credits: FixtureCredit[]; creditsMode: "ok" | "error"; consume: ConsumeMode;
}
interface AccountInit {
  blocked?: boolean; primaryUsed?: number; weeklyUsed?: number; primaryResetInMs?: number; creditsExpireInMs?: number[];
  consume?: ConsumeMode; email?: string; orgId?: string; reportedCount?: number; creditsMode?: "ok" | "error";
}
function account(key: string, init: AccountInit = {}): FixtureAccount {
  const blocked = init.blocked === true;
  return {
    key, accountId: `acct-${key}`, email: init.email ?? `${key}@example.com`, orgId: init.orgId,
    usage: { mode: blocked ? "blocked" : "healthy", primaryUsed: init.primaryUsed ?? (blocked ? 1 : 0.3), weeklyUsed: init.weeklyUsed ?? 0.4,
      primaryResetAtMs: base + (init.primaryResetInMs ?? 3 * HOUR), weeklyResetAtMs: base + 2 * 24 * HOUR, reportedCount: init.reportedCount },
    credits: (init.creditsExpireInMs ?? []).map((offset, index) => ({ id: `credit-${key}-${index + 1}`, expiresAtMs: base + offset, status: "available" as const })),
    creditsMode: init.creditsMode ?? "ok", consume: init.consume ?? "reset",
  };
}
/** Marks the active account as blocked by the live 429 exactly when the controlled stream reports it. */
function blockAccount(account: FixtureAccount): void { account.usage.mode = "blocked"; account.usage.primaryUsed = 1; }
const availableCount = (account: FixtureAccount) => account.credits.filter(credit => credit.status === "available").length;
type Route = "usage" | "credits" | "consume" | "unknown";
interface TransportRequest { method: string; route: Route; account?: string; body?: Record<string, unknown>; at: number }
const transportRequests: TransportRequest[] = [];
const boundaryOrder: string[] = [];
let escapedTransport = 0;
/** Optional holds: a request on the gated route waits until released (or its native signal aborts). */
const gates: Partial<Record<Route, ReturnType<typeof Promise.withResolvers<void>>>> = {};
const reached: Partial<Record<Route, ReturnType<typeof Promise.withResolvers<TransportRequest>>>> = {};
const pool: FixtureAccount[] = [];
function usagePayload(account: FixtureAccount) {
  const blocked = account.usage.mode === "blocked";
  return { plan_type: "plus", rate_limit: { allowed: !blocked, limit_reached: blocked,
    primary_window: { used_percent: Math.round(account.usage.primaryUsed * 100), limit_window_seconds: 18_000, reset_at: Math.floor(account.usage.primaryResetAtMs / 1000) },
    secondary_window: { used_percent: Math.round(account.usage.weeklyUsed * 100), limit_window_seconds: 604_800, reset_at: Math.floor(account.usage.weeklyResetAtMs / 1000) } },
    rate_limit_reset_credits: { available_count: account.usage.reportedCount ?? availableCount(account) } };
}
function creditsPayload(account: FixtureAccount) {
  return { available_count: availableCount(account), credits: account.credits.map(credit => ({ id: credit.id, status: credit.status,
    reset_type: "codex_rate_limits", granted_at: new Date(base - 24 * HOUR).toISOString(), expires_at: new Date(credit.expiresAtMs).toISOString() })) };
}
function abortRejection(signal: AbortSignal | null | undefined): Promise<never> {
  const { promise, reject } = Promise.withResolvers<never>();
  const abort = () => reject(new DOMException("Controlled Codex transport aborted", "AbortError"));
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  return promise;
}
const usageFetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const request = new Request(input, init), url = new URL(request.url);
  const accountId = request.headers.get("ChatGPT-Account-Id") ?? undefined;
  const target = pool.find(candidate => candidate.accountId === accountId);
  const route: Route = url.pathname.endsWith("/wham/usage") ? "usage" : url.pathname.endsWith("/wham/rate-limit-reset-credits") ? "credits"
    : url.pathname.endsWith("/wham/rate-limit-reset-credits/consume") ? "consume" : "unknown";
  const body = request.method === "POST" ? (await request.json()) as Record<string, unknown> : undefined;
  const record: TransportRequest = { method: request.method, route, account: target?.key ?? accountId, body, at: Date.now() };
  transportRequests.push(record);
  boundaryOrder.push(`transport:${route}`);
  if (route === "unknown" || !target) { escapedTransport++; throw new Error(`Unowned Codex transport request: ${request.method} ${url.pathname}`); }
  reached[route]?.resolve(record); delete reached[route];
  const gate = gates[route];
  if (gate) await Promise.race([gate.promise, abortRejection(request.signal)]);
  if (route === "usage") return target.usage.mode === "error" ? new Response("controlled usage failure", { status: 500 }) : Response.json(usagePayload(target));
  if (route === "credits") return target.creditsMode === "error" ? new Response("controlled credit listing failure", { status: 503 }) : Response.json(creditsPayload(target));
  assert.equal(request.method, "POST", "Consume must be a POST");
  switch (target.consume) {
    case "throw": throw new TypeError("controlled consume transport failure");
    case "hang": return abortRejection(request.signal);
    case "malformed": return Response.json({}, { status: 200 });
    case "future": return Response.json({ code: "provider_future_code" }, { status: 200 });
    case "already_redeemed": return Response.json({ code: "already_redeemed" }, { status: 409 });
    case "nothing_to_reset": return Response.json({ code: "nothing_to_reset" }, { status: 200 });
    default: {
      const credit = target.credits.find(candidate => candidate.id === body?.credit_id);
      if (!credit || credit.status !== "available") return Response.json({ code: "no_credit" }, { status: 200 });
      credit.status = "redeemed";
      target.usage = { ...target.usage, mode: "healthy", primaryUsed: 0, weeklyUsed: 0 };
      return Response.json({ code: "reset" }, { status: 200 });
    }
  }
}, { preconnect: () => {} }) as typeof fetch;
interface RouteHold { reached: Promise<TransportRequest>; release(): void }
/** Holds the next request on `route` until released; `reached` resolves when native traffic arrives at the gate. */
function holdRoute(route: Route): RouteHold {
  gates[route] = Promise.withResolvers<void>(); reached[route] = Promise.withResolvers<TransportRequest>();
  return { reached: reached[route]!.promise, release() { gates[route]?.resolve(); delete gates[route]; } };
}
/** Resolves when the next request on `route` arrives, without holding it. */
function watchRoute(route: Route): Promise<TransportRequest> {
  reached[route] = Promise.withResolvers<TransportRequest>();
  return reached[route]!.promise;
}
const consumes = () => transportRequests.filter(request => request.route === "consume");
const consumeSummary = () => consumes().map(request => ({ account: request.account, accountId: request.body?.account_id, creditId: request.body?.credit_id,
  redeemRequestId: request.body?.redeem_request_id }));

// ---------------------------------------------------------------------------
// Native credential store with the controlled transport
// ---------------------------------------------------------------------------
async function seedPool(accounts: FixtureAccount[]): Promise<AuthStorage> {
  pool.push(...accounts);
  const auth = new NativeAuthStorage(await SqliteAuthCredentialStore.open(getAgentDbPath(agentDir)), { usageFetch });
  await auth.set("openai-codex", accounts.map(entry => ({ type: "oauth" as const, refresh: `fixture-refresh-${entry.key}`, access: `fixture-access-${entry.key}`,
    expires: base + 24 * HOUR, accountId: entry.accountId, email: entry.email, ...(entry.orgId ? { orgId: entry.orgId } : {}) })));
  for (const summary of auth.listOAuthAccounts("openai-codex")) {
    const entry = accounts.find(candidate => candidate.accountId === summary.accountId);
    assert.ok(entry, "Every stored credential must map back to a fixture account"); entry.credentialId = summary.credentialId;
  }
  return auth;
}
async function readOnlyRegistry(auth: AuthStorage): Promise<ModelRegistry> {
  return new NativeModelRegistry(auth, path.join(agentDir, "models.yml"), { settings: await NativeSettings.loadReadOnly({ agentDir, cwd }) });
}

// ---------------------------------------------------------------------------
// Recording owner (proposal003 CodexResetPolicyOwner) with scenario knobs
// ---------------------------------------------------------------------------
interface OwnerKnobs {
  failCheckpoint?: ResetCheckpoint["phase"]; failComplete?: boolean; failPresent?: boolean; failAdmit?: boolean; skipSelect?: boolean;
  beforeAnswer?: () => void | Promise<void>; onCheckpoint?: (event: ResetCheckpoint) => void | Promise<void>;
  admit?: "hold-owner-unavailable" | "remove-credential"; guard?: boolean; onAdmit?: (snapshot: ResetPlanSnapshot, index: number) => void | Promise<void>; verifyPlanner?: boolean;
}
function describePass(pass: ResetPlanSnapshot["pass"]) {
  return { passId: pass.passId, nativeSessionId: pass.nativeSessionId, trigger: pass.trigger, source: pass.source, provider: pass.provider, modelId: pass.modelId,
    codexBaseUrl: pass.codexBaseUrl, identity: pass.identity, activeBlockUnblockAtMs: pass.activeBlockUnblockAtMs, policy: pass.policy, startedAtMs: pass.startedAtMs };
}
function describeSnapshot(snapshot: ResetPlanSnapshot) {
  return { passId: snapshot.pass.passId, trigger: snapshot.pass.trigger, plannedAtMs: snapshot.plannedAtMs, reportRevision: snapshot.reportRevision,
    actions: snapshot.plan.actions, skipped: snapshot.plan.skipped };
}
function describeObservation(observation: ResetObservation) {
  return { consumeBoundary: observation.consumeBoundary, result: observation.result.kind === "outcome" ? { kind: "outcome", code: observation.result.outcome.code,
    ok: observation.result.outcome.ok, creditId: observation.result.outcome.creditId, accountId: observation.result.outcome.accountId }
    : { kind: "error", message: observation.result.error instanceof Error ? `${observation.result.error.name}: ${observation.result.error.message}` : String(observation.result.error) } };
}
interface InFlightAttempt { attemptId: string; passId: string; settled: Promise<ResetObservation>; resolve: (observation: ResetObservation) => void }
class FixtureOwner implements CodexResetPolicyOwner {
  readonly journal: Record<string, unknown>[] = [];
  readonly presented: { passId: string; actions: number; answer: NativeResetAnswer | "not-invoked"; selectError?: string }[] = [];
  readonly admissions: Record<string, unknown>[] = [];
  readonly guardCalls: { attemptId: string; identity: ResetCreditConsumeIdentity; allowed: boolean }[] = [];
  readonly completions: Record<string, unknown>[] = [];
  readonly persistence: Record<string, unknown>[] = [];
  readonly plannerParity: { passId: string; equal: boolean; revisionEqual: boolean; expected?: CodexResetPlan; actual?: CodexResetPlan;
    expectedRevision?: string; actualRevision?: string }[] = [];
  readonly fenced = new Set<string>();
  readonly #inFlight = new Map<string, InFlightAttempt>();
  readonly #permits = new Map<string, { attemptKey: string; accountKey: string }>();
  #settings: Settings | undefined;
  constructor(readonly auth: AuthStorage, readonly registry: ModelRegistry, readonly knobs: OwnerKnobs = {}) {}
  /** The live session Settings instance whose native `set` this owner must prove persisted. */
  attach(settings: Settings): void { this.#settings = settings; }
  async checkpoint(event: ResetCheckpoint): Promise<void> {
    boundaryOrder.push(`checkpoint:${event.phase}`);
    const entry: Record<string, unknown> = { phase: event.phase };
    if (event.phase === "started" || event.phase === "finished" || event.phase === "joined") entry.pass = describePass(event.pass);
    if (event.phase === "joined") entry.originalPassId = event.originalPassId;
    if (event.phase === "finished") entry.settlement = event.settlement;
    if (event.phase === "planned" || event.phase === "answer" || event.phase === "setting-written") entry.snapshot = describeSnapshot(event.snapshot);
    if (event.phase === "answer") entry.answer = event.answer;
    if (event.phase === "setting-written") entry.mode = event.mode;
    this.journal.push(entry);
    await this.knobs.onCheckpoint?.(event);
    if (event.phase === "planned" && this.knobs.verifyPlanner) await this.#verifyPlanner(event.snapshot);
    if (this.knobs.failCheckpoint === event.phase) throw new Error(`controlled checkpoint failure at ${event.phase}`);
    if (event.phase === "setting-written") await this.#provePersisted(event.snapshot, event.mode);
  }
  /**
   * Owner durability barrier for the native `settings.set`: flush the live instance, drop file caches,
   * independently read the persisted global layer and the effective value back, and reject anything
   * unverified or conflicting. A proven global write under an unchanged higher-layer `unset` keeps only
   * this pass's explicit answer and is reported as shadowed. No retry, no cancellation of live saves.
   */
  async #provePersisted(snapshot: ResetPlanSnapshot, mode: "yes" | "no"): Promise<void> {
    const settings = this.#settings;
    assert.ok(settings, "The owner must be attached to the live session settings before a decision");
    const record: Record<string, unknown> = { mode, flushed: false };
    this.persistence.push(record);
    try { await settings.flush(); } catch (error) { record.flushError = error instanceof Error ? error.message : String(error); throw error; }
    record.flushed = true;
    invalidateFsCache(configPath);
    const readBack = await NativeSettings.loadReadOnly({ agentDir, cwd });
    const persisted = (readBack.getGlobalSettings().codexResets as Record<string, unknown> | undefined)?.autoRedeem;
    const project = (readBack.getProjectSettings().codexResets as Record<string, unknown> | undefined)?.autoRedeem;
    const effective = settings.get("codexResets.autoRedeem");
    Object.assign(record, { persisted, project, effective, shadowed: effective !== mode });
    if (persisted !== mode) throw new Error(`unverified global write: persisted ${String(persisted)} instead of ${mode}`);
    if (effective !== mode && effective !== snapshot.pass.policy.autoRedeem) throw new Error(`effective autoRedeem changed under the prompt: ${String(effective)}`);
  }
  /** Re-run the actual pure planner over the same evidence with the snapshot's exact clock: the copy must be identical. */
  async #verifyPlanner(snapshot: ResetPlanSnapshot): Promise<void> {
    const baseUrlResolver = (provider: string) => this.registry.getProviderBaseUrl?.(provider);
    let reports = await this.auth.fetchUsageReports({ baseUrlResolver });
    if (snapshot.pass.trigger === "blocked") {
      reports = overlayLiveResetCredits(reports, await this.auth.listResetCredits({ provider: "openai-codex", sessionId: snapshot.pass.nativeSessionId, baseUrlResolver }));
    }
    const expected = planCodexResetRedemptionsWithReportRevision({ nowMs: snapshot.plannedAtMs, trigger: snapshot.pass.trigger, provider: snapshot.pass.provider, modelId: snapshot.pass.modelId,
      settings: { enabled: snapshot.pass.policy.autoRedeem !== "no", minBlockedMinutes: snapshot.pass.policy.minBlockedMinutes, keepCredits: snapshot.pass.policy.keepCredits,
        salvageHorizonMs: snapshot.pass.policy.salvageHorizonHours * HOUR },
      identity: snapshot.pass.identity, reports, attemptedKeys: new Set(), deferredUntilByKey: new Map(), lastAttemptAtByAccount: new Map(),
      activeBlockUnblockAtMs: snapshot.pass.activeBlockUnblockAtMs });
    const actual = structuredClone(snapshot.plan) as CodexResetPlan;
    this.plannerParity.push({ passId: snapshot.pass.passId, equal: Bun.deepEquals(expected.plan, actual, true),
      revisionEqual: expected.reportRevision === snapshot.reportRevision, expected: expected.plan, actual,
      expectedRevision: expected.reportRevision, actualRevision: snapshot.reportRevision });
  }
  async presentDecision(snapshot: ResetPlanSnapshot, selectNative: () => Promise<NativeResetAnswer>): Promise<void> {
    const entry: FixtureOwner["presented"][number] = { passId: snapshot.pass.passId, actions: snapshot.plan.actions.length, answer: "not-invoked" };
    this.presented.push(entry);
    if (this.knobs.skipSelect) return;
    await this.knobs.beforeAnswer?.();
    try { entry.answer = await selectNative(); } catch (error) { entry.selectError = error instanceof Error ? error.message : String(error); throw error; }
    if (this.knobs.failPresent) throw new Error("controlled presentDecision failure after the native select");
  }
  async admit(snapshot: ResetPlanSnapshot, actionIndex: number): Promise<ResetAdmission> {
    const action = snapshot.plan.actions[actionIndex];
    assert.ok(action, "Native admission index must address a planned action");
    await this.knobs.onAdmit?.(snapshot, actionIndex);
    if (this.knobs.failAdmit) throw new Error("controlled admission failure");
    const record = (admission: ResetAdmission): ResetAdmission => {
      this.admissions.push({ passId: snapshot.pass.passId, actionIndex, attemptKey: action.attemptKey, accountKey: action.accountKey, reason: action.reason,
        admission: admission.kind === "execute" ? { kind: "execute", attemptId: admission.permit.attemptId, credentialId: admission.permit.target.credentialId,
          creditId: admission.permit.creditId, redeemRequestId: admission.permit.redeemRequestId }
          : admission.kind === "join" ? { kind: "join", attemptId: admission.attemptId } : admission });
      return admission;
    };
    if (this.knobs.admit === "hold-owner-unavailable") return record({ kind: "hold", reason: "owner-unavailable" });
    // Unknown receipts fence this account for any later trigger/key; they never force a global policy.
    if (this.fenced.has(action.accountKey)) return record({ kind: "hold", reason: "unknown" });
    const inFlight = this.#inFlight.get(action.attemptKey);
    if (inFlight) return record({ kind: "join", attemptId: inFlight.attemptId, settled: inFlight.settled });
    // Exact identity/credit through the original session's AuthStorage (native picker, no invented gate).
    const statuses = await this.auth.listResetCredits({ provider: "openai-codex", sessionId: snapshot.pass.nativeSessionId,
      baseUrlResolver: provider => this.registry.getProviderBaseUrl?.(provider) });
    const matches = statuses.filter(status => action.target.accountId ? status.accountId === action.target.accountId : !!action.target.email && status.email === action.target.email);
    const status = matches[0];
    if (matches.length !== 1 || !status || status.credentialId === undefined) return record({ kind: "hold", reason: "identity-unresolved" });
    if (status.error) return record({ kind: "hold", reason: "credit-unavailable" });
    const credit = pickSoonestExpiringCredit(status.credits);
    if (!credit || (credit.status ?? "available") !== "available") return record({ kind: "hold", reason: "credit-unavailable" });
    if (this.knobs.admit === "remove-credential") {
      const stored = this.auth.getAll()["openai-codex"];
      const remaining = (Array.isArray(stored) ? stored : stored ? [stored] : []).filter(entry => entry.type !== "oauth" || entry.accountId !== status.accountId);
      await this.auth.set("openai-codex", remaining);
    }
    const credentialId = status.credentialId, creditId = credit.id, attemptId = crypto.randomUUID();
    const permit: ResetPermit = { attemptId, target: { credentialId }, creditId, redeemRequestId: crypto.randomUUID(), beforeConsume: identity => {
      const allowed = this.knobs.guard !== false && identity.provider === "openai-codex" && identity.credentialId === credentialId && identity.creditId === creditId;
      this.guardCalls.push({ attemptId, identity, allowed });
      return allowed;
    } };
    const settled = Promise.withResolvers<ResetObservation>();
    this.#inFlight.set(action.attemptKey, { attemptId, passId: snapshot.pass.passId, settled: settled.promise, resolve: settled.resolve });
    this.#permits.set(attemptId, { attemptKey: action.attemptKey, accountKey: action.accountKey });
    return record({ kind: "execute", permit });
  }
  async complete(permit: ResetPermit, observation: ResetObservation): Promise<void> {
    const meta = this.#permits.get(permit.attemptId);
    this.completions.push({ attemptId: permit.attemptId, creditId: permit.creditId, credentialId: permit.target.credentialId, ...describeObservation(observation) });
    const unknown = observation.consumeBoundary === "passed" && (observation.result.kind === "error" ||
      (!isTerminalRedeemOutcome(observation.result.outcome.code) && observation.result.outcome.code !== "nothing_to_reset"));
    if (unknown && meta) this.fenced.add(meta.accountKey);
    if (meta) { this.#inFlight.get(meta.attemptKey)?.resolve(observation); this.#inFlight.delete(meta.attemptKey); }
    if (this.knobs.failComplete) throw new Error("controlled completion failure");
  }
}
function ownerEvidence(owner: FixtureOwner) {
  return { journal: owner.journal, presented: owner.presented, admissions: owner.admissions, guardCalls: owner.guardCalls, completions: owner.completions,
    persistence: owner.persistence, fenced: [...owner.fenced],
    plannerParity: owner.plannerParity.map(entry => ({ passId: entry.passId, equal: entry.equal, revisionEqual: entry.revisionEqual,
      ...((entry.equal && entry.revisionEqual) ? {} : { expected: entry.expected, actual: entry.actual, expectedRevision: entry.expectedRevision, actualRevision: entry.actualRevision }) })) };
}
const finishedSettlements = (owner: FixtureOwner, trigger?: "blocked" | "sweep") => owner.journal
  .filter(entry => entry.phase === "finished" && (!trigger || (entry.pass as { trigger: string }).trigger === trigger))
  .map(entry => ({ passId: (entry.pass as { passId: string }).passId, trigger: (entry.pass as { trigger: string }).trigger, settlement: entry.settlement }));

// ---------------------------------------------------------------------------
// Real pinned AgentSession with controlled stream and optional real UI bridge
// ---------------------------------------------------------------------------
type ModelChoice = "codex" | "spark" | "local";
type StreamStep = "usage-limit" | "ok";
interface SessionOptions {
  model: ModelChoice; owner?: FixtureOwner; ui?: boolean; script?: StreamStep[];
  /** Runs when the controlled stream reports the live 429; may delay the error to align concurrent sessions. */
  onUsageLimit?: () => void | Promise<void>;
}
interface SessionFixture {
  session: AgentSession; manager: SessionManager; settings: Settings; registry: ModelRegistry; coordinator: CodexAutoRedeemCoordinator;
  bridge: OmpInteractionBridge | undefined; notices: { level: string; message: string; source?: string }[]; retries: Record<string, unknown>[];
  interactions: { id: string; title: string; options?: { label: string; description?: string }[] }[]; resolutions: { id: string; reason: string }[]; streamCalls: StreamStep[];
  setInteractionHandler(handler: (interaction: OmpInteraction) => void): void;
  blockedPrompt(): Promise<void>;
  close(): Promise<void>;
}
const RETRY_AFTER_SECONDS = 7200;
async function openSession(auth: AuthStorage, options: SessionOptions): Promise<SessionFixture> {
  const settings = await NativeSettings.loadIsolated({ agentDir, cwd });
  const registry = new NativeModelRegistry(auth, path.join(agentDir, "models.yml"), { settings });
  const model = options.model === "local" ? registry.find("plan-fixture", "base")
    : registry.find("openai-codex", options.model === "spark" ? "gpt-5.3-codex-spark" : "gpt-5.4-mini");
  assert.ok(model, `Pinned catalog must provide the ${options.model} model; do not fabricate a PASS.`);
  const manager = NativeSessionManager.create(cwd, path.join(agentDir, "sessions"));
  const coordinator = defaultCodexAutoRedeemCoordinator;
  options.owner?.attach(settings);
  const result = await createAgentSession({ agentDir, cwd, settings, authStorage: auth, modelRegistry: registry, agentRegistry: new AgentRegistry(),
    sessionManager: manager, model, hasUI: false, interactivePrompts: options.ui === true, deferUsageReserveConfirmation: true, disableExtensionDiscovery: true,
    extensions: [], enableLsp: false, enableMCP: false, toolNames: [], skills: [], rules: [], contextFiles: [],
    systemPrompt: "Controlled native reset-policy fixture; no live provider transport.", codexResetPolicyOwner: options.owner });
  await manager.ensureOnDisk();
  const session = result.session;
  const notices: SessionFixture["notices"] = [];
  const retries: Record<string, unknown>[] = [];
  session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "notice") notices.push({ level: event.level, message: event.message, source: event.source });
    else if (event.type === "auto_retry_start") retries.push({ type: event.type, attempt: event.attempt, delayMs: event.delayMs });
    else if (event.type === "auto_retry_end") retries.push({ type: event.type, attempt: event.attempt, success: event.success, finalError: event.finalError });
  });
  const interactions: SessionFixture["interactions"] = [];
  const resolutions: SessionFixture["resolutions"] = [];
  let onInteraction: ((interaction: OmpInteraction) => void) | undefined;
  let bridge: OmpInteractionBridge | undefined;
  if (options.ui) {
    bridge = new Bridge(session.sessionId, (event: OmpBridgeEvent) => {
      if (event.type === "extension_interaction_requested") {
        interactions.push({ id: event.interaction.id, title: event.interaction.title ?? "", options: event.interaction.options });
        onInteraction?.(event.interaction);
      } else if (event.type === "extension_interaction_resolved") resolutions.push({ id: event.id, reason: event.reason });
    });
    result.setToolUIContext(bridge, true);
    await initializeDesktopExtensions(session, bridge);
  }
  // Controlled provider stream through the public agent seam: the real retry pipeline, usage-limit
  // recording, credential blocking and the owned blocked pass all run natively on this message.
  const streamCalls: StreamStep[] = [];
  const script = options.script ?? [];
  const original = session.agent.streamFn;
  const controlled: StreamFn = (model, context, streamOptions) => {
    if (model.provider !== "openai-codex" && model.provider !== "plan-fixture") return original(model, context, streamOptions);
    const step = script[streamCalls.length] ?? "ok"; streamCalls.push(step);
    const stream = new AssistantMessageEventStream();
    const output = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as AssistantMessage;
    void (async () => {
      if (step === "usage-limit") {
        output.stopReason = "error"; output.errorStatus = 429;
        output.errorMessage = `429 usage_limit_reached: You have hit your ChatGPT usage limit. retry-after: ${RETRY_AFTER_SECONDS}`;
        await options.onUsageLimit?.();
        stream.push({ type: "error", reason: "error", error: output });
      } else {
        output.content = [{ type: "text", text: "Controlled native response." }];
        stream.push({ type: "done", reason: "stop", message: output });
      }
      stream.end();
    })();
    return stream;
  };
  session.agent.streamFn = controlled;
  return {
    session, manager, settings, registry, coordinator, bridge, notices, retries, interactions, resolutions, streamCalls,
    setInteractionHandler(handler) { onInteraction = handler; },
    async blockedPrompt() {
      await session.prompt("Controlled prompt that meets a usage limit.");
      await session.waitForIdle().catch(() => {});
      await session.drainCodexResetPolicy();
    },
    async close() { bridge?.dispose(); try { await session.dispose(); } catch { /* disposal after beginDispose is best-effort here */ } },
  };
}
// Real waits on purpose: this subprocess drives an actual AgentSession through real async IO, which fake
// timers cannot advance. `waitFor` polls for an observed condition; `settledWithin` is a bounded negative probe.
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) { assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`); await Bun.sleep(20); }
}
const settledWithin = (promise: Promise<unknown>, ms: number) => Promise.race([promise.then(() => true, () => true), Bun.sleep(ms).then(() => false)]);
/** Await the immediate native retry after an observed reset, then let the session settle. */
async function awaitRetry(fixture: SessionFixture, timeoutMs = 15_000): Promise<void> {
  await waitFor(() => fixture.streamCalls.length >= 2, "immediate retry after the observed reset", timeoutMs);
  await fixture.session.waitForIdle().catch(() => {});
  await fixture.session.drainCodexResetPolicy();
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function respondAll(fixture: SessionFixture, answer: "Yes" | "No" | "cancel", delayMs = 0) {
  fixture.setInteractionHandler(interaction => { void Bun.sleep(delayMs).then(() => {
    try { fixture.bridge!.respond(interaction.id, answer === "cancel" ? { cancel: true } : { value: answer }); } catch { /* recorded by resolutions */ }
  }); });
}
async function readConfig() {
  const bytes = await readFile(configPath);
  return { bytes, parsed: Bun.YAML.parse(bytes.toString("utf8")) as Record<string, unknown> };
}
const plannedSnapshot = (owner: FixtureOwner, trigger: "blocked" | "sweep") => owner.journal
  .find(entry => entry.phase === "planned" && (entry.snapshot as { trigger: string }).trigger === trigger)?.snapshot as
  { plannedAtMs: number; reportRevision: string; actions: CodexResetPlan["actions"]; skipped: CodexResetPlan["skipped"] } | undefined;

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
const result: Record<string, unknown> = { scenario };
let restoreLockedDir: string | undefined;
const closers: (() => Promise<void>)[] = [];
let auth: AuthStorage | undefined;
try {
  switch (scenario) {
    case "owner-absent-sweep": {
      // N1: absent owner, existing yes, sweep across the pool with the actual pure planner as the oracle.
      auth = await seedPool([account("a", { creditsExpireInMs: [2 * HOUR] }), account("b", { creditsExpireInMs: [30 * HOUR] }),
        account("c", { creditsExpireInMs: [1 * HOUR], weeklyUsed: 0.1, primaryUsed: 0.1 })]);
      const fixture = await openSession(auth, { model: "codex", ui: true }); closers.push(fixture.close);
      const first = await fixture.session.fetchUsageReports();
      await fixture.coordinator.sweepPromise;
      // The joining method is owner-only; without an owner it must reject rather than fake a settlement.
      const joiningRejected = await fixture.session.fetchUsageReportsWithResetPolicy({ source: "manual" }).then(() => false, error => error instanceof Error ? error.message : String(error));
      const expected = planCodexResetRedemptions({ nowMs: fixture.coordinator.lastSweepAt, trigger: "sweep", provider: "openai-codex", modelId: "gpt-5.4-mini",
        settings: { enabled: true, minBlockedMinutes: 60, keepCredits: 0, salvageHorizonMs: 12 * HOUR }, identity: auth.getOAuthAccountIdentity("openai-codex", fixture.session.sessionId),
        reports: first, attemptedKeys: new Set(), deferredUntilByKey: new Map(), lastAttemptAtByAccount: new Map() });
      const before = consumes().length;
      const second = await fixture.session.fetchUsageReports();
      await fixture.coordinator.sweepPromise;
      result.sweep = { joiningRejected, reportsCount: first?.length ?? null, secondReportsCount: second?.length ?? null,
        expectedActions: expected.actions.map(action => ({ reason: action.reason, accountKey: action.accountKey, attemptKey: action.attemptKey })), expectedSkipped: expected.skipped,
        consumes: consumeSummary(), nativeRequestIdsAreUuids: consumes().every(request => uuidPattern.test(String(request.body?.redeem_request_id))),
        secondSweepConsumed: consumes().length - before, interactions: fixture.interactions.length, attemptedKeys: [...fixture.coordinator.attemptedKeys], notices: fixture.notices };
      break;
    }
    case "owner-absent-blocked": {
      // N1 blocked parity: no owner, yes, one account; the real retry pipeline restores and retries at once.
      const a = account("a", { creditsExpireInMs: [20 * HOUR] });
      auth = await seedPool([a]);
      const fixture = await openSession(auth, { model: "codex", ui: true, script: ["usage-limit", "ok"], onUsageLimit: () => blockAccount(a) }); closers.push(fixture.close);
      await fixture.blockedPrompt();
      await awaitRetry(fixture);
      const joiningRejected = await fixture.session.fetchUsageReportsWithResetPolicy({ source: "manual" }).then(() => false, error => error instanceof Error ? error.message : String(error));
      result.blocked = { streamCalls: fixture.streamCalls, consumes: consumeSummary(), nativeRequestIdsAreUuids: consumes().every(request => uuidPattern.test(String(request.body?.redeem_request_id))),
        retries: fixture.retries, notices: fixture.notices, interactions: fixture.interactions.length, joiningRejected, attemptedKeys: [...fixture.coordinator.attemptedKeys] };
      break;
    }
    case "policy-no-blocked": {
      // N1: `no` exits before any eligibility IO, with or without an owner; the turn fails fast instead of spending.
      const a = account("a", { creditsExpireInMs: [2 * HOUR] });
      auth = await seedPool([a]);
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth));
      const fixture = await openSession(auth, { model: "codex", owner, script: ["usage-limit"], onUsageLimit: () => blockAccount(a) }); closers.push(fixture.close);
      const beforeBlock = transportRequests.length;
      await fixture.blockedPrompt();
      result.no = { streamCalls: fixture.streamCalls, requestsAfterBlock: transportRequests.slice(beforeBlock).map(request => request.route), consumes: consumes().length,
        ownerJournal: owner.journal, retries: fixture.retries, policy: (await fixture.session.fetchUsageReportsWithResetPolicy({ source: "manual" })).policy };
      break;
    }
    case "pool-blocked-restore-salvage": case "pool-reserve": case "pool-spark": {
      // N2: all-account blocked planning; siblings are pre-blocked so native credential rotation cannot pre-empt the pass.
      // Spark scopes credential blocks to its own meter (siblings would look free), so that case keeps a single
      // account whose only route is the salvage rule: the blocked-account rule is off for a Spark model.
      const spark = scenario === "pool-spark";
      const a = account("a", spark ? { creditsExpireInMs: [1 * HOUR], weeklyUsed: 0.6 } : { creditsExpireInMs: [20 * HOUR] });
      const b = account("b", { blocked: true, creditsExpireInMs: [1 * HOUR], primaryResetInMs: 4 * HOUR });
      const c = account("c", { blocked: true, creditsExpireInMs: [20 * HOUR], primaryResetInMs: 4 * HOUR });
      auth = await seedPool(spark ? [a] : [a, b, c]);
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth), { verifyPlanner: true });
      const fixture = await openSession(auth, { model: spark ? "spark" : "codex", owner, script: ["usage-limit", "ok"], onUsageLimit: () => blockAccount(a) });
      closers.push(fixture.close);
      await fixture.blockedPrompt();
      await awaitRetry(fixture);
      result.pool = { streamCalls: fixture.streamCalls, planned: plannedSnapshot(owner, "blocked"), expected: { primaryResetAtMs: a.usage.primaryResetAtMs, creditBExpiresAtMs: b.credits[0]!.expiresAtMs },
        consumes: consumeSummary(), finished: finishedSettlements(owner, "blocked"), owner: ownerEvidence(owner), retries: fixture.retries, notices: fixture.notices,
        config: (await readConfig()).parsed };
      break;
    }
    case "pool-other-provider-sweep": {
      // N2: another selected provider still salvages every eligible Codex account through the sweep.
      auth = await seedPool([account("a", { creditsExpireInMs: [3 * HOUR] }), account("b", { creditsExpireInMs: [1 * HOUR] }), account("c", { creditsExpireInMs: [30 * HOUR] })]);
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth), { verifyPlanner: true });
      const fixture = await openSession(auth, { model: "local", owner }); closers.push(fixture.close);
      const { policy } = await fixture.session.fetchUsageReportsWithResetPolicy({ source: "manual" });
      result.otherProvider = { policy, consumes: consumeSummary(), planned: plannedSnapshot(owner, "sweep"), owner: ownerEvidence(owner),
        finished: finishedSettlements(owner, "sweep"), notices: fixture.notices };
      break;
    }
    case "pool-synthesized-live429": {
      // N2: no usable report after the block; the planner synthesizes the active candidate with an unknown count and the owner resolves the credit live.
      const a = account("a", { creditsExpireInMs: [5 * HOUR] });
      auth = await seedPool([a]);
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth), { verifyPlanner: true });
      const fixture = await openSession(auth, { model: "codex", owner, script: ["usage-limit", "ok"], onUsageLimit: () => { a.usage.mode = "error"; } }); closers.push(fixture.close);
      await fixture.blockedPrompt();
      await awaitRetry(fixture);
      result.synthesized = { streamCalls: fixture.streamCalls, planned: plannedSnapshot(owner, "blocked"), consumes: consumeSummary(),
        finished: finishedSettlements(owner, "blocked"), owner: ownerEvidence(owner), retries: fixture.retries };
      break;
    }
    case "pool-stale-zero-gate": {
      // N2: a stale zero in the usage payload keeps the native sweep gate closed even though live credits exist.
      auth = await seedPool([account("a", { creditsExpireInMs: [1 * HOUR], reportedCount: 0 })]);
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth));
      const fixture = await openSession(auth, { model: "codex", owner }); closers.push(fixture.close);
      const { reports, policy } = await fixture.session.fetchUsageReportsWithResetPolicy({ source: "manual" });
      result.staleZero = { policy, reportedCount: reports?.[0]?.resetCredits?.availableCount ?? null, creditListings: transportRequests.filter(request => request.route === "credits").length,
        consumes: consumes().length, ownerJournal: owner.journal, sweepScheduled: fixture.coordinator.sweepPromise !== undefined };
      break;
    }
    case "sweep-zero-actions": {
      // Fast-settled owned pass: the sweep is scheduled, plans nothing, and the joining report method still aggregates it.
      auth = await seedPool([account("a", { creditsExpireInMs: [20 * HOUR] })]);
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth));
      const fixture = await openSession(auth, { model: "codex", owner }); closers.push(fixture.close);
      const { policy } = await fixture.session.fetchUsageReportsWithResetPolicy({ source: "manual" });
      result.zero = { policy, ownerJournal: owner.journal, finished: finishedSettlements(owner, "sweep"), consumes: consumes().length, admissions: owner.admissions.length };
      break;
    }
    case "report-binding-sweep-order": {
      const a = account("a", { creditsExpireInMs: [1 * HOUR], weeklyUsed: 0.6 });
      auth = await seedPool([a]);
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth), { verifyPlanner: true });
      const fixture = await openSession(auth, { model: "codex", owner }); closers.push(fixture.close);
      boundaryOrder.length = 0;
      const { policy } = await fixture.session.fetchUsageReportsWithResetPolicy({ source: "manual" });
      result.binding = { policy, boundaryOrder: [...boundaryOrder], owner: ownerEvidence(owner), planned: plannedSnapshot(owner, "sweep"),
        finished: finishedSettlements(owner, "sweep"), consumes: consumeSummary() };
      break;
    }
    case "report-binding-fetch-error": {
      const seeded = await seedPool([account("a", { creditsExpireInMs: [1 * HOUR] })]);
      const routed = new NativeAuthStorage(await SqliteAuthCredentialStore.open(getAgentDbPath(agentDir)), { usageFetch,
        fetchUsageReports: () => Promise.reject(new Error("controlled aggregate report failure")) });
      await routed.reload(); closers.push(async () => seeded.close()); auth = routed;
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth), { failCheckpoint: "finished" });
      const fixture = await openSession(auth, { model: "codex", owner }); closers.push(fixture.close);
      boundaryOrder.length = 0;
      let fetchError: string | undefined;
      try { await fixture.session.fetchUsageReportsWithResetPolicy({ source: "manual" }); }
      catch (error) { fetchError = error instanceof Error ? error.message : String(error); }
      const drained = await fixture.session.drainCodexResetPolicy();
      result.bindingError = { fetchError, drained, boundaryOrder: [...boundaryOrder], owner: ownerEvidence(owner), finished: finishedSettlements(owner, "sweep") };
      break;
    }
    case "report-binding-start-error": {
      auth = await seedPool([account("a", { creditsExpireInMs: [1 * HOUR] })]);
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth), { failCheckpoint: "started" });
      const fixture = await openSession(auth, { model: "codex", owner }); closers.push(fixture.close);
      boundaryOrder.length = 0;
      const { reports, policy } = await fixture.session.fetchUsageReportsWithResetPolicy({ source: "manual" });
      result.bindingStartError = { reportCount: reports?.length ?? null, policy, boundaryOrder: [...boundaryOrder], owner: ownerEvidence(owner),
        finished: finishedSettlements(owner, "sweep"), consumes: consumes().length };
      break;
    }
    case "clock-identity": {
      // N3: a late answer never drifts the captured absolute times; the same email in another org never substitutes.
      const a = account("a", { creditsExpireInMs: [20 * HOUR], email: "shared@example.com", orgId: "org-a" });
      const twin = account("a2", { blocked: true, creditsExpireInMs: [20 * HOUR], email: "shared@example.com", orgId: "org-a2", primaryResetInMs: 4 * HOUR });
      auth = await seedPool([a, twin]);
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth), { verifyPlanner: true });
      const fixture = await openSession(auth, { model: "codex", owner, ui: true, script: ["usage-limit", "ok"], onUsageLimit: () => blockAccount(a) }); closers.push(fixture.close);
      respondAll(fixture, "Yes", 1500);
      await fixture.blockedPrompt();
      await awaitRetry(fixture, 20_000);
      result.clock = { planned: plannedSnapshot(owner, "blocked"), primaryResetAtMs: a.usage.primaryResetAtMs, credentialIds: { a: a.credentialId, twin: twin.credentialId },
        interactions: fixture.interactions, resolutions: fixture.resolutions, streamCalls: fixture.streamCalls, consumes: consumeSummary(),
        owner: ownerEvidence(owner), finished: finishedSettlements(owner, "blocked"), config: (await readConfig()).parsed };
      break;
    }
    case "retarget-account-started": {
      // N3: pinning another account after the pass captured its identity never retargets the original blocked
      // account: the immutable pass identity stays A, and the moved active identity holds admission before any POST.
      const a = account("a", { creditsExpireInMs: [20 * HOUR] });
      const b = account("b", { blocked: true, creditsExpireInMs: [20 * HOUR], primaryResetInMs: 4 * HOUR });
      auth = await seedPool([a, b]);
      let fixtureRef: SessionFixture | undefined, pinned: boolean | undefined;
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth), { verifyPlanner: true, onCheckpoint: event => {
        if (event.phase === "started") pinned = auth!.pinSessionOAuthAccount("openai-codex", fixtureRef!.session.sessionId, b.credentialId!);
      } });
      const fixture = await openSession(auth, { model: "codex", owner, script: ["usage-limit"], onUsageLimit: () => blockAccount(a) });
      fixtureRef = fixture; closers.push(fixture.close);
      await fixture.blockedPrompt();
      result.retarget = { pinned, planned: plannedSnapshot(owner, "blocked"), consumes: consumeSummary(), owner: ownerEvidence(owner), finished: finishedSettlements(owner, "blocked"),
        identityAfter: auth.getOAuthAccountIdentity("openai-codex", fixture.session.sessionId), notices: fixture.notices };
      break;
    }
    case "retarget-model-started": case "retarget-model-planned": {
      // N3: a model/selection change before dispatch holds the blocked pass; nothing is admitted or spent.
      const a = account("a", { creditsExpireInMs: [20 * HOUR] });
      auth = await seedPool([a]);
      let fixtureRef: SessionFixture | undefined, switched: unknown;
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth), { onCheckpoint: async event => {
        if (event.phase === (scenario === "retarget-model-started" ? "started" : "planned")) switched = await fixtureRef!.session.setModelTemporary(fixtureRef!.registry.find("plan-fixture", "base")!);
      } });
      const fixture = await openSession(auth, { model: "codex", owner, script: ["usage-limit"], onUsageLimit: () => blockAccount(a) });
      fixtureRef = fixture; closers.push(fixture.close);
      await fixture.blockedPrompt();
      result.retarget = { switched: switched ?? null, modelAfter: fixture.session.model?.provider, planned: plannedSnapshot(owner, "blocked"), admissions: owner.admissions.length,
        consumes: consumes().length, finished: finishedSettlements(owner, "blocked"), notices: fixture.notices };
      break;
    }
    case "guard-refused": case "guard-policy-change": case "identity-removed": {
      // N3: the synchronous U1 guard refuses (owner false / native policy recheck), or the credential vanishes before dispatch.
      const a = account("a", { creditsExpireInMs: [20 * HOUR] });
      auth = await seedPool([a]);
      let fixtureRef: SessionFixture | undefined;
      const knobs: OwnerKnobs = scenario === "guard-refused" ? { guard: false } : scenario === "identity-removed" ? { admit: "remove-credential" }
        : { onAdmit: () => { fixtureRef!.settings.override("codexResets.keepCredits", 1); } };
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth), knobs);
      const fixture = await openSession(auth, { model: "codex", owner, script: ["usage-limit"], onUsageLimit: () => blockAccount(a) });
      fixtureRef = fixture; closers.push(fixture.close);
      await fixture.blockedPrompt();
      result.guard = { streamCalls: fixture.streamCalls, consumes: consumes().length, owner: ownerEvidence(owner), finished: finishedSettlements(owner, "blocked"),
        deferredKeys: [...fixture.coordinator.deferredUntilByKey.keys()], attemptedKeys: [...fixture.coordinator.attemptedKeys], notices: fixture.notices, retries: fixture.retries };
      break;
    }
    case "decision-yes": case "decision-no": case "decision-dismiss": {
      // N4: one whole-plan native select; exact native wording; Yes/No/dismiss effects on the real global config; a second client answer is rejected.
      const a = account("a", { creditsExpireInMs: [20 * HOUR] });
      const b = account("b", { blocked: true, creditsExpireInMs: [1 * HOUR], primaryResetInMs: 4 * HOUR });
      auth = await seedPool([a, b]);
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth));
      const fixture = await openSession(auth, { model: "codex", owner, ui: true, script: ["usage-limit", "ok"], onUsageLimit: () => blockAccount(a) }); closers.push(fixture.close);
      let secondResponseRejected: string | undefined;
      fixture.setInteractionHandler(interaction => {
        const answer = scenario === "decision-yes" ? { value: "Yes" } : scenario === "decision-no" ? { value: "No" } : { cancel: true as const };
        fixture.bridge!.respond(interaction.id, answer);
        try { fixture.bridge!.respond(interaction.id, { value: "Yes" }); } catch (error) { secondResponseRejected = error instanceof Error ? error.message : String(error); }
      });
      await fixture.blockedPrompt();
      if (scenario === "decision-yes") await awaitRetry(fixture);
      const beforeSecond = owner.journal.length;
      const second = await fixture.session.fetchUsageReportsWithResetPolicy({ source: "manual" });
      const config = await readConfig();
      result.decision = { interactions: fixture.interactions, resolutions: fixture.resolutions, secondResponseRejected, streamCalls: fixture.streamCalls,
        consumes: consumeSummary(), owner: ownerEvidence(owner), finished: finishedSettlements(owner, "blocked"),
        effectiveAutoRedeem: fixture.settings.get("codexResets.autoRedeem"), persistedAutoRedeem: (config.parsed.codexResets as Record<string, unknown> | undefined)?.autoRedeem,
        configUnchanged: config.bytes.equals(originalConfigBytes), configRest: { ...config.parsed, codexResets: undefined },
        secondFetch: { policy: second.policy, ownedCheckpoints: owner.journal.slice(beforeSecond), consumes: consumes().length }, notices: fixture.notices, retries: fixture.retries };
      break;
    }
    case "decision-headless": {
      // N4: no UI keeps the one-shot native notice and journals "no answer"; nothing is written or spent.
      const a = account("a", { creditsExpireInMs: [20 * HOUR] });
      auth = await seedPool([a]);
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth));
      const fixture = await openSession(auth, { model: "codex", owner, script: ["usage-limit"], onUsageLimit: () => blockAccount(a) }); closers.push(fixture.close);
      await fixture.blockedPrompt();
      result.headless = { owner: ownerEvidence(owner), finished: finishedSettlements(owner, "blocked"), consumes: consumes().length,
        notices: fixture.notices, notifiedKeys: [...fixture.coordinator.notifiedKeys], configUnchanged: (await readConfig()).bytes.equals(originalConfigBytes) };
      break;
    }
    case "settings-flush-throws": case "settings-unrelated-key-merge": case "settings-project-shadow": case "settings-runtime-change": case "settings-conflicting-readback": {
      // N5: real global config writes proven by the owner — throwing save (read-only physical target), unrelated external
      // edit merge, pre-existing project `unset` shadow, and a runtime policy change under the prompt.
      const a = account("a", { creditsExpireInMs: [20 * HOUR] });
      auth = await seedPool([a]);
      let fixtureRef: SessionFixture | undefined;
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth), { beforeAnswer: async () => {
        if (scenario === "settings-flush-throws") {
          const locked = path.join(directory, "locked"); await mkdir(locked, { recursive: true });
          await rename(configPath, path.join(locked, "config.yml")); await symlink(path.join(locked, "config.yml"), configPath);
          await chmod(locked, 0o555); restoreLockedDir = locked;
        } else if (scenario === "settings-unrelated-key-merge") {
          await writeFile(configPath, `${configText}defaultThinkingLevel: high\n`);
        } else if (scenario === "settings-runtime-change") {
          fixtureRef!.settings.override("codexResets.autoRedeem", "no");
        }
      }, onCheckpoint: async event => {
        if (scenario === "settings-conflicting-readback" && event.phase === "setting-written") {
          await fixtureRef!.settings.flush();
          await writeFile(configPath, configText.replace("autoRedeem: unset", "autoRedeem: no"));
        }
      } });
      const fixture = await openSession(auth, { model: "codex", owner, ui: true, script: ["usage-limit", "ok"], onUsageLimit: () => blockAccount(a) });
      fixtureRef = fixture; closers.push(fixture.close);
      respondAll(fixture, "Yes");
      await fixture.blockedPrompt();
      if (scenario === "settings-unrelated-key-merge" || scenario === "settings-project-shadow") await awaitRetry(fixture);
      if (restoreLockedDir) await chmod(restoreLockedDir, 0o755);
      const config = await readConfig();
      result.settings = { owner: ownerEvidence(owner), finished: finishedSettlements(owner, "blocked"), consumes: consumes().length, streamCalls: fixture.streamCalls,
        persisted: config.parsed, effectiveAutoRedeem: fixture.settings.get("codexResets.autoRedeem"), configUnchanged: config.bytes.equals(originalConfigBytes),
        projectConfig: scenario === "settings-project-shadow" ? await readFile(path.join(cwd, ".omp", "config.yml"), "utf8") : undefined, notices: fixture.notices };
      break;
    }
    case "outcome-unknown-fence": case "outcome-future-fence": case "nothing-to-reset-reenter": {
      // N7: sweep-driven — an owned malformed 2xx becomes `outcome_unknown` and fences the account across a later
      // trigger/key; a known `nothing_to_reset` re-enters only through a fresh native plan after its defer.
      const a = account("a", { creditsExpireInMs: [2 * HOUR], weeklyUsed: 0.6,
        consume: scenario === "outcome-unknown-fence" ? "malformed" : scenario === "outcome-future-fence" ? "future" : "nothing_to_reset" });
      auth = await seedPool([a]);
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth));
      const fixture = await openSession(auth, { model: "codex", owner }); closers.push(fixture.close);
      const first = (await fixture.session.fetchUsageReportsWithResetPolicy({ source: "manual" })).policy;
      const deferredAfterFirst = [...fixture.coordinator.deferredUntilByKey.entries()].map(([key, until]) => ({ key, deferredForMs: until - Date.now() }));
      // Simulated clock advance on this subprocess's native coordinator: sweep floor and per-account cooldown elapse.
      fixture.coordinator.lastSweepAt = 0; fixture.coordinator.lastAttemptAtByAccount.clear();
      const stillDeferred = (await fixture.session.fetchUsageReportsWithResetPolicy({ source: "manual" })).policy;
      const admissionsWhileDeferred = owner.admissions.length;
      // Beyond the native 30-minute defer: only then can a fresh native plan re-enter the episode.
      for (const key of fixture.coordinator.deferredUntilByKey.keys()) fixture.coordinator.deferredUntilByKey.set(key, Date.now() - 1);
      fixture.coordinator.lastSweepAt = 0; fixture.coordinator.lastAttemptAtByAccount.clear();
      a.consume = "reset";
      const third = (await fixture.session.fetchUsageReportsWithResetPolicy({ source: "manual" })).policy;
      result.outcome = { first, stillDeferred, third, deferredAfterFirst, admissionsWhileDeferred, consumes: consumeSummary(),
        owner: ownerEvidence(owner), finished: finishedSettlements(owner, "sweep"), notices: fixture.notices };
      break;
    }
    case "outcome-throw": case "outcome-timeout": {
      // N7: thrown transport failure or the native 15s consume timeout: paired error completion, native defer, unknown fence.
      const a = account("a", { creditsExpireInMs: [2 * HOUR], weeklyUsed: 0.6, consume: scenario === "outcome-throw" ? "throw" : "hang" });
      auth = await seedPool([a]);
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth));
      const fixture = await openSession(auth, { model: "codex", owner }); closers.push(fixture.close);
      const startedAt = Date.now();
      const { policy } = await fixture.session.fetchUsageReportsWithResetPolicy({ source: "manual" });
      fixture.coordinator.lastSweepAt = 0; fixture.coordinator.lastAttemptAtByAccount.clear();
      for (const key of fixture.coordinator.deferredUntilByKey.keys()) fixture.coordinator.deferredUntilByKey.set(key, Date.now() - 1);
      a.consume = "reset";
      const afterFence = (await fixture.session.fetchUsageReportsWithResetPolicy({ source: "manual" })).policy;
      result.outcome = { policy, afterFence, elapsedMs: Date.now() - startedAt, consumes: consumes().length, owner: ownerEvidence(owner), finished: finishedSettlements(owner, "sweep"),
        deferredKeys: [...fixture.coordinator.deferredUntilByKey.keys()], notices: fixture.notices };
      break;
    }
    case "refresh-failed-retains-reset": case "complete-throws": case "checkpoint-planned-throws": case "admit-throws": {
      // N8: post-reset refresh failure, a throwing completion, a pre-dispatch checkpoint rejection, or a throwing admission.
      const a = account("a", { creditsExpireInMs: [20 * HOUR] });
      const b = account("b", { blocked: true, creditsExpireInMs: [1 * HOUR], primaryResetInMs: 4 * HOUR });
      const seeded = await seedPool([a, b]);
      auth = seeded;
      if (scenario === "refresh-failed-retains-reset") {
        // The local per-credential fan-out swallows transport failures, so the only native way a report
        // refresh rejects is the aggregate `fetchUsageReports` seam (broker-style). Delegate to the real
        // fan-out of the seeded store and reject only after the consume was dispatched.
        let refreshFails = false;
        void watchRoute("consume").then(() => { refreshFails = true; });
        const routed = new NativeAuthStorage(await SqliteAuthCredentialStore.open(getAgentDbPath(agentDir)), { usageFetch, fetchUsageReports: signal => refreshFails
          ? Promise.reject(new Error("controlled post-reset report refresh failure")) : seeded.fetchUsageReports({ signal }) });
        await routed.reload();
        closers.push(async () => seeded.close());
        auth = routed;
      }
      const knobs: OwnerKnobs = scenario === "complete-throws" ? { failComplete: true } : scenario === "checkpoint-planned-throws" ? { failCheckpoint: "planned" }
        : scenario === "admit-throws" ? { failAdmit: true } : {};
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth), knobs);
      const fixture = await openSession(auth, { model: "codex", owner, script: ["usage-limit", "ok"], onUsageLimit: () => blockAccount(a) }); closers.push(fixture.close);
      await fixture.blockedPrompt();
      if (scenario === "refresh-failed-retains-reset" || scenario === "complete-throws") await awaitRetry(fixture).catch(() => {});
      await fixture.session.drainCodexResetPolicy();
      result.completion = { streamCalls: fixture.streamCalls, consumes: consumeSummary(), owner: ownerEvidence(owner), finished: finishedSettlements(owner, "blocked"),
        notices: fixture.notices, retries: fixture.retries };
      break;
    }
    case "present-throws": {
      // Callback failure propagation: presentDecision throwing after the native select withholds consent without a write or spend.
      const a = account("a", { creditsExpireInMs: [20 * HOUR] });
      auth = await seedPool([a]);
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth), { failPresent: true });
      const fixture = await openSession(auth, { model: "codex", owner, ui: true, script: ["usage-limit"], onUsageLimit: () => blockAccount(a) }); closers.push(fixture.close);
      respondAll(fixture, "Yes");
      await fixture.blockedPrompt();
      result.present = { owner: ownerEvidence(owner), finished: finishedSettlements(owner, "blocked"), consumes: consumes().length, streamCalls: fixture.streamCalls,
        configUnchanged: (await readConfig()).bytes.equals(originalConfigBytes), retries: fixture.retries };
      break;
    }
    case "join-sweep-provenance": {
      // N8: both SDK sessions use the real process coordinator. The second refresh adopts the
      // original sweep's receipt instead of admitting another plan or attributing another spend.
      const b = account("b", { creditsExpireInMs: [1 * HOUR], weeklyUsed: 0.6 });
      auth = await seedPool([b]);
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth));
      const first = await openSession(auth, { model: "codex", owner }); closers.push(first.close);
      const second = await openSession(auth, { model: "codex", owner }); closers.push(second.close);
      const hold = holdRoute("consume");
      const firstRun = first.session.fetchUsageReportsWithResetPolicy({ source: "manual" });
      await hold.reached;
      const secondRun = second.session.fetchUsageReportsWithResetPolicy({ source: "background" });
      const secondSettledBeforeRelease = await settledWithin(secondRun, 300);
      hold.release();
      const [firstPolicy, secondPolicy] = await Promise.all([firstRun, secondRun]);
      result.join = { firstPolicy: firstPolicy.policy, secondPolicy: secondPolicy.policy, secondSettledBeforeRelease, consumes: consumes().length,
        owner: ownerEvidence(owner), finished: finishedSettlements(owner, "sweep"), notices: { first: first.notices, second: second.notices } };
      break;
    }
    case "join-blocked-provenance":
    case "join-checkpoint-throws": {
      // N8: two sessions share the process coordinator and hit the same account's live 429 together; the second blocked
      // pass adopts the original pass, journals `joined` against its real pass id, spends nothing and still retries.
      const a = account("a", { creditsExpireInMs: [20 * HOUR] });
      auth = await seedPool([a]);
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth),
        scenario === "join-checkpoint-throws" ? { failCheckpoint: "joined" } : {});
      let arrivals = 0; const barrier = Promise.withResolvers<void>();
      const onUsageLimit = () => { blockAccount(a); if (++arrivals === 2) barrier.resolve(); return barrier.promise; };
      const first = await openSession(auth, { model: "codex", owner, script: ["usage-limit", "ok"], onUsageLimit }); closers.push(first.close);
      const second = await openSession(auth, { model: "codex", owner, script: ["usage-limit", "ok"], onUsageLimit }); closers.push(second.close);
      const hold = holdRoute("consume");
      const prompts = Promise.all([first.blockedPrompt(), second.blockedPrompt()]);
      await hold.reached;
      const joinedInTime = await settledWithin(waitFor(() => owner.journal.some(entry => entry.phase === "joined"), "the joined checkpoint", 5_000), 5_500);
      hold.release();
      await prompts;
      await Promise.all([awaitRetry(first).catch(() => {}), awaitRetry(second).catch(() => {})]);
      const originalPassId = (owner.journal.find(entry => entry.phase === "started")?.pass as { passId: string } | undefined)?.passId;
      result.join = { joinedInTime, originalPassId, joined: owner.journal.filter(entry => entry.phase === "joined"), consumes: consumeSummary(),
        streamCalls: { first: first.streamCalls, second: second.streamCalls }, finished: finishedSettlements(owner, "blocked"), owner: ownerEvidence(owner),
        notices: { first: first.notices, second: second.notices } };
      break;
    }
    case "dispose-during-select": {
      // N9: begin-dispose during the native select aborts it; no consent, no write, no spend.
      const a = account("a", { creditsExpireInMs: [20 * HOUR] });
      auth = await seedPool([a]);
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth));
      const fixture = await openSession(auth, { model: "codex", owner, ui: true, script: ["usage-limit"], onUsageLimit: () => blockAccount(a) }); closers.push(fixture.close);
      let drain: ReturnType<AgentSession["drainCodexResetPolicy"]> | undefined;
      fixture.setInteractionHandler(() => { fixture.session.beginDispose(); drain = fixture.session.drainCodexResetPolicy(); });
      await fixture.session.prompt("Controlled prompt that meets a usage limit.").catch(() => {});
      assert.ok(drain, "The select must start a drain while its owned pass is pending");
      const drained = await drain;
      result.dispose = { interactions: fixture.interactions.length, resolutions: fixture.resolutions, owner: ownerEvidence(owner), finished: finishedSettlements(owner, "blocked"),
        drained, consumes: consumes().length, configUnchanged: (await readConfig()).bytes.equals(originalConfigBytes) };
      break;
    }
    case "dispose-during-eligibility": {
      // N9: begin-dispose while the pass is still fetching eligibility prevents dispatch; drain waits for the pending
      // eligibility work rather than resolving early.
      const a = account("a", { creditsExpireInMs: [20 * HOUR] });
      auth = await seedPool([a]);
      // The gate is armed at the `started` checkpoint, so only the pass's own eligibility fetch (it always invalidates
      // the usage cache first) can be held; pre-pass usage reads pass through ungated.
      let hold: RouteHold | undefined;
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth), { onCheckpoint: event => { if (event.phase === "started") hold = holdRoute("usage"); } });
      const fixture = await openSession(auth, { model: "codex", owner, script: ["usage-limit"], onUsageLimit: () => blockAccount(a) });
      closers.push(fixture.close);
      const prompt = fixture.session.prompt("Controlled prompt that meets a usage limit.").catch(() => {});
      await waitFor(() => hold !== undefined, "the owned pass to start");
      await hold!.reached;
      fixture.session.beginDispose();
      const drain = fixture.session.drainCodexResetPolicy();
      const drainSettledWhilePending = await settledWithin(drain, 300);
      hold!.release();
      const drained = await drain;
      const promptSettled = await settledWithin(prompt, 5_000);
      result.dispose = { drainSettledWhilePending, drained, promptSettled, owner: ownerEvidence(owner), finished: finishedSettlements(owner, "blocked"), consumes: consumes().length,
        admissions: owner.admissions.length, notices: fixture.notices };
      break;
    }
    case "dispose-during-consume": {
      // N9: begin-dispose during a dispatched consume keeps the bounded consume, journals its outcome against the
      // original owner, admits nothing further, and drain waits only for this session's work.
      const a = account("a", { creditsExpireInMs: [20 * HOUR] });
      const b = account("b", { blocked: true, creditsExpireInMs: [1 * HOUR], primaryResetInMs: 4 * HOUR });
      auth = await seedPool([a, b]);
      const owner = new FixtureOwner(auth, await readOnlyRegistry(auth));
      const fixture = await openSession(auth, { model: "codex", owner, script: ["usage-limit"], onUsageLimit: () => blockAccount(a) }); closers.push(fixture.close);
      const unrelated = await openSession(auth, { model: "codex", owner }); closers.push(unrelated.close);
      const hold = holdRoute("consume");
      const prompt = fixture.session.prompt("Controlled prompt that meets a usage limit.").catch(() => {});
      const reachedRequest = await hold.reached;
      fixture.session.beginDispose();
      const disposing = fixture.session.dispose();
      const unrelatedDrain = unrelated.session.drainCodexResetPolicy();
      const unrelatedDrainPrompt = await settledWithin(unrelatedDrain, 1000);
      const drainBlockedWhileConsumeHeld = !(await settledWithin(fixture.session.drainCodexResetPolicy(), 300));
      hold.release();
      const drained = await fixture.session.drainCodexResetPolicy();
      await disposing;
      const promptSettled = await settledWithin(prompt, 5_000);
      result.dispose = { reachedAccount: reachedRequest.account, unrelatedDrainPrompt, unrelatedDrained: await unrelatedDrain, drainBlockedWhileConsumeHeld, drained, promptSettled,
        consumes: consumeSummary(), owner: ownerEvidence(owner), finished: finishedSettlements(owner, "blocked"), notices: fixture.notices };
      break;
    }
    default: assert.fail(`Scenario ${scenario} has no implementation`);
  }
} finally {
  for (const close of closers.reverse()) await close().catch(() => {});
  auth?.close();
  if (restoreLockedDir) await chmod(restoreLockedDir, 0o755).catch(() => {});
}
result.blockedFetches = blockedFetches;
result.blockedNetworkAttempts = blockedNetworkAttempts;
result.escapedTransport = escapedTransport;
result.transport = transportRequests.map(request => ({ method: request.method, route: request.route, account: request.account }));
result.configUnchanged = (await readFile(configPath)).equals(originalConfigBytes);
console.log(JSON.stringify(result));
