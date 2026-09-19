import { expect, test } from "bun:test";
import { SessionUsageState, usageResetMessage } from "./session-usage-state";
import type { SessionUsageResponse, UsageResetReceipt } from "../../../../packages/shared/src/session-usage";
import type { CommandEnvelope, CommandResult } from "@agent-desktop/shared";

const receipt = (state: UsageResetReceipt["state"] = "prepared"): UsageResetReceipt => ({ operationId: "prepared", hostId: "host", sessionId: "session", state, createdAt: 1,
  confirmation: { expiresAt: Date.now() + 60_000, account: { accountRef: "account", accountId: "one", active: true }, credit: { title: "Saved reset" } } });
const response = (): SessionUsageResponse => ({ version: 1, hostId: "host", sessionId: "session", reset: null,
  snapshot: { version: 1, epoch: "epoch", revision: "revision", sessionId: "session", reportStatus: "not-loaded", reports: [], credits: [], modelSelectors: [], policy: { autoRedeem: "unset", minBlockedMinutes: 60, keepCredits: 0, salvageHorizonHours: 12 } } });
function memory() { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; }
test("opening and reconnect inspection never sends; an absent request retries its exact persisted envelope", async () => {
  const storage = memory(), commands: CommandEnvelope[] = []; let absent = false;
  const ports = { command: async (envelope: CommandEnvelope): Promise<CommandResult> => { commands.push(envelope); throw new Error("lost ACK"); },
    getSessionUsage: async (_session: string, _host: string, _mode: unknown, id?: string) => ({ ...response(), ...(id ? { command: { id, state: absent ? "absent" as const : "unknown" as const } } : {}) }) };
  const owner = new SessionUsageState("host", "session", ports, storage); expect(commands).toHaveLength(0);
  await owner.refresh("credits"); await owner.prepare("account"); expect(commands).toHaveLength(1);
  const original = commands[0]!; expect(owner.view.pending?.state).toBe("unknown");
  owner.close(); const restored = new SessionUsageState("host", "session", ports, storage);
  expect(restored.view.pending?.envelope).toEqual(original); expect(commands).toHaveLength(1);
  await restored.retryAbsent(); await restored.refresh(); expect(commands).toHaveLength(1);
  absent = true; await restored.refresh(); expect(restored.view.pending?.state).toBe("absent");
  await restored.retryAbsent(); expect(commands).toHaveLength(2); expect(commands[1]).toEqual(original);
});
test("saving the original request is mandatory before any reset command", async () => {
  let sends = 0, failWrites = false;
  const store = memory(), owner = new SessionUsageState("host", "session", { getSessionUsage: async () => response(), command: async () => { sends++; throw new Error(); } },
    { getItem: store.getItem, setItem: (key, value) => { if (failWrites) throw new Error("disk full"); store.setItem(key, value); } });
  await owner.refresh("credits"); failWrites = true; await owner.prepare("account");
  expect(sends).toBe(0); expect(owner.view.error).toContain("Nothing was sent");
});
test("confirmation is explicit, cancellation is separate, and successful reset survives a later refresh failure", async () => {
  const sent: CommandEnvelope[] = []; let failRead = false;
  const owner = new SessionUsageState("host", "session", { getSessionUsage: async () => { if (failRead) throw new Error(); return response(); },
    command: async envelope => { sent.push(envelope); return { ok: true, commandId: envelope.id, value: { type: "session.usage.reset", receipt: envelope.command.type === "session.usage.reset.prepare" ? receipt() : { ...receipt("settled"), outcome: "reset" } } }; } }, memory());
  await owner.refresh("credits"); await owner.prepare("account"); expect(sent).toHaveLength(1); expect(owner.view.value?.reset?.state).toBe("prepared");
  await owner.answer(true); expect(sent[1]?.command).toMatchObject({ type: "session.usage.reset.respond", operationId: "prepared", confirm: true });
  failRead = true; await owner.refresh("reports"); expect(owner.view.value?.reset?.outcome).toBe("reset");
  expect(usageResetMessage(owner.view.value!.reset!)).toBe("One saved reset was applied.");
});
test("a late response stays with its original disposed host/session and does not replace another owner", async () => {
  let finish!: (value: SessionUsageResponse) => void;
  const storage = memory(), owner = new SessionUsageState("host", "session", { getSessionUsage: () => new Promise(resolve => { finish = resolve; }), command: async () => { throw new Error(); } }, storage);
  const reading = owner.refresh("reports"); owner.close(); finish(response()); await reading;
  const other = new SessionUsageState("other", "session", { command: async () => { throw new Error(); } }, storage);
  expect(owner.view.value).toBeNull(); expect(other.view.value).toBeNull();
});
test("unknown and already spent receipts never claim a fresh reset", () => {
  expect(usageResetMessage(receipt("unknown"))).toContain("unconfirmed");
  expect(usageResetMessage({ ...receipt("settled"), outcome: "already_redeemed" })).toContain("does not establish a new reset");
});
