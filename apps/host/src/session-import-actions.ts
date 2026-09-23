import type { NativeImportOutcome, NativeImportPreparation, SessionSummary } from "@agent-desktop/shared";
import { nativeImportCandidateId, nativeImportCommandId } from "@agent-desktop/shared";
import type { WorkerSession } from "./omp-workers/runtime";
import { OriginalImportRecords, type OriginalImportBinding, type OriginalImportIdentity } from "./session-import-records";

type AdmissionStatus =
  | {commandId:string;state:"absent"}
  | {commandId:string;state:"pending"|"admitted";binding:OriginalImportBinding}
  | {commandId:string;state:"refused";reason:string;message:string}
  | {commandId:string;state:"unknown";message:string};
/** Structural boundary of the native admission owner; no catalog or renderer
 * operation substitutes for its original-file ownership check. */
export interface OriginalAdmissionPort {
  prepare(input:{candidateId:string;expectedRevision:string}):Promise<
    | {ok:true;preparationId:string;binding:OriginalImportBinding;source:OriginalImportIdentity}
    | {ok:false;reason:string;message:string}>;
  admit(input:{commandId:string;preparationId:string}):Promise<{status:AdmissionStatus;handle?:WorkerSession}>;
  status(commandId:string):Promise<AdmissionStatus>;
  getRetainedHandle(commandId:string,binding:OriginalImportBinding):WorkerSession|undefined;
}
export class SessionImportActions {
  private pending=new Map<string,{preparationId:string;result:Promise<NativeImportOutcome>}>();
  private preparations=new Set<Promise<NativeImportPreparation>>();
  private closing=false;
  constructor(private readonly options:{hostId:string;admission:OriginalAdmissionPort;records:OriginalImportRecords;
    /** Synchronous: check and install the already-owned worker, publish host
     * state, and never start another worker in this callback. */
    retain(handle:WorkerSession,binding:OriginalImportBinding):void;
  }){}
  async prepare(candidateId:string,revision:string):Promise<NativeImportPreparation>{
    candidateId=nativeImportCandidateId(candidateId);revision=nativeImportCandidateId(revision);
    const result=Promise.resolve().then(()=>this.prepareOriginal(candidateId,revision));this.preparations.add(result);
    try{return await result;}finally{this.preparations.delete(result);}
  }
  private async prepareOriginal(candidateId:string,revision:string):Promise<NativeImportPreparation>{
    const base={version:1 as const,hostId:this.options.hostId,candidateId,revision};
    if(this.closing)return {...base,state:"refused",reason:"stopping",message:"The owning host is stopping."};
    const result=await this.options.admission.prepare({candidateId,expectedRevision:revision});
    if(this.closing)return {...base,state:"refused",reason:"stopping",message:"The owning host stopped this preparation."};
    return result.ok ? {...base,state:"ready",preparationId:result.preparationId,original:{sessionId:result.binding.nativeId,originalFile:result.binding.originalFile,cwd:result.binding.recordedCwd}}
      : {...base,state:"refused",reason:result.reason,message:result.message};
  }
  private base(commandId:string){return {version:1 as const,hostId:this.options.hostId,commandId};}
  private unknown(commandId:string,message:string):NativeImportOutcome{return {...this.base(commandId),state:"unknown",message};}
  private project(commandId:string,status:AdmissionStatus):NativeImportOutcome{
    if(status.commandId!==commandId)throw new Error("The native admission returned another command identity.");
    const base=this.base(commandId),record=this.options.records.read(commandId);
    if(status.state==="refused"&&status.reason==="request-conflict")return {...base,state:"refused",reason:status.reason,message:status.message};
    if(record?.state==="admitted"){
      const binding=this.options.records.bindingForSession(record.source.nativeId);
      if(!binding)throw new Error("The imported session lost its original ownership binding.");
      return {...base,state:"imported",original:{sessionId:binding.nativeId,originalFile:binding.originalFile,cwd:binding.recordedCwd}};
    }
    if(status.state==="admitted")return this.pending.has(commandId) ? {...base,state:"pending"}
      : this.unknown(commandId,"Native admission completed without a confirmed catalog publication. Inspect this original command; do not create a replacement import.");
    if(status.state==="unknown")return this.unknown(commandId,status.message);
    if(status.state==="refused")return {...base,state:"refused",reason:status.reason,message:status.message};
    if(record?.state==="unknown"||record?.state==="reserved"&&status.state==="absent")return this.unknown(commandId,record.error||"The original import reservation has no confirmed native outcome.");
    return {...base,state:status.state};
  }
  async status(commandId:string):Promise<NativeImportOutcome>{
    commandId=nativeImportCommandId(commandId);
    try{return this.project(commandId,await this.options.admission.status(commandId));}
    catch(error){return this.unknown(commandId,error instanceof Error?error.message:"The original import outcome could not be read.");}
  }
  async admit(commandId:string,preparationId:string):Promise<NativeImportOutcome>{
    commandId=nativeImportCommandId(commandId);preparationId=nativeImportCommandId(preparationId);
    const prior=this.pending.get(commandId);
    if(prior)return prior.preparationId===preparationId ? prior.result : {...this.base(commandId),state:"refused",reason:"request-conflict",message:"This import command already has another preparation."};
    if(this.closing)return {...this.base(commandId),state:"refused",reason:"stopping",message:"The owning host is stopping. No new import was dispatched."};
    const result=Promise.resolve().then(()=>this.run(commandId,preparationId));
    this.pending.set(commandId,{preparationId,result});
    try{return await result;}finally{if(this.pending.get(commandId)?.result===result)this.pending.delete(commandId);}
  }
  private async run(commandId:string,preparationId:string):Promise<NativeImportOutcome>{
    try{
      if(this.closing)return {...this.base(commandId),state:"refused",reason:"stopping",message:"The host stopped before native import dispatch."};
      const result=await this.options.admission.admit({commandId,preparationId}),status=result.status;
      if(status.commandId!==commandId)throw new Error("The native admission returned another command identity.");
      if(status.state==="admitted"){
        const saved=this.options.records.read(commandId);
        if(saved?.state!=="admitted"){
          const handle=this.options.admission.getRetainedHandle(commandId,status.binding);
          if(!handle||result.handle&&handle!==result.handle)throw new Error("The original admitted worker is no longer proven current. No replacement was opened.");
          if(this.closing)throw new Error("The host stopped before catalog publication; inspect the original import outcome.");
          const now=Date.now();
          const summary:SessionSummary={id:handle.id,hostId:this.options.hostId,projectId:null,cwd:handle.cwd,sessionFile:handle.sessionFile,title:handle.title||"Imported conversation",model:handle.model,status:"idle",createdAt:Number.isFinite(handle.createdAt)?handle.createdAt:now,updatedAt:now,archived:false,error:handle.modelFallbackMessage};
          this.options.records.publish(commandId,status.binding,summary);
          this.options.retain(handle,status.binding);
        }
      }else if(status.state==="refused"&&status.reason!=="request-conflict")this.options.records.settleFailure(commandId,"refused",status.message);
      else if(status.state==="unknown")this.options.records.settleFailure(commandId,"unknown",status.message);
      return this.project(commandId,status);
    }catch(error){
      // Native admission may already have effects. A read/transport/publication
      // failure is never a no-effect refusal or permission to replay.
      return this.unknown(commandId,error instanceof Error?error.message:"The original import outcome is unknown.");
    }
  }
  async dispose():Promise<void>{this.closing=true;await Promise.allSettled([...this.preparations,...[...this.pending.values()].map(value=>value.result)]);}
}
