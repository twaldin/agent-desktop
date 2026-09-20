import type { CommandEnvelope, DesktopBridge } from "@agent-desktop/shared";
import { parseUsageCommand, type SessionUsageResponse, type UsageRefresh, type UsageResetReceipt } from "../../../../packages/shared/src/session-usage";
import { validateSessionUsageResponse } from "../../../../packages/shared/src/session-usage-validation";
import { usageResetAccount, UsageResetSelectionNotice } from "./usage-reset-command";

interface Pending { envelope: CommandEnvelope; state: "unknown" | "absent" }
export interface UsageView { value: SessionUsageResponse | null; pending: Pending | null; busy: boolean; error?: string; cached: boolean }
type Ports = Pick<DesktopBridge, "command" | "getSessionUsage">;

/** Each controller owns one host/session. Only explicit buttons issue network work. */
export class SessionUsageState {
  #view: UsageView = { value: null, pending: null, busy: false, cached: true };
  #listeners = new Set<() => void>();
  #closed = false;
  #key: string;
  constructor(readonly hostId: string, readonly sessionId: string, private ports: Ports, private storage: Pick<Storage, "getItem" | "setItem">) {
    this.#key = `agent-desktop.provider-usage.v1:${encodeURIComponent(hostId)}:${encodeURIComponent(sessionId)}`;
    try {
      const raw = storage.getItem(this.#key);
      if (raw && raw.length <= 1_100_000) {
        const cached = JSON.parse(raw);
        const value = cached.value ? validateSessionUsageResponse({ ...cached.value, command: undefined }, { hostId }, sessionId) : null;
        let pending: Pending | null = null;
        if (cached.pending) {
          const envelope = cached.pending.envelope;
          if (typeof envelope?.id !== "string" || !envelope.id || envelope.id.length > 200) throw new Error("Invalid saved request.");
          const command = parseUsageCommand(envelope.command);
          if (command.sessionId !== sessionId) throw new Error("Saved request belongs to another session.");
          pending = { envelope: { id: envelope.id, commandVersion: 20, command }, state: "unknown" };
        }
        this.#view = { value, pending, busy: false, cached: true };
      }
    } catch { this.#view.error = "Saved provider usage could not be read. Inspect the original host before sending a reset."; }
  }
  get view() { return this.#view; }
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  open() { this.#closed = false; }
  close() { this.#closed = true; this.#listeners.clear(); }
  #publish(next: Partial<UsageView>) { if (this.#closed) return; this.#view = { ...this.#view, ...next }; for (const listener of this.#listeners) listener(); }
  #persist(pending: Pending | null, value = this.#view.value) {
    this.storage.setItem(this.#key, JSON.stringify({ value, pending }));
  }
  async refresh(mode: UsageRefresh = "cached") {
    if (this.#closed || this.#view.busy || !this.ports.getSessionUsage) return;
    this.#publish({ busy: true, error: undefined });
    try {
      const pending = this.#view.pending;
      const rawValue = await this.ports.getSessionUsage(this.sessionId, this.hostId, mode, mode === "cached" ? pending?.envelope.id : undefined);
      if (this.#closed) return;
      const value = validateSessionUsageResponse(rawValue, { hostId: this.hostId }, this.sessionId, mode === "cached" ? pending?.envelope.id : undefined);
      let nextPending = pending;
      if (pending && value.command?.id === pending.envelope.id) {
        if (value.command.state === "absent") nextPending = { ...pending, state: "absent" };
        else if (value.command.state === "done") nextPending = null;
      }
      // Host restart can retain a receipt without any report cache. Keep the
      // last viewed reports explicitly cached; never relabel them as refreshed.
      const combined = value.snapshot ? value : { ...value, snapshot: this.#view.value?.snapshot ?? null };
      this.#persist(nextPending, combined);
      this.#publish({ value: combined, pending: nextPending, cached: mode === "cached", ...(value.command?.failed ? { error: "The original command failed. Inspect the receipt before preparing another reset." } : {}) });
    } catch { this.#publish({ error: "Provider usage could not be confirmed. Cached values remain available; reconnect and inspect the original request." }); }
    finally { this.#publish({ busy: false }); }
  }
  async #send(envelope: CommandEnvelope) {
    if (this.#closed || this.#view.busy) return;
    const pending: Pending = { envelope, state: "unknown" };
    try { this.#persist(pending); }
    catch { this.#publish({ error: "The reset request could not be saved on this device. Nothing was sent." }); return; }
    this.#publish({ pending, busy: true, error: undefined });
    try {
      const result = await this.ports.command(envelope, this.hostId);
      if (this.#closed) return;
      if (result.commandId !== envelope.id) throw new Error("Wrong command receipt.");
      if (!result.ok) {
        if (result.error.code === "USAGE_REJECTED" && envelope.command.type === "session.usage.reset.prepare") {
          this.#persist(null);
          this.#publish({ pending: null, error: "Reset preparation was rejected. Inspect the original saved-reset state before trying again." });
          return;
        }
        throw new Error("Reset answer could not be confirmed.");
      }
      const receipt = result.value && "type" in result.value && result.value.type === "session.usage.reset" ? result.value.receipt : undefined;
      if (!receipt) throw new Error("Missing reset receipt.");
      const value = validateSessionUsageResponse({ version: 1, hostId: this.hostId, sessionId: this.sessionId, snapshot: this.#view.value?.snapshot ?? null, reset: receipt }, { hostId: this.hostId }, this.sessionId);
      this.#persist(null, value); this.#publish({ value, pending: null, cached: true });
    } catch { this.#publish({ error: "The original request outcome is unconfirmed. Inspect it; do not prepare a replacement credit." }); }
    finally { this.#publish({ busy: false }); }
  }
  prepare(accountRef: string) {
    const snapshot = this.#view.value?.snapshot;
    if (!snapshot || this.#view.pending) return Promise.resolve();
    return this.#send({ id: crypto.randomUUID(), commandVersion: 20, command: { type: "session.usage.reset.prepare", sessionId: this.sessionId, epoch: snapshot.epoch, revision: snapshot.revision, accountRef } });
  }
  /** Resolve a native command against a fresh original-owner credit snapshot.
   * Selection only prepares; it never supplies the later confirmation answer. */
  async prepareCommand(argument: string, assertCurrent: () => void) {
    const current = () => {
      if (this.#closed) throw new Error("The provider usage dialog closed. The draft was retained.");
      assertCurrent();
    };
    try {
      current();
      const reset = this.#view.value?.reset;
      if (this.#view.busy || this.#view.pending || reset && ["prepared", "unknown", "dispatching"].includes(reset.state))
        throw new Error("Inspect or cancel the original reset request before selecting another account. The draft was retained.");
      await this.refresh("credits");
      current();
      if (this.#view.error || !this.#view.value?.snapshot) throw new Error(this.#view.error ?? "Saved credits could not be inspected. The draft was retained.");
      const accountRef = usageResetAccount(this.#view.value.snapshot, argument);
      if (accountRef === undefined) return;
      await this.prepare(accountRef);
      current();
      const prepared = this.#view.value?.reset;
      if (this.#view.error || this.#view.pending || prepared?.state !== "prepared" || prepared.confirmation.account.accountRef !== accountRef)
        throw new Error(this.#view.error ?? "The original account could not be prepared. The draft was retained.");
    } catch (error) {
      this.#publish({ error: error instanceof Error ? error.message : "Saved resets could not be prepared. The draft was retained." });
      if (error instanceof UsageResetSelectionNotice) return;
      throw error;
    }
  }
  answer(confirm: boolean) {
    const receipt = this.#view.value?.reset;
    if (receipt?.state !== "prepared" || this.#view.pending) return Promise.resolve();
    return this.#send({ id: crypto.randomUUID(), commandVersion: 20, command: { type: "session.usage.reset.respond", sessionId: this.sessionId, operationId: receipt.operationId, confirm } });
  }
  retryAbsent() { const pending = this.#view.pending; return pending?.state === "absent" ? this.#send(pending.envelope) : Promise.resolve(); }
}

export function usageResetMessage(receipt: UsageResetReceipt): string {
  if (receipt.state === "unknown" || receipt.state === "dispatching") return "Outcome unconfirmed. Inspect this original reset; another credit will not be selected.";
  if (receipt.state === "prepared") return "Review this exact account and saved credit, then explicitly confirm or cancel.";
  if (receipt.state === "cancelled") return "Confirmation cancelled. No reset was requested.";
  if (receipt.state === "rejected") return "The original confirmation is no longer valid. No reset was admitted.";
  const messages: Record<string, string> = { reset: "One saved reset was applied.", already_redeemed: "This credit was already spent. This receipt does not establish a new reset.", no_credit: "The selected credit was unavailable; no replacement was selected.", nothing_to_reset: "The provider reported nothing to reset.", no_account: "The original account was unavailable.", account_unavailable: "Native access to the original account was unavailable.", credit_list_failed: "Native credit inspection failed." };
  return messages[receipt.outcome ?? ""] ?? "Inspect the original reset outcome.";
}
