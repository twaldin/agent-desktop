import { expect, test } from "bun:test";
import { SessionTreeState, TreeNotSubmitted, type SessionTreePorts } from "./use-session-tree";
import { SESSION_TREE_CAPABILITY, SESSION_TREE_RESET_CAPABILITY, type SessionTree, type SessionTreeResponse, type TreeMutation, type TreeMutationResult } from "../../../../packages/shared/src/session-tree";
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
const stored = (id: string, commandVersion: number, mutation: unknown) =>
 JSON.stringify({ id, commandVersion, command: { type: "session.tree.mutate", sessionId: "session", ticket: tree("before").ticket, mutation } });
function envelopeFields(text: string) {
 const raw: unknown = JSON.parse(text);
 if (!raw || typeof raw !== "object" || !("id" in raw) || typeof raw.id !== "string" || !("commandVersion" in raw) || typeof raw.commandVersion !== "number") throw new Error("The retained record is not a Tree command envelope.");
 return { id: raw.id, commandVersion: raw.commandVersion };
}
async function dispatchOnce(mutation: TreeMutation) {
 const sent: CommandEnvelope[] = [], records: string[] = [];
 const state = new SessionTreeState(owner);
 const ports: SessionTreePorts = { storage: { read: () => null, write: (_key, value) => { records.push(value); }, remove: () => {} },
  bridge: { subscribe: () => () => {}, getSessionTree: async () => ({ ...owner, tree: tree("current") }),
   command: async envelope => { sent.push(envelope); return { ok: true, commandId: envelope.id, value: { type: "session.tree.mutate", result: { commandId: envelope.id, state: tree("current"), cancelled: false } } }; } } };
 state.configure(ports, true, undefined, true); await state.refresh();
 await state.mutate(owner, { sessionId: "session", ticket: tree("current").ticket, mutation });
 return { sent, records };
}
test("a context reset is dispatched and retained at command version 25 while navigation keeps 23", async () => {
 const reset = await dispatchOnce({ action: "reset-context", origin: "clear-command" });
 const navigate = await dispatchOnce({ action: "navigate", targetId: "entry", summarize: false });
 expect(reset.sent[0]!.commandVersion).toBe(SESSION_TREE_RESET_CAPABILITY.commandVersion);
 expect(navigate.sent[0]!.commandVersion).toBe(SESSION_TREE_CAPABILITY.commandVersion);
 expect(envelopeFields(reset.records[0]!).commandVersion).toBe(25);
 expect(envelopeFields(navigate.records[0]!).commandVersion).toBe(23);
});
test("a retained version 23 navigation is restored and settled by journal inspection alone", async () => {
 let removed = false, commands = 0; const inspected: (string | undefined)[] = [];
 const state = new SessionTreeState(owner);
 state.configure({ storage: { read: () => stored("legacy-1", 23, { action: "navigate", targetId: "entry", summarize: false }), write: () => {}, remove: () => { removed = true; } },
  bridge: { subscribe: () => () => {}, command: async () => { commands++; throw Error("must not dispatch"); },
   getSessionTree: async (_session, _host, commandId) => { inspected.push(commandId); return { ...owner, tree: tree("current"), receipt: { commandId: commandId!, state: "succeeded", result: { commandId: commandId!, state: tree("current"), cancelled: false } } }; } } }, true, undefined, false);
 expect(state.getSnapshot().uncertain).toBe(true); expect(state.getSnapshot().original?.request.mutation.action).toBe("navigate");
 await state.refresh();
 expect(inspected).toEqual(["legacy-1"]); expect(state.getSnapshot().receipt?.state).toBe("succeeded");
 expect(state.getSnapshot().uncertain).toBe(false); expect(removed).toBe(true); expect(commands).toBe(0);
});
test("a retained version 25 reset is still inspected on a host that no longer offers resets", async () => {
 let removed = false, commands = 0; const inspected: (string | undefined)[] = [];
 const state = new SessionTreeState(owner);
 state.configure({ storage: { read: () => stored("reset-1", 25, { action: "reset-context", origin: "clear-command" }), write: () => {}, remove: () => { removed = true; } },
  bridge: { subscribe: () => () => {}, command: async () => { commands++; throw Error("must not dispatch"); },
   getSessionTree: async (_session, _host, commandId) => { inspected.push(commandId); return { ...owner, tree: tree("current"), receipt: { commandId: commandId!, state: "unknown" } }; } } }, true, undefined, false);
 expect(state.getSnapshot().original?.request.mutation).toEqual({ action: "reset-context", origin: "clear-command" });
 await state.refresh();
 expect(inspected).toEqual(["reset-1"]); expect(state.getSnapshot().receipt?.state).toBe("unknown"); expect(state.getSnapshot().uncertain).toBe(true);
 expect(state.getSnapshot().resetSupported).toBe(false); expect(removed).toBe(false);
 await expect(state.mutate(owner, { sessionId: "session", ticket: tree("current").ticket, mutation: { action: "reset-context" } })).rejects.toThrow(/Update the owning host/);
 expect(commands).toBe(0); expect(removed).toBe(false);
});
test("a retained command whose version disagrees with its action is preserved and blocks further changes", async () => {
 let removed = false, commands = 0; const inspected: (string | undefined)[] = [];
 const state = new SessionTreeState(owner);
 state.configure({ storage: { read: () => stored("mismatch-1", 23, { action: "reset-context" }), write: () => {}, remove: () => { removed = true; } },
  bridge: { subscribe: () => () => {}, command: async () => { commands++; throw Error("must not dispatch"); },
   getSessionTree: async (_session, _host, commandId) => { inspected.push(commandId); return { ...owner, tree: tree("current") }; } } }, true, undefined, true);
 expect(state.getSnapshot().uncertain).toBe(true); expect(state.getSnapshot().original).toBeUndefined();
 await state.refresh();
 expect(inspected).toEqual([undefined]); expect(state.getSnapshot().fresh).toBe(true); expect(state.getSnapshot().uncertain).toBe(true); expect(removed).toBe(false);
 await expect(state.mutate(owner, { sessionId: "session", ticket: tree("current").ticket, mutation: { action: "reset-context" } })).rejects.toThrow(TreeNotSubmitted);
 expect(commands).toBe(0); expect(removed).toBe(false);
});
test("an unsupported reset is refused before any recovery record or dispatch exists", async () => {
 let commands = 0, writes = 0;
 const state = new SessionTreeState(owner);
 const ports: SessionTreePorts = { storage: { read: () => null, write: () => { writes++; }, remove: () => { writes++; } },
  bridge: { subscribe: () => () => {}, command: async () => { commands++; throw Error("must not dispatch"); }, getSessionTree: async () => ({ ...owner, tree: tree("current") }) } };
 state.configure(ports, true); await state.refresh();
 expect(state.getSnapshot().resetSupported).toBe(false);
 await expect(state.mutate(owner, { sessionId: "session", ticket: tree("current").ticket, mutation: { action: "reset-context", origin: "clear-command" } })).rejects.toThrow(TreeNotSubmitted);
 expect(commands).toBe(0); expect(writes).toBe(0);
 const view = state.getSnapshot();
 expect(view.fresh).toBe(true); expect(view.pending).toBe(false); expect(view.uncertain).toBe(false); expect(view.original).toBeUndefined();
});
test("a lost reset response is never resent and its later receipt does not replace the current read", async () => {
 let commands = 0, reads = 0, removed = 0; const records: string[] = [], inspected: (string | undefined)[] = [];
 const state = new SessionTreeState(owner);
 const ports: SessionTreePorts = { storage: { read: () => null, write: (_key, value) => { records.push(value); }, remove: () => { removed++; } },
  bridge: { subscribe: () => () => {}, command: async () => { commands++; throw Error("The owning host connection dropped."); },
   getSessionTree: async (_session, _host, commandId) => {
    reads++; inspected.push(commandId);
    if (reads === 1) return { ...owner, tree: tree("before") };
    if (reads === 2) return { ...owner, tree: tree("other-client"), receipt: { commandId: commandId!, state: "pending" } };
    return { ...owner, tree: tree("newest"), receipt: { commandId: commandId!, state: "succeeded", result: { commandId: commandId!, state: tree("reset-result"), cancelled: false } } };
   } } };
 state.configure(ports, true, undefined, true); await state.refresh();
 await expect(state.mutate(owner, { sessionId: "session", ticket: tree("before").ticket, mutation: { action: "reset-context", origin: "clear-command" } })).rejects.toThrow(/connection dropped/);
 const { id } = envelopeFields(records[0]!);
 expect(commands).toBe(1); expect(removed).toBe(0); expect(state.getSnapshot().uncertain).toBe(true);
 await state.refresh();
 expect(inspected).toEqual([undefined, id]); expect(commands).toBe(1);
 expect(state.getSnapshot().uncertain).toBe(true); expect(state.getSnapshot().value?.ticket.revision).toBe("other-client");
 await state.refresh();
 expect(commands).toBe(1); expect(removed).toBe(1);
 const settled = state.getSnapshot();
 expect(settled.value?.ticket.revision).toBe("newest"); expect(settled.result?.state.ticket.revision).toBe("reset-result");
 expect(settled.uncertain).toBe(false); expect(settled.original).toBeUndefined();
});

test("the reset endpoint's proven unsupported refusal clears only the original receipt without retry", async () => {
 let sends = 0, saved: string | undefined, removed = 0;
 const state = new SessionTreeState(owner);
 const ports: SessionTreePorts = { storage: { read: () => null, write: (_key, value) => { saved = value; }, remove: () => { saved = undefined; removed++; } },
  bridge: { subscribe: () => () => {}, getSessionTree: async () => ({ ...owner, tree: tree("current") }),
   command: async envelope => { sends++; return { ok: false, commandId: envelope.id, error: { code: "TREE_RESET_PROTOCOL_UNSUPPORTED", message: "Reset is not supported by this host." } }; } } };
 state.configure(ports, true, undefined, true); await state.refresh();
 await expect(state.mutate(owner, { sessionId: owner.sessionId, ticket: tree("current").ticket, mutation: { action: "reset-context" } })).rejects.toBeInstanceOf(TreeNotSubmitted);
 expect(sends).toBe(1); expect(removed).toBe(1); expect(saved).toBeUndefined();
 expect(state.getSnapshot().uncertain).toBe(false); expect(state.getSnapshot().original).toBeUndefined();
});

test("a captured reset ticket cannot silently follow a newer branch or a revoked capability", async () => {
 let commands = 0, writes = 0, revision = "captured";
 const state = new SessionTreeState(owner);
 const ports: SessionTreePorts = { storage: { read: () => null, write: () => { writes++; }, remove: () => {} },
  bridge: { subscribe: () => () => {}, command: async () => { commands++; throw Error("must not dispatch"); }, getSessionTree: async () => ({ ...owner, tree: tree(revision) }) } };
 state.configure(ports, true, undefined, true); await state.refresh();
 const captured = state.getSnapshot().value!.ticket;
 revision = "newer"; await state.refresh();
 await expect(state.mutate(owner, { sessionId: owner.sessionId, ticket: captured, mutation: { action: "reset-context" } })).rejects.toBeInstanceOf(TreeNotSubmitted);
 state.configure(ports, true, undefined, false);
 await expect(state.mutate(owner, { sessionId: owner.sessionId, ticket: tree(revision).ticket, mutation: { action: "reset-context" } })).rejects.toBeInstanceOf(TreeNotSubmitted);
 expect(commands).toBe(0); expect(writes).toBe(0); expect(state.getSnapshot().value?.ticket.revision).toBe("newer");
});
