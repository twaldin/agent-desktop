import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ForceToolPanel } from "./ForceToolControl";
import { ForceToolState, type ForceToolSnapshot, type ForceToolPorts } from "./force-tool-state";
const owner = { hostId: "work", sessionId: "session" };
const native = (): ForceToolSnapshot => ({ epoch: "worker", revision: 1, nativeSessionId: "native",
  model: { provider: "anthropic", id: "example", api: "anthropic-messages" }, availability: { state: "supported", reason: "Native model allows named tools.", thinkingNote: "Native forcing adjusts thinking for this request." },
  tools: [{ name: "read", available: true }, { name: "unavailable-tool", available: false, reason: "Tool was removed" }],
  directives: [{ id: "pending", toolName: "read", phase: "pending-tool", requeued: true }, { id: "active", toolName: "write", phase: "tool-in-flight", requeued: false }], canArm: true, canCancel: true });
async function setup(snapshot = native(), ownerLabel?: string) {
  const calls: unknown[] = [];
  const ports: ForceToolPorts = { read: async () => ({ protocolVersion: 1, ...owner, value: snapshot }),
    insertDraft: (_owner, input) => { calls.push(input); }, cancel: async () => ({ ...snapshot, directives: [] }), recoverPrompt: async () => {} };
  const state = new ForceToolState(owner, ports, "keep this prompt"); state.configure(true, true, "keep this prompt"); await state.refresh();
  return { state, calls, render: () => ForceToolPanel({ state, view: state.getSnapshot(), owner, ownerLabel, id: "force", onClose() {} }) };
}
type Props = { children?: unknown; disabled?: boolean; value?: string; "aria-label"?: string; onClick?: () => void; onChange?: (event: { target: { value: string } }) => void };
function nodes(input: unknown): React.ReactElement<Props>[] {
  if (Array.isArray(input)) return input.flatMap(nodes);
  if (!React.isValidElement<Props>(input)) return [];
  return [input, ...nodes(input.props.children)];
}
function button(tree: unknown, name: string) {
  const item = nodes(tree).find(node => node.type === "button" && (node.props.children === name || node.props["aria-label"] === name));
  if (!item) throw new Error(`Missing ${name}`); return item;
}

test("rendered controls list active/unavailable tools and real queue phases without claiming execution", async () => {
  const f = await setup(), html = renderToStaticMarkup(f.render());
  expect(html).toContain("Current conversation"); expect(html).not.toContain("work · session");
  const named = await setup(native(), "Fix parser · Work Mac");
  expect(renderToStaticMarkup(named.render())).toContain("Fix parser · Work Mac");
  expect(html).toContain("Native forcing adjusts thinking");
  expect(html).toContain("Tool was removed"); expect(html).toContain("requeued by native OMP");
  expect(html).toContain("Tool request in progress"); expect(html).toContain("not proof that the tool executed");
  expect(button(f.render(), "Remove pending force for read").props.disabled).toBe(false);
  expect(button(f.render(), "Remove pending force for write").props.disabled).toBe(true);
});
test("component selection and optional prompt changes only insert into composer on explicit action", async () => {
  const f = await setup(); let tree = f.render();
  expect(button(tree, "Add to composer").props.disabled).toBe(true);
  nodes(tree).find(node => node.type === "select")!.props.onChange!({ target: { value: "read" } });
  tree = f.render(); nodes(tree).find(node => node.type === "textarea")!.props.onChange!({ target: { value: "" } });
  expect(f.calls).toHaveLength(0); tree = f.render(); expect(button(tree, "Add to composer").props.disabled).toBe(false);
  button(tree, "Add to composer").props.onClick!(); expect(f.calls).toMatchObject([{ text: "/force read", expectedDraftText: "keep this prompt" }]);
});
test("degraded and unsupported native API states stay visible with active tools", async () => {
  for (const state of ["degraded", "unsupported"] as const) {
    const f = await setup({ ...native(), availability: { state, reason: state === "degraded" ? "Native provider downgrades named force to auto." : "Pinned Google native /force rejects named forcing." } });
    f.state.select("read"); const html = renderToStaticMarkup(f.render());
    expect(html).toContain(state === "degraded" ? "Native forcing is limited" : "Native forcing unavailable");
    expect(html).toContain("read"); expect(button(f.render(), "Add to composer").props.disabled).toBe(state === "unsupported");
  }
});
test("offline renderer preserves optional prompt while disabling all queue writes", async () => {
  const f = await setup(); f.state.select("read"); f.state.setPrompt("retained edit"); f.state.configure(false, true, "keep this prompt");
  const html = renderToStaticMarkup(f.render()); expect(html).toContain("Offline · cached state"); expect(html).toContain("retained edit");
  expect(button(f.render(), "Add to composer").props.disabled).toBe(true); expect(button(f.render(), "Remove pending force for read").props.disabled).toBe(true);
});
