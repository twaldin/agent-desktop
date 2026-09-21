import { expect, test } from "bun:test";
import { SessionTreeState, type SessionTreePorts } from "./use-session-tree";
import type { SessionTree, SessionTreeResponse, TreeMutationResult } from "../../../../packages/shared/src/session-tree";
import type { CommandEnvelope, CommandResult } from "@agent-desktop/shared";
const owner = { hostId: "host", sessionId: "session" };
const tree = (revision: string): SessionTree => ({ ticket: { nativeSessionId: "session", epoch: "epoch", revision }, entries: [{ id: "entry", parentId: null, timestamp: "today", kind: "user", text: revision, active: true, editable: true, imageCount: 0 }], leafId: "entry", summariesEnabled: false, nativeCommandAvailable: true, reconciliationRequired: false });
test("delayed original navigation receipt never replaces a newer authoritative branch as fresh", async () => {
 const reply = Promise.withResolvers<CommandResult>(), refresh = Promise.withResolvers<SessionTreeResponse>(); let command: CommandEnvelope | undefined, reads = 0;
 const state = new SessionTreeState(owner);
 const ports: SessionTreePorts = { bridge: { subscribe: () => () => {}, command: async value => { command = value; return reply.promise; }, getSessionTree: async () => {
  reads++; return reads === 1 ? { ...owner, tree: tree("before") } : reads === 2 ? { ...owner, tree: tree("other-client"), receipt: { commandId: command!.id, state: "pending" } } : refresh.promise;
 } } };
 state.configure(ports, true); await state.refresh(); const pending = state.mutate(owner, { sessionId: "session", ticket: tree("before").ticket, mutation: { action: "navigate", targetId: "entry", summarize: false } });
 state.invalidate(); await state.refresh(); expect(state.getSnapshot().value?.ticket.revision).toBe("other-client");
 const outcome: TreeMutationResult = { commandId: command!.id, state: tree("older-result"), cancelled: false };
 reply.resolve({ ok: true, commandId: command!.id, value: { type: "session.tree.mutate", result: outcome } }); await pending;
 expect(state.getSnapshot().fresh).toBe(false); expect(state.getSnapshot().value?.ticket.revision).toBe("other-client");
 refresh.resolve({ ...owner, tree: tree("latest") }); await Bun.sleep(0);
 expect(state.getSnapshot().value?.ticket.revision).toBe("latest"); expect(state.getSnapshot().fresh).toBe(true);
});
test("corrupt recovery bytes remain intact and block new mutations after a successful read", async () => {
 let removed = false, commands = 0;
 const state = new SessionTreeState(owner); state.configure({ storage: { read: () => "{corrupt", write: () => {}, remove: () => { removed = true; } }, bridge: { subscribe: () => () => {}, command: async () => { commands++; throw Error("must not dispatch"); }, getSessionTree: async () => ({ ...owner, tree: tree("current") }) } }, true);
 await state.refresh(); expect(state.getSnapshot().uncertain).toBe(true); expect(removed).toBe(false);
 await expect(state.mutate(owner, { sessionId: "session", ticket: tree("current").ticket, mutation: { action: "navigate", targetId: "entry", summarize: false } })).rejects.toThrow(); expect(commands).toBe(0);
});
