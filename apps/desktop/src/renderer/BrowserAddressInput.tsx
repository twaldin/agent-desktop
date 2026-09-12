import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { addressSuggestionPosition, addressSuggestionSelection, moveAddressSuggestion, type AddressKeyboardSelection } from "./browser-address-suggestion-state";
import { Icon } from "./Icons";
import "./browser-address-suggestions.css";

export interface BrowserAddressSuggestion {
  id: string;
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  ariaLabel?: string;
  canBeDefault: boolean;
  deleteLabel?: string;
}
export interface BrowserAddressInputProps<T extends BrowserAddressSuggestion> {
  inputRef: RefObject<HTMLInputElement | null>;
  anchorRef: RefObject<HTMLElement | null>;
  owner: string;
  value: string;
  draft: boolean;
  disabled: boolean;
  readOnly: boolean;
  suggestions?: readonly T[];
  onChange(value: string): void;
  onFocus?(): void;
  onBlur?(): void;
  onCancel(): void;
  onSubmit(): void;
  /** Selection is an intent. The caller revalidates source/destination ownership
   * and owns completion; this field never closes/replaces a launcher itself. */
  onChoose?(row: T): void;
  onDelete?(row: T): void;
}

export function BrowserAddressInput<T extends BrowserAddressSuggestion>(props: BrowserAddressInputProps<T>) {
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const [focused, setFocused] = useState(false);
  const [inComposition, setInComposition] = useState(false);
  const [keyboard, setKeyboard] = useState<AddressKeyboardSelection>();
  const [position, setPosition] = useState<ReturnType<typeof addressSuggestionPosition>>();
  const enabled = !props.disabled && !props.readOnly;
  const editing = enabled && focused && !inComposition;
  const suggestions = props.onChoose ? props.suggestions ?? [] : [];
  const view = addressSuggestionSelection(props.value, suggestions, keyboard);
  const open = editing && view.rows.length > 0;
  const expanded = open && position !== undefined;
  useLayoutEffect(() => {
    if (!enabled) { setFocused(false); setKeyboard(undefined); composing.current = false; setInComposition(false); }
  }, [enabled]);
  useLayoutEffect(() => {
    if (!open) { setPosition(undefined); return; }
    let frame = 0;
    const update = () => {
      const anchor = props.anchorRef.current;
      const next = anchor?.isConnected && anchor.getClientRects().length ? addressSuggestionPosition(anchor.getBoundingClientRect(), { width: innerWidth, height: innerHeight }) : undefined;
      setPosition(old => old?.left === next?.left && old?.top === next?.top && old?.width === next?.width && old?.maxHeight === next?.maxHeight ? old : next);
      // Layout animation can move the anchor without resizing it or scrolling.
      frame = requestAnimationFrame(update);
    };
    update();
    return () => cancelAnimationFrame(frame);
  }, [open, props.anchorRef]);
  useEffect(() => {
    const blur = () => { setFocused(false); setKeyboard(undefined); composing.current = false; setInComposition(false); };
    window.addEventListener("blur", blur);
    return () => window.removeEventListener("blur", blur);
  }, []);
  useLayoutEffect(() => {
    if (expanded && keyboard?.query === props.value && view.selectedIndex >= 0)
      list.current?.querySelectorAll<HTMLElement>('[role="option"]')[view.selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [expanded, keyboard, props.value, view.selectedIndex]);
  return <>
    <input ref={props.inputRef} data-browser-address-owner={props.owner}
      data-browser-address-draft={props.draft ? "true" : undefined} dir="ltr"
      aria-label="Page address" role="combobox" aria-expanded={expanded} aria-autocomplete={props.onChoose ? "list" : "none"}
      aria-controls={expanded ? listId : undefined}
      aria-activedescendant={expanded && view.selectedIndex >= 0 ? `${listId}-option-${view.selectedIndex}` : undefined}
      spellCheck={false} autoComplete="off" maxLength={8192} placeholder="Search or enter a URL"
      disabled={props.disabled} readOnly={props.readOnly} value={props.value}
      onFocus={() => { setFocused(true); setKeyboard(undefined); props.onFocus?.(); }}
      onPointerDown={() => { if (enabled) setFocused(true); }}
      onBlur={event => {
        if ((event.relatedTarget as HTMLElement | null)?.dataset?.browserSidebarAutocompleteDelete === "true") return;
        setFocused(false); setKeyboard(undefined); composing.current = false; setInComposition(false); props.onBlur?.();
      }}
      onChange={event => { setKeyboard(undefined); props.onChange(event.currentTarget.value); }}
      onCompositionStart={() => { composing.current = true; setInComposition(true); setKeyboard(undefined); }}
      onCompositionEnd={() => { composing.current = false; setInComposition(false); }}
      onKeyDown={event => {
        const submitKey = event.key === "Enter" || event.key === "Return";
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
          if (submitKey) event.preventDefault();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault(); event.stopPropagation(); setFocused(false); setKeyboard(undefined);
          props.onCancel(); event.currentTarget.blur(); return;
        }
        // Enter must own the form default even with modifiers: a vanished
        // selection cannot fall through to the parent's URL submit handler.
        if (submitKey) {
          event.preventDefault(); event.stopPropagation();
          if (!enabled || editing && view.missing) return;
          if (editing && view.selected) props.onChoose?.(view.selected);
          else props.onSubmit();
          return;
        }
        if (!enabled || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if ((event.key === "ArrowDown" || event.key === "ArrowUp") && open) {
          event.preventDefault(); event.stopPropagation();
          setKeyboard(moveAddressSuggestion(props.value, suggestions, event.key === "ArrowDown" ? 1 : -1, keyboard));
        }
      }}/>
    {expanded && createPortal(<div ref={list} id={listId} role="listbox" aria-label="Address suggestions"
      className="browser-address-suggestions" style={position}>
      {view.rows.map((row, index) => <div key={row.id} id={`${listId}-option-${index}`} role="option"
        aria-label={row.ariaLabel} aria-selected={index === view.selectedIndex}>
        <button type="button" tabIndex={-1} data-browser-sidebar-skip-address-commit="true"
          onPointerDown={event => event.preventDefault()}
          onClick={() => { if (enabled && !composing.current) props.onChoose?.(row); }}>
          {row.icon && <span className="browser-address-suggestion-icon" aria-hidden="true">{row.icon}</span>}
          <span className="browser-address-suggestion-copy"><span className="browser-address-suggestion-title">{row.title}</span>{row.subtitle&&<span className="browser-address-suggestion-subtitle">{row.subtitle}</span>}</span>
        </button>
        {row.deleteLabel && props.onDelete && <button type="button" className="browser-address-suggestion-delete" aria-label={row.deleteLabel}
          data-browser-sidebar-autocomplete-delete="true"
          onClick={event => { event.stopPropagation(); if (enabled && !composing.current) props.onDelete?.(row); }}><Icon name="close"/></button>}
      </div>)}
    </div>, document.body)}
  </>;
}
