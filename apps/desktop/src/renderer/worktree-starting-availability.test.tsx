import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { Draft, HostState, DesktopBridge } from "../../../../packages/shared/src/protocol";
import { hasRemoteExecution } from "../../../../packages/shared/src/new-chat";
import { hasDraftContent } from "./drafts";
import { EnvironmentPreparationPause, SubmissionController, type PendingSubmission } from "./submissions";
import { EnvironmentPreparationCard } from "./EnvironmentPreparationCard";
import { remoteWorktreeIssue, remoteWorktreeResumeIssue } from "./worktree-starting-availability";

const capabilities: Pick<HostState, "newChatExecution" | "localEnvironments"> = {
  newChatExecution: { commandVersion: 4, worktrees: true, startingRefs: { commandVersion: 12, remote: true } },
  localEnvironments: { configuration: true, execution: { commandVersion: 5 } },
};
const remote: Draft = { id: "new-conversation", revision: 7, updatedAt: 10, projectId: "project-a", text: "Read the file", model: null, environment: null,
  execution: { type: "worktree", startingState: { type: "branch", branchName: "Origin topic", remoteRef: "refs/remotes/origin/topic" } } };
const pending: PendingSubmission = { draft: remote, mode: "prompt", uncertain: false, preparation: { id: "original-create", revision: 3, hostId: "host-a", projectId: "project-a", phase: "validated", worktreePath: "/fixture/worktree", needsAttention: false, environment: null, createdAt: 1, updatedAt: 2 } };
const resumeEnvelope = { id: "original-resume", commandVersion: 12 as const, command: { type: "session.environment.resume" as const, preparationId: pending.preparation!.id, expectedRevision: 3 } };
const app = readFileSync(process.env.WORKTREE_AVAILABILITY_APP ?? new URL("./App.tsx", import.meta.url), "utf8");
function expression(name: string, values: Record<string, unknown>): unknown {
  const matches = [...app.matchAll(new RegExp(`const ${name} = ([\\s\\S]*?);\\n`, "g"))];
  if (matches.length !== 1) throw new Error(`Expected one ${name} expression`);
  return new Function(...Object.keys(values), `return (${matches[0]![1]});`)(...Object.values(values));
}
function appHandler(name: "submit" | "resumeEnvironment", values: Record<string, unknown>): () => Promise<void> {
  const start = app.indexOf(`  async function ${name}()`);
  const end = app.indexOf("  async function ", start + 10);
  if (start < 0 || end < 0) throw new Error("Missing App handler");
  const code = new Bun.Transpiler({ loader: "tsx" }).transformSync(`function build(values) { const {${Object.keys(values).join(",")}} = values; ${app.slice(start, end)} return ${name}; }`);
  return new Function(`${code}; return build;`)()(values);
}

test("remote availability requires all advertised owning-host capabilities; Local remains compatible", () => {
  expect(remoteWorktreeIssue(remote.execution, capabilities)).toBeUndefined();
  for (const state of [undefined, {}, { newChatExecution: { commandVersion: 4, worktrees: true } }, { ...capabilities, localEnvironments: undefined }]) {
    expect(remoteWorktreeIssue(remote.execution, state as typeof capabilities)).toContain("owning host");
    expect(remoteWorktreeIssue({ type: "local" }, state as typeof capabilities)).toBeUndefined();
  }
  for (const change of [{ commandVersion: 11, remote: true }, { commandVersion: 12, remote: false }]) {
    expect(remoteWorktreeIssue(remote.execution, { ...capabilities, newChatExecution: { ...capabilities.newChatExecution!, startingRefs: change as never } })).toBeDefined();
  }
});

test("actual App readiness accepts a saved remote choice without inventing a local branch", () => {
  const workspace = { restored: true, status: { branch: "main", entries: [] }, branches: [], busy: false, pending: undefined };
  const values = { selectedId: null, draft: remote, worktreesAvailable: true, project: { id: "project-a" }, workspace, executionBranch: "Origin topic", hasRemoteExecution, remoteExecutionIssue: undefined };
  expect(expression("executionReady", values)).toBe(true);
  expect(expression("executionReady", { ...values, remoteExecutionIssue: "Update host" })).toBe(false);
  expect(expression("executionReady", { ...values, workspace: { ...workspace, busy: true } })).toBe(false);
  expect(expression("executionReady", { ...values, workspace: { ...workspace, status: undefined } })).toBe(false);
  const localBranch = { ...remote, execution: { type: "worktree", startingState: { type: "branch", branchName: "Origin topic" } } };
  expect(expression("executionReady", { ...values, draft: localBranch })).toBe(false);
  expect(expression("executionReady", { ...values, draft: localBranch, workspace: { ...workspace, status: { ...workspace.status, branch: "Origin topic" } } })).toBe(true);
  expect(expression("environmentReady", { selectedId: null, draft: { ...remote, environment: undefined }, environmentAvailable: false, environmentCatalog: undefined, hasRemoteExecution })).toBe(false);
});

test("actual App send gate blocks fresh remote consumption but keeps original uncertain checking available", () => {
  const values = { connected: true, state: {}, busy: false, missingSession: false, pendingSubmission: undefined, hasDraftContent, draft: remote,
    imageIssue: undefined, selectedTextIssue: undefined, wholeFileIssue: undefined, imagesStaging: false, remoteExecutionIssue: "Update host", executionReady: true, environmentReady: true,
    view: { status: "saved" }, modeView: undefined, selected: undefined };
  expect(expression("canSend", values)).toBe(false);
  expect(expression("canSend", { ...values, remoteExecutionIssue: undefined })).toBe(true);
  expect(expression("canSend", { ...values, pendingSubmission: { uncertain: true } })).toBe(true);
});

test("actual App submit rechecks the owning host after the saved-draft await", async () => {
  for (const loss of ["capability", "connection", "unchanged"] as const) {
    let release!: (draft: Draft) => void;
    const saved = new Promise<Draft>(resolve => { release = resolve; });
    const owner = { connected: true, state: { ...capabilities, drafts: [] } };
    const records = new Map([["host-a", owner]]);
    let dispatched = 0; const errors: unknown[] = [];
    const values = {
      canSend: true, submitting: { current: false }, setBusy() {}, setActionError(value: unknown) { if (value) errors.push(value); }, draftId: remote.id, selectedRef: { current: "host-a:new" }, hostId: "host-a",
      submissions: { get() { return undefined; }, async submit(snapshot: Draft) { dispatched++; return { submitted: snapshot, sessionId: "new-session", commandId: "send-id" }; } },
      drafts: { async prepareSubmission() { return saved; }, beginPendingSubmission() {}, finishSubmission() {}, get() { return { draft: remote }; }, ingest() {} },
      hasDraftContent, hasRemoteExecution, remoteWorktreeIssue, desktop: { catalog: { records } }, selectedId: null, running: false, nativeBtwQuestion() { return undefined; },
      async refresh() {}, transcript: { refresh() {} }, navigate() {}, textarea: { current: { focus() {} } }, EnvironmentPreparationPause, errorMessage: String,
    };
    const run = appHandler("submit", values)();
    expect(dispatched).toBe(0);
    if (loss === "capability") owner.state = { drafts: [] };
    if (loss === "connection") owner.connected = false;
    release(remote); await run;
    expect(dispatched).toBe(loss === "unchanged" ? 1 : 0);
    expect(errors).toHaveLength(loss === "unchanged" ? 0 : 1);
    expect(values.submitting.current).toBe(false);
  }
});

test("resume availability uses the captured draft and preserves exact-envelope recovery", () => {
  expect(remoteWorktreeResumeIssue(pending, {})).toContain("owning host");
  expect(remoteWorktreeResumeIssue(pending, capabilities)).toBeUndefined();
  expect(remoteWorktreeResumeIssue({ ...pending, draft: { ...remote, execution: { type: "local" } } }, {})).toBeUndefined();
  expect(remoteWorktreeResumeIssue({ ...pending, uncertain: true }, {})).toBeDefined();
  expect(remoteWorktreeResumeIssue({ ...pending, resume: { id: "resume-id", commandVersion: 12, command: { type: "session.environment.resume", preparationId: pending.preparation!.id, expectedRevision: 3 } } }, {})).toBeUndefined();
});

test("actual preparation card disables new continuation with an explanation, keeping status and cancellation separate", () => {
  const bridge = {} as DesktopBridge, submissions = new SubmissionController(async () => { throw new Error("No dispatch permitted"); }, "host-a");
  const markup = (item: PendingSubmission) => renderToStaticMarkup(<EnvironmentPreparationCard bridge={bridge} hostId="host-a" pending={item} submissions={submissions} connected busy={false}
    executionControls={{ scriptCancellation: true }} resumeIssue={remoteWorktreeResumeIssue(item, {})} onResume={() => { throw new Error("SSR dispatch"); }} onSettings={() => {}}/>);
  const blocked = markup(pending);
  expect(blocked).toContain('disabled="">Continue and send'); expect(blocked).toContain("Update the owning host");
  expect(blocked).toContain("Check status"); expect(blocked).not.toContain('disabled=""><svg');
  const retry = markup({ ...pending, uncertain: true, resume: resumeEnvelope });
  expect(retry).toContain(">Check original submission</button>"); expect(retry).not.toContain('disabled="">Check original submission');
  const running = markup({ ...pending, preparation: { ...pending.preparation!, phase: "setup-running" } });
  expect(running).toContain(">Cancel</button>"); expect(running).not.toContain('disabled="">Cancel');
});

test("actual App resume consults live capture and capabilities before dispatching a new continuation", async () => {
  for (const checking of [false, true]) {
    let dispatched = 0; const errors: unknown[] = [];
    const current = { ...pending, uncertain: true, ...(checking ? { resume: resumeEnvelope } : {}) };
    const values = { submitting: { current: false }, connected: true, pendingSubmission: pending, draftId: remote.id, selectedRef: { current: "host-a:new" }, hostId: "host-a",
      submissions: { get() { return current; }, async resumeEnvironment() { dispatched++; return { submitted: remote, sessionId: "new-session", commandId: "send-id" }; } },
      desktop: { catalog: { records: new Map([["host-a", { connected: true, state: { drafts: [] } }]]) } }, remoteWorktreeResumeIssue,
      setActionError(value: unknown) { if (value) errors.push(value); }, setBusy() {}, drafts: { beginPendingSubmission() {}, finishSubmission() {}, get() { return { draft: remote }; } },
      async refresh() {}, transcript: { refresh() {} }, hasDraftContent, navigate() {}, EnvironmentPreparationPause, errorMessage: String,
    };
    await appHandler("resumeEnvironment", values)();
    expect(dispatched).toBe(checking ? 1 : 0); expect(errors).toHaveLength(checking ? 0 : 1);
  }
});
