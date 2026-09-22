import { expect, test } from "bun:test";
import { ContextResetConfirmation, type ContextResetSource } from "./context-reset-confirmation";

function source(): ContextResetSource {
  return { hostId: "host", sessionId: "native-session", connected: true, available: true, idle: true, visible: true,
    draft: { id: "session:native-session", revision: 1, text: "/clear", projectId: null, model: null, updatedAt: 1 },
    tree: { resetSupported: true, owner: { hostId: "host", sessionId: "native-session" }, fresh: true, loading: false, pending: false, uncertain: false,
      value: { ticket: { nativeSessionId: "native-session", epoch: "original-worker", revision: "original-context" }, leafId: null,
        entries: [], summariesEnabled: false, nativeCommandAvailable: true, reconciliationRequired: false } } };
}

test("confirmation retains the original request and is consumed only once", () => {
  const current = source(), confirmation = new ContextResetConfirmation(current, true);
  const request = confirmation.take(current);
  expect(request).toEqual({ sessionId: "native-session", ticket: current.tree.value!.ticket, mutation: { action: "reset-context", origin: "clear-command" } });
  expect(() => confirmation.take(current)).toThrow("already submitted");
  expect(current.draft.text).toBe("/clear");
});

const changes: [string, (s: ContextResetSource) => void][] = [
  ["host", s => { s.hostId = "another-host"; }],
  ["conversation", s => { s.sessionId = "another-session"; }],
  ["overlay", s => { s.visible = false; }],
  ["connection", s => { s.connected = false; }],
  ["capability", s => { s.available = false; }],
  ["streaming", s => { s.idle = false; }],
  ["maintenance", s => { s.tree.value!.busyReason = "Compaction in progress"; }],
  ["stale read", s => { s.tree.fresh = false; }],
  ["unknown receipt", s => { s.tree.uncertain = true; }],
  ["pending command", s => { s.tree.pending = true; }],
  ["reconciliation", s => { s.tree.value!.reconciliationRequired = true; }],
  ["worker epoch", s => { s.tree.value!.ticket.epoch = "replacement-worker"; }],
  ["history revision", s => { s.tree.value!.ticket.revision = "new-context"; }],
  ["composer text", s => { s.draft.text = "A new prompt"; }],
  ["composer attachment", s => { s.draft.wholeFileAttachments = [{ id: "file", source: { kind: "file", hostId: "host", path: "/private/new.ts" } }]; }],
];
for (const [name, change] of changes) test(`observed ${name} loss cannot revive the original confirmation`, () => {
  const current = source(), confirmation = new ContextResetConfirmation(current, true);
  change(current);
  expect(confirmation.update(current)).toBeString();
  expect(() => confirmation.take(source())).toThrow();
  expect(confirmation.submitted).toBe(false);
  // A fresh deliberate confirmation is allowed after restoration.
  expect(new ContextResetConfirmation(source(), true).take(source()).mutation.action).toBe("reset-context");
});

test("History reset preserves arbitrary composer content and does not claim the slash command", () => {
  const current = source(), confirmation = new ContextResetConfirmation(current);
  current.draft.text = "Keep this prompt";
  expect(confirmation.take(current).mutation).toEqual({ action: "reset-context" });
  expect(current.draft.text).toBe("Keep this prompt");
  expect(confirmation.draft).toBeUndefined();
});

test("the confirmation copies nested draft and native ticket values", () => {
  const current = source(), confirmation = new ContextResetConfirmation(current, true);
  current.tree.value!.ticket.revision = "changed-in-place";
  current.draft.text = "changed-in-place";
  expect(confirmation.ticket.revision).toBe("original-context");
  expect(confirmation.draft?.text).toBe("/clear");
  expect(() => confirmation.take(current)).toThrow("context changed");
});

test("a mismatched native response cannot establish confirmation ownership", () => {
  const current = source(); current.tree.value!.ticket.nativeSessionId = "another-session";
  expect(() => new ContextResetConfirmation(current)).toThrow("Refresh History");
});
