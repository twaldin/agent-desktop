import type { CommandEnvelope, DesktopBridge, Draft, NativeBtwSnapshot } from '../../../../packages/shared/src/protocol';
import { DraftController, captureDraft, sameDraftContent, type DraftCache } from './drafts';

interface Pending { envelope: CommandEnvelope; draft?: Draft }
/** A lost acknowledgement keeps its original command identity across window
 * restarts. Refresh can recover that receipt; it never makes a replacement send. */
export class BtwState {
  value: NativeBtwSnapshot | null = null;
  error?: string;
  unavailable?: string;
  busy = false;
  ready = false;
  pending?: Pending;
  receiptError?: string;
  private listeners = new Set<() => void>();
  private readSequence = 0;
  readonly draftId: string;
  private key: string;
  constructor(private bridge: DesktopBridge, readonly hostId: string, readonly sessionId: string, readonly drafts: DraftController, private cache: DraftCache) {
    this.draftId = `btw:${sessionId}`;
    this.key = `btw.pending.${hostId}.${sessionId}`;
    try {
      const saved = JSON.parse(cache.read(this.key) || 'null') as Pending | null;
      if (saved !== null) {
        const envelope = saved.envelope, command = envelope?.command;
        if (!envelope || typeof envelope.id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(envelope.id) || !command || !('sessionId' in command) || command.sessionId !== sessionId) throw new Error('Invalid receipt owner.');
        if (command.type === 'session.btw.start') {
          if (typeof command.question !== 'string' || !command.question.trim() || new TextEncoder().encode(command.question).byteLength > 32768) throw new Error('Invalid saved question.');
        } else if (command.type !== 'session.btw.cancel' || typeof command.runId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(command.runId)) throw new Error('Invalid saved operation.');
        if (saved.draft && (command.type !== 'session.btw.start' || saved.draft.id !== this.draftId || saved.draft.text !== command.question)) throw new Error('Invalid captured draft.');
        this.pending = { envelope, ...(saved.draft ? { draft: captureDraft(saved.draft, hostId) } : {}) };
      }
    } catch { this.receiptError = this.error = 'The saved side-chat receipt could not be read. Sending is disabled to avoid repeating an unconfirmed request.'; }
  }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private publish() { for (const listener of this.listeners) listener(); }
  private persist(pending: Pending | undefined) { this.cache.write(this.key, JSON.stringify(pending ?? null)); this.pending = pending; }
  async refresh(recover = false) {
    if (recover && this.pending && !this.busy) await this.dispatch(this.pending);
    if (!this.bridge.getBtw) { this.ready = false; this.unavailable = 'Update this desktop to use native side chat.'; this.publish(); return; }
    const sequence = ++this.readSequence;
    try {
      const result = await this.bridge.getBtw(this.sessionId, this.hostId);
      if (result.protocolVersion !== 1 || result.hostId !== this.hostId || result.sessionId !== this.sessionId || (result.value && result.value.sessionId !== this.sessionId)) throw new Error('The side-chat response belongs to another session.');
      if (sequence !== this.readSequence) return;
      this.value = result.value; this.unavailable = result.unavailable; this.ready = !result.unavailable && !this.receiptError;
      // A terminal native observation can settle a lost command response. An
      // admission-intent/failed snapshot alone cannot prove provider execution.
      if (this.pending && result.value && (result.value.status === 'complete' || result.value.status === 'cancelled')) {
        const command = this.pending.envelope.command;
        const runId = command.type === 'session.btw.start' ? this.pending.envelope.id : command.type === 'session.btw.cancel' ? command.runId : undefined;
        if (result.value.runId === runId) {
          const submitted = this.pending.draft;
          this.persist(undefined);
          if (submitted && sameDraftContent(this.drafts.get(this.draftId).draft, submitted)) this.drafts.update(this.draftId, { text: '' });
        }
      }
      if (!this.pending) this.error = this.receiptError;
    } catch (cause) { if (sequence === this.readSequence) { this.ready = false; this.error = cause instanceof Error ? cause.message : String(cause); } }
    if (sequence === this.readSequence) this.publish();
  }
  async start() {
    if (this.busy || this.pending || this.receiptError) return;
    const view = this.drafts.get(this.draftId);
    if (!view.draft.text.trim() || view.status === 'conflict') return;
    this.busy = true; this.error = undefined; this.publish();
    try {
      const submitted = structuredClone(view.draft);
      await this.drafts.flush(this.draftId);
      // Only the text present at Send is submitted; new typing remains a draft.
      const pending: Pending = { envelope: { id: crypto.randomUUID(), command: { type: 'session.btw.start', sessionId: this.sessionId, question: submitted.text } }, draft: submitted };
      this.persist(pending);
      this.busy = false;
      await this.dispatch(pending);
    } catch (cause) { this.error = cause instanceof Error ? cause.message : String(cause); }
    finally { this.busy = false; this.publish(); }
  }
  async cancel() {
    if (this.busy || this.pending || this.receiptError || !this.value || this.value.status !== 'running') return;
    try {
      const pending: Pending = { envelope: { id: crypto.randomUUID(), command: { type: 'session.btw.cancel', sessionId: this.sessionId, runId: this.value.runId } } };
      this.persist(pending); await this.dispatch(pending);
    } catch (cause) { this.error = cause instanceof Error ? cause.message : String(cause); this.publish(); }
  }
  private async dispatch(pending: Pending) {
    this.busy = true; this.readSequence++; this.publish();
    try {
      const result = await this.bridge.command(pending.envelope, this.hostId);
      if (result.commandId !== pending.envelope.id) throw new Error('The side-chat command receipt does not match this request.');
      if (!result.ok) {
        if (result.error.code === 'OUTCOME_UNKNOWN') throw new Error(result.error.message);
        this.persist(undefined); throw new Error(result.error.message);
      }
      if (!result.value || !('type' in result.value) || result.value.type !== 'session.btw') throw new Error('The host did not confirm the native side-chat command.');
      const value = result.value.snapshot;
      const command = pending.envelope.command;
      const runId = command.type === 'session.btw.start' ? pending.envelope.id : command.type === 'session.btw.cancel' ? command.runId : undefined;
      if (!value || value.sessionId !== this.sessionId || value.runId !== runId) throw new Error('The native side-chat receipt has a different owner.');
      this.value = value; this.error = undefined;
      this.persist(undefined);
      if (pending.draft && sameDraftContent(this.drafts.get(this.draftId).draft, pending.draft)) this.drafts.update(this.draftId, { text: '' });
    } catch (cause) { this.error = cause instanceof Error ? cause.message : String(cause); }
    finally { this.busy = false; this.publish(); }
  }
}
