import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { goToLineNumber } from "./go-to-line";

interface Props {
  frame: RefObject<HTMLDivElement | null>; active: boolean; value: string;
  onOpen(): boolean; onPreview(line: number): void; onCommit(line: number): void;
  onClose(cancelPreview: boolean, focusEditor: boolean): void;
}

/** One file-panel owner; closing by Escape and closing by click-away differ. */
export function GoToLine(props: Props) {
  const current = useRef(props); current.current = props;
  const [open, setOpen] = useState(false), opened = useRef(false);
  const [text, setText] = useState(""), [invalid, setInvalid] = useState(false);
  const form = useRef<HTMLFormElement>(null), input = useRef<HTMLInputElement>(null);
  const errorId = useId(), rangeId = useId();
  const [colors, setColors] = useState<CSSProperties>();
  const close = (cancel: boolean, focus: boolean) => {
    if (!opened.current) return;
    opened.current = false; setOpen(false); current.current.onClose(cancel, focus);
  };
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const value = current.current;
      const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
      if (!value.active || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || event.shiftKey
        || (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "l") return;
      const owner = value.frame.current?.closest('[role="tabpanel"]') ?? value.frame.current;
      if (!owner || !event.composedPath().includes(owner)) return;
      event.preventDefault(); event.stopPropagation();
      if (opened.current) { input.current?.focus({ preventScroll: true }); input.current?.select(); return; }
      if (!value.onOpen()) return;
      opened.current = true; setText(""); setInvalid(false); setOpen(true);
    };
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("keydown", key, true); if (opened.current) current.current.onClose(true, false); };
  }, []);
  useEffect(() => { if (!props.active) closeRef.current(true, false); }, [props.active]);
  // A changed document invalidates the old selection snapshot; do not restore it.
  useEffect(() => { closeRef.current(false, false); }, [props.value]);
  useLayoutEffect(() => {
    if (!open) return;
    input.current?.focus({ preventScroll: true }); input.current?.select();
    const host = props.frame.current?.querySelector("diffs-container");
    if (host) {
      const syncColors = () => {
        const style = getComputedStyle(host);
        const next = { "--go-to-line-bg": style.getPropertyValue("--diffs-bg").trim() || style.backgroundColor,
          "--go-to-line-fg": style.getPropertyValue("--diffs-fg").trim() || style.color,
          "--go-to-line-modified-base": style.getPropertyValue("--diffs-modified-base").trim() || "var(--accent)" } as CSSProperties;
        setColors(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      };
      syncColors();
      const observer = new MutationObserver(syncColors);
      observer.observe(host, { attributes: true });
      if (host.shadowRoot) observer.observe(host.shadowRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
      const media = matchMedia("(prefers-color-scheme: dark)"); media.addEventListener("change", syncColors);
      return () => { observer.disconnect(); media.removeEventListener("change", syncColors); };
    }
  }, [open, props.frame]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!event.composedPath().includes(form.current!)) closeRef.current(false, false); };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);
  if (!open) return null;
  const lineCount = props.value.split(/\r\n|\r|\n/).length;
  return <div className="source-go-to-line-position"><form className="source-go-to-line" ref={form} style={colors} autoComplete="off"
    onBlurCapture={event => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      requestAnimationFrame(() => { if (!form.current?.contains(document.activeElement)) closeRef.current(false, false); });
    }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true, true); } }}
    onSubmit={event => {
      event.preventDefault(); const line = goToLineNumber(text, lineCount);
      if (line === null) { setInvalid(true); return; }
      props.onCommit(line); close(false, true);
    }}>
    <div className="source-go-to-line-row"><div className="source-go-to-line-field">
      <input ref={input} aria-label="Go to line" placeholder="Line" inputMode="numeric" type="text" value={text}
        aria-invalid={invalid || undefined} aria-describedby={`${rangeId} ${errorId}`} onChange={event => {
          const value = event.currentTarget.value; setText(value); setInvalid(false);
          const line = goToLineNumber(value, lineCount); if (line !== null) props.onPreview(line);
        }}/>
    </div><span id={rangeId} className={`source-go-to-line-range${text.trim() ? " entered" : ""}`}>1–{lineCount}</span>
      <span id={errorId} className="sr-only">Enter a valid whole line number</span></div>
    <button type="button" className="source-go-to-line-close" aria-label="Close go to line" onClick={() => close(true, true)}>
      <svg aria-hidden="true" viewBox="0 0 16 16" focusable="false"><path d="M3.75 3.75 12.25 12.25M12.25 3.75 3.75 12.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
    </button>
  </form></div>;
}
