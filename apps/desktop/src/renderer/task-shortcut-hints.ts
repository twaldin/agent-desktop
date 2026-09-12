import type { ModifierReleaseResult } from "@agent-desktop/shared";
import type { AppShortcut } from "./app-shortcuts";
import { appCommandShortcutLabel } from "./app-command-bindings";
import type { MainTaskTarget } from "./main-task-targets";

export type TaskHintModifier = "meta" | "control";
export type NativeHintWatch = (modifier: TaskHintModifier, signal: AbortSignal) => Promise<ModifierReleaseResult>;
export type HintTimer = (callback: () => void, milliseconds: number) => () => void;
interface HintEventTarget {
  addEventListener(type: string, listener: EventListener, capture?: boolean): void;
  removeEventListener(type: string, listener: EventListener, capture?: boolean): void;
}

/** The macOS desktop's saved Number shortcuts target chooses the held modifier.
 * Labels themselves always come from the committed effective bindings. */
export function taskShortcutHintLabels(targets: readonly MainTaskTarget[], direction: "ltr" | "rtl", bindings: Partial<Record<AppShortcut, readonly string[]>>) {
  const ordered = direction === "rtl" ? [...targets].reverse() : targets;
  let chat: string | undefined;
  const content = new Map<string,string>();
  ordered.slice(0,9).forEach((target,index) => {
    const label = appCommandShortcutLabel(bindings,`task-tab-${index+1}` as AppShortcut);
    if (!label) return;
    if (target.kind === "chat") chat=label; else content.set(target.tabId,label);
  });
  return {chat,content};
}

/** Delivered renderer events are the fast path; an optional desktop-owned native
 * watch clears the same generation when release delivery is lost to native UI. */
export function observeTaskHintModifier(target: HintEventTarget, document: HintEventTarget & {hidden: boolean}, modifier: TaskHintModifier, changed: (shown: boolean) => void,
  timer: HintTimer = (callback,milliseconds) => { const id=setTimeout(callback,milliseconds); return () => clearTimeout(id); }, nativeWatch?: NativeHintWatch) {
  let held=false, shown=false, composing=false, disposed=false, generation=0;
  let cancel: (() => void) | undefined;
  let nativeAbort: AbortController | undefined;
  const publish = (value:boolean) => { if(shown!==value) {shown=value;changed(value);} };
  const reset = () => { nativeAbort?.abort(); nativeAbort=undefined; held=false;generation++;cancel?.();cancel=undefined;publish(false); };
  const update: EventListener = event => {
    const flags=event as KeyboardEvent;
    if(composing || flags.isComposing || document.hidden) {reset();return;}
    const next=modifier==="meta"?flags.metaKey:flags.ctrlKey;
    if(!next) {reset();return;}
    if(held) return;
    held=true;
    const token=++generation;
    cancel=timer(() => {
      if(disposed || !held || document.hidden || generation!==token) return;
      cancel=undefined; publish(true);
      if(nativeWatch) {
        const owner = nativeAbort = new AbortController();
        Promise.resolve().then(() => owner.signal.aborted ? "cancelled" : nativeWatch(modifier,owner.signal)).then(() => {
          if(!disposed && generation===token) reset();
        }, () => { if(!disposed && generation===token) reset(); });
      }
    },500);
  };
  const blur: EventListener = () => reset();
  const visibility: EventListener = () => {if(document.hidden) reset();};
  const compositionStart: EventListener = () => {composing=true;reset();};
  const compositionEnd: EventListener = () => {composing=false;};
  const listeners: [string,EventListener][]=[['keydown',update],['keyup',update],['pointermove',update],['blur',blur],['compositionstart',compositionStart],['compositionend',compositionEnd]];
  for(const [name,handler] of listeners) target.addEventListener(name,handler,true);
  document.addEventListener('visibilitychange',visibility);
  return () => {
    disposed=true;generation++;cancel?.();nativeAbort?.abort();
    for(const [name,handler] of listeners) target.removeEventListener(name,handler,true);
    document.removeEventListener('visibilitychange',visibility);
  };
}
