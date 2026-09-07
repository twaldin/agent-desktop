import { useCallback, useEffect, useId, useReducer, useRef, useState, type ReactNode } from "react";
import type { DockTab } from "./dock-state";
import type { NativeSkillFileController } from "./native-skill-file-state";
import type { WorkspaceState } from "./workspace-state";

interface CloseDecision {
  tabId: string;
  path: string;
  buffer: {
    subscribe(listener:()=>void):()=>void;
    save():Promise<boolean>;
    clean():boolean;
    error():string|undefined;
    canDiscard():boolean;
    discard():Promise<boolean>;
  };
  resolve(allowed: boolean): void;
}

/** Coordinates file saves and the explicit discard decision before DockPanel
 * removes a tab. The workspace resolver retains owner identity in App. */
export function useWorkspaceFileClose(resolveWorkspace: (tab: DockTab) => WorkspaceState | undefined, resolveSkillFile?: (tab:DockTab)=>NativeSkillFileController|undefined): {
  onBeforeClose(tab: DockTab): Promise<boolean>;
  dialog: ReactNode;
} {
  const [decision, setDecision] = useState<CloseDecision | undefined>(undefined);
  const [discarding, setDiscarding] = useState(false);
  const pending = useRef<CloseDecision | undefined>(undefined), gate = useRef(false), mounted = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId(), descriptionId = useId();
  const [, redraw] = useReducer((value: number) => value + 1, 0);

  const finish = useCallback((allowed: boolean) => {
    const current = pending.current;
    if (!current) return;
    pending.current = undefined;
    if (mounted.current) { setDecision(undefined); setDiscarding(false); }
    current.resolve(allowed);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const current = pending.current;
      pending.current = undefined;
      current?.resolve(false);
    };
  }, []);
  useEffect(() => decision?.buffer.subscribe(redraw), [decision?.buffer]);
  useEffect(() => {
    if (!decision) return;
    const element = dialog.current;
    if (!element?.open) element?.showModal();
    element?.querySelector<HTMLButtonElement>("[data-continue-viewing]")?.focus();
    return () => { if (element?.open) element.close(); };
  }, [decision]);
  const onBeforeClose = useCallback(async (tab: DockTab) => {
    if (tab.kind !== "skill-file" && (tab.kind !== "file" || !tab.filePath)) return true;
    if (gate.current) return false;
    gate.current = true;
    try {
      const skill=tab.kind==="skill-file"?resolveSkillFile?.(tab):undefined;
      const data=tab.kind==="file"?resolveWorkspace(tab):undefined;
      const path=tab.filePath??tab.skillFile?.sourcePath??tab.title;
      if(!skill&&!data)return true;
      const buffer:CloseDecision["buffer"]=skill?{
        subscribe:skill.subscribe,
        save:()=>skill.saveUntilClean(),
        clean:()=>false,
        error:()=>skill.state.error,
        canDiscard:()=>skill.canDiscardEdits(),
        discard:()=>skill.discardEdits(),
      }:{
        subscribe:listener=>data!.subscribe(listener),
        save:async()=>{await data!.restore();return data!.saveUntilClean(path);},
        clean:()=>data!.restored&&!data!.documents.get(path)?.dirty,
        error:()=>data!.documents.get(path)?.saveError??data!.cacheWarning??data!.errors.action,
        canDiscard:()=>data!.restored,
        discard:()=>data!.discardFileEdits(path),
      };
      try { if(await buffer.save())return true; } catch {
        // The decision below retains any recoverable buffer and original receipt.
      }
      if (!mounted.current) return false;
      if (buffer.clean()) return true;
      return await new Promise<boolean>(resolve => {
        const next = { tabId: tab.id, path, buffer, resolve };
        pending.current = next;
        setDecision(next);
      });
    } finally {
      gate.current = false;
    }
  }, [resolveWorkspace,resolveSkillFile]);

  const error = decision?.buffer.error();
  return {
    onBeforeClose,
    dialog: decision ? <dialog ref={dialog} className="app-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}
      onCancel={event => { event.preventDefault(); if (!discarding) finish(false); }} onClick={event => { if (!discarding && event.target === event.currentTarget) finish(false); }}>
      <div className="dialog-header"><h2 id={titleId}>Discard file changes?</h2></div>
      <p id={descriptionId}>Your unsaved changes to this file will be lost.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="dialog-footer">
        <button type="button" className="secondary-button" data-continue-viewing disabled={discarding} onClick={() => finish(false)}>Continue viewing</button>
        <button type="button" className="primary-button" disabled={!decision.buffer.canDiscard() || discarding} onClick={() => {
          const current = pending.current;
          if (!current || discarding) return;
          setDiscarding(true);
          void current.buffer.discard().then(allowed => {
            if (pending.current !== current) return;
            if (allowed) finish(true);
            else if (mounted.current) setDiscarding(false);
          });
        }}>{discarding ? "Discarding…" : "Discard changes"}</button>
      </div>
    </dialog> : null,
  };
}
