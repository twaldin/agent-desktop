import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";

function channels(value: string) { return [1, 3, 5].map(start => Number.parseInt(value.slice(start, start + 2), 16) / 255); }
function hsv(value: string, previousHue: number) {
  const [r, g, b] = channels(value) as [number, number, number], high = Math.max(r, g, b), low = Math.min(r, g, b), delta = high - low;
  return { h: delta === 0 ? previousHue : ((high === r ? (g - b) / delta : high === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) % 360, s: high === 0 ? 0 : delta / high, v: high };
}
function hex(h: number, s: number, v: number) {
  return `#${[5, 3, 1].map(offset => { const k = (offset + h / 60) % 6; return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255).toString(16).padStart(2, "0"); }).join("")}`;
}
/** Hex editing and the 136px saturation/hue popover keep incomplete text local. */
export function AppearanceColor({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange(value: string): void }) {
  const [draft, setDraft] = useState<string>(), [open, setOpen] = useState(false), [hue, setHue] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null), dialog = useRef<HTMLDialogElement>(null);
  const color = hsv(value, hue), [r, g, b] = channels(value), foreground = r! * .2126 + g! * .7152 + b! * .0722 > .62 ? "#101010" : "#ffffff";
  const close = () => { setOpen(false); setDraft(undefined); dialog.current?.close(); trigger.current?.focus({ preventScroll: true }); };
  const change = (next: typeof color) => { if (disabled) return; setHue(next.h); onChange(hex(next.h, next.s, next.v)); };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    change({ ...color, s: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), v: 1 - Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)) });
  };
  useLayoutEffect(() => {
    if (!open || disabled) { dialog.current?.close(); if (open) setOpen(false); return; }
    const panel = dialog.current!; panel.showModal();
    const position = () => { const rect = trigger.current!.getBoundingClientRect(), box = panel.getBoundingClientRect(); panel.style.left = `${Math.max(12, Math.min(rect.right - box.width, innerWidth - box.width - 12))}px`; panel.style.top = `${Math.max(12, Math.min(rect.bottom + 8, innerHeight - box.height - 12))}px`; };
    position(); addEventListener("resize", position); return () => { removeEventListener("resize", position); panel.close(); };
  }, [open, disabled]);
  return <div className="appearance-color" style={{ backgroundColor: value, color: foreground }}>
    <button ref={trigger} type="button" aria-label={`Pick ${label.toLowerCase()}`} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} style={{ backgroundColor: value, borderColor: `color-mix(in srgb, ${foreground} 18%, ${value})` }} onClick={() => setOpen(true)}/>
    <input aria-label={label} type="text" spellCheck={false} disabled={disabled} value={(draft ?? value).toUpperCase()} onBlur={() => setDraft(undefined)} onChange={event => {
      const text = `#${event.target.value.toUpperCase().replace(/[^0-9A-F]/g, "").slice(0, 6)}`;
      if (/^#[0-9A-F]{6}$/.test(text)) { setDraft(undefined); onChange(text.toLowerCase()); } else setDraft(text);
    }}/>
    {open && <dialog ref={dialog} className="appearance-color-popover" aria-label={`${label} picker`} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === dialog.current) { const box = dialog.current.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close(); } }}>
      <div tabIndex={0} role="slider" aria-label={`${label} saturation and brightness`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(color.s * 100)} aria-valuetext={`${Math.round(color.s * 100)}% saturation, ${Math.round(color.v * 100)}% brightness`} className="appearance-saturation" style={{ backgroundColor: `hsl(${color.h}, 100%, 50%)` }} onPointerDown={event => {
        if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); move(event);
      }} onPointerMove={event => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) move(event);
      }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return; event.preventDefault(); const step = event.shiftKey ? .1 : .01;
        change({ ...color, s: Math.max(0, Math.min(1, color.s + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0))), v: Math.max(0, Math.min(1, color.v + (event.key === "ArrowDown" ? -step : event.key === "ArrowUp" ? step : 0))) });
      }}><span style={{ left: `${color.s * 100}%`, top: `${(1 - color.v) * 100}%`, backgroundColor: value }}/></div>
      <input className="appearance-hue" type="range" aria-label={`${label} hue`} min={0} max={360} step={1} value={color.h} onChange={event => change({ ...color, h: Number(event.target.value) })}/>
    </dialog>}
  </div>;
}
