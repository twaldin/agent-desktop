import { parseNativeSkillFileDocument, parseNativeSkillFileRef, type CommandEnvelope, type CommandResult, type DesktopBridge, type NativeSkillFileDocument, type NativeSkillFileRef } from "@agent-desktop/shared";
import type { OfflineCache } from "./offline-cache";
export type { NativeSkillFileDocument, NativeSkillFileRef };

type Write = Extract<CommandEnvelope["command"], {type:"skill.file.write"}>;
type PendingOpen = {id:string;targetId:string};
type Pending = {id:string;command:Write};
export interface NativeSkillFileState {
  hostId:string; ref:NativeSkillFileRef; file:NativeSkillFileDocument|null;
  text:string; dirty:boolean; saving:boolean; loading:boolean; conflict:boolean; uncertain:boolean;
  source:boolean; switchingSource:boolean; opening?:boolean; openError?:string; error?:string; notice?:string; recoveredText?:string;
}
type Stored = {version:1;file:NativeSkillFileDocument|null;text:string;dirty:boolean;conflict:boolean;pending?:Pending;pendingOpen?:PendingOpen;recoveredText?:string};
export const sameRef = (a:NativeSkillFileRef,b:NativeSkillFileRef) => JSON.stringify(parseNativeSkillFileRef(a)) === JSON.stringify(parseNativeSkillFileRef(b));
export const keyFor = (host:string,ref:NativeSkillFileRef) => `agent-desktop:skill-file:v1:${host}:${JSON.stringify(parseNativeSkillFileRef(ref))}`;
const message = (cause:unknown) => cause instanceof Error ? cause.message : "The owning host could not complete this action.";

/** A single host/catalog resource. Window navigation never changes its identity.
 * Pending commands are persisted before dispatch and only retried explicitly
 * with the original receipt ID. Editor text is independent of each sent snapshot. */
export class NativeSkillFileController {
  readonly state:NativeSkillFileState;
  imageGeneration=0;
  private timer?:ReturnType<typeof setTimeout>;
  private epoch=0;
  private version=0;
  private listeners=new Set<()=>void>();
  private writes:Promise<void>=Promise.resolve();
  private connected=false;
  private pending?:Pending;
  private pendingOpen?:PendingOpen;
  private opening=false;
  private restoreTask?:Promise<boolean>;
  private restored=false;
  private storageError=false;
  private disposed=false;
  constructor(private bridge:DesktopBridge, hostId:string, ref:NativeSkillFileRef, private cache:OfflineCache, initialMode:"markdown"|"source"="markdown") {
    this.state={hostId,ref:parseNativeSkillFileRef(ref),file:null,text:"",dirty:false,saving:false,loading:false,conflict:false,uncertain:false,source:initialMode==="source",switchingSource:false};
  }
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  getVersion=()=>this.version;
  private emit(){this.version++;for(const fn of this.listeners)fn();}
  private owned(value:unknown){const file=parseNativeSkillFileDocument(value);if(file.hostId!==this.state.hostId||!sameRef(file.ref,this.state.ref))throw new Error("Skill file response belongs to a different owner or file.");return file;}
  private persist():Promise<void>{
    const value=JSON.stringify({version:1,file:this.state.file,text:this.state.text,dirty:this.state.dirty,conflict:this.state.conflict,pending:this.pending,pendingOpen:this.pendingOpen,recoveredText:this.state.recoveredText} satisfies Stored);
    const write=this.writes.catch(()=>{}).then(()=>this.cache.write(keyFor(this.state.hostId,this.state.ref),value));
    this.writes=write;
    return write.then(()=>{this.storageError=false;},cause=>{this.storageError=true;this.state.error=`Edits could not be stored on this device: ${message(cause)}`;this.emit();throw cause;});
  }
  get canSaveCopy(){return Boolean(this.bridge.saveSkillFileCopy);}
  async saveCopy(){
    if(this.disposed||!this.connected||!this.bridge.saveSkillFileCopy)throw new Error("Reconnect with a desktop that supports native skill Save as.");
    return this.bridge.saveSkillFileCopy(this.state.ref,this.state.hostId);
  }
  async getOpenOptions() {
    if(this.disposed||!this.connected)throw new Error("Reconnect to see applications on this skill’s host.");
    if(!this.bridge.getSkillFileOpenOptions)throw new Error("Native skill Open is unavailable in this desktop.");
    const result=await this.bridge.getSkillFileOpenOptions(this.state.ref,this.state.hostId);
    if(result.hostId!==this.state.hostId||!sameRef(result.ref,this.state.ref)||result.options.path!==this.state.ref.sourcePath)throw new Error("Skill Open options belong to a different owner or file.");
    return result.options;
  }
  get pendingOpenTarget(){return this.pendingOpen?.targetId;}
  async retryOpen(){if(this.pendingOpen)await this.openFile(this.pendingOpen.targetId);}
  async openFile(targetId:string):Promise<boolean> {
    if(this.opening)return false;
    this.opening=true;this.state.opening=true;this.state.openError=undefined;this.emit();
    let dispatched=false;
    try {
      if(this.disposed||!this.connected||!await this.restore())throw new Error("Reconnect to open this skill on its host.");
      if(this.pendingOpen&&this.pendingOpen.targetId!==targetId)throw new Error("An earlier Open needs confirmation. Select that same application to check its original receipt before opening another.");
      const pending=this.pendingOpen??{id:crypto.randomUUID(),targetId};this.pendingOpen=pending;
      await this.persist();
      if(this.disposed||!this.connected)throw new Error("The skill owner is no longer connected. Its Open receipt was retained.");
      dispatched=true;
      const result=await this.bridge.command({id:pending.id,command:{type:"skill.file.open",ref:this.state.ref,targetId:pending.targetId}},this.state.hostId);
      if(result.commandId!==pending.id)throw new Error("The host returned a different Open receipt.");
      if(!result.ok){
        if(result.error.code!=="OUTCOME_UNKNOWN"){this.pendingOpen=undefined;try{await this.persist();}catch(cause){this.pendingOpen=pending;throw cause;}}
        throw new Error(result.error.message);
      }
      if(!result.value||!("type" in result.value)||result.value.type!=="skill.file.open"||result.value.targetId!==pending.targetId)throw new Error("The host did not confirm the selected Open application.");
      this.pendingOpen=undefined;try{await this.persist();}catch(cause){this.pendingOpen=pending;throw cause;}return true;
    } catch(cause) {
      this.state.openError=`${dispatched&&this.pendingOpen?"Open needs confirmation. Selecting the same application checks the original receipt. ":""}${message(cause)}`;
      throw new Error(this.state.openError);
    } finally {this.opening=false;this.state.opening=false;this.emit();}
  }
  async acquireImage(path:string){
    if(this.disposed||!this.connected)throw new Error("Reconnect to load this skill image.");
    if(!this.bridge.acquireSkillImage||!this.bridge.releaseWorkspaceImage)throw new Error("Skill image loading is unavailable in this desktop.");
    const release=this.bridge.releaseWorkspaceImage.bind(this.bridge);
    const lease=await this.bridge.acquireSkillImage(this.state.ref,path,this.state.hostId);
    if(this.disposed||!this.connected){await release(lease.id);throw new Error("The skill image owner is no longer active.");}
    return {url:lease.url,release:()=>release(lease.id)};
  }
  async flush(){await this.writes;}
  private async waitForSave(signal?:AbortSignal){
    signal?.throwIfAborted();
    if(!this.state.saving)return;
    await new Promise<void>((resolve,reject)=>{
      const clean=()=>{off();signal?.removeEventListener("abort",cancel);};
      const cancel=()=>{clean();reject(signal?.reason);};
      const off=this.subscribe(()=>{if(!this.state.saving){clean();resolve();}});
      signal?.addEventListener("abort",cancel,{once:true});
    });
    signal?.throwIfAborted();
  }
  /** Drain current and newer edits without inventing a retry for an unknown receipt. */
  async saveUntilClean(signal?:AbortSignal):Promise<boolean>{
    if(this.disposed||!await this.restore())return false;
    for(;;){
      if(this.disposed)return false;
      signal?.throwIfAborted();
      // Even a locally clean buffer can have an older write in flight (Undo).
      if(this.state.saving){
        await this.waitForSave(signal);
        continue;
      }
      if(this.state.conflict||this.state.uncertain||this.storageError)return false;
      if(!this.state.dirty)return true;
      if(!this.connected||!await this.save())return false;
    }
  }
  async prepareWindowClose(signal?:AbortSignal):Promise<boolean>{
    if(!await this.restore())return false;
    signal?.throwIfAborted();
    // Going offline cannot cancel a command already delivered to the host.
    await this.waitForSave(signal);
    if(this.connected&&!await this.saveUntilClean(signal))return false;
    signal?.throwIfAborted();await this.persist();signal?.throwIfAborted();return true;
  }
  private async restore():Promise<boolean>{
    if(this.restored)return true;
    if(this.restoreTask)return this.restoreTask;
    this.restoreTask=(async()=>{
      try {
        const raw=await this.cache.read(keyFor(this.state.hostId,this.state.ref));
        if(raw){
          const saved=JSON.parse(raw) as Stored;
          if(saved.version!==1||typeof saved.text!=="string"||typeof saved.dirty!=="boolean"||typeof saved.conflict!=="boolean")throw new Error("Saved skill edits are invalid; they have been retained for recovery.");
          const file=saved.file?this.owned(saved.file):null;
          if(saved.pending){
            const p=saved.pending;
            if(typeof p.id!=="string"||!p.id||p.command?.type!=="skill.file.write"||!sameRef(p.command.ref,this.state.ref)||typeof p.command.text!=="string"||p.command.text.length>1024*1024||typeof p.command.expectedRevision!=="string"||!/^[a-f0-9]{64}$/.test(p.command.expectedRevision)||typeof p.command.bom!=="boolean")throw new Error("Saved skill write identity is invalid; it has been retained for recovery.");
            this.pending=p;
          }
          if(saved.pendingOpen){
            const open=saved.pendingOpen;
            if(typeof open.id!=="string"||!open.id||open.id.length>200||typeof open.targetId!=="string"||!open.targetId||open.targetId.length>200)throw new Error("Saved skill Open identity is invalid; it has been retained for recovery.");
            this.pendingOpen={id:open.id,targetId:open.targetId};this.state.openError="An earlier Open has an unresolved receipt.";
          }
          this.state.file=file;this.state.text=saved.text;this.state.dirty=saved.dirty;this.state.conflict=saved.conflict;this.state.uncertain=Boolean(this.pending);
          if(typeof saved.recoveredText==="string")this.state.recoveredText=saved.recoveredText;
        }
        this.restored=true;return true;
      } catch(cause){this.state.error=message(cause);this.emit();return false;}
      finally {this.restoreTask=undefined;}
    })();return this.restoreTask;
  }
  setConnected(connected:boolean){
    if(this.disposed)return;
    if(this.connected!==connected){if(connected)this.imageGeneration++;this.connected=connected;if(!connected){this.epoch++;this.state.loading=false;clearTimeout(this.timer);}else this.schedule();this.emit();}
  }
  async load(connected=this.connected){
    if(this.disposed)return;
    this.setConnected(connected);const epoch=++this.epoch;this.state.loading=true;this.state.error=undefined;this.emit();
    if(!await this.restore()){this.state.loading=false;this.emit();return;}
    if(epoch!==this.epoch)return;
    if(!this.connected){this.state.loading=false;this.emit();return;}
    try {
      if(!this.bridge.getSkillFile)throw new Error("Update this desktop to open native skill files.");
      const baseline=this.state.file, writingAtStart=Boolean(this.pending)||this.state.saving;
      const file=this.owned(await this.bridge.getSkillFile(this.state.ref,this.state.hostId));
      if(epoch!==this.epoch||!this.connected)return;
      if(!writingAtStart&&!this.pending&&!this.state.saving&&this.state.file===baseline){
        if(!this.state.dirty){this.state.file=file;this.state.text=file.document.text;this.state.conflict=false;}
        else if(!this.state.file){this.state.file=file;this.state.conflict=this.state.text!==file.document.text;this.state.dirty=this.state.conflict;}
        else if(file.document.revision!==this.state.file.document.revision){
          this.state.file=file;
          this.state.conflict=this.state.text!==file.document.text;
          this.state.dirty=this.state.conflict;
        }
      }
      await this.persist();
    } catch(cause){if(epoch===this.epoch)this.state.error=message(cause);}
    finally {if(epoch===this.epoch){this.state.loading=false;this.emit();this.schedule();}}
  }
  private schedule(){
    clearTimeout(this.timer);
    if(!this.disposed&&this.connected&&this.restored&&this.state.file&&this.state.dirty&&!this.state.saving&&!this.state.conflict&&!this.state.uncertain&&!this.state.error&&!this.storageError)
      this.timer=setTimeout(()=>void this.save(),3000);
  }
  setText(text:string){
    if(this.disposed||!this.restored)return;
    this.state.text=text;this.state.dirty=text!==this.state.file?.document.text;this.state.notice=undefined;this.state.error=undefined;this.emit();
    void this.persist().then(()=>this.schedule(),()=>{});
  }
  async toggleSource(signal?:AbortSignal, nextSource=!this.state.source):Promise<boolean>{
    if(this.disposed||this.state.switchingSource||!this.state.file||this.state.loading||signal?.aborted)return false;
    this.state.switchingSource=true;this.emit();
    try {
      for(;;){
        const saved=await this.saveUntilClean(signal);
        signal?.throwIfAborted();
        if(!saved){
          this.state.error??="Save or resolve this file before switching views.";
          return false;
        }
        // A new edit can arrive between the drain and this continuation.
        if(this.state.saving||this.state.dirty||this.state.conflict||this.state.uncertain||this.storageError)continue;
        this.state.source=nextSource;return true;
      }
    } catch(cause){
      if(!signal?.aborted)this.state.error=message(cause);
      return false;
    } finally {this.state.switchingSource=false;this.emit();}
  }
  private async accept(result:CommandResult,pending:Pending){
    if(result.commandId!==pending.id)throw new Error("The save receipt belongs to a different command.");
    if(!result.ok){
      if(result.error.code==="OUTCOME_UNKNOWN") throw new Error(result.error.message);
      this.pending=undefined;this.state.uncertain=false;this.state.error=result.error.message;
      await this.persist();return false;
    }
    if(!result.value||!("type" in result.value)||result.value.type!=="skill.file.write"||typeof result.value.conflict!=="boolean")throw new Error("The skill save receipt is invalid.");
    const file=this.owned(result.value.file);
    if(!result.value.conflict&&(file.document.text!==pending.command.text||file.document.bom!==pending.command.bom))throw new Error("The host did not confirm the requested file contents.");
    this.pending=undefined;this.state.file=file;this.state.uncertain=false;this.state.conflict=result.value.conflict;
    this.state.dirty=this.state.text!==file.document.text || result.value.conflict;
    this.state.error=undefined;this.state.notice=result.value.conflict?"The file changed on its host. Your edits are preserved.":"Saved";
    await this.persist();return !result.value.conflict;
  }
  private async dispatch(pending:Pending){
    try {return await this.accept(await this.bridge.command(pending,this.state.hostId),pending);}
    catch(cause){
      // A confirmed receipt may be followed by a local cache failure. That is a
      // storage error, not permission to retry a different command.
      this.state.uncertain=Boolean(this.pending);this.state.error=message(cause);
      if(this.pending)this.state.notice="Save not confirmed. Inspect the file or check the same save receipt.";
      await this.persist().catch(()=>{});return false;
    } finally {this.state.saving=false;this.emit();this.schedule();}
  }
  async save(){
    if(this.disposed||!this.connected||!this.restored||!this.state.dirty||this.state.saving||this.state.conflict||this.state.uncertain||!this.state.file)return false;
    clearTimeout(this.timer);
    if(new TextEncoder().encode(this.state.text).byteLength>1024*1024){this.state.error="Skill files must be at most 1 MiB. Your edits are retained on this device; shorten them before saving.";this.emit();return false;}
    const pending:Pending={id:crypto.randomUUID(),command:{type:"skill.file.write",ref:this.state.ref,text:this.state.text,expectedRevision:this.state.file.document.revision,bom:this.state.file.document.bom}};
    this.pending=pending;this.state.saving=true;this.state.error=undefined;this.emit();
    try {await this.persist();}catch{this.pending=undefined;this.state.saving=false;this.emit();return false;}
    if(this.disposed||!this.connected){this.pending=undefined;this.state.saving=false;await this.persist().catch(()=>{});this.emit();return false;}
    return this.dispatch(pending);
  }
  async inspectUnknown(){
    if(this.disposed||!this.connected||!this.pending||!this.state.uncertain||this.state.saving||!this.bridge.getSkillFile)return false;
    this.state.loading=true;this.state.error=undefined;this.emit();
    try {
      const pending=this.pending,file=this.owned(await this.bridge.getSkillFile(this.state.ref,this.state.hostId));
      if(this.pending!==pending)return false;
      if(file.document.text!==pending.command.text||file.document.bom!==pending.command.bom){this.state.notice="The file differs from that save. Check the original receipt before saving again.";return false;}
      this.pending=undefined;this.state.file=file;this.state.uncertain=false;this.state.conflict=false;
      this.state.dirty=this.state.text!==file.document.text;this.state.notice="Saved contents confirmed on the host";
      await this.persist();return true;
    }catch(cause){this.state.error=message(cause);return false;}
    finally {this.state.loading=false;this.emit();this.schedule();}
  }
  async retryUnknown(){
    if(this.disposed||!this.connected||!this.pending||!this.state.uncertain||this.state.saving||this.state.loading)return false;
    this.state.saving=true;this.state.error=undefined;this.emit();
    return this.dispatch(this.pending);
  }
  resolveConflict(choice:"use-file"|"keep-changes"){
    if(!this.state.file||this.pending||!this.state.conflict)return;
    if(choice==="use-file"){
      this.state.recoveredText=this.state.text;this.state.text=this.state.file.document.text;this.state.dirty=false;
    }else this.state.dirty=this.state.text!==this.state.file.document.text;
    this.state.conflict=false;this.state.error=undefined;this.state.notice=choice==="use-file"?"File version restored; previous edits are recoverable.":undefined;this.emit();
    void this.persist().then(()=>this.schedule(),()=>{});
  }
  restorePreviousEdits(){if(this.state.recoveredText===undefined)return;const text=this.state.recoveredText;this.state.recoveredText=undefined;this.setText(text);}
  canDiscardEdits(){return !this.disposed&&this.restored&&Boolean(this.state.file)&&!this.state.saving&&!this.pending;}
  async discardEdits():Promise<boolean>{
    // Discard is not an acknowledgement or cancellation of a delivered write.
    if(!this.canDiscardEdits())return false;
    clearTimeout(this.timer);
    const previous={text:this.state.text,dirty:this.state.dirty,conflict:this.state.conflict,recoveredText:this.state.recoveredText};
    const baseline=this.state.file!.document.text;
    this.state.text=baseline;this.state.dirty=false;this.state.conflict=false;this.state.recoveredText=undefined;
    this.state.error=undefined;this.state.notice=undefined;
    try {
      await this.persist();
      return !this.state.dirty&&!this.pending&&this.state.text===baseline;
    } catch {
      // Do not replace a newer edit that arrived while recovery storage failed.
      if(this.state.text===baseline&&!this.state.dirty)Object.assign(this.state,previous);
      return false;
    } finally {this.emit();}
  }
  dispose(){this.disposed=true;clearTimeout(this.timer);this.epoch++;}
}
