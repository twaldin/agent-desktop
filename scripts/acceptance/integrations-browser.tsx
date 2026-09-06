import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {NativeIntegrations} from '../../apps/desktop/src/renderer/NativeIntegrations';
import {SettingsSidebar} from '../../apps/desktop/src/renderer/SettingsSidebar';
import type {DesktopBridge} from '@agent-desktop/shared';
import '../../apps/desktop/src/renderer/styles.css';
import '../../apps/desktop/src/renderer/theme.css';
const endpoint=new URLSearchParams(location.search).get('endpoint')!;
const request=async<T,>(route:string,body:unknown):Promise<T>=>{
  const response=await fetch(endpoint+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const value=await response.json();if(!response.ok)throw new Error(value.error??'Configuration request failed');return value;
};
const bridge={subscribe:()=>()=>{},getPlugins:(target,hostId)=>request('/plugins/read',{target}),mutatePlugin:(target,mutation)=>request('/plugins/mutate',{target,mutation}),getMcpServers:target=>request('/mcp/read',{target}),mutateMcpServer:(target,mutation)=>request('/mcp/mutate',{target,mutation})} satisfies Pick<DesktopBridge,'subscribe'|'getPlugins'|'mutatePlugin'|'getMcpServers'|'mutateMcpServer'>;
function Fixture(){const[page,setPage]=useState<'plugins'|'mcp'>('plugins');return <div className="app-shell settings-open" style={{display:'flex',height:'100vh',width:'100vw'}}><SettingsSidebar page={page} onSelect={value=>{if(value==='plugins'||value==='mcp')setPage(value);}} onBack={()=>{}}/><NativeIntegrations key={page} bridge={bridge as DesktopBridge} hostId="isolated-worker" hostName="Integration fixture" connected target={{projectId:'fixture'}} page={page} onPageChange={setPage} onClose={()=>{}}/></div>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
Object.assign(window,{
 acceptanceTarget(selector:string,text?:string){const items=[...document.querySelectorAll<HTMLElement>(selector)],item=text===undefined?items[0]:items.find(x=>x.textContent?.trim()===text||x.getAttribute('aria-label')===text);if(!item)throw new Error(`Missing ${selector} ${text??''}`);item.scrollIntoView({block:'center'});const r=item.getBoundingClientRect();if(!r.width||!r.height)throw new Error('Target is hidden');return{x:r.left+r.width/2,y:r.top+r.height/2};},
 acceptanceState(){return{viewport:{width:innerWidth,height:innerHeight},dpr:devicePixelRatio,zoom:visualViewport?.scale,font:getComputedStyle(document.body).fontFamily,body:document.body.innerText,fields:[...document.querySelectorAll<HTMLInputElement>('input,textarea,select')].map(x=>({label:x.getAttribute('aria-label')??x.closest('label')?.textContent,type:x.type,value:x.type==='password'?'[masked]':x.value,disabled:x.disabled})),scrollWidth:document.documentElement.scrollWidth};},
 async acceptanceWait(code:string){const start=Date.now();while(Date.now()-start<10000){if((0,eval)(code))return;await new Promise(r=>setTimeout(r,25));}throw new Error('Condition did not settle: '+code);}
});
