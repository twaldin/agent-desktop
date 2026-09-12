import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ComposerEditor, type ComposerEditorHandle } from "../../apps/desktop/src/renderer/ComposerEditor";
import "../../apps/desktop/src/renderer/composer-editor.css";

const placeholder = "Ask anything, or describe a task";
let ownerSequence = 0;
const owners = new WeakMap<Element, number>();
const shortcuts: Array<{ key: string; meta: boolean; control: boolean; target: string }> = [];
document.addEventListener("keydown", event => shortcuts.push({ key: event.key, meta: event.metaKey, control: event.ctrlKey, target: (event.target as Element)?.id ?? "" }));
const owner = (element: Element) => {
  let value = owners.get(element);
  if (!value) { value = ++ownerSequence; owners.set(element, value); }
  return value;
};

function Fixture() {
  const editor = useRef<ComposerEditorHandle>(null);
  const [scope, setScope] = useState("empty-a"), [drafts, setDrafts] = useState({ "empty-a": "", "empty-b": "" }), [tick, setTick] = useState(0);
  const text = drafts[scope as keyof typeof drafts];
  Object.assign(window, {
    switchScope(next: "empty-a" | "empty-b") { setScope(next); },
    replace(text: string) { editor.current!.replaceText(text); },
    select(start: number, end: number) { editor.current!.setSelectionRange(start, end); },
    focusEditor() { editor.current!.focus(); },
    rerender() { setTick(value => value + 1); },
    state() {
      const input = document.querySelector<HTMLElement>("#prompt");
      if (!input) return null;
      return { scope, tick, owner: owner(input), html: input.outerHTML, placeholder: input.dataset.placeholder ?? null, empty: input.dataset.empty ?? null, ariaLabel: input.getAttribute("aria-label"), before: getComputedStyle(input, "::before").content, text: input.textContent ?? "", selection: [editor.current?.selectionStart, editor.current?.selectionEnd], shortcuts: [...shortcuts] };
    },
  });
  return <ComposerEditor inputRef={editor} scope={scope} text={text} placeholder={placeholder} onChange={({ text }) => setDrafts(current => ({ ...current, [scope]: text }))}/>;
}

createRoot(document.getElementById("root")!).render(<Fixture/>);
