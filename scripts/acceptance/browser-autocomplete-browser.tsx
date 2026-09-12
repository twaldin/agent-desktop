import { createRoot } from "react-dom/client";
import { BrowserPanel } from "../../apps/desktop/src/renderer/BrowserPanel";
import type { DesktopBridge } from "@agent-desktop/shared";
import "../../apps/desktop/src/renderer/styles.css";

declare global { interface Window { browserAutocompleteBridge: DesktopBridge & { pointer(x:number,y:number):Promise<void> }; runBrowserAutocompleteAcceptance():Promise<unknown> } }
const root=createRoot(document.getElementById("root")!),params=new URLSearchParams(location.search);
const target={workerPid:Number(params.get("workerPid")),name:params.get("name")!,targetId:params.get("targetId")!};
const hostId=params.get("hostId")!,sessionId=params.get("sessionId")!,origin=params.get("origin")!;
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function waitFor(test:()=>unknown,label:string){for(let attempt=0;attempt<240;attempt++){if(test())return;await sleep(25)}throw new Error(`Timed out waiting for ${label}`)}
function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(message)}
function input(){return document.querySelector<HTMLInputElement>('[aria-label="Page address"]')!}
async function edit(value:string){const field=input();field.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field,value);field.dispatchEvent(new Event("input",{bubbles:true}));await sleep(0)}
async function navigate(value:string){await edit(value);input().form!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));}
async function rows(){try{await waitFor(()=>document.querySelector('[role="listbox"][aria-label="Address suggestions"]'),"address suggestions")}catch(error){const field=input();throw new Error(`${error instanceof Error?error.message:String(error)}; bridge=${typeof window.browserAutocompleteBridge.browserAutocomplete}; focused=${document.activeElement===field}; expanded=${field.getAttribute("aria-expanded")}; value=${field.value}`)}return [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')]}
async function waitForNative(url:string){for(let attempt=0;attempt<120;attempt++){try{const value=await window.browserAutocompleteBridge.getBrowserHistory!(sessionId,{requestId:crypto.randomUUID(),target,query:""},hostId);if(value.entries.some(entry=>entry.current&&entry.url===url))return}catch{}await sleep(50)}throw new Error(`Timed out waiting for ${url}`)}

window.runBrowserAutocompleteAcceptance=async()=>{
  root.render(<BrowserPanel bridge={window.browserAutocompleteBridge} hostId={hostId} sessionId={sessionId} nativeTarget={target} active/>);
  await waitFor(()=>document.querySelector<HTMLImageElement>(".browser-viewport img")?.naturalWidth,"initial native frame");
  const metadata=await window.browserAutocompleteBridge.getBrowserMetadata!(sessionId,hostId);
  input().blur();await sleep(25);const bounds=input().getBoundingClientRect();await window.browserAutocompleteBridge.pointer(Math.round(bounds.left+bounds.width/2),Math.round(bounds.top+bounds.height/2));input().dispatchEvent(new FocusEvent("focusin",{bubbles:true}));
  await edit(input().value);let visible=await rows();
  assert(visible.some(row=>row.textContent?.includes("one")),"Native current history was not offered");
  const remove=visible.map(row=>row.querySelector<HTMLButtonElement>('[aria-label^="Remove suggestion"]')).find(Boolean);
  assert(remove,"History row had no deletion action");remove.click();
  await waitFor(()=>![...document.querySelectorAll<HTMLElement>('[role="option"]')].some(row=>row.querySelector('[aria-label^="Remove suggestion"]')),"deleted native row to remain absent");
  input().blur();await sleep(25);await edit("exam");await waitFor(()=>[...document.querySelectorAll<HTMLElement>('[role="option"]')].some(row=>row.textContent?.includes("Search the web for ‘exam’")),"Search web result for current query");visible=await rows();
  assert(visible.some(row=>row.textContent?.includes("Search the web for ‘exam’")),"Search web row was absent");
  assert(!visible.some(row=>row.querySelector('[aria-label^="Remove suggestion"]')),"Deleted unchanged native row returned");
  input().blur();await sleep(25);await navigate(`${origin}/two`);await waitForNative(`${origin}/two`);
  await waitFor(()=>input().value.endsWith("/two"),"second page address");
  await edit("two");await waitFor(()=>[...document.querySelectorAll<HTMLElement>('[role="option"]')].some(row=>row.textContent?.includes("Search the web for ‘two’")),"second query suggestions");visible=await rows();
  assert(visible.some(row=>row.textContent?.includes("two")&&row.querySelector('[aria-label^="Remove suggestion"]')),"Completed navigation was not recorded from native history");
  const searchCount=visible.filter(row=>row.textContent?.includes("Search the web")).length;
  assert(searchCount===1,"Search row was duplicated");
  const historyRemove=visible.map(row=>row.querySelector<HTMLButtonElement>('[aria-label^="Remove suggestion"]')).find(Boolean);
  assert(historyRemove,"Recorded navigation had no delete action");historyRemove.click();
  await waitFor(()=>![...document.querySelectorAll<HTMLElement>('[role="option"]')].some(row=>row.querySelector('[aria-label^="Remove suggestion"]')),"second deletion");
  const final=await window.browserAutocompleteBridge.browserAutocomplete!(sessionId,{action:"start",editingSessionId:"final-edit",requestId:"final-request",target,query:"",cursorPosition:0,preventInlineAutocomplete:false},hostId);
  assert(final.state==="matches"&&final.matches?.length===0,"Deleted history remained in authoritative host results");
  root.render(null);
  return {passed:true,target,searchCount,deletedHistory:true,hostRevision:final.revision,metadata,
    scope:"Production BrowserPanel mounted in Electron through authenticated production transports and a real isolated OMP CDP target. DOM focus/input is controlled; this proves project-owned observed navigation history, deletion, and the app Search web row, not personal Chrome history, search-engine suggestions, physical focus, cmux, or a whole-App capture."};
};
