import { activateDockTab, closeDockTab, createDockState, dockTabId, hideDock, insertDockTab, type DockTab } from "./dock-state";
import { parseDockSnapshot } from "../window-state";
import { captureDockPresentation, isCurrentDockPresentation, reconcileDockPresentations, type DockPresentationRef, type DockPresentations } from "./dock-presentations";
import { sameMainTask, type MainChatTarget } from "./main-task-targets";
import type { BrowserNewTabState } from "./browser-new-tab";

/** Runtime-only selection intent. Holding the immutable draft object also rejects
 * edits which change and then restore the same text before a queued completion. */
export interface BrowserReplacementOrigin {
  presentation: DockPresentationRef;
  owner: MainChatTarget;
  state: BrowserNewTabState;
  title: string;
}
export type BrowserReplacementDestination =
  | { kind: "chat"; target: MainChatTarget }
  | { kind: "tab"; target: DockPresentationRef }
  /** A confirmed result from the existing action owner, never an in-flight intent. */
  | { kind: "opened"; tab: DockTab };
export interface BrowserReplacementResult {
  presentations: DockPresentations;
  focus: MainChatTarget | DockPresentationRef;
}

function replaceable(tab: DockTab | undefined, owner: MainChatTarget): tab is DockTab & { browserNewTab: BrowserNewTabState } {
  return Boolean(tab && owner.sessionId !== null && tab.hostId === owner.hostId && tab.target === `session:${owner.sessionId}`
    && tab.kind === "browser" && tab.id === dockTabId(tab) && tab.browserInstanceId && !tab.browserTarget
    && (tab.browserNewTab?.status === "rejected"
      || tab.browserNewTab?.status === "idle" && tab.browserNewTab.request === undefined));
}

/** Deliberate suggestion replacement permits typed/explicitly empty drafts and
 * custom titles. It is not the pristine cleanup/disposal predicate. */
export function captureBrowserReplacement(presentations: DockPresentations, tabId: string, owner: MainChatTarget): BrowserReplacementOrigin | undefined {
  const presentation = captureDockPresentation(presentations, tabId);
  const tab = presentations.snapshot.tabs.find(tab => tab.id === tabId);
  if (!presentation || !replaceable(tab, owner)) return;
  return { presentation, owner: { ...owner }, state: tab.browserNewTab, title: tab.title };
}

/** Call against the latest state and current owner. This is presentation-only;
 * backend acquisition, cancellation, and post-commit focus belong to their owners. */
export function replaceBrowserWorkspaceDestination(
  previous: DockPresentations,
  origin: BrowserReplacementOrigin,
  destination: BrowserReplacementDestination,
  currentOwner: MainChatTarget | undefined,
  seed: string,
): BrowserReplacementResult | undefined {
  if (!currentOwner || !sameMainTask(currentOwner, origin.owner) || !isCurrentDockPresentation(previous, origin.presentation)) return;
  const source = previous.snapshot.tabs.find(tab => tab.id === origin.presentation.tabId);
  if (!replaceable(source, currentOwner) || source.browserNewTab !== origin.state || source.title !== origin.title) return;
  let selected: DockPresentationRef | undefined, opened: DockTab | undefined;
  if (destination.kind === "chat") {
    if (!sameMainTask(destination.target, currentOwner)) return;
  } else if (destination.kind === "tab") {
    if (destination.target.tabId === source.id || !isCurrentDockPresentation(previous, destination.target)) return;
    selected = destination.target;
  } else {
    const tab = destination.tab;
    if (tab.id === source.id || tab.id !== dockTabId(tab) || tab.hostId !== source.hostId || tab.target !== source.target) return;
    if (!parseDockSnapshot({ state: insertDockTab(createDockState(), tab, "right"), tabs: [tab] })) return;
    if (tab.browserNewTab && (tab.browserNewTab.status !== "idle" || tab.browserNewTab.request !== undefined)) return;
    const existing = previous.snapshot.tabs.find(item => item.id === tab.id);
    if (existing) {
      selected = captureDockPresentation(previous, tab.id);
      if (!selected) return;
    } else opened = tab;
  }
  const index = previous.snapshot.state[origin.presentation.destination].tabIds.indexOf(source.id);
  let state = closeDockTab(previous.snapshot.state, origin.presentation.destination, source.id);
  const tabs = previous.snapshot.tabs.filter(tab => tab.id !== source.id);
  if (selected) state = activateDockTab(state, selected.destination, selected.tabId);
  else if (opened) {
    tabs.push(opened);
    state = insertDockTab(state, opened, origin.presentation.destination, index);
    // Replacing the last tab must not accidentally discard full-content layout.
    if (origin.presentation.destination === "right" && previous.snapshot.state.rightLayout === "full")
      state = { ...state, rightLayout: "full" };
  } else if (state.right.open && state.rightLayout === "full") state = hideDock(state, "right", true);
  const presentations = reconcileDockPresentations(previous, { state, tabs }, seed);
  const focus = selected ?? (opened ? captureDockPresentation(presentations, opened.id) : currentOwner);
  return focus ? { presentations, focus } : undefined;
}
