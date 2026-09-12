import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ComposerEditor, type ComposerEditorHandle } from "../../apps/desktop/src/renderer/ComposerEditor";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

function Fixture() {
  const editor = useRef<ComposerEditorHandle>(null);
  const [text, setText] = useState("");
  Object.assign(window, {
    setComposerText(value: string) { editor.current?.replaceText(value); },
    composerStructureState() {
      const region = document.querySelector<HTMLElement>(".composer-region")!;
      const form = document.querySelector<HTMLElement>(".composer")!;
      const input = document.querySelector<HTMLElement>(".composer-rich-input")!;
      const toolbar = document.querySelector<HTMLElement>(".composer-toolbar")!;
      const placeholder = getComputedStyle(input, "::before");
      const styles = getComputedStyle(input);
      const rect = (element: HTMLElement) => {
        const value = element.getBoundingClientRect();
        return { x: value.x, y: value.y, width: value.width, height: value.height, right: value.right, bottom: value.bottom };
      };
      return {
        text,
        viewport: { width: innerWidth, height: innerHeight },
        region: rect(region), form: rect(form), input: rect(input), toolbar: rect(toolbar),
        inputStyle: { minHeight: styles.minHeight, maxHeight: styles.maxHeight, paddingBlock: styles.paddingBlock, paddingInline: styles.paddingInline, lineHeight: styles.lineHeight },
        placeholder: { content: placeholder.content, color: placeholder.color, opacity: placeholder.opacity },
        scroll: { height: input.scrollHeight, clientHeight: input.clientHeight, width: input.scrollWidth, clientWidth: input.clientWidth },
        focused: document.activeElement === input,
      };
    },
  });
  return <main className="main-panel"><div className="welcome"/><section className="composer-region"><form className="composer">
    <ComposerEditor inputRef={editor} scope="composer-structure" text={text} placeholder="Ask anything, or describe a task" onChange={value => setText(value.text)}/>
    <div className="composer-toolbar"><div className="composer-selections"><button type="button">Permissions</button></div><div className="composer-send-actions"><button className="send-button" type="button" aria-label="Send message"/></div></div>
  </form></section></main>;
}

createRoot(document.getElementById("root")!).render(<Fixture/>);
