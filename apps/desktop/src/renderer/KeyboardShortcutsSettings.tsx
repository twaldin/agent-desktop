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

export interface KeyboardShortcutsSettingsProps {
  data?: CommandKeymapState;
  /** Commands with a real installed dispatcher. Catalogue membership alone is not execution support. */
  supportedCommandIds: ReadonlySet<string>;
  primaryNumberShortcutTarget?: PrimaryNumberShortcutTarget;
  onChangePrimaryNumberShortcutTarget?: (target: PrimaryNumberShortcutTarget) => Promise<void>;
}

type Capture = { commandId: string; previous?: string; append: boolean };

function commandOrder(left: ApplicationCommandMetadata, right: ApplicationCommandMetadata): number {
  const leftPriority = priority.indexOf(left.id), rightPriority = priority.indexOf(right.id);
  if (leftPriority >= 0 || rightPriority >= 0) return (leftPriority < 0 ? priority.length : leftPriority) - (rightPriority < 0 ? priority.length : rightPriority);
  const grouped = groups.indexOf(left.group) - groups.indexOf(right.group);
  return grouped || left.id.localeCompare(right.id);
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

function Recorder({ title, allowsSequences, conflict, disabled, onCancel, onCommit }: {
  title: string; allowsSequences: boolean; conflict?: string; disabled: boolean;
  onCancel(restoreFocus: boolean): void; onCommit(accelerator: string): void;
}) {
  const [first, setFirst] = useState<string>();
  const timer = useRef<number | undefined>(undefined);
  const composing = useRef(false);
  const conflictId = useId();
  const clear = () => { if (timer.current !== undefined) window.clearTimeout(timer.current); timer.current = undefined; };
  useEffect(() => clear, []);
  const cancel = (restoreFocus: boolean) => { clear(); setFirst(undefined); onCancel(restoreFocus); };
  const finish = (value: string) => { clear(); setFirst(undefined); onCommit(value); };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.repeat || composing.current || event.nativeEvent.isComposing || event.keyCode === 229 || event.getModifierState("AltGraph")) return;
    if (event.key === "Escape" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault(); event.stopPropagation(); cancel(true); return;
    }
    const stroke = acceleratorStroke(event.nativeEvent);
    if (!stroke) return;
    event.preventDefault(); event.stopPropagation();
    if (first) { finish(`${first} ${stroke}`); return; }
    if (!allowsSequences || stroke.includes("+")) { finish(stroke); return; }
    setFirst(stroke); clear(); timer.current = window.setTimeout(() => finish(stroke), sequenceDelayMs);
  };
  return <div className="shortcut-recorder">
    <div>
      <input autoFocus readOnly disabled={disabled} data-codex-shortcut-capture aria-label={`Shortcut capture for ${title}`} aria-invalid={Boolean(conflict)} aria-describedby={conflict ? conflictId : undefined} value={first ? `${keyLabel(first)} …` : "Press shortcut"} onBlur={() => cancel(false)} onCompositionStart={() => { composing.current = true; clear(); setFirst(undefined); }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={keyDown}/>
      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => cancel(true)}>Cancel</button>
    </div>
    {conflict && <span id={conflictId} className="shortcut-conflict" role="alert">Used by {conflict}</span>}
  </div>;
}

function ResetAllDialog({ open, pending, error, onClose, onConfirm }: { open: boolean; pending: boolean; error?: string; onClose(): void; onConfirm(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = dialog.current; if (open && !node?.open) node?.showModal(); else if (!open && node?.open) node.close(); }, [open]);
  return <dialog ref={dialog} className="shortcut-reset-dialog" aria-labelledby="shortcut-reset-title" onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}>
    <form method="dialog" onSubmit={event => { event.preventDefault(); onConfirm(); }}>
      <h2 id="shortcut-reset-title">Reset all keyboard shortcuts?</h2>
      <p>This will discard all custom shortcuts and restore the defaults.</p>
      {error && <p className="shortcut-dialog-error" role="alert">{error}</p>}
      <footer><button type="button" className="secondary-button" disabled={pending} onClick={onClose}>Cancel</button><button type="submit" className="danger-button" disabled={pending}>{pending ? "Resetting…" : "Reset all"}</button></footer>
    </form>
  </dialog>;
}

export function KeyboardShortcutsSettings({ data, supportedCommandIds, primaryNumberShortcutTarget = "tabs", onChangePrimaryNumberShortcutTarget }: KeyboardShortcutsSettingsProps) {
  const [, redraw] = useState(0), [query, setQuery] = useState(""), [keySearch, setKeySearch] = useState(false);
  const [capture, setCapture] = useState<Capture>(), [conflict, setConflict] = useState<string>();
  const [resetOpen, setResetOpen] = useState(false), [numberPending, setNumberPending] = useState(false), [numberError, setNumberError] = useState<string>();
  const resetOpener = useRef<HTMLButtonElement>(null);
  const captureOpener = useRef<HTMLButtonElement | undefined>(undefined);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchComposing = useRef(false);
  useEffect(() => data?.subscribe(() => redraw(value => value + 1)), [data]);
  useEffect(() => { setCapture(undefined); setConflict(undefined); captureOpener.current = undefined; }, [data, data?.hostId]);
  useEffect(() => { if (keySearch) searchInput.current?.focus(); }, [keySearch]);

  const current = keymap(data);
  let resolved: ReturnType<typeof resolveEffectiveApplicationBindings> | undefined, resolutionError: string | undefined;
  try { resolved = resolveEffectiveApplicationBindings(data?.record && !data.record.deleted ? data.record.value : undefined, { primaryNumberShortcutTarget }); }
  catch (cause) { resolutionError = cause instanceof Error ? cause.message : String(cause); }
  const definitions = useMemo(() => applicationCommandDefinitions({ primaryNumberShortcutTarget }), [primaryNumberShortcutTarget]);
  const definitionById = new Map(definitions.map(value => [value.id, value]));
  const effectiveById = new Map(resolved?.bindings.map(value => [value.command, value.keys]) ?? []);
  const metadata = [...APPLICATION_COMMANDS].filter(command => !command.goalExclusion && definitionById.get(command.id)?.configurable !== false).sort(commandOrder);
  const customIds = new Set(current.overrides.map(value => value.command));
  const unknown = current.overrides.filter(value => !definitionById.has(value.command));
  const writable = Boolean(data?.loaded && data.available && !data.pending && !data.busy && !data.staleEdit && !data.receiptRecoveryError && !resolutionError && unknown.length === 0);

  const visible = metadata.filter(command => {
    if (!query.trim()) return true;
    if (!keySearch) return fuzzy(`${command.id} ${command.title} ${command.description}`, query);
    try { return (effectiveById.get(command.id) ?? []).some(key => {
      const normalized = normalizeAccelerator(query);
      return sameAccelerator(key, normalized, "mac") || normalizeAccelerator(key).startsWith(`${normalized} `);
    }); } catch { return false; }
  });

  const submit = async (commandId: string, update: CommandBindingUpdate) => {
    if (!data || !writable || !supportedCommandIds.has(commandId)) return;
    await data.submit({ type: "command", commandId, update });
  };
  const begin = (commandId: string, previous: string | undefined, event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!writable || !supportedCommandIds.has(commandId)) return;
    const definition = definitionById.get(commandId);
    captureOpener.current = event.currentTarget;
    setConflict(undefined); setCapture({ commandId, previous, append: Boolean(previous && event.shiftKey && definition?.multiple !== false) });
  };
  const cancelCapture = (restoreFocus: boolean) => {
    const commandId = capture?.commandId, opener = captureOpener.current;
    setCapture(undefined); setConflict(undefined); captureOpener.current = undefined;
    if (restoreFocus) requestAnimationFrame(() => {
      if (opener?.isConnected) opener.focus();
      else if (commandId) document.querySelector<HTMLButtonElement>(`[data-command-id="${CSS.escape(commandId)}"] button[aria-label^="Change shortcut"], [data-command-id="${CSS.escape(commandId)}"] button[aria-label^="Set shortcut"]`)?.focus();
    });
  };
  const commit = async (command: ApplicationCommandMetadata, accelerator: string) => {
    const active = capture;
    if (!active || active.commandId !== command.id) return;
    if (active.previous && sameAccelerator(active.previous, accelerator, "mac")) { setCapture(undefined); return; }
    setConflict(undefined);
    const eligibleIds = new Set([...supportedCommandIds, "findInThread", ...APPLICATION_RESERVED_KEYBINDINGS.map(value => value.id)]);
    const eligible = [
      ...definitions.filter(value => eligibleIds.has(value.id)).map(value => ({ ...value, defaults: effectiveById.get(value.id) ?? value.defaults, sharesBindingsWith: value.sharesBindingsWith?.filter(id => eligibleIds.has(id)) })),
      ...APPLICATION_RESERVED_KEYBINDINGS,
    ];
    const owner = findBindingConflict(definitionById.get(command.id)!, accelerator, eligible, current, "mac");
    if (owner) { setConflict(APPLICATION_COMMANDS.find(value => value.id === owner.id)?.title ?? ({ "reserved.findNext": "Find Next", "reserved.findPrevious": "Find Previous" }[owner.id] ?? owner.id)); return; }
    const update: CommandBindingUpdate = active.append ? { type: "append", accelerator }
      : active.previous ? { type: "replace", previousAccelerator: active.previous, accelerator }
      : { type: "set", accelerator };
    await submit(command.id, update); setCapture(undefined); setConflict(undefined);
  };

  const searchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!keySearch || event.repeat || searchComposing.current || event.nativeEvent.isComposing || event.keyCode === 229 || event.getModifierState("AltGraph")) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === "Escape" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) { setQuery(""); setKeySearch(false); return; }
    const stroke = acceleratorStroke(event.nativeEvent); if (!stroke) return;
    const candidate = query ? `${query} ${stroke}` : stroke;
    const continues = query && metadata.some(command => (effectiveById.get(command.id) ?? []).some(key => sameAccelerator(key, candidate, "mac") || normalizeAccelerator(key).startsWith(`${normalizeAccelerator(candidate)} `)));
    setQuery(continues ? candidate : stroke);
  };
  const changeNumberTarget = (value: PrimaryNumberShortcutTarget) => {
    if (!onChangePrimaryNumberShortcutTarget || numberPending || !data?.loaded || !data.available || data.pending || data.busy || data.staleEdit || data.receiptRecoveryError) return;
    setNumberPending(true); setNumberError(undefined);
    void onChangePrimaryNumberShortcutTarget(value)
      .catch(cause => setNumberError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setNumberPending(false));
  };
  const closeReset = () => { setResetOpen(false); requestAnimationFrame(() => resetOpener.current?.focus()); };

  if (!data) return <section className="settings-page keyboard-shortcuts-settings" aria-label="Keyboard shortcuts settings"><div className="keyboard-shortcuts-scroll"><div className="keyboard-shortcuts-column"><header><h1>Keyboard shortcuts</h1></header><div className="inline-error"><p>Keyboard shortcut settings require a local host owner.</p></div></div></div></section>;

  return <section className="settings-page keyboard-shortcuts-settings" aria-label="Keyboard shortcuts settings">
    <div className="keyboard-shortcuts-scroll"><div className="keyboard-shortcuts-column">
      <header className="keyboard-shortcuts-header"><h1>Keyboard shortcuts</h1>{customIds.size > 0 && <button ref={resetOpener} className="secondary-button" disabled={!writable} onClick={() => setResetOpen(true)}>Reset all to defaults</button>}</header>
      <div className="shortcut-search-wrap">
        <div className="shortcut-search"><Icon name="search"/><input ref={searchInput} value={query} readOnly={keySearch} disabled={!data.loaded} data-codex-shortcut-capture={keySearch || undefined} aria-label={keySearch ? "Keystroke search capture" : "Search keyboard shortcuts"} placeholder={keySearch ? "Press shortcut to search" : "Search shortcuts"} onChange={event => setQuery(event.target.value)} onCompositionStart={() => { searchComposing.current = true; }} onCompositionEnd={() => { searchComposing.current = false; }} onKeyDown={searchKey}/><button type="button" aria-label="Search by keystrokes" aria-pressed={keySearch} disabled={!data.loaded} onMouseDown={event => event.preventDefault()} onClick={() => { setQuery(""); setKeySearch(value => !value); }}><Icon name="shortcut"/></button></div>
      </div>
      <div className="shortcut-content">
      {onChangePrimaryNumberShortcutTarget && <><div className="shortcut-number-row">
        <div><h2>Number shortcuts</h2><p>Use ⌘1–9 to switch {primaryNumberShortcutTarget === "tabs" ? "tabs" : "chats"} and ⌃1–9 to switch {primaryNumberShortcutTarget === "tabs" ? "chats" : "tabs"}.</p></div>
        <select aria-label="Number shortcuts" value={primaryNumberShortcutTarget} disabled={!onChangePrimaryNumberShortcutTarget || numberPending || !data.loaded || !data.numberTargetAvailable || Boolean(data.pending || data.busy || data.staleEdit || data.receiptRecoveryError)} onChange={event => changeNumberTarget(event.target.value as PrimaryNumberShortcutTarget)}><option value="tabs">⌘1-9 for Tabs</option><option value="sidebar">⌘1-9 for Chats</option></select>
      </div>{numberError && <p className="shortcut-inline-error" role="alert">{numberError}</p>}</>}
      {(resolutionError || data.error || data.cacheWarning || data.receiptRecoveryError) && <div className="inline-error"><p>{resolutionError ?? data.error ?? data.cacheWarning ?? data.receiptRecoveryError}</p>{data.pending && <button disabled={!data.available || data.busy} onClick={() => void data.retry()}>Retry original change</button>}</div>}
      {data.loaded && !data.available && !data.error && <p className="shortcut-status" role="status">{data.connected ? "Update the owning host before editing keyboard shortcuts." : "Reconnect to the owning host to edit keyboard shortcuts."}</p>}
      {data.pending && !data.error && <div className="shortcut-pending" role="status"><span>{data.busy ? "Saving shortcut change…" : "The original shortcut change is awaiting confirmation."}</span>{!data.busy && <button className="secondary-button" disabled={!data.available} onClick={() => void data.retry()}>Retry original change</button>}</div>}
      {(!data.loaded || data.loading) && <p className="shortcut-status" role="status">Loading shortcuts…</p>}
      {data.staleEdit && <div className="shortcut-stale" role="alert"><p>This shortcut change was based on an older revision. Review the latest shortcuts before applying it again.</p><div><button className="secondary-button" disabled={!data.available || data.busy} onClick={() => void data.rebase()}>Rebase and retry</button><button className="secondary-button" disabled={data.busy} onClick={() => data.dismissStale()}>Discard retained change</button></div></div>}
      {data.loaded && unknown.length > 0 && <p className="shortcut-status" role="status">Install a version that supports the preserved shortcuts below before changing this keymap.</p>}
      {data.loaded && (visible.length === 0 ? <div className="shortcut-card"><p className="shortcut-empty">No matching shortcuts</p></div> : <div className="shortcut-card">{visible.map(command => {
        const keys = effectiveById.get(command.id) ?? [], supported = supportedCommandIds.has(command.id), definition = definitionById.get(command.id)!;
        const lines: Array<string | undefined> = keys.length ? [...keys] : [undefined];
        if (capture?.commandId === command.id && capture.append && keys.length) lines.push(undefined);
        return <article className="shortcut-row" data-command-id={command.id} data-command-group={command.group} key={command.id} aria-labelledby={`shortcut-${command.id}`}>
          <div className="shortcut-copy"><h2 id={`shortcut-${command.id}`}>{command.title}</h2><p>{command.description}</p>{!supported && <span>Unavailable until this command has an installed action.</span>}</div>
          <div className="shortcut-bindings" role="group" aria-labelledby={`shortcut-${command.id}`}>{lines.map((key, index) => {
            const recording = capture?.commandId === command.id && (capture.append ? key === undefined && index === lines.length - 1 : capture.previous === key);
            if (recording) return <Recorder key={`record-${index}`} title={command.title} allowsSequences={command.referenceFamily === "webview" && definition.multiple !== false} conflict={conflict} disabled={!writable} onCancel={cancelCapture} onCommit={value => void commit(command, value)}/>;
            return <div className="shortcut-binding" key={key ?? "unassigned"}><span className={key ? "shortcut-keycap" : "shortcut-unassigned"}>{key ? keyLabel(key) : "Unassigned"}</span><button className="icon-button small" type="button" aria-label={key ? `Change shortcut for ${command.title}` : `Set shortcut for ${command.title}`} disabled={!writable || !supported} onClick={event => begin(command.id, key, event)}><Icon name={key ? "pencil" : "plus"}/></button>{key && <button className="icon-button small" type="button" aria-label={`Clear shortcut for ${command.title}`} disabled={!writable || !supported} onClick={() => void submit(command.id, { type: "remove", accelerator: key })}><Icon name="close"/></button>}{index === 0 && customIds.has(command.id) && <button className="icon-button small" type="button" aria-label={`Reset shortcut for ${command.title}`} disabled={!writable || !supported} onClick={() => void submit(command.id, { type: "reset" })}><Icon name="refresh"/></button>}</div>;
          })}</div>
        </article>;
      })}</div>)}
      {data.loaded && unknown.length > 0 && <section className="shortcut-unknown" aria-labelledby="unsupported-shortcuts-title"><h2 id="unsupported-shortcuts-title">Shortcuts from a newer app</h2><p>These saved bindings are preserved but cannot run or be edited by this version.</p><div className="shortcut-card">{unknown.map(value => <article className="shortcut-row" key={value.command}><div className="shortcut-copy"><h2>{value.command}</h2><span>Unsupported command</span></div><div className="shortcut-bindings">{value.keys.length ? value.keys.map((key, index) => <span className="shortcut-keycap" key={`${key}-${index}`}>{keyLabel(key)}</span>) : <span className="shortcut-unassigned">Unassigned</span>}</div></article>)}</div></section>}
      </div>
    </div></div>
    <ResetAllDialog open={resetOpen} pending={data.busy} error={resetOpen ? data.error : undefined} onClose={closeReset} onConfirm={() => { void data.submit({ type: "reset-all" }).then(() => { if (!data.error && !data.pending && !data.staleEdit) closeReset(); }); }}/>
  </section>;
}
