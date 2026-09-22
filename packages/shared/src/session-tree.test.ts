import { expect, test } from "bun:test";
import { parseTreeMutationRequest, parseTreeMutationResult, treeMutationCommandVersion, type SessionTree } from "./session-tree";

const ticket = { nativeSessionId: "session", epoch: "epoch", revision: "revision" };
const request = (mutation: unknown) => ({ sessionId: "session", ticket, mutation });

test("targetless reset and explicit slash origin use command25 while legacy tree actions stay on23", () => {
  for (const mutation of [{ action: "reset-context" }, { action: "reset-context", origin: "clear-command" }] as const) {
    const parsed = parseTreeMutationRequest(request(mutation));
    expect(parsed.mutation).toEqual(mutation);
    expect(treeMutationCommandVersion(parsed.mutation)).toBe(25);
  }
  for (const mutation of [{ action: "navigate", targetId: "entry", summarize: false }, { action: "label", targetId: "entry", label: null }] as const) {
    const parsed = parseTreeMutationRequest(request(mutation));
    expect(parsed.mutation).toEqual(mutation);
    expect(treeMutationCommandVersion(parsed.mutation)).toBe(23);
  }
});

test("reset cannot carry a history target, navigation fields or an invented command origin", () => {
  for (const extra of [{ targetId: "entry" }, { targetId: undefined }, { summarize: false }, { customInstructions: "focus" }, { label: null }, { origin: "history" }])
    expect(() => parseTreeMutationRequest(request({ action: "reset-context", ...extra }))).toThrow();
  for (const mutation of [{ action: "navigate", targetId: "entry", summarize: false }, { action: "label", targetId: "entry", label: "saved" }])
    expect(() => parseTreeMutationRequest(request({ ...mutation, origin: "clear-command" }))).toThrow();
  expect(() => parseTreeMutationRequest({ ...request({ action: "reset-context" }), sessionId: "other-owner" })).toThrow("owner");
});

test("a reset result preserves the legacy tree response grammar and command correlation", () => {
  const state: SessionTree = { ticket, leafId: "reset", entries: [
    { id: "old", parentId: null, timestamp: "before", kind: "user", text: "Retained history", active: true, editable: true, imageCount: 0 },
    { id: "reset", parentId: "old", timestamp: "after", kind: "reset_boundary", text: "", active: true, editable: false, imageCount: 0 },
  ], summariesEnabled: false, nativeCommandAvailable: true, reconciliationRequired: false };
  const result = { commandId: "original-reset", state, cancelled: false };
  expect(parseTreeMutationResult(result, "original-reset")).toEqual(result);
  expect(() => parseTreeMutationResult(result, "another-command")).toThrow("result identity");
  expect(() => parseTreeMutationResult({ ...result, state: { ...state, resetContext: { version: 1 } } })).toThrow();
});
