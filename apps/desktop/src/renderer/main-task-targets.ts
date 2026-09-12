import { setRightDockFullWidth, activateDockTab, hideDock, dockTabId, type DockState, type DockTab } from "./dock-state";
import type { AppShortcut } from "./app-shortcuts";

export interface MainChatTarget { kind: "chat"; hostId: string; sessionId: string | null }
export interface MainContentTarget { kind: "content"; tabId: string; hostId: string; target: DockTab["target"] }
export type MainTaskTarget = MainChatTarget | MainContentTarget;
export interface MainTaskSnapshot { state: DockState; tabs: readonly DockTab[] }

/** Pinned KM is the right content owner. qM/bottom is a separate strip, never a numeric task slot.
 * Includes current app content descriptors (including its goal/worktree adaptations); not a claim
 * that their visual tabs or the unified full-width strip already match the reference. */
export function mainTaskTargets(snapshot: MainTaskSnapshot, chat: MainChatTarget): MainTaskTarget[] {
  const seen = new Set<string>();
  return [chat, ...snapshot.state.right.tabIds.flatMap(tabId => {
    const tab = snapshot.tabs.find(value => value.id === tabId);
    if (!tab || tab.id !== dockTabId(tab) || seen.has(tabId)) return [];
    seen.add(tabId);
    return [{ kind: "content" as const, tabId, hostId: tab.hostId, target: tab.target }];
  })];
}

/** Pinned full mode includes a CLOSED right controller with retained content.
 * The leading Chat tab remains the way back to those mounted content views. */
export function unifiedMainTaskStrip(snapshot: MainTaskSnapshot, chat: MainChatTarget): { content: MainContentTarget[]; active: MainTaskTarget } | undefined {
  const content = mainTaskTargets(snapshot,chat).filter((target): target is MainContentTarget => target.kind === "content");
  if (!content.length || (snapshot.state.right.open && snapshot.state.rightLayout !== "full")) return;
  const active = snapshot.state.right.open ? content.find(target => target.tabId === snapshot.state.right.activeTabId) : undefined;
  return {content,active:active ?? chat};
}

export interface TaskLayoutActivation { fillChat: boolean; restoreFocus: boolean }
/** Capture before a menu closes: only the focused activating control owns the
 * request to move focus after layout. Option/Alt is independent of keybindings. */
export function readTaskLayoutActivation(event: {altKey:boolean; currentTarget:HTMLElement}): TaskLayoutActivation {
  return {fillChat:event.altKey,restoreFocus:event.currentTarget.ownerDocument.activeElement===event.currentTarget};
}

/** Pinned Go/Yo: retained content in closed/full mode offers Restore split.
 * Choose the still-owned active content or the first retained target before opening. */
export function mainTaskLayoutChange(snapshot: MainTaskSnapshot, chat: MainChatTarget, fillChat = false): {label:"Fullscreen"|"Restore split"; state:DockState; focusTarget:MainTaskTarget} | undefined {
  const targets=mainTaskTargets(snapshot,chat).filter((target): target is MainContentTarget => target.kind==="content");
  const target=targets.find(target=>target.tabId===snapshot.state.right.activeTabId) ?? targets[0];
  if(!target) return;
  const restore=!snapshot.state.right.open || snapshot.state.rightLayout==="full";
  const selected=activateDockTab(snapshot.state,"right",target.tabId);
  // Pinned pKi fills Chat from split by closing content without remembering full
  // content. Restoring split ignores Alt and retains the active Chat/content side.
  if(!restore && fillChat) return {label:"Fullscreen",state:hideDock(selected,"right"),focusTarget:chat};
  return {label:restore?"Restore split":"Fullscreen",state:setRightDockFullWidth(selected,!restore),focusTarget:restore && !snapshot.state.right.open ? chat : target};
}

export function sameMainTask(left: MainTaskTarget, right: MainTaskTarget): boolean {
  return left.kind === right.kind && left.hostId === right.hostId && (left.kind === "chat"
    ? right.kind === "chat" && left.sessionId === right.sessionId
    : right.kind === "content" && left.tabId === right.tabId && left.target === right.target);
}

/** Pinned nonnumeric dKi cycles content only in split, Chat+content in full.
 * The direction is logical next/previous; only numeric indexing reverses in RTL. */
export function adjacentMainTask(snapshot: MainTaskSnapshot, chat: MainChatTarget, area: "chat" | "content", direction: "next" | "previous"): { target: MainTaskTarget; focusSource?: MainTaskTarget } | undefined {
  const all = mainTaskTargets(snapshot, chat);
  if (all.length === 1) return;
  const split = snapshot.state.right.open && snapshot.state.rightLayout !== "full";
  const content = all.find(target => target.kind === "content" && target.tabId === snapshot.state.right.activeTabId);
  const selected = snapshot.state.right.open && content && (snapshot.state.rightLayout === "full" || area === "content") ? content : chat;
  const items = split ? all.slice(1) : all;
  const index = items.findIndex(target => split ? target.kind === "content" && target.tabId === snapshot.state.right.activeTabId : sameMainTask(target,selected));
  const target = items[(index + (direction === "next" ? 1 : -1) + items.length) % items.length]!;
  return { target, ...(selected.kind !== target.kind ? { focusSource:selected } : {}) };
}

/** Cross-kind cycling moves focus only if the departing panel actually owned it. */
export function mainTaskContainsFocus(root: HTMLElement, target: MainTaskTarget): boolean {
  const selector = target.kind === "chat" ? '[data-main-task-chat]' : `[data-main-task-content="${CSS.escape(target.tabId)}"]`;
  return root.querySelector<HTMLElement>(selector)?.contains(root.ownerDocument.activeElement) ?? false;
}

/** No wrap or fallback. RTL reverses the whole list before taking the nine numeric slots. */
export function numberedMainTaskActions(targets: readonly MainTaskTarget[], direction: "ltr" | "rtl", select: (target: MainTaskTarget) => void): Partial<Record<AppShortcut, () => void>> {
  const ordered = direction === "rtl" ? [...targets].reverse() : targets;
  return Object.fromEntries(ordered.slice(0, 9).map((target, index) => [`task-tab-${index + 1}`, () => select(target)]));
}

/** Revalidate the full target at activation; never reopen a removed or newly bottom-owned tab. */
export function activateMainTask(snapshot: MainTaskSnapshot, chat: MainChatTarget, target: MainTaskTarget): DockState | undefined {
  if (!mainTaskTargets(snapshot, chat).some(value => sameMainTask(value, target))) return;
  return target.kind === "chat" ? snapshot.state.right.open && snapshot.state.rightLayout === "full" ? hideDock(snapshot.state, "right", true) : snapshot.state : activateDockTab(snapshot.state, "right", target.tabId);
}

/** Focus only the committed, still-active owner. Existing input/embedded focus stays where it is. */
export function focusMainTask(root: HTMLElement, snapshot: MainTaskSnapshot, chat: MainChatTarget, target: MainTaskTarget): boolean {
  if (!mainTaskTargets(snapshot, chat).some(value => sameMainTask(value, target))) return false;
  if (target.kind === "content" && (!snapshot.state.right.open || snapshot.state.right.activeTabId !== target.tabId)) return false;
  const selector = target.kind === "chat" ? '[data-main-task-chat]' : `[data-main-task-content="${CSS.escape(target.tabId)}"]`;
  const panel = root.querySelector<HTMLElement>(selector);
  if (!panel?.isConnected || panel.closest('[hidden], [inert]') || !panel.getClientRects().length) return false;
  if (!panel.contains(panel.ownerDocument.activeElement)) panel.focus({ preventScroll: true });
  return true;
}
