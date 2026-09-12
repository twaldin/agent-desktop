import type { TerminalPreparation } from "./use-workbench-dock";
import type { BrowserReplacementOrigin } from "./browser-workspace-replacement";
import { useTaskPaneDrag } from "./use-task-pane-drag";
import { resolveContentSide, resizeDockFromPointer, resizeDockFromKey } from "./content-side-placement";
import { readTaskLayoutActivation, type TaskLayoutActivation } from "./main-task-targets";
import { createPortal } from "react-dom";
import { dockStripFocusTarget } from "./dock-strip-navigation";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icons";
import { DockTabIcon } from "./DockTabIcon";
import { DockActionIcon } from "./DockActionIcon";
import { activateDockTab, closeDockTab, hideDock, moveDockTab, otherDock, reorderDockTab, type DockDestination, type DockState, type DockTab, type DockViewport } from "./dock-state";
import "./dock-panel.css";

export type DockDragTask = DockTab | "chat";
export interface DockAddAction {
  /** Shared address-menu preparation; ordinary add menus still use onSelect. */
  prepare?(signal: AbortSignal, origin?: BrowserReplacementOrigin): Promise<TerminalPreparation>;
  /** Exact owner captured by prepare; required for address-menu acquisition. */
  preparationTarget?: { hostId: string; target: DockTab["target"] };
  /** Local descriptor preparation can remain available with cached/offline state. */
  requiresConnection?: boolean;
  singletonTabId?: string;
  id: string; label: string; icon: "compose" | "terminal" | "folder" | "sideChat" | "globe"; shortcut?: string; deferSelectionUntilDropdownClose?: boolean; onSelect(destination: DockDestination): void }
export interface DockLeadingTab { id: string; panelId: string; title: string; selected: boolean; shortcutHint?: string; onContextMenu?: React.MouseEventHandler<HTMLButtonElement>; onSelect(): void }
export interface DockPanelProps { presentationIds?: ReadonlyMap<string, string>; dragEnabled?:boolean; dragOwner?:string; shortcutHints?: ReadonlyMap<string,string>; leadingTab?: DockLeadingTab; stripContainer?: HTMLElement | null; stripStart?: ReactNode; stripActions?: ReactNode; onEmpty?(destination: DockDestination): void; onStripContextMenu?: React.MouseEventHandler<HTMLElement>;  destination: DockDestination; state: DockState; tabs: readonly DockTab[]; viewport: DockViewport; renderTab(tab: DockTab, active: boolean): ReactNode; onChange(state: DockState): void; onBeforeClose?(tab: DockTab): Promise<boolean>; onPinTab?(tabId:string):void; onTabContextMenu?(event:React.MouseEvent<HTMLButtonElement>,tab:DockTab):void; onTabDrop?(tabId: string, from: DockDestination, to: DockDestination, index: number): void; onPaneDrag?(task:DockDragTask,point:{clientX:number;clientY:number}):void; onPaneDrop?(task:DockDragTask,point:{clientX:number;clientY:number}):void; onPaneDragEnd?():void; onHide?(): void; onSwapSides?(): void; layoutAction?: {label:"Fullscreen"|"Restore split"; onSelect(activation?:TaskLayoutActivation):void}; addActions?: readonly DockAddAction[];
  /** Strip-end Close button. The shell turns it off where a window-pinned toggle already closes the dock. */
  closeable?: boolean }
export function DockPanel({ presentationIds, dragEnabled = true, dragOwner, shortcutHints, leadingTab, stripContainer, stripStart, stripActions, onEmpty, onStripContextMenu, destination, state, tabs, viewport, renderTab, onChange, onBeforeClose, onPinTab, onTabContextMenu, onTabDrop, onPaneDrag, onPaneDrop, onPaneDragEnd, onHide, onSwapSides, layoutAction, addActions = [], closeable = true }: DockPanelProps) {
  const region = state[destination], panelId = useId(), strip = useRef<HTMLDivElement>(null), resize = useRef<{ pointer: number; start: DockState } | undefined>(undefined);
  const latest = useRef({ state, tabs, onChange, onBeforeClose, onEmpty, onPaneDragEnd }); latest.current = { state, tabs, onChange, onBeforeClose, onEmpty, onPaneDragEnd };
  const closingIds = useRef(new Set<string>()), [closing, setClosing] = useState<Set<string>>(() => new Set());
  const mounted = useRef(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const deferredSelection = useRef<(() => void) | null>(null);
  const changeAddMenuOpen = (open: boolean) => {
    // Preserve the former named-details group when opening the portaled menu.
    if (open) document.querySelectorAll<HTMLDetailsElement>('details[name="workbench-panel-menu"][open]').forEach(menu => { menu.open = false; });
    setAddMenuOpen(open);
  };
  useEffect(() => { if ((!region.open && !leadingTab) || addActions.length === 0) setAddMenuOpen(false); }, [region.open, Boolean(leadingTab), addActions.length]);
  const ordered = region.tabIds.flatMap(id => { const tab = tabs.find(item => item.id === id); return tab ? [tab] : []; });
  const publish = (next: DockState) => { if (next !== state) onChange(next); };
  const focus = (id: string | undefined) => requestAnimationFrame(() => strip.current?.querySelector<HTMLButtonElement>(`[data-dock-tab-id="${CSS.escape(id ?? "")}"]`)?.focus());
  const select = (id: string) => { if (leadingTab?.id === id) leadingTab.onSelect(); else publish(activateDockTab(state, destination, id)); };
  const activeId = leadingTab?.selected ? leadingTab.id : region.activeTabId;
  const stripIds = [...(leadingTab ? [leadingTab.id] : []), ...ordered.map(tab => tab.id)];
  useEffect(() => {
    if (!region.open || !ordered.some(tab => tab.id === activeId && (tab.kind === "file" || tab.kind === "files"))) return;
    const header = strip.current;
    const pill = header?.querySelector<HTMLButtonElement>(`[data-dock-tab-id="${CSS.escape(activeId!)}"]`)?.parentElement;
    const scroller = header?.querySelector<HTMLElement>(".dock-tabs");
    if (!header || !pill || !scroller) return;
    // Keep the active file and its close control reachable without stealing editor/tree focus.
    const end = pill.querySelector<HTMLElement>(".dock-tab-close") ?? pill;
    const reveal = () => {
      const bounds = scroller.getBoundingClientRect(), close = end.getBoundingClientRect(), tab = pill.getBoundingClientRect();
      if (close.right > bounds.right) scroller.scrollLeft += close.right - bounds.right;
      else if (tab.width <= bounds.width && tab.left < bounds.left) scroller.scrollLeft += tab.left - bounds.left;
    };
    reveal();
    const frame = requestAnimationFrame(reveal);
    const observer = new ResizeObserver(reveal);
    observer.observe(scroller);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [activeId, region.open, region.tabIds, tabs, stripContainer]);
  const pinFromContent = (event: React.SyntheticEvent, tab: DockTab) => {
    if (!region.open || region.activeTabId !== tab.id || !tab.preview || event.nativeEvent.composedPath().some(node => node instanceof Element && node.hasAttribute("data-tab-preview-pin-exempt"))) return;
    onPinTab?.(tab.id);
  };
  const closeCurrent = (id: string) => {
    if (!mounted.current) return;
    const current = latest.current.state;
    const currentDestination = current.right.tabIds.includes(id) ? "right" : current.bottom.tabIds.includes(id) ? "bottom" : undefined;
    if (!currentDestination) return;
    const next = closeDockTab(current, currentDestination, id);
    latest.current.onChange(next);
    const nextId = next[currentDestination].activeTabId;
    if (!next[currentDestination].tabIds.length) latest.current.onEmpty?.(currentDestination);
    requestAnimationFrame(() => { if (mounted.current) document.querySelector<HTMLButtonElement>(`[data-dock-tab-id="${CSS.escape(nextId ?? "")}"]`)?.focus(); });
  };
  const close = (id: string) => {
    if (closingIds.current.has(id)) return;
    const tab = latest.current.tabs.find(item => item.id === id);
    if (!tab) return;
    const before = latest.current.onBeforeClose;
    if (!before) { closeCurrent(id); return; }
    closingIds.current.add(id); setClosing(previous => new Set(previous).add(id));
    void before(tab).then(allowed => { if (allowed) closeCurrent(id); }, () => {}).finally(() => {
      closingIds.current.delete(id);
      if (mounted.current) setClosing(previous => { const next = new Set(previous); next.delete(id); return next; });
    });
  };
  const dropIndex = (root: HTMLElement, id: string, clientX: number) => { const pills = [...root.querySelectorAll<HTMLElement>("[data-dock-content-tab]")].filter(item => item.dataset.dockTabId !== id); const rtl=root.ownerDocument.documentElement.dir === "rtl"; const index = pills.findIndex(item => { const bounds=item.getBoundingClientRect(); return rtl ? clientX > bounds.left + bounds.width/2 : clientX < bounds.left + bounds.width/2; }); return index < 0 ? pills.length : index; };
  const paneDrag=useTaskPaneDrag<DockDragTask>({owner:`${destination}:${dragOwner ?? leadingTab?.id ?? "content"}`,enabled:dragEnabled && (region.open || Boolean(leadingTab)),
    onMove:(task,point)=>onPaneDrag?.(task,point),onEnd:()=>latest.current.onPaneDragEnd?.(),
    onDrop:(task,point,element)=>{
      const target=element.ownerDocument.elementFromPoint(point.clientX,point.clientY)?.closest<HTMLElement>(".dock-strip[data-dock-destination]");
      const to=target?.dataset.dockDestination;
      if(task!=="chat" && target && (to==="right" || to==="bottom")) {
        const at=dropIndex(target,task.id,point.clientX);
        if(onTabDrop) onTabDrop(task.id,destination,to,at);
        else if(to===destination) publish(reorderDockTab(state,destination,task.id,at));
      } else if(onPaneDrop) onPaneDrop(task,point);
      else if(task!=="chat") {
        const root=element.ownerDocument.elementFromPoint(point.clientX,point.clientY)?.closest<HTMLElement>("[data-dock-destination]");
        const to=root?.dataset.dockDestination;
        if(root && (to==="right" || to==="bottom") && onTabDrop) onTabDrop(task.id,destination,to,dropIndex(root,task.id,point.clientX));
      }
    },
  });
  const keydown = (event: React.KeyboardEvent<HTMLButtonElement>, id: string) => {
    const content = ordered.some(tab => tab.id === id);
    if (event.key === "Delete" && content) { event.preventDefault(); close(id); return; }
    if ((event.altKey || event.ctrlKey) && event.key === "ArrowDown" && content) { event.preventDefault(); publish(moveDockTab(state,id,otherDock(destination))); return; }
    const next = dockStripFocusTarget(stripIds,id,event.key,event.currentTarget.ownerDocument.documentElement.dir === "rtl" ? "rtl" : "ltr");
    if (next) { event.preventDefault(); select(next); focus(next); }
  };
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => { resize.current = { pointer: event.pointerId, start: state }; try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic and canceled pointers still restore through the state model. */ } };
  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => { if (resize.current?.pointer === event.pointerId) publish(resizeDockFromPointer(state,destination,viewport,event)); };
  const endResize = (event: React.PointerEvent<HTMLDivElement>) => { if (resize.current?.pointer === event.pointerId) resize.current = undefined; };
  const resizeKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && resize.current) { event.preventDefault(); publish(resize.current.start); resize.current = undefined; return; }
    const next=resizeDockFromKey(state,destination,viewport,event.key);
    if(next) {event.preventDefault();publish(next);}
  };
  useEffect(() => { const cancel = (event: KeyboardEvent) => { if (event.key !== "Escape") return; if (resize.current) { publish(resize.current.start); resize.current = undefined; } }; addEventListener("keydown", cancel); return () => removeEventListener("keydown", cancel); });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const tabStrip = (
    <header className="dock-strip" ref={strip} onContextMenu={onStripContextMenu} data-app-shell-tab-strip-controller={destination} data-dock-destination={destination} role="tablist" aria-label={leadingTab ? "Task tabs" : `${destination} dock tabs`}>
      {stripStart}
      <div className="dock-tabs">{leadingTab && <div className={`dock-pill dock-chat-pill ${leadingTab.selected ? "active" : ""}`}><button id={leadingTab.id} data-main-task-chat-tab data-dock-tab-id={leadingTab.id} role="tab" aria-selected={leadingTab.selected} aria-controls={leadingTab.panelId} tabIndex={leadingTab.selected ? 0 : -1}  {...paneDrag.handlers("chat",ordered.length>0)} onClick={event => {if(!paneDrag.consumeClick(event)) leadingTab.onSelect();}} onContextMenu={leadingTab.onContextMenu} onKeyDown={event => keydown(event,leadingTab.id)}><Icon name="sideChat"/><span>{leadingTab.title}</span>{leadingTab.shortcutHint && <span className="task-shortcut-hint" data-tab-shortcut-hint aria-hidden="true"><kbd>{leadingTab.shortcutHint}</kbd></span>}</button></div>}{ordered.map(tab => <div className={`dock-pill ${tab.preview ? "preview" : ""} ${activeId === tab.id ? "active" : ""}`} key={presentationIds?.get(tab.id) ?? tab.id} draggable={false}>
        <button id={`${panelId}-${tab.id}`} data-dock-tab-id={tab.id} data-dock-content-tab title={tab.kind === "file" ? tab.filePath : undefined} {...paneDrag.handlers(tab)} role="tab" aria-selected={activeId === tab.id} aria-controls={`${panelId}-panel-${tab.id}`} tabIndex={activeId === tab.id ? 0 : -1} onClick={event => {if(!paneDrag.consumeClick(event)) select(tab.id);}} onContextMenu={event=>onTabContextMenu?.(event,tab)} onDoubleClick={() => onPinTab?.(tab.id)} onKeyDown={event => keydown(event, tab.id)} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); close(tab.id); } }}><DockTabIcon tab={tab}/><span>{tab.title}</span>{shortcutHints?.get(tab.id) && <span className="task-shortcut-hint" data-tab-shortcut-hint aria-hidden="true"><kbd>{shortcutHints.get(tab.id)}</kbd></span>}{tab.unread && <i className="dock-unread" aria-label="Unread side-chat answer"/>}</button><button className="dock-tab-close" data-app-shell-tab-close-button aria-label={`Close ${tab.title} tab`} disabled={closing.has(tab.id)} onPointerDown={event => event.stopPropagation()} onClick={() => close(tab.id)}><Icon name="close"/></button>
      </div>)}</div>
      {addActions.length > 0 && <DropdownMenu.Root modal={false} open={addMenuOpen} onOpenChange={changeAddMenuOpen}>
        <DropdownMenu.Trigger asChild><button type="button" className="dock-add-trigger" aria-label={`Open ${destination === "right" ? "side" : "bottom"} panel tab`} title="Add panel tab"><Icon name="plus"/></button></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content className="dock-add-menu" data-menu-destination={destination} aria-label={`Open ${destination === "right" ? "side" : "bottom"} panel tab`} side="bottom" align="start" sideOffset={1} collisionPadding={6} loop={false} onCloseAutoFocus={event => {
          // Files and Browser open their own focus surface after the menu relinquishes focus.
          const select = deferredSelection.current;
          deferredSelection.current = null;
          if (select) { event.preventDefault(); select(); }
        }}>
          {addActions.map(action => <DropdownMenu.Item className="dock-add-item" key={action.id} textValue={action.label} onSelect={() => {
            if (action.deferSelectionUntilDropdownClose) deferredSelection.current = () => action.onSelect(destination);
            else action.onSelect(destination);
          }}><DockActionIcon action={action}/><span>{action.label}</span>{action.shortcut && <kbd>{action.shortcut}</kbd>}</DropdownMenu.Item>)}
        </DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root>}

      <div className="dock-strip-trailing">
        {stripActions}
        {(region.activeTabId || layoutAction) && <details className="dock-menu" name="workbench-panel-menu"><summary aria-label="Dock options" title="Dock options"><Icon name="more"/></summary><div>{region.activeTabId && <button onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); publish(moveDockTab(state, region.activeTabId!, otherDock(destination))); }}>Move to {otherDock(destination)} dock</button>}{layoutAction && <button onClick={event => { const activation=readTaskLayoutActivation(event); event.currentTarget.closest("details")?.removeAttribute("open"); layoutAction.onSelect(activation); }}>{layoutAction.label}</button>}</div></details>}
        {closeable && <button className="dock-close" aria-label="Close" title={`Close ${destination} panel`} onClick={() => { publish(hideDock(state, destination)); onHide?.(); }}><Icon name="close"/></button>}
      </div>
    </header>
  );
  return <section className={`dock-panel dock-panel-${destination}`} data-content-side={destination === "right" ? resolveContentSide(state) : undefined} aria-label={`${destination === "right" ? "Side" : "Bottom"} dock`} data-dock-destination={destination} data-open={region.open}>
    {region.open && !(destination === "right" && state.rightLayout === "full") && <div className="dock-resize" role="separator" aria-orientation={destination === "right" ? "vertical" : "horizontal"} aria-valuemin={destination === "right" ? viewport.rightMinWidth ?? 320 : Math.min(160,viewport.height/2)} aria-valuemax={destination === "right" ? viewport.width : viewport.height / 2} aria-valuenow={destination === "right" ? Math.round(state.rightWidthRatio * viewport.width) : Math.round(state.bottomHeight)} tabIndex={0} onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={event => { if (resize.current?.pointer === event.pointerId) { publish(resize.current.start); resize.current = undefined; } }} onLostPointerCapture={event => { if (resize.current?.pointer === event.pointerId) { publish(resize.current.start); resize.current = undefined; } }} onKeyDown={resizeKey}/>}
    {region.open && destination === "right" && state.rightLayout !== "full" && onSwapSides && <button className="dock-swap-sides" aria-label="Swap left and right panes" title="Swap left and right panes" onClick={onSwapSides}><Icon name="swapPanes"/></button>}
    {stripContainer ? createPortal(tabStrip,stripContainer) : tabStrip}
    <div className="dock-content">{ordered.map(tab => <div key={presentationIds?.get(tab.id) ?? tab.id} id={`${panelId}-panel-${tab.id}`} role="tabpanel" tabIndex={-1} data-dock-content-id={tab.id} data-main-task-content={destination === "right" ? tab.id : undefined} onPointerDownCapture={event => pinFromContent(event,tab)} onKeyDownCapture={event => pinFromContent(event,tab)} aria-labelledby={`${panelId}-${tab.id}`} hidden={region.activeTabId !== tab.id} inert={region.activeTabId !== tab.id || undefined}>{renderTab(tab, region.activeTabId === tab.id)}</div>)}</div>
  </section>;
}
