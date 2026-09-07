import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Icon} from './Icons';

/** Compact installed-plugin actions, anchored outside the scrolling settings pane. */
export function InstalledPluginActions({name,revision,disabled,canUpgrade,onAction}:{name:string;revision:string;disabled:boolean;canUpgrade:boolean;onAction(action:'upgrade'|'uninstall',opener:HTMLButtonElement):void}) {
 const trigger=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null);
 const [open,setOpen]=useState(false),[position,setPosition]=useState({left:0,top:0});
 const dismiss=(restore=false)=>{setOpen(false);if(restore)requestAnimationFrame(()=>trigger.current?.focus());};
 useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
 useEffect(()=>setOpen(false),[revision]);
 useLayoutEffect(()=>{
  if(!open||!trigger.current||!menu.current)return;
  const r=trigger.current.getBoundingClientRect(),m=menu.current.getBoundingClientRect();
  setPosition({left:Math.max(8,Math.min(r.right-m.width,innerWidth-m.width-8)),top:r.bottom+6+m.height<=innerHeight-8?r.bottom+6:Math.max(8,r.top-m.height-6)});
  menu.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  const outside=(event:PointerEvent)=>{if(!menu.current?.contains(event.target as Node)&&!trigger.current?.contains(event.target as Node))dismiss();};
  const moved=(event:Event)=>{if(!menu.current?.contains(event.target as Node))dismiss(true);};
  document.addEventListener('pointerdown',outside);window.addEventListener('resize',moved);document.addEventListener('scroll',moved,true);
  return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',moved);document.removeEventListener('scroll',moved,true);};
 },[open]);
 return <><button ref={trigger} className="icon-button installed-plugin-actions-trigger" aria-label={`More actions for ${name}`} title="More actions" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={()=>setOpen(!open)}><Icon name="more"/></button>{open&&createPortal(<div ref={menu} role="menu" aria-label={`${name} actions`} className="acquisition-menu installed-plugin-actions-menu" style={position} onKeyDown={event=>{
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dismiss(true);return;}
  if(event.key==='Tab'){event.preventDefault();dismiss(true);return;}
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
  event.preventDefault();const items=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')],index=items.indexOf(document.activeElement as HTMLButtonElement);
  items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();
 }}><button role="menuitem" disabled={!canUpgrade} onClick={()=>{dismiss();onAction('upgrade',trigger.current!);}}><Icon name="refresh"/>Upgrade</button><button role="menuitem" onClick={()=>{dismiss();onAction('uninstall',trigger.current!);}}><Icon name="trash"/>Uninstall</button></div>,document.body)}</>;
}
