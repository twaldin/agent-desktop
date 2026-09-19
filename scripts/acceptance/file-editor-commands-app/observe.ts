import type { Editor } from "@pierre/diffs/edit";
import type { SymbolSelection } from "../../../packages/shared/src/symbol-navigation";

export interface OriginalEditorObservation {
  owner: string | undefined;
  label: string | null | undefined;
  focused: boolean;
  inputConnected: boolean;
  inputVisible: boolean;
  native: { text: string; selections: SymbolSelection[] | undefined } | undefined;
  busy: boolean | undefined;
  navigationMessage: string | undefined;
  revealPending: boolean | undefined;
  model: "pending" | "no-selection" | "selected";
  domSelection: string | undefined;
  messages: string[];
  buttons: Array<{ text: string | null; disabled: boolean }>;
  choices: number;
}

/** Serializable main-world observer. No commands, focus changes or selection writes.
 * A symbol-command capture legitimately has no result before the first caret;
 * this reads the original editor's independent public document/state contract. */
export function observeOriginalFileEditors(): OriginalEditorObservation[] {
  type ReadonlyEditor = Pick<Editor<undefined>, "getText" | "getState">;
  type Navigation = { busy: boolean; message: string; pending?: { request: { id: string } } };
  type Hook = { memoizedState?: unknown; next?: Hook };
  type Fiber = { memoizedProps?: { documentKey?: string; symbolNavigation?: { navigation: Navigation } }; memoizedState?: Hook; return?: Fiber; alternate?: Fiber };
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
  const editor = (value: unknown): value is ReadonlyEditor => record(value) && typeof value.getText === "function" && typeof value.getState === "function";
  return [...document.querySelectorAll<HTMLElement>(".pierre-source-editor-frame[data-symbol-owner]")].filter(frame => frame.getClientRects().length > 0).map((frame): OriginalEditorObservation => {
    const root = frame.querySelector("diffs-container")?.shadowRoot, input = root?.querySelector<HTMLElement>('[contenteditable="true"]');
    const inputStyle = input && getComputedStyle(input);
    const inputVisible = Boolean(input?.isConnected && input.isContentEditable && !frame.closest("[hidden], [inert]")
      && [...input.getClientRects()].some(rect => rect.width > 0 && rect.height > 0)
      && inputStyle?.visibility !== "hidden" && inputStyle?.visibility !== "collapse");
    const key = Object.keys(frame).find(key => key.startsWith("__reactFiber"));
    // This DOM node's React attachment is in-process metadata; exact frame-ref
    // identity below prevents an ancestor/sibling editor from becoming a fallback.
    const fields = frame as unknown as Record<string, Fiber>, first = key ? fields[key] : undefined;
    const candidates = new Map<ReadonlyEditor, Navigation | undefined>();
    for (const branch of [first, first?.alternate]) {
      for (let component = branch?.return; component; component = component.return) {
        if (!component.memoizedProps || component.memoizedProps.documentKey !== frame.dataset.symbolOwner) continue;
        let ownsFrame = false;
        const instances: ReadonlyEditor[] = [];
        for (let hook = component.memoizedState; hook; hook = hook.next) {
          const state = hook.memoizedState;
          if (!record(state) || !("current" in state)) continue;
          const value = state.current;
          if (value === frame) ownsFrame = true;
          if (record(value) && editor(value.editor)) instances.push(value.editor);
        }
        if (!ownsFrame) continue;
        for (const instance of instances) candidates.set(instance, component.memoizedProps.symbolNavigation?.navigation);
        break;
      }
    }
    if (candidates.size > 1) throw new Error("The exact rendered frame has ambiguous original editor instances: " + frame.dataset.symbolOwner);
    const entry = candidates.entries().next().value;
    const state = entry?.[0].getState();
    const native = entry ? { text: entry[0].getText(), selections: state?.selections?.map(selection => ({
      start: { line: selection.start.line + 1, column: selection.start.character + 1 },
      end: { line: selection.end.line + 1, column: selection.end.character + 1 },
      direction: selection.direction === -1 ? "backward" as const : "forward" as const,
    })) } : undefined;
    // Chromium supports a shadow-local Selection although lib.dom's declaration
    // may omit that optional method. It is diagnostic, not the model authority.
    const selectionRoot = root as (ShadowRoot & { getSelection?: () => Selection }) | null | undefined;
    return { owner: frame.dataset.symbolOwner, label: input?.getAttribute("aria-label"), focused: Boolean(input && root?.activeElement === input),
      inputConnected: Boolean(input?.isConnected), inputVisible, native, busy: entry?.[1]?.busy,
      navigationMessage: entry?.[1]?.message, revealPending: entry?.[1] ? Boolean(entry[1].pending) : undefined,
      model: !native ? "pending" : native.selections?.length ? "selected" : "no-selection", domSelection: selectionRoot?.getSelection?.()?.toString(),
      messages: [...frame.querySelectorAll('[role="status"]')].map(node => node.textContent ?? ""),
      buttons: [...frame.querySelectorAll<HTMLButtonElement>(".symbol-navigation button")].map(button => ({ text: button.textContent, disabled: button.disabled })),
      choices: frame.querySelectorAll(".symbol-definition-choices button").length };
  });
}
