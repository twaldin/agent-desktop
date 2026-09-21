import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import type { DesktopBridge, DesktopEvent } from "../../../../packages/shared/src/protocol";
import { parseSessionTreeResponse, parseTreeCommandId, parseTreeMutationRequest, parseTreeMutationResult, SESSION_TREE_CAPABILITY,
  type SessionTree, type TreeJournalReceipt, type TreeMutationRequest, type TreeMutationResult } from "../../../../packages/shared/src/session-tree";

/** Proven no-effect refusal: local admission or an explicit host rejection code. */
export class TreeNotSubmitted extends Error {}
export interface SessionTreeOwner { hostId: string; sessionId: string }
export interface SessionTreePorts {
  bridge: Pick<DesktopBridge, "getSessionTree" | "command" | "subscribe">;
  storage?: { read(key: string): string | null; write(key: string, value: string): void; remove(key: string): void };
}
export interface SessionTreeView {
  owner: SessionTreeOwner; value: SessionTree | null; fresh: boolean; loading: boolean; pending: boolean; uncertain: boolean;
  /** Outcome of the latest change: refusal or unconfirmed-command guidance. */
  error?: string;
  /** Latest failed read; cleared by the next successful read. */
  readError?: string;
  unavailable?: string;
  /** Retained original command awaiting journal inspection. Never resent. */
  original?: { commandId: string; request: TreeMutationRequest };
  receipt?: TreeJournalReceipt;
  /** Retained confirmed native result; draft recovery also lives on its native branch. */
  result?: TreeMutationResult;
}
type TreeEnvelope = { id: string; commandVersion: typeof SESSION_TREE_CAPABILITY.commandVersion; command: { type: "session.tree.mutate" } & TreeMutationRequest };
const refusedCodes: Record<string, true> = { TREE_REJECTED: true, TREE_PROTOCOL_UNSUPPORTED: true };
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const receiptGuidance: Record<Exclude<TreeJournalReceipt["state"], "succeeded" | "failed">, string> = {
  pending: "The original Tree command is still pending on the owning host. Check status without repeating it.",
  unknown: "The original Tree command outcome is unknown. Check status; do not repeat it.",
  absent: "The owning host has no record of the original Tree command. Check status; do not repeat it.",
};

/** Owns the desktop read/admission lifetime, not native Tree state. Every write
 * goes through the existing deduplicated host command path. Reads never replay. */
export class SessionTreeState {
  #ports?: SessionTreePorts; #enabled = false; #generation = 0; #reading = false; #again = false; #readToken = 0;
  #listeners = new Set<() => void>(); #view: SessionTreeView;
  #original?: TreeEnvelope; #restored = false;
  constructor(readonly owner: SessionTreeOwner) {
    this.#view = { owner, value: null, fresh: false, loading: false, pending: false, uncertain: false };
  }
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  getSnapshot = () => this.#view;
  #set(patch: Partial<SessionTreeView>) { this.#view = { ...this.#view, ...patch }; this.#listeners.forEach(listener => listener()); }
  #storageKey() { return `agent-desktop:tree-command:v1:${JSON.stringify(this.owner)}`; }
  #remember(envelope?: TreeEnvelope) {
    const storage = this.#ports?.storage;
    if (storage) { if (envelope) storage.write(this.#storageKey(), JSON.stringify(envelope)); else storage.remove(this.#storageKey()); }
    this.#original = envelope;
    if (!envelope) { this.#set({ original: undefined }); return; }
    const { type: _type, ...request } = envelope.command;
    this.#set({ original: { commandId: envelope.id, request } });
  }
  configure(ports: SessionTreePorts, enabled: boolean, unavailable?: string) {
    this.#ports = ports;
    if (!this.#restored) {
      this.#restored = true;
      try {
        const text = ports.storage?.read(this.#storageKey());
        if (text) {
          const raw: unknown = JSON.parse(text);
          if (!raw || typeof raw !== "object" || !("id" in raw) || !("commandVersion" in raw) || raw.commandVersion !== SESSION_TREE_CAPABILITY.commandVersion
            || !("command" in raw) || !raw.command || typeof raw.command !== "object" || !("type" in raw.command) || raw.command.type !== "session.tree.mutate"
            || Object.keys(raw).some(key => !["id", "commandVersion", "command"].includes(key))) throw new Error("Stored Tree command is invalid.");
          const id = parseTreeCommandId(raw.id), { type: _type, ...fields } = raw.command;
          const request = parseTreeMutationRequest(fields);
          if (request.sessionId !== this.owner.sessionId) throw new Error("Stored Tree command belongs to another owner.");
          this.#original = { id, commandVersion: SESSION_TREE_CAPABILITY.commandVersion, command: { type: "session.tree.mutate", ...request } };
          this.#set({ original: { commandId: id, request }, uncertain: true, error: "Check the original Tree command status before making another change." });
        }
      } catch (cause) {
        this.#set({ uncertain: true, error: `The original history command record could not be read and was preserved: ${message(cause)} Inspect the owning session before making another change.` });
      }
    }
    if (this.#enabled !== enabled) { this.#generation++; this.#reading = false; this.#again = false; }
    this.#enabled = enabled;
    this.#set({ unavailable, ...(!enabled ? { fresh: false, loading: false } : {}) });
  }
  disconnect() { this.#enabled = false; this.#generation++; this.#reading = false; this.#again = false; this.#set({ fresh: false, loading: false }); }
  #assert(owner = this.owner) {
    if (!this.#enabled || owner.hostId !== this.owner.hostId || owner.sessionId !== this.owner.sessionId)
      throw new TreeNotSubmitted("Open the connected owning conversation before changing its Tree.");
  }
  refresh = async () => {
    this.#assert();
    if (this.#reading) { this.#again = true; return; }
    const ports = this.#ports!, generation = this.#generation, token = ++this.#readToken, original = this.#original;
    const live = () => this.#enabled && generation === this.#generation && token === this.#readToken;
    this.#reading = true; this.#set({ loading: true, fresh: false });
    try {
      if (!ports.bridge.getSessionTree) throw new Error("Update the desktop to read native Tree.");
      const response = parseSessionTreeResponse(await ports.bridge.getSessionTree(this.owner.sessionId, this.owner.hostId, original?.id), this.owner.hostId, this.owner.sessionId, original?.id);
      if (!live()) return;
      let patch: Partial<SessionTreeView> = {};
      const receipt = response.receipt;
      if (original && receipt) {
        if (receipt.state === "succeeded") {
          const result = receipt.result;
          if (!result || receipt.submission) throw new Error("The receipt does not belong to this history navigation.");
          if (result.state.ticket.nativeSessionId !== this.owner.sessionId || result.state.ticket.epoch !== original.command.ticket.epoch)
            throw new Error("The journal result belongs to another native owner.");
          // The desktop performs advertised structured actions itself; only plain outputs are shown.
          this.#remember(); patch = { uncertain: false, receipt, result, error: undefined };
        } else if (receipt.state === "failed") {
          this.#remember();
          patch = { uncertain: false, receipt, error: `The owning host refused the original Tree command before any change${receipt.error ? `: ${receipt.error}` : "."}` };
        } else patch = { uncertain: receipt.state !== "pending" || !this.#view.pending, receipt, error: receipt.state === "pending" && this.#view.pending ? undefined : receiptGuidance[receipt.state] };
      }
      this.#set({ ...patch, value: response.tree, unavailable: response.unavailable, fresh: true, readError: undefined });
    } catch (cause) { if (live()) this.#set({ fresh: false, readError: message(cause) }); }
    finally {
      if (generation === this.#generation && token === this.#readToken) {
        this.#reading = false; this.#set({ loading: false });
        if (this.#again && this.#enabled) { this.#again = false; void this.refresh(); }
      }
    }
  };
  invalidate() { this.#invalidateRead(); }
  #invalidateRead() { this.#readToken++; this.#reading = false; this.#again = false; this.#set({ loading: false, fresh: false }); }
  /** The request ticket must be the exact loaded revision; the host rejects any
   * stale ticket, and a refusal only refreshes. Nothing is ever resent. */
  async mutate(owner: SessionTreeOwner, raw: TreeMutationRequest): Promise<TreeMutationResult> {
    this.#assert(owner);
    let request: TreeMutationRequest;
    try { request = parseTreeMutationRequest(raw); } catch (cause) { throw new TreeNotSubmitted(message(cause)); }
    if (request.sessionId !== owner.sessionId) throw new TreeNotSubmitted("The Tree request belongs to another conversation.");
    const view = this.#view;
    if (!view.fresh || view.pending || view.uncertain || !view.value) throw new TreeNotSubmitted("Refresh the current Tree before changing them.");
    if (view.value.reconciliationRequired) throw new TreeNotSubmitted("The native Tree need reconciliation. Check status; do not repeat the change.");
    const current = view.value.ticket, ticket = request.ticket;
    if (ticket.epoch !== current.epoch || ticket.nativeSessionId !== current.nativeSessionId || ticket.revision !== current.revision)
      throw new TreeNotSubmitted("The native Tree changed. Review the latest state before applying this change.");
    const ports = this.#ports!, generation = this.#generation;
    const envelope: TreeEnvelope = { id: crypto.randomUUID(), commandVersion: SESSION_TREE_CAPABILITY.commandVersion, command: { type: "session.tree.mutate", ...request } };
    try { this.#remember(envelope); } catch (cause) { throw new TreeNotSubmitted(`The Tree recovery record could not be saved: ${message(cause)}`); }
    this.#invalidateRead(); this.#set({ pending: true, error: undefined, receipt: undefined, result: undefined });
    try {
      const result = await ports.bridge.command(envelope, owner.hostId);
      if (result.commandId !== envelope.id) throw new Error("The Tree response belongs to another command.");
      if (!result.ok) {
        if (refusedCodes[result.error.code]) {
          this.#remember(); this.#set({ uncertain: false, error: result.error.message });
          if (this.#enabled && generation === this.#generation) void this.refresh().catch(() => {});
          throw new TreeNotSubmitted(result.error.message);
        }
        throw new Error(result.error.message);
      }
      if (!result.value || !("type" in result.value) || result.value.type !== "session.tree.mutate") throw new Error("The original Tree outcome was not returned.");
      const outcome = parseTreeMutationResult(result.value.result, envelope.id);
      if (outcome.state.ticket.nativeSessionId !== owner.sessionId || outcome.state.ticket.epoch !== request.ticket.epoch)
        throw new Error("The Tree result belongs to another native owner.");
      this.#remember(); this.#invalidateRead();
      this.#set({ result: outcome, uncertain: false, fresh: false });
      // A command receipt is historical; another client may already have moved
      // this same owner. Only a subsequent authoritative read is fresh UI state.
      if (this.#enabled && generation === this.#generation) void this.refresh().catch(() => {});
      return outcome;
    } catch (cause) {
      if (!(cause instanceof TreeNotSubmitted)) this.#set({ error: message(cause), uncertain: true, fresh: false });
      throw cause;
    } finally { this.#set({ pending: false }); }
  }
}

export function treeEventMatches(event: DesktopEvent, owner: SessionTreeOwner, localHostId?: string) {
  if ((event.hostId ?? localHostId) !== owner.hostId) return false;
  if (event.type === "state") return true;
  if (event.type === "settings") return event.sessionId === owner.sessionId;
  if (event.type !== "runtime" || event.sessionId !== owner.sessionId) return false;
  const native = event.event;
  if (!native || typeof native !== "object" || !("type" in native) || typeof native.type !== "string") return false;

  return ["tree_changed", "message_end", "agent_end", "turn_end", "session_start"].includes(native.type);
}

export function useSessionTree(owner: SessionTreeOwner, ports: SessionTreePorts,
  options: { connected: boolean; supported: boolean; active: boolean; localHostId?: string }) {
  const states = useMemo(() => new Map<string, SessionTreeState>(), []);
  const state = useMemo(() => {
    const key = JSON.stringify(owner); let value = states.get(key);
    if (!value) { value = new SessionTreeState(owner); states.set(key, value); } return value;
  }, [states, owner.hostId, owner.sessionId]);
  const enabled = !!owner.sessionId && options.connected && options.supported && options.active;
  useLayoutEffect(() => { state.configure(ports, enabled, !owner.sessionId ? "Open a conversation to see its native Tree."
    : !options.supported ? "Update the owning host and desktop to use native Tree." : undefined); }, [state, ports, enabled, options.supported]);
  useLayoutEffect(() => () => state.disconnect(), [state]);
  useEffect(() => { if (enabled) void state.refresh(); }, [state, enabled]);
  useEffect(() => {
    if (!enabled) return;
    return ports.bridge.subscribe(event => {
      if ((event.hostId ?? options.localHostId) === owner.hostId && event.type === "connection") {
        if (!event.connected) state.disconnect();
        else { state.configure(ports, true); void state.refresh().catch(() => {}); }
      }
      else if (treeEventMatches(event, owner, options.localHostId)) { state.invalidate(); void state.refresh().catch(() => {}); }
    });
  }, [state, ports.bridge, enabled, options.localHostId]);
  const view = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
  return { state, view };
}
