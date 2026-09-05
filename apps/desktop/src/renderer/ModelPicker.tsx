import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icons";
import { filterModelOptions, nextModelOption, type ModelPickerOption } from "./model-picker";
import "./model-picker.css";

const PAGE = 100;

/** Native dialog supplies focus containment; the searchable list keeps model identity explicit. */
export function ModelPicker({ label, value, options, disabled, title, displayValue, onChange }: {
  label: string; value: string; options: ModelPickerOption[]; disabled?: boolean; title?: string; displayValue?: string;
  onChange(value: string): void;
}) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), dialog = useRef<HTMLDialogElement>(null), search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [limit, setLimit] = useState(PAGE), [activeValue, setActiveValue] = useState<string | undefined>();
  const filtered = useMemo(() => {
    const matches = filterModelOptions(options, query);
    // The selected item remains reachable without materializing thousands of preceding rows.
    const current = matches.find(option => option.value === value);
    return !query.trim() && current ? [current, ...matches.filter(option => option !== current)] : matches;
  }, [options, query, value]);
  const selected = options.find(option => option.value === value);
  const active = filtered.findIndex(option => option.value === activeValue && !option.disabled);
  const first = nextModelOption(filtered, -1, 1);
  const activeIndex = active < 0 ? first : active;
  const visible = Math.max(limit, activeIndex + 1);
  function close() { setOpen(false); dialog.current?.close(); trigger.current?.focus({ preventScroll: true }); }
  function choose(option: ModelPickerOption) {
    if (disabled || option.disabled || !options.some(current => current.value === option.value && !current.disabled)) return;
    close(); onChange(option.value);
  }
  useLayoutEffect(() => {
    if (!open || disabled) { dialog.current?.close(); if (open) setOpen(false); return; }
    const panel = dialog.current!, button = trigger.current!;
    panel.showModal(); search.current?.focus({ preventScroll: true });
    function position() {
      const box = button.getBoundingClientRect(), width = Math.min(440, innerWidth - 24);
      panel.style.width = `${width}px`;
      panel.style.left = `${Math.max(12, Math.min(box.left, innerWidth - width - 12))}px`;
      const height = panel.getBoundingClientRect().height;
      panel.style.top = `${Math.max(12, Math.min(box.bottom + 6 + height <= innerHeight - 12 ? box.bottom + 6 : box.top - height - 6, innerHeight - height - 12))}px`;
    }
    position(); const observer = new ResizeObserver(position); observer.observe(panel);
    window.addEventListener("resize", position);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); panel.close(); };
  }, [open, disabled]);
  useLayoutEffect(() => { if (open && activeIndex >= 0) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" }); }, [open, activeIndex, id]);
  return <div className="model-picker">
    <button ref={trigger} type="button" className="model-picker-trigger" aria-label={label} aria-describedby={`${id}-selected`} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} title={title} onClick={() => { setQuery(""); setLimit(PAGE); setActiveValue(value); setOpen(true); }}>
      <span aria-hidden="true">{displayValue ?? selected?.label ?? (value || "Choose model")}</span><span className="sr-only" id={`${id}-selected`}>{selected?.label ?? (value || "Choose model")}</span><Icon name="chevron"/>
    </button>
    {open && <dialog ref={dialog} className="model-picker-dialog" aria-label={`Choose ${label.toLocaleLowerCase()}`} onCancel={event => { event.preventDefault(); close(); }} onClick={event => {
      if (event.target !== dialog.current) return;
      const bounds = dialog.current!.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    }}>
      <div className="model-picker-heading"><strong>{label}</strong><button type="button" className="icon-button small" aria-label="Close model picker" onClick={close}><Icon name="close"/></button></div>
      <div className="model-picker-search"><Icon name="search"/><input ref={search} type="search" role="combobox" aria-label="Search models" placeholder="Search model or provider" autoComplete="off" spellCheck={false} aria-controls={`${id}-list`} aria-expanded="true" aria-autocomplete="list" aria-activedescendant={activeIndex < 0 ? undefined : `${id}-option-${activeIndex}`} value={query} onChange={event => { setQuery(event.target.value); setLimit(PAGE); setActiveValue(undefined); }} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "PageDown" || event.key === "PageUp") {
          event.preventDefault(); const direction = event.key.endsWith("Down") ? 1 : -1; let next = activeIndex;
          for (let i = 0; i < (event.key.startsWith("Page") ? 8 : 1); i++) next = nextModelOption(filtered, next, direction);
          setActiveValue(filtered[next]?.value);
        } else if (event.key === "Enter") { event.preventDefault(); if (activeIndex >= 0) choose(filtered[activeIndex]!); }
      }}/></div>
      <div className="model-picker-count" role="status">{filtered.length.toLocaleString()} {filtered.length === 1 ? "model" : "models"}{visible < filtered.length ? ` · showing ${visible.toLocaleString()}` : ""}</div>
      <div className="model-picker-options" role="listbox" aria-label={label} id={`${id}-list`}>
        {filtered.slice(0, visible).map((option, index) => <div role="option" id={`${id}-option-${index}`} key={option.value} aria-selected={option.value === value} aria-disabled={Boolean(option.disabled)} className={`model-picker-option${index === activeIndex ? " active" : ""}`} onMouseEnter={() => { if (!option.disabled) setActiveValue(option.value); }} onMouseDown={event => event.preventDefault()} onClick={() => choose(option)}>
          <span className="model-picker-check">{option.value === value && <Icon name="check"/>}</span><div><span className="model-picker-name">{option.label}</span>{(option.provider || option.detail) && <span className="model-picker-detail">{[option.provider, option.detail].filter(Boolean).join(" · ")}</span>}</div>
        </div>)}
        {!filtered.length && <p className="model-picker-empty">No models match this search.</p>}
      </div>
      {visible < filtered.length && <button type="button" className="model-picker-more" onClick={() => setLimit(visible + PAGE)}>Show more models</button>}
    </dialog>}
  </div>;
}
