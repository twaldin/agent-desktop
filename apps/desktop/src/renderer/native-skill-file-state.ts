import { parseNativeSkillFileDocument, parseNativeSkillFileRef, type CommandEnvelope, type CommandResult, type DesktopBridge, type NativeSkillFileDocument, type NativeSkillFileRef } from "@agent-desktop/shared";
import type { OfflineCache } from "./offline-cache";
export type { NativeSkillFileDocument, NativeSkillFileRef };

type Write = Extract<CommandEnvelope["command"], {type:"skill.file.write"}>;
type Pending = {id:string;command:Write};
export interface NativeSkillFileState {
  hostId:string; ref:NativeSkillFileRef; file:NativeSkillFileDocument|null;
  text:string; dirty:boolean; saving:boolean; loading:boolean; conflict:boolean; uncertain:boolean;
  source:boolean; switchingSource:boolean; error?:string; notice?:string; recoveredText?:string;
}
type Stored = {version:1;file:NativeSkillFileDocument|null;text:string;dirty:boolean;conflict:boolean;pending?:Pending;recoveredText?:string};
export const sameRef = (a:NativeSkillFileRef,b:NativeSkillFileRef) => JSON.stringify(parseNativeSkillFileRef(a)) === JSON.stringify(parseNativeSkillFileRef(b));
export const keyFor = (host:string,ref:NativeSkillFileRef) => `agent-desktop:skill-file:v1:${host}:${JSON.stringify(parseNativeSkillFileRef(ref))}`;
const message = (cause:unknown) => cause instanceof Error ? cause.message : "The owning host could not complete this action.";

/** A single host/catalog resource. Window navigation never changes its identity.
 * Pending commands are persisted before dispatch and only retried explicitly
 * with the original receipt ID. Editor text is independent of each sent snapshot. */
export class NativeSkillFileController {
  readonly state:NativeSkillFileState;
  private timer?:ReturnType<typeof setTimeout>;
  private epoch=0;
  private version=0;
  private listeners=new Set<()=>void>();
  private writes:Promise<void>=Promise.resolve();
  private connected=false;
  private pending?:Pending;
  private restoreTask?:Promise<boolean>;
  private restored=false;
  private storageError=false;
  constructor(private bridge:DesktopBridge, hostId:string, ref:NativeSkillFileRef, private cache:OfflineCache) {
    this.state={hostId,ref:parseNativeSkillFileRef(ref),file:null,text:"",dirty:false,saving:false,loading:false,conflict:false,uncertain:false,source:false,switchingSource:false};
  }
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  getVersion=()=>this.version;
  private emit(){this.version++;for(const fn of this.listeners)fn();}
  private owned(value:unknown){const file=parseNativeSkillFileDocument(value);if(file.hostId!==this.state.hostId||!sameRef(file.ref,this.state.ref))throw new Error("Skill file response belongs to a different owner or file.");return file;}
  private persist():Promise<void>{
    const value=JSON.stringify({version:1,file:this.state.file,text:this.state.text,dirty:this.state.dirty,conflict:this.state.conflict,pending:this.pending,recoveredText:this.state.recoveredText} satisfies Stored);
    const write=this.writes.catch(()=>{}).then(()=>this.cache.write(keyFor(this.state.hostId,this.state.ref),value));
    this.writes=write;
    return write.then(()=>{this.storageError=false;},cause=>{this.storageError=true;this.state.error=`Edits could not be stored on this device: ${message(cause)}`;this.emit();throw cause;});
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
    if(!await this.restore())return false;
    for(;;){
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
          this.state.file=file;this.state.text=saved.text;this.state.dirty=saved.dirty;this.state.conflict=saved.conflict;this.state.uncertain=Boolean(this.pending);
          if(typeof saved.recoveredText==="string")this.state.recoveredText=saved.recoveredText;
        }
        this.restored=true;return true;
      } catch(cause){this.state.error=message(cause);this.emit();return false;}
      finally {this.restoreTask=undefined;}
    })();return this.restoreTask;
  }
  setConnected(connected:boolean){
    if(this.connected!==connected){this.connected=connected;if(!connected){this.epoch++;this.state.loading=false;clearTimeout(this.timer);}else this.schedule();this.emit();}
  }
  async load(connected=this.connected){
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
    if(this.connected&&this.restored&&this.state.file&&this.state.dirty&&!this.state.saving&&!this.state.conflict&&!this.state.uncertain&&!this.state.error&&!this.storageError)
      this.timer=setTimeout(()=>void this.save(),3000);
  }
  setText(text:string){
    if(!this.restored)return;
    this.state.text=text;this.state.dirty=text!==this.state.file?.document.text;this.state.notice=undefined;this.state.error=undefined;this.emit();
    void this.persist().then(()=>this.schedule(),()=>{});
  }
  async toggleSource(signal?:AbortSignal):Promise<boolean>{
    if(this.state.switchingSource||!this.state.file||this.state.loading||signal?.aborted)return false;
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
        this.state.source=!this.state.source;return true;
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
    if(!this.connected||!this.restored||!this.state.dirty||this.state.saving||this.state.conflict||this.state.uncertain||!this.state.file)return false;
    clearTimeout(this.timer);
    if(new TextEncoder().encode(this.state.text).byteLength>1024*1024){this.state.error="Skill files must be at most 1 MiB. Your edits are retained on this device; shorten them before saving.";this.emit();return false;}
    const pending:Pending={id:crypto.randomUUID(),command:{type:"skill.file.write",ref:this.state.ref,text:this.state.text,expectedRevision:this.state.file.document.revision,bom:this.state.file.document.bom}};
    this.pending=pending;this.state.saving=true;this.state.error=undefined;this.emit();
    try {await this.persist();}catch{this.pending=undefined;this.state.saving=false;this.emit();return false;}
    if(!this.connected){this.pending=undefined;this.state.saving=false;await this.persist().catch(()=>{});this.emit();return false;}
    return this.dispatch(pending);
  }
  async inspectUnknown(){
    if(!this.connected||!this.pending||!this.state.uncertain||this.state.saving||!this.bridge.getSkillFile)return false;
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
    if(!this.connected||!this.pending||!this.state.uncertain||this.state.saving||this.state.loading)return false;
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
  dispose(){clearTimeout(this.timer);this.epoch++;}
}
