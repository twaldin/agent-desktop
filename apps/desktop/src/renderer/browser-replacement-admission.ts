import type { BrowserReplacementDestination, BrowserReplacementOrigin, BrowserReplacementResult } from "./browser-workspace-replacement";
import { replaceBrowserWorkspaceDestination } from "./browser-workspace-replacement";
import { isCurrentDockPresentation, type DockPresentations } from "./dock-presentations";
import { sameMainTask, type MainChatTarget } from "./main-task-targets";

export interface BrowserReplacementAdmission {
  id: string;
  owner: MainChatTarget;
  focus?: BrowserReplacementResult["focus"];
}
/** Runtime-only commit results; never serialized into the window's dock snapshot. */
export interface BrowserReplacementPresentations extends DockPresentations {
  browserAdmissions?: ReadonlyMap<string, BrowserReplacementAdmission>;
}
export function admitBrowserReplacement(previous: BrowserReplacementPresentations, origin: BrowserReplacementOrigin,
  destination: BrowserReplacementDestination, owner: MainChatTarget | undefined, id: string): BrowserReplacementPresentations {
  if (previous.browserAdmissions?.has(id)) return previous;
  const result = replaceBrowserWorkspaceDestination(previous, origin, destination, owner, id);
  const browserAdmissions = new Map(previous.browserAdmissions);
  browserAdmissions.set(id, {id, owner:origin.owner, ...(result ? {focus:result.focus} : {})});
  return { ...(result?.presentations ?? previous), browserAdmissions };
}
export function acknowledgeBrowserAdmissions(previous: BrowserReplacementPresentations, ids: readonly string[]): BrowserReplacementPresentations {
  if (!ids.some(id => previous.browserAdmissions?.has(id))) return previous;
  const browserAdmissions = new Map(previous.browserAdmissions);
  ids.forEach(id => browserAdmissions.delete(id));
  return { ...previous, browserAdmissions };
}

/** Remember focus at the actual selection event, not when a slow action finishes.
 * Opening a dialog or choosing another control while waiting must keep its focus. */
export function rememberBrowserAddressFocus(root: HTMLElement | null, origin: BrowserReplacementOrigin): () => boolean {
  const input=root?.querySelector<HTMLInputElement>(`[data-dock-content-id="${CSS.escape(origin.presentation.tabId)}"] input[aria-label="Page address"]`);
  if (!root || !input || root.ownerDocument.activeElement!==input
    || input.dataset.browserAddressOwner!==JSON.stringify([origin.owner.hostId,origin.owner.sessionId])) return ()=>false;
  return ()=>root.isConnected && (root.ownerDocument.activeElement===input
    || !input.isConnected && root.ownerDocument.activeElement===root.ownerDocument.body);
}

/** Capture the committed node, then recheck both route and exact presentation at
 * RAF. A newer node or a user's intervening focus change is never a fallback. */
export function prepareBrowserReplacementFocus(root: HTMLElement, admission: BrowserReplacementAdmission,
  current: () => { presentations: DockPresentations; owner?: MainChatTarget }): (() => boolean) | undefined {
  const focus=admission.focus;
  if (!focus) return;
  const valid=()=>{
    const context=current();
    if (!context.owner || !sameMainTask(context.owner,admission.owner)
      || root.dataset.browserCurrentOwner !== JSON.stringify([context.owner.hostId,context.owner.sessionId])) return false;
    if (focus.kind === "chat") return sameMainTask(focus,context.owner);
    return isCurrentDockPresentation(context.presentations,focus)
      && context.presentations.snapshot.state[focus.destination].open
      && context.presentations.snapshot.state[focus.destination].activeTabId === focus.tabId;
  };
  if (!valid()) return;
  const selector=focus.kind === "chat" ? '[data-main-task-chat]'
    : `[data-dock-destination="${focus.destination}"] [data-dock-content-id="${CSS.escape(focus.tabId)}"]`;
  const node=root.querySelector<HTMLElement>(selector), active=root.ownerDocument.activeElement;
  if (!node) return;
  return ()=>{
    if (!valid() || !root.isConnected || root.querySelector(selector)!==node || !node.isConnected
      || node.closest('[hidden], [inert]') || !node.getClientRects().length) return false;
    if (node.contains(root.ownerDocument.activeElement)) return true;
    if (root.ownerDocument.activeElement!==active) return false;
    node.focus({preventScroll:true});return true;
  };
}
