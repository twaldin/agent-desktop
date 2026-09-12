import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { goToLineNumber } from "./go-to-line";

const lineCommands = new WeakMap<Element, () => void>();

/** Resolve only the focused mounted file owner, including its shadow editor. */
export function goToLineCommand(root: HTMLElement, origin: Element | null): (() => void) | undefined {
  let element: Element | null = origin;
  while (element && root.contains(element)) {
    const command = lineCommands.get(element);
    if (command && element.isConnected && !element.closest("[hidden], [inert]") && element.getClientRects().length) return command;
    element = element.parentElement;
  }
  const panel = origin?.closest("[data-dock-content-id]");
  if (!panel || !root.contains(panel)) return;
  for (const frame of panel.querySelectorAll<HTMLElement>("[data-go-to-line-owner]")) {
    const command = lineCommands.get(frame);
    if (command && frame.isConnected && !frame.closest("[hidden], [inert]") && frame.getClientRects().length) return command;
  }
}

interface Props {
  appearance?: "pierre" | "codemirror";
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
  // The parent frame ref attaches after this child's layout effects.
  useEffect(() => {
    const frame = props.frame.current;
    if (!frame || !props.active) return;
    const open = () => {
      const value = current.current;
      if (lineCommands.get(frame) !== open || !frame.isConnected || value.frame.current !== frame || !value.active || frame.closest("[hidden], [inert]")) return;
      if (opened.current) { input.current?.focus({ preventScroll: true }); input.current?.select(); return; }
      if (!value.onOpen()) return;
      opened.current = true; setText(""); setInvalid(false); setOpen(true);
    };
    lineCommands.set(frame, open);
    frame.setAttribute("data-go-to-line-owner", "");
    return () => { lineCommands.delete(frame); frame.removeAttribute("data-go-to-line-owner"); if (opened.current) closeRef.current(true, false); };
  }, [props.active, props.frame]);
  useEffect(() => { if (!props.active) closeRef.current(true, false); }, [props.active]);
  // A changed document invalidates the old selection snapshot; do not restore it.
  useEffect(() => { closeRef.current(false, false); }, [props.value]);
  useLayoutEffect(() => {
    if (!open) return;
    input.current?.focus({ preventScroll: true }); input.current?.select();
    const host = props.appearance === "codemirror" ? null : props.frame.current?.querySelector("diffs-container");
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
  const closeButton = <button type="button" className="source-go-to-line-close" aria-label="Close go to line" onClick={() => close(true, true)}>
      <svg aria-hidden="true" viewBox="0 0 16 16" focusable="false">{props.appearance === "codemirror" ? <path d="M10.962 4.29539C11.1669 4.09057 11.4992 4.09076 11.7042 4.29539C11.9092 4.50039 11.9091 4.83255 11.7042 5.03758L8.74229 7.99949L11.7052 10.9624C11.9097 11.1673 11.9097 11.4996 11.7052 11.7046C11.5003 11.9095 11.168 11.9093 10.963 11.7046L8.0001 8.74168L5.03721 11.7046C4.83216 11.9093 4.49994 11.9095 4.29502 11.7046C4.09047 11.4996 4.09045 11.1673 4.29502 10.9624L7.25791 7.99949L4.296 5.03758C4.09101 4.83255 4.09099 4.5004 4.296 4.29539C4.50105 4.09079 4.8333 4.09054 5.03819 4.29539L8.0001 7.2573L10.962 4.29539Z" fill="currentColor"/> : <path d="M3.75 3.75 12.25 12.25M12.25 3.75 3.75 12.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>}</svg>
    </button>;
  return <div className={`source-go-to-line-position${props.appearance === "codemirror" ? " codemirror-go-to-line-position" : ""}`}><form className={`source-go-to-line${props.appearance === "codemirror" ? " codemirror-go-to-line" : ""}`} ref={form} style={colors} autoComplete="off"
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
      {props.appearance === "codemirror" && <span className="codemirror-go-to-line-label" aria-hidden="true">Line</span>}
      <input ref={input} aria-label="Go to line" placeholder={props.appearance === "codemirror" ? undefined : "Line"} inputMode="numeric" type="text" value={text}
        aria-invalid={invalid || undefined} aria-describedby={rangeId} aria-errormessage={invalid ? errorId : undefined} onChange={event => {
          const value = event.currentTarget.value; setText(value); setInvalid(false);
          const line = goToLineNumber(value, lineCount); if (line !== null) props.onPreview(line);
        }}/>
    </div><span id={rangeId} className={`source-go-to-line-range${text.trim() ? " entered" : ""}`}>1–{lineCount}</span>
      <span id={errorId} className="sr-only">Enter a valid whole line number</span></div>
    {props.appearance === "codemirror" ? <div className="codemirror-go-to-line-close-region"><span aria-hidden="true"/>{closeButton}</div> : closeButton}
  </form></div>;
}
