import { useEffect, useState } from "react";
import { observeTaskHintModifier, type TaskHintModifier } from "./task-shortcut-hints";

export function useTaskShortcutHints(modifier: TaskHintModifier, enabled: boolean): boolean {
  const [state,setState]=useState<{modifier:TaskHintModifier;shown:boolean}>({modifier,shown:false});
  useEffect(() => {
    setState({modifier,shown:false});
    if(!enabled) return;
    const bridge = window.agentDesktop;
    const nativeWatch = bridge.watchModifierRelease && bridge.cancelModifierRelease
      ? (held: TaskHintModifier, signal: AbortSignal) => {
        const id = crypto.randomUUID();
        const cancel = () => { void bridge.cancelModifierRelease!(id).catch(() => {}); };
        signal.addEventListener("abort",cancel,{once:true});
        // Invoke is enqueued before cancellation; IDs fence later generations in main.
        const result = bridge.watchModifierRelease!(held,id);
        if(signal.aborted) cancel();
        return result.finally(() => signal.removeEventListener("abort",cancel));
      } : undefined;
    return observeTaskHintModifier(window,document,modifier,shown => setState({modifier,shown}),undefined,nativeWatch);
  },[modifier,enabled]);
  return enabled && state.modifier===modifier && state.shown;
}
