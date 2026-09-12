import { expect, test } from "bun:test";
import { BrowserAutocompleteRecords } from "./browser-autocomplete-records";
import { BrowserAutocompleteService } from "./browser-autocomplete-service";

const target={workerPid:42,name:"tab",targetId:"target"},owner={kind:"session" as const,id:"session"};
const request=(id:string,query="exam")=>({action:"start" as const,editingSessionId:"edit",requestId:id,target,query,cursorPosition:query.length,preventInlineAutocomplete:false});
const records=()=>{let saved:unknown;return new BrowserAutocompleteRecords(()=>saved,value=>{saved=value},()=>1000)};
test("replacement fences the old native read and tokens bind the active request",async()=>{
  const store=records(),service=new BrowserAutocompleteService("host",store),gates=[Promise.withResolvers<any[]>(),Promise.withResolvers<any[]>()];let calls=0;
  const handle={workerPid:42,getBrowserHistory:()=>gates[calls++]!.promise};
  const first=service.execute(owner,request("one"),handle,()=>true),second=service.execute(owner,request("two"),handle,()=>true);
  gates[0]!.resolve([]);await expect(first).rejects.toThrow("changed");gates[1]!.resolve([{id:"1",url:"https://example.com/",title:"Example",current:true}]);
  const result=await second,match=result.matches!.find(row=>row.type==="history")!;
  await expect(service.execute(owner,{action:"delete",editingSessionId:"edit",requestId:"one",target,deleteToken:match.deleteToken!},handle,()=>true)).rejects.toThrow("no longer active");
  expect((await service.execute(owner,{action:"delete",editingSessionId:"edit",requestId:"two",target,deleteToken:match.deleteToken!},handle,()=>true)).state).toBe("deleted");
});
test("completed host navigation records native current history without a prior autocomplete request",async()=>{
  const store=records(),service=new BrowserAutocompleteService("host",store);
  const handle={workerPid:42,getBrowserHistory:async()=>[{id:"native-2",url:"https://navigated.example/path",title:"Navigated",current:true}]};
  await service.observeNavigation(owner,target,handle,()=>true);
  expect(store.matches("navigated",()=>"opaque")).toMatchObject([{type:"history",destinationURL:"https://navigated.example/path"},{type:"search-what-you-typed"}]);
});
test("retiring an owner invalidates its active token without affecting another owner",async()=>{
  const store=records(),service=new BrowserAutocompleteService("host",store),handle={workerPid:42,getBrowserHistory:async()=>[{id:"1",url:"https://example.com/",title:"Example",current:true}]};
  const first=await service.execute(owner,request("one"),handle,()=>true),other={kind:"draft" as const,id:"draft"};
  const second=await service.execute(other,request("two"),handle,()=>true);service.retire(owner);
  await expect(service.execute(owner,{action:"accept",editingSessionId:"edit",requestId:"one",target,acceptToken:first.matches![0]!.acceptToken!},handle,()=>true)).rejects.toThrow("no longer active");
  expect((await service.execute(other,{action:"accept",editingSessionId:"edit",requestId:"two",target,acceptToken:second.matches![0]!.acceptToken!},handle,()=>true)).state).toBe("accepted");
});
