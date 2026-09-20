import { expect, test } from "bun:test";
import type { CommandEnvelope, CommandResult } from "@agent-desktop/shared";
import type { SessionUsageResponse, UsageResetReceipt } from "../../../../packages/shared/src/session-usage";
import { SessionUsageState } from "./session-usage-state";

function memory() { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; }
const response = (): SessionUsageResponse => ({ version: 1, hostId: "host", sessionId: "session", reset: null,
  snapshot: { version: 1, epoch: "epoch", revision: "revision", sessionId: "session", reportStatus: "not-loaded", reports: [], modelSelectors: [],
    credits: [{ accountRef: "original-ref", active: true, availableCount: 1, credits: [], canPrepare: true }],
    resetCommandAccounts: [{ accountRef: "original-ref", label: "same@fixture.invalid", active: true, availableCount: 1, accountId: "first" }],
    policy: { autoRedeem: "unset", minBlockedMinutes: 60, keepCredits: 0, salvageHorizonHours: 12 } } });
const receipt = (): UsageResetReceipt => ({ operationId: "original-operation", hostId: "host", sessionId: "session", state: "prepared", createdAt: 1,
  confirmation: { expiresAt: Date.now() + 60_000, account: { accountRef: "original-ref", accountId: "first", active: true }, credit: { title: "Original credit" } } });
function fixture(read: () => Promise<SessionUsageResponse> = async () => response(), send?: (command: CommandEnvelope) => Promise<CommandResult>) {
  const calls: CommandEnvelope[] = [], modes: unknown[] = [], storage = memory();
  const owner = new SessionUsageState("host", "session", {
    getSessionUsage: async (_session, _host, mode) => { modes.push(mode); return read(); },
    command: async envelope => { calls.push(envelope); return send ? send(envelope) : { ok: true, commandId: envelope.id, value: { type: "session.usage.reset", receipt: { ...receipt(), ...(envelope.command.type === "session.usage.reset.respond" && !envelope.command.confirm ? { state: "cancelled" as const } : {}) } } }; },
  }, storage);
  return { owner, calls, modes, storage };
}

test("no-argument command opens fresh native choices without prepare or consume", async () => {
  const { owner, calls, modes } = fixture();
  await owner.prepareCommand("", () => {});
  expect(modes).toEqual(["credits"]); expect(calls).toHaveLength(0);
  expect(owner.view.value?.snapshot?.resetCommandAccounts?.[0]?.accountRef).toBe("original-ref");
});

test("explicit account command prepares only the original opaque row and still needs a separate answer", async () => {
  const { owner, calls } = fixture();
  await owner.prepareCommand("active", () => {});
  expect(calls).toHaveLength(1);
  expect(calls[0]?.command).toEqual({ type: "session.usage.reset.prepare", sessionId: "session", epoch: "epoch", revision: "revision", accountRef: "original-ref" });
  expect(owner.view.value?.reset?.state).toBe("prepared");
  await owner.answer(false);
  expect(calls[1]?.command).toEqual({ type: "session.usage.reset.respond", sessionId: "session", operationId: "original-operation", confirm: false });
  expect(owner.view.value?.reset?.state).toBe("cancelled");
});

test("held original read cannot prepare after dialog close, route replacement or disconnection", async () => {
  for (const loss of ["close", "route", "connection"] as const) {
    let finish!: (value: SessionUsageResponse) => void, active = true;
    const { owner, calls } = fixture(() => new Promise(resolve => { finish = resolve; }));
    const running = owner.prepareCommand("active", () => { if (!active) throw new Error(`Original ${loss} lost`); });
    const settled = running.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
    if (loss === "close") owner.close(); else active = false;
    finish(response());
    const result = await settled;
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : String(result.error)).toContain(loss === "close" ? "dialog closed" : `Original ${loss} lost`);
    expect(calls).toHaveLength(0);
  }
});

test("a failed fresh read never prepares using a cached selector", async () => {
  let fail = false;
  const { owner, calls } = fixture(async () => { if (fail) throw new Error("read failed"); return response(); });
  await owner.refresh("credits"); fail = true;
  await expect(owner.prepareCommand("active", () => {})).rejects.toThrow("could not be confirmed");
  expect(calls).toHaveLength(0); expect(owner.view.cached).toBe(false);
});

test("lost prepare delivery retains its exact pending request and never sends a replacement or confirmation", async () => {
  const { owner, calls } = fixture(undefined, async () => { throw new Error("lost prepare reply"); });
  await expect(owner.prepareCommand("active", () => {})).rejects.toThrow("unconfirmed");
  const original = owner.view.pending?.envelope;
  await expect(owner.prepareCommand("active", () => {})).rejects.toThrow("original reset");
  expect(calls).toHaveLength(1); expect(owner.view.pending?.envelope).toEqual(original);
});

test("existing prepared and unknown receipts refuse another command before inspecting credits", async () => {
  for (const state of ["prepared", "unknown", "dispatching"] as const) {
    const { owner, calls, modes } = fixture(async () => ({ ...response(), reset: { ...receipt(), state } }));
    await owner.refresh();
    await expect(owner.prepareCommand("active", () => {})).rejects.toThrow("original reset");
    expect(modes).toEqual(["cached"]); expect(calls).toHaveLength(0);
  }
});

test("old hosts and exact-account preparation refusals retain a visible error", async () => {
  const old = fixture(async () => { const value = response(); delete value.snapshot!.resetCommandAccounts; return value; });
  await expect(old.owner.prepareCommand("active", () => {})).rejects.toThrow("Update the owning host");
  expect(old.calls).toHaveLength(0);
  const refused = fixture(undefined, async envelope => ({ ok: false, commandId: envelope.id, error: { code: "USAGE_REJECTED", message: "Account changed" } }));
  await expect(refused.owner.prepareCommand("active", () => {})).rejects.toThrow();
  expect(refused.calls).toHaveLength(1); expect(refused.owner.view.pending).toBeNull();
  expect(refused.owner.view.error).toContain("preparation was rejected");
  expect(refused.owner.view.error).not.toContain("outcome is unconfirmed");
});


test("native no-match, empty-list and no-credit notices consume the invocation without preparing", async () => {
  const cases = [
    { argument: "missing account", change: (value: SessionUsageResponse) => value, notice: "No Codex account matches" },
    { argument: "", change: (value: SessionUsageResponse) => { value.snapshot!.resetCommandAccounts = []; return value; }, notice: "No Codex accounts" },
    { argument: "active", change: (value: SessionUsageResponse) => { value.snapshot!.resetCommandAccounts![0]!.availableCount = 0; return value; }, notice: "no saved resets" },
  ];
  for (const item of cases) {
    const { owner, calls } = fixture(async () => item.change(response()));
    await owner.prepareCommand(item.argument, () => {});
    expect(owner.view.error).toContain(item.notice);
    expect(calls).toHaveLength(0);
  }
});
