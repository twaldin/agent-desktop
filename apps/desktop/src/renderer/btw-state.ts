import type { CommandEnvelope, DesktopBridge, Draft, NativeBtwSnapshot, SessionSummary } from '../../../../packages/shared/src/protocol';
import { nativeBtwQuestion } from '../../../../packages/shared/src/btw';
import { DraftController, captureDraft, sameDraftContent, type DraftCache } from './drafts';

interface Pending { envelope: CommandEnvelope; draft?: Draft; promotedSession?: SessionSummary }
/** A lost acknowledgement keeps its original command identity across window
 * restarts. Refresh can recover that receipt; it never makes a replacement send. */
export class BtwState {
  value: NativeBtwSnapshot | null = null;
  error?: string;
  unavailable?: string;
  busy = false;
  ready = false;
  promotionAvailable = false;
  pending?: Pending;
  receiptError?: string;
  private promotedSession?: SessionSummary;
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
        } else if ((command.type !== 'session.btw.cancel' && command.type !== 'session.btw.promote')
          || typeof command.runId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(command.runId)) throw new Error('Invalid saved operation.');
        if (saved.draft && (command.type !== 'session.btw.start'
          || (command.nativeCommand === 'btw' ? saved.draft.id !== `session:${sessionId}` || nativeBtwQuestion(saved.draft.text) !== command.question.trim()
            : saved.draft.id !== this.draftId || saved.draft.text.trim() !== command.question.trim())
          || command.draft && (command.draft.id !== saved.draft.id || command.draft.revision !== saved.draft.revision))) throw new Error('Invalid captured draft.');
        if (saved.promotedSession && (command.type !== 'session.btw.promote' || saved.promotedSession.hostId !== hostId || !saved.promotedSession.id)) throw new Error('Invalid promoted session receipt.');
        this.pending = { envelope, ...(saved.draft ? { draft: captureDraft(saved.draft, hostId) } : {}),
          ...(saved.promotedSession ? { promotedSession: structuredClone(saved.promotedSession) } : {}) };
        if (this.pending.draft) this.drafts.beginPendingSubmission(this.pending.draft, envelope.id);
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
      this.value = result.value;
      this.promotionAvailable = result.promotion === true;
      this.unavailable = result.unavailable || (result.draftConsumption !== true ? 'Update the owning host to send side questions with saved drafts.' : undefined);
      this.ready = !this.unavailable && !this.receiptError;
      // A terminal native observation can settle a lost command response. An
      // admission-intent/failed snapshot alone cannot prove provider execution.
      if (this.pending && result.value && (result.value.status === 'complete' || result.value.status === 'cancelled')) {
        const command = this.pending.envelope.command;
        const runId = command.type === 'session.btw.start' ? this.pending.envelope.id : command.type === 'session.btw.cancel' ? command.runId : undefined;
        if (result.value.runId === runId && !(command.type === 'session.btw.start' && command.draft)) {
          const submitted = this.pending.draft;
          this.persist(undefined);
          if (submitted && sameDraftContent(this.drafts.get(this.draftId).draft, submitted)) this.drafts.update(this.draftId, { text: '' });
        }
      }
      if (!this.pending) this.error = this.receiptError;
    } catch (cause) { if (sequence === this.readSequence) { this.ready = false; this.error = cause instanceof Error ? cause.message : String(cause); } }
    if (sequence === this.readSequence) this.publish();
  }
  async start(captured?: Draft) {
    if (this.busy || this.pending || this.receiptError) return;
    const sourceId = captured?.id ?? this.draftId;
    const view = this.drafts.get(sourceId);
    if (!captured && (!view.draft.text.trim() || view.status === 'conflict')) return;
    this.busy = true; this.error = undefined; this.publish();
    let submitted: Draft | undefined;
    try {
      submitted = captured ? captureDraft(captured, this.hostId) : await this.drafts.prepareSubmission(this.draftId);
      const composer = sourceId === `session:${this.sessionId}`;
      if (!composer && sourceId !== this.draftId) throw new Error('The side question has a different draft owner.');
      if (submitted.wholeFileAttachments?.length || submitted.selectedTextAttachments?.length) throw new Error('Native /btw does not accept file context. The draft was retained.');
      if (submitted.attachments?.length) throw new Error('Native /btw does not accept images. The draft was retained.');
      const question = composer ? nativeBtwQuestion(submitted.text) : submitted.text.trim();
      if (!question) throw new Error('Usage: /btw <question>');
      const pending: Pending = { envelope: { id: crypto.randomUUID(), command: { type: 'session.btw.start', sessionId: this.sessionId, question,
        draft: { id: submitted.id, revision: submitted.revision }, ...(composer ? { nativeCommand: 'btw' as const } : {}) } }, draft: submitted };
      this.persist(pending);
      this.drafts.beginPendingSubmission(submitted, pending.envelope.id);
      this.busy = false;
      await this.dispatch(pending);
    } catch (cause) {
      if (submitted && !this.pending) this.drafts.finishSubmission(submitted.id, submitted, false);
      this.error = cause instanceof Error ? cause.message : String(cause);
    }
    finally { this.busy = false; this.publish(); }
  }
  async cancel() {
    if (this.busy || this.pending || this.receiptError || !this.value || this.value.status !== 'running') return;
    try {
      const pending: Pending = { envelope: { id: crypto.randomUUID(), command: { type: 'session.btw.cancel', sessionId: this.sessionId, runId: this.value.runId } } };
      this.persist(pending); await this.dispatch(pending);
    } catch (cause) { this.error = cause instanceof Error ? cause.message : String(cause); this.publish(); }
  }
  async promote() {
    if (this.busy || this.pending || this.receiptError || !this.ready || !this.promotionAvailable || !this.value
      || this.value.status !== 'complete' || this.value.canPromote === false) return;
    try {
      const pending: Pending = { envelope: { id: crypto.randomUUID(), command: {
        type: 'session.btw.promote', sessionId: this.sessionId, runId: this.value.runId,
      } } };
      this.persist(pending); await this.dispatch(pending);
    } catch (cause) { this.error = cause instanceof Error ? cause.message : String(cause); this.publish(); }
  }
  takePromotedSession(): SessionSummary | undefined {
    const session = this.promotedSession;
    if (session && this.pending?.promotedSession?.id === session.id) {
      try { this.persist(undefined); }
      catch (cause) { this.error = cause instanceof Error ? cause.message : String(cause); return undefined; }
    }
    this.promotedSession = undefined;
    return session;
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
      const command = pending.envelope.command;
      if (command.type === 'session.btw.promote') {
        if (!result.value || !('type' in result.value) || result.value.type !== 'session.btw.promote') throw new Error('The host did not confirm the native side-chat promotion.');
        if (result.value.session.hostId !== this.hostId || !result.value.session.id) throw new Error('The promoted conversation belongs to another host.');
        if (!result.value.cancelled && result.value.session.id === this.sessionId) throw new Error('The host did not return a distinct promoted conversation.');
        this.error = undefined;
        if (result.value.cancelled) this.persist(undefined);
        else {
          const completed = { ...pending, promotedSession: structuredClone(result.value.session) };
          this.persist(completed); this.promotedSession = completed.promotedSession;
        }
        return;
      }
      if (!result.value || !('type' in result.value) || result.value.type !== 'session.btw') throw new Error('The host did not confirm the native side-chat command.');
      const value = result.value.snapshot;
      const runId = command.type === 'session.btw.start' ? pending.envelope.id : command.type === 'session.btw.cancel' ? command.runId : undefined;
      if (!value || value.sessionId !== this.sessionId || value.runId !== runId) throw new Error('The native side-chat receipt has a different owner.');
      this.value = value; this.error = undefined;
      this.persist(undefined);
      if (pending.draft) {
        if (command.type === 'session.btw.start' && command.draft) this.drafts.finishSubmission(pending.draft.id, pending.draft, true, false, pending.envelope.id);
        else if (sameDraftContent(this.drafts.get(pending.draft.id).draft, pending.draft)) this.drafts.update(pending.draft.id, { text: '' });
      }
    } catch (cause) {
      if (pending.draft) this.drafts.finishSubmission(pending.draft.id, pending.draft, false, Boolean(this.pending), pending.envelope.id);
      this.error = cause instanceof Error ? cause.message : String(cause);
    }
    finally { this.busy = false; this.publish(); }
  }
}
