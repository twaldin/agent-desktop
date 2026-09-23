import { expect, test } from "bun:test";
import { NativeSessionImportState, type NativeImportReadBridge } from "./native-session-import-state";
const rows = [{ candidateId: "one", sourcePath: "/original/one" }, { candidateId: "two", sourcePath: "/original/two" }];
const listing = { version: 1 as const, hostId: "host", candidates: rows };
const inspection = (candidateId: string) => ({ version: 1 as const, hostId: "host", inspection: { candidateId, revision: "revision", originalFile: "/original/" + candidateId,
  entries: 2, messages: 1, malformedRecords: 0, issues: [], writeAdmission: { allowed: false as const, reason: "ownership-unverified" as const } } });
const gate = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; };
test("explicit original-host reads send opaque IDs, preserve source inspection and never dispatch a mutation", async () => {
  const calls: unknown[] = [];
  const bridge: NativeImportReadBridge = { listNativeSessionImports: async (host, id) => { calls.push([host, id]); return listing; }, inspectNativeSessionImport: async (host, candidate, id) => { calls.push([host, candidate, id]); return inspection(candidate); } };
  const state = new NativeSessionImportState("host", bridge); state.configure(true); expect(calls).toEqual([]);
  await state.refresh(); await state.inspect("one");
  expect(state.getSnapshot().inspection?.writeAdmission.allowed).toBe(false);
  expect(calls).toHaveLength(2); expect(calls[1]).toEqual(["host", "one", expect.any(String)]);
  await state.inspect("/arbitrary/path"); expect(calls).toHaveLength(2);
});
test("observed disconnect cancels the original request and a late reply cannot revive on reconnect", async () => {
  const pending = gate<typeof listing>(), cancelled: string[] = [];
  const state = new NativeSessionImportState("host", { listNativeSessionImports: () => pending.promise, inspectNativeSessionImport: async id => inspection(id), cancelNativeSessionImportRead: async (host, id) => { cancelled.push(host + ":" + id); } });
  state.configure(true); const read = state.refresh(); state.configure(false); state.configure(true);
  pending.resolve(listing); await read;
  expect(cancelled).toHaveLength(1); expect(cancelled[0]).toStartWith("host:"); expect(state.getSnapshot().fresh).toBe(false); expect(state.getSnapshot().candidates).toEqual([]);
});
test("a later selected original wins even when the first inspection resolves last", async () => {
  const pending = gate<ReturnType<typeof inspection>>(), calls: string[] = [];
  const state = new NativeSessionImportState("host", { listNativeSessionImports: async () => listing, inspectNativeSessionImport: async (_host, id) => { calls.push(id); return id === "one" ? pending.promise : inspection(id); } });
  state.configure(true); await state.refresh(); const old = state.inspect("one"); await state.inspect("two"); pending.resolve(inspection("one")); await old;
  expect(calls).toEqual(["one", "two"]); expect(state.getSnapshot().selected).toBe("two"); expect(state.getSnapshot().inspection?.candidateId).toBe("two");
});
test("foreign replies fail visibly and failed refresh cannot reuse prior inspection for admission", async () => {
  let fail = false;
  const state = new NativeSessionImportState("host", { listNativeSessionImports: async () => { if (fail) throw new Error("original unavailable"); return listing; }, inspectNativeSessionImport: async () => ({ ...inspection("one"), hostId: "other" }) });
  state.configure(true); await state.refresh(); await state.inspect("one"); expect(state.getSnapshot().error).toContain("another host"); expect(state.getSnapshot().inspection).toBeUndefined();
  fail = true; await state.refresh(); expect(state.getSnapshot().fresh).toBe(false); expect(state.getSnapshot().error).toBe("original unavailable");
});

function admissionFixture(){
  const saved=new Map<string,string>(),calls:Array<{commandId:string;preparationId:string}>=[];
  const original={sessionId:"native",originalFile:"/original/one",cwd:"/project"};
  const prepared={version:1 as const,hostId:"host",candidateId:"one",revision:"revision",state:"ready" as const,preparationId:"prepared",original};
  const bridge:NativeImportReadBridge={listNativeSessionImports:async()=>listing,inspectNativeSessionImport:async()=>({...inspection("one"),inspection:{...inspection("one").inspection,nativeId:"native",recordedCwd:"/project"}}),
    prepareNativeSessionImport:async()=>prepared,
    admitNativeSessionImport:async(_host,input)=>{calls.push({...input});throw new Error("Lost original reply")},
    getNativeSessionImportOutcome:async(_host,commandId)=>({version:1,hostId:"host",commandId,state:"imported",original})};
  const storage={get length(){return saved.size},key:(index:number)=>[...saved.keys()][index]??null,getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>{saved.set(key,value)}};
  return{saved,calls,bridge,storage,prepared};
}
test("confirmation saves the exact command before dispatch; a lost reply and remount recover without replay",async()=>{
  const f=admissionFixture(),state=new NativeSessionImportState("host",f.bridge,f.storage);state.configure(true,true);
  await state.refresh();await state.inspect("one");await state.prepare();expect(f.calls).toEqual([]);expect(f.saved.size).toBe(0);
  await state.confirm();expect(f.calls).toHaveLength(1);expect(state.getSnapshot().outcome?.state).toBe("unknown");
  const retained=JSON.parse(f.saved.get(state.storageKey+f.calls[0]!.commandId)!);expect(retained.commandId).toBe(f.calls[0]!.commandId);expect(retained.preparation.preparationId).toBe("prepared");
  await state.confirm();expect(f.calls).toHaveLength(1);
  const reopened=new NativeSessionImportState("host",f.bridge,f.storage);reopened.configure(true,true);expect(f.calls).toHaveLength(1);
  await reopened.checkOutcome();expect(reopened.getSnapshot().outcome).toMatchObject({state:"imported",original:f.prepared.original});expect(f.calls).toHaveLength(1);
});
test("storage failure, source replacement, and capability loss cannot dispatch an original import",async()=>{
  const f=admissionFixture(),state=new NativeSessionImportState("host",f.bridge,{...f.storage,setItem(){throw Error("disk full")}});state.configure(true,true);
  await state.refresh();await state.inspect("one");await state.prepare();await state.confirm();expect(f.calls).toHaveLength(0);expect(state.getSnapshot().error).toContain("Nothing was submitted");
  const held=gate<typeof f.prepared>();f.bridge.prepareNativeSessionImport=()=>held.promise;
  const live=new NativeSessionImportState("host",f.bridge,f.storage);live.configure(true,true);await live.refresh();await live.inspect("one");
  const preparing=live.prepare();live.configure(true,false);held.resolve(f.prepared);await preparing;await live.confirm();
  expect(f.calls).toHaveLength(0);expect(live.getSnapshot().preparation).toBeUndefined();
  const wrong=admissionFixture();wrong.bridge.prepareNativeSessionImport=async()=>({...wrong.prepared,original:{...wrong.prepared.original,originalFile:"/replacement"}});
  const replaced=new NativeSessionImportState("host",wrong.bridge,wrong.storage);replaced.configure(true,true);await replaced.refresh();await replaced.inspect("one");await replaced.prepare();
  expect(replaced.getSnapshot().error).toContain("inspected original");await replaced.confirm();expect(wrong.calls).toHaveLength(0);
});
test("only an explicit unseen retry resends the saved command and preparation",async()=>{
  const f=admissionFixture(),state=new NativeSessionImportState("host",f.bridge,f.storage);state.configure(true,true);await state.refresh();await state.inspect("one");await state.prepare();await state.confirm();
  f.bridge.getNativeSessionImportOutcome=async(_host,commandId)=>({version:1,hostId:"host",commandId,state:"absent"});
  await state.checkOutcome();expect(f.calls).toHaveLength(1);await state.retryUnseen();expect(f.calls).toHaveLength(2);expect(f.calls[1]).toEqual(f.calls[0]);
});

test("two windows retain distinct pending commands and recover either without replay",async()=>{
  const f=admissionFixture(), first=new NativeSessionImportState("host",f.bridge,f.storage),second=new NativeSessionImportState("host",f.bridge,f.storage);
  for(const state of [first,second]){state.configure(true,true);await state.refresh();await state.inspect("one");await state.prepare();}
  const held=gate<void>();
  f.bridge.admitNativeSessionImport=async(_host,input)=>{f.calls.push({...input});await held.promise;throw new Error("Lost original reply");};
  const a=first.confirm(),b=second.confirm();
  expect(f.calls).toHaveLength(2);expect(f.calls[0]!.commandId).not.toBe(f.calls[1]!.commandId);expect(f.saved.size).toBe(2);
  const recovered=new NativeSessionImportState("host",f.bridge,f.storage);recovered.configure(true,true);
  expect(recovered.getSnapshot().savedCommands).toHaveLength(2);
  for(const command of f.calls){recovered.selectRecovery(command.commandId);await recovered.checkOutcome();expect(recovered.getSnapshot().outcome).toMatchObject({commandId:command.commandId,state:"imported"});}
  expect(f.calls).toHaveLength(2);
  // Settle both original callers after the independent recovery checks.
  held.resolve();await Promise.all([a,b]);
  expect(f.saved.size).toBe(2);
});

test("checking a saved outcome cancels an in-flight listing without leaving its loading state stuck",async()=>{
  const f=admissionFixture(),first=new NativeSessionImportState("host",f.bridge,f.storage);first.configure(true,true);
  await first.refresh();await first.inspect("one");await first.prepare();await first.confirm();
  const held=gate<typeof listing>();f.bridge.listNativeSessionImports=()=>held.promise;
  const reopened=new NativeSessionImportState("host",f.bridge,f.storage);reopened.configure(true,true);
  const refreshing=reopened.refresh();expect(reopened.getSnapshot().loading).toBe("list");
  await reopened.checkOutcome();expect(reopened.getSnapshot().loading).toBeUndefined();expect(reopened.getSnapshot().outcome?.state).toBe("imported");
  held.resolve(listing);await refreshing;expect(reopened.getSnapshot().fresh).toBe(false);expect(reopened.getSnapshot().candidates).toEqual([]);
  expect(f.calls).toHaveLength(1);
});
