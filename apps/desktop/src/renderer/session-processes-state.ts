import { assertSessionProcessesResultMatches, parseSessionProcessesEnvelope, parseSessionProcessesOwner, parseSessionProcessesRequest,
  parseSessionProcessTarget, sameSessionProcessesOwner, sameSessionProcessTarget,
  type SessionProcessesEnvelope, type SessionProcessesOwner, type SessionProcessesRequest, type SessionProcessesResult,
  type SessionProcessesSnapshot, type SessionProcessMutation, type SessionProcessReceipt, type SessionProcessRow,
  type SessionProcessState, type SessionProcessTarget } from "../../../../packages/shared/src/session-processes";

/** Structural subset of DesktopBridge. Native processes are read and changed by
 * request only: there is no subscription and no renderer-side registry. */
export interface SessionProcessesBridge {
  sessionProcesses?(sessionId: string, request: SessionProcessesRequest, hostId: string): Promise<SessionProcessesEnvelope>;
}
export interface SessionProcessesJournalScope { hostId: string; sessionId: string }
/** The only thing ever written down about an operation: who it was sent to and what
 * it was. Never the stdin text, a status, a row or an error message. */
export interface SessionProcessOperationMetadata {
  operationId: string; owner: SessionProcessesOwner; target: SessionProcessTarget; action: SessionProcessMutation["action"];
}
/** Durable per host/session record of operations that were recorded before being sent.
 * A resolved `save()` promises the entries survive this window; anything else is a
 * failure and stops the operation it was recording. */
export interface SessionProcessesJournal {
  load(scope: SessionProcessesJournalScope): Promise<unknown>;
  save(scope: SessionProcessesJournalScope, entries: readonly SessionProcessOperationMetadata[]): Promise<void>;
}
export interface SessionProcessesScope { hostId: string; sessionId: string; connected: boolean; visible: boolean }
/** `saving` is recorded-but-not-sent, `not-sent` is proven never dispatched,
 * `unknown` may or may not have run and is never repeated. */
export type SessionProcessOperationStatus = "saving" | "pending" | "unknown" | "completed" | "rejected" | "not-sent";
export type SessionProcessOperationView = SessionProcessOperationMetadata & {
  status: SessionProcessOperationStatus; lookupPending: boolean; error?: string; row?: SessionProcessRow;
};
export interface SessionProcessesLogs {
  target: SessionProcessTarget; state: "pending" | "ready" | "failed"; text?: string; truncated?: boolean; error?: string;
}
export interface SessionProcessesView {
  hostId: string; sessionId: string; supported: boolean; connected: boolean; visible: boolean;
  /** No snapshot yet and a reading is expected. */
  loading: boolean;
  reading: boolean;
  /** Retained rows whose latest reading failed, answered for another owner/broker, or whose host is offline. */
  stale: boolean;
  /** A mutation is being recorded or sent; a second one is refused meanwhile. */
  busy: boolean;
  snapshot?: SessionProcessesSnapshot;
  error?: string;
  logs?: SessionProcessesLogs;
  operations: SessionProcessOperationView[];
  journalState: "loading" | "ready" | "failed" | "unavailable";
  journalError?: string;
}
export interface SessionProcessesTimers {
  setTimeout(handler: () => void, ms: number): unknown; clearTimeout(handle: unknown): void;
  setInterval(handler: () => void, ms: number): unknown; clearInterval(handle: unknown): void;
}

/** Same cadence as the Jobs observer and the Environment activity observer. */
export const SESSION_PROCESSES_POLL_MS = 5000;
export const SESSION_PROCESSES_COALESCE_MS = 120;
/** Unresolved records are a liability, not a history: the list is deliberately small. */
export const SESSION_PROCESSES_MAX_OPERATIONS = 32;
/** Reads and actions share this budget, so a hung host cannot accumulate requests. */
export const SESSION_PROCESSES_MAX_IN_FLIGHT = 2;

const UNSUPPORTED = "Native processes are unavailable through this desktop bridge.";
const SATURATED = "Two native process requests are already outstanding. Wait for them to settle.";
const OWNER_CHANGED = "The native session behind these processes changed. These rows are the original session's last reading.";
const BROKER_CHANGED = "The process broker restarted. These rows are the original broker's last reading.";
const UNCERTAIN = "The outcome is unknown. Look up its receipt; do not repeat it.";
const RECOVERED = "Recorded before this window reopened; the outcome is unknown until its receipt is looked up.";
const NO_RECORD = "The owning host has no receipt for this operation yet. It is still unknown; do not repeat it.";
const NOT_DISPATCHED = "Recorded, then refused before it was sent: nothing reached the host.";

const LIVE_STATES: readonly SessionProcessState[] = ["starting", "running", "ready"];
const METADATA_KEYS = ["operationId", "owner", "target", "action"];
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const unresolved = (status: SessionProcessOperationStatus) => status === "saving" || status === "pending" || status === "unknown";

export const processRowKey = (target: SessionProcessTarget) =>
  `${target.brokerId}\u0000${target.name}\u0000${target.id}\u0000${target.generation}`;

export function initialSessionProcessesView(hostId: string, sessionId: string, supported: boolean, connected: boolean): SessionProcessesView {
  return { hostId, sessionId, supported, connected, visible: false, loading: supported && connected,
    reading: false, stale: false, busy: false, operations: [], journalState: "loading" };
}

export function findProcessRow(snapshot: SessionProcessesSnapshot | undefined, target: SessionProcessTarget): SessionProcessRow | undefined {
  return snapshot?.rows.find(row => sameSessionProcessTarget(row.target, target));
}

/** Why this exact row cannot be changed right now; undefined when the action may be offered.
 * Every reason is local knowledge: no capability is guessed from a past host answer. */
export function processMutationRefusal(view: SessionProcessesView, row: SessionProcessRow | undefined,
  action: SessionProcessMutation["action"]): string | undefined {
  if (!view.supported) return UNSUPPORTED;
  if (!view.connected) return "Offline · reconnect to the owning host before changing a process.";
  if (!view.visible) return "The processes list is hidden.";
  if (!row || !findProcessRow(view.snapshot, row.target)) return "This process is not part of the current reading.";
  if (view.stale) return "The last reading failed. Refresh before changing a process.";
  if (view.journalState === "unavailable") return "This window cannot record operations, so Stop, Restart and input are unavailable.";
  if (view.journalState === "loading") return "Preparing the operation record.";
  if (view.journalState === "failed") return "The operation record could not be read or written. Retry it before changing a process.";
  if (view.busy) return "Another process operation is still being recorded or sent.";
  const blocking = view.operations.find(operation => unresolved(operation.status) && operation.target.name === row.target.name);
  if (blocking) return `An earlier ${blocking.action} for ${row.target.name} is unresolved. Look up its receipt instead of sending another.`;
  if (view.operations.filter(operation => unresolved(operation.status)).length >= SESSION_PROCESSES_MAX_OPERATIONS)
    return "Too many unresolved process operations are recorded. Look up their receipts first.";
  if (row.state === "restarting" || row.state === "stopping") return `${row.target.name} is already ${row.state}.`;
  if (action === "restart") return undefined;
  if (!LIVE_STATES.includes(row.state)) return `${row.target.name} is not running.`;
  return undefined;
}

function parseOperationMetadata(value: unknown): SessionProcessOperationMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A recorded process operation is not an object.");
  const entry = value as Record<string, unknown>;
  for (const key of Object.keys(entry)) if (!METADATA_KEYS.includes(key)) throw new Error(`A recorded process operation carries an unexpected ${key} field.`);
  const action = entry.action;
  if (action !== "stop" && action !== "restart" && action !== "input") throw new Error("A recorded process operation has no valid action.");
  // The identity is validated by the same protocol parsers the host uses, so a record
  // that could never be sent is rejected here rather than at dispatch time.
  const probe = parseSessionProcessesRequest({ action: "receipt", operationId: entry.operationId });
  if (probe.action !== "receipt") throw new Error("A recorded process operation has an invalid identity.");
  return { operationId: probe.operationId, action, owner: parseSessionProcessesOwner(entry.owner), target: parseSessionProcessTarget(entry.target) };
}
/** Strict bounded projection. The journal port returns [] for an absent record;
 * malformed content is an error, never permission to forget an operation. */
export function parseSessionProcessOperationEntries(value: unknown): SessionProcessOperationMetadata[] {
  if (!Array.isArray(value)) throw new Error("The recorded process operations are not a list.");
  if (value.length > SESSION_PROCESSES_MAX_OPERATIONS) throw new Error("The recorded process operations exceed the supported limit.");
  const entries = Array.from(value, parseOperationMetadata);
  if (new Set(entries.map(entry => entry.operationId)).size !== entries.length) throw new Error("The recorded process operations repeat an operation id.");
  return entries;
}

interface BridgeWork {
  inFlight: number; reserved: number; mutating?: string; listeners: Set<() => void>;
}
const bridgeWork = new WeakMap<SessionProcessesBridge, BridgeWork>();
const journalWork = new WeakMap<SessionProcessesJournal, Promise<void>>();
function workFor(bridge: SessionProcessesBridge): BridgeWork {
  let work = bridgeWork.get(bridge);
  if (!work) { work = { inFlight: 0, reserved: 0, listeners: new Set() }; bridgeWork.set(bridge, work); }
  return work;
}
/** Serialize the whole load/merge/save transaction, including across panel remounts.
 * A failed transaction does not poison later explicit recovery. */
function withJournal<T>(journal: SessionProcessesJournal, run: () => Promise<T>): Promise<T> {
  const result = (journalWork.get(journal) ?? Promise.resolve()).then(run);
  journalWork.set(journal, result.then(() => {}, () => {}));
  return result;
}
function scopedEntries(value: unknown, scope: SessionProcessesJournalScope) {
  const entries = parseSessionProcessOperationEntries(value);
  if (entries.some(entry => entry.owner.nativeSessionId !== scope.sessionId))
    throw new Error("The operation journal belongs to another native session.");
  return entries;
}

class LateResponse extends Error {}

/** One renderer-side observer and operator of the OMP supervised process registry of a
 * single loaded session. It owns no process: rows are what the pinned native owner last
 * reported, and a change is only real once the owning host hands back a durable receipt.
 * Hiding, reconfiguring or stopping this observer never touches a native process. */
export class SessionProcessesState {
  #bridge: SessionProcessesBridge;
  #journal?: SessionProcessesJournal;
  #timers: SessionProcessesTimers;
  #listeners = new Set<() => void>();
  #view: SessionProcessesView;
  #scope?: SessionProcessesScope;
  /** Bumped on host/session change and stop; older work can no longer touch the view. */
  #epoch = 0;
  /** Last sent / last applied reading: an older reading never overwrites a newer one. */
  #sequence = 0; #applied = 0;
  /** Reads outstanding for the current epoch, for the view only. */
  #reading = 0;
  /** Shared by every controller using this bridge, including unmounted controllers. */
  #work: BridgeWork;
  #pinnedOwner?: SessionProcessesOwner; #pinnedBroker?: string;
  /** Metadata this window believes is durable, and ids whose removal is still owed. */
  #recorded = new Map<string, SessionProcessOperationMetadata>();
  #pruned = new Set<string>();
  #journalLoad?: Promise<void>;
  #interval?: unknown; #coalesce?: unknown;
  #polling = false; #pollPending = false; #pollAgain = false;

  constructor(bridge: SessionProcessesBridge, journal?: SessionProcessesJournal, timers: SessionProcessesTimers = globalThis) {
    this.#bridge = bridge; this.#journal = journal; this.#timers = timers;
    this.#work = workFor(bridge);
    this.#view = { ...initialSessionProcessesView("", "", this.supported, false), journalState: journal ? "loading" : "unavailable" };
  }
  get supported() { return typeof this.#bridge.sessionProcesses === "function"; }
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  getSnapshot = () => this.#view;
  #publish(next: Partial<SessionProcessesView>) {
    this.#view = { ...this.#view, ...next, busy: !!this.#work.mutating };
    for (const listener of this.#listeners) listener();
  }
  #patch(operationId: string, next: Partial<SessionProcessOperationView>) {
    if (!this.#view.operations.some(operation => operation.operationId === operationId)) return;
    this.#publish({ operations: this.#view.operations.map(operation => operation.operationId === operationId ? { ...operation, ...next } : operation) });
  }
  /** Budget shared by readings, actions and the slot a recording mutation holds. */
  #outstanding() { return this.#work.inFlight + this.#work.reserved; }
  #workChanged = () => {
    if (!this.#scope) return;
    this.#publish({});
    if (this.#pollAgain && !this.#pollPending && this.#outstanding() < SESSION_PROCESSES_MAX_IN_FLIGHT) {
      this.#pollAgain = false; this.#schedule();
    }
  };
  #notifyWork() { for (const listener of this.#work.listeners) listener(); }

  /** Called from the React layout effect. A host/session change drops the previous
   * owner's rows, logs and operation list before anything in flight settles; the
   * previous owner's records stay durable under their own scope. */
  configure(scope: SessionProcessesScope) {
    const previous = this.#scope; this.#scope = { ...scope };
    this.#work.listeners.add(this.#workChanged);
    const changed = !previous || previous.hostId !== scope.hostId || previous.sessionId !== scope.sessionId;
    if (changed) {
      this.#epoch++; this.#sequence = 0; this.#applied = 0; this.#reading = 0;
      this.#pollPending = false; this.#pollAgain = false;
      this.#pinnedOwner = undefined; this.#pinnedBroker = undefined;
      this.#recorded.clear(); this.#pruned.clear(); this.#journalLoad = undefined;
      this.#view = { ...initialSessionProcessesView(scope.hostId, scope.sessionId, this.supported, scope.connected),
        visible: scope.visible, journalState: this.#journal ? "loading" : "unavailable" };
    }
    this.#stopPolling();
    const stale = !!this.#view.snapshot && (this.#view.stale || !scope.connected);
    this.#publish({ connected: scope.connected, visible: scope.visible, stale,
      loading: !!scope.hostId && !!scope.sessionId && scope.connected && this.supported && !this.#view.snapshot && !this.#view.error });
    if (changed && scope.hostId && scope.sessionId) void this.#loadJournal(scope);
    if (scope.hostId && scope.sessionId && scope.visible && scope.connected && this.supported) this.#startPolling();
  }
  /** Unmount: stop reading and drop late results. No native process is stopped, no
   * operation is cancelled or replayed, and recorded metadata stays durable. */
  stop() {
    this.#epoch++; this.#stopPolling(); this.#scope = undefined;
    this.#work.listeners.delete(this.#workChanged); this.#listeners.clear();
  }

  #startPolling() {
    this.#polling = true;
    void this.#read();
    this.#interval = this.#timers.setInterval(() => void this.#read(), SESSION_PROCESSES_POLL_MS);
  }
  #stopPolling() {
    this.#polling = false;
    if (this.#interval !== undefined) { this.#timers.clearInterval(this.#interval); this.#interval = undefined; }
    if (this.#coalesce !== undefined) { this.#timers.clearTimeout(this.#coalesce); this.#coalesce = undefined; }
  }
  /** One outstanding reading at a time: further demand coalesces into a single follow-up. */
  #schedule() {
    if (!this.#polling) return;
    if (this.#pollPending || this.#outstanding() >= SESSION_PROCESSES_MAX_IN_FLIGHT) { this.#pollAgain = true; return; }
    if (this.#coalesce !== undefined) return;
    this.#coalesce = this.#timers.setTimeout(() => { this.#coalesce = undefined; void this.#read(); }, SESSION_PROCESSES_COALESCE_MS);
  }
  async #read() {
    const scope = this.#scope;
    if (!scope?.hostId || !scope.sessionId || !this.supported || !scope.connected || !scope.visible) return;
    if (this.#pollPending || this.#outstanding() >= SESSION_PROCESSES_MAX_IN_FLIGHT) { this.#schedule(); return; }
    this.#pollPending = true;
    const epoch = this.#epoch;
    try { await this.#requestRead(); }
    finally {
      if (epoch === this.#epoch) {
        this.#pollPending = false;
        if (this.#pollAgain) { this.#pollAgain = false; this.#schedule(); }
      }
    }
  }
  /** Explicit control: the same pinned reading, issued now. */
  async refresh() { await this.#read(); }

  /** Pinned reading: once an owner is accepted every later reading carries it, and an
   * answer from another native owner or another broker incarnation is refused. */
  async #requestRead() {
    const pinned = this.#pinnedOwner;
    const request: SessionProcessesRequest = pinned ? { action: "read", owner: pinned } : { action: "read" };
    const sequence = ++this.#sequence, epoch = this.#epoch;
    try {
      const result = await this.#call(request);
      await this.#journalLoad;
      if (epoch !== this.#epoch) return;
      if (result.action !== "read") throw new Error("The host answered a process reading with another action.");
      const snapshot = result.snapshot;
      if (this.#pinnedOwner && !sameSessionProcessesOwner(snapshot.owner, this.#pinnedOwner)) throw new Error(OWNER_CHANGED);
      if (this.#pinnedBroker && snapshot.brokerId !== this.#pinnedBroker) throw new Error(BROKER_CHANGED);
      if (sequence <= this.#applied) return;
      this.#applied = sequence;
      if (!this.#pinnedOwner) { this.#pinnedOwner = snapshot.owner; this.#pinnedBroker = snapshot.brokerId; }
      // An answer that arrives after the host went offline is real data, but the
      // display is no longer live: keep it marked stale.
      this.#publish({ snapshot, stale: !this.#scope?.connected, error: undefined, loading: false });
    } catch (cause) {
      if (cause instanceof LateResponse || epoch !== this.#epoch) return;
      if (sequence <= this.#applied) return;
      this.#applied = sequence;
      this.#publish({ stale: !!this.#view.snapshot, error: message(cause), loading: false });
    }
  }

  /** The single bounded bridge entry. Every answer is checked against the scope that
   * sent it, the protocol parser and the request it belongs to. */
  async #call(request: SessionProcessesRequest, reserved = false, scope = this.#scope, epoch = this.#epoch): Promise<SessionProcessesResult> {
    const sessionProcesses = this.#bridge.sessionProcesses;
    if (!reserved && this.#outstanding() >= SESSION_PROCESSES_MAX_IN_FLIGHT) throw new Error(SATURATED);
    // Convert a held reservation atomically, before notifying any subscriber.
    if (reserved) this.#work.reserved--;
    if (!scope || !sessionProcesses) throw new Error(UNSUPPORTED);
    if (epoch !== this.#epoch) throw new LateResponse();
    const hostId = scope.hostId, sessionId = scope.sessionId;
    this.#work.inFlight++; this.#reading++;
    this.#publish({ reading: true });
    try {
      if (epoch !== this.#epoch || !this.#scope?.connected || !this.#scope.visible) throw new LateResponse();
      const envelope = await sessionProcesses.call(this.#bridge, sessionId, request, hostId);
      if (epoch !== this.#epoch) throw new LateResponse("late");
      const parsed = parseSessionProcessesEnvelope(envelope, hostId, sessionId);
      // A pinned reading answered for another native owner gets its own explanation
      // before the generic protocol mismatch the same condition would raise.
      if (request.action === "read" && request.owner && parsed.result.action === "read"
        && !sameSessionProcessesOwner(request.owner, parsed.result.snapshot.owner)) throw new Error(OWNER_CHANGED);
      assertSessionProcessesResultMatches(request, parsed.result);
      return parsed.result;
    } finally {
      this.#work.inFlight--;
      if (epoch === this.#epoch) {
        this.#reading--;
        this.#publish({ reading: this.#reading > 0 });
        if (this.#pollAgain && !this.#pollPending) { this.#pollAgain = false; this.#schedule(); }
      }
      this.#notifyWork();
    }
  }

  /** Bounded retained output of one current row, read from the pinned owner. Allowed
   * while stale because it is a reading; it never acknowledges or consumes anything. */
  async inspect(target: SessionProcessTarget) {
    const scope = this.#scope, owner = this.#pinnedOwner;
    if (!scope || !this.supported || !scope.connected || !scope.visible || !owner) return;
    const row = findProcessRow(this.#view.snapshot, target);
    if (!row) return;
    const request = parseSessionProcessesRequest({ action: "logs", owner, target: row.target });
    if (request.action !== "logs") return;
    const pinnedTarget = request.target;
    this.#publish({ logs: { target: pinnedTarget, state: "pending" } });
    try {
      const result = await this.#call(request);
      if (result.action !== "logs") throw new Error("The host answered a log reading with another action.");
      if (!this.#inspecting(pinnedTarget)) return;
      this.#publish({ logs: { target: pinnedTarget, state: "ready", text: result.text, truncated: result.truncated } });
    } catch (cause) {
      if (cause instanceof LateResponse || !this.#inspecting(pinnedTarget)) return;
      this.#publish({ logs: { target: pinnedTarget, state: "failed", error: message(cause) } });
    }
  }
  #inspecting(target: SessionProcessTarget) {
    const logs = this.#view.logs;
    return !!logs && logs.state === "pending" && sameSessionProcessTarget(logs.target, target);
  }
  closeLogs() { if (this.#view.logs && this.#view.logs.state !== "pending") this.#publish({ logs: undefined }); }

  /** One recorded, serialized change of one exact current row.
   * The identity is copied through the protocol parsers before anything is awaited, the
   * metadata is durable before the request leaves, and the permission is rechecked after
   * the write: an operation that is no longer allowed is reported as never sent. */
  async mutate(target: SessionProcessTarget, action: SessionProcessMutation["action"], text?: string) {
    const scope = this.#scope, journal = this.#journal;
    if (!scope || !this.supported || !journal || this.#work.mutating) return;
    const row = findProcessRow(this.#view.snapshot, target), owner = this.#pinnedOwner;
    if (!row || !owner || processMutationRefusal(this.#view, row, action)) return;
    if (this.#outstanding() >= SESSION_PROCESSES_MAX_IN_FLIGHT) { this.#publish({ error: SATURATED }); return; }
    const operationId = crypto.randomUUID();
    const metadata: SessionProcessOperationMetadata = { operationId, action,
      owner: parseSessionProcessesOwner(owner), target: parseSessionProcessTarget(row.target) };
    const request: SessionProcessMutation = action === "input"
      ? { action: "input", operationId, owner: metadata.owner, target: metadata.target, text: typeof text === "string" ? text : "" }
      : { action, operationId, owner: metadata.owner, target: metadata.target };
    try { parseSessionProcessesRequest(request); }
    catch (cause) { this.#publish({ error: message(cause) }); return; }
    const journalScope = { hostId: scope.hostId, sessionId: scope.sessionId }, epoch = this.#epoch;
    this.#work.mutating = operationId; this.#work.reserved++;
    this.#recorded.set(operationId, metadata);
    this.#publish({ error: undefined, operations: [...this.#view.operations, { ...metadata, status: "saving", lookupPending: false }] });
    this.#notifyWork();
    try {
      await this.#persist(journal, journalScope, metadata);
    } catch (cause) {
      if (epoch === this.#epoch) {
        this.#forget(operationId);
        this.#patch(operationId, { status: "not-sent", error: `${message(cause)} Nothing was sent.` });
        this.#publish({ journalState: "failed", journalError: message(cause) });
      }
      await this.#prune(journal, journalScope, epoch, [operationId]);
      this.#release(operationId, true);
      return;
    }
    const current = this.#scope, live = findProcessRow(this.#view.snapshot, metadata.target);
    const permission = { ...this.#view, busy: false, operations: this.#view.operations.filter(entry => entry.operationId !== operationId) };
    if (epoch !== this.#epoch || !current || current.hostId !== journalScope.hostId || current.sessionId !== journalScope.sessionId
      || !this.#pinnedOwner || !sameSessionProcessesOwner(metadata.owner, this.#pinnedOwner)
      || processMutationRefusal(permission, live, action)) {
      if (epoch === this.#epoch) { this.#forget(operationId); this.#patch(operationId, { status: "not-sent", error: NOT_DISPATCHED }); }
      await this.#prune(journal, journalScope, epoch, [operationId]);
      this.#release(operationId, true);
      return;
    }
    this.#patch(operationId, { status: "pending", error: undefined });
    try {
      const result = await this.#call(request, true, scope, epoch);
      if (result.action !== "mutation") throw new Error("The host answered a process operation with another action.");
      await this.#settle(operationId, result.receipt, journal, journalScope);
    } catch (cause) {
      const operation = this.#view.operations.find(entry => entry.operationId === operationId);
      if (!(cause instanceof LateResponse) && epoch === this.#epoch && operation && unresolved(operation.status))
        this.#patch(operationId, { status: "unknown", error: `${message(cause)} ${UNCERTAIN}` });
    } finally {
      if (request.action === "input") request.text = "";
      this.#release(operationId, false);
    }
  }

  /** Explicit, user-driven receipt lookup for one recorded operation of this original
   * host/session. Never automatic, never a resend, and possible while the row is gone. */
  async lookupReceipt(operationId: string) {
    const scope = this.#scope;
    const operation = this.#view.operations.find(entry => entry.operationId === operationId);
    if (!operation || operation.lookupPending || !this.supported || !scope || !scope.connected || !scope.visible) return;
    if (operation.status !== "pending" && operation.status !== "unknown") return;
    if (this.#outstanding() >= SESSION_PROCESSES_MAX_IN_FLIGHT) { this.#patch(operationId, { error: SATURATED }); return; }
    const journalScope: SessionProcessesJournalScope = { hostId: scope.hostId, sessionId: scope.sessionId };
    const epoch = this.#epoch;
    this.#patch(operationId, { lookupPending: true, error: undefined });
    try {
      const result = await this.#call(parseSessionProcessesRequest({ action: "receipt", operationId }));
      if (result.action !== "receipt") throw new Error("The host answered a receipt lookup with another action.");
      const current = this.#view.operations.find(entry => entry.operationId === operationId);
      if (!current || !unresolved(current.status)) return;
      if (!result.receipt) { this.#patch(operationId, { status: "unknown", error: NO_RECORD }); return; }
      await this.#settle(operationId, result.receipt, this.#journal, journalScope);
    } catch (cause) {
      if (cause instanceof LateResponse || epoch !== this.#epoch) return;
      const current = this.#view.operations.find(entry => entry.operationId === operationId);
      if (current && unresolved(current.status)) this.#patch(operationId, { error: message(cause) });
    } finally { if (epoch === this.#epoch) this.#patch(operationId, { lookupPending: false }); }
  }

  /** Applies one receipt to the operation it names. The receipt must match the saved
   * metadata in full; only a durable completed or rejected receipt resolves anything. */
  async #settle(operationId: string, receipt: SessionProcessReceipt, journal: SessionProcessesJournal | undefined, scope: SessionProcessesJournalScope) {
    const operation = this.#view.operations.find(entry => entry.operationId === operationId);
    if (!operation || !unresolved(operation.status)) return;
    if (receipt.action !== operation.action || !sameSessionProcessesOwner(receipt.owner, operation.owner)
      || !sameSessionProcessTarget(receipt.target, operation.target))
      throw new Error("The host answered with a receipt for another process operation.");
    if (receipt.status === "pending" || receipt.status === "unknown") {
      this.#patch(operationId, { status: receipt.status, error: receipt.status === "unknown" ? UNCERTAIN : undefined });
      return;
    }
    if (receipt.status === "completed") {
      this.#patch(operationId, { status: "completed", row: receipt.row, error: undefined });
      this.#reconcile(receipt.row, operation.target, receipt.owner);
    } else if (receipt.status === "rejected") {
      this.#patch(operationId, { status: "rejected", error: receipt.message, row: undefined });
    }
    const epoch = this.#epoch;
    this.#forget(operationId);
    if (journal) await this.#prune(journal, scope, epoch, [operationId]);
    this.#release(operationId, false);
  }
  /** The host's own durable row for a confirmed change, applied to the pinned reading.
   * It replaces the exact row the operation named, or the same identity read since; a
   * row the host has already moved further (another generation) is never downgraded,
   * and readings begun before this receipt can no longer restore the older row. */
  #reconcile(row: SessionProcessRow, original: SessionProcessTarget, owner: SessionProcessesOwner) {
    const snapshot = this.#view.snapshot;
    if (!snapshot || this.#view.stale || !sameSessionProcessesOwner(snapshot.owner, owner) || row.target.brokerId !== snapshot.brokerId) return;
    const index = snapshot.rows.findIndex(current =>
      sameSessionProcessTarget(current.target, original) || sameSessionProcessTarget(current.target, row.target));
    if (index < 0) return;
    this.#applied = this.#sequence;
    this.#publish({ snapshot: { ...snapshot, rows: snapshot.rows.map((current, at) => at === index ? row : current) } });
  }
  #forget(operationId: string) { this.#recorded.delete(operationId); this.#pruned.add(operationId); }
  #release(operationId: string, reservation: boolean) {
    if (reservation) this.#work.reserved--;
    if (this.#work.mutating === operationId) this.#work.mutating = undefined;
    this.#notifyWork();
  }
  /** Prune only the captured original operation IDs, never another scope's current maps. */
  async #prune(journal: SessionProcessesJournal, scope: SessionProcessesJournalScope, epoch: number, drop: readonly string[]) {
    if (!drop.length) return true;
    try {
      await this.#persist(journal, scope, undefined, drop);
      if (epoch === this.#epoch) for (const id of drop) this.#pruned.delete(id);
      return true;
    } catch (cause) {
      if (epoch === this.#epoch)
        this.#publish({ journalState: "failed", journalError: `The operation record could not be updated: ${message(cause)}` });
      return false;
    }
  }
  /** Incremental serialized updates cannot restore a record another controller retired. */
  #persist(journal: SessionProcessesJournal, scope: SessionProcessesJournalScope,
    add?: SessionProcessOperationMetadata, drop: readonly string[] = []) {
    return withJournal(journal, async () => {
      const durable = scopedEntries(await journal.load(scope), scope);
      if (add && durable.some(entry => entry.target.name === add.target.name))
        throw new Error("An earlier operation for this process is recorded. Reload the journal and look up its receipt.");
      const entries = durable.filter(entry => !drop.includes(entry.operationId));
      if (add) entries.push(parseOperationMetadata(add));
      if (entries.length > SESSION_PROCESSES_MAX_OPERATIONS) throw new Error("The recorded process operations exceed the supported limit.");
      await journal.save(scope, entries);
    });
  }

  /** Loads the durable record of this host/session. Recorded operations reappear as
   * unknown: they are never rebound to a current row and never resent. */
  async #loadJournal(scope: SessionProcessesScope) {
    const journal = this.#journal;
    if (!journal) { this.#publish({ journalState: "unavailable", journalError: undefined }); return; }
    const epoch = this.#epoch, journalScope: SessionProcessesJournalScope = { hostId: scope.hostId, sessionId: scope.sessionId };
    this.#publish({ journalState: "loading", journalError: undefined });
    const load = (async () => {
      try {
        const entries = await withJournal(journal, async () => scopedEntries(await journal.load(journalScope), journalScope));
        if (epoch !== this.#epoch) return;
        if (!this.#pinnedOwner && entries[0]) {
          this.#pinnedOwner = entries[0].owner; this.#pinnedBroker = entries[0].target.brokerId;
        }
        const known = new Set(this.#view.operations.map(operation => operation.operationId));
        const recovered: SessionProcessOperationView[] = [];
        for (const entry of entries) {
          if (this.#pruned.has(entry.operationId)) continue;
          this.#recorded.set(entry.operationId, entry);
          if (!known.has(entry.operationId)) recovered.push({ ...entry, status: "unknown", lookupPending: false, error: RECOVERED });
        }
        this.#publish({ journalState: "ready", journalError: undefined, operations: [...this.#view.operations, ...recovered] });
      } catch (cause) {
        if (epoch !== this.#epoch) return;
        this.#publish({ journalState: "failed", journalError: message(cause) });
      }
    })();
    this.#journalLoad = load;
    await load;
  }
  /** Explicit retry of the record itself. It never dispatches, resends or resolves an operation. */
  async retryJournal() {
    const scope = this.#scope;
    if (!scope || !this.#journal) return;
    if (this.#view.journalState === "loading") { await this.#journalLoad; return; }
    if (this.#view.journalState !== "failed") return;
    if (!await this.#prune(this.#journal, { hostId: scope.hostId, sessionId: scope.sessionId }, this.#epoch, [...this.#pruned])) return;
    await this.#loadJournal(scope);
  }

  /** Local list hygiene only: an operation whose outcome is durable, or which is proven
   * never sent, can be removed from the display. Pending or unknown work cannot. */
  dismissOperation(operationId: string) {
    const operation = this.#view.operations.find(entry => entry.operationId === operationId);
    if (!operation || operation.lookupPending || unresolved(operation.status)) return;
    if (this.#recorded.has(operationId)) return;
    this.#publish({ operations: this.#view.operations.filter(entry => entry.operationId !== operationId) });
  }
}
