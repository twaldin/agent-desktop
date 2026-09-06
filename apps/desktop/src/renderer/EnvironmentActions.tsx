import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LocalEnvironmentIcon, NativeTerminalInfo } from "@agent-desktop/shared";
import { Icon } from "./Icons";
import type { WorkspaceState } from "./workspace-state";
import "./environment-actions.css";

export interface EnvironmentActionsProps {
  workspace: WorkspaceState;
  connected: boolean;
  onTerminal(terminal: NativeTerminalInfo, title: string): void;
  onSettings(): void;
}

type MenuPosition = { left: number; top: number; maxHeight: number };
const deliveredReceipts = new WeakMap<WorkspaceState, Set<string>>();
const requestedTitles = new WeakMap<WorkspaceState, string>();

export function EnvironmentActions({ workspace, connected, onTerminal, onSettings }: EnvironmentActionsProps) {
  const [, redraw] = useReducer(value => value + 1, 0);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition>();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const environmentInteraction = useRef(false);
  const state = workspace.environmentActions;
  const pendingAction = workspace.pending?.envelope.command.action;
  const environmentPending = pendingAction?.type === "environment.select" || pendingAction?.type === "environment.action";
  const selected = state?.environments.find(item => item.configPath === state.selectedConfigPath);
  const primary = state?.actions[0];
  const mutationsDisabled = !connected || !state?.available || workspace.busy || Boolean(workspace.pending);

  useEffect(() => workspace.subscribe(redraw), [workspace]);
  useEffect(() => { if (connected) void workspace.loadEnvironmentActions(); }, [connected, workspace]);

  useEffect(() => {
    const receipt = workspace.mutationReceipt;
    if (!receipt || (receipt.value.type !== "environment.action" && receipt.value.type !== "environment.select")) return;
    environmentInteraction.current = false;
    if (receipt.value.type !== "environment.action") return;
    let seen = deliveredReceipts.get(workspace);
    if (!seen) deliveredReceipts.set(workspace, seen = new Set());
    if (seen.has(receipt.commandId)) return;
    seen.add(receipt.commandId);
    const title = requestedTitles.get(workspace) ?? primary?.name ?? "Environment action";
    requestedTitles.delete(workspace);
    onTerminal(receipt.value.terminal, title);
  }, [onTerminal, primary?.name, workspace, workspace.mutationReceipt?.commandId]);

  useLayoutEffect(() => {
    if (!open || !menu.current) return;
    const rect = menu.current.getBoundingClientRect();
    setPosition(previous => {
      if (!previous) return previous;
      const left = Math.max(8, Math.min(previous.left, window.innerWidth - rect.width - 8));
      const top = Math.max(8, Math.min(previous.top, window.innerHeight - rect.height - 8));
      return left === previous.left && top === previous.top ? previous : { ...previous, left, top };
    });
  }, [open, state]);

  useEffect(() => {
    if (!open) return;
    const first = menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    first?.focus();
    const reposition = () => closeMenu(false);
    window.addEventListener("resize", reposition);
    return () => window.removeEventListener("resize", reposition);
  }, [open]);

  function closeMenu(restoreFocus = true) {
    setOpen(false);
    setPosition(undefined);
    if (restoreFocus) queueMicrotask(() => trigger.current?.focus());
  }

  function openMenu() {
    if (open) { closeMenu(); return; }
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({ left: rect.right - 260, top: rect.bottom + 6, maxHeight: Math.max(120, window.innerHeight - rect.bottom - 14) });
    setOpen(true);
    if (connected) void workspace.loadEnvironmentActions();
  }

  function moveFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); closeMenu(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Home") items[0]!.focus();
    else if (event.key === "End") items.at(-1)!.focus();
    else items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]!.focus();
  }

  function selectEnvironment(configPath: string | null) {
    if (!state || mutationsDisabled || configPath === state.selectedConfigPath) { closeMenu(); return; }
    environmentInteraction.current = true;
    closeMenu();
    void workspace.mutate({ type: "environment.select", configPath, expectedRevision: state.selectionRevision });
  }

  function runAction(action: { index: number; name: string }) {
    if (!state?.selectedConfigPath || !state.configRevision || mutationsDisabled) return;
    environmentInteraction.current = true;
    requestedTitles.set(workspace, action.name);
    closeMenu();
    void workspace.mutate({ type: "environment.action", configPath: state.selectedConfigPath, configRevision: state.configRevision, selectionRevision: state.selectionRevision, actionIndex: action.index });
  }

  const status = !state ? workspace.loading.has("environment-actions") ? "Loading actions…" : "Actions unavailable"
    : !state.available ? "Update the owning host to use environment actions."
      : !connected ? "Offline · saved actions" : undefined;

  return <div className="environment-actions">
    <button ref={trigger} className={`icon-button small environment-actions-trigger${open ? " active" : ""}`} type="button" aria-label="Actions" aria-haspopup="menu" aria-expanded={open} title="Actions" onClick={openMenu}><Icon name="more"/></button>
    {primary && state?.selectedConfigPath && <button className="environment-action-primary" type="button" aria-label={`Run: ${primary.name}`} title={primary.name} disabled={mutationsDisabled} onClick={() => runAction(primary)}><ActionIcon icon={primary.icon}/></button>}
    {open && position && createPortal(<>
      <button className="environment-actions-dismiss" type="button" aria-label="Close actions menu" tabIndex={-1} onPointerDown={event => event.preventDefault()} onClick={() => closeMenu(false)}/>
      <div ref={menu} className="environment-actions-menu" role="menu" aria-label="Environment actions" style={position} onKeyDown={moveFocus}>
        <p className="environment-actions-heading">Actions</p>
        {status && <p className="environment-actions-status" role="status">{status}</p>}
        {workspace.errors["environment-actions"] && <p className="environment-actions-error" role="alert">{workspace.errors["environment-actions"]}</p>}
        {state?.actions.map(action => <button key={action.index} type="button" role="menuitem" aria-label={`Run: ${action.name}`} disabled={mutationsDisabled || !state.selectedConfigPath || !state.configRevision} onClick={() => runAction(action)}><ActionIcon icon={action.icon}/><span>{action.name}</span></button>)}
        {state && !state.actions.length && <p className="environment-actions-status">No actions are configured.</p>}
        <hr/>
        <p className="environment-actions-heading">Environment</p>
        <button type="button" role="menuitemradio" aria-checked={state?.selectedConfigPath === null} disabled={mutationsDisabled} onClick={() => selectEnvironment(null)}><Icon name="close"/><span>No environment</span>{state?.selectedConfigPath === null && <Icon name="check"/>}</button>
        {state?.environments.map(environment => <button key={environment.configPath} type="button" role="menuitemradio" aria-checked={state.selectedConfigPath === environment.configPath} disabled={mutationsDisabled || Boolean(environment.error)} title={environment.error ?? environment.configPath} onClick={() => selectEnvironment(environment.configPath)}><Icon name={environment.error ? "refresh" : "folder"}/><span>{environment.name ?? "Unreadable environment"}{environment.error && <small>{environment.error}</small>}</span>{state.selectedConfigPath === environment.configPath && <Icon name="check"/>}</button>)}
        <button type="button" role="menuitem" onClick={() => { closeMenu(false); onSettings(); }}><Icon name="sliders"/><span>Environment settings</span></button>
        {(environmentPending || environmentInteraction.current || requestedTitles.has(workspace)) && workspace.errors.action && <p className="environment-actions-error" role="alert">{workspace.errors.action}</p>}
        {environmentPending && <button className="environment-actions-retry" type="button" role="menuitem" disabled={!connected || workspace.busy} onClick={() => void workspace.retry()}><Icon name="refresh"/><span>{workspace.pending?.uncertain ? "Check original run" : "Retry environment change"}</span></button>}
      </div>
    </>, document.body)}
    {!open && environmentPending && workspace.pending?.uncertain && <button className="environment-action-retry-inline" type="button" disabled={!connected || workspace.busy} onClick={() => void workspace.retry()}>Check original run</button>}
    {!open && selected?.error && <span className="environment-action-warning" title={selected.error}>Environment error</span>}
  </div>;
}

function ActionIcon({ icon }: { icon: LocalEnvironmentIcon | null }) {
  // Exact static artwork from pinned Codex 7982: play-outline, bug, flask, and tool exports.
  if (!icon || icon === "run") return <svg className="environment-action-icon" viewBox="0 0 18 18" aria-hidden="true"><path d="M3.82422 4.74933C3.82427 3.32901 5.39273 2.46804 6.59102 3.23058L13.2698 7.48185C14.3813 8.18917 14.3813 9.81116 13.2698 10.5185L6.59102 14.7689C5.39281 15.5314 3.82448 14.6711 3.82422 13.251V4.74933ZM5.17422 13.251C5.17448 13.6058 5.56646 13.8211 5.86592 13.6307L12.5456 9.37941C12.8232 9.20249 12.8234 8.79681 12.5456 8.62004L5.86592 4.36964C5.56636 4.17902 5.17427 4.39428 5.17422 4.74933V13.251Z" fill="currentColor"/></svg>;
  if (icon === "debug") return <svg className="environment-action-icon" viewBox="0 0 16 16" aria-hidden="true"><path fillRule="evenodd" clipRule="evenodd" d="M10.2168 1.00076C10.4051.780861 10.7367.754321 10.957.942163 11.1773 1.13034 11.2034 1.46196 11.0156 1.6824L10.2764 2.54763C10.7067 3.06638 10.9657 3.73377 10.9658 4.46072 10.9658 4.61885 10.9515 4.77455 10.9277 4.92654 12.679 5.93944 13.8582 7.83132 13.8584 9.99978 13.8584 12.0975 12.7556 13.9373 11.1006 14.9715 10.6866 15.2301 10.1715 15.0344 9.99316 14.6209L9.85742 14.3074C9.28431 14.5436 8.65772 14.6755 8.00098 14.6756 7.34382 14.6756 6.71612 14.5438 6.14258 14.3074L6.00781 14.6209C5.82956 15.0345 5.31438 15.23 4.90039 14.9715 3.24529 13.9373 2.1416 12.0975 2.1416 9.99978 2.14176 7.8317 3.32042 5.93957 5.07129 4.92654 5.04749 4.77459 5.03418 4.61878 5.03418 4.46072 5.03431 3.73352 5.29295 3.06548 5.72363 2.54666L4.98535 1.6824C4.79734 1.46196 4.82363 1.13041 5.04395.942163 5.26432.754515 5.59599.780733 5.78418 1.00076L6.52734 1.8699C6.96102 1.61938 7.46319 1.47442 8 1.47439 8.53701 1.47439 9.03888 1.62021 9.47266 1.87087L10.2168 1.00076ZM7.47559 5.22048C5.87879 5.39381 4.51705 6.34902 3.78027 7.69509 3.95007 7.62307 4.13696 7.58379 4.33301 7.58376 5.11527 7.58376 5.74976 8.21758 5.75 8.99978 5.75 9.78218 5.11541 10.4168 4.33301 10.4168 3.86665 10.4167 3.4544 10.1903 3.19629 9.84255 3.19461 9.89477 3.19239 9.94715 3.19238 9.99978 3.19238 11.5997 3.97406 13.0167 5.17773 13.8914L7.47559 8.55837V5.22048ZM8.52539 8.55837 10.8223 13.8914C12.0262 13.0167 12.8086 11.5999 12.8086 9.99978 12.8086 9.94682 12.8054 9.89413 12.8037 9.84158 12.5457 10.1897 12.1336 10.4167 11.667 10.4168 10.8846 10.4168 10.25 9.78218 10.25 8.99978 10.2502 8.21758 10.8847 7.58376 11.667 7.58376 11.8632 7.58381 12.0499 7.62394 12.2197 7.69607 11.483 6.34987 10.1222 5.39392 8.52539 5.22048ZM6.55762 13.3426C7.00287 13.5242 7.48978 13.6258 8.00098 13.6258 8.51191 13.6257 8.99747 13.5231 9.44238 13.3416L8 9.99294 6.55762 13.3426ZM8 2.52517C6.94642 2.52526 6.08525 3.38763 6.08496 4.46072V4.46267C6.68514 4.25509 7.32928 4.14142 8 4.14138 8.67074 4.14138 9.31486 4.25511 9.91504 4.46267L9.91602 4.46072C9.91572 3.38758 9.05365 2.52517 8 2.52517Z" fill="currentColor"/></svg>;
  if (icon === "test") return <svg className="environment-action-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M16.0013 14.4404C16.0012 13.9504 15.8514 13.4739 15.5736 13.0742L15.4467 12.9082 15.0121 12.3877C13.8615 12.8911 12.9154 13.1121 12.0619 13.1562 11.1476 13.2035 10.3805 13.0475 9.66541 12.8857 8.9421 12.7221 8.28162 12.5562 7.47302 12.5146 6.70041 12.475 5.77589 12.5504 4.56873 12.8887L4.5531 12.9082C4.19469 13.3383 3.99852 13.8806 3.99841 14.4404 3.99841 15.7627 5.07071 16.835 6.39294 16.835H13.6078C14.9299 16.8349 16.0013 15.7626 16.0013 14.4404ZM11.8353 3.16504H8.16541V7.72949C8.16541 8.20671 8.01889 8.6713 7.74841 9.06055L7.62439 9.22266 5.93396 11.25C6.52127 11.1756 7.05057 11.1614 7.54041 11.1865 8.48678 11.2351 9.2693 11.432 9.95837 11.5879 10.6557 11.7456 11.272 11.8653 11.9926 11.8281 12.5792 11.7978 13.2617 11.6591 14.1215 11.3184L12.3754 9.22266C12.0262 8.80363 11.8353 8.27494 11.8353 7.72949V3.16504ZM13.1654 7.72949C13.1654 7.96372 13.247 8.19111 13.3969 8.37109L16.4681 12.0566 16.6654 12.3154C17.0976 12.9371 17.3313 13.6782 17.3314 14.4404 17.3314 16.4971 15.6645 18.1649 13.6078 18.165H6.39294C4.33617 18.165 2.66833 16.4972 2.66833 14.4404 2.66844 13.5694 2.97398 12.7258 3.53162 12.0566L6.60291 8.37109 6.65564 8.30176C6.77198 8.13447 6.83533 7.93464 6.83533 7.72949V3.16504H6.66638C6.29926 3.16486 6.00134 2.86716 6.00134 2.5 6.00134 2.13284 6.29926 1.83514 6.66638 1.83496H13.3334L13.4672 1.84863C13.7703 1.91057 13.9984 2.17857 13.9984 2.5 13.9984 2.82143 13.7703 3.08943 13.4672 3.15137L13.3334 3.16504H13.1654V7.72949Z" fill="currentColor"/></svg>;
  return <svg className="environment-action-icon" viewBox="0 0 20 20" aria-hidden="true"><path fillRule="evenodd" clipRule="evenodd" d="M9.99944 7.24939C11.5169 7.2495 12.7473 8.47995 12.7475 9.99744 12.7475 11.5151 11.517 12.7454 9.99944 12.7455 8.48176 12.7455 7.2514 11.5151 7.2514 9.99744 7.25155 8.47988 8.48186 7.24939 9.99944 7.24939ZM9.99944 8.57947C9.2164 8.57947 8.58163 9.21442 8.58148 9.99744 8.58148 10.7806 9.2163 11.4154 9.99944 11.4154 10.7825 11.4153 11.4174 10.7805 11.4174 9.99744 11.4173 9.21449 10.7824 8.57958 9.99944 8.57947Z" fill="currentColor"/><path fillRule="evenodd" clipRule="evenodd" d="M10.6391 1.67517C11.2939 1.67532 11.8991 2.02577 12.226 2.59314L13.2485 4.36755H15.2963C15.9505 4.36758 16.555 4.71709 16.8823 5.28357L17.5219 6.39001C17.8489 6.95668 17.8481 7.65542 17.5209 8.22205L16.4975 9.99451 17.5239 11.7689C17.8519 12.3357 17.8521 13.0347 17.5248 13.6019L16.8862 14.7084C16.559 15.2747 15.9543 15.6243 15.3002 15.6244H13.2514L12.2299 17.3988C11.9029 17.9663 11.297 18.3168 10.642 18.3168L9.3637 18.3158C8.71064 18.3155 8.10718 17.9678 7.77972 17.4027L6.74847 15.6234 4.69964 15.6244C4.04558 15.6242 3.44087 15.2747 3.1137 14.7084L2.47503 13.6019C2.14791 13.0349 2.14836 12.3366 2.47601 11.7699L3.50237 9.99548 2.47894 8.22205C2.15175 7.65533 2.15174 6.95673 2.47894 6.39001L3.11761 5.28259C3.44458 4.71663 4.04894 4.36813 4.70257 4.36755L6.75042 4.36658 7.77581 2.59119C8.10301 2.02476 8.7076 1.67527 9.36175 1.67517H10.6391ZM9.36273 3.00623C9.1835 3.00623 9.01679 3.10199 8.92718 3.2572L7.82659 5.16345C7.63652 5.49253 7.28473 5.69529 6.90472 5.69568L4.70355 5.69763C4.52451 5.69782 4.3585 5.79355 4.26898 5.94861L3.6303 7.05505C3.54091 7.2102 3.54077 7.40192 3.6303 7.55701L4.73089 9.46326C4.92108 9.7929 4.92135 10.1992 4.73089 10.5287L3.62737 12.4359C3.5378 12.591 3.53792 12.7817 3.62737 12.9369L4.26605 14.0433C4.35567 14.1982 4.52067 14.2932 4.69964 14.2933L6.90276 14.2943C7.28242 14.2946 7.63335 14.497 7.82366 14.8256L8.93011 16.7357C9.01984 16.8905 9.18578 16.9857 9.36468 16.9857H10.642C10.8213 16.9857 10.987 16.89 11.0766 16.7347L12.1752 14.8275C12.3653 14.4975 12.7182 14.2943 13.0991 14.2943H15.3002C15.4794 14.2942 15.6452 14.1985 15.7348 14.0433L16.3725 12.9379C16.4621 12.7826 16.4621 12.5911 16.3725 12.4359L15.27 10.5287C15.1032 10.2404 15.0808 9.89331 15.2055 9.59021L15.269 9.46326 16.3696 7.55701C16.4591 7.40189 16.459 7.21022 16.3696 7.05505L15.7309 5.94861C15.6412 5.79363 15.4754 5.69863 15.2963 5.69861L13.0951 5.69763 12.9535 5.68884C12.6751 5.65158 12.4217 5.50519 12.2504 5.28259L12.1723 5.16443 11.0737 3.2572C10.9841 3.10175 10.8175 3.00525 10.6381 3.00525L9.36273 3.00623Z" fill="currentColor"/></svg>;
}
