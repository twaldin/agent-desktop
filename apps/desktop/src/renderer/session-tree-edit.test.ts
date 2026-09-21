import { expect, test } from "bun:test";
import type { CommandEnvelope, CommandResult, DesktopBridge } from "@agent-desktop/shared";
import type { SessionTree, TreeMutationResult } from "../../../../packages/shared/src/session-tree";
import { SessionTreeEditState } from "./session-tree-edit";
const owner = { hostId: "host-a", sessionId: "session-a", targetId: "old-user" };
const ticket = { nativeSessionId: owner.sessionId, epoch: "worker-a", revision: "before" };
function tree(revision = "before"): SessionTree {
  return { ticket: { ...ticket, revision }, leafId: "old-user", entries: [{ id: "old-user", parentId: null, timestamp: "2026-09-20", kind: "user", text: "Original", active: true, editable: true, imageCount: 0 }], summariesEnabled: false, nativeCommandAvailable: true, reconciliationRequired: false };
}
function fixture() {
  const storage = new Map<string, string>(), commands: CommandEnvelope[] = [];
  const navigation = Promise.withResolvers<CommandResult>();
  let current = tree(), receipt: unknown;
  const bridge = {
    async getSessionTree(_session: string, _host?: string, commandId?: string) { return { hostId: owner.hostId, sessionId: owner.sessionId, tree: current, ...(commandId ? { receipt } : {}) }; },
    async command(envelope: CommandEnvelope) { commands.push(envelope); if (envelope.command.type === "session.tree.mutate") return navigation.promise; return { commandId: envelope.id, ok: true, admission: { kind: "user-message", entryId: "new-user" } }; },
  } as unknown as DesktopBridge;
  const backing = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } };
  const create = () => { const state = new SessionTreeEditState(owner, "Original", 0, bridge, backing, undefined, ticket); state.configure(true); return state; };
  function finishNavigation() {
    current = tree("after"); const result: TreeMutationResult = { commandId: commands[0]!.id, cancelled: false, state: current, draft: { text: "Native exact text", images: [] } };
    receipt = { commandId: result.commandId, state: "succeeded", result };
    navigation.resolve({ commandId: result.commandId, ok: true, value: { type: "session.tree.mutate", result } });
  }
  return { create, commands, storage, finishNavigation, setCurrent: (value: SessionTree) => { current = value; }, setReceipt: (value: unknown) => { receipt = value; } };
}
async function waitForNavigation(value: ReturnType<typeof fixture>) { for (let n = 0; n < 50 && !value.commands.length; n++) await Bun.sleep(1); expect(value.commands).toHaveLength(1); }
test("Stop while the native navigation reply is held never submits from its later successful reply", async () => {
  const f = fixture(), state = f.create(); state.update({ text: "Revised question" }); const send = state.send(); await waitForNavigation(f);
  state.stop(); f.finishNavigation(); await send;
  expect(f.commands).toHaveLength(1); expect(state.getSnapshot().uncertain).toBe(true); expect(state.getSnapshot().text).toBe("Revised question"); expect(f.storage.size).toBe(1);
  await state.inspect(); expect(state.getSnapshot().prepared).toBe(true); expect(f.commands).toHaveLength(1);
  await state.send(); expect(f.commands).toHaveLength(2); expect(state.getSnapshot().sent).toBe(true); expect(f.storage.size).toBe(0);
});
test("original owner disconnect fences late navigation, preserved command is inspected after reopen without replay", async () => {
  const f = fixture(), state = f.create(), send = state.send(); await waitForNavigation(f); state.disconnect(); f.finishNavigation(); await send;
  expect(f.commands).toHaveLength(1); const reopened = f.create(); expect(reopened.getSnapshot().uncertain).toBe(true);
  await reopened.inspect(); expect(reopened.getSnapshot().text).toBe("Native exact text"); expect(f.commands).toHaveLength(1);
});
test("known stale branch requires explicit use-current action and keeps edited text", async () => {
  const f = fixture(), state = f.create(); state.update({ text: "Preserved edit" }); f.setCurrent(tree("other-client")); await state.send();
  expect(f.commands).toHaveLength(0); expect(state.getSnapshot().error).toContain("History changed"); await state.reviewCurrent();
  const send = state.send(); await waitForNavigation(f); f.finishNavigation(); await send;
  expect(f.commands[1]?.command).toMatchObject({ type: "session.prompt", text: "Preserved edit", treeTicket: { ...ticket, revision: "after" } });
});
test("corrupt saved edit stays untouched and cannot crash or dispatch", async () => {
  const f = fixture(), key = `agent-desktop:history-edit:v1:${JSON.stringify(owner)}`; f.storage.set(key, "{invalid"); const state = f.create();
  expect(state.getSnapshot().uncertain).toBe(true); await state.send(); await state.inspect(); state.cancel(); state.update({ text: "overwrite" });
  expect(f.commands).toHaveLength(0); expect(f.storage.get(key)).toBe("{invalid");
});
test("cancel before navigation makes no history command and removes only the inline edit", () => {
  const f = fixture(), state = f.create(); f.storage.set("main-composer-draft", "unchanged"); state.update({ text: "cancelled" }); state.cancel();
  expect(f.commands).toHaveLength(0); expect([...f.storage]).toEqual([["main-composer-draft", "unchanged"]]);
});
test("explicit current-branch recovery retains text, inspects the old receipt and does not replay navigation", async () => {
 const f = fixture(), state = f.create(); state.update({ text: "Retained revision" }); const send = state.send(); await waitForNavigation(f);
 state.stop(); f.finishNavigation(); await send; await state.inspect();
 f.setCurrent(tree("different-branch")); await state.send();
 expect(state.getSnapshot().error).toContain("branch changed"); expect(f.commands).toHaveLength(1);
 await state.reviewCurrent(); expect(state.getSnapshot()).toMatchObject({ text: "Retained revision", prepared: false, uncertain: false });
 expect(f.commands).toHaveLength(1); expect([...f.storage.values()][0]).toContain('"revision":"different-branch"');
});
