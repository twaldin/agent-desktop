import type { DesktopEvent } from "../../../../packages/shared/src/protocol";
import type { RecordedImageBytes } from "../../../../packages/shared/src/attachments";
import { sameSessionSubagentsOwner, sameSessionSubagentTarget, SESSION_SUBAGENTS_PROTOCOL_VERSION, type SessionSubagentRow, type SessionSubagentsEnvelope, type SessionSubagentsOwner, type SessionSubagentsRequest, type SessionSubagentsResult, type SessionSubagentTarget } from "../../../../packages/shared/src/session-subagents";
import type { AttachmentMediaContext } from "./attachment-media";

/** Structural subset of DesktopBridge; the panel never needs anything else. */
export interface SessionSubagentsBridge {
  subscribe(listener: (event: DesktopEvent) => void): () => void;
  sessionSubagents?(sessionId: string, request: SessionSubagentsRequest, hostId: string): Promise<SessionSubagentsEnvelope>;
  openExternal(url: string): Promise<void>;
}
/** `active` is the dock tab being shown; reads only happen while active and connected. */
export interface SessionSubagentsScope { hostId: string; sessionId: string; connected: boolean; active: boolean }
export type SessionSubagentsList = Extract<SessionSubagentsResult, { action: "list" }>;
export type SessionSubagentTranscript = Extract<SessionSubagentsResult, { action: "transcript" }>;
export type SessionSubagentImage = Extract<SessionSubagentsResult, { action: "image" }>["image"];
export interface SessionSubagentPreview { path: string; state: "pending" | "ready" | "failed"; text?: string; truncated?: boolean; error?: string }
export interface SessionSubagentDetail {
  /** Owner and child generation captured when the row was opened; every read of this detail carries both. */
  owner: SessionSubagentsOwner;
  target: SessionSubagentTarget;
  /** Row as listed when opened, so the header survives the row leaving the native roster. */
  row: SessionSubagentRow;
  state: "pending" | "ready" | "failed";
  transcript?: SessionSubagentTranscript;
  /** Retained transcript whose latest re-read failed or whose host is offline. */
  stale: boolean;
  error?: string;
  /** The last transcript read happened while the child was running; one more read settles it. */
  live: boolean;
  preview?: SessionSubagentPreview;
}
export interface SessionSubagentsView {
  hostId: string; sessionId: string; supported: boolean; connected: boolean; active: boolean;
  /** No list yet and a read is expected. */
  loading: boolean;
  reading: boolean;
  /** Last roster read from the pinned native owner; retained through failures, never replaced by a fabricated empty. */
  list?: SessionSubagentsList;
  /** Retained rows whose latest read failed, whose owner was replaced on the host, or whose host is offline. */
  stale: boolean;
  /** The host now reports another native owner for this session; only an explicit reload retargets. */
  ownerChanged: boolean;
  error?: string;
  detail?: SessionSubagentDetail;
}
export interface SessionSubagentsTimers {
  setTimeout(handler: () => void, ms: number): unknown; clearTimeout(handle: unknown): void;
  setInterval(handler: () => void, ms: number): unknown; clearInterval(handle: unknown): void;
}

/** Same cadence as the Environment activity observer. */
export const SESSION_SUBAGENTS_POLL_MS = 5000;
export const SESSION_SUBAGENTS_COALESCE_MS = 90;
const UNSUPPORTED = "Subagents are unavailable through this desktop bridge.";
const OFFLINE = "Offline · reconnect to the owning host to read this subagent.";
const OWNER_CHANGED = "The native session behind these subagents changed. Reload to read the current native session.";
const NOT_OPEN = "This subagent is no longer open.";

export const subagentRowKey = (target: SessionSubagentTarget) => `${target.id}\u0000${target.sessionId}\u0000${target.guard}`;

export function initialSessionSubagentsView(hostId: string, sessionId: string, supported: boolean, connected: boolean, active: boolean): SessionSubagentsView {
  return { hostId, sessionId, supported, connected, active, loading: supported && connected, reading: false, stale: false, ownerChanged: false };
}

export function findSubagentRow(list: SessionSubagentsList | undefined, target: SessionSubagentTarget): SessionSubagentRow | undefined {
  return list?.availability === "available" ? list.rows.find(row => sameSessionSubagentTarget(row.target, target)) : undefined;
}

/** Why a row cannot be opened right now; undefined when opening is allowed. */
export function openRefusal(view: SessionSubagentsView): string | undefined {
  if (!view.supported) return UNSUPPORTED;
  if (!view.connected) return "Offline · reconnect before opening a subagent.";
  return undefined;
}

/** Native image bytes travel as base64; the panel is the only place that decodes them. */
export function decodeSubagentImage(image: SessionSubagentImage): RecordedImageBytes {
  let binary: string;
  try { binary = atob(image.base64); } catch { throw new Error("The host image bytes are not valid base64."); }
  if (binary.length !== image.bytes) throw new Error("The host image size differs from its metadata.");
  const data = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index);
  return { data, sha256: image.sha256, bytes: image.bytes, mimeType: image.mimeType };
}

/** Media context bound to one opened child. Recorded transcript images go to the child through its captured
 * owner and target; there is no parent-session route. Attachment bytes stay content-addressed on the host. */
export function subagentMediaContext(state: Pick<SessionSubagentsState, "image">, target: SessionSubagentTarget, parent: AttachmentMediaContext): AttachmentMediaContext {
  const getImageAttachment = parent.bridge.getImageAttachment;
  return {
    cache: parent.cache,
    bridge: {
      ...(getImageAttachment ? { getImageAttachment: (sha256: string, hostId: string) => getImageAttachment.call(parent.bridge, sha256, hostId) } : {}),
      getTranscriptImage: (_sessionId, nativeEntryId, blockIndex, _hostId, source) => state.image(target, nativeEntryId, blockIndex, source),
    },
  };
}

class LateResponse extends Error {}

/** One renderer-side observer of the original native session's owned subagents.
 * Rows are whatever the owning host last reported for the pinned native owner; opening a row reads the exact
 * child generation that was listed. Nothing here resumes, messages or stops a child. */
export class SessionSubagentsState {
  #bridge: SessionSubagentsBridge; #timers: SessionSubagentsTimers;
  #listeners = new Set<() => void>();
  #view: SessionSubagentsView;
  #scope?: SessionSubagentsScope;
  /** Bumped on host/session change and stop; settled requests from an older epoch never touch the view. */
  #epoch = 0;
  /** Monotonic ticket for every read; an older reply never overwrites a newer one. */
  #token = 0;
  #selection = 0;
  #listApplied = 0; #detailApplied = 0; #previewToken = 0;
  #inFlight = 0;
  #pollPending = false; #pollAgain = false;
  #reloadPending = false;
  #coalesce?: unknown; #interval?: unknown; #unsubscribe?: () => void;
  constructor(bridge: SessionSubagentsBridge, timers: SessionSubagentsTimers = globalThis) {
    this.#bridge = bridge; this.#timers = timers;
    this.#view = initialSessionSubagentsView("", "", this.supported, false, false);
  }
  get supported() { return typeof this.#bridge.sessionSubagents === "function"; }
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  getSnapshot = () => this.#view;
  #publish(next: Partial<SessionSubagentsView>) { this.#view = { ...this.#view, ...next }; for (const listener of this.#listeners) listener(); }

  /** Called from the React layout effect. A host/session change drops the previous owner's view before any request settles. */
  configure(scope: SessionSubagentsScope) {
    const previous = this.#scope; this.#scope = scope;
    const changed = !previous || previous.hostId !== scope.hostId || previous.sessionId !== scope.sessionId;
    if (changed) {
      this.#epoch++; this.#listApplied = 0; this.#detailApplied = 0; this.#previewToken = 0; this.#inFlight = 0;
      this.#selection++;
      this.#pollPending = false; this.#pollAgain = false; this.#reloadPending = false;
      this.#view = initialSessionSubagentsView(scope.hostId, scope.sessionId, this.supported, scope.connected, scope.active);
    }
    this.#stopPolling();
    const stale = !!this.#view.list && (this.#view.stale || !scope.connected);
    const detail = this.#view.detail;
    const offlineDetail = detail && !scope.connected && detail.transcript && !detail.stale ? { ...detail, stale: true } : detail;
    if (scope.active && scope.connected && this.supported) {
      this.#publish({ connected: true, active: true, stale, detail: offlineDetail });
      this.#startPolling(scope);
    } else this.#publish({ connected: scope.connected, active: scope.active, loading: scope.connected && this.supported && !this.#view.list && !this.#view.error, stale, detail: offlineDetail });
  }
  /** Unmount: stop reads and drop late results. Nothing native is touched. */
  stop() { this.#epoch++; this.#stopPolling(); this.#scope = undefined; this.#listeners.clear(); }

  #startPolling(scope: SessionSubagentsScope) {
    this.#unsubscribe = this.#bridge.subscribe(event => {
      if ((event.hostId ?? scope.hostId) !== scope.hostId) return;
      if (event.type === "runtime") {
        if (event.sessionId !== scope.sessionId) return;
        const native = event.event as { activityChanged?: unknown } | null;
        if (event.sessionActivity === true || (native !== null && typeof native === "object" && native.activityChanged === true)) this.#schedule();
      } else if (event.type === "state" && event.state.sessions.some(session => session.id === scope.sessionId)) this.#schedule();
    });
    void this.#poll();
    this.#interval = this.#timers.setInterval(() => void this.#poll(), SESSION_SUBAGENTS_POLL_MS);
  }
  #stopPolling() {
    this.#unsubscribe?.(); this.#unsubscribe = undefined;
    if (this.#interval !== undefined) { this.#timers.clearInterval(this.#interval); this.#interval = undefined; }
    if (this.#coalesce !== undefined) { this.#timers.clearTimeout(this.#coalesce); this.#coalesce = undefined; }
  }
  #schedule() {
    if (this.#coalesce !== undefined || !this.#unsubscribe) return;
    this.#coalesce = this.#timers.setTimeout(() => { this.#coalesce = undefined; void this.#poll(); }, SESSION_SUBAGENTS_COALESCE_MS);
  }
  /** Pinned read: once an owner is known every automatic read carries it and refuses another owner's rows. */
  async #poll() {
    if (!this.#unsubscribe || this.#reloadPending) return;
    if (this.#pollPending) { this.#pollAgain = true; return; }
    this.#pollPending = true;
    const epoch = this.#epoch;
    try { await this.#readList(this.#view.list?.owner); await this.#refreshDetail(); }
    finally {
      if (epoch === this.#epoch) { this.#pollPending = false; if (this.#pollAgain) { this.#pollAgain = false; this.#schedule(); } }
    }
  }
  /** Explicit control: same pinned read as the poll, issued now. */
  async refresh() {
    if (!this.#scope || !this.supported || !this.#scope.connected || this.#reloadPending) return;
    if (this.#coalesce !== undefined) { this.#timers.clearTimeout(this.#coalesce); this.#coalesce = undefined; }
    await this.#readList(this.#view.list?.owner); await this.#refreshDetail();
  }
  /** Explicit control after owner loss: reads whatever native owner the host has now and replaces the retained view. */
  async reload() {
    if (!this.#scope || !this.supported || !this.#scope.connected || this.#reloadPending) return;
    const epoch = this.#epoch;
    this.#reloadPending = true;
    try { await this.#readList(undefined); }
    finally { if (epoch === this.#epoch) this.#reloadPending = false; }
  }

  async #readList(owner: SessionSubagentsOwner | undefined) {
    const token = ++this.#token;
    try {
      const result = await this.#request(owner ? { action: "list", owner } : { action: "list" }, owner);
      if (result.action !== "list") throw new Error("The host answered the subagent list with a different action.");
      if (token <= this.#listApplied) return;
      this.#listApplied = token;
      const replaced = !!this.#view.list && !sameSessionSubagentsOwner(this.#view.list.owner, result.owner);
      if (replaced) this.#detailApplied = ++this.#token;
      this.#publish({ list: result, stale: !this.#scope?.connected, ownerChanged: false, error: undefined, loading: false, ...(replaced ? { detail: undefined } : {}) });
    } catch (cause) {
      if (cause instanceof LateResponse || token <= this.#listApplied) return;
      this.#listApplied = token;
      const message = cause instanceof Error ? cause.message : String(cause);
      this.#publish({ stale: !!this.#view.list, ownerChanged: message === OWNER_CHANGED || message.includes("[STALE_OWNER]"), error: message, loading: false });
    }
  }

  /** Every response is checked against the scope that sent it, the pinned owner, the requested target and later responses. */
  async #request(request: SessionSubagentsRequest, pin: SessionSubagentsOwner | undefined): Promise<SessionSubagentsResult> {
    const scope = this.#scope, sessionSubagents = this.#bridge.sessionSubagents;
    if (!scope || !sessionSubagents) throw new Error(UNSUPPORTED);
    if (!scope.connected) throw new Error(OFFLINE);
    const epoch = this.#epoch;
    this.#inFlight++; this.#publish({ reading: true });
    try {
      const envelope = await sessionSubagents.call(this.#bridge, scope.sessionId, request, scope.hostId);
      if (epoch !== this.#epoch) throw new LateResponse();
      if (pin && this.#view.list && !sameSessionSubagentsOwner(this.#view.list.owner, pin)) throw new LateResponse();
      if (envelope.protocolVersion !== SESSION_SUBAGENTS_PROTOCOL_VERSION || envelope.hostId !== scope.hostId || envelope.sessionId !== scope.sessionId) throw new Error("The subagents response belongs to a different session or an unsupported protocol.");
      const result = envelope.result;
      if (result.action !== request.action) throw new Error("The host answered the subagents request with a different action.");
      if (request.owner && !sameSessionSubagentsOwner(result.owner, request.owner)) throw new Error(OWNER_CHANGED);
      if ("target" in request && (!("target" in result) || !sameSessionSubagentTarget(result.target, request.target))) throw new Error("The host answered for a different subagent.");
      return result;
    } catch (cause) {
      if (epoch !== this.#epoch) throw new LateResponse();
      if (pin && this.#view.list && !sameSessionSubagentsOwner(this.#view.list.owner, pin)) throw new LateResponse();
      throw cause;
    } finally {
      if (epoch === this.#epoch) { this.#inFlight--; this.#publish({ reading: this.#inFlight > 0 }); }
    }
  }

  #detailIs(target: SessionSubagentTarget) { const current = this.#view.detail; return !!current && sameSessionSubagentTarget(current.target, target); }

  /** Opens the exact listed child generation for reading. The owner and target captured here travel with every later read. */
  open(target: SessionSubagentTarget): Promise<void> {
    const list = this.#view.list, row = findSubagentRow(list, target);
    if (!list || !row || openRefusal(this.#view) || this.#reloadPending) return Promise.resolve();
    if (this.#detailIs(target)) return Promise.resolve();
    this.#detailApplied = ++this.#token;
    this.#selection++;
    this.#publish({ detail: { owner: list.owner, target, row, state: "pending", stale: false, live: false } });
    return this.#readTranscript(target, list.owner);
  }
  /** Returns to the list. A transcript still in flight for this child is discarded when it lands. */
  back() {
    if (!this.#view.detail) return;
    this.#detailApplied = ++this.#token; this.#previewToken = 0;
    this.#selection++;
    this.#publish({ detail: undefined });
  }
  async #refreshDetail() {
    const detail = this.#view.detail;
    if (!detail || detail.state === "pending" || !this.#scope?.connected || !this.#scope.active) return;
    const row = findSubagentRow(this.#view.list, detail.target);
    if (!row?.running && !detail.live) return;
    await this.#readTranscript(detail.target, detail.owner);
  }
  async #readTranscript(target: SessionSubagentTarget, owner: SessionSubagentsOwner) {
    const token = ++this.#token;
    try {
      const result = await this.#request({ action: "transcript", owner, target }, owner);
      if (result.action !== "transcript") throw new Error("The host answered a transcript read with a different action.");
      if (!this.#detailIs(target) || token <= this.#detailApplied) return;
      this.#detailApplied = token;
      const live = findSubagentRow(this.#view.list, target)?.running ?? false;
      this.#publish({ detail: { ...this.#view.detail!, state: "ready", transcript: result, stale: !this.#scope?.connected, error: undefined, live } });
    } catch (cause) {
      if (cause instanceof LateResponse || !this.#detailIs(target) || token <= this.#detailApplied) return;
      this.#detailApplied = token;
      const current = this.#view.detail!, message = cause instanceof Error ? cause.message : String(cause);
      this.#publish({ detail: { ...current, state: current.transcript ? "ready" : "failed", stale: !!current.transcript, error: message } });
    }
  }

  /** Read-only text of one file relative to the child's own cwd, rendered inside this panel. Never opens a workspace by id. */
  async openFile(target: SessionSubagentTarget, path: string): Promise<void> {
    const detail = this.#view.detail;
    if (!detail || !sameSessionSubagentTarget(detail.target, target)) throw new Error(NOT_OPEN);
    if (!this.#scope?.connected) throw new Error(OFFLINE);
    if (!detail.transcript?.cwd) throw new Error("This subagent has no working directory for file links.");
    if (path.startsWith("/")) throw new Error("Only files inside the subagent's working directory can be previewed here.");
    const token = this.#previewToken = ++this.#token;
    this.#publish({ detail: { ...detail, preview: { path, state: "pending" } } });
    try {
      const result = await this.#request({ action: "file", owner: detail.owner, target, path }, detail.owner);
      if (result.action !== "file") throw new Error("The host answered a file read with a different action.");
      if (result.path !== path) throw new Error("The host answered with a different file.");
      if (!this.#previewIs(target, token)) return;
      this.#publish({ detail: { ...this.#view.detail!, preview: { path, state: "ready", text: result.text, truncated: result.truncated } } });
    } catch (cause) {
      if (cause instanceof LateResponse || !this.#previewIs(target, token)) return;
      this.#publish({ detail: { ...this.#view.detail!, preview: { path, state: "failed", error: cause instanceof Error ? cause.message : String(cause) } } });
    }
  }
  #previewIs(target: SessionSubagentTarget, token: number) { return this.#detailIs(target) && this.#previewToken === token && !!this.#view.detail!.preview; }
  closePreview() {
    const detail = this.#view.detail;
    if (!detail?.preview) return;
    this.#previewToken = 0;
    this.#publish({ detail: { ...detail, preview: undefined } });
  }

  /** The host re-validates the exact child before the desktop opens anything; a changed selection cancels the open. */
  async openExternal(target: SessionSubagentTarget, url: string): Promise<void> {
    const detail = this.#view.detail;
    const selection = this.#selection;
    if (!detail || !sameSessionSubagentTarget(detail.target, target)) throw new Error(NOT_OPEN);
    let result: SessionSubagentsResult;
    try { result = await this.#request({ action: "validate", owner: detail.owner, target }, detail.owner); }
    catch (cause) { throw cause instanceof LateResponse ? new Error("The session changed; the link was not opened.") : cause; }
    if (result.action !== "validate") throw new Error("The host answered a validation with a different action.");
    if (!this.#detailIs(target) || selection !== this.#selection || !this.#scope?.connected || !this.#scope.active) throw new Error("The selected subagent changed; the link was not opened.");
    await this.#bridge.openExternal(url);
  }

  /** Recorded transcript image of the opened child, through its captured owner and target only. */
  async image(target: SessionSubagentTarget, nativeEntryId: string, blockIndex: number, source?: "generated"): Promise<RecordedImageBytes> {
    const detail = this.#view.detail;
    const selection = this.#selection;
    if (!detail || !sameSessionSubagentTarget(detail.target, target)) throw new Error(NOT_OPEN);
    let result: SessionSubagentsResult;
    try { result = await this.#request({ action: "image", owner: detail.owner, target, nativeEntryId, blockIndex, ...(source ? { source } : {}) }, detail.owner); }
    catch (cause) { throw cause instanceof LateResponse ? new Error(NOT_OPEN) : cause; }
    if (result.action !== "image") throw new Error("The host answered an image read with a different action.");
    if (!this.#detailIs(target) || selection !== this.#selection || !this.#scope?.connected || !this.#scope.active) throw new Error(NOT_OPEN);
    return decodeSubagentImage(result.image);
  }
}
