import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Icon } from "./Icons";
import type { TaskLocationActions, TaskLocationDestination, TaskLocationMoveTarget, TaskLocationOperation, TaskLocationSnapshot } from "./task-location";
import { sameTaskLocationOwner } from "./task-location";
import "./task-location.css";

type Captured = { token: string; snapshot: TaskLocationSnapshot; destination: TaskLocationDestination; operationId: string; reason?: string; started?: boolean };

/** The renderer only submits a host-proven destination and checkout branch. */
export function TaskLocationControl({ snapshot, actions, connected }: { snapshot: TaskLocationSnapshot; actions: TaskLocationActions; connected: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false), [captured, setCaptured] = useState<Captured>(), [submitting, setSubmitting] = useState(false), [error, setError] = useState<{ token: string; message: string }>();
  const trigger = useRef<HTMLButtonElement>(null), current = snapshot.current;
  const operation = captured && sameTaskLocationOwner(captured.snapshot, snapshot) && captured.operationId && snapshot.operation?.id === captured.operationId ? snapshot.operation : undefined;
  const busy = operation?.status === "queued" || operation?.status === "running";
  const observedOperation = snapshot.operation?.status === "succeeded" ? undefined : snapshot.operation;
  const unavailable = !connected ? "Reconnect to the owning host." : undefined;
  useEffect(() => { if (captured && !sameTaskLocationOwner(captured.snapshot, snapshot)) { setCaptured(undefined); setSubmitting(false); setError(undefined); } }, [captured, snapshot]);
  function close() { setCaptured(undefined); setSubmitting(false); setError(undefined); trigger.current?.focus({ preventScroll: true }); }
  async function start(target: TaskLocationMoveTarget) {
    if (!captured || submitting || busy || !connected || !sameTaskLocationOwner(captured.snapshot, snapshot)) return;
    setSubmitting(true); setError(undefined);
    const token = captured.token; setCaptured(value => value?.token === token ? { ...value, started: true } : value);
    try { await actions.move(captured.snapshot, target, captured.operationId); setCaptured(value => value?.token === token ? { ...value, started: true } : value); }
    catch (cause) { setError({ token, message: cause instanceof Error ? cause.message : String(cause) }); }
    finally { setSubmitting(false); }
  }
  async function recover() {
    if (!captured || !operation || submitting || !connected || !sameTaskLocationOwner(captured.snapshot, snapshot)) return;
    setSubmitting(true); setError(undefined);
    const token = captured.token;
    try { await actions.resume(snapshot, operation.id); setCaptured(value => value?.token === token ? { ...value, started: true } : value); }
    catch (cause) { setError({ token, message: cause instanceof Error ? cause.message : String(cause) }); }
    finally { setSubmitting(false); }
  }
  const availability = current.kind === "local" ? snapshot.worktree : snapshot.local, destination = availability.destination ?? observedOperation?.destination;
  const icon = current.kind === "worktree" ? "swapPanes" : "laptop", currentLabel = current.kind === "worktree" ? "Worktree" : "Local";
  return <><DropdownMenu.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}><DropdownMenu.Trigger asChild><button ref={trigger} className="environment-location-trigger" type="button" aria-label="Change task location" title={current.cwd}><Icon name={icon}/><span>{currentLabel}</span><Icon name="chevron"/></button></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="task-location-menu" aria-label="Task location" side="right" align="start" sideOffset={4} collisionPadding={8} loop={false}><DropdownMenu.Label>Continue in</DropdownMenu.Label>
      {destination && <DropdownMenu.Item className="task-location-menu-item" disabled={Boolean(unavailable)} onSelect={event => { event.preventDefault(); setMenuOpen(false); setError(undefined); setCaptured({ token: crypto.randomUUID(), snapshot: structuredClone(snapshot), destination: { ...destination }, operationId: observedOperation?.id ?? crypto.randomUUID(), reason: availability.reason, started: Boolean(observedOperation) }); }}><Icon name={destination.kind === "worktree" ? "swapPanes" : "laptop"}/><span><b>{destinationLabel(destination)}</b>{availability.reason && <small>{availability.reason}</small>}</span>{observedOperation?.destination?.cwd === destination.cwd && <span className="spinner" aria-label="Location move in progress"/>}</DropdownMenu.Item>}
      {!destination && <p className="task-location-menu-empty">{availability.reason ?? "No alternate location is available for this task."}</p>}{unavailable && <p className="task-location-menu-empty">{unavailable}</p>}
    </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
    {captured && <TaskLocationDialog captured={captured} operation={operation} connected={connected} submitting={submitting} error={error?.token === captured.token ? error.message : undefined} branches={captured.snapshot.localCheckoutBranches} pendingStart={Boolean(captured.started && !operation)} onClose={close} onStart={start} onRecover={recover}/>}</>;
}
function TaskLocationDialog({ captured, operation, connected, submitting, error, branches, pendingStart, onClose, onStart, onRecover }: { captured: Captured; operation?: TaskLocationOperation; connected: boolean; submitting: boolean; error?: string; branches: readonly string[]; pendingStart: boolean; onClose(): void; onStart(target: TaskLocationMoveTarget): void; onRecover(): void }) {
  const destination = captured.destination, toLocal=destination.kind==="local", [branch,setBranch]=useState(toLocal?destination.branch:""), active = operation?.status === "queued" || operation?.status === "running";
  const outcome = operation?.status === "succeeded" ? "Task location updated." : operation?.status === "failed" ? operation.message ?? "The task stayed in its original location." : operation?.status === "unknown" ? operation.message ?? "The operation outcome is unknown. Inspect it before retrying." : undefined;
  const blocked = !connected ? "Reconnect to the owning host." : captured.reason;
  const trimmedBranch=branch.trim(), target = toLocal ? trimmedBranch?{ kind: "local" as const, branch: trimmedBranch }:undefined : branch ? { kind: "worktree" as const, branch: destination.branch, localCheckoutBranch: branch } : undefined;
  const title=toLocal?"Bring changes back to local checkout":"Hand off chat to worktree", action=toLocal?"Bring changes back":"Hand off";
  return <Dialog.Root open onOpenChange={open => { if (!open && !submitting) onClose(); }}><Dialog.Portal><Dialog.Overlay className="task-location-overlay"/><Dialog.Content className="task-location-dialog" onCloseAutoFocus={event => event.preventDefault()}><button className="task-location-close" type="button" aria-label="Close dialog" onClick={onClose}><Icon name="close"/></button><header className="task-location-header"><Icon name="swapPanes"/><Dialog.Title>{title}</Dialog.Title></header><Dialog.Description asChild><div className="task-location-description">
    {!operation&&toLocal&&<><p>Check out branch <input autoFocus aria-label="Local branch name" value={branch} disabled={submitting} onChange={event=>setBranch(event.target.value)}/> in a local workspace and detach it from worktree.</p><div className="task-location-destination"><span>Bringing changes back to local checkout</span><button type="button" disabled aria-label={`Local workspace: ${destination.label??"Local workspace"}, ${destination.cwd}`}><b>{destination.label??"Local workspace"}</b><Icon name="chevron"/></button><small>{destination.cwd}</small></div></>}
    {!operation&&!toLocal&&<><p>Check out branch <strong>{destination.branch}</strong> in a new worktree to continue working in parallel.</p><label className="task-location-field">Local workspace will switch to<select autoFocus aria-label="Local checkout branch" value={branch} disabled={submitting} onChange={event => setBranch(event.target.value)}><option value="">Select local checkout branch</option>{branches.map(value => <option value={value} key={value}>{value}</option>)}</select></label></>}
    {pendingStart && !active && <p role="status"><span className="spinner"/> Starting location move…</p>}{active && <p role="status"><span className="spinner"/> {operation?.message ?? stepLabel(operation?.step)} You can close this dialog and reopen it to check progress.</p>}{outcome && <p role={operation?.status === "failed" || operation?.status === "unknown" ? "alert" : "status"}>{outcome}</p>}{error && <p role="alert">{error}</p>}{blocked && <p className="task-location-blocked" role="status">{blocked}</p>}
  </div></Dialog.Description><footer>{operation?.status === "unknown" && <button type="button" className="primary-button" disabled={!connected || submitting} onClick={onRecover}>{submitting ? "Checking…" : "Check original operation"}</button>}{!operation && <button type="button" className="primary-button" disabled={Boolean(blocked) || submitting || !target} onClick={() => target && onStart(target)}>{submitting ? "Starting…" : action}</button>}</footer></Dialog.Content></Dialog.Portal></Dialog.Root>;
}
function destinationLabel(destination: TaskLocationDestination) { return destination.kind === "local" ? "Local" : destination.managed ? "This local worktree" : "New local worktree"; }
function stepLabel(step: TaskLocationOperation["step"] | undefined) { return step === "capture-changes" ? "Capturing changes…" : step === "prepare-destination" ? "Preparing destination…" : step === "switch-git" ? "Switching Git state…" : step === "move-session" ? "Moving task…" : step === "record-result" ? "Recording result…" : "Validating task location…"; }
