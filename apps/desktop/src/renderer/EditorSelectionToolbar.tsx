import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { FileTextSelection } from "@agent-desktop/shared";
import "./editor-selection-toolbar.css";

export function EditorSelectionToolbar({ anchor, selection, onAddToChat }: { anchor: DOMRect; selection: FileTextSelection; onAddToChat: (selection: FileTextSelection) => void }) {
  const toolbar = useRef<HTMLDivElement>(null), [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => { setSize({ width: toolbar.current?.offsetWidth ?? 0, height: toolbar.current?.offsetHeight ?? 0 }); }, [selection]);
  const style = { left: Math.max(8 + size.width / 2, Math.min(window.innerWidth - 8 - size.width / 2, anchor.left + anchor.width / 2)), top: Math.max(8, anchor.top - 8 - size.height) } as CSSProperties;
  return <div ref={toolbar} className="editor-selection-toolbar" data-editor-selection-toolbar="true" style={style} role="toolbar" aria-label="Selection actions" onKeyDown={event => event.stopPropagation()}>
    <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => onAddToChat(selection)}><span>Add to chat</span></button>
  </div>;
}
