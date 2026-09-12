import { expect, test } from "bun:test";
import type { AccountAction, DesktopBridge, SessionAccountList } from "@agent-desktop/shared";
import { SessionAccountsState } from "./session-accounts-state";
const model = { provider: "native", id: "model" };
const snapshot = (revision = "owner1"): SessionAccountList => ({ sessionId: "session", providerId: "native", selection: { model, revision }, accounts: [{ credentialId: 1, providerId: "native", type: "oauth", disabled: false, active: false }] });
function fixture(overrides: Partial<Pick<DesktopBridge, "getSessionAccounts" | "accountAction" | "subscribe">> = {}) {
  const calls: AccountAction[] = [];
  const data = new SessionAccountsState({ getSessionAccounts: async () => snapshot(), accountAction: async action => { calls.push(action); return { selection: { ...snapshot("owner2"), accounts: [{ ...snapshot().accounts[0]!, active: action.type === "session.pin" }] } }; }, subscribe: () => () => {}, ...overrides }, "host", "session", model);
  data.setConnected(true); return { data, calls };
}
test("selection copies original native token and requires explicit new choice", async () => {
  const { data, calls } = fixture(); await data.refresh(); await data.choose(1);
  expect(calls).toEqual([{ type: "session.pin", sessionId: "session", credentialId: 1, expectedSelection: { model, revision: "owner1" } }]);
  expect(data.selection?.accounts[0]?.active).toBe(true);
  await data.choose(null);
  expect(calls[1]).toEqual({ type: "session.release", sessionId: "session", expectedSelection: { model, revision: "owner2" } });
  expect(data.selection?.accounts[0]?.active).toBe(false);
});
test("old hosts, unsupported credentials and foreign model responses never enable pin", async () => {
  for (const value of [{ ...snapshot(), selection: undefined }, { ...snapshot(), accounts: [{ ...snapshot().accounts[0]!, type: "api_key" as const }] }, { ...snapshot(), selection: { model: { ...model, id: "other" }, revision: "x" } }]) {
    const { data, calls } = fixture({ getSessionAccounts: async () => value }); await data.refresh(); await data.choose(1); expect(calls).toHaveLength(0);
  }
});
test("offline and stopped views suppress late old reads and mutation receipts", async () => {
  const held = Promise.withResolvers<SessionAccountList>(); const { data, calls } = fixture({ getSessionAccounts: () => held.promise });
  const read = data.refresh(); data.setConnected(false); held.resolve(snapshot()); await read;
  expect(data.selection).toBeUndefined(); expect(data.loading).toBe(false); await data.choose(1); expect(calls).toHaveLength(0);
  const reply = Promise.withResolvers<{ selection: SessionAccountList }>(); const current = fixture({ accountAction: () => reply.promise }); await current.data.refresh(); const changing = current.data.choose(1); current.data.stop(); reply.resolve({ selection: { ...snapshot("late"), accounts: [] } }); await changing;
  expect(current.data.selection?.selection?.revision).toBe("owner1"); expect(current.data.busy).toBe(false);
});
test("failed mutation remains visible and never retries until fresh read and deliberate choice", async () => {
  let writes = 0; const { data } = fixture({ accountAction: async () => { writes++; throw new Error("Selection receipt lost"); } });
  await data.refresh(); await data.choose(1); expect(data.error).toContain("receipt lost");
  await data.choose(1); expect(writes).toBe(1); await data.refresh(); await data.choose(1); expect(writes).toBe(2);
});

test("account invalidation during a held read loads the later selection", async () => {
  const first = Promise.withResolvers<SessionAccountList>(); let reads = 0;
  const { data } = fixture({ getSessionAccounts: () => ++reads === 1 ? first.promise : Promise.resolve(snapshot("updated")) });
  const pending = data.refresh(); await Promise.resolve(); void data.refresh(); first.resolve(snapshot("old"));
  await pending; await Promise.resolve(); await Promise.resolve();
  expect(reads).toBe(2); expect(data.selection?.selection?.revision).toBe("updated");
});
