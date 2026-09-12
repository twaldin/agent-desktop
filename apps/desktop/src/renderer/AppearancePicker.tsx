import { useId, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./Icons";

/** Theme and local-font choices share the pinned searchable menu behavior. */
export function AppearancePicker({ label, value, options, disabled, customValue, searchable = true, onChange }: {
  label: string; value: string; options: { value: string; label: string }[]; disabled?: boolean; customValue?: boolean; searchable?: boolean; onChange(value: string): void;
}) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [active, setActive] = useState(0);
  const typed = useRef({ text: "", time: 0 });
  const choices = options.filter(option => !searchable || option.label.toLowerCase().includes(query.toLowerCase().trim()));
  const index = Math.min(active, choices.length - 1);
  const close = () => { setOpen(false); panel.current?.close(); trigger.current?.focus({ preventScroll: true }); };
  const choose = (next: string) => { if (!disabled && (customValue || options.some(option => option.value === next))) { close(); onChange(next); } };
  useLayoutEffect(() => {
    if (!open || disabled) { panel.current?.close(); if (open) setOpen(false); return; }
    const dialog = panel.current!, button = trigger.current!;
    dialog.showModal(); (searchable ? input.current : dialog.querySelector<HTMLElement>('[role="listbox"]'))?.focus({ preventScroll: true });
    const position = () => {
      const rect = button.getBoundingClientRect(), width = Math.min(Math.max(rect.width, 240), innerWidth - 24);
      dialog.style.width = `${width}px`; dialog.style.maxHeight = `${Math.max(100, innerHeight - 24)}px`;
      const height = dialog.getBoundingClientRect().height;
      dialog.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`;
      dialog.style.top = `${Math.max(12, Math.min(rect.bottom + 4, innerHeight - height - 12))}px`;
    };
    position(); const observer = new ResizeObserver(position); observer.observe(dialog);
    addEventListener("resize", position); return () => { observer.disconnect(); removeEventListener("resize", position); dialog.close(); };
  }, [open, disabled, searchable]);
  useLayoutEffect(() => { if (open) panel.current?.querySelector<HTMLElement>(`[data-choice-index="${index}"]`)?.scrollIntoView({ block: "nearest" }); }, [open, index]);
  return <div className="appearance-picker"><button ref={trigger} type="button" aria-label={label} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => { setQuery(""); typed.current = { text: "", time: 0 }; setActive(Math.max(0, options.findIndex(option => option.value === value))); setOpen(true); }}><span>{options.find(option => option.value === value)?.label ?? value}</span><Icon name="chevron"/></button>
    {open && <dialog ref={panel} className="appearance-picker-menu" aria-label={label} tabIndex={-1} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); setActive(event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 : Math.max(0, Math.min(choices.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))); }
        else if (event.key === "Enter") { event.preventDefault(); if (choices[index]) choose(choices[index].value); else if (customValue && query.trim()) choose(query.trim()); }
        else if (!searchable && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault(); const now = performance.now(); const prefix = `${now - typed.current.time < 1000 ? typed.current.text : ""}${event.key.toLowerCase()}`;
          let next = choices.findIndex(option => option.label.toLowerCase().startsWith(prefix));
          typed.current = { text: prefix, time: now };
          if (next < 0) { typed.current.text = event.key.toLowerCase(); next = choices.findIndex((option, at) => at > index && option.label.toLowerCase().startsWith(typed.current.text)); if (next < 0) next = choices.findIndex(option => option.label.toLowerCase().startsWith(typed.current.text)); }
          if (next >= 0) setActive(next);
        }
      }} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === panel.current) { const box = panel.current.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close(); } }}>
      {searchable && <input ref={input} type="search" role="combobox" aria-label={`Search ${label.toLowerCase()}`} placeholder="Search…" aria-expanded="true" aria-controls={`${id}-choices`} aria-activedescendant={index >= 0 ? `${id}-choice-${index}` : undefined} value={query} onChange={event => { setQuery(event.target.value); setActive(0); }}/>}      <div id={`${id}-choices`} role="listbox" aria-label={label} tabIndex={searchable ? undefined : 0} aria-activedescendant={!searchable && index >= 0 ? `${id}-choice-${index}` : undefined} className="appearance-picker-options">{choices.map((option, at) => <div key={option.value} role="option" id={`${id}-choice-${at}`} data-choice-index={at} aria-selected={option.value === value} className={at === index ? "active" : ""} onMouseEnter={() => setActive(at)} onMouseDown={event => event.preventDefault()} onClick={() => choose(option.value)}><span>{option.label}</span>{option.value === value && <Icon name="check"/>}</div>)}{customValue && query.trim() && <button type="button" onClick={() => choose(query.trim())}>Use custom font value: {query.trim()}</button>}{!choices.length && !customValue && <p>No matches</p>}</div>
    </dialog>}
  </div>;
}
