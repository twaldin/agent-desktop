import { useEffect, useRef, type ReactNode } from "react";
import type { CapturedFileEditorCommands } from "./SymbolNavigationControls";

interface Props {
  title: string;
  expanded: boolean;
  children: ReactNode;
  captureFileEditor(): CapturedFileEditorCommands | undefined;
  onOpen(capture: CapturedFileEditorCommands | null): void;
}

export function CommandMenuSearchButton(props: Props) {
  const button = useRef<HTMLButtonElement>(null);
  const latest = useRef(props); latest.current = props;
  const pointerCapture = useRef<CapturedFileEditorCommands | undefined>(undefined);
  const keyboardCapture = useRef<CapturedFileEditorCommands | undefined>(undefined);
  useEffect(() => {
    const trigger = button.current;
    if (!trigger) return;
    const document = trigger.ownerDocument;
    let tabFocusTransfer = false;
    const clear = () => { pointerCapture.current = undefined; keyboardCapture.current = undefined; tabFocusTransfer = false; };
    const keyDown = (event: KeyboardEvent) => {
      pointerCapture.current = undefined;
      if (event.key === "Tab" && !event.ctrlKey && !event.metaKey) {
        // Capture before focus transfer; macOS Option+Tab bypasses Pierre's indent binding.
        // Intermediate tab stops retain the original, never a visible-editor fallback.
        keyboardCapture.current = latest.current.captureFileEditor() ?? keyboardCapture.current;
        tabFocusTransfer = true;
      } else if (event.key !== "Shift" && event.key !== "Alt" && !(trigger === document.activeElement && (event.key === "Enter" || event.key === " "))) clear();
    };
    const keyUp = (event: KeyboardEvent) => { if (event.key === "Tab") tabFocusTransfer = false; };
    const focusIn = () => { if (!tabFocusTransfer) keyboardCapture.current = undefined; tabFocusTransfer = false; };
    document.addEventListener("keydown", keyDown, true);
    document.addEventListener("keyup", keyUp, true);
    document.addEventListener("focusin", focusIn, true);
    document.addEventListener("pointerdown", clear, true);
    document.defaultView?.addEventListener("blur", clear);
    return () => {
      document.removeEventListener("keydown", keyDown, true);
      document.removeEventListener("keyup", keyUp, true);
      document.removeEventListener("focusin", focusIn, true);
      document.removeEventListener("pointerdown", clear, true);
      document.defaultView?.removeEventListener("blur", clear);
    };
  }, []);
  return <button ref={button} className="icon-button small" aria-label="Search" title={props.title} aria-expanded={props.expanded}
    onPointerDown={event => { if (event.button === 0) pointerCapture.current = props.captureFileEditor(); }}
    onClick={event => {
      const original = event.detail > 0 ? pointerCapture.current : keyboardCapture.current;
      pointerCapture.current = undefined; keyboardCapture.current = undefined;
      props.onOpen(original ?? null);
    }}>
    {props.children}
  </button>;
}
