import {createRoot} from 'react-dom/client';
import {SessionMcp} from '../../apps/desktop/src/renderer/SessionMcp';
import type {DesktopBridge} from '@agent-desktop/shared';
import '../../apps/desktop/src/renderer/styles.css';
import '../../apps/desktop/src/renderer/theme.css';
import '../../apps/desktop/src/renderer/native-integrations.css';
const query=new URLSearchParams(location.search),endpoint=query.get('endpoint')!,sessionId=query.get('sessionId')!;
async function request(route:string,body?:unknown){const response=await fetch(endpoint+route,{...(body?{method:'POST',body:JSON.stringify(body),headers:{'Content-Type':'application/json'}}:{})});const value=await response.json();if(!response.ok)throw new Error(value?.error?.message??'Controlled MCP endpoint unavailable');return value;}
const bridge={readSessionMcpResource:(_session:string,input:unknown)=>request('/resource',input).then(value=>value.value),getSessionMcp:(_session:string,_host:string,commandId?:string)=>request('/read'+(commandId?'?commandId='+encodeURIComponent(commandId):'')),command:(envelope:unknown)=>request('/reload',envelope)} as DesktopBridge;
createRoot(document.getElementById('root')!).render(<main className="settings-page native-integrations"><div className="integration-content"><SessionMcp bridge={bridge} sessionId={sessionId} hostId="fixture" connected idle/></div></main>);
Object.assign(window,{
 acceptanceTarget(selector:string,text?:string){const item=[...document.querySelectorAll<HTMLElement>(selector)].find(x=>text===undefined||x.textContent?.trim()===text);if(!item)throw new Error('Missing target');const r=item.getBoundingClientRect();if(!r.width||!r.height)throw new Error('Hidden target');return{x:r.left+r.width/2,y:r.top+r.height/2};},
 acceptanceState(){return{viewport:{width:innerWidth,height:innerHeight},dpr:devicePixelRatio,font:getComputedStyle(document.body).fontFamily,body:document.body.innerText,buttons:[...document.querySelectorAll('button')].map(x=>({text:x.textContent,disabled:x.disabled})),scrollWidth:document.documentElement.scrollWidth};},
 async acceptanceWait(code:string){const end=Date.now()+10000;while(Date.now()<end){if((0,eval)(code))return;await new Promise(r=>setTimeout(r,25));}throw new Error('Condition did not settle: '+code);}
});
