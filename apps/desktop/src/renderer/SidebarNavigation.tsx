import * as Dialog from "@radix-ui/react-dialog";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { DEFAULT_SIDEBAR_NAVIGATION, reorderSidebarDestinations, resetSidebarNavigation, setSidebarDestinationHidden, sidebarNavigationLayout, type SidebarDestinationId } from "../../../../packages/shared/src/sidebar-navigation";
import type { SidebarNavigationState } from "./sidebar-navigation-state";
import { Icon } from "./Icons";
import { SidebarNavigationIcon } from "./SidebarNavigationIcon";
import { SidebarPinIcon } from "./sidebar-icons";
import "./sidebar-navigation.css";

export interface SidebarDestination { id: SidebarDestinationId; label: string; icon: ReactNode; current?: boolean; onSelect(): void }
interface Props { data?: SidebarNavigationState; destinations: SidebarDestination[]; onNew(): void; newShortcut?: string }
export function SidebarNavigation({ data, destinations, onNew, newShortcut }: Props) {
  const [customizing, setCustomizing] = useState(false);
  const [explore, setExplore] = useState(false);
  const [context, setContext] = useState<{ x: number; y: number }>();
  const [announcement, setAnnouncement] = useState("");
  const [drag, setDrag] = useState<{ id: SidebarDestinationId; order: SidebarDestinationId[]; keyboard: boolean }>();
  const nav = useRef<HTMLElement>(null), exploreButton = useRef<HTMLButtonElement>(null), done = useRef<HTMLButtonElement>(null);
  const [customizationContent, setCustomizationContent] = useState<HTMLDivElement | null>(null);
  const [customizationBounds, setCustomizationBounds] = useState<{ left: number; top: number; width: number; maxHeight: number }>();
  const [customizationHeight, setCustomizationHeight] = useState(0);
  const deferred = useRef<(() => void) | undefined>(undefined);
  const hoverOpen = useRef(false), hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  const value = data?.value ?? DEFAULT_SIDEBAR_NAVIGATION;
  const layout = sidebarNavigationLayout(value, destinations);
  const availableKey = destinations.map(item => item.id).join("|");
  const rows = drag ? drag.order.flatMap(id => { const item = destinations.find(item => item.id === id); return item ? [item] : []; }) : layout.ordered;
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  useEffect(() => { setDrag(undefined); }, [availableKey, data]);
  useEffect(() => { if (data && !data.writable) setDrag(undefined); }, [data?.writable]);
  useLayoutEffect(() => {
    if (drag?.keyboard) customizationContent?.querySelector<HTMLButtonElement>(`[data-sidebar-destination="${drag.id}"] .sidebar-reorder`)?.focus();
  }, [drag, customizationContent]);
  useLayoutEffect(() => {
    if (!customizing) return;
    const origin = nav.current?.querySelector<HTMLElement>(":scope > .nav-action"), content = customizationContent;
    if (!origin || !content) return;
    const measure = () => {
      const rect = origin.getBoundingClientRect(), width = Math.min(rect.width + 8, window.innerWidth - 8);
      const top = rect.bottom + 1, left = Math.max(4, Math.min(rect.left - 4, window.innerWidth - width - 4));
      setCustomizationBounds({ left, top, width, maxHeight: Math.max(30, window.innerHeight - top - 8) });
      setCustomizationHeight(content.getBoundingClientRect().height);
    };
    measure(); const resize = new ResizeObserver(measure); resize.observe(origin); resize.observe(content);
    window.addEventListener("resize", measure);
    return () => { resize.disconnect(); window.removeEventListener("resize", measure); };
  }, [customizing, customizationContent]);
  const closeCustomize = () => { setDrag(undefined); setCustomizing(false); requestAnimationFrame(() => exploreButton.current?.focus()); };
  const startCustomize = () => { setContext(undefined); setExplore(false); setCustomizing(true); };
  const saveVisibility = (item: SidebarDestination) => {
    if (!data?.writable || drag) return;
    void data.save(setSidebarDestinationHidden(value, item.id, !value.hidden.includes(item.id)));
  };
  const move = (over: SidebarDestinationId) => {
    if (!drag || drag.id === over) return;
    const order = [...drag.order], from = order.indexOf(drag.id), to = order.indexOf(over);
    if (from < 0 || to < 0) return;
    order.splice(from, 1); order.splice(to, 0, drag.id);
    setDrag({ ...drag, order });
    setAnnouncement(`${destinations.find(item => item.id === drag.id)?.label} moved to position ${to + 1} of ${order.length}`);
  };
  const drop = () => {
    if (!drag || !data?.writable) return;
    const next = reorderSidebarDestinations(value, drag.order);
    setAnnouncement(`${destinations.find(item => item.id === drag.id)?.label} dropped at position ${drag.order.indexOf(drag.id) + 1} of ${drag.order.length}`);
    setDrag(undefined);
    if (next.order.some((id, index) => id !== value.order[index])) void data.save(next);
  };
  const contextMenu = (x: number, y: number) => { setExplore(false); setContext({ x, y }); };
  const closeHover = () => { clearTimeout(hoverTimer.current); if (hoverOpen.current) hoverTimer.current = setTimeout(() => setExplore(false), 100); };
  return <nav ref={nav} className="sidebar-actions sidebar-navigation" aria-label="Main navigation" onContextMenu={event => { event.preventDefault(); contextMenu(event.clientX, event.clientY); }} onKeyDown={event => {
    if (event.key === "F10" && event.shiftKey) { event.preventDefault(); const rect = (event.target as HTMLElement).getBoundingClientRect(); contextMenu(rect.right, rect.top); }
  }}>
    <button className="nav-action" onClick={onNew}><SidebarNavigationIcon name="new-chat"/><span>New chat</span>{newShortcut && <kbd>{newShortcut}</kbd>}</button>
    {!customizing && layout.direct.map(item => <div className={`sidebar-navigation-row ${item.current ? "selected" : ""}`} key={item.id}>
      <button aria-label={item.label} className={`nav-action ${item.current ? "selected" : ""}`} aria-current={item.current ? "page" : undefined} onClick={item.onSelect}>{item.icon}<span>{item.label}</span></button>
      {value.hidden.includes(item.id) && <button className="sidebar-navigation-pin icon-button small" aria-label={`Pin ${item.label} to sidebar`} title="Pin to sidebar" disabled={!data?.writable} onClick={() => void data?.save(setSidebarDestinationHidden(reorderSidebarDestinations(value, [...layout.ordered.filter(row => row.id !== item.id).map(row => row.id), item.id]), item.id, false))}><SidebarPinIcon pinned={false}/></button>}
    </div>)}
    {customizing && <div aria-hidden="true" style={{ height: customizationHeight }}/>}
    <Dialog.Root open={customizing} onOpenChange={open => { if (!open) closeCustomize(); }}>
      {customizing && <Dialog.Portal><Dialog.Overlay className="sidebar-customization-overlay"/><Dialog.Content ref={setCustomizationContent} className="sidebar-customization" style={customizationBounds} aria-describedby={undefined} onOpenAutoFocus={event => { event.preventDefault(); done.current?.focus(); }} onCloseAutoFocus={event => { event.preventDefault(); exploreButton.current?.focus(); }} onEscapeKeyDown={event => {
        if (drag) { event.preventDefault(); const handle = customizationContent?.querySelector<HTMLButtonElement>(`[data-sidebar-destination="${drag.id}"] .sidebar-reorder`); setAnnouncement(`Reordering ${destinations.find(item => item.id === drag.id)?.label ?? drag.id} cancelled`); setDrag(undefined); requestAnimationFrame(() => handle?.focus()); }
      }}>
        <Dialog.Title className="sr-only">Customize sidebar</Dialog.Title>
        <div className="sidebar-customization-header"><span>Customize</span><button ref={done} aria-label="Finish customizing sidebar" onClick={closeCustomize}>Done</button></div>
        <p className="sr-only" id={`${id}-instructions`}>To reorder this sidebar item, press Space or Enter. Use the arrow keys to move it, press Space or Enter to drop it, or press Escape to cancel.</p>
        <div role="list" aria-label="Sidebar destinations">{rows.map(item => <div role="listitem" data-sidebar-destination={item.id} className={`sidebar-customization-row ${drag?.id === item.id ? "reordering" : ""}`} key={item.id} onDragOver={event => { if (drag && !drag.keyboard) { event.preventDefault(); move(item.id); } }} onDrop={event => { event.preventDefault(); drop(); }}>
          <button className="sidebar-visibility sidebar-destination-switch" role="checkbox" aria-label={item.label} aria-checked={!value.hidden.includes(item.id)} aria-disabled={!data?.writable || !!drag} onClick={() => saveVisibility(item)}><span className="sidebar-visibility-indicator" aria-hidden="true">{value.hidden.includes(item.id) ? "○" : "✓"}</span>{item.icon}<span>{item.label}</span></button>
          <button className="sidebar-reorder" aria-label={`Reorder ${item.label}`} aria-describedby={`${id}-instructions`} aria-pressed={drag?.id === item.id} draggable={Boolean(data?.writable)} aria-disabled={!data?.writable} onDragStart={event => { if (!data?.writable) { event.preventDefault(); return; } event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.id); setDrag({ id: item.id, order: layout.ordered.map(item => item.id), keyboard: false }); }} onDragEnd={() => setDrag(undefined)} onKeyDown={event => {
            if (!data?.writable) { if ([" ", "Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) event.preventDefault(); return; }
            if (event.key === " " || event.key === "Enter") { event.preventDefault(); if (drag) drop(); else { setDrag({ id: item.id, order: layout.ordered.map(item => item.id), keyboard: true }); setAnnouncement(`${item.label} picked up, position ${layout.ordered.indexOf(item) + 1} of ${layout.ordered.length}`); } }
            else if (drag?.id === item.id && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); const index = drag.order.indexOf(item.id), delta = event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1; const over = drag.order[index + delta]; if (over) move(over); }
          }}><svg aria-hidden="true" width="12" height="16" viewBox="0 0 12 16" fill="currentColor"><circle cx="4" cy="4" r="1"/><circle cx="8" cy="4" r="1"/><circle cx="4" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="8" cy="12" r="1"/></svg></button>
        </div>)}</div>
        <button className="sidebar-customization-reset" aria-disabled={!data?.writable || !!drag} onClick={() => { if (data?.writable && !drag) void data.save(resetSidebarNavigation(value, destinations.map(item => item.id))); }}>Reset customization</button>
        {(!data || data.unavailable) && <p className="sidebar-navigation-notice" role="status">{data?.unavailable ?? "Connect this device to a local host to customize the sidebar."}</p>}
        {data?.unsaved && <p className="sidebar-navigation-notice" role="status">{data.busy ? "Saving sidebar changes…" : "Sidebar changes are not yet saved."}{!data.busy && !data.error && <button disabled={!data.canRetry} onClick={() => void data.retry()}>Retry sidebar changes</button>}</p>}
        {data?.error && <div className="sidebar-navigation-notice" role="alert">{data.error}<button disabled={!data.canRetry} onClick={() => void data.retry()}>Retry sidebar changes</button></div>}
        {data?.canDiscard && <div className="sidebar-navigation-notice"><button className="sidebar-discard" onClick={() => { void data.discardUnsaved(); done.current?.focus(); }}>Discard unsaved sidebar changes</button>Original bytes are kept on this device.</div>}
        <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
      </Dialog.Content></Dialog.Portal>}
    </Dialog.Root>
    {!customizing && <Menu.Root modal={false} open={explore} onOpenChange={open => { clearTimeout(hoverTimer.current); setExplore(open); }}>
      <Menu.Trigger asChild><button ref={exploreButton} className="nav-action sidebar-explore" aria-label="Explore" onPointerDown={() => { hoverOpen.current = false; }} onKeyDown={() => { hoverOpen.current = false; }} onPointerEnter={event => {
        if (event.pointerType === "mouse") { clearTimeout(hoverTimer.current); hoverTimer.current = setTimeout(() => { hoverOpen.current = true; setExplore(true); }, 200); }
      }} onPointerLeave={closeHover}><Icon name="more"/><span>Explore</span></button></Menu.Trigger>
      <Menu.Portal><Menu.Content className="sidebar-navigation-menu" aria-label="Explore" side="right" align="start" alignOffset={-11} sideOffset={4} collisionPadding={8} onPointerEnter={() => clearTimeout(hoverTimer.current)} onPointerLeave={closeHover} onCloseAutoFocus={event => {
        const action = deferred.current; deferred.current = undefined;
        if (action) { event.preventDefault(); action(); } else if (hoverOpen.current) event.preventDefault();
      }}>
        {layout.more.map(item => <Menu.Item className="sidebar-navigation-menu-item" key={item.id} textValue={item.label} onSelect={item.onSelect}>{item.icon}<span>{item.label}</span></Menu.Item>)}
        {layout.more.length > 0 && <Menu.Separator className="sidebar-navigation-menu-separator"/>}
        <Menu.Item className="sidebar-navigation-menu-item" onSelect={() => { deferred.current = startCustomize; }}><Icon name="sliders"/><span>Customize</span></Menu.Item>
      </Menu.Content></Menu.Portal>
    </Menu.Root>}
    <Menu.Root modal={false} open={!!context} onOpenChange={open => { if (!open) setContext(undefined); }}><Menu.Trigger asChild><span aria-hidden="true" className="sidebar-navigation-context-anchor" style={{ left: context?.x, top: context?.y }}/></Menu.Trigger>
      <Menu.Portal><Menu.Content className="sidebar-navigation-menu" aria-label="Sidebar navigation options" side="right" sideOffset={0} align="start" collisionPadding={8} onCloseAutoFocus={event => { event.preventDefault(); const action = deferred.current; deferred.current = undefined; if (action) action(); else if (customizing) done.current?.focus(); else exploreButton.current?.focus(); }}>
        <Menu.Item className="sidebar-navigation-menu-item" disabled={customizing && (!data?.writable || !!drag)} onSelect={() => { deferred.current = customizing ? () => { void data?.save(resetSidebarNavigation(value, destinations.map(item => item.id))); done.current?.focus(); } : startCustomize; }}>{customizing ? "Reset customization" : "Customize"}</Menu.Item>
      </Menu.Content></Menu.Portal>
    </Menu.Root>
  </nav>;
}
