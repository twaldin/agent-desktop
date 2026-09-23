import { parseNativeImportInspection, parseNativeImportListing, parseNativeImportPreparation,parseNativeImportOutcome,nativeImportCommandId,
  type DesktopBridge, type NativeImportCandidate, type NativeImportInspection,type NativeImportPreparation,type NativeImportOutcome } from "@agent-desktop/shared";
export type NativeImportReadBridge = Pick<DesktopBridge, "listNativeSessionImports" | "inspectNativeSessionImport" | "cancelNativeSessionImportRead" | "prepareNativeSessionImport" | "admitNativeSessionImport" | "getNativeSessionImportOutcome">;
type ReadyPreparation=Extract<NativeImportPreparation,{state:"ready"}>;
interface SavedImport {version:1;hostId:string;commandId:string;preparation:ReadyPreparation}
export interface NativeImportStorage {readonly length:number;key(index:number):string|null;getItem(key:string):string|null;setItem(key:string,value:string):void}
export interface NativeImportView {
  savedCommands: SavedImport[]; connected: boolean; loading?: "list" | "inspection"; candidates: NativeImportCandidate[];
  selected?: string; inspection?: NativeImportInspection; fresh: boolean; error?: string;
  admissionAvailable?:boolean;operation?:"prepare"|"admit"|"status";preparation?:NativeImportPreparation;saved?:SavedImport;outcome?:NativeImportOutcome;
}
/** One explicit picker owns its original host's reads. Reconnection never turns
 * cached inspection into write authority; a new inspection is always needed. */
export class NativeSessionImportState {
  private view: NativeImportView = { savedCommands: [], connected: false, candidates: [], fresh: false };
  private current?: string;
  private generation=0;
  private storageFailed=false;
  readonly storageKey:string;
  private listeners = new Set<() => void>();
  constructor(readonly hostId: string, private readonly bridge: NativeImportReadBridge,private readonly storage?:NativeImportStorage) {
    this.storageKey="native-session-import.v1:"+encodeURIComponent(hostId)+":";
    this.refreshRecovery();
  }
  /** A separate immutable key per command prevents different windows from
   * overwriting unresolved requests. Reading recovery never dispatches work. */
  refreshRecovery():void {
    if (!this.storage || this.view.operation) return;
    try {
      const keys: string[] = [];
      for (let i=0;i<this.storage.length;i++) {
        const key=this.storage.key(i);
        if(key?.startsWith(this.storageKey)) keys.push(key);
      }
      if(keys.length>1000) throw new Error("Too many saved import commands.");
      const savedCommands:SavedImport[]=[];
      for(const key of keys.sort()) {
        const raw=this.storage.getItem(key);
        if(raw===null)continue;
        if(raw.length>16384)throw new Error("Saved import exceeds its limit.");
        const value=JSON.parse(raw) as SavedImport;
        if(value.version!==1||value.hostId!==this.hostId)throw new Error("Saved import belongs to another host.");
        const commandId=nativeImportCommandId(value.commandId);
        if(key!==this.storageKey+commandId)throw new Error("Saved import command identity changed.");
        const preparation=parseNativeImportPreparation(value.preparation,this.hostId,value.preparation.candidateId,value.preparation.revision);
        if(preparation.state!=="ready")throw new Error("Saved import lost its confirmed preparation.");
        savedCommands.push({version:1,hostId:this.hostId,commandId,preparation});
      }
      this.storageFailed=false;
      this.publish({savedCommands,saved:this.view.saved??savedCommands.at(-1)});
    }catch(error){this.storageFailed=true;this.publish({error:"Import recovery could not be read. New imports are paused. "+(error instanceof Error?error.message:String(error))});}
  }
  selectRecovery(commandId:string):void {
    if(this.view.operation)return;
    this.refreshRecovery();
    const saved=this.view.savedCommands.find(value=>value.commandId===commandId);
    if(saved)this.publish({saved,outcome:undefined,preparation:undefined});
  }

  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(value: Partial<NativeImportView>) { this.view = { ...this.view, ...value }; for (const listener of this.listeners) listener(); }
  private cancel() {
    const id = this.current; this.current = undefined;
    if (id) void this.bridge.cancelNativeSessionImportRead?.(this.hostId, id).catch(() => {});
  }
  configure(connected: boolean,admissionAvailable=false) {
    const available = connected && !!this.bridge.listNativeSessionImports && !!this.bridge.inspectNativeSessionImport;
    const admission=available&&admissionAvailable&&!!this.bridge.prepareNativeSessionImport&&!!this.bridge.admitNativeSessionImport&&!!this.bridge.getNativeSessionImportOutcome;
    if (available === this.view.connected&&admission===!!this.view.admissionAvailable) return;
    this.generation++;this.cancel(); this.publish({ connected: available, admissionAvailable:admission,loading: undefined, fresh: false, inspection: undefined,preparation:undefined });
  }
  async refresh(): Promise<void> {
    if (!this.view.connected||this.view.operation) return;
    this.refreshRecovery();
    this.cancel(); const id = crypto.randomUUID(); this.current = id;
    this.publish({ loading: "list", selected: undefined, inspection: undefined,preparation:undefined, fresh: false, error: this.storageFailed?this.view.error:undefined });
    try {
      if(this.current!==id||!this.view.connected)return;
      const reply = parseNativeImportListing(await this.bridge.listNativeSessionImports!(this.hostId, id), this.hostId);
      if (this.current !== id || !this.view.connected) return;
      this.publish({ candidates: reply.candidates, fresh: true });
    } catch (error) { if (this.current === id) this.publish({ error: error instanceof Error ? error.message : "Native sessions could not be listed." }); }
    finally { if (this.current === id) { this.current = undefined; this.publish({ loading: undefined }); } }
  }
  async inspect(candidateId: string): Promise<void> {
    if (!this.view.connected || !this.view.fresh || this.view.operation || !this.view.candidates.some(row => row.candidateId === candidateId)) return;
    this.cancel(); const id = crypto.randomUUID(); this.current = id;
    this.publish({ loading: "inspection", selected: candidateId, inspection: undefined,preparation:undefined, error: this.storageFailed?this.view.error:undefined });
    try {
      if(this.current!==id||!this.view.connected)return;
      const reply = parseNativeImportInspection(await this.bridge.inspectNativeSessionImport!(this.hostId, candidateId, id), this.hostId, candidateId);
      if (this.current !== id || !this.view.connected) return;
      this.publish({ inspection: reply.inspection });
    } catch (error) { if (this.current === id) this.publish({ error: error instanceof Error ? error.message : "The original native session could not be inspected." }); }
    finally { if (this.current === id) { this.current = undefined; this.publish({ loading: undefined }); } }
  }
  get unresolved(){return !!this.view.saved&&(!this.view.outcome||["absent","pending","unknown"].includes(this.view.outcome.state));}
  async prepare():Promise<void>{
    const inspected=this.view.inspection;
    if(!this.view.admissionAvailable||!this.view.fresh||!inspected||inspected.issues.length||this.view.operation||this.unresolved||this.storageFailed)return;
    this.cancel();const requestId=crypto.randomUUID(),generation=this.generation;this.current=requestId;
    this.publish({operation:"prepare",error:undefined,preparation:undefined});
    try{
      if(this.current!==requestId||this.generation!==generation)return;
      const result=parseNativeImportPreparation(await this.bridge.prepareNativeSessionImport!(this.hostId,{candidateId:inspected.candidateId,revision:inspected.revision},requestId),this.hostId,inspected.candidateId,inspected.revision);
      if(this.current!==requestId||this.generation!==generation)return;
      if(result.state==="ready"&&(result.original.originalFile!==inspected.originalFile||result.original.sessionId!==inspected.nativeId||result.original.cwd!==inspected.recordedCwd))throw new Error("The prepared import no longer matches the inspected original.");
      this.publish({preparation:result});
    }catch(error){if(this.generation===generation)this.publish({error:error instanceof Error?error.message:String(error)});}
    finally{if(this.current===requestId)this.current=undefined;this.publish({operation:undefined});}
  }
  async confirm():Promise<void>{
    const preparation=this.view.preparation;
    if(!this.view.admissionAvailable||preparation?.state!=="ready"||this.view.operation||this.unresolved||this.storageFailed)return;
    const saved:SavedImport={version:1,hostId:this.hostId,commandId:crypto.randomUUID(),preparation:structuredClone(preparation)};
    try{if(!this.storage)throw new Error("Recovery storage is unavailable.");if(this.view.savedCommands.length>=1000)throw new Error("Saved import command limit reached.");this.storage.setItem(this.storageKey+saved.commandId,JSON.stringify(saved));}
    catch(error){this.publish({error:"The original import request could not be saved. Nothing was submitted. "+(error instanceof Error?error.message:String(error))});return;}
    this.publish({savedCommands:[...this.view.savedCommands,saved]});
    await this.dispatch(saved);
  }
  private async dispatch(saved:SavedImport):Promise<void>{
    const generation=this.generation;
    this.publish({saved,preparation:undefined,operation:"admit",error:undefined,outcome:{version:1,hostId:this.hostId,commandId:saved.commandId,state:"pending"}});
    try{
      if(!this.view.admissionAvailable||this.generation!==generation)throw new Error("The owning host changed before dispatch. Check this saved command before trying again.");
      const outcome=parseNativeImportOutcome(await this.bridge.admitNativeSessionImport!(this.hostId,{commandId:saved.commandId,preparationId:saved.preparation.preparationId}),this.hostId,saved.commandId);
      if(outcome.state==="imported"&&(outcome.original.sessionId!==saved.preparation.original.sessionId||outcome.original.originalFile!==saved.preparation.original.originalFile||outcome.original.cwd!==saved.preparation.original.cwd))throw new Error("The import result names a different original session.");
      this.publish({outcome});
    }catch(error){this.publish({outcome:{version:1,hostId:this.hostId,commandId:saved.commandId,state:"unknown",message:error instanceof Error?error.message:String(error)}});}
    finally{this.publish({operation:undefined});}
  }
  async checkOutcome():Promise<void>{
    const saved=this.view.saved;if(!saved||!this.view.connected||!this.bridge.getNativeSessionImportOutcome||this.view.operation)return;
    this.cancel();const requestId=crypto.randomUUID(),generation=this.generation;this.current=requestId;this.publish({operation:"status",loading:undefined,error:undefined});
    try{
      const result=parseNativeImportOutcome(await this.bridge.getNativeSessionImportOutcome(this.hostId,saved.commandId,requestId),this.hostId,saved.commandId);
      if(this.current!==requestId||this.generation!==generation)return;
      if(result.state==="imported"&&(result.original.sessionId!==saved.preparation.original.sessionId||result.original.originalFile!==saved.preparation.original.originalFile||result.original.cwd!==saved.preparation.original.cwd))throw new Error("The saved import outcome changed its original session.");
      this.publish({outcome:result});
    }catch(error){if(this.generation===generation)this.publish({error:error instanceof Error?error.message:String(error)});}
    finally{if(this.current===requestId)this.current=undefined;this.publish({operation:undefined});}
  }
  async retryUnseen():Promise<void>{
    if(!this.view.saved||this.view.outcome?.state!=="absent"||!this.view.admissionAvailable||this.view.operation||this.storageFailed)return;
    await this.dispatch(this.view.saved);
  }
}
