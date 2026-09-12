import { useEffect, useLayoutEffect, useRef } from "react";
import { Icon } from "./Icons";
import { BrowserAddressInput, type BrowserAddressSuggestion } from "./BrowserAddressInput";
import type { BrowserWorkspaceMenuState } from "./browser-workspace-menu";
import type { BrowserNewTabController } from "./browser-new-tab";
import type { ReactNode } from "react";
import "./browser-panel.css";

export function BrowserNewTabPanel<T extends BrowserAddressSuggestion>({ controller, active, suggestions, onChoose, workspaceState, onCancelWorkspace, terminalRecovery, recovery, addressOwner }: {
  controller: Pick<BrowserNewTabController, "tab" | "state" | "connected" | "checking" | "observePresentation" | "edit" | "submit" | "inspect">; active: boolean; suggestions?: readonly T[]; onChoose?(row: T): void;
  workspaceState?: BrowserWorkspaceMenuState; onCancelWorkspace?(): void;
  terminalRecovery?: ReactNode; recovery?: ReactNode; addressOwner?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const addressBar = useRef<HTMLFormElement>(null);
  const state = controller.state;
  const pending = state.status === "pending";
  const unknown = state.status === "unknown";
  const workspaceBlocked = Boolean(terminalRecovery) || workspaceState?.status === "preparing" || workspaceState?.status === "committing" || workspaceState?.status === "ready"
    || workspaceState?.status === "unknown" || workspaceState?.status === "cancelled" && workspaceState.creationMayHaveRun;
  const focused = useRef(false);
  useLayoutEffect(() => { controller.observePresentation(); }, [controller]);
  useEffect(() => {
    if (active && !focused.current && !pending && !unknown) { focused.current = true; input.current?.focus(); }
  }, [active, pending, unknown]);
  return <section className="browser-panel" aria-label="Browser preview">
    <div className="browser-controls" aria-label="Browser controls">
      <button aria-label="Back" title="Back" disabled><Icon name="browserBack"/></button>
      <button aria-label="Forward" title="Forward" disabled><Icon name="browserBack" className="browser-forward-icon"/></button>
      <button aria-label="Reload page" title="Reload page" disabled><Icon name="browserReload"/></button>
      <form ref={addressBar} onSubmit={event => { event.preventDefault(); if (active && !workspaceBlocked) void controller.submit(); }}>
        <BrowserAddressInput inputRef={input} anchorRef={addressBar}
          owner={addressOwner ?? JSON.stringify([controller.tab.hostId, controller.tab.target.slice(8)])}
          draft={state.draft !== undefined} value={state.draft ?? ""} disabled={!active || pending} readOnly={unknown || workspaceBlocked}
          suggestions={suggestions} onChoose={onChoose} onChange={value => { if (!workspaceBlocked) controller.edit(value); }}
          onCancel={() => { if (!workspaceBlocked) controller.edit(undefined); }} onSubmit={() => { if (active && !workspaceBlocked) void controller.submit(); }}/>
        <button aria-label="Open in external browser" title="Open in this device’s external browser" disabled type="button"><Icon name="browserExternal"/></button>
      </form>
    </div>
    {state.message && <p className="browser-status" role="alert">{state.message}</p>}
    {recovery}
    {terminalRecovery}
    {(workspaceState?.status === "preparing" || workspaceState?.status === "committing" || workspaceState?.status === "ready") && <div className="browser-status" role="status">
      Opening panel… {workspaceState.status === "preparing" && onCancelWorkspace && <button type="button" onClick={onCancelWorkspace}>Cancel</button>}
    </div>}
    {(workspaceState?.status === "error" || workspaceState?.status === "unknown") && <p className="browser-status" role="alert">{workspaceState.message}{workspaceState.status === "unknown" && " The address is retained. No action will be repeated automatically."}</p>}
    {workspaceState?.status === "cancelled" && <p className="browser-status" role="status">{workspaceState.creationMayHaveRun ? "Opening was cancelled. The action may have completed, so it will not be repeated. The address is retained." : "Opening was cancelled. The address is retained."}</p>}
    {unknown && <div className="browser-status">
      <button type="button" disabled={!active || !controller.connected || controller.checking}
        onClick={() => { if (active) void controller.inspect(); }}>Check creation status</button>
      {controller.checking && <span role="status"> Checking…</span>}
    </div>}
    {pending && <p className="browser-status" role="status">Opening page…</p>}
    <figure><div className="browser-blank-page"><Icon name="globe"/><strong>Start browsing</strong><span>Enter a URL to open a page</span></div></figure>
  </section>;
}
