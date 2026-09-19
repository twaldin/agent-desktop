import type {
	ResetCheckpoint,
	ResetObservation,
	ResetPass,
	ResetPermit,
	ResetPlanSnapshot,
} from "@oh-my-pi/pi-coding-agent";
import type { ResetCreditConsumeIdentity } from "@oh-my-pi/pi-ai";

export const RESET_POLICY_MAX_INFLIGHT = 128;
export const RESET_POLICY_MAX_ACTIONS = 128;
export const RESET_POLICY_MAX_SKIPPED = 2_048;
export const RESET_POLICY_MAX_SERIALIZED_BYTES = 1_048_576;

const MAX_ID = 512;
const MAX_TEXT = 4_096;
const MAX_ERROR_TEXT = 2_048;

export type ResetPassWire = ResetPass;
export type ResetPlanSnapshotWire = ResetPlanSnapshot;
export type ResetPermitWire = Omit<ResetPermit, "beforeConsume">;
export type ResetCheckpointWire = ResetCheckpoint;
export type ResetObservationWire = Readonly<{
	consumeBoundary: ResetObservation["consumeBoundary"];
	result:
		| Extract<ResetObservation["result"], { kind: "outcome" }>
		| { kind: "error"; error: ResetPolicyWireError };
}>;
export type ResetConsumeIdentityWire = Readonly<ResetCreditConsumeIdentity>;
export type ResetPolicyWireError = Readonly<{ name: string; message: string }>;
export type ResetPolicyWireBinding = Readonly<{ workerEpoch: string; rootSessionId: string }>;

/** Private child-to-owning-host evidence. No credential material is carried. The
 * host adapter must require the evidence matching its phase before mutation. */
export type ResetPolicyWireAccount = Readonly<{
  provider: "openai-codex"; baseUrl?: string; accountId?: string; email?: string;
  orgId?: string; projectId?: string; credentialId: number;
  credentialFingerprint: string; authAuthority: string; emailUnambiguous?: boolean;
}>;
export type ResetPolicyWireCredit = Readonly<{ id: string; status: "available"; expiresAt?: string; fingerprint: string }>;
export type ResetPolicyWireEvidence =
  | Readonly<{ kind: "source"; selectionRevision: string; policyRevision: string }>
  | Readonly<{ kind: "plan"; accounts: readonly ResetPolicyWireAccount[] }>
  | Readonly<{ kind: "persistence"; status: "verified" | "failed"; globalMode?: "yes" | "no";
      effectivePolicy?: ResetPass["policy"]; layersUnchanged?: boolean; policyRevision?: string }>
  | Readonly<{ kind: "admission"; selectionRevision: string; policyRevision: string;
      account: ResetPolicyWireAccount; credit: ResetPolicyWireCredit }>;

export type ResetPolicyWireOperation =
	| Readonly<{ kind: "checkpoint"; event: ResetCheckpointWire }>
	| Readonly<{ kind: "decision.prepare"; snapshot: ResetPlanSnapshotWire }>
	| Readonly<{ kind: "decision.bind"; decisionId: string; interactionId: string }>
	| Readonly<{ kind: "admit"; snapshot: ResetPlanSnapshotWire; actionIndex: number }>
	| Readonly<{ kind: "join"; joinId: string }>
	| Readonly<{ kind: "complete"; permit: ResetPermitWire; observation: ResetObservationWire }>;

export type ResetPolicyWireResult =
	| Readonly<{ kind: "checkpointed" }>
	| Readonly<{ kind: "decision.prepared"; decisionId: string }>
	| Readonly<{ kind: "decision.bound" }>
	| Readonly<{ kind: "admission.hold"; reason: "unknown" | "stale" | "identity-unresolved" | "credit-unavailable" | "owner-unavailable" }>
	| Readonly<{ kind: "admission.execute"; permit: ResetPermitWire; consumeIdentity: ResetConsumeIdentityWire }>
	| Readonly<{ kind: "admission.join"; attemptId: string; joinId: string }>
	| Readonly<{ kind: "joined"; observation: ResetObservationWire }>
	| Readonly<{ kind: "completed" }>;

export type ResetPolicyWireRequest = Readonly<{
	type: "resetPolicyRequest";
	requestId: number;
	binding: ResetPolicyWireBinding;
	nativeSessionId: string;
	passId: string;
	operation: ResetPolicyWireOperation;
	evidence?: ResetPolicyWireEvidence;
}>;

export type ResetPolicyWireResponse = Readonly<{
	type: "resetPolicyResponse";
	requestId: number;
	binding: ResetPolicyWireBinding;
	response: Readonly<{ ok: true; result: ResetPolicyWireResult }> | Readonly<{ ok: false; error: ResetPolicyWireError }>;
}>;

type Dict = Record<string, unknown>;

function fail(message: string): never { throw new Error(`Invalid reset-policy wire packet: ${message}`); }
function object(value: unknown, label: string): Dict {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
	return value as Dict;
}
function exact(value: Dict, keys: readonly string[], label: string): void {
	const allowed = new Set(keys);
	for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label}.${key} is not allowed`);
}
function string(value: unknown, label: string, max = MAX_TEXT): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max) fail(`${label} must be a bounded non-empty string`);
	return value;
}
function optionalString(value: unknown, label: string, max = MAX_TEXT): string | undefined {
	return value === undefined ? undefined : string(value, label, max);
}
function finite(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be finite`);
	return value;
}
function integer(value: unknown, label: string, minimum = 0): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(`${label} must be a safe integer`);
	return value as number;
}
function boolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") fail(`${label} must be boolean`);
	return value;
}
function member<T extends string>(value: unknown, choices: readonly T[], label: string): T {
	if (typeof value !== "string" || !choices.includes(value as T)) fail(`${label} is unknown`);
	return value as T;
}
function array(value: unknown, label: string, maximum: number): unknown[] {
	if (!Array.isArray(value) || value.length > maximum) fail(`${label} exceeds its bound`);
	for (let index = 0; index < value.length; index++) if (!(index in value)) fail(`${label} must not be sparse`);
	return value;
}
function present<T extends Dict>(source: Dict, target: T, key: string, value: unknown): void {
	if (key in source) (target as Dict)[key] = value;
}
function freeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const item of Object.values(value as Dict)) freeze(item);
	}
	return value;
}

export function serializedResetPolicyWireBytes(value: unknown): number {
	let encoded: string;
	try { encoded = JSON.stringify(value); } catch { return Number.POSITIVE_INFINITY; }
	if (encoded === undefined) return Number.POSITIVE_INFINITY;
	return new TextEncoder().encode(encoded).byteLength;
}

export function assertResetPolicyWireSize(value: unknown): void {
	if (serializedResetPolicyWireBytes(value) > RESET_POLICY_MAX_SERIALIZED_BYTES) fail("packet exceeds 1 MiB");
}

export function projectResetPolicyError(error: unknown): ResetPolicyWireError {
	const name = error instanceof Error ? error.name : "Error";
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown reset-policy owner error";
	return freeze({ name: name.slice(0, MAX_ID) || "Error", message: message.slice(0, MAX_ERROR_TEXT) || "Unknown reset-policy owner error" });
}

function binding(value: unknown, label: string): ResetPolicyWireBinding {
	const input = object(value, label); exact(input, ["workerEpoch", "rootSessionId"], label);
	return { workerEpoch: string(input.workerEpoch, `${label}.workerEpoch`, MAX_ID), rootSessionId: string(input.rootSessionId, `${label}.rootSessionId`, MAX_ID) };
}

function assertBinding(actual: ResetPolicyWireBinding, expected?: ResetPolicyWireBinding): void {
	if (expected && (actual.workerEpoch !== expected.workerEpoch || actual.rootSessionId !== expected.rootSessionId)) fail("foreign worker binding");
}

function policy(value: unknown, label: string) {
	const input = object(value, label); exact(input, ["autoRedeem", "minBlockedMinutes", "keepCredits", "salvageHorizonHours"], label);
	return { autoRedeem: member(input.autoRedeem, ["unset", "yes", "no"] as const, `${label}.autoRedeem`), minBlockedMinutes: finite(input.minBlockedMinutes, `${label}.minBlockedMinutes`), keepCredits: finite(input.keepCredits, `${label}.keepCredits`), salvageHorizonHours: finite(input.salvageHorizonHours, `${label}.salvageHorizonHours`) };
}

function identity(value: unknown, label: string) {
	if (value === undefined) return undefined;
	const input = object(value, label); exact(input, ["accountId", "email", "projectId", "orgId", "orgName"], label);
	const output: Dict = {};
	for (const key of ["accountId", "email", "projectId", "orgId", "orgName"] as const) present(input, output, key, optionalString(input[key], `${label}.${key}`));
	return output;
}

function pass(value: unknown, label: string): ResetPassWire {
	const input = object(value, label); exact(input, ["passId", "nativeSessionId", "trigger", "source", "startedAtMs", "provider", "modelId", "codexBaseUrl", "identity", "activeBlockUnblockAtMs", "policy"], label);
	const output: Dict = { passId: string(input.passId, `${label}.passId`, MAX_ID), nativeSessionId: string(input.nativeSessionId, `${label}.nativeSessionId`, MAX_ID), trigger: member(input.trigger, ["blocked", "sweep"] as const, `${label}.trigger`), source: member(input.source, ["manual", "background", "blocked"] as const, `${label}.source`), startedAtMs: finite(input.startedAtMs, `${label}.startedAtMs`), provider: string(input.provider, `${label}.provider`, MAX_ID), modelId: string(input.modelId, `${label}.modelId`, MAX_ID), policy: policy(input.policy, `${label}.policy`) };
	present(input, output, "codexBaseUrl", optionalString(input.codexBaseUrl, `${label}.codexBaseUrl`));
	present(input, output, "identity", identity(input.identity, `${label}.identity`));
	present(input, output, "activeBlockUnblockAtMs", input.activeBlockUnblockAtMs === undefined ? undefined : finite(input.activeBlockUnblockAtMs, `${label}.activeBlockUnblockAtMs`));
	return output as ResetPassWire;
}

function target(value: unknown, label: string) {
	const input = object(value, label); exact(input, ["credentialId", "accountId", "email"], label); const output: Dict = {};
	present(input, output, "credentialId", input.credentialId === undefined ? undefined : integer(input.credentialId, `${label}.credentialId`));
	present(input, output, "accountId", optionalString(input.accountId, `${label}.accountId`)); present(input, output, "email", optionalString(input.email, `${label}.email`)); return output;
}

function action(value: unknown, label: string) {
	const input = object(value, label); exact(input, ["reason", "target", "accountKey", "attemptKey", "label", "availableCount", "weeklyUsedFraction", "remainingMs", "blockedWindows", "salvageWindow", "salvageUsedFraction", "expiresInMs", "active"], label);
	const output: Dict = { reason: member(input.reason, ["blocked-account", "expiring-credit"] as const, `${label}.reason`), target: target(input.target, `${label}.target`), accountKey: string(input.accountKey, `${label}.accountKey`), attemptKey: string(input.attemptKey, `${label}.attemptKey`), label: string(input.label, `${label}.label`), active: boolean(input.active, `${label}.active`) };
	for (const key of ["availableCount", "weeklyUsedFraction", "remainingMs", "salvageUsedFraction", "expiresInMs"] as const) present(input, output, key, input[key] === undefined ? undefined : finite(input[key], `${label}.${key}`));
	present(input, output, "blockedWindows", input.blockedWindows === undefined ? undefined : array(input.blockedWindows, `${label}.blockedWindows`, 2).map((item, index) => member(item, ["5h", "weekly"] as const, `${label}.blockedWindows[${index}]`)));
	present(input, output, "salvageWindow", input.salvageWindow === undefined ? undefined : member(input.salvageWindow, ["5h", "weekly"] as const, `${label}.salvageWindow`));
	return output;
}

function skip(value: unknown, label: string) {
	const input = object(value, label); exact(input, ["accountKey", "rule", "reason"], label);
	return { accountKey: string(input.accountKey, `${label}.accountKey`), rule: member(input.rule, ["blocked-account", "expiring-credit", "account"] as const, `${label}.rule`), reason: string(input.reason, `${label}.reason`, MAX_ID) };
}

function snapshot(value: unknown, label: string): ResetPlanSnapshotWire {
	const input = object(value, label); exact(input, ["pass", "plannedAtMs", "reportRevision", "plan"], label); const planInput = object(input.plan, `${label}.plan`); exact(planInput, ["actions", "skipped"], `${label}.plan`);
	return { pass: pass(input.pass, `${label}.pass`), plannedAtMs: finite(input.plannedAtMs, `${label}.plannedAtMs`), reportRevision: digest(input.reportRevision, `${label}.reportRevision`), plan: { actions: array(planInput.actions, `${label}.plan.actions`, RESET_POLICY_MAX_ACTIONS).map((item, index) => action(item, `${label}.plan.actions[${index}]`)), skipped: array(planInput.skipped, `${label}.plan.skipped`, RESET_POLICY_MAX_SKIPPED).map((item, index) => skip(item, `${label}.plan.skipped[${index}]`)) } } as unknown as ResetPlanSnapshotWire;
}

function settlement(value: unknown, label: string) {
	const input = object(value, label); exact(input, ["state", "applied", "attemptIds", "refresh"], label);
	return { state: member(input.state, ["settled", "held", "cancelled", "failed"] as const, `${label}.state`), applied: integer(input.applied, `${label}.applied`), attemptIds: array(input.attemptIds, `${label}.attemptIds`, RESET_POLICY_MAX_ACTIONS).map((item, index) => string(item, `${label}.attemptIds[${index}]`, MAX_ID)), refresh: member(input.refresh, ["not-needed", "complete", "failed"] as const, `${label}.refresh`) };
}

function checkpoint(value: unknown, label: string): ResetCheckpointWire {
	const input = object(value, label); const phase = member(input.phase, ["started", "planned", "joined", "answer", "setting-written", "finished"] as const, `${label}.phase`);
	if (phase === "started") { exact(input, ["phase", "pass"], label); return { phase, pass: pass(input.pass, `${label}.pass`) }; }
	if (phase === "planned") { exact(input, ["phase", "snapshot"], label); return { phase, snapshot: snapshot(input.snapshot, `${label}.snapshot`) }; }
	if (phase === "joined") { exact(input, ["phase", "pass", "originalPassId"], label); return { phase, pass: pass(input.pass, `${label}.pass`), originalPassId: string(input.originalPassId, `${label}.originalPassId`, MAX_ID) }; }
	if (phase === "answer") { exact(input, ["phase", "snapshot", "answer"], label); return { phase, snapshot: snapshot(input.snapshot, `${label}.snapshot`), answer: input.answer === undefined ? undefined : member(input.answer, ["Yes", "No"] as const, `${label}.answer`) }; }
	if (phase === "setting-written") { exact(input, ["phase", "snapshot", "mode"], label); return { phase, snapshot: snapshot(input.snapshot, `${label}.snapshot`), mode: member(input.mode, ["yes", "no"] as const, `${label}.mode`) }; }
	exact(input, ["phase", "pass", "settlement"], label); return { phase, pass: pass(input.pass, `${label}.pass`), settlement: settlement(input.settlement, `${label}.settlement`) };
}

function permit(value: unknown, label: string): ResetPermitWire {
	const input = object(value, label); exact(input, ["attemptId", "target", "creditId", "redeemRequestId"], label); const targetInput = object(input.target, `${label}.target`); exact(targetInput, ["credentialId"], `${label}.target`);
	return { attemptId: string(input.attemptId, `${label}.attemptId`, MAX_ID), target: { credentialId: integer(targetInput.credentialId, `${label}.target.credentialId`) }, creditId: string(input.creditId, `${label}.creditId`, MAX_ID), redeemRequestId: string(input.redeemRequestId, `${label}.redeemRequestId`, MAX_ID) };
}

function consumeIdentity(value: unknown, label: string): ResetConsumeIdentityWire {
	const input = object(value, label); exact(input, ["provider", "credentialId", "accountId", "email", "projectId", "orgId", "creditId"], label); const output: Dict = { provider: string(input.provider, `${label}.provider`, MAX_ID), creditId: string(input.creditId, `${label}.creditId`, MAX_ID) };
	present(input, output, "credentialId", input.credentialId === undefined ? undefined : integer(input.credentialId, `${label}.credentialId`));
	for (const key of ["accountId", "email", "projectId", "orgId"] as const) present(input, output, key, optionalString(input[key], `${label}.${key}`));
	return output as ResetConsumeIdentityWire;
}

function observation(value: unknown, label: string): ResetObservationWire {
	const input = object(value, label); exact(input, ["consumeBoundary", "result"], label); const resultInput = object(input.result, `${label}.result`); const kind = member(resultInput.kind, ["outcome", "error"] as const, `${label}.result.kind`);
	if (kind === "error") { exact(resultInput, ["kind", "error"], `${label}.result`); const errorInput = object(resultInput.error, `${label}.result.error`); exact(errorInput, ["name", "message"], `${label}.result.error`); return { consumeBoundary: member(input.consumeBoundary, ["not-reached", "refused", "passed"] as const, `${label}.consumeBoundary`), result: { kind, error: { name: string(errorInput.name, `${label}.result.error.name`, MAX_ID), message: string(errorInput.message, `${label}.result.error.message`, MAX_ERROR_TEXT) } } }; }
	exact(resultInput, ["kind", "outcome"], `${label}.result`); const outcomeInput = object(resultInput.outcome, `${label}.result.outcome`); exact(outcomeInput, ["ok", "code", "accountId", "email", "creditId"], `${label}.result.outcome`); const outcome: Dict = { ok: boolean(outcomeInput.ok, `${label}.result.outcome.ok`), code: string(outcomeInput.code, `${label}.result.outcome.code`, MAX_ID) };
	for (const key of ["accountId", "email", "creditId"] as const) present(outcomeInput, outcome, key, optionalString(outcomeInput[key], `${label}.result.outcome.${key}`));
	return { consumeBoundary: member(input.consumeBoundary, ["not-reached", "refused", "passed"] as const, `${label}.consumeBoundary`), result: { kind, outcome: outcome as unknown as Extract<ResetObservation["result"], { kind: "outcome" }>["outcome"] } };
}

function operation(value: unknown, nativeSessionId: string, passId: string): ResetPolicyWireOperation {
	const input = object(value, "operation"); const kind = member(input.kind, ["checkpoint", "decision.prepare", "decision.bind", "admit", "join", "complete"] as const, "operation.kind"); let output: ResetPolicyWireOperation;
	if (kind === "checkpoint") { exact(input, ["kind", "event"], "operation"); output = { kind, event: checkpoint(input.event, "operation.event") }; }
	else if (kind === "decision.prepare") { exact(input, ["kind", "snapshot"], "operation"); output = { kind, snapshot: snapshot(input.snapshot, "operation.snapshot") }; }
	else if (kind === "decision.bind") { exact(input, ["kind", "decisionId", "interactionId"], "operation"); return { kind, decisionId: string(input.decisionId, "operation.decisionId", MAX_ID), interactionId: string(input.interactionId, "operation.interactionId", MAX_ID) }; }
	else if (kind === "admit") { exact(input, ["kind", "snapshot", "actionIndex"], "operation"); const parsed = snapshot(input.snapshot, "operation.snapshot"); const actionIndex = integer(input.actionIndex, "operation.actionIndex"); if (actionIndex >= parsed.plan.actions.length) fail("operation.actionIndex is outside the plan"); output = { kind, snapshot: parsed, actionIndex }; }
	else if (kind === "join") { exact(input, ["kind", "joinId"], "operation"); return { kind, joinId: string(input.joinId, "operation.joinId", MAX_ID) }; }
	else { exact(input, ["kind", "permit", "observation"], "operation"); return { kind, permit: permit(input.permit, "operation.permit"), observation: observation(input.observation, "operation.observation") }; }
	const sourcePass = output.kind === "checkpoint" ? ("pass" in output.event ? output.event.pass : output.event.snapshot.pass) : output.snapshot.pass;
	if (sourcePass.nativeSessionId !== nativeSessionId || sourcePass.passId !== passId) fail("operation provenance does not match its envelope");
	return output;
}

function result(value: unknown): ResetPolicyWireResult {
	const input = object(value, "response.result"); const kind = string(input.kind, "response.result.kind", MAX_ID);
	if (kind === "checkpointed" || kind === "decision.bound" || kind === "completed") { exact(input, ["kind"], "response.result"); return { kind }; }
	if (kind === "decision.prepared") { exact(input, ["kind", "decisionId"], "response.result"); return { kind, decisionId: string(input.decisionId, "response.result.decisionId", MAX_ID) }; }
	if (kind === "admission.hold") { exact(input, ["kind", "reason"], "response.result"); return { kind, reason: member(input.reason, ["unknown", "stale", "identity-unresolved", "credit-unavailable", "owner-unavailable"] as const, "response.result.reason") }; }
	if (kind === "admission.execute") { exact(input, ["kind", "permit", "consumeIdentity"], "response.result"); return { kind, permit: permit(input.permit, "response.result.permit"), consumeIdentity: consumeIdentity(input.consumeIdentity, "response.result.consumeIdentity") }; }
	if (kind === "admission.join") { exact(input, ["kind", "attemptId", "joinId"], "response.result"); return { kind, attemptId: string(input.attemptId, "response.result.attemptId", MAX_ID), joinId: string(input.joinId, "response.result.joinId", MAX_ID) }; }
	if (kind === "joined") { exact(input, ["kind", "observation"], "response.result"); return { kind, observation: observation(input.observation, "response.result.observation") }; }
	return fail("response.result.kind is unknown");
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail(`${label} must be a SHA-256 digest`);
  return value;
}
function account(value: unknown, label: string): ResetPolicyWireAccount {
  const input = object(value, label);
  exact(input, ["provider", "baseUrl", "accountId", "email", "orgId", "projectId", "credentialId", "credentialFingerprint", "authAuthority", "emailUnambiguous"], label);
  const output: Dict = { provider: member(input.provider, ["openai-codex"] as const, `${label}.provider`),
    credentialId: integer(input.credentialId, `${label}.credentialId`),
    credentialFingerprint: digest(input.credentialFingerprint, `${label}.credentialFingerprint`),
    authAuthority: string(input.authAuthority, `${label}.authAuthority`, 256) };
  for (const [key, max] of [["baseUrl", 1024], ["accountId", 200], ["email", 320], ["orgId", 200], ["projectId", 200]] as const)
    present(input, output, key, optionalString(input[key], `${label}.${key}`, max));
  present(input, output, "emailUnambiguous", input.emailUnambiguous === undefined ? undefined : boolean(input.emailUnambiguous, `${label}.emailUnambiguous`));
  if (!output.accountId && (!output.email || output.emailUnambiguous !== true)) fail(`${label} has no unambiguous account identity`);
  return output as ResetPolicyWireAccount;
}
function credit(value: unknown, label: string): ResetPolicyWireCredit {
  const input = object(value, label); exact(input, ["id", "status", "expiresAt", "fingerprint"], label);
  const output: Dict = { id: string(input.id, `${label}.id`, 200), status: member(input.status, ["available"] as const, `${label}.status`), fingerprint: digest(input.fingerprint, `${label}.fingerprint`) };
  present(input, output, "expiresAt", optionalString(input.expiresAt, `${label}.expiresAt`, 200));
  return output as ResetPolicyWireCredit;
}
function evidence(value: unknown): ResetPolicyWireEvidence {
  const input = object(value, "evidence");
  const kind = member(input.kind, ["source", "plan", "persistence", "admission"] as const, "evidence.kind");
  if (kind === "source") {
    exact(input, ["kind", "selectionRevision", "policyRevision"], "evidence");
    return { kind, selectionRevision: digest(input.selectionRevision, "evidence.selectionRevision"), policyRevision: digest(input.policyRevision, "evidence.policyRevision") };
  }
  if (kind === "plan") {
    exact(input, ["kind", "accounts"], "evidence");
    return { kind, accounts: array(input.accounts, "evidence.accounts", RESET_POLICY_MAX_ACTIONS).map((item, index) => account(item, `evidence.accounts[${index}]`)) };
  }
  if (kind === "admission") {
    exact(input, ["kind", "selectionRevision", "policyRevision", "account", "credit"], "evidence");
    return { kind, selectionRevision: digest(input.selectionRevision, "evidence.selectionRevision"), policyRevision: digest(input.policyRevision, "evidence.policyRevision"), account: account(input.account, "evidence.account"), credit: credit(input.credit, "evidence.credit") };
  }
  exact(input, ["kind", "status", "globalMode", "effectivePolicy", "layersUnchanged", "policyRevision"], "evidence");
  const output: Dict = { kind, status: member(input.status, ["verified", "failed"] as const, "evidence.status") };
  present(input, output, "globalMode", input.globalMode === undefined ? undefined : member(input.globalMode, ["yes", "no"] as const, "evidence.globalMode"));
  present(input, output, "effectivePolicy", input.effectivePolicy === undefined ? undefined : policy(input.effectivePolicy, "evidence.effectivePolicy"));
  present(input, output, "layersUnchanged", input.layersUnchanged === undefined ? undefined : boolean(input.layersUnchanged, "evidence.layersUnchanged"));
  present(input, output, "policyRevision", input.policyRevision === undefined ? undefined : digest(input.policyRevision, "evidence.policyRevision"));
  return output as ResetPolicyWireEvidence;
}

export function parseResetPolicyWireRequest(value: unknown, expectedBinding?: ResetPolicyWireBinding): ResetPolicyWireRequest {
	assertResetPolicyWireSize(value); const input = object(value, "request"); exact(input, ["type", "requestId", "binding", "nativeSessionId", "passId", "operation", "evidence"], "request");
	if (input.type !== "resetPolicyRequest") fail("request.type is unknown"); const parsedBinding = binding(input.binding, "request.binding"); assertBinding(parsedBinding, expectedBinding);
	const nativeSessionId = string(input.nativeSessionId, "request.nativeSessionId", MAX_ID), passId = string(input.passId, "request.passId", MAX_ID);
	return freeze({ type: "resetPolicyRequest", requestId: integer(input.requestId, "request.requestId", 1), binding: parsedBinding, nativeSessionId, passId, operation: operation(input.operation, nativeSessionId, passId), ...(input.evidence === undefined ? {} : { evidence: evidence(input.evidence) }) });
}

export function parseResetPolicyWireResponse(value: unknown, expectedBinding?: ResetPolicyWireBinding): ResetPolicyWireResponse {
	assertResetPolicyWireSize(value); const input = object(value, "response"); exact(input, ["type", "requestId", "binding", "response"], "response"); if (input.type !== "resetPolicyResponse") fail("response.type is unknown");
	const parsedBinding = binding(input.binding, "response.binding"); assertBinding(parsedBinding, expectedBinding); const responseInput = object(input.response, "response.response"); exact(responseInput, responseInput.ok === true ? ["ok", "result"] : ["ok", "error"], "response.response");
	let parsedResponse: ResetPolicyWireResponse["response"];
	if (responseInput.ok === true) parsedResponse = { ok: true, result: result(responseInput.result) };
	else if (responseInput.ok === false) { const errorInput = object(responseInput.error, "response.response.error"); exact(errorInput, ["name", "message"], "response.response.error"); parsedResponse = { ok: false, error: { name: string(errorInput.name, "response.response.error.name", MAX_ID), message: string(errorInput.message, "response.response.error.message", MAX_ERROR_TEXT) } }; }
	else fail("response.response.ok must be boolean");
	return freeze({ type: "resetPolicyResponse", requestId: integer(input.requestId, "response.requestId", 1), binding: parsedBinding, response: parsedResponse });
}
