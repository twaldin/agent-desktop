import type { DockAddAction } from "./DockPanel";
import type { DockTab } from "./dock-state";
import { captureDockPresentation, isCurrentDockPresentation, type DockPresentationRef, type DockPresentations } from "./dock-presentations";
import { sameMainTask, type MainChatTarget } from "./main-task-targets";
import { captureBrowserReplacement, type BrowserReplacementOrigin, type BrowserReplacementDestination } from "./browser-workspace-replacement";
import { BrowserWorkspaceActionController, type BrowserWorkspaceActionState } from "./browser-workspace-action";
import { browserWorkspaceChoices, matchBrowserWorkspaceChoices, type BrowserWorkspaceMatch } from "./browser-workspace-suggestions";
import type { BrowserReplacementAdmission } from "./browser-replacement-admission";

interface WorkspaceTab { id:string; title:string; instanceId:string; destination:"right"|"bottom"; reference:DockPresentationRef; descriptor:DockTab }
interface WorkspaceAction { id:string; title:string; singletonTabId?:string; descriptor:DockAddAction }
export type BrowserWorkspaceRow = BrowserWorkspaceMatch<WorkspaceTab,WorkspaceAction> & {origin:BrowserReplacementOrigin};
export interface BrowserWorkspaceMenuContext {
  presentations:DockPresentations;
  owner:MainChatTarget;
  enabled:boolean;
  connected:boolean;
  actions:readonly DockAddAction[];
  chatTitle:string;
  replace(origin:BrowserReplacementOrigin,destination:BrowserReplacementDestination,readOwner:()=>MainChatTarget|undefined):string;
}
function sourceEnabled(context:BrowserWorkspaceMenuContext,origin:BrowserReplacementOrigin):boolean {
  const region=context.presentations.snapshot.state[origin.presentation.destination];
  const current=captureBrowserReplacement(context.presentations,origin.presentation.tabId,context.owner);
  return context.enabled && sameMainTask(origin.owner,context.owner) && region.open && region.activeTabId===origin.presentation.tabId
    && isCurrentDockPresentation(context.presentations,origin.presentation) && current?.state===origin.state && current.title===origin.title;
}
function preparationMatches(action:DockAddAction,origin:BrowserReplacementOrigin):boolean {
  return action.preparationTarget?.hostId===origin.presentation.hostId
    && action.preparationTarget.target===origin.presentation.target;
}
/** Render-only inventory. Every selection carries its original source and tab
 * identity; selecting later always revalidates against the committed context. */
export function browserWorkspaceRows(context:BrowserWorkspaceMenuContext,sourceId:string,query:string,locale:string):BrowserWorkspaceRow[] {
  const origin=captureBrowserReplacement(context.presentations,sourceId,context.owner);
  if (!origin || !sourceEnabled(context,origin)) return [];
  const tabs=context.presentations.snapshot.tabs.flatMap(descriptor=>{
    const reference=captureDockPresentation(context.presentations,descriptor.id);
    return reference?[{id:descriptor.id,title:descriptor.title,instanceId:reference.instanceId,destination:reference.destination,reference,descriptor}]:[];
  });
  const actions=context.actions.filter(action=>Boolean(action.prepare) && preparationMatches(action,origin) && (context.connected || action.requiresConnection === false)).map(descriptor=>({id:descriptor.id,title:descriptor.label,singletonTabId:descriptor.singletonTabId,descriptor}));
  const choices=browserWorkspaceChoices(context.chatTitle,tabs,actions,{id:sourceId,destination:origin.presentation.destination});
  // The input's real navigation parser is the final default-Enter authority.
  return matchBrowserWorkspaceChoices(choices,query,locale,true).map(row=>({...row,origin}));
}
interface Attempt { controller:BrowserWorkspaceActionController; restoreFocus:()=>boolean; admission?:string }
export type BrowserWorkspaceMenuState = BrowserWorkspaceActionState | {status:"committing"};

/** Window owner, retained across panel visibility/remount. commit() observes
 * every committed route/connection/layout transition, including away-and-back. */
export class BrowserWorkspaceMenu {
  private context?:BrowserWorkspaceMenuContext;
  private readonly attempts=new Map<string,Attempt>();
  private readonly selections=new Map<string,{origin:BrowserReplacementOrigin;attempt?:Attempt;valid:boolean;restoreFocus:()=>boolean}>();
  private live=true;
  constructor(private readonly changed:()=>void) {}
  get committedContext(){return this.live ? this.context : undefined;}
  commit(context:BrowserWorkspaceMenuContext) {
    this.context=context;
    for (const selection of this.selections.values()) if (!sourceEnabled(context,selection.origin)) selection.valid=false;
    for (const [instance,attempt] of this.attempts) {
      attempt.controller.observe();
      if (![...context.presentations.instances.values()].includes(instance)) {
        attempt.controller.dispose();this.attempts.delete(instance);
      }
    }
  }
  dispose(){this.live=false;for(const attempt of this.attempts.values())attempt.controller.dispose();this.attempts.clear();this.selections.clear();this.context=undefined;}
  state(instance:string):BrowserWorkspaceMenuState|undefined {
    const attempt=this.attempts.get(instance);
    if (attempt?.admission || [...this.selections.values()].some(value=>value.origin.presentation.instanceId===instance)) return {status:"committing"};
    return attempt?.controller.state;
  }
  /** Read inside the queued cleanup update, against its actual presentation.
   * An untouched address field says nothing about a separate sent action. */
  retainsSource(presentations:DockPresentations,tabId:string):boolean {
    const instance=presentations.instances.get(tabId);
    if(!instance)return false;
    const state=this.state(instance);
    return state?.status==="preparing" || state?.status==="ready" || state?.status==="committing" || state?.status==="unknown"
      || state?.status==="cancelled" && state.creationMayHaveRun;
  }
  private submit(origin:BrowserReplacementOrigin,destination:BrowserReplacementDestination,restoreFocus:()=>boolean,attempt?:Attempt,attachmentGuard:()=>boolean=()=>true) {
    if (!this.context || !sourceEnabled(this.context,origin) || !attachmentGuard()) return false;
    const selection={origin,attempt,valid:true,restoreFocus};
    const id=this.context.replace(origin,destination,()=>this.live && selection.valid && this.context && sourceEnabled(this.context,origin) && attachmentGuard() ? this.context.owner : undefined);
    this.selections.set(id,selection);if(attempt)attempt.admission=id;
    this.changed();return true;
  }
  choose(row:BrowserWorkspaceRow,restoreFocus:()=>boolean=()=>true):boolean {
    const context=this.context;
    if (!this.live || !context || !sourceEnabled(context,row.origin)) return false;
    const instance=row.origin.presentation.instanceId,existing=this.attempts.get(instance),state=this.state(instance);
    if (state?.status==="preparing" || state?.status==="committing" || state?.status==="unknown"
      || state?.status==="cancelled" && state.creationMayHaveRun) return false;
    if (existing) {existing.controller.dispose();this.attempts.delete(instance);}
    if(row.kind==="chat")return this.submit(row.origin,{kind:"chat",target:row.origin.owner},restoreFocus);
    if(row.kind==="tab")return this.submit(row.origin,{kind:"tab",target:row.tab.reference},restoreFocus);
    // Resolve the current shared action, never invoke a captured stale closure.
    const action=context.actions.find(action=>action.id===row.action.id);
    if(!action?.prepare || !preparationMatches(action,row.origin) || !context.connected && action.requiresConnection !== false || action.singletonTabId && context.presentations.snapshot.tabs.some(tab=>tab.id===action.singletonTabId))return false;
    const controller=new BrowserWorkspaceActionController(row.origin,()=>{
      const latest=this.context, available=latest?.actions.find(candidate=>candidate.id===action.id && candidate.prepare && preparationMatches(candidate,row.origin));
      return {presentations:latest?.presentations??context.presentations,owner:latest?.owner,
        connected:Boolean(latest && (latest.connected || available?.requiresConnection === false)),enabled:Boolean(this.live && latest && sourceEnabled(latest,row.origin) && available)};
    },signal=>action.prepare!(signal,row.origin),()=>{if(this.live)this.changed();});
    const attempt:Attempt={controller,restoreFocus};this.attempts.set(instance,attempt);
    void controller.start().then(()=>{
      if(!this.live || this.attempts.get(instance)!==attempt)return;
      const replacement=controller.replacement();
      // Preparation can lose eligibility after enqueue while its source remains
      // current. Retain the same controller's latched validity through admission.
      if(replacement && !this.submit(replacement.origin,replacement.destination,attempt.restoreFocus,attempt,()=>Boolean(controller.replacement())))controller.cancel();
    });
    return true;
  }
  cancel(instance:string){this.attempts.get(instance)?.controller.cancel();}
  /** Capture while this exact action is preparing. The request owner invokes
   * this only after confirmed non-submission or saved result attachment. A late
   * settlement cannot release a newer attempt, even on the same presentation. */
  captureSettlement(origin:BrowserReplacementOrigin):(()=>void)|undefined {
    const instance=origin.presentation.instanceId,attempt=this.attempts.get(instance);
    if (!this.live || !attempt || attempt.controller.origin!==origin || attempt.controller.state.status!=="preparing") return;
    return ()=>{
      if (!this.live || this.attempts.get(instance)!==attempt || attempt.admission || this.state(instance)?.status==="committing") return;
      const state=attempt.controller.state;
      if (state.status!=="unknown" && !(state.status==="cancelled" && state.creationMayHaveRun)) return;
      attempt.controller.dispose();this.attempts.delete(instance);this.changed();
    };
  }
  /** Explicit read-only result recovery still uses the existing replacement
   * admission and deferred focus owner; it never calls an action again. Retain
   * the request owner's guard until the queued replacement reads its owner. */
  adopt(origin:BrowserReplacementOrigin,tab:DockTab,restoreFocus:()=>boolean=()=>true,attachmentGuard:()=>boolean=()=>true):boolean {
    if (!this.live || this.state(origin.presentation.instanceId)?.status === "committing") return false;
    return this.submit(origin,{kind:"opened",tab},restoreFocus,undefined,attachmentGuard);
  }
  /** Called only after the owning request inspector proves not-submitted and
   * removes its saved request. This releases the UI fence, never retries it. */
  releaseNotSubmitted(origin:BrowserReplacementOrigin):boolean {
    if (!this.live || !this.context || !sourceEnabled(this.context,origin)) return false;
    const instance=origin.presentation.instanceId,attempt=this.attempts.get(instance);
    if (!attempt || attempt.admission || attempt.controller.origin.state !== origin.state) return false;
    const state=attempt.controller.state;
    if (state.status!=="unknown" && !(state.status==="cancelled" && state.creationMayHaveRun)) return false;
    attempt.controller.dispose();this.attempts.delete(instance);this.changed();return true;
  }
  /** Called only with results visible in the committed hook state. Success is
   * returned for post-commit focus; rejection leaves the source and draft intact. */
  committed(admissions:ReadonlyMap<string,BrowserReplacementAdmission>|undefined):BrowserReplacementAdmission[] {
    const completed:BrowserReplacementAdmission[]=[];
    for(const [id,admission] of admissions??[]) {
      const selection=this.selections.get(id);if(!selection)continue;
      this.selections.delete(id);
      if(selection.attempt) {
        selection.attempt.admission=undefined;
        if(!admission.focus)selection.attempt.controller.cancel();
      }
      if(admission.focus && selection.restoreFocus())completed.push(admission);
      this.changed();
    }
    return completed;
  }
}
