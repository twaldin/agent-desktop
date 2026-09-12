import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icons";
import { filterModelOptions, nextModelOption, type ModelPickerOption } from "./model-picker";
import "./composer-selection-popup.css";

export interface ComposerSelectionPopupHandle { openModels(): void }

export function ComposerSelectionPopup({ modelValue, modelLabel, modelTitle, models, levels, effort, effectiveEffort, defaultEffortLabel, disabled, onModel, onEffort, onReset, commandRef }: {
  modelValue: string; modelLabel: string; modelTitle: string; models: ModelPickerOption[]; levels: string[]; effort?: string; effectiveEffort?: string; defaultEffortLabel: string; disabled: boolean;
  onModel(value: string): void; onEffort(value?: string): void; onReset(): void;
  commandRef?: Ref<ComposerSelectionPopupHandle>;
}) {
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), scrollFrame = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState<"main" | "models" | "effort">(), [query, setQuery] = useState("");
  const [position, setPosition] = useState<CSSProperties>();
  useImperativeHandle(commandRef, () => ({ openModels() {
    if (disabled || !trigger.current?.isConnected) return;
    setQuery(""); setOpen("models");
  } }), [disabled]);
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const anchor = trigger.current;
    const measure = () => {
      const box = anchor.getBoundingClientRect(), width = Math.min(open === "main" ? 256 : 330, innerWidth - 24);
      const above = box.top >= Math.min(240, innerHeight / 2);
      setPosition({ width, left: Math.max(12, Math.min(box.right - width, innerWidth - width - 12)),
        ...(above ? { bottom: innerHeight - box.top + 8, top: "auto", maxHeight: Math.max(40, Math.min(420, box.top - 20)) }
          : { top: box.bottom + 8, bottom: "auto", maxHeight: Math.max(40, Math.min(420, innerHeight - box.bottom - 20)) }) });
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(anchor);
    window.addEventListener("resize", measure); window.addEventListener("scroll", measure, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  }, [open]);
  const effortLabel = (value: string) => value === "xhigh" || value === "x-high" ? "Extra High" : value.replace(/(^|[ -])([a-z])/g, (_, prefix, letter) => prefix + letter.toUpperCase());
  const ordinal = levels.filter(level => level !== "auto" && level !== "off");
  const activeEffort = effort ?? effectiveEffort;
  const activeOrdinal = ordinal.indexOf(activeEffort ?? "");
  const close = () => { cancelAnimationFrame(scrollFrame.current!); setOpen(undefined); setQuery(""); trigger.current?.focus({ preventScroll: true }); };
  useEffect(() => { if (disabled && open) close(); }, [disabled, open]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>(open === "models" ? "input" : "input:not(:disabled),button:not(:disabled)")?.focus({ preventScroll: true }));
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) { setOpen(undefined); setQuery(""); } };
    addEventListener("pointerdown", outside); return () => { cancelAnimationFrame(frame); removeEventListener("pointerdown", outside); };
  }, [open]);
  const filtered = filterModelOptions(models, query);
  const visibleModels = filtered;
  useEffect(() => { if (open !== "models") return; const node = menu.current, frame = scrollFrame.current = requestAnimationFrame(() => { if (menu.current === node) node?.querySelector<HTMLButtonElement>(`button[aria-checked="true"]`)?.scrollIntoView({ block: "nearest" }); }); return () => cancelAnimationFrame(frame); }, [open, query, modelValue]);
  const chooseModel = (item: ModelPickerOption) => { if (disabled || item.disabled) return; onModel(item.value); close(); };
  const label = `${modelLabel}${activeEffort ? ` ${effortLabel(activeEffort)}` : ""}`;
  const moveMenuFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (!(["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) || !(event.target instanceof HTMLElement) || event.target.tagName !== "BUTTON") return;
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled):not([aria-hidden=true])") ?? [])];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  return <div className="composer-selection-popup" ref={root}>
    <button ref={trigger} type="button" className="composer-selection-trigger" aria-label="Model and reasoning effort" aria-haspopup="menu" aria-expanded={Boolean(open)} title={modelTitle} disabled={disabled} onKeyDown={event => { if (event.key === "Escape" && open) { event.preventDefault(); close(); } }} onClick={() => { if (disabled) return; if (open) close(); else setOpen("main") }}><span>{label}</span><Icon name="chevron"/></button>
    {open && position && createPortal(<div style={position} ref={menu} className={`composer-selection-menu ${open === "main" ? "composer-power-menu" : ""}`} role="menu" aria-label={open === "models" ? "Select model" : open === "effort" ? "Select effort" : "Composer selections"} onKeyDown={moveMenuFocus}>
      {open === "main" && <>
        <div className="composer-selection-header">
          {levels.length > 0 && <button role="menuitem" type="button" className="composer-effort-button" aria-label="Select effort" title="Select effort" onClick={() => { if (!disabled) setOpen("effort"); }}><Icon name="sliders"/></button>}
          <button role="menuitem" type="button" className="composer-model-summary" aria-label="Select model" onClick={() => { if (!disabled) setOpen("models"); }}><span><b>{activeEffort ? effortLabel(activeEffort) : modelLabel}<Icon name="chevron"/></b>{activeEffort && <small>{modelLabel}</small>}</span></button>
          <button type="button" aria-label="Reset composer selections" title="Reset to default" disabled={disabled || (!modelValue && !effort)} onClick={() => { if (disabled) return; onReset(); close(); }}><Icon name="refresh"/></button>
        </div>
        {ordinal.length > 0 && <div className="composer-selection-power" style={{ "--power-progress": `${activeOrdinal < 0 ? 0 : ordinal.length === 1 ? 100 : activeOrdinal / (ordinal.length - 1) * 100}%` } as CSSProperties}>
          <div className="composer-power-ticks" aria-hidden="true">{ordinal.map(level => <i key={level}/>)}</div>
          <input aria-label="Reasoning power" aria-valuetext={activeOrdinal >= 0 ? effortLabel(ordinal[activeOrdinal]!) : activeEffort ?? defaultEffortLabel} type="range" min="0" max={ordinal.length - 1} step="1" value={Math.max(0, activeOrdinal)} disabled={disabled || activeOrdinal < 0 || ordinal.length === 1} onChange={event => { if (!disabled) onEffort(ordinal[Number(event.target.value)]); }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); close(); } }}/>
          <output className="visually-hidden">{activeOrdinal >= 0 ? ordinal[activeOrdinal] : "Select effort"}</output>
        </div>}

      </>}
      {open === "models" && <><div className="composer-selection-heading"><button type="button" aria-label="Back to composer selections" onClick={() => { if (!disabled) setOpen("main"); }}><Icon name="chevron"/></button><strong>Select model</strong></div><label className="composer-selection-search"><Icon name="search"/><input type="search" aria-label="Search models" value={query} placeholder="Search model or provider" onChange={event => { setQuery(event.target.value); }} onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === "Escape") { event.preventDefault(); close(); return; } if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const index = event.key === "ArrowDown" ? nextModelOption(filtered, -1, 1) : nextModelOption(filtered, filtered.length, -1); if (index >= 0) menu.current?.querySelector<HTMLButtonElement>(`button[data-model-index="${index}"]`)?.focus(); return; } if (event.key === "Enter") { event.preventDefault(); const index = nextModelOption(filtered, -1, 1); if (index >= 0) chooseModel(filtered[index]!); } }}/></label><div className="composer-selection-options" role="menu">{visibleModels.map((item, index) => <button data-model-index={index} role="menuitemradio" aria-checked={item.value === modelValue} aria-disabled={Boolean(item.disabled)} disabled={item.disabled} key={item.value} type="button" onClick={() => chooseModel(item)}><span><b>{item.label}</b>{item.detail && <small>{item.detail}</small>}</span>{item.value === modelValue && <Icon name="check"/>}</button>)}{!filtered.length && <p>No models match this search.</p>}</div></>}
      {open === "effort" && <><div className="composer-selection-heading"><button type="button" aria-label="Back to composer selections" onClick={() => { if (!disabled) setOpen("main"); }}><Icon name="chevron"/></button><strong>Select effort</strong></div><button role="menuitemradio" aria-checked={!effort} type="button" onClick={() => { if (disabled) return; onEffort(undefined); close(); }}>{defaultEffortLabel}{!effort && <Icon name="check"/>}</button>{levels.map(level => <button role="menuitemradio" aria-checked={effort === level} key={level} type="button" onClick={() => { if (disabled) return; onEffort(level); close(); }}>{effortLabel(level)}{effort === level && <Icon name="check"/>}</button>)}</>}
    </div>, document.body)}
  </div>;
}
