import { useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { BranchSwitchRequest } from "./BranchSwitchDialog";
import { Icon } from "./Icons";
import type { WorkspaceState } from "./workspace-state";
import { useBranchCopyMenu } from "./use-branch-copy-menu";
import { useBranchSearch } from "./use-branch-search";
import { useBranchInventory } from "./use-branch-inventory";
import { orderBranchNames } from "./branch-inventory";
import type { GitBranch } from "@agent-desktop/shared";
import "./branch-selector.css";

export interface BranchSelectorProps {
  workspace: WorkspaceState;
  connected: boolean;
  branchPrefix: string;
  onOpenGitSettings(): void;
  variant: "composer" | "environment" | "commit";
  /** Commit selects a destination; it never checks out while browsing. */
  destination?: { newBranch: boolean; onChange(newBranch: boolean): void };
  portalContainer?: HTMLElement;
  repositoryName?: string;
  onOpen?(): void;
  onCheckoutBlocked?(request: BranchSwitchRequest): void;
}

type OpenSurface = "branches" | "create-branch";

export function BranchSelector({ workspace, connected, branchPrefix, onOpenGitSettings, variant, repositoryName, onOpen, destination, portalContainer, onCheckoutBlocked }: BranchSelectorProps) {
  const [open, setOpen] = useState<OpenSurface>();
  const [query, setQuery] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [selectionError, setSelectionError] = useState<string>();
  const [resolvingVersion, setResolvingVersion] = useState<number>();
  // A restored tuple is a new menu/query lifetime. Unlike the controller's
  // connection generation, this token belongs to the handler's committed render.
  const selectionLifetime = useMemo(() => ({}), [workspace, open, query, connected]);
  const committedSelectionLifetime = useRef<object | undefined>(undefined);
  const selectionAttempt = useRef(0);
  const selecting = useRef<number | undefined>(undefined);
  const [, redraw] = useReducer(value => value + 1, 0);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const branchInput = useRef<HTMLInputElement>(null);
  const currentContext = useRef({ workspace, open, query, connected });
  currentContext.current = { workspace, open, query, connected };
  const [position, setPosition] = useState<CSSProperties>();
  const dialogTitle = useId(), branchInputId = useId();
  const disabled = !connected || !workspace.status || !workspace.restored || workspace.busy || Boolean(workspace.pending);
  const localBranches = workspace.branches.filter(item => !item.remote && !item.symbolicTarget);
  const currentBranch = workspace.status?.branch ?? localBranches.find(item => item.current)?.name;
  const branchCopy = useBranchCopyMenu(workspace, workspace.status?.branch ?? undefined, variant === "environment");
  const search = useBranchSearch(workspace, query, open === "branches" && !destination && connected);
  const inventory = useBranchInventory(workspace, open === "branches" && !destination && connected);
  const resolving = resolvingVersion !== undefined && search.controller.isCurrent(resolvingVersion);
  const uncommitted = workspace.status?.entries.length ?? 0;

  useEffect(() => workspace.subscribe(redraw), [workspace]);
  useLayoutEffect(() => {
    committedSelectionLifetime.current = selectionLifetime;
    ++selectionAttempt.current; selecting.current = undefined; setResolvingVersion(undefined); setSelectionError(undefined);
    return () => { committedSelectionLifetime.current = undefined; ++selectionAttempt.current; selecting.current = undefined; };
  }, [selectionLifetime]);
  useEffect(() => {
    setOpen(undefined); setQuery(""); setNewBranch(""); setPosition(undefined);
  }, [workspace]);
  useLayoutEffect(() => {
    if (open !== "branches" || !trigger.current) return;
    const target = trigger.current;
    const measure = () => {
      const box = target.getBoundingClientRect(), width = Math.min(297, innerWidth - 24);
      if (variant === "environment") {
        const left = box.left - width - 4 >= 12 ? box.left - width - 4 : Math.min(box.right + 4, innerWidth - width - 12);
        const top = Math.max(12, Math.min(box.top, innerHeight - 52));
        setPosition({ width, left: Math.max(12, left), top, maxHeight: Math.max(40, innerHeight - top - 12) });
        return;
      }
      const above = variant !== "commit" && box.top >= Math.min(200, innerHeight / 2);
      setPosition({ width, left: Math.max(12, Math.min(box.left, innerWidth - width - 12)), ...(above
        ? { bottom: innerHeight - box.top + 4, top: "auto", maxHeight: Math.max(40, Math.min(420, box.top - 16)) }
        : { top: box.bottom + 4, bottom: "auto", maxHeight: Math.max(40, Math.min(420, innerHeight - box.bottom - 16)) }) });
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(target);
    window.addEventListener("resize", measure); window.addEventListener("scroll", measure, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  }, [open, variant]);
  useEffect(() => {
    if (open !== "branches") return;
    const frame = requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>("input,button:not(:disabled)")?.focus({ preventScroll: true }));
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(undefined);
    };
    window.addEventListener("pointerdown", outside);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("pointerdown", outside); };
  }, [open]);
  useLayoutEffect(() => {
    const target = dialog.current;
    if (open !== "create-branch" || !target) return;
    if (!target.open) target.showModal();
    const frame = requestAnimationFrame(() => branchInput.current?.focus({ preventScroll: true }));
    return () => { cancelAnimationFrame(frame); if (target.open) target.close(); };
  }, [open]);

  function close() {
    const restore = trigger.current, modal = Boolean(dialog.current?.open), owner = workspace;
    setOpen(undefined);
    if (!modal) restore?.focus({ preventScroll: true });
    else requestAnimationFrame(() => {
      if (currentContext.current.workspace === owner && currentContext.current.open == null) restore?.focus({ preventScroll: true });
    });
  }
  function toggle() {
    setQuery(""); setNewBranch(""); setPosition(undefined);
    if (open !== "branches") onOpen?.();
    setOpen(value => value === "branches" ? undefined : "branches");
    if (connected) { void workspace.loadGit(); void workspace.loadWorktrees(); }
  }
  function key(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (event.target instanceof HTMLInputElement && !["ArrowDown", "ArrowUp"].includes(event.key)) return;
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : index < 0 ? event.key === "ArrowUp" ? buttons.length - 1 : 0 : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next]?.focus({ preventScroll: true }); buttons[next]?.scrollIntoView({ block: "nearest" });
  }
  function completedCheckout(commandId: string | undefined) {
    if (!commandId) return;
    if (workspace.checkoutRefusal?.commandId === commandId && onCheckoutBlocked) {
      // The conflict modal owns autofocus. Do not refocus the disappearing menu.
      setOpen(undefined);
      onCheckoutBlocked({ data: workspace, refusal: workspace.checkoutRefusal });
    } else if (!workspace.errors.action && !workspace.pending) close();
  }
  async function checkout(branch: string, create = false) {
    const revision = workspace.status?.revision;
    if (disabled || !revision) return;
    const attempt = selectionAttempt.current, surface = open;
    const current = () => currentContext.current.workspace === workspace && currentContext.current.open === surface
      && currentContext.current.connected && selectionAttempt.current === attempt;
    const id = await workspace.mutateCommand({ type: "git.checkout", branch, expectedRevision: revision, ...(create ? { create: true } : {}) }, undefined, current);
    if (current()) completedCheckout(id);
  }
  function selectBranch(branch: GitBranch) {
    const expression = branch.remote ? /^refs\/remotes\/[^/]+\/(.+)$/.exec(branch.ref)?.[1]
      : branch.ref.startsWith("refs/heads/") ? branch.ref.slice("refs/heads/".length) : undefined;
    if (expression) void selectExact(expression);
  }
  async function selectExact(expression = query.trim()) {
    if (committedSelectionLifetime.current !== selectionLifetime || disabled || !currentContext.current.connected || currentContext.current.workspace !== workspace
      || currentContext.current.open !== "branches" || currentContext.current.query !== query
      || !workspace.status || !workspace.restored || workspace.busy || workspace.pending
      || (selecting.current !== undefined && search.controller.isCurrent(selecting.current)) || !expression) return;
    const attempt = ++selectionAttempt.current, version = search.controller.version;
    selecting.current = version; setResolvingVersion(version); setSelectionError(undefined);
    const current = () => selectionAttempt.current === attempt && search.controller.isCurrent(version)
      && currentContext.current.workspace === workspace && currentContext.current.open === "branches" && currentContext.current.query === query;
    try {
      const target = await search.controller.resolveCheckout(expression);
      if (!target || !current() || !currentContext.current.connected || !workspace.restored || workspace.busy || workspace.pending) return;
      const revision = workspace.status?.revision;
      if (!revision) return;
      if (target.kind === "branch" && target.selection.ref === `refs/heads/${workspace.status?.branch}`) { close(); return; }
      const submitted = await workspace.mutateCommand(target.kind === "branch"
        ? { type: "git.checkout-ref", selection: target.selection, expectedRevision: revision }
        : { type: "git.checkout-revision", revision: { expression: target.expression, commit: target.commit }, expectedRevision: revision }, undefined, current);
      if (current()) completedCheckout(submitted);
    } catch (cause) { if (current()) setSelectionError(cause instanceof Error ? cause.message : "Unable to select the branch."); }
    finally { if (selectionAttempt.current === attempt) { selecting.current = undefined; setResolvingVersion(undefined); } }
  }
  async function retryCheckout(surface: OpenSurface) {
    const id = workspace.pending?.envelope.id, attempt = selectionAttempt.current;
    await workspace.retry();
    if (currentContext.current.workspace !== workspace || currentContext.current.open !== surface || !currentContext.current.connected || selectionAttempt.current !== attempt) return;
    if (id && (workspace.checkoutRefusal?.commandId === id || !workspace.errors.action && !workspace.pending)) { completedCheckout(id); return; }
    requestAnimationFrame(() => (surface === "branches" ? menu.current?.querySelector<HTMLInputElement>("input") : branchInput.current)?.focus({ preventScroll: true }));
  }

  const typed = query.trim();
  const idleNames = orderBranchNames(inventory.snapshot.recent, workspace.status?.branch, inventory.snapshot.defaultBranch);
  const visibleBranches = typed ? search.snapshot.branches.map(branch => ({ name: branch.name, key: branch.ref, branch }))
    : idleNames.map(name => ({ name, key: name, branch: undefined }));
  const branchLoading = typed ? search.snapshot.loading : inventory.snapshot.loading && (!inventory.snapshot.loaded || !idleNames.length);
  const branchError = typed ? search.snapshot.error : inventory.snapshot.error;
  const exactMatch = visibleBranches.some(item => item.name === typed || item.branch?.ref === typed);
  const trimmedBranch = newBranch.trim();
  const branchExists = workspace.branches.some(item => !item.remote && item.name === trimmedBranch);
  const branchEndsWithSlash = trimmedBranch.endsWith("/");
  const canCreateBranch = !disabled && workspace.status?.head !== null && Boolean(trimmedBranch) && !branchEndsWithSlash && !branchExists;
  const triggerTitle = workspace.errors.git ?? currentBranch ?? "Repository branch";
  const triggerContent = <><Icon name="branch"/><span>{destination?.newBranch ? "New branch" : workspace.status ? currentBranch ?? "Detached HEAD" : workspace.loading.has("git") ? "Loading branch…" : "Branch unavailable"}</span>{workspace.pending ? <span className="spinner" aria-label="Branch operation pending"/> : <Icon name="chevron"/>}</>;

  return <>
    <button ref={trigger} type="button" className={variant === "environment" ? "environment-row branch-selector-trigger" : "branch-selector-trigger"} aria-label={destination ? "Commit to" : "Switch branch"} aria-haspopup="menu" aria-expanded={open === "branches" || open === "create-branch"} title={triggerTitle} onClick={toggle} onContextMenu={branchCopy.onContextMenu}>{triggerContent}</button>
    {branchCopy.error && <p className="environment-note" role="alert">{branchCopy.error}</p>}
    {open === "branches" && position && createPortal(<div ref={menu} role="menu" aria-label={destination ? "Commit to" : currentBranch ?? "Switch branch"} className="branch-selector-menu" data-side={variant === "environment" ? "left" : "composer"} style={position} onKeyDown={event => { key(event); if (destination) event.stopPropagation(); }}>
      {!destination && <label className="branch-selector-search"><Icon name="search"/><input type="search" aria-label="Search branches" placeholder={repositoryName ? `Search ${repositoryName} branches` : "Search branches"} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.key !== "Enter") return;
        event.preventDefault(); event.stopPropagation();
        if (!query.trim()) close(); else void selectExact();
      }}/></label>}
      {workspace.cacheWarning && <p role="alert">{workspace.cacheWarning}</p>}
      {workspace.errors.git && <p role="alert">{workspace.errors.git}</p>}
      {!destination && !typed && (inventory.snapshot.warning || inventory.snapshot.defaultWarning) && <p role="status">{inventory.snapshot.warning ?? inventory.snapshot.defaultWarning}<button type="button" disabled={!connected} onClick={() => inventory.controller.retry()}>Retry live updates</button></p>}
      {!destination && workspace.repositoryWatchWarning && <p role="status">{workspace.repositoryWatchWarning}</p>}
      {!connected && <p>Reconnect to switch branches.</p>}
      {workspace.errors.action && <p role="alert">{workspace.errors.action}</p>}
      {workspace.pending && <button type="button" disabled={!connected || workspace.busy} onClick={() => void retryCheckout("branches")}>Retry original workspace command</button>}
      {destination ? <div className="branch-selector-destination"><p className="branch-selector-heading">Commit to</p>
        {currentBranch && <button type="button" role="menuitemradio" aria-checked={!destination.newBranch} disabled={disabled} onClick={() => { destination.onChange(false); close(); }}><Icon name="branch"/><span>{currentBranch}</span>{!destination.newBranch && <Icon name="check"/>}</button>}
        <button type="button" role="menuitemradio" aria-checked={destination.newBranch} disabled={disabled || workspace.status?.head === null} onClick={() => { destination.onChange(true); close(); }}><Icon name="plus"/><span>New branch</span>{destination.newBranch && <Icon name="check"/>}</button>
      </div> : <><div className="branch-selector-options"><p className="branch-selector-heading">Branches</p>
        {typed && (!exactMatch || branchLoading) && !branchError && <button type="button" role="menuitem" disabled={disabled || resolving} onClick={() => void selectExact()}><span>Use {typed}</span></button>}
        {branchLoading || resolving ? <p role="status">Loading branches…</p> : branchError ? <><p role="alert">Unable to load branches. {branchError}</p><button type="button" role="menuitem" disabled={!connected} onClick={() => { if (typed) search.controller.retry(); else inventory.controller.retry(); }}>Retry</button></> : <>
          {visibleBranches.map(item => { const selected = item.branch ? item.branch.ref === `refs/heads/${workspace.status?.branch}` : item.name === workspace.status?.branch; return <button type="button" role="menuitemradio" aria-checked={selected} disabled={disabled} key={item.key} onClick={() => { if (item.branch) selectBranch(item.branch); else void selectExact(item.name); }}><Icon name="branch"/><span>{item.name}{selected && uncommitted > 0 && <small>Uncommitted: {uncommitted} {uncommitted === 1 ? "file" : "files"}</small>}</span>{selected && <Icon name="check"/>}</button>; })}
          {!visibleBranches.length && !typed && <p>No branches found.</p>}
        </>}
        {!typed && inventory.snapshot.defaultError && <><p role="alert">Unable to load the default branch. {inventory.snapshot.defaultError}</p><button type="button" role="menuitem" disabled={!connected} onClick={() => inventory.controller.retry()}>Retry default branch</button></>}
        {selectionError && <p role="alert">{selectionError}</p>}
      </div>
      <hr/><button type="button" role="menuitem" disabled={disabled || workspace.status?.head === null} title={workspace.status?.head === null ? "Commit changes to create and checkout a new branch" : undefined} onClick={() => { setNewBranch(branchPrefix); setOpen("create-branch"); }}><Icon name="plus"/><span>Create and checkout new branch…</span></button></>}
    </div>, portalContainer ?? document.body)}
    {open === "create-branch" && createPortal(<dialog ref={dialog} className="branch-selector-dialog" aria-labelledby={dialogTitle} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <form onSubmit={event => { event.preventDefault(); if (canCreateBranch) void checkout(trimmedBranch, true); }}>
        <div className="branch-dialog-header"><h2 id={dialogTitle}>Create and checkout branch</h2><button type="button" className="branch-dialog-close" aria-label="Close dialog" onClick={close}><Icon name="close"/></button></div>
        <div className="branch-dialog-label"><label htmlFor={branchInputId}>Branch name</label><button type="button" onClick={() => { close(); onOpenGitSettings(); }}>Set prefix</button></div>
        <input ref={branchInput} id={branchInputId} aria-label="Branch name" value={newBranch} onChange={event => setNewBranch(event.target.value)} placeholder="new-branch" autoFocus aria-invalid={branchEndsWithSlash || branchExists || undefined}/>
        {branchEndsWithSlash ? <p className="branch-dialog-error" role="alert">Branch name cannot end with “/”.</p> : branchExists && !workspace.busy ? <p className="branch-dialog-error" role="alert">Branch already exists.</p> : null}
        {workspace.cacheWarning && <p className="branch-dialog-error" role="alert">{workspace.cacheWarning}</p>}
        {workspace.errors.action && <p className="branch-dialog-error" role="alert">{workspace.errors.action}</p>}
        {workspace.pending && <button className="branch-dialog-retry" type="button" disabled={!connected || workspace.busy} onClick={() => void retryCheckout("create-branch")}>Retry original workspace command</button>}
        <div className="branch-dialog-actions"><button className="secondary-button" type="button" onClick={close}>Close</button><button className="primary-button" type="submit" disabled={!canCreateBranch}>{workspace.busy ? <><span className="spinner"/> Create and checkout</> : "Create and checkout"}</button></div>
      </form>
    </dialog>, document.body)}
  </>;
}
