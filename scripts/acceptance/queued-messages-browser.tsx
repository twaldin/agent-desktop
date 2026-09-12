import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { DesktopBridge } from "../../packages/shared/src/protocol";
import type { NativeQueuedMessagesSnapshot, NativeQueuedMessageMutation } from "../../packages/shared/src/queued-messages";
import { QueuedMessages } from "../../apps/desktop/src/renderer/QueuedMessages";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";
const rows = ["first","second","follow-up"].map((id,index) => ({ id:`epoch:${id}`,lane:index===2?"follow-up" as const:"steer" as const,text:`${id} original queued text`,imageCount:index===1?2:0,position:index,ownership:"desktop-pending" as const,editable:false,removable:true,promotable:index===2 }));
let snapshot:NativeQueuedMessagesSnapshot={revision:1,streaming:true,messages:rows};
const calls:unknown[]=[];let listener:((event:{hostId:string;sessionId:string})=>void)|undefined;let fail=false;
const bridge = {
 async getQueuedMessages(sessionId:string,hostId:string) { return {protocolVersion:1 as const,sessionId,hostId,...structuredClone(snapshot)}; },
 async mutateQueuedMessages(sessionId:string,mutation:NativeQueuedMessageMutation,hostId:string) {
  calls.push({sessionId,hostId,mutation:structuredClone(mutation)});
  if(fail)throw Error("Original queue update refused");
  if(mutation.expectedRevision!==snapshot.revision)throw Error("Stale queue");
  if(mutation.type==='remove')snapshot.messages=snapshot.messages.filter(row=>row.id!==mutation.messageId);
  else if(mutation.type==='promote'){const row=snapshot.messages.find(row=>row.id===mutation.messageId)!;row.lane='steer';row.promotable=false;}
  else snapshot.messages=mutation.messageIds.map(id=>snapshot.messages.find(row=>row.id===id)!);
  snapshot={...snapshot,revision:snapshot.revision+1,messages:snapshot.messages.map((row,position)=>({...row,position}))};
  listener?.({hostId,sessionId});
  return {type:'native-queued-messages' as const,mutation:mutation.type,...('messageId' in mutation?{messageId:mutation.messageId}:{}),snapshot:structuredClone(snapshot)};
 },
 subscribeQueuedMessages(callback:typeof listener){listener=callback;return()=>{listener=undefined;};},
} as Pick<DesktopBridge,'getQueuedMessages'|'mutateQueuedMessages'|'subscribeQueuedMessages'> as DesktopBridge;
function Fixture(){const[connected,setConnected]=useState(true);Object.assign(window,{queueFixture:{calls,setConnected,seedMany(){snapshot={...snapshot,revision:snapshot.revision+1,messages:Array.from({length:30},(_,position)=>({...rows[0]!,id:`many:${position}`,position,text:"Long queued instructions ".repeat(20)}))};listener?.({hostId:"original-host",sessionId:"original-session"});},setFail(value:boolean){fail=value;},state(){return{ids:[...document.querySelectorAll('[data-queue-id]')].map(e=>e.getAttribute('data-queue-id')),error:document.querySelector('[role=alert]')?.textContent,calls,bodyWidth:document.body.scrollWidth,width:innerWidth};}}});return <main className="main-panel"><div className="welcome"/><div className="composer-region"><QueuedMessages bridge={bridge} hostId="original-host" sessionId="original-session" connected={connected} archived={false}/><form className="composer"><textarea aria-label="Prompt" placeholder="Ask anything"/></form></div></main>}
createRoot(document.getElementById('root')!).render(<Fixture/>);
