import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Draft } from "../../../../packages/shared/src/protocol";
import { DraftController } from "./drafts";
import { errorMessage } from "./desktop-state";
import { actionError, clearRecoveredForceError, type ActionError } from "./action-error";
import { usageResetArgument } from "./usage-reset-command";

const app = readFileSync(process.env.FORCE_ACTION_ERROR_APP ?? new URL("./App.tsx", import.meta.url), "utf8");
function extractedReport(values: Record<string, unknown>): (cause: unknown, draftId: string, commandId?: string) => void {
  const start = app.indexOf("  const reportSubmissionError =");
  const end = app.indexOf("  const queuedSubmissionRecoveries", start);
  if (start < 0 || end < 0) throw new Error("Missing App submission error reporter");
  const source = new Bun.Transpiler({ loader: "tsx" }).transformSync(`function build(values) { const {${Object.keys(values).join(",")}} = values; ${app.slice(start, end)} return reportSubmissionError; }`);
  return new Function(`${source}; return build;`)()(values);
}
function appSubmit(values: Record<string, unknown>): () => Promise<void> {
  const start = app.indexOf("  async function submit(");
  const end = app.indexOf("  async function ", start + 10);
  if (start < 0 || end < 0) throw new Error("Missing App submit handler");
  const source = new Bun.Transpiler({ loader: "tsx" }).transformSync(`function build(values) { const {${Object.keys(values).join(",")}} = values; ${app.slice(start, end)} return submit; }`);
  return new Function(`${source}; return build;`)()(values);
}
function usageOwnerFixture(hostId: string) {
  let releases = 0;
  const subscribe = () => {
    let active = true;
    return () => { if (active) { active = false; releases++; } };
  };
  return {
    usageRoute: { current: { key: `${hostId}:session` } },
    desktop: { localHostId: "local", catalog: { records: new Map([[hostId, { connected: true }]]), subscribe } },
    bridge: { subscribe },
    releases: () => releases,
  };
}
function extractedRecovery(values: Record<string, unknown>): (owner: {hostId:string;sessionId:string}, request: any) => Promise<void> {
  const marker = "      recoverPrompt: async (owner, request) => {";
  const start = app.indexOf(marker), end = app.indexOf("\n      },\n    };", start);
  if (start < 0 || end < 0) throw new Error("Missing App force recovery port");
  const member = app.slice(start, end + "\n      }".length).trim();
  const source = new Bun.Transpiler({ loader: "tsx" }).transformSync(`function build(values) { const {${Object.keys(values).join(",")}} = values; return ({${member}}).recoverPrompt; }`);
  return new Function(`${source}; return build;`)()(values);
}
function extractedOperationCheck(values: Record<string, unknown>): () => void {
  const end = app.indexOf("}}>Check original operation</button>");
  const start = app.lastIndexOf("onClick={() => {", end);
  if (start < 0 || end < 0) throw new Error("Missing App force operation check");
  const expression = app.slice(start + "onClick={".length, end + 1);
  const source = new Bun.Transpiler({ loader: "tsx" }).transformSync(`function build(values) { const {${Object.keys(values).join(",")}} = values; return (${expression}); }`);
  return new Function(`${source}; return build;`)()(values);
}
const owner = { hostId: "home", sessionId: "session" };
const receipt = { commandId: "original-force", epoch: "epoch", directiveId: "directive", toolName: "read", arm: "armed" as const, prompt: "not-recorded" as const };
const original: Draft = { id: "session", revision: 4, updatedAt: 4, projectId: null, text: "/force read original prompt", model: null };
const request = { text: "original prompt", originalReceipt: receipt, ticket: { epoch: "epoch", revision: 8 }, directiveId: "directive" };

function harness(recovery: () => Promise<Draft>) {
  let shown: ActionError | null = null, refreshes = 0;
  const setActionErrorState = (next: ActionError | null | ((current: ActionError | null) => ActionError | null)) => {
    shown = typeof next === "function" ? next(shown) : next;
  };
  const setActionError = (message: string | null) => setActionErrorState(message === null ? null : actionError(message));
  const submissions = { get: () => ({ sessionId: owner.sessionId, forceToolReceipt: receipt }), recoverForcePrompt: recovery };
  const report = extractedReport({ submissions, errorMessage, setActionErrorState, ownedActionError: actionError, hostId: owner.hostId, setActionError });
  const drafts = new DraftController(async () => { throw new Error("Unexpected draft write"); }, owner.hostId);
  drafts.get(original.id, original); drafts.update(original.id, { text: "newer composer edit" });
  const recover = extractedRecovery({ submissions, drafts, setActionErrorState, clearRecoveredForceError,
    assertOwner: (candidate: typeof owner) => { if (candidate.hostId !== owner.hostId || candidate.sessionId !== owner.sessionId) throw "wrong owner"; },
    refresh: () => { refreshes++; } });
  return { report, recover, setActionError, setActionErrorState, drafts, shown: () => shown, refreshes: () => refreshes };
}

test("actual App recovery clears only the matching original force banner and retains newer draft text", async () => {
  const h = harness(async () => original);
  h.report("original force prompt was not recorded", original.id, receipt.commandId);
  expect(h.shown()?.force).toEqual({ ...owner, commandId: receipt.commandId });
  await h.recover(owner, request);
  expect(h.shown()).toBeNull();
  expect(h.drafts.get(original.id).draft.text).toBe("newer composer edit");
  expect(h.refreshes()).toBe(1);
});

test("actual delayed recovery preserves later or differently owned errors", async () => {
  const delayed = Promise.withResolvers<Draft>(), h = harness(() => delayed.promise);
  h.report("same visible text", original.id, receipt.commandId);
  const running = h.recover(owner, request);
  h.report("same visible text", original.id);
  delayed.resolve(original); await running;
  expect(h.shown()).toEqual(actionError("same visible text"));
  expect(h.drafts.get(original.id).draft.text).toBe("newer composer edit");
  for (const force of [
    { ...owner, commandId: "later-command" },
    { hostId: "work", sessionId: owner.sessionId, commandId: receipt.commandId },
    { hostId: owner.hostId, sessionId: "other-session", commandId: receipt.commandId },
  ]) {
    const current = actionError("keep this", force);
    h.setActionErrorState(current);
    await h.recover(owner, request);
    expect(h.shown()).toEqual(current);
  }
});

test("actual failed recovery retains the original banner and newer draft", async () => {
  const h = harness(async () => { throw "recovery refused"; });
  h.report("original force prompt was not recorded", original.id, receipt.commandId);
  await expect(h.recover(owner, request)).rejects.toBe("recovery refused");
  expect(h.shown()?.force).toEqual({ ...owner, commandId: receipt.commandId });
  expect(h.drafts.get(original.id).draft.text).toBe("newer composer edit");
  expect(h.refreshes()).toBe(0);
});

test("actual App pre-submit btw failure cannot acquire an older partial force command", async () => {
  let current: ActionError | null = null, dispatches = 0;
  const shown = (): ActionError | null => current;
  const setActionErrorState = (next: ActionError | null | ((current: ActionError | null) => ActionError | null)) => {
    current = typeof next === "function" ? next(current) : next;
  };
  const setActionError = (message: string | null) => setActionErrorState(message === null ? null : actionError(message));
  const pending = { draft: { ...original, text: "/btw later question" }, sessionId: owner.sessionId, mode: "prompt", uncertain: false, force: { nativeForce: true }, forceToolReceipt: receipt };
  const submissions = { get: () => pending, queuedEntries: () => [], submit: async () => { dispatches++; throw "unexpected dispatch"; } };
  const reportSubmissionError = extractedReport({ submissions, errorMessage, setActionErrorState, ownedActionError: actionError, hostId: owner.hostId, setActionError });
  const newer = pending.draft;
  const usageOwner = usageOwnerFixture(owner.hostId);
  await appSubmit({
    canSend: true, submitting: { current: false }, setBusy() {}, setActionError, reportSubmissionError, usageResetArgument,
    draftId: original.id, selectedRef: { current: `${owner.hostId}:${owner.sessionId}` }, hostId: owner.hostId,
    submissions, drafts: { async prepareSubmission() { return newer; }, finishSubmission() {}, get() { return { draft: newer }; } },
    hasDraftContent: () => true, hasRemoteExecution: () => false, nativeBtwQuestion: () => "later question",
    selectedId: owner.sessionId, bridge: usageOwner.bridge, desktop: usageOwner.desktop, usageRoute: usageOwner.usageRoute, draftBrowserOwners: { beforeSubmission() {} },
    draftBrowserPages: { beforeSubmission() {}, captureContinuation() { return undefined; } }, draftBrowserDocks: new Map(),
    EnvironmentPreparationPause: class extends Error {}, errorMessage, textarea: { current: { focus() {} } },
  })();
  expect(dispatches).toBe(0);
  expect(usageOwner.releases()).toBe(2);
  expect(shown()).toEqual(actionError("Update this desktop to resolve native /btw. The draft was retained."));
  const recovered = clearRecoveredForceError(shown(), { ...owner, commandId: receipt.commandId });
  expect(recovered).toEqual(shown());
});

test("actual App binds fresh force and uncertain retry only when the emitted command matches the receipt", async () => {
  for (const mode of ["fresh", "retry", "mismatch"] as const) {
    const retry = mode === "retry", emittedCommandId = mode === "mismatch" ? "different-command" : receipt.commandId;
    let current: ActionError | null = null;
    const shown = (): ActionError | null => current;
    const setActionErrorState = (next: ActionError | null | ((current: ActionError | null) => ActionError | null)) => {
      current = typeof next === "function" ? next(current) : next;
    };
    const setActionError = (message: string | null) => setActionErrorState(message === null ? null : actionError(message));
    const forceDraft = { ...original, text: "/force read original prompt" };
    let pending: any = retry ? { draft: forceDraft, sessionId: owner.sessionId, mode: "prompt", uncertain: true, force: { nativeForce: true }, forceToolReceipt: receipt } : undefined;
    const submissions = {
      get: () => pending, queuedEntries: () => [], forceTools: { selection: () => ({ nativeForce: true }) },
      submit: async (snapshot: Draft, _sessionId: string, _mode: string, onSend: (draft: Draft, commandId: string) => void, _browser: unknown, force: unknown) => {
        expect(Boolean(force)).toBe(!retry);
        onSend(snapshot, emittedCommandId);
        pending = { draft: snapshot, sessionId: owner.sessionId, mode: "prompt", uncertain: false, force: { nativeForce: true }, forceToolReceipt: receipt };
        throw "known partial force";
      },
    };
    const reportSubmissionError = extractedReport({ submissions, errorMessage, setActionErrorState, ownedActionError: actionError, hostId: owner.hostId, setActionError });
    const usageOwner = usageOwnerFixture(owner.hostId);
    await appSubmit({
      canSend: true, submitting: { current: false }, setBusy() {}, setActionError, reportSubmissionError, usageResetArgument,
      draftId: original.id, selectedRef: { current: `${owner.hostId}:${owner.sessionId}` }, hostId: owner.hostId,
      submissions, drafts: { async prepareSubmission() { return forceDraft; }, beginPendingSubmission() {}, finishSubmission() {}, get() { return { draft: forceDraft }; } },
      hasDraftContent: () => true, hasRemoteExecution: () => false, nativeBtwQuestion: () => undefined,
      forceCommandSpelling: () => true, nativeForceWinner: () => true, assertComposerOwner() {},
      selectedId: owner.sessionId, bridge: { ...usageOwner.bridge, getComposerActions: async () => ({ commands: [] }) }, desktop: usageOwner.desktop, usageRoute: usageOwner.usageRoute,
      state: { forceTool: { version: 1, commandVersion: 18 } }, running: false,
      draftBrowserOwners: { beforeSubmission() {} }, draftBrowserPages: { beforeSubmission() {}, captureContinuation() { return undefined; } }, draftBrowserDocks: new Map(),
      EnvironmentPreparationPause: class extends Error {}, errorMessage, textarea: { current: { focus() {} } },
    })();
    expect(shown()).toEqual(mode === "mismatch" ? actionError("known partial force")
      : actionError("known partial force", { ...owner, commandId: receipt.commandId }));
    expect(usageOwner.releases()).toBe(2);
  }
});

test("actual operation check clears a recovered prompt error but not cancellation history", async () => {
  for (const kind of ["recover", "cancel"] as const) {
    let shown: ActionError | null = actionError("original", { ...owner, commandId: receipt.commandId });
    const finished: string[] = [];
    const done = Promise.withResolvers<void>();
    const callback = extractedOperationCheck({
      forceSessionId: owner.sessionId, operation: { id: "operation", kind }, hostId: owner.hostId,
      submissions: { checkForceOperation: async () => ({ draft: original, originalCommandId: receipt.commandId }) },
      drafts: { finishSubmission: (id: string) => { finished.push(id); } },
      setActionErrorState: (next: ActionError | null | ((current: ActionError | null) => ActionError | null)) => {
        shown = typeof next === "function" ? next(shown) : next;
      },
      clearRecoveredForceError, refresh: () => {}, setBusy: (busy: boolean) => { if (!busy) done.resolve(); },
      setActionError: () => { throw new Error("Unexpected operation-check failure"); }, errorMessage,
    });
    callback(); await done.promise;
    expect(finished).toEqual([original.id]);
    if (kind === "recover") expect(shown).toBeNull();
    else expect(shown).toEqual(actionError("original", { ...owner, commandId: receipt.commandId }));
  }
});
