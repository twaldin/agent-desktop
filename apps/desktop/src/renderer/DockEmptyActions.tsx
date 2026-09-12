import { useLayoutEffect, useRef, useState } from "react";
import { SuggestedOutputRows, type SuggestedOutputRowsProps } from "./SuggestedOutputRows";
import { DockActionIcon } from "./DockActionIcon";
import type { DockAddAction } from "./DockPanel";
import type { DockDestination } from "./dock-state";
import "./dock-empty-actions.css";

export interface DockEmptyActionsProps {
  /** The shell's action catalogue, rendered in the supplied order. */
  actions: readonly DockAddAction[];
  destination: DockDestination;
  suggested?: SuggestedOutputRowsProps;
  /** Optional interception; the default activation is the action's own onSelect. */
  onSelect?(action: DockAddAction, destination: DockDestination): void;
}

/** The catalogue and activation owner are supplied by the shell, not inferred here. */
export function DockEmptyActions({ actions, destination, onSelect, suggested }: DockEmptyActionsProps) {
  const scroll = useRef<HTMLDivElement>(null), header = useRef<HTMLDivElement>(null), sentinel = useRef<HTMLDivElement>(null);
  const [shadow, setShadow] = useState(false);
  const hasSuggested = Boolean(suggested?.owner.snapshot?.outputs.length);
  useLayoutEffect(() => {
    if (!hasSuggested || !scroll.current || !header.current || !sentinel.current) { setShadow(false); return; }
    let observer: IntersectionObserver | undefined;
    const measure = () => {
      observer?.disconnect();
      observer = new IntersectionObserver(([entry]) => setShadow(!entry?.isIntersecting), { root: scroll.current, rootMargin: `-${Math.ceil(header.current!.getBoundingClientRect().height)}px 0px 0px 0px`, threshold: 0 });
      observer.observe(sentinel.current!);
    };
    const resize = new ResizeObserver(measure); resize.observe(header.current); measure();
    return () => { resize.disconnect(); observer?.disconnect(); };
  }, [hasSuggested]);
  // The source stays open with initial=false; it has no reachable enter/exit motion.
  // Static content also needs no alternate reduced-motion path.
  return <div ref={scroll} className={`dock-empty-panel-actions${hasSuggested ? " has-suggested" : ""}`} data-dock-empty-actions={destination}>
    <div className="dock-empty-panel-content">
      <div ref={header} className={`dock-empty-panel-header${shadow ? " has-scroll-shadow" : ""}`}>
        {actions.length
          ? <ul className="dock-empty-panel-list">
              {actions.map(action => <li key={action.id}>
                <button type="button" onClick={() => onSelect ? onSelect(action, destination) : action.onSelect(destination)}>
                  <span className="dock-empty-panel-icon"><DockActionIcon action={action}/></span>
                  <span className="dock-empty-panel-label">{action.label}</span>
                  {action.shortcut ? <span className="dock-empty-panel-shortcut"><kbd>{action.shortcut}</kbd></span> : null}
                </button>
              </li>)}
            </ul>
          : <div className="dock-empty-panel-note">No tabs are available for this chat</div>}
        {hasSuggested && <div className="dock-suggested-heading">Suggested</div>}
      </div>
      {!hasSuggested && suggested?.owner.error && <p role="alert" className="dock-suggested-message">{suggested.owner.error} <button type="button" disabled={!suggested.owner.enabled} onClick={() => void suggested.owner.read()}>Refresh outputs</button></p>}
      {hasSuggested && suggested && <><div ref={sentinel} className="dock-suggested-sentinel"/><SuggestedOutputRows {...suggested}/></>}
    </div>
  </div>;
}
