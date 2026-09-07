import {useEffect,useRef,useState} from 'react';
import {NativePluginDirectory,type NativePluginDirectoryProps} from './NativePluginDirectory';
import {NativeIntegrations} from './NativeIntegrations';
import {targetIdentity} from './composer-autocomplete';

/** Keep directory navigation mounted while the selected native detail is open. */
export function NativePluginBrowser(props:NativePluginDirectoryProps) {
 const owner=`${props.hostId}:${targetIdentity(props.target)}`;
 const [selection,setSelection]=useState<{owner:string;id:string}|null>(null);
 const opener=useRef<HTMLElement|null>(null),directory=useRef<HTMLDivElement>(null);
 const selected=selection?.owner===owner?selection:null;
 useEffect(()=>{setSelection(null);opener.current=null;},[owner]);
 const closeDetail=()=>{setSelection(null);requestAnimationFrame(()=>{
  if(opener.current?.isConnected)opener.current.focus();
  else directory.current?.querySelector<HTMLElement>('[aria-label="Refresh plugin directory"]')?.focus();
 });};
 return <div className="native-plugin-browser">
  <div ref={directory} style={{display:selected?'none':'contents'}} inert={Boolean(selected)}>
   <NativePluginDirectory {...props} onManage={id=>{
    if(!id){props.onManage();return;}
    opener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
    setSelection({owner,id});
   }}/>
  </div>
  {selected&&<NativeIntegrations key={`${owner}:${selected.id}`} standalone onOpenSkillFile={props.onOpenSkillFile} initialPluginId={selected.id} bridge={props.bridge} hostId={props.hostId} hostName={props.hostName} connected={props.connected} target={props.target} page="plugins" onClose={closeDetail}/>}
 </div>;
}
