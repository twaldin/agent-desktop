import { expect, test } from "bun:test";
import React from "react";
import { TodoExternalEditorControls } from "./TodoExternalEditor";
import { TodoExternalEditorState, type TodoEditorPorts } from "./todo-external-editor-state";
import type { TodoExternalEditorObservation } from "../../../../packages/shared/src/todo-external-editor";

type Props = { children?: unknown; disabled?: boolean; onClick?: () => unknown; value?: string; "aria-label"?: string };
function elements(value: unknown): React.ReactElement<Props>[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  return React.isValidElement<Props>(value) ? [value, ...elements(value.props.children)] : [];
}
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("");
  return React.isValidElement<Props>(value) ? text(value.props.children) : "";
}
function button(tree: unknown, label: string) { const found = elements(tree).find(node => node.type === "button" && text(node) === label); expect(found).toBeDefined(); return found!; }
test("production Todo controls expose accurate unavailable, original terminal/cancel and copy-only recovery actions", async () => {
  const request = { requestId: crypto.randomUUID(), controlEpoch: crypto.randomUUID(), sessionId: "session", ticket: { epoch: "worker", nativeSessionId: "session", revision: "revision" } };
  let job: TodoExternalEditorObservation = { protocolVersion: 1, hostId: "host", request, state: "pending", terminalId: crypto.randomUUID() };
  const actions: string[] = [], copies: string[] = [];
  const ports: TodoEditorPorts = { storage: { getItem: () => null, setItem: () => {} }, openTerminal: () => actions.push("terminal"), refreshTodos: async () => {}, copy: async value => { copies.push(value); }, bridge: {
    getTodoEditorCapabilities: async () => ({ protocolVersion: 1, hostId: "host", controlEpoch: request.controlEpoch, available: false, reason: "No editor configured on the owning host. Set VISUAL or EDITOR." }),
    listTodoEditors: async () => ({ protocolVersion: 1, hostId: "host", sessionId: "session", items: [job] }),
    startTodoEditor: async () => { actions.push("start"); return job; }, getTodoEditorStatus: async () => job,
    cancelTodoEditor: async () => { actions.push("cancel"); return { ...job, state: "settled", result: { outcome: "unknown" } }; },
    recoverTodoEditor: async () => ({ observation: job, content: "recover this", source: "completed-output" }),
  } };
  const editor = new TodoExternalEditorState({ hostId: "host", sessionId: "session", connected: true, fresh: true, open: true, dirty: false,
    todos: { ticket: request.ticket, phases: [], markdown: "# Todos\n", nativeCommandAvailable: true, reconciliationRequired: false } }, ports);
  await editor.refresh();
  let tree = TodoExternalEditorControls({ editor, state: editor.getSnapshot(), connected: true });
  expect(button(tree, "Edit in configured editor").props.disabled).toBe(true);
  await button(tree, "Open editor terminal").props.onClick!();
  await editor.act(request.requestId, "cancel");
  expect(actions).toEqual(["terminal", "cancel"]);
  job = { ...job, state: "settled", result: { outcome: "unknown" } }; await editor.refresh();
  tree = TodoExternalEditorControls({ editor, state: editor.getSnapshot(), connected: true });
  expect(text(tree)).toContain("No editor configured");
  expect(button(tree, "Recover edited text").props.disabled).toBe(false);
  await editor.act(request.requestId, "recover");
  tree = TodoExternalEditorControls({ editor, state: editor.getSnapshot(), connected: true });
  expect(elements(tree).find(node => node.props["aria-label"] === "Recovered editor text")?.props.value).toBe("recover this");
  await editor.act(request.requestId, "copy"); expect(copies).toEqual(["recover this"]); expect(actions).not.toContain("start");
});
