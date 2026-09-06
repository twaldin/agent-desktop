import { useEffect, useReducer, useRef } from 'react';
import type { SessionSummary } from '../../../../packages/shared/src/protocol';
import type { DraftController } from './drafts';
import { BtwState } from './btw-state';
import { Icon } from './Icons';
import { MarkdownText } from './MarkdownText';
import './side-chat.css';

export function SideChat({ controller, hostId, session, sessionId, drafts, connected, active, onTitle, onUnread, onPromoted }: {
  controller: BtwState; hostId: string; sessionId: string; session?: SessionSummary;
  drafts: DraftController; connected: boolean; active: boolean; onTitle(title: string): void; onUnread(unread: boolean): void; onPromoted(session: SessionSummary): void;
}) {
  const [, redraw] = useReducer(value => value + 1, 0), textarea = useRef<HTMLTextAreaElement>(null), content = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  useEffect(() => { const off = controller.subscribe(redraw), offDrafts = drafts.subscribe(redraw); return () => { off(); offDrafts(); }; }, [controller, drafts]);
  useEffect(() => {
    if (!connected) return;
    let pending = false, alive = true;
    const read = async () => { if (pending || !alive) return; pending = true; try { await controller.refresh(); } finally { pending = false; } };
    void read(); const timer = setInterval(() => void read(), active ? 500 : 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [controller, connected, active]);
  useEffect(() => { if (active) textarea.current?.focus(); }, [active]);
  const view = drafts.get(controller.draftId, { projectId: session?.projectId ?? null });
  const snapshot = controller.value;
  useEffect(() => { onTitle(snapshot?.question.slice(0, 100) || 'Side chat'); }, [snapshot?.question]);
  useEffect(() => {
    const key = `btw.seen.${hostId}.${sessionId}`;
    if (active) {
      onUnread(false);
      if (snapshot?.status === 'complete') try { localStorage.setItem(key, snapshot.runId); } catch { /* Read markers are presentation-only. */ }
    } else if (snapshot?.status === 'complete') {
      let seen: string | null = null; try { seen = localStorage.getItem(key); } catch { /* A missing marker keeps the answer discoverable. */ }
      if (seen !== snapshot.runId) onUnread(true);
    }
  }, [active, snapshot?.runId, snapshot?.status]);
  useEffect(() => { if (nearBottom.current && content.current) content.current.scrollTop = content.current.scrollHeight; }, [snapshot?.answer, snapshot?.runId]);
  useEffect(() => { const promoted = controller.takePromotedSession(); if (promoted) onPromoted(promoted); });
  useEffect(() => { const field = textarea.current; if (field) { field.style.height = '0px'; field.style.height = `${Math.min(240, Math.max(56, field.scrollHeight))}px`; } }, [view.draft.text]);
  const running = snapshot?.status === 'running';
  const blocked = !connected || !controller.ready || !session || session.archived || controller.busy || Boolean(controller.pending) || Boolean(controller.unavailable) || view.status === 'conflict';
  const submit = () => { if (!blocked && !running) void controller.start(); };
  return <section className="side-chat" aria-label="Side chat" data-app-shortcuts="off">
    <div className="side-chat-content" ref={content} onScroll={event => { const node = event.currentTarget; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60; }}>
      {!snapshot ? <div className="side-chat-empty"><Icon name="sideChat"/><h2>Side chat</h2><p>Ask a side question using this conversation’s context.</p></div> : <div className="side-chat-transcript">
        <div className="side-chat-question">{snapshot.question}</div>
        {snapshot.answer && <MarkdownText text={snapshot.answer} blockKey={`btw:${hostId}:${sessionId}:${snapshot.runId}`}/>}
        {running && <div className="side-chat-working" role="status"><span/>Thinking…</div>}
        {snapshot.status === 'cancelled' && <p className="side-chat-notice">Stopped</p>}
        {snapshot.error && <p className="side-chat-notice" role="alert">{snapshot.error}</p>}
        {!running && snapshot.answer && <div className="side-chat-answer-actions"><button className="side-chat-copy" onClick={() => void navigator.clipboard.writeText(snapshot.answer).catch(() => { controller.error = 'Could not copy the answer.'; redraw(); })}>Copy</button>{snapshot.status === 'complete' && controller.promotionAvailable && <button className="side-chat-promote" disabled={!connected || !session || session.archived || !controller.ready || controller.busy || Boolean(controller.pending) || Boolean(controller.error) || Boolean(controller.unavailable) || Boolean(controller.receiptError) || snapshot.canPromote === false} onClick={() => void controller.promote()}>Fork chat from here</button>}</div>}
      </div>}
    </div>
    <div className="side-chat-footer">
      {(!connected || controller.error || controller.unavailable || controller.pending) && <div className="side-chat-notice" role="status"><span>{!connected ? 'Offline · your draft stays on this device until reconnected.' : controller.error || controller.unavailable || 'The previous request is awaiting confirmation.'}</span>{connected && <button disabled={controller.busy} onClick={() => void controller.refresh(true)}>Refresh</button>}</div>}
      {view.status === 'conflict' && <div className="side-chat-conflict" role="alert"><p>This side-chat draft changed on another device.</p><pre>{view.conflict?.text || '(Empty draft)'}</pre><button onClick={() => drafts.resolve(controller.draftId, 'local')}>Keep mine</button><button onClick={() => drafts.resolve(controller.draftId, 'remote')}>Use other draft</button></div>}
      {view.error && <p className="side-chat-notice" role="alert">{view.error}</p>}
      <form className="side-chat-composer" onSubmit={event => { event.preventDefault(); submit(); }}>
        <textarea ref={textarea} aria-label="Side chat prompt" placeholder="Ask a side question" value={view.draft.text} maxLength={32768} onChange={event => drafts.update(controller.draftId, { text: event.target.value })} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }}/>
        <div className="side-chat-controls"><span className="side-chat-context" title="Native OMP /btw uses the parent context and model. It answers without running tools or changing the main transcript.">No tools</span><span className="side-chat-model" title="Uses the main conversation’s native model and reasoning settings">{session?.model?.id || 'Parent model'}</span><button className="side-chat-send" type={running ? 'button' : 'submit'} aria-label={running ? 'Stop side chat' : 'Send side question'} disabled={blocked || (!running && !view.draft.text.trim())} onClick={running ? () => void controller.cancel() : undefined}><Icon name={running ? 'stop' : 'arrow'}/></button></div>
      </form>
    </div>
  </section>;
}
