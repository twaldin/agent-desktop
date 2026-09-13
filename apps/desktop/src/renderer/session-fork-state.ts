import type { CommandEnvelope, DesktopBridge, SessionSummary } from '../../../../packages/shared/src/protocol';
import type { SessionForkSnapshot } from '../../../../packages/shared/src/session-fork';
import type { DraftCache } from './drafts';

export type ForkExecution = { type: 'local' } | { type: 'worktree'; startingState: { type: 'working-tree' } };
interface PendingFork { envelope: CommandEnvelope; operationId: string; bound?: { sessionId: string; sessionFile: string } }
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** Fork never owns either composer's draft. A persisted intent survives an
 * uncertain response; recovery reads the binding, never repeats the effect. */
export class SessionForkState {
  value?: SessionForkSnapshot;
  pending?: PendingFork;
  child?: SessionSummary;
  error?: string;
  receiptError?: string;
  busy = false;
  loading = false;
  connected = false;
  supported = false;
  private ready = false;
  private generation = 0;
  private readSequence = 0;
  private listeners = new Set<() => void>();
  private readonly key: string;

  constructor(private bridge: Pick<DesktopBridge, 'command' | 'getState' | 'getSessionFork'>, readonly hostId: string, readonly sessionId: string, private cache: DraftCache) {
    this.key = `session-fork.pending.${hostId}.${sessionId}`;
    try {
      const saved = JSON.parse(cache.read(this.key) || 'null') as PendingFork | null;
      if (saved !== null) {
        const envelope = saved.envelope, command = envelope?.command;
        if (!envelope || !identifier(envelope.id) || envelope.commandVersion !== 16 || !identifier(saved.operationId)
          || !command || !('sessionId' in command) || command.sessionId !== sessionId
          || Object.keys(envelope).some(key => !['id', 'commandVersion', 'command'].includes(key))) throw new Error('Invalid fork intent.');
        if (command.type === 'session.fork') {
          if (saved.operationId !== envelope.id || typeof command.expectedRevision !== 'string' || !command.expectedRevision
            || Object.keys(command).some(key => !['type', 'sessionId', 'expectedRevision', 'execution'].includes(key))
            || !command.execution || (command.execution.type !== 'local' && (command.execution.type !== 'worktree' || command.execution.startingState.type !== 'working-tree'))) throw new Error('Invalid fork destination.');
        } else if (command.type !== 'session.fork.resume' || command.operationId !== saved.operationId
          || Object.keys(command).some(key => !['type', 'sessionId', 'operationId'].includes(key))) throw new Error('Invalid fork recovery.');
        if (saved.bound && (!identifier(saved.bound.sessionId) || saved.bound.sessionId === sessionId || typeof saved.bound.sessionFile !== 'string' || !saved.bound.sessionFile)) throw new Error('Invalid fork binding.');
        this.pending = saved;
      }
    } catch {
      this.receiptError = this.error = 'The saved fork receipt could not be read. Forking is disabled to avoid repeating an unconfirmed request.';
    }
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish() { for (const listener of this.listeners) listener(); }
  private persist(pending: PendingFork | undefined) { this.cache.write(this.key, JSON.stringify(pending ?? null)); this.pending = pending; }
  setConnection(connected: boolean, supported: boolean) {
    if (connected === this.connected && supported === this.supported) return;
    this.connected = connected; this.supported = supported; this.generation++; this.readSequence++; this.loading = false; this.ready = false;
    this.publish();
  }
  get canStart() { return this.connected && this.supported && this.ready && !this.busy && !this.loading && !this.pending && !this.receiptError && Boolean(this.value); }
  get canResume() {
    const operation = this.value?.operation;
    return this.connected && this.supported && this.ready && !this.busy && !this.loading && !this.receiptError && Boolean(operation?.canResume && operation.state !== 'unknown' && operation.state !== 'complete'
      && (!this.pending || this.pending.operationId === operation.commandId));
  }

  async refresh() {
    if (!this.connected || !this.supported || !this.bridge.getSessionFork) return;
    const generation = this.generation, sequence = ++this.readSequence;
    const current = () => this.connected && generation === this.generation && sequence === this.readSequence;
    this.loading = true; this.ready = false; this.publish();
    try {
      const value = await this.bridge.getSessionFork(this.sessionId, this.hostId);
      if (!current()) return;
      if (value.version !== 1 || value.hostId !== this.hostId || value.sessionId !== this.sessionId || !value.revision) throw new Error('The fork response belongs to another host or chat.');
      this.value = value; this.ready = true;
      const operation = value.operation, pending = this.pending;
      if (pending && operation?.commandId === pending.operationId && operation.state === 'complete') {
        if (!identifier(operation.sessionId) || operation.sessionId === this.sessionId || !operation.sessionFile) throw new Error('The host has not provided a distinct bound fork.');
        const state = await this.bridge.getState(this.hostId);
        if (!current() || this.pending !== pending) return;
        if (state.host.id !== this.hostId) throw new Error('The fork catalog belongs to another host.');
        const child = state.sessions.find(session => session.id === operation.sessionId);
        if (!child || child.hostId !== this.hostId || child.sessionFile !== operation.sessionFile) throw new Error('The fork is not yet present in its owning host’s catalog.');
        this.bind(pending, child); this.error = this.receiptError;
      } else if (pending && operation && operation.commandId !== pending.operationId) {
        this.error = 'The host reports another fork operation. The original request is retained; inspect its receipt before forking again.';
      }
    } catch (cause) { if (current()) { this.ready = false; this.error = message(cause); } }
    finally { if (current()) { this.loading = false; this.publish(); } }
  }

  async start(execution: ForkExecution): Promise<SessionSummary | undefined> {
    if (!this.canStart || !this.value) return;
    const destination = execution.type === 'local' ? this.value.local : this.value.worktree;
    if (!destination.available) { this.error = destination.reason ?? 'This fork destination is unavailable.'; this.publish(); return; }
    try {
      const id = crypto.randomUUID();
      const pending: PendingFork = { operationId: id, envelope: { id, commandVersion: 16, command: {
        type: 'session.fork', sessionId: this.sessionId, expectedRevision: this.value.revision, execution,
      } } };
      this.persist(pending); await this.dispatch(pending);
      return this.child;
    } catch (cause) { this.error = message(cause); this.publish(); }
  }

  async resume(): Promise<SessionSummary | undefined> {
    const operation = this.value?.operation;
    if (!this.canResume || !operation) return;
    try {
      const pending: PendingFork = { operationId: operation.commandId, envelope: { id: crypto.randomUUID(), commandVersion: 16,
        command: { type: 'session.fork.resume', sessionId: this.sessionId, operationId: operation.commandId } } };
      this.persist(pending); await this.dispatch(pending);
      return this.child;
    } catch (cause) { this.error = message(cause); this.publish(); }
  }

  private bind(pending: PendingFork, child: SessionSummary) {
    if (child.hostId !== this.hostId || !identifier(child.id) || child.id === this.sessionId || !child.sessionFile) throw new Error('The host did not return a distinct fork on the owning host.');
    const current = this.pending;
    if (!current || current.operationId !== pending.operationId) return;
    if (current.bound && (current.bound.sessionId !== child.id || current.bound.sessionFile !== child.sessionFile)) throw new Error('The fork binding changed. The original receipt is retained.');
    this.persist({ ...current, bound: { sessionId: child.id, sessionFile: child.sessionFile } });
    this.child = child;
  }

  /** Called only by the still-owning route after the real child is available. */
  takeChild(): SessionSummary | undefined {
    if (!this.child || this.pending?.bound?.sessionId !== this.child.id) return;
    try {
      const child = this.child; this.persist(undefined); this.child = undefined; this.publish(); return child;
    } catch (cause) { this.error = message(cause); this.publish(); }
  }

  private async dispatch(pending: PendingFork) {
    this.busy = true; this.ready = false; this.error = undefined; this.readSequence++; this.loading = false; this.publish();
    try {
      const result = await this.bridge.command(pending.envelope, this.hostId);
      if (this.pending?.operationId !== pending.operationId) return;
      if (result.commandId !== pending.envelope.id) throw new Error('The fork command receipt does not match this request.');
      if (!result.ok) {
        if (this.pending.bound) return;
        if (result.error.code !== 'OUTCOME_UNKNOWN' && result.error.code !== 'ENVIRONMENT_OUTCOME_UNKNOWN') this.persist(undefined);
        throw new Error(result.error.message);
      }
      const receipt = result.value;
      if (!receipt || !('type' in receipt) || receipt.type !== 'session.forked' || receipt.commandId !== pending.operationId || receipt.sourceSessionId !== this.sessionId) throw new Error('The host did not confirm this fork operation.');
      this.bind(pending, receipt.session);
    } catch (cause) { this.error = message(cause); }
    finally { this.busy = false; this.publish(); }
  }
}
