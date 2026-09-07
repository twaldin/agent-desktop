import {createRoot} from 'react-dom/client';
import {useEffect,useMemo,useReducer} from 'react';
import type {DesktopBridge} from '@agent-desktop/shared';
import {GeneralSettings} from '../../apps/desktop/src/renderer/GeneralSettings';
import {SettingsSidebar} from '../../apps/desktop/src/renderer/SettingsSidebar';
import {PreferencesState} from '../../apps/desktop/src/renderer/preferences-state';
import {offlineCache} from '../../apps/desktop/src/renderer/offline-cache';
import '../../apps/desktop/src/renderer/styles.css';
import '../../apps/desktop/src/renderer/theme.css';
const params=new URLSearchParams(location.search),endpoint=params.get('endpoint')!,hostId=params.get('hostId')!;
const request=async(route:string,body?:unknown)=>{const response=await fetch(endpoint+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body??{})});const value=await response.json();if(!response.ok)throw Error(value.error?.message??'Request failed');return value;};
const bridge={getPreferences:()=>request('/preferences'),command:(envelope)=>request('/command',envelope),subscribe:()=>()=>{}} satisfies Partial<DesktopBridge> as DesktopBridge;
let controller:PreferencesState;
const errors:string[]=[];addEventListener('error',event=>errors.push(event.message));addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
function Fixture(){const[,redraw]=useReducer(n=>n+1,0);const preferences=useMemo(()=>new PreferencesState(bridge,offlineCache,{read:key=>localStorage.getItem(key),write:(key,value)=>localStorage.setItem(key,value)}),[]);controller=preferences;
useEffect(()=>{const off=preferences.subscribe(redraw);preferences.setConnection(hostId,true);void preferences.restore().then(()=>preferences.refresh());return off;},[preferences]);
return <main className="app-shell settings-open"><SettingsSidebar page="general" onSelect={()=>{}} onBack={()=>{}}/><main className="main-pane"><GeneralSettings preferences={preferences} bridge={bridge} onClose={()=>{}}/></main></main>;}
document.documentElement.dataset.theme='dark';
createRoot(document.getElementById('root')!).render(<Fixture/>);
Object.assign(window,{state:()=>({preferences:controller?.get('general.notifications'),busy:controller?.busy,pending:controller?.pending.length,error:controller?.error,errors,
  active:document.activeElement?.outerHTML,dpr:devicePixelRatio,font:getComputedStyle(document.body).fontFamily,fontSize:getComputedStyle(document.body).fontSize,
  controls:[...document.querySelectorAll('button,select')].map(node=>({text:node.textContent,label:node.getAttribute('aria-label'),role:node.getAttribute('role'),checked:node.getAttribute('aria-checked'),disabled:(node as HTMLButtonElement).disabled,rect:node.getBoundingClientRect().toJSON()}))}),
request,target:(selector:string)=>{const node=document.querySelector(selector) as HTMLElement; if(!node)throw Error('Missing '+selector);const box=node.getBoundingClientRect();return{x:Math.round(box.x+box.width/2),y:Math.round(box.y+box.height/2)};}});
