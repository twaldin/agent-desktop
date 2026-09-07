import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import type {DesktopBridge} from '@agent-desktop/shared';
import {NativeIntegrations} from '../../apps/desktop/src/renderer/NativeIntegrations';
import {SettingsSidebar} from '../../apps/desktop/src/renderer/SettingsSidebar';
import '../../apps/desktop/src/renderer/styles.css';
import '../../apps/desktop/src/renderer/theme.css';
const params=new URLSearchParams(location.search),endpoint=params.get('endpoint')!,target=JSON.parse(params.get('target')!);
const request=async(route:string,body:unknown)=>{const r=await fetch(endpoint+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw new Error('Unconfirmed request');return value;};
const prefix='/v1/integrations/acquisition/';
const bridge={subscribe:()=>()=>{},getPlugins:()=>request('/v1/integrations/plugins/read',{target}),getMcpServers:()=>request('/v1/integrations/mcp/read',{target}),
 getMarketplaceCatalog:t=>request(prefix+'catalog',{target:t}),getPluginAcquisitionOperations:()=>request(prefix+'operations',{}),startPluginAcquisition:(t,r)=>request(prefix+'start',{target:t,request:r}),reviewPluginAcquisition:(t,id,expectedRevision)=>request(prefix+'review',{target:t,id,expectedRevision}),closePluginAcquisitionRequest:(t,r)=>request(prefix+'close-request',{target:t,...r})} as DesktopBridge;
let connection:(value:boolean)=>void;
function Fixture(){const[page,setPage]=useState<'plugins'|'mcp'>('plugins'),[connected,setConnected]=useState(true);connection=setConnected;return <div className="app-shell settings-open" style={{display:'flex',height:'100vh',width:'100vw'}}><SettingsSidebar page={page} onSelect={p=>{if(p==='plugins'||p==='mcp')setPage(p);}} onBack={()=>{}}/><NativeIntegrations bridge={bridge} page={page} target={target} hostId="fixture" hostName="Local fixture" connected={connected} onPageChange={setPage} onClose={()=>{}}/></div>;}
document.documentElement.dataset.theme='dark';createRoot(document.getElementById('root')!).render(<Fixture/>);
Object.assign(window,{
 request,connection:(value:boolean)=>connection(value),
 target(selector:string,text?:string){const item=[...document.querySelectorAll<HTMLElement>(selector)].filter(x=>x.getClientRects().length).find(x=>text===undefined||x.textContent?.trim()===text);if(!item)throw new Error('Missing '+selector+' '+text);item.scrollIntoView({block:'center'});const r=item.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};},
 state(){return{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,theme:document.documentElement.dataset.theme,body:document.body.innerText,font:getComputedStyle(document.body).fontFamily,fontSize:getComputedStyle(document.body).fontSize,scrollWidth:document.documentElement.scrollWidth,active:document.activeElement?.getAttribute('aria-label'),storage:Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])),geometry:[...document.querySelectorAll<HTMLElement>('.marketplace-dialog,.acquisition-menu,.marketplace-row,.integration-content')].filter(x=>x.getClientRects().length).map(x=>{const r=x.getBoundingClientRect(),s=getComputedStyle(x);return{class:x.className,x:r.x,y:r.y,width:r.width,height:r.height,background:s.backgroundColor,color:s.color,radius:s.borderRadius,font:s.fontFamily,fontSize:s.fontSize};})};}
});
