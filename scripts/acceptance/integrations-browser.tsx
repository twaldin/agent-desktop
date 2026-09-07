import {createRoot} from 'react-dom/client';
import {useState,type Dispatch,type SetStateAction} from 'react';
import {NativeIntegrations} from '../../apps/desktop/src/renderer/NativeIntegrations';
import {SettingsSidebar} from '../../apps/desktop/src/renderer/SettingsSidebar';
import type {DesktopBridge} from '@agent-desktop/shared';
import '../../apps/desktop/src/renderer/styles.css';
import '../../apps/desktop/src/renderer/theme.css';
const endpoint=new URLSearchParams(location.search).get('endpoint')!;
const docs:string[]=[];
document.documentElement.dataset.theme='dark';
const request=async<T,>(route:string,body:unknown):Promise<T>=>{
  const response=await fetch(endpoint+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const value=await response.json();if(!response.ok)throw new Error(value.error??'Configuration request failed');return value;
};
const bridge={subscribe:()=>()=>{},getPlugins:(target,hostId)=>request('/plugins/read',{target}),mutatePlugin:(target,mutation)=>request('/plugins/mutate',{target,mutation}),getMcpServers:target=>request('/mcp/read',{target}),mutateMcpServer:(target,mutation)=>request('/mcp/mutate',{target,mutation}),openExternal:async(url:string)=>{docs.push(url);}} satisfies Pick<DesktopBridge,'subscribe'|'getPlugins'|'mutatePlugin'|'getMcpServers'|'mutateMcpServer'|'openExternal'>;
let setConnection:Dispatch<SetStateAction<boolean>>|undefined;
function Fixture(){const[page,setPage]=useState<'plugins'|'mcp'>('plugins');const[connected,setConnected]=useState(true);setConnection=setConnected;return <div className="app-shell settings-open" data-connected={connected} style={{display:'flex',height:'100vh',width:'100vw'}}><SettingsSidebar page={page} onSelect={value=>{if(value==='plugins'||value==='mcp')setPage(value);}} onBack={()=>{}}/><NativeIntegrations key={page} bridge={bridge as DesktopBridge} hostId="isolated-worker" hostName="Integration fixture" connected={connected} target={{projectId:'fixture'}} page={page} onPageChange={setPage} onClose={()=>{}}/></div>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
Object.assign(window,{
 acceptanceTarget(selector:string,text?:string){const items=[...document.querySelectorAll<HTMLElement>(selector)],item=text===undefined?items[0]:items.find(x=>x.textContent?.trim()===text||x.getAttribute('aria-label')===text);if(!item)throw new Error(`Missing ${selector} ${text??''}`);item.scrollIntoView({block:'center'});const r=item.getBoundingClientRect();if(!r.width||!r.height)throw new Error('Target is hidden');return{x:r.left+r.width/2,y:r.top+r.height/2};},
 acceptanceSetConnected(value:boolean){setConnection?.(value);},
 acceptanceDelayState(){return request<{held:boolean}>('/test/delay-state',{});},
 acceptanceRelease(){return request<{released:boolean}>('/test/release',{});},
 acceptanceState(){const measured=(selector:string)=>[...document.querySelectorAll<HTMLElement>(selector)].filter(x=>x.getClientRects().length).map((x,index)=>{const r=x.getBoundingClientRect(),s=getComputedStyle(x);return{selector,index,rect:{x:r.x,y:r.y,width:r.width,height:r.height},fontSize:s.fontSize,lineHeight:s.lineHeight,background:s.backgroundColor,color:s.color,borderColor:s.borderColor}});return{viewport:{width:innerWidth,height:innerHeight},dpr:devicePixelRatio,zoom:visualViewport?.scale,theme:document.documentElement.dataset.theme,font:getComputedStyle(document.body).fontFamily,bodyStyle:{background:getComputedStyle(document.body).backgroundColor,color:getComputedStyle(document.body).color,fontSize:getComputedStyle(document.body).fontSize},body:document.body.innerText,active:(document.activeElement as HTMLElement|null)?.getAttribute('aria-label')??(document.activeElement as HTMLElement|null)?.textContent?.trim(),docs:[...docs],geometry:[...measured('.integration-content'),...measured('.mcp-add'),...measured('.mcp-form-heading'),...measured('.mcp-form-group'),...measured('.mcp-form-section'),...measured('.mcp-add .text-field'),...measured('.mcp-add button')],fields:[...document.querySelectorAll<HTMLInputElement>('input,textarea,select')].map(x=>({label:x.getAttribute('aria-label')??x.closest('label')?.textContent,type:x.type,value:x.type==='password'?'[masked]':x.value,disabled:x.disabled})),scrollWidth:document.documentElement.scrollWidth};},
 async acceptanceWait(code:string){const start=Date.now();while(Date.now()-start<10000){if((0,eval)(code))return;await new Promise(r=>setTimeout(r,25));}throw new Error('Condition did not settle: '+code);}
});
