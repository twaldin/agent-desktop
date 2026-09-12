import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  APPLICATION_COMMANDS,
  APPLICATION_RESERVED_KEYBINDINGS,
  applicationCommandDefinitions,
  resolveEffectiveApplicationBindings,
  type ApplicationCommandMetadata,
  type PrimaryNumberShortcutTarget,
} from "../../../../packages/shared/src/application-commands";
import {
  findBindingConflict,
  normalizeAccelerator,
  sameAccelerator,
  type CommandBindingUpdate,
  type CommandKeymap,
} from "../../../../packages/shared/src/command-keybindings";
import { acceleratorStroke } from "./keyboard-accelerators";
import type { CommandKeymapState } from "./command-keymap-state";
import { Icon } from "./Icons";
import "./keyboard-shortcuts-settings.css";

const priority = ["newTask", "temporaryChat", "quickChat", "archiveThread", "newProjectlessTask", "openSideChat"];
const groups = ["thread", "navigation", "panels", "workspace", "skills", "configure", "app", "ungrouped"];
const sequenceDelayMs = 1_000;
const fixedFindTitles: Record<string, string> = { findInThread: "Find", "reserved.findNext": "Find Next", "reserved.findPrevious": "Find Previous" };

export interface KeyboardShortcutsSettingsProps {
  data?: CommandKeymapState;
  /** Installed execution capabilities, independent of the current route's enabled actions. */
  supportedCommandIds: ReadonlySet<string>;
  primaryNumberShortcutTarget?: PrimaryNumberShortcutTarget;
  onChangePrimaryNumberShortcutTarget?: (target: PrimaryNumberShortcutTarget) => Promise<void>;
}

type Capture = { commandId: string; previous?: string; append: boolean; attempted?: string };

function commandOrder(left: ApplicationCommandMetadata, right: ApplicationCommandMetadata): number {
  const grouped = (left.referenceFamily === "webview" && left.group !== "ungrouped" ? groups.indexOf(left.group) : groups.length)
    - (right.referenceFamily === "webview" && right.group !== "ungrouped" ? groups.indexOf(right.group) : groups.length);
  if (grouped) return grouped;
  const leftPriority = priority.indexOf(left.id), rightPriority = priority.indexOf(right.id);
  return (leftPriority < 0 ? priority.length : leftPriority) - (rightPriority < 0 ? priority.length : rightPriority)
    || left.id.localeCompare(right.id);
}

function keymap(data: CommandKeymapState | undefined): CommandKeymap {
  const record = data?.record;
  return { overrides: record && !record.deleted ? record.value.overrides : [] };
}

function keyLabel(value: string): string {
  const order: Record<string, number> = { Ctrl: 0, Alt: 1, Shift: 2, Command: 3, CmdOrCtrl: 3 };
  return value.split(" ").map(stroke => stroke.split("+").sort((left, right) => (order[left] ?? 4) - (order[right] ?? 4))
    .map(part => ({ Command: "⌘", CmdOrCtrl: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Space: "Space" }[part] ?? part)).join(" ")).join("  ");
}

function fuzzy(value: string, query: string): boolean {
  const source = value.toLocaleLowerCase(), wanted = query.trim().toLocaleLowerCase();
  if (!wanted) return true;
  let at = 0;
  for (const character of wanted) { at = source.indexOf(character, at); if (at < 0) return false; at++; }
  return true;
}

function matchesKeystrokes(accelerator: string, prefix: string): boolean {
  const strokes = normalizeAccelerator(accelerator).split(" "), wanted = normalizeAccelerator(prefix).split(" ");
  return wanted.length <= strokes.length && wanted.every((stroke, index) => sameAccelerator(strokes[index]!, stroke, "mac"));
}

function Recorder({ title, allowsSequences, attempted, conflict, disabled, onCancel, onCommit }: {
  title: string; allowsSequences: boolean; attempted?: string; conflict?: string; disabled: boolean;
  onCancel(restoreFocus: boolean): void; onCommit(accelerator: string): void;
}) {
  const [first, setFirst] = useState<string>();
  const firstStroke = useRef<string | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const composing = useRef(false);
  const conflictId = useId();
  const clear = () => { if (timer.current !== undefined) window.clearTimeout(timer.current); timer.current = undefined; };
  const resetSequence = () => { clear(); firstStroke.current = undefined; setFirst(undefined); };
  useEffect(() => clear, []);
  useEffect(() => { if (disabled) resetSequence(); }, [disabled]);
  const cancel = (restoreFocus: boolean) => { resetSequence(); onCancel(restoreFocus); };
  const finish = (value: string) => { resetSequence(); onCommit(value); };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229 || event.getModifierState("AltGraph")) { resetSequence(); return; }
    event.preventDefault(); event.stopPropagation();
    if (event.repeat) return;
    if (event.key === "Escape" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) { cancel(true); return; }
    if (disabled) return;
    const stroke = acceleratorStroke(event.nativeEvent);
    if (!stroke) return;
    if (firstStroke.current) { finish(`${firstStroke.current} ${stroke}`); return; }
    if (!allowsSequences || stroke.includes("+")) { finish(stroke); return; }
    firstStroke.current = stroke; setFirst(stroke); clear();
    timer.current = window.setTimeout(() => finish(stroke), sequenceDelayMs);
  };
  return <div className="shortcut-recorder">
    <div>
      <input autoFocus readOnly aria-disabled={disabled} data-codex-shortcut-capture aria-label={`Shortcut capture for ${title}`} aria-invalid={Boolean(conflict)} aria-describedby={conflict ? conflictId : undefined} value={first ? `${keyLabel(first)} …` : attempted ? keyLabel(attempted) : "Press shortcut"} onBlur={() => { resetSequence(); if (!attempted && !disabled) cancel(false); }} onCompositionStart={() => { composing.current = true; resetSequence(); }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={keyDown}/>
      {attempted && !conflict && <button type="button" disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => onCommit(attempted)}>Save shortcut</button>}
      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => cancel(true)}>Cancel</button>
    </div>
    {conflict && <span id={conflictId} className="shortcut-conflict" role="alert">Used by {conflict}</span>}
  </div>;
}

function ResetAllDialog({ open, pending, disabled, error, onClose, onConfirm }: { open: boolean; pending: boolean; disabled: boolean; error?: string; onClose(): void; onConfirm(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = dialog.current; if (open && !node?.open) node?.showModal(); else if (!open && node?.open) node.close(); }, [open]);
  return <dialog ref={dialog} className="shortcut-reset-dialog" aria-labelledby="shortcut-reset-title" onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}>
    <form method="dialog" onSubmit={event => { event.preventDefault(); if (!disabled) onConfirm(); }}>
      <h2 id="shortcut-reset-title">Reset all keyboard shortcuts?</h2>
      <p>This will discard all custom shortcuts and restore the defaults.</p>
      {error && <p className="shortcut-dialog-error" role="alert">{error}</p>}
      <footer><button type="button" className="secondary-button" disabled={pending} onClick={onClose}>Cancel</button><button type="submit" className="danger-button" disabled={disabled}>{pending ? "Resetting…" : "Reset all"}</button></footer>
    </form>
  </dialog>;
}

export function KeyboardShortcutsSettings({ data, supportedCommandIds, primaryNumberShortcutTarget = "tabs", onChangePrimaryNumberShortcutTarget }: KeyboardShortcutsSettingsProps) {
  const [, redraw] = useState(0), [query, setQuery] = useState(""), [keySearch, setKeySearch] = useState(false);
  const [capture, setCapture] = useState<Capture>(), [conflict, setConflict] = useState<string>();
  const [resetOpen, setResetOpen] = useState(false), [saving, setSaving] = useState(false), [numberError, setNumberError] = useState<string>();
  const [resetError, setResetError] = useState<string>();
  const [rowErrors, setRowErrors] = useState<Record<string, string | undefined>>({});
  const captureRef = useRef<Capture | undefined>(undefined);
  const operation = useRef<symbol | undefined>(undefined);
  const owner = useRef({ data, hostId: data?.hostId });
  if (owner.current.data !== data || owner.current.hostId !== data?.hostId) owner.current = { data, hostId: data?.hostId };
  const resetOpener = useRef<HTMLButtonElement>(null);
  const captureOpener = useRef<HTMLButtonElement | undefined>(undefined);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchComposing = useRef(false);
  useEffect(() => data?.subscribe(() => redraw(value => value + 1)), [data]);
  useEffect(() => {
    setCapture(undefined); captureRef.current = undefined; setConflict(undefined); captureOpener.current = undefined;
    setRowErrors({}); setNumberError(undefined); setResetError(undefined); setResetOpen(false); operation.current = undefined; setSaving(false);
  }, [data, data?.hostId]);
  useEffect(() => { if (keySearch) searchInput.current?.focus(); }, [keySearch]);

  const current = keymap(data);
  let resolved: ReturnType<typeof resolveEffectiveApplicationBindings> | undefined, resolutionError: string | undefined;
  try { resolved = resolveEffectiveApplicationBindings(data?.record && !data.record.deleted ? data.record.value : undefined, { primaryNumberShortcutTarget }); }
  catch (cause) { resolutionError = cause instanceof Error ? cause.message : String(cause); }
  const definitions = useMemo(() => applicationCommandDefinitions({ primaryNumberShortcutTarget }), [primaryNumberShortcutTarget]);
  const definitionById = new Map(definitions.map(value => [value.id, value]));
  const effectiveById = new Map(resolved?.bindings.map(value => [value.command, value.keys]) ?? []);
  const metadata = APPLICATION_COMMANDS.filter(command => supportedCommandIds.has(command.id) && !command.goalExclusion
    && command.id !== "personalitySettings" && definitionById.get(command.id)?.configurable !== false).sort(commandOrder);
  const customIds = new Set(current.overrides.map(value => value.command));
  const unknown = current.overrides.filter(value => !definitionById.has(value.command));
  const numberConflict = Boolean(resolved && APPLICATION_COMMANDS.some(command =>
    (command.numberShortcutFamily === "tabs" || command.numberShortcutFamily === "sidebar")
    && !customIds.has(command.id) && effectiveById.get(command.id)?.length === 0));
  const writable = Boolean(data?.loaded && data.available && !saving && !data.pending && !data.busy && !data.staleEdit && !data.receiptRecoveryError && !resolutionError && unknown.length === 0);
  const retainedEdit = data?.pending?.command.mutation.edit ?? data?.staleEdit;
  const retainedDescription = retainedEdit?.type === "command"
    ? `${APPLICATION_COMMANDS.find(command => command.id === retainedEdit.commandId)?.title ?? retainedEdit.commandId}: ${"accelerator" in retainedEdit.update ? keyLabel(retainedEdit.update.accelerator) : retainedEdit.update.type === "reset" ? "Restore defaults" : "Clear shortcuts"}`
    : retainedEdit?.type === "number-target" ? `Number shortcuts: ${retainedEdit.target === "tabs" ? "Tabs" : "Chats"}`
    : retainedEdit?.type === "reset-all" ? "Reset all keyboard shortcuts" : undefined;

  const visible = metadata.filter(command => {
    if (!query.trim()) return true;
    if (!keySearch) return fuzzy(`${command.id} ${command.title} ${command.description}`, query);
    try { return (effectiveById.get(command.id) ?? []).some(key => matchesKeystrokes(key, query)); }
    catch { return false; }
  });

  // The controller reports outcomes through its durable public state, not promise rejection.
  const runOperation = async (action: () => Promise<void>, commandId?: string): Promise<boolean> => {
    if (!data || operation.current) return false;
    const currentOwner = owner.current, token = Symbol();
    operation.current = token; setSaving(true);
    if (commandId) setRowErrors(errors => ({ ...errors, [commandId]: undefined }));
    try {
      await action();
      if (owner.current !== currentOwner || data.hostId !== currentOwner.hostId) return false;
      const error = data.error ?? (data.pending || data.staleEdit ? "This shortcut change is not confirmed. Review the retained change below." : undefined);
      if (commandId) setRowErrors(errors => ({ ...errors, [commandId]: error }));
      return !error && !data.busy && !data.receiptRecoveryError;
    } catch (cause) {
      if (owner.current === currentOwner && commandId) setRowErrors(errors => ({ ...errors, [commandId]: cause instanceof Error ? cause.message : String(cause) }));
      return false;
    } finally {
      if (operation.current === token) { operation.current = undefined; setSaving(false); }
    }
  };
  const submit = async (commandId: string, update: CommandBindingUpdate): Promise<boolean> => {
    if (!data || !writable || !supportedCommandIds.has(commandId)) return false;
    return runOperation(() => data.submit({ type: "command", commandId, update }), commandId);
  };
  const begin = (commandId: string, previous: string | undefined, event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!writable || !supportedCommandIds.has(commandId)) return;
    const definition = definitionById.get(commandId);
    captureOpener.current = event.currentTarget;
    const next = { commandId, previous, append: Boolean(previous && event.shiftKey && definition?.multiple !== false) };
    setRowErrors(errors => ({ ...errors, [commandId]: undefined }));
    setConflict(undefined); captureRef.current = next; setCapture(next);
  };
  const cancelCapture = (restoreFocus: boolean) => {
    const commandId = captureRef.current?.commandId, opener = captureOpener.current;
    captureRef.current = undefined; setCapture(undefined); setConflict(undefined); captureOpener.current = undefined;
    if (restoreFocus) requestAnimationFrame(() => {
      const target = opener?.isConnected ? opener : commandId
        ? document.querySelector<HTMLButtonElement>(`[data-command-id="${CSS.escape(commandId)}"] button[aria-label^="Change shortcut"], [data-command-id="${CSS.escape(commandId)}"] button[aria-label^="Set shortcut"]`) : undefined;
      if (target && !target.disabled) target.focus(); else searchInput.current?.focus();
    });
  };
  const commit = async (command: ApplicationCommandMetadata, accelerator: string) => {
    const active = captureRef.current;
    if (!active || active.commandId !== command.id || !writable || operation.current) return;
    if (active.previous && sameAccelerator(active.previous, accelerator, "mac")) { cancelCapture(true); return; }
    const attempted = { ...active, attempted: accelerator };
    captureRef.current = attempted; setCapture(attempted); setConflict(undefined);
    setRowErrors(errors => ({ ...errors, [command.id]: undefined }));
    const admission = [
      ...APPLICATION_RESERVED_KEYBINDINGS,
      ...definitions.filter(value => value.id !== "toggleDebugModal" || supportedCommandIds.has(value.id))
        .map(value => ({ ...value, defaults: effectiveById.get(value.id) ?? value.defaults })),
    ];
    try {
      const conflicting = findBindingConflict(definitionById.get(command.id)!, accelerator, admission, current, "mac");
      if (conflicting) {
        setConflict(fixedFindTitles[conflicting.id] ?? APPLICATION_COMMANDS.find(value => value.id === conflicting.id)?.title ?? conflicting.id);
        return;
      }
    } catch (cause) {
      setRowErrors(errors => ({ ...errors, [command.id]: cause instanceof Error ? cause.message : String(cause) }));
      return;
    }
    const update: CommandBindingUpdate = active.append ? { type: "append", accelerator }
      : active.previous ? { type: "replace", previousAccelerator: active.previous, accelerator }
      : { type: "set", accelerator };
    if (await submit(command.id, update) && captureRef.current === attempted) cancelCapture(true);
  };

  const searchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!keySearch || searchComposing.current || event.nativeEvent.isComposing || event.keyCode === 229 || event.getModifierState("AltGraph")) return;
    event.preventDefault(); event.stopPropagation();
    if (event.repeat) return;
    if (event.key === "Escape" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) { setQuery(""); setKeySearch(false); return; }
    const stroke = acceleratorStroke(event.nativeEvent); if (!stroke) return;
    const candidate = query ? `${query} ${stroke}` : stroke;
    const continues = query && metadata.some(command => (effectiveById.get(command.id) ?? []).some(key => matchesKeystrokes(key, candidate)));
    setQuery(continues ? candidate : stroke);
  };
  const changeNumberTarget = async (value: PrimaryNumberShortcutTarget) => {
    if (!onChangePrimaryNumberShortcutTarget || !writable || !data?.numberTargetAvailable || operation.current) return;
    setNumberError(undefined);
    const currentOwner = owner.current;
    const confirmed = await runOperation(async () => {
      try { await onChangePrimaryNumberShortcutTarget(value); }
      catch (cause) {
        if (owner.current === currentOwner) setNumberError(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      }
    });
    if (!confirmed && owner.current === currentOwner) setNumberError(error => error ?? data.error ?? "Could not save shortcut preference");
  };
  const closeReset = () => {
    setResetOpen(false); setResetError(undefined);
    requestAnimationFrame(() => { if (resetOpener.current?.isConnected) resetOpener.current.focus(); else searchInput.current?.focus(); });
  };
  const resetAll = async () => {
    if (!data || !writable || operation.current) return;
    const currentOwner = owner.current;
    setResetError(undefined);
    if (await runOperation(() => data.submit({ type: "reset-all" }))) closeReset();
    else if (owner.current === currentOwner) setResetError(data.error ?? "Reset is not confirmed. Close this dialog to review the retained change.");
  };
  const recover = async (rebase: boolean) => {
    if (!data || !data.available || data.busy || operation.current || (rebase ? !data.staleEdit || Boolean(data.pending) : !data.pending)) return;
    const edit = data.pending?.command.mutation.edit ?? data.staleEdit, active = captureRef.current;
    if (await runOperation(() => rebase ? data.rebase() : data.retry(), edit?.type === "command" ? edit.commandId : undefined)) {
      if (edit?.type === "command" && active?.commandId === edit.commandId && captureRef.current === active) cancelCapture(true);
      if (edit?.type === "reset-all") closeReset();
      if (edit?.type === "number-target") setNumberError(undefined);
    }
  };

  if (!data) return <section className="settings-page keyboard-shortcuts-settings" aria-label="Keyboard shortcuts settings"><div className="keyboard-shortcuts-scroll"><div className="keyboard-shortcuts-column"><header><h1>Keyboard shortcuts</h1></header><div className="inline-error"><p>Keyboard shortcut settings require a local host owner.</p></div></div></div></section>;

  return <section className="settings-page keyboard-shortcuts-settings" aria-label="Keyboard shortcuts settings">
    <div className="keyboard-shortcuts-scroll"><div className="keyboard-shortcuts-column">
      <header className="keyboard-shortcuts-header"><h1>Keyboard shortcuts</h1>{customIds.size > 0 && <button ref={resetOpener} className="secondary-button" disabled={!writable} onClick={() => setResetOpen(true)}>Reset all to defaults</button>}</header>
      <div className="shortcut-search-wrap">
        <div className="shortcut-search"><Icon name="search"/><input ref={searchInput} value={query} readOnly={keySearch} disabled={!data.loaded} data-codex-shortcut-capture={keySearch || undefined} aria-label={keySearch ? "Keystroke search capture" : "Search keyboard shortcuts"} placeholder={keySearch ? "Press shortcut to search" : "Search shortcuts"} onChange={event => setQuery(event.target.value)} onCompositionStart={() => { searchComposing.current = true; }} onCompositionEnd={() => { searchComposing.current = false; }} onKeyDown={searchKey}/><button type="button" aria-label="Search by keystrokes" aria-pressed={keySearch} disabled={!data.loaded} onMouseDown={event => event.preventDefault()} onClick={() => { setQuery(""); setKeySearch(value => !value); searchInput.current?.focus(); }}><Icon name="shortcut"/></button></div>
      </div>
      <div className="shortcut-content">
      {onChangePrimaryNumberShortcutTarget && <><div className="shortcut-number-row">
        <div><h2>Number shortcuts</h2>{numberError && <p className="shortcut-inline-error" role="alert">{numberError}</p>}<p>Use ⌘1–9 to switch {primaryNumberShortcutTarget === "tabs" ? "tabs" : "chats"} and ⌃1–9 to switch {primaryNumberShortcutTarget === "tabs" ? "chats" : "tabs"}.</p>{numberConflict && <p>Some number shortcuts are already assigned to other actions</p>}</div>
        <select aria-label="Number shortcuts" value={primaryNumberShortcutTarget} disabled={!writable || !data.numberTargetAvailable} onChange={event => void changeNumberTarget(event.target.value as PrimaryNumberShortcutTarget)}><option value="tabs">⌘1-9 for Tabs</option><option value="sidebar">⌘1-9 for Chats</option></select>
      </div></>}
      {(resolutionError || data.error || data.cacheWarning || data.receiptRecoveryError) && <div className="inline-error" role="alert"><p>{resolutionError ?? data.error ?? data.cacheWarning ?? data.receiptRecoveryError}</p></div>}
      {data.loaded && !data.available && !data.error && <p className="shortcut-status" role="status">{data.connected ? "Update the owning host before editing keyboard shortcuts." : "Reconnect to the owning host to edit keyboard shortcuts."}</p>}
      {data.pending && <div className="shortcut-pending" role="status"><span>{data.busy || saving ? "Saving shortcut change…" : "The original shortcut change is awaiting confirmation."}{retainedDescription && <><br/>{retainedDescription}</>}</span>{!data.busy && <button className="secondary-button" disabled={!data.available || saving} onClick={() => void recover(false)}>Retry original change</button>}</div>}
      {(!data.loaded || data.loading) && <p className="shortcut-status" role="status">Loading shortcuts…</p>}
      {data.staleEdit && !data.pending && <div className="shortcut-stale" role="alert"><p>This shortcut change was based on an older revision. Review the latest shortcuts before applying it again.</p>{retainedDescription && <p>{retainedDescription}</p>}<div><button className="secondary-button" disabled={!data.available || data.busy || saving} onClick={() => void recover(true)}>Rebase and retry</button><button className="secondary-button" disabled={data.busy || saving} onClick={() => { data.dismissStale(); if (!data.staleEdit) cancelCapture(false); }}>Discard retained change</button></div></div>}
      {data.loaded && unknown.length > 0 && <p className="shortcut-status" role="status">Install a version that supports the preserved shortcuts below before changing this keymap.</p>}
      {data.loaded && (visible.length === 0 ? <div className="shortcut-card"><p className="shortcut-empty">No matching shortcuts</p></div> : <div className="shortcut-card">{visible.map(command => {
        const keys = effectiveById.get(command.id) ?? [], definition = definitionById.get(command.id)!;
        const custom = customIds.has(command.id) && (command.id !== "searchChats" || keys.length > 0);
        const divergent = keys.findIndex((key, index) => key !== definition.defaults[index]);
        const resetIndex = custom ? Math.max(0, divergent) : -1;
        const rowError = retainedEdit?.type === "command" && retainedEdit.commandId === command.id && data.error ? data.error : rowErrors[command.id];
        const lines: Array<string | undefined> = keys.length ? [...keys] : [undefined];
        let captureIndex = -1;
        if (capture?.commandId === command.id) {
          captureIndex = keys.length === 0 ? 0 : capture.append ? -1 : lines.indexOf(capture.previous);
          if (captureIndex < 0) { captureIndex = lines.length; lines.push(undefined); }
        }
        return <article className="shortcut-row" data-command-id={command.id} data-command-group={command.group} key={command.id} aria-labelledby={`shortcut-${command.id}`}>
          <div className="shortcut-copy"><h2 id={`shortcut-${command.id}`}>{command.title}</h2><p>{command.description}</p>{rowError && <p className="shortcut-inline-error" role="alert">{rowError}</p>}</div>
          <div className="shortcut-bindings" role="group" aria-labelledby={`shortcut-${command.id}`}>{lines.map((key, index) => {
            if (index === captureIndex) return <Recorder key="recorder" title={command.title} allowsSequences={command.referenceFamily === "webview" && definition.multiple !== false} attempted={capture?.attempted} conflict={conflict} disabled={!writable} onCancel={cancelCapture} onCommit={value => void commit(command, value)}/>;
            return <div className="shortcut-binding" key={key ?? "unassigned"}><span className={key ? "shortcut-keycap" : "shortcut-unassigned"}>{key ? keyLabel(key) : "Unassigned"}</span><button className="icon-button small" type="button" aria-label={key ? `Change shortcut for ${command.title}` : `Set shortcut for ${command.title}`} title={key && definition.multiple !== false ? "Hold Shift to add another shortcut" : undefined} disabled={!writable} onClick={event => begin(command.id, key, event)}><Icon name={key ? "pencil" : "plus"}/></button>{key && <button className="icon-button small" type="button" aria-label={`Clear shortcut for ${command.title}`} disabled={!writable} onClick={() => void submit(command.id, { type: "remove", accelerator: key })}><Icon name="close"/></button>}{index === resetIndex && <button className="icon-button small" type="button" aria-label={`Reset shortcut for ${command.title}`} disabled={!writable} onClick={() => void submit(command.id, { type: "reset" })}><Icon name="refresh"/></button>}</div>;
          })}</div>
        </article>;
      })}</div>)}
      {data.loaded && unknown.length > 0 && <section className="shortcut-unknown" aria-labelledby="unsupported-shortcuts-title"><h2 id="unsupported-shortcuts-title">Shortcuts from a newer app</h2><p>These saved bindings are preserved but cannot run or be edited by this version.</p><div className="shortcut-card">{unknown.map(value => <article className="shortcut-row" key={value.command}><div className="shortcut-copy"><h2>{value.command}</h2><span>Unsupported command</span></div><div className="shortcut-bindings">{value.keys.length ? value.keys.map((key, index) => <span className="shortcut-keycap" key={`${key}-${index}`}>{keyLabel(key)}</span>) : <span className="shortcut-unassigned">Unassigned</span>}</div></article>)}</div></section>}
      </div>
    </div></div>
    <ResetAllDialog open={resetOpen} pending={data.busy || saving} disabled={!writable} error={resetError} onClose={closeReset} onConfirm={() => void resetAll()}/>
  </section>;
}
