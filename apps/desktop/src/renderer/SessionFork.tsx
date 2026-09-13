import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { SessionForkSnapshot } from '../../../../packages/shared/src/session-fork';
import type { ForkExecution, SessionForkState } from './session-fork-state';
import './composer-autocomplete.css';
import './session-fork.css';

export interface SessionForkDestination { id: 'local' | 'worktree'; title: string; description: string; worktree: boolean; available: boolean; reason?: string; execution: ForkExecution }

/** Pinned bHr: local first; only eligible new-worktree destinations are offered. */
export function sessionForkDestinations(snapshot: SessionForkSnapshot): SessionForkDestination[] {
  const sameWorktree = snapshot.worktree.available && snapshot.local.isWorktree;
  const local: SessionForkDestination = { id: 'local', title: sameWorktree ? 'Fork chat in same worktree' : 'Fork chat',
    description: sameWorktree ? 'Fork this chat in the same worktree' : 'Fork this chat in the current workspace',
    worktree: snapshot.local.isWorktree, available: snapshot.local.available, reason: snapshot.local.reason, execution: { type: 'local' } };
  return snapshot.worktree.available ? [local, { id: 'worktree', title: 'Fork chat in new worktree', description: 'Fork this chat into an isolated worktree',
    worktree: true, available: true, execution: { type: 'worktree', startingState: { type: 'working-tree' } } }] : [local];
}

/** Scoped pinned gL laptop / Lp (initial T8o) fork glyphs, not the 16px Git branch. */
export function SessionForkIcon({ worktree = true }: { worktree?: boolean }) {
  return worktree ? <svg className="icon" aria-hidden="true" viewBox="0 0 20 20" fill="currentColor"><path d="M15.8 11.535c.367 0 .665.298.665.665v5a.665.665 0 0 1-.665.665h-5a.665.665 0 1 1 0-1.33h3.394l-3.565-3.564a.666.666 0 0 1 .942-.942l3.564 3.565V12.2c0-.367.298-.665.665-.665Zm0-9.4c.367 0 .665.298.665.665v5a.665.665 0 0 1-1.33 0V4.405l-5.128 5.128c-.323.324-.558.565-.842.74a2.668 2.668 0 0 1-.771.319c-.324.078-.662.073-1.12.073H1.93a.665.665 0 1 1 0-1.33h5.345c.52 0 .673-.005.809-.037.136-.033.266-.086.385-.16.12-.072.23-.177.598-.545l5.128-5.128H10.8a.665.665 0 0 1 0-1.33h5Z"/></svg>
    : <svg className="icon" aria-hidden="true" viewBox="0 0 21 21" fill="none"><path d="M18.2682 14.3617H13.2565L12.5641 14.7084C12.4718 14.7545 12.3695 14.7787 12.2663 14.7787H8.93329C8.83005 14.7787 8.72778 14.7545 8.63544 14.7084L7.94305 14.3617H2.92841V14.9467C2.92841 15.4999 3.37715 15.9486 3.93036 15.9486H17.2663C17.8195 15.9486 18.2682 15.4999 18.2682 14.9467V14.3617ZM17.4352 6.78064C17.4352 6.30296 17.4347 5.98418 17.4147 5.73962C17.4002 5.56206 17.3766 5.45678 17.3513 5.38611L17.3259 5.32556C17.2538 5.18414 17.1494 5.06256 17.0222 4.97009L16.8884 4.88806C16.8195 4.85296 16.7101 4.81854 16.4733 4.79919C16.2288 4.77924 15.9107 4.77869 15.4333 4.77869H5.7663C5.2889 4.77869 4.97075 4.77924 4.72626 4.79919C4.54907 4.81367 4.44343 4.83642 4.37274 4.86169L4.31219 4.88806C4.17098 4.96002 4.04914 5.06385 3.95673 5.1908L3.87372 5.32556C3.83865 5.39444 3.80517 5.50312 3.78583 5.73962C3.76585 5.98418 3.76532 6.30296 3.76532 6.78064V13.0316H8.10028L8.17645 13.0365C8.25305 13.0454 8.32783 13.0673 8.39716 13.1019L9.08954 13.4486H12.11L12.8024 13.1019L12.8737 13.0717C12.946 13.0455 13.023 13.0316 13.1003 13.0316H17.4352V6.78064ZM18.7653 13.0316H18.9333C19.3004 13.0317 19.5982 13.3296 19.5983 13.6967V14.9467C19.5983 16.2344 18.554 17.2787 17.2663 17.2787H3.93036C2.64261 17.2787 1.59833 16.2344 1.59833 14.9467V13.6967L1.612 13.5629C1.67405 13.2599 1.94205 13.0316 2.26337 13.0316H2.43524V6.78064C2.43524 6.3249 2.43422 5.94251 2.45966 5.63123C2.48573 5.31234 2.54269 5.00955 2.68915 4.72205L2.77899 4.56091C3.003 4.19579 3.32393 3.89808 3.7077 3.70251L3.8161 3.65173C4.07126 3.54227 4.33858 3.49682 4.61786 3.474C4.92907 3.44858 5.31072 3.44861 5.7663 3.44861H15.4333C15.8889 3.44861 16.2705 3.44859 16.5817 3.474C16.9008 3.50007 17.2043 3.55596 17.4919 3.70251L17.652 3.79236C18.0175 4.0164 18.3148 4.33802 18.5104 4.72205L18.5612 4.83044C18.6706 5.08544 18.7171 5.35214 18.7399 5.63123C18.7654 5.94251 18.7653 6.3249 18.7653 6.78064V13.0316Z" fill="currentColor"/></svg>;
}

export interface SessionForkMenuRequest { anchor: HTMLElement; restoreFocus(): void }
export function SessionFork({ data, request, onClose, onSelect, onResume, onOpenChild }: {
  data: SessionForkState; request?: SessionForkMenuRequest; onClose(restore: boolean): void;
  onSelect(execution: ForkExecution): void; onResume(): void; onOpenChild(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>();
  const close = useRef(onClose); close.current = onClose;
  useLayoutEffect(() => {
    if (!request) return;
    const measure = () => {
      const box = request.anchor.getBoundingClientRect(), width = Math.min(360, innerWidth - 24);
      const above = box.top > innerHeight / 2;
      setPosition({ width, left: Math.max(12, Math.min(box.left, innerWidth - width - 12)),
        ...(above ? { bottom: innerHeight - box.top + 8, maxHeight: Math.min(320, box.top - 20) }
          : { top: box.bottom + 8, maxHeight: Math.min(320, innerHeight - box.bottom - 20) }) });
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(request.anchor);
    window.addEventListener('resize', measure); window.addEventListener('scroll', measure, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [request]);
  useEffect(() => {
    if (!request || !position) return;
    const frame = requestAnimationFrame(() => (menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu.current)?.focus({ preventScroll: true }));
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !request.anchor.contains(event.target as Node)) close.current(false); };
    window.addEventListener('pointerdown', outside);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('pointerdown', outside); };
  }, [request, Boolean(position)]);
  function key(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(true); return; }
    if (event.key === 'Tab') { onClose(false); return; }
    // Pinned F7i owns Enter on keydown; do not depend on a later native char event.
    if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[role="menuitem"]') : null;
      if (!button || button.disabled || !menu.current?.contains(button)) return;
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) button.click();
      return;
    }
    const macMove = /Mac|iPhone|iPad|iPod/.test(navigator.platform) && event.ctrlKey && (event.key === 'n' || event.key === 'p');
    if (event.metaKey || event.altKey || (event.ctrlKey && !macMove) || !(['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || macMove)) return;
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (!buttons.length) return;
    event.preventDefault(); event.stopPropagation();
    const index = buttons.indexOf(event.target as HTMLButtonElement), backwards = event.key === 'ArrowUp' || macMove && event.key === 'p';
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (backwards ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next]?.focus({ preventScroll: true });
  }
  const operation = data.value?.operation && (!data.pending || data.value.operation.commandId === data.pending.operationId) ? data.value.operation : undefined;
  const unsettled = data.pending || data.busy || operation && operation.state !== 'complete';
  return <>
    {(unsettled || data.error || data.child) && <section className="session-fork-status" aria-label="Fork status" role={data.error || operation?.state === 'unknown' ? 'alert' : 'status'}>
      <span>{data.child ? 'Chat forked.' : data.error || operation?.error || (operation?.state === 'unknown' ? 'The fork outcome is unknown. Inspect its retained operation before taking another action.'
        : operation?.execution.type === 'worktree' ? `Preparing fork in a new worktree · ${operation.state}` : data.busy ? 'Forking chat…' : 'The fork request is awaiting confirmation. It will not be repeated.')}</span>
      {operation?.worktreePath && <code>{operation.worktreePath}</code>}
      {data.child ? <button type="button" disabled={!data.connected} onClick={onOpenChild}>Open forked chat</button> : <button type="button" disabled={!data.connected || !data.supported || data.busy || data.loading} onClick={() => void data.refresh()}>Refresh fork status</button>}
      {data.canResume && <button type="button" onClick={onResume}>Resume fork preparation</button>}
    </section>}
    {request && position && createPortal(<div ref={menu} role="menu" tabIndex={-1} aria-label="Fork chat" className="composer-autocomplete session-fork-menu" style={position} onKeyDown={key}>
      {data.value ? sessionForkDestinations(data.value).map(item => <button key={item.id} type="button" role="menuitem" className="composer-autocomplete-row" disabled={!data.canStart || !item.available}
        title={item.reason ?? item.description} onClick={() => onSelect(item.execution)}><SessionForkIcon worktree={item.worktree}/><span className="session-fork-row-content"><span className="completion-label">{item.title}</span><span className="completion-description">{item.reason ?? item.description}</span></span></button>)
        : <div className="composer-autocomplete-status" role="status">{data.error || 'Loading fork destinations…'}</div>}
      {!data.connected && <div className="composer-autocomplete-status" role="status">Reconnect to the owning host before forking.</div>}
    </div>, document.body)}
  </>;
}
