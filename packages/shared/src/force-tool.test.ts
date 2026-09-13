import { expect, test } from "bun:test";
import {
  parseForceToolState, parseForceToolReceipt, parseForceToolResponse, parseForceToolCancel,
  parseForceToolCancelResult, parseForceToolPromptFields, parseForceToolRecovery,
  type ForceToolState, type ForceToolReceipt,
} from "./force-tool";

const state = (): ForceToolState => ({ epoch: "worker-a", revision: 1, nativeSessionId: "native-a",
  model: { provider: "local", id: "model", api: "openai-completions" },
  availability: { state: "degraded", reason: "Native compatibility omits tool choice." },
  tools: [{ name: "read", available: true }], directives: [], canArm: true, canCancel: false });
const receipt = (): ForceToolReceipt => ({ commandId: "command-a", epoch: "worker-a", toolName: "read", directiveId: "directive-a", arm: "armed", prompt: "not-recorded" });

test("degraded native-accepted state remains armable and stale directives need not match today's tool registry", () => {
  const input = state();
  input.directives = [{ id: "old-tool", toolName: "removed", phase: "pending-tool", requeued: true }];
  input.canCancel = true;
  expect(parseForceToolState(input)).toEqual(input);
  input.tools = [];
  expect(() => parseForceToolState(input)).toThrow();
  input.canArm = false;
  expect(parseForceToolState(input).directives[0]?.toolName).toBe("removed");
});

test("wire keys, UTF8 bounds, booleans and safe revisions cannot coerce", () => {
  for (const invalid of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1", null])
    expect(() => parseForceToolState({ ...state(), revision: invalid })).toThrow();
  expect(parseForceToolState({ ...state(), revision: Number.MAX_SAFE_INTEGER }).revision).toBe(Number.MAX_SAFE_INTEGER);
  expect(() => parseForceToolState({ ...state(), canArm: "true" })).toThrow();
  expect(() => parseForceToolState({ ...state(), restore: [] })).toThrow();
  expect(() => parseForceToolState({ ...state(), model: { ...state().model, credential: "excluded" } })).toThrow();
  expect(() => parseForceToolState({ ...state(), epoch: "é".repeat(101) })).toThrow();
  expect(parseForceToolState({ ...state(), epoch: "é".repeat(100) }).epoch).toBe("é".repeat(100));
  expect(() => parseForceToolState({ ...state(), tools: [{ name: "a\0b", available: true }] })).toThrow();
  expect(() => parseForceToolState({ ...state(), availability: { state: "degraded", reason: "" } })).toThrow();
  expect(parseForceToolState({ ...state(), availability: { state: "supported", reason: "" } }).availability.reason).toBe("");
});

test("duplicate tool/directive/command identities and oversized lists are rejected", () => {
  const directive = { id: "d", toolName: "read", commandId: "c", phase: "pending-tool", requeued: false };
  expect(() => parseForceToolState({ ...state(), tools: [{ name: "read", available: true }, { name: "read", available: false }] })).toThrow();
  expect(() => parseForceToolState({ ...state(), directives: [directive, directive] })).toThrow();
  expect(() => parseForceToolState({ ...state(), directives: [directive, { ...directive, id: "other" }] })).toThrow();
  expect(() => parseForceToolState({ ...state(), tools: Array.from({ length: 16385 }, (_, n) => ({ name: `${n}`, available: true })) })).toThrow();
  expect(() => parseForceToolState({ ...state(), directives: Array.from({ length: 4097 }, (_, n) => ({ ...directive, id: `${n}`, commandId: `c${n}` })) })).toThrow();
});

test("partial arm evidence distinguishes recorded, absent entry and unknown", () => {
  expect(parseForceToolReceipt(receipt(), "command-a")).toEqual(receipt());
  for (const patch of [{ directiveId: undefined }, { arm: "not-armed" }, { prompt: "recorded" }, { promptEntryId: "entry" }, { commandId: "other" }, { commandId: "bad/id" }])
    expect(() => parseForceToolReceipt({ ...receipt(), ...patch }, "command-a")).toThrow();
  expect(parseForceToolReceipt({ ...receipt(), prompt: "recorded", promptEntryId: "entry" }).prompt).toBe("recorded");
  expect(parseForceToolReceipt({ ...receipt(), arm: "unknown", directiveId: undefined, prompt: "unknown" }).arm).toBe("unknown");
  expect(parseForceToolReceipt({ ...receipt(), prompt: "unknown", promptEntryId: "observed-but-unflushed" })).toMatchObject({
    prompt: "unknown", promptEntryId: "observed-but-unflushed",
  });
});

test("definite native usage refusal preserves an empty actual tool argument without fabricating an armed target", () => {
  const usage: ForceToolReceipt = { commandId: "usage", epoch: "worker", toolName: "", arm: "not-armed", prompt: "not-requested" };
  expect(parseForceToolReceipt(usage, "usage")).toEqual(usage);
  expect(() => parseForceToolReceipt({ ...usage, arm: "armed", directiveId: "d" })).toThrow();
  expect(() => parseForceToolReceipt({ ...usage, arm: "unknown" })).toThrow();
  expect(() => parseForceToolReceipt({ ...usage, directiveId: "d" })).toThrow();
  expect(parseForceToolResponse({ protocolVersion: 1, hostId: "host", sessionId: "session", value: null, unavailable: "Worker unavailable",
    receipt: { commandId: "usage", state: "failed", forceToolReceipt: usage } }, "host", "session", "usage").receipt?.forceToolReceipt).toEqual(usage);
});

test("journal envelope binds both owners and requested identity without recreating a live queue", () => {
  const base = { protocolVersion: 1, hostId: "host", sessionId: "session", value: null, unavailable: "Worker is gone." };
  for (const journalState of ["pending", "absent", "unknown", "failed", "succeeded"] as const) {
    const parsed = parseForceToolResponse({ ...base, receipt: { commandId: "command-a", state: journalState } }, "host", "session", "command-a");
    expect(parsed.value).toBeNull(); expect(parsed.receipt?.state).toBe(journalState);
  }
  const historical = { ...base, receipt: { commandId: "command-a", state: "failed", forceToolReceipt: receipt() } };
  expect(parseForceToolResponse(historical, "host", "session", "command-a").value).toBeNull();
  for (const [host, session, command] of [["other", "session", "command-a"], ["host", "other", "command-a"], ["host", "session", "other"]])
    expect(() => parseForceToolResponse(historical, host!, session!, command)).toThrow();
  expect(() => parseForceToolResponse(base, "host", "session", "command-a")).toThrow();
  expect(() => parseForceToolResponse(historical, "host", "session")).toThrow();
  expect(() => parseForceToolResponse({ ...historical, receipt: { ...historical.receipt, state: "absent" } }, "host", "session", "command-a")).toThrow();
  expect(() => parseForceToolResponse({ ...historical, receipt: { ...historical.receipt, state: "succeeded" } }, "host", "session", "command-a")).toThrow();
  expect(() => parseForceToolResponse({ ...base, unavailable: undefined }, "host", "session")).toThrow();
});

test("cancel is exact-ticket/exact-ID and recovery is mutually exclusive with an arm", () => {
  const cancel = { sessionId: "s", ticket: { epoch: "e", revision: 0 }, directiveId: "d" };
  expect(parseForceToolCancel(cancel)).toEqual(cancel);
  expect(() => parseForceToolCancel({ ...cancel, ticket: { ...cancel.ticket, epoch: "" } })).toThrow();
  expect(() => parseForceToolCancel({ ...cancel, removeByLabel: "user-force" })).toThrow();
  expect(() => parseForceToolCancelResult({ state: { ...state(), directives: [{ id: "d", toolName: "read", phase: "pending-tool", requeued: false }] }, cancelledDirectiveId: "d" })).toThrow();
  expect(parseForceToolCancelResult({ state: state(), cancelledDirectiveId: "d" }).cancelledDirectiveId).toBe("d");
  const recovery = { epoch: "e", expectedRevision: 0, directiveId: "d" };
  expect(parseForceToolRecovery(recovery)).toEqual(recovery);
  expect(() => parseForceToolRecovery({ ...recovery, originalCommandId: "not-this-operation" })).toThrow();
  expect(() => parseForceToolPromptFields({ forceTool: { epoch: "e", expectedRevision: 0, toolName: "read" }, forceRecovery: recovery })).toThrow();
});

test("cancel availability requires a cancellable pending native phase rather than merely a visible in-flight directive", () => {
  const directive = { id: "d", toolName: "read", requeued: false };
  expect(() => parseForceToolState({ ...state(), canCancel: true })).toThrow();
  expect(() => parseForceToolState({ ...state(), canCancel: true, directives: [{ ...directive, phase: "tool-in-flight" }] })).toThrow();
  expect(() => parseForceToolState({ ...state(), canCancel: true, directives: [{ ...directive, phase: "final-response-in-flight" }] })).toThrow();
  expect(parseForceToolState({ ...state(), canCancel: true, directives: [{ ...directive, phase: "pending-final-response" }] }).canCancel).toBe(true);
});
