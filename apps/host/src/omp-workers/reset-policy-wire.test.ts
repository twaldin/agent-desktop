import { describe, expect, test } from "bun:test";
import type { ResetCheckpoint } from "@oh-my-pi/pi-coding-agent";
import {
	RESET_POLICY_MAX_ACTIONS,
	RESET_POLICY_MAX_SERIALIZED_BYTES,
	RESET_POLICY_MAX_SKIPPED,
	assertResetPolicyWireSize,
	parseResetPolicyWireRequest,
	parseResetPolicyWireResponse,
	projectResetPolicyError,
	serializedResetPolicyWireBytes,
	type ResetPolicyWireBinding,
	type ResetPlanSnapshotWire,
} from "./reset-policy-wire";

const binding = { workerEpoch: "epoch-1", rootSessionId: "root-session" } satisfies ResetPolicyWireBinding;
const pass = {
	passId: "pass-1", nativeSessionId: "native-child", trigger: "blocked", source: "blocked", startedAtMs: 100,
	provider: "openai-codex", modelId: "gpt-5", codexBaseUrl: "https://chatgpt.com/backend-api/codex",
	identity: { accountId: "account", email: "user@example.test", projectId: "project", orgId: "org", orgName: "Org" },
	activeBlockUnblockAtMs: 500, policy: { autoRedeem: "yes", minBlockedMinutes: 10, keepCredits: 1, salvageHorizonHours: 24 },
} as const;
const action = {
	reason: "blocked-account" as const, target: { credentialId: 7, accountId: "account", email: "user@example.test" },
	accountKey: "account-key", attemptKey: "attempt-key", label: "user@example.test", availableCount: 2,
	weeklyUsedFraction: 0.95, remainingMs: 1_000, active: true,
};
const snapshot = {
	pass, plannedAtMs: 200, reportRevision: "d".repeat(64), plan: { actions: [action], skipped: [{ accountKey: "other", rule: "account", reason: "cooldown" }] },
} satisfies ResetPlanSnapshotWire;

function request(operation: unknown, overrides: Record<string, unknown> = {}) {
	return { type: "resetPolicyRequest" as const, requestId: 1, binding, nativeSessionId: pass.nativeSessionId, passId: pass.passId, operation, ...overrides };
}
function response(result: unknown, overrides: Record<string, unknown> = {}) {
	return { type: "resetPolicyResponse", requestId: 1, binding, response: { ok: true, result }, ...overrides };
}

test("origin evidence cannot claim a report before native planning", () => {
  const origin = { kind: "source", selectionRevision: "a".repeat(64), policyRevision: "b".repeat(64) } as const;
  const parse = (evidence: unknown) => parseResetPolicyWireRequest(request({ kind: "checkpoint", event: { phase: "started", pass } }, { evidence }), binding);
  expect(parse(origin).evidence).toEqual(origin);
  expect(() => parse({ ...origin, reportRevision: "c".repeat(64) })).toThrow("reportRevision");
});

test("every planned callback retains the native report digest and refuses missing or malformed revisions", () => {
  const planned = { ...snapshot, reportRevision: "c".repeat(64) };
  const operations = (value: unknown) => [
    { kind: "checkpoint", event: { phase: "planned", snapshot: value } },
    { kind: "checkpoint", event: { phase: "answer", snapshot: value, answer: "Yes" } },
    { kind: "checkpoint", event: { phase: "setting-written", snapshot: value, mode: "yes" } },
    { kind: "decision.prepare", snapshot: value },
    { kind: "admit", snapshot: value, actionIndex: 0 },
  ];
  for (const operation of operations(planned)) {
    expect(parseResetPolicyWireRequest(request(operation), binding).operation as unknown).toEqual(operation);
  }
  for (const reportRevision of [undefined, "", "x".repeat(64), "C".repeat(64), "c".repeat(63)]) {
    for (const operation of operations({ ...planned, reportRevision })) {
      expect(() => parseResetPolicyWireRequest(request(operation), binding)).toThrow("reportRevision");
    }
  }
});

describe("reset policy worker wire", () => {
	test("copies and freezes real native checkpoint and planner shapes without truncation", () => {
		const event = { phase: "planned", snapshot } satisfies ResetCheckpoint;
		const packet = request({ kind: "checkpoint", event });
		const parsed = parseResetPolicyWireRequest(packet, binding);
		expect(parsed as unknown).toEqual(packet);
		expect(parsed).not.toBe(packet);
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen((parsed.operation as { event: object }).event)).toBe(true);
		(packet.operation as { event: { snapshot: { plan: { actions: Array<{ label: string }> } } } }).event.snapshot.plan.actions[0]!.label = "mutated";
		expect((parsed.operation as unknown as { event: typeof event }).event.snapshot.plan.actions[0]!.label).toBe("user@example.test");
	});

	test("accepts every operation and preserves each response discriminant", () => {
		const checkpointEvent = { phase: "finished", pass, settlement: { state: "settled", applied: 1, attemptIds: ["attempt-1"], refresh: "complete" } } satisfies ResetCheckpoint;
		const operations = [
			{ kind: "checkpoint", event: checkpointEvent },
			{ kind: "decision.prepare", snapshot },
			{ kind: "decision.bind", decisionId: "decision-1", interactionId: "interaction-1" },
			{ kind: "admit", snapshot, actionIndex: 0 },
			{ kind: "join", joinId: "join-1" },
			{ kind: "complete", permit: { attemptId: "attempt-1", target: { credentialId: 7 }, creditId: "credit-1", redeemRequestId: "request-1" }, observation: { consumeBoundary: "passed", result: { kind: "outcome", outcome: { ok: false, code: "future_native_code", accountId: "account", email: "user@example.test", creditId: "credit-1" } } } },
		] as const;
		for (const operation of operations) expect(parseResetPolicyWireRequest(request(operation), binding).operation.kind).toBe(operation.kind);

		const results = [
			{ kind: "checkpointed" }, { kind: "decision.prepared", decisionId: "decision-1" }, { kind: "decision.bound" },
			{ kind: "admission.hold", reason: "owner-unavailable" },
			{ kind: "admission.execute", permit: { attemptId: "attempt-1", target: { credentialId: 7 }, creditId: "credit-1", redeemRequestId: "request-1" }, consumeIdentity: { provider: "openai-codex", credentialId: 7, accountId: "account", email: "user@example.test", projectId: "project", orgId: "org", creditId: "credit-1" } },
			{ kind: "admission.join", attemptId: "attempt-1", joinId: "join-1" },
			{ kind: "joined", observation: { consumeBoundary: "not-reached", result: { kind: "error", error: { name: "TimeoutError", message: "owner timed out" } } } },
			{ kind: "completed" },
		] as const;
		for (const result of results) {
			const parsed = parseResetPolicyWireResponse(response(result), binding);
			expect(parsed.response.ok && parsed.response.result.kind).toBe(result.kind);
		}
	});

	test("rejects malformed, sparse, oversized, and foreign-bound packets", () => {
		expect(() => parseResetPolicyWireRequest(request({ kind: "decision.prepare", snapshot }, { requestId: 0 }))).toThrow("requestId");
		expect(() => parseResetPolicyWireRequest(request({ kind: "decision.prepare", snapshot }, { extra: true }))).toThrow("extra");
		expect(() => parseResetPolicyWireRequest(request({ kind: "admit", snapshot, actionIndex: 1 }))).toThrow("outside the plan");
		expect(() => parseResetPolicyWireRequest(request({ kind: "decision.prepare", snapshot }), { ...binding, workerEpoch: "foreign" })).toThrow("foreign worker binding");
		expect(() => parseResetPolicyWireRequest(request({ kind: "decision.prepare", snapshot }), binding)).not.toThrow();
		expect(() => parseResetPolicyWireRequest(request({ kind: "decision.prepare", snapshot }), { ...binding, rootSessionId: "other" })).toThrow("foreign worker binding");

		const sparse = Array(2); sparse[0] = action;
		expect(() => parseResetPolicyWireRequest(request({ kind: "decision.prepare", snapshot: { ...snapshot, plan: { actions: sparse, skipped: [] } } }))).toThrow("sparse");
		expect(() => parseResetPolicyWireRequest(request({ kind: "decision.prepare", snapshot: { ...snapshot, plan: { actions: Array.from({ length: RESET_POLICY_MAX_ACTIONS + 1 }, () => action), skipped: [] } } }))).toThrow("exceeds its bound");
		expect(() => parseResetPolicyWireRequest(request({ kind: "decision.prepare", snapshot: { ...snapshot, plan: { actions: [action], skipped: Array.from({ length: RESET_POLICY_MAX_SKIPPED + 1 }, () => snapshot.plan.skipped[0]) } } }))).toThrow("exceeds its bound");

		const oversized = { type: "resetPolicyResponse", requestId: 1, binding, response: { ok: false, error: { name: "Error", message: "x".repeat(RESET_POLICY_MAX_SERIALIZED_BYTES) } } };
		expect(serializedResetPolicyWireBytes(oversized)).toBeGreaterThan(RESET_POLICY_MAX_SERIALIZED_BYTES);
		expect(() => assertResetPolicyWireSize(oversized)).toThrow("1 MiB");
		expect(() => parseResetPolicyWireResponse(oversized)).toThrow("1 MiB");
	});

	test("checks envelope provenance, rejects unknown response kinds, and bounds errors", () => {
		expect(() => parseResetPolicyWireRequest(request({ kind: "decision.prepare", snapshot }, { passId: "forged" }))).toThrow("provenance");
		expect(() => parseResetPolicyWireRequest(request({ kind: "decision.prepare", snapshot }, { nativeSessionId: "foreign" }))).toThrow("provenance");
		expect(() => parseResetPolicyWireResponse(response({ kind: "future-result" }))).toThrow("unknown");
		expect(() => parseResetPolicyWireResponse({ type: "resetPolicyResponse", requestId: 1, binding, response: { ok: false, error: { name: "OwnerError", message: "failed", stack: "private" } } })).toThrow("stack");
		const projected = projectResetPolicyError({ secret: "not serializable" });
		expect(projected).toEqual({ name: "Error", message: "Unknown reset-policy owner error" });
		expect(Object.isFrozen(projected)).toBe(true);
		expect(projectResetPolicyError(new Error("x".repeat(3_000))).message.length).toBe(2_048);
	});
});

test("private evidence copies account proofs without allowing credential payloads or partial plans", () => {
  const digest = "a".repeat(64);
  const account = { provider: "openai-codex", credentialId: 7, accountId: "account", credentialFingerprint: digest, authAuthority: "original-auth" };
  const parse = (evidence: unknown) => parseResetPolicyWireRequest(request({ kind: "checkpoint", event: { phase: "planned", snapshot } }, { evidence }), binding);
  const accounts = [account];
  const parsed = parse({ kind: "plan", accounts });
  account.accountId = "replacement";
  expect(parsed.evidence?.kind === "plan" && parsed.evidence.accounts[0]!.accountId).toBe("account");
  expect(Object.isFrozen(parsed.evidence)).toBe(true);
  expect(parsed.evidence?.kind === "plan" && Object.isFrozen(parsed.evidence.accounts[0])).toBe(true);
  expect(() => parse({ kind: "plan", accounts: [{ ...account, accessToken: "must-not-cross" }] })).toThrow("accessToken");
  expect(() => parse({ kind: "plan", accounts: [{ ...account, credentialFingerprint: "not-a-digest" }] })).toThrow("SHA-256");
  expect(() => parse({ kind: "plan", accounts: [{ ...account, accountId: undefined, email: "shared@example.test" }] })).toThrow("unambiguous");
  expect(() => parse({ kind: "plan", accounts: [{ ...account, accountId: undefined, email: "single@example.test", emailUnambiguous: true }] })).not.toThrow();
  expect(() => parse({ kind: "plan", accounts: new Array(1) })).toThrow("sparse");
  expect(() => parse({ kind: "plan", accounts: Array.from({ length: RESET_POLICY_MAX_ACTIONS + 1 }, () => account) })).toThrow("bound");
});

test("source, persistence and admission evidence retain exact provenance and fail closed on malformed fields", () => {
  const digest = "b".repeat(64);
  const parse = (evidence: unknown) => parseResetPolicyWireRequest(request({ kind: "decision.prepare", snapshot }, { evidence }), binding).evidence;
	const source = { kind: "source", selectionRevision: digest, policyRevision: digest } as const;
  expect(parse(source)).toEqual(source);
  expect(() => parse({ ...source, policyRevision: "" })).toThrow("SHA-256");
	const persistence = { kind: "persistence", status: "verified", globalMode: "yes", effectivePolicy: pass.policy, layersUnchanged: true, policyRevision: digest } as const;
  expect(parse(persistence)).toEqual(persistence);
  expect(parse({ kind: "persistence", status: "failed" })).toEqual({ kind: "persistence", status: "failed" });
  expect(() => parse({ ...persistence, layersUnchanged: "yes" })).toThrow("boolean");
  const admission = { kind: "admission", selectionRevision: digest, policyRevision: digest,
    account: { provider: "openai-codex", credentialId: 7, accountId: "account", credentialFingerprint: digest, authAuthority: "original-auth" },
		credit: { id: "original-credit", status: "available", fingerprint: digest } } as const;
  expect(parse(admission)).toEqual(admission);
  expect(() => parse({ ...admission, credit: { ...admission.credit, status: "redeemed" } })).toThrow("unknown");
  expect(() => parse({ ...admission, currentOwner: "replacement" })).toThrow("currentOwner");
});
