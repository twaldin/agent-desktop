import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { DesktopBridge } from '@agent-desktop/shared';
import { notificationPreferences, type CompletionNotificationPolicy, type NotificationPreferences } from '../../../../packages/shared/src/preferences';
import type { PreferencesState } from './preferences-state';
import { Icon } from './Icons';
import { NativeSwitch } from './NativeSwitch';
import './general-settings.css';

const policies = [ ['never', 'Never'], ['unfocused', 'Only when unfocused'], ['always', 'Always'] ] as const;
export function GeneralSettings({ preferences, bridge, onClose }: { preferences: PreferencesState; bridge: DesktopBridge; onClose(): void }) {
  const value = notificationPreferences(preferences.get('general.notifications'));
  const writable = preferences.ready && preferences.connected && !preferences.busy && !preferences.pending.length;
  const [delivery, setDelivery] = useState<{ supported: boolean; error?: string }>();
  useEffect(() => {
    let active = true;
    const refresh = () => { void bridge.getNotificationStatus?.().then(status => { if(active)setDelivery(status); }).catch(() => { if(active)setDelivery({supported:false,error:'Notification delivery status could not be read.'}); }); };
    refresh(); const off = bridge.subscribeNotificationStatus?.(refresh);
    return () => { active = false; off?.(); };
  }, [bridge]);
  const save = (patch: Partial<NotificationPreferences>) => {
    if (!writable) return;
    const next = { ...value, ...patch };
    next.turnComplete = next.completionPolicy !== 'never';
    void preferences.put({key:'general.notifications',value:next});
  };
  return <section className="settings-page general-settings" aria-label="General settings">
    <header className="settings-header"><button className="icon-button" aria-label="Close General settings" onClick={onClose}><Icon name="browserBack"/></button><h1>General</h1></header>
    <div className="general-settings-scroll">
      <section className="general-settings-group" aria-labelledby="general-interaction"><h2 id="general-interaction">Interaction</h2><div className="general-settings-card">
        <div className="general-settings-row"><div><h3>Send messages with</h3><p>Choose the keyboard shortcut for sending messages</p></div><select aria-label="Send messages with" disabled={!writable} value={preferences.get('general.sendBehavior') ?? 'enter'} onChange={event => void preferences.put({key:'general.sendBehavior',value:event.target.value as 'enter'|'mod-enter'})}><option value="enter">Enter</option><option value="mod-enter">⌘ Enter</option></select></div>
        <div className="general-settings-row"><div><h3>Reduce motion</h3><p>Reduce interface animations</p></div><NativeSwitch label="Reduce motion" checked={preferences.get('general.reduceMotion') ?? false} disabled={!writable} onChange={value => void preferences.put({key:'general.reduceMotion',value})}/></div>
      </div></section>
      <section className="general-settings-group" aria-labelledby="general-notifications"><h2 id="general-notifications">Notifications</h2><div className="general-settings-card">
        <div className="general-settings-row"><div><h3>Turn completion notifications</h3><p>Set when Agent Desktop alerts you that it’s finished</p></div><CompletionMenu value={value.completionPolicy} disabled={!writable} onChange={completionPolicy => save({completionPolicy})}/></div>
        <div className="general-settings-row"><div><h3>Enable permission notifications</h3><p>Show alerts when approval is required</p></div><NativeSwitch label="Enable permission notifications" checked={value.approvalRequired} disabled={!writable} onChange={approvalRequired => save({approvalRequired})}/></div>
        <div className="general-settings-row"><div><h3>Enable question notifications</h3><p>Show alerts when input is needed to continue</p></div><NativeSwitch label="Enable question notifications" checked={value.questionRequired} disabled={!writable} onChange={questionRequired => save({questionRequired})}/></div>
      </div><details className="general-notification-advanced"><summary>Advanced</summary><div className="general-settings-row"><div><h3>Notification sound</h3><p>Use the system alert sound</p></div><NativeSwitch label="Notification sound" checked={value.sound} disabled={!writable} onChange={sound => save({sound})}/></div><p>Alerts are delivered while Agent Desktop is open and connected to the session’s host. System notification settings also apply.</p>{delivery && <p role="status">{delivery.error ?? (delivery.supported ? 'System notification delivery is available. This does not confirm system permission.' : 'System notifications are unavailable on this device.')}</p>}</details></section>
      {!preferences.connected && <p className="settings-description">Reconnect to save shared preferences.</p>}
      {(preferences.error || preferences.cacheWarning || preferences.pending.length > 0) && <div className="inline-error" role="alert"><p>{preferences.error ?? preferences.cacheWarning ?? 'Preference changes are awaiting confirmation.'}</p><button className="secondary-button" disabled={!preferences.connected || preferences.busy} onClick={() => preferences.pending.length ? void preferences.retry() : void preferences.refresh()}>{preferences.pending.length ? 'Retry saved preference changes' : 'Refresh preferences'}</button></div>}
    </div>
  </section>;
}
function CompletionMenu({ value, disabled, onChange }: {value:CompletionNotificationPolicy;disabled:boolean;onChange(value:CompletionNotificationPolicy):void}) {
  const trigger=useRef<HTMLButtonElement>(null), menu=useRef<HTMLDivElement>(null);
  const [open,setOpen]=useState(false), [position,setPosition]=useState<CSSProperties>();
  const close=(restore=true)=>{setOpen(false);if(restore)trigger.current?.focus({preventScroll:true});};
  useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
  useLayoutEffect(()=>{
    if(!open)return;
    const measure=()=>{const box=trigger.current?.getBoundingClientRect();if(!box)return;const width=Math.min(240,innerWidth-24), height=112;
      setPosition({width,left:Math.max(12,Math.min(box.right-width,innerWidth-width-12)),top:box.bottom+height+12<=innerHeight?box.bottom+4:Math.max(12,box.top-height-4)});};
    measure();addEventListener('resize',measure);addEventListener('scroll',measure,true);
    return()=>{removeEventListener('resize',measure);removeEventListener('scroll',measure,true);};
  },[open]);
  useEffect(()=>{
    if(!open||!position)return;
    const frame=requestAnimationFrame(()=>menu.current?.querySelector<HTMLButtonElement>('[aria-checked=true]')?.focus());
    const outside=(event:PointerEvent)=>{if(!trigger.current?.contains(event.target as Node)&&!menu.current?.contains(event.target as Node))close(false);};
    addEventListener('pointerdown',outside);return()=>{cancelAnimationFrame(frame);removeEventListener('pointerdown',outside);};
  },[open,Boolean(position)]);
  return <><button className="general-notification-trigger" ref={trigger} aria-label="Turn completion notifications" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={()=>setOpen(!open)}><span>{policies.find(([id])=>id===value)?.[1]}</span><Icon name="chevron"/></button>
    {open&&position&&createPortal(<div ref={menu} className="general-notification-menu" style={position} role="menu" aria-label="Turn completion notifications" onBlur={event=>{if(event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget as Node))close(false);}} onKeyDown={event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}
      if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];const index=buttons.indexOf(document.activeElement as HTMLButtonElement);const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[next]?.focus();}
    }}>{policies.map(([id,label])=><button key={id} role="menuitemradio" aria-checked={id===value} onClick={()=>{if(!disabled)onChange(id);close();}}><span>{label}</span>{id===value&&<Icon name="check"/>}</button>)}</div>,document.body)}</>;
}
