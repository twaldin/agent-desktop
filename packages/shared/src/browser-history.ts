import type { BrowserFrameTarget } from "./browser";
import { validBrowserFrameTarget } from "./browser-frame";

export const BROWSER_HISTORY_PROTOCOL_VERSION = 1 as const;
export interface BrowserHistoryRequest { requestId:string; target:BrowserFrameTarget; query:string }
export interface BrowserHistoryOwner { kind:"session"|"draft"; id:string }
export interface BrowserHistoryEntry { id:string; url:string; title:string; current:boolean }
export interface BrowserHistoryResult {
  protocolVersion:typeof BROWSER_HISTORY_PROTOCOL_VERSION;hostId:string;owner:BrowserHistoryOwner;requestId:string;
  target:BrowserFrameTarget;query:string;revision:string;entries:BrowserHistoryEntry[];
}
const safe=(value:unknown,max:number,empty=false):value is string=>typeof value==="string"&&(empty||value.length>0)&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const exact=(value:unknown,fields:readonly string[],label:string):Record<string,unknown>=>{if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>!fields.includes(key)))throw new Error(`Invalid ${label}.`);return value as Record<string,unknown>;};
export function parseBrowserHistoryRequest(value:unknown):BrowserHistoryRequest{
  const input=exact(value,["requestId","target","query"],"browser history request");
  if(!safe(input.requestId,100)||!validBrowserFrameTarget(input.target)||!safe(input.query,8192,true))throw new Error("Invalid browser history request.");
  const target=input.target as BrowserFrameTarget;return{requestId:input.requestId as string,target:{workerPid:target.workerPid,name:target.name,targetId:target.targetId},query:input.query as string};
}
export function parseBrowserHistoryResult(value:unknown,hostId:string,owner:BrowserHistoryOwner,request:BrowserHistoryRequest):BrowserHistoryResult{
  const input=exact(value,["protocolVersion","hostId","owner","requestId","target","query","revision","entries"],"browser history result"),receivedOwner=exact(input.owner,["kind","id"],"browser history owner");
  if(input.protocolVersion!==BROWSER_HISTORY_PROTOCOL_VERSION||input.hostId!==hostId||receivedOwner.kind!==owner.kind||receivedOwner.id!==owner.id||input.requestId!==request.requestId||input.query!==request.query||!validBrowserFrameTarget(input.target)||JSON.stringify(input.target)!==JSON.stringify(request.target)||!safe(input.revision,128)||!Array.isArray(input.entries)||input.entries.length>100)throw new Error("Browser history result changed its owner, target, query, or revision.");
  const rawEntries=input.entries as unknown[];const entries=Array.from({length:rawEntries.length},(_,index)=>{const row=exact(rawEntries[index],["id","url","title","current"],"browser history entry");if(!safe(row.id,128)||!safe(row.url,8192)||!safe(row.title,1024,true)||typeof row.current!=="boolean")throw new Error("Invalid browser history entry.");return{id:row.id,url:row.url,title:row.title,current:row.current};});
  if(new Set(entries.map(row=>row.id)).size!==entries.length||entries.filter(row=>row.current).length>1)throw new Error("Browser history entries are ambiguous.");
  return{protocolVersion:1,hostId,owner:{...owner},requestId:request.requestId,target:{...request.target},query:request.query,revision:input.revision as string,entries};
}
