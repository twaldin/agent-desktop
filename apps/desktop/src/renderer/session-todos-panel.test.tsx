import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentCard } from "./EnvironmentCard";
import type { WorkspaceState } from "./workspace-state";
import { SessionTodosPanel, SessionTodosPanelContent } from "./SessionTodos";
import { SessionTodosModel, type SessionTodosPanelInput, type SessionTodosPanelPorts } from "./session-todos-model";
import { TodosNotSubmitted } from "./use-session-todos";
import type { SessionTodos, TodoMutationRequest, TodoMutationResult } from "../../../../packages/shared/src/session-todos";
import { planTodoMutation, type TodoPlanVerb } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/todo";
import { parseSlashCommand, parseSubcommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse";

type Props = { children?: unknown; disabled?: boolean; value?: string; "aria-pressed"?: boolean; "aria-label"?: string; "data-status"?: string;
  className?: string; role?: string; onClick?: () => void; onChange?: (event: { target: { value: string } }) => void; onSubmit?: (event: { preventDefault(): void }) => void };
function nodes(input: unknown): React.ReactElement<Props>[] {
  if (Array.isArray(input)) return input.flatMap(nodes);
  if (!React.isValidElement<Props>(input)) return [];
  return [input, ...nodes(input.props.children)];
}
function text(input: unknown): string {
  if (Array.isArray(input)) return input.map(text).join("");
  if (React.isValidElement<Props>(input)) return text(input.props.children);
  return typeof input === "string" || typeof input === "number" ? String(input) : "";
}
function button(tree: unknown, label: string) {
  const node = nodes(tree).find(node => node.type === "button" && (text(node) === label || node.props["aria-label"] === label));
  if (!node) throw new Error(`Missing button ${label}`); return node;
}
const hash = "a".repeat(64), later = "b".repeat(64);
const owner = { hostId: "home", sessionId: "session" };
const state = (revision = hash, content = "Install deps"): SessionTodos => ({
  ticket: { epoch: "worker", nativeSessionId: "session", revision },
  phases: [
    { name: "Setup", tasks: [{ content, status: "in_progress" }, { content: "Wire CI", status: "blocked", blocker: "Waiting for credentials" }] },
    { name: "Ship", tasks: [{ content: "Write docs", status: "pending" }, { content: "Old idea", status: "abandoned" }, { content: "Tag release", status: "completed" }] },
  ],
  markdown: `## Setup\n- [~] ${content}\n- [!] Wire CI\n## Ship\n- [ ] Write docs\n- [-] Old idea\n- [x] Tag release\n`,
  nativeCommandAvailable: true, reconciliationRequired: false,
});
function fixture(patch: Partial<SessionTodosPanelInput> = {}, refuse?: (request: TodoMutationRequest) => string | undefined) {
  let input: SessionTodosPanelInput = { owner, connected: true, fresh: true, loading: false, pending: false, uncertain: false, value: state(), ...patch };
  const requests: TodoMutationRequest[] = [], copies: string[] = []; let refreshes = 0;
  const ports: SessionTodosPanelPorts = {
    mutate: async (_owner, request) => {
      requests.push(request);
      const refusal = refuse?.(request); if (refusal) throw new TodosNotSubmitted(refusal);
      const result: TodoMutationResult = { commandId: "command", state: state(later), output: "ok" }; return result;
    },
    refresh: async () => { refreshes++; }, copy: async value => { copies.push(value); },
  };
  const model = new SessionTodosModel(input, ports);
  return { model, requests, copies, get refreshes() { return refreshes; }, get input() { return input; },
    configure(next: Partial<SessionTodosPanelInput>) { input = { ...input, ...next }; model.configure(input, ports); },
    render: () => SessionTodosPanelContent({ model, view: model.getSnapshot(), id: "todos" }) };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const tasks = (tree: unknown) => nodes(tree).filter(node => node.type === "li" && node.props["data-status"]);

test("phases and all five statuses render in native order with blockers, and selection survives an agent update", async () => {
  const f = fixture(); let tree = f.render();
  expect(tasks(tree).map(node => node.props["data-status"])).toEqual(["in_progress", "blocked", "pending", "abandoned", "completed"]);
  expect(nodes(tree).filter(node => node.type === "section").map(node => node.props["aria-label"])).toEqual(["Setup", "Ship"]);
  expect(nodes(tree).some(node => node.props.className === "session-todos-blocker" && text(node) === "Blocked: Waiting for credentials")).toBe(true);
  expect(nodes(tree).some(node => node.props.role === "group")).toBe(false);
  button(tree, "◐Install depsIn progress").props.onClick!(); tree = f.render();
  expect(nodes(tree).find(node => node.props.role === "group")?.props["aria-label"]).toBe("Actions for Install deps");
  expect(button(tree, "◐Install depsIn progress").props["aria-pressed"]).toBe(true);
  f.configure({ value: { ...state(later), phases: [{ name: "Extra", tasks: [{ content: "New agent task", status: "pending" }] }, ...state(later).phases] } });
  tree = f.render();
  expect(tasks(tree)).toHaveLength(6); expect(button(tree, "◐Install depsIn progress").props["aria-pressed"]).toBe(true);
  f.configure({ value: state("c".repeat(64), "Renamed by agent") }); tree = f.render();
  expect(nodes(tree).some(node => node.props.role === "group")).toBe(false);
  expect(nodes(tree).filter(node => node.type === "button" && node.props["aria-pressed"] === true)).toHaveLength(0);
});

test("panel task actions use native grammar without turning a multiword task into a phase", async () => {
  let native = state();
  const input = (): SessionTodosPanelInput => ({ owner, connected: true, fresh: true, loading: false, pending: false, uncertain: false, value: native });
  const ports: SessionTodosPanelPorts = { refresh: async () => {}, mutate: async (_owner, request) => {
    if (request.mutation.action !== "command") throw new Error("Expected native command");
    const command = parseSlashCommand(request.mutation.text)!;
    const { verb, rest } = parseSubcommand(command.args);
    const plan = planTodoMutation(verb as TodoPlanVerb, rest, native.phases);
    if (!plan.edit) throw new Error(plan.message);
    native = { ...native, phases: plan.edit.phases };
    return { commandId: "command", state: native, output: plan.message };
  } };
  const model = new SessionTodosModel(input(), ports);
  model.setAppend({ text: 'Handle "quoted" windows\\paths' });
  await model.append();
  expect(native.phases.map(phase => phase.name)).toEqual(["Setup", "Ship"]);
  expect(native.phases[1]!.tasks.at(-1)!.content).toBe('Handle "quoted" windows\\paths');
  model.configure(input(), ports);
  await model.taskAction("start", native.phases[1]!.tasks.at(-1)!);
  expect(native.phases[1]!.tasks.at(-1)!.status).toBe("in_progress");
  expect(native.phases.flatMap(phase => phase.tasks).filter(task => task.status === "in_progress")).toHaveLength(1);
  model.configure(input(), ports);
  await model.taskAction("rm", native.phases[1]!.tasks.at(-1)!);
  expect(native.phases[1]!.tasks.map(task => task.content)).toEqual(["Write docs", "Old idea", "Tag release"]);
});

test("authored Markdown survives native changes, a stale ticket is refused locally, and only an explicit choice rebases it", async () => {
  const f = fixture({}, request => request.ticket.revision !== f.input.value!.ticket.revision ? "The native Todos changed." : undefined);
  button(f.render(), "Edit").props.onClick!();
  let editor = nodes(f.render()).find(node => node.type === "textarea")!;
  expect(editor.props.value).toBe(state().markdown);
  f.configure({ value: state(later) }); editor = nodes(f.render()).find(node => node.type === "textarea")!;
  expect(editor.props.value).toBe(state(later).markdown);
  editor.props.onChange!({ target: { value: "## Setup\n- [x] Install deps\n" } });
  f.configure({ value: state("c".repeat(64)) }); let tree = f.render();
  expect(nodes(tree).find(node => node.type === "textarea")!.props.value).toBe("## Setup\n- [x] Install deps\n");
  expect(nodes(tree).some(node => node.props.className === "session-todos-conflict")).toBe(true);
  expect(nodes(tree).some(node => node.type === "button" && text(node) === "Save edits")).toBe(false);
  button(tree, "Save over latest").props.onClick!(); await flush();
  expect(f.requests[0]).toEqual({ sessionId: "session", ticket: state("c".repeat(64)).ticket, mutation: { action: "edit", markdown: "## Setup\n- [x] Install deps\n" } });
  expect(f.model.getSnapshot().local.edit).toBeUndefined();
  button(f.render(), "Edit").props.onClick!(); nodes(f.render()).find(node => node.type === "textarea")!.props.onChange!({ target: { value: "## Later\n" } });
  f.model.select({ phase: "Setup", task: "Wire CI" });
  f.configure({ value: state("d".repeat(64)) });
  await f.model.saveEdits(); tree = f.render();
  expect(f.requests).toHaveLength(1);
  expect(nodes(tree).find(node => node.props.role === "alert" && node.props.className === "session-todos-error")?.props.children).toContain("Save over the latest state");
  expect(nodes(tree).find(node => node.type === "textarea")!.props.value).toBe("## Later\n");
  expect(f.model.getSnapshot().selected?.task.content).toBe("Wire CI");
});

test("a replacement worker conflicts with authored edits even when its branch revision is unchanged", async () => {
  const f = fixture();
  f.model.setEditing(true); f.model.setText("# Authored\n- [ ] Kept text\n");
  f.configure({ value: { ...state(), ticket: { ...state().ticket, epoch: "replacement" } } });
  expect(f.model.getSnapshot().conflict).toBe(true);
  await f.model.saveEdits();
  expect(f.requests).toHaveLength(0);
  expect(f.model.getSnapshot().local.edit?.text).toBe("# Authored\n- [ ] Kept text\n");
  await f.model.saveEdits(true);
  expect(f.requests[0]!.ticket.epoch).toBe("replacement");
});

test("copy uses the exact native Markdown including its final newline", async () => {
  const f = fixture(); button(f.render(), "Copy").props.onClick!(); await flush();
  expect(f.copies).toEqual([state().markdown]); expect(f.copies[0]!.endsWith("\n")).toBe(true);
  const without = fixture(); (without.model as SessionTodosModel).configure(without.input, { mutate: async () => { throw new Error("unused"); }, refresh: async () => {} });
  expect(button(without.render(), "Copy").props.disabled).toBe(true);
});

test("an unconfirmed original command is inspectable and blocks every change until the journal settles it", async () => {
  const original = { commandId: "todo-lost", request: { sessionId: "session", ticket: state().ticket, mutation: { action: "command" as const, text: "/todo done Install deps" } } };
  const f = fixture({ uncertain: true, fresh: true, original, receipt: { commandId: "todo-lost", state: "unknown" }, error: "The original Todos command outcome is unknown." });
  let tree = f.render();
  const recovery = nodes(tree).find(node => node.props.className === "session-todos-recovery")!;
  expect(text(recovery)).toContain("todo-lost"); expect(text(recovery)).toContain("/todo done Install deps"); expect(text(recovery)).toContain("Outcome unknown");
  button(tree, "◐Install depsIn progress").props.onClick!(); tree = f.render();
  for (const label of ["Start", "Done", "Drop", "Remove"]) expect(button(nodes(tree).find(node => node.props.role === "group")!, label).props.disabled).toBe(true);
  expect(button(tree, "Add").props.disabled).toBe(true);
  await f.model.command("/todo rm"); expect(f.requests).toHaveLength(0);
  button(tree, "Check original command status").props.onClick!(); await flush(); expect(f.refreshes).toBe(1); expect(f.requests).toHaveLength(0);
  f.configure({ uncertain: false, original: undefined, receipt: { commandId: "todo-lost", state: "failed", error: "Revision mismatch." }, error: "The owning host refused the original Todos command before any change: Revision mismatch." });
  tree = f.render();
  expect(nodes(tree).some(node => node.props.className === "session-todos-recovery")).toBe(false);
  expect(nodes(tree).find(node => node.props.role === "alert")?.props.children).toContain("refused");
  expect(button(nodes(tree).find(node => node.props.role === "group")!, "Done").props.disabled).toBe(false);
});

test("busy, stale, offline and command-unavailable states explain themselves while Markdown editing stays possible", async () => {
  const f = fixture({ value: { ...state(), busyReason: "The agent is streaming a response." } });
  let tree = f.render();
  expect(nodes(tree).some(node => node.props.role === "status" && node.props.children === "The agent is streaming a response.")).toBe(true);
  expect(button(tree, "Add").props.disabled).toBe(true); expect(button(tree, "Edit").props.disabled).toBe(true);
  f.configure({ value: { ...state(), nativeCommandAvailable: false } }); tree = f.render();
  expect(button(tree, "Add").props.disabled).toBe(true); expect(button(tree, "Edit").props.disabled).toBe(false);
  await f.model.command("/todo done Install deps"); expect(f.requests).toHaveLength(0);
  expect(f.model.getSnapshot().local.error).toContain("Edit the Markdown instead");
  f.configure({ value: state(), fresh: false }); expect(f.model.getSnapshot().blockedReason).toContain("stale");
  f.configure({ fresh: true, connected: false }); expect(f.model.getSnapshot().blockedReason).toContain("Offline");
  expect(button(f.render(), "Refresh todos").props.disabled).toBe(true);
  f.configure({ connected: true, value: null, unavailable: "Update the owning host and desktop to use native Todos." }); tree = f.render();
  expect(nodes(tree).some(node => node.props.children === "Update the owning host and desktop to use native Todos.")).toBe(true);
  expect(nodes(tree).filter(node => node.type === "section")).toHaveLength(0);
  f.configure({ unavailable: undefined, value: { ...state(), phases: [], markdown: "" } });
  expect(nodes(f.render()).some(node => node.props.children === "No todos yet. Add a task or let the agent create a plan.")).toBe(true);
});

test("the mounted panel renders inside the Environment card Todos section with persisted disclosure and open-task count", () => {
  const workspace = { gitAvailability: "not-repository", status: undefined, branches: [], worktrees: [], loading: new Set(), errors: {},
    restored: true, busy: false, connected: true, pending: undefined, subscribe: () => () => {} } as unknown as WorkspaceState;
  const f = fixture();
  const card = (collapsed: boolean, todos?: { count: number; content: React.ReactNode }) => renderToStaticMarkup(<EnvironmentCard hostName="Home" cwd="/tmp/plain" local connected
    workspace={workspace} sources={[]} onReview={() => {}} onCommit={() => {}} onFiles={() => {}} onTerminal={() => {}} onHost={() => {}} branchPrefix="codex/"
    onOpenGitSettings={() => {}} collapsedSections={collapsed ? ["todos"] : []} onToggleSection={() => {}} todos={todos}/>);
  const panel = <SessionTodosPanel model={f.model} {...f.input} mutate={async () => { throw new Error("unused"); }} refresh={async () => {}}/>;
  const expanded = card(false, { count: 3, content: panel });
  expect(expanded).toContain('data-section="todos"'); expect(expanded).toContain("Wire CI"); expect(expanded).toContain("Blocked: Waiting for credentials");
  expect(expanded).toContain('role="toolbar"'); expect(expanded).not.toContain("environment-section-count");
  const collapsed = card(true, { count: 3, content: panel });
  expect(collapsed).toContain('aria-expanded="false"'); expect(collapsed).toContain('class="environment-section-count">3<');
  expect(collapsed).toMatch(/class="environment-section-body" hidden=""/);
  expect(card(false)).not.toContain('data-section="todos"');
});
