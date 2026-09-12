import { closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { notificationPreferences, type NotificationPreferences } from '../../../../packages/shared/src/preferences';
import type { HostNotification, NotificationNavigationTarget } from '@agent-desktop/shared';

export interface DeliveredNotification { close():void }
interface HostLedger { sequence:number; seen:string[]; pending?:string[] }
interface DeliveryLedger { version:1; hosts:Record<string,HostLedger> }
export interface NotificationDeliveryAdapter {
  preferences():NotificationPreferences|undefined;
  focused():boolean;
  supported():boolean;
  show(notice:HostNotification, options:{silent:boolean;onClick():void;onFailed():void;onClosed():void}):DeliveredNotification;
  navigate(target:NotificationNavigationTarget):void;
  statusChanged():void;
}
/** Single main-process delivery owner, independent of the number of renderer windows.
 * The ledger stores IDs/cursors only. Record an attempt before entering the OS so
 * a crash cannot replay an action whose delivery outcome is unknown. */
export class NotificationDelivery {
  private ledger:DeliveryLedger={version:1,hosts:{}};
  private blocked=false;
  private error?:string;
  private preferencesError?:string;
  private streams=new Map<string,{ready:boolean;known:boolean;pending:{sequence:number;notice:HostNotification}[]}>();
  private active=new Map<string,{hostId:string;notice:HostNotification;handle:DeliveredNotification}>();
  constructor(private file:string,private adapter:NotificationDeliveryAdapter){
    try {
      if(!existsSync(file))return;
      const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
      try {
        const info=fstatSync(fd);if(!info.isFile()||info.size>4*1024*1024)throw Error();
        const parsed=JSON.parse(readFileSync(fd,'utf8')) as DeliveryLedger;
        if(parsed?.version!==1||!parsed.hosts||typeof parsed.hosts!=='object'||Array.isArray(parsed.hosts)||Object.keys(parsed.hosts).length>1000)throw Error();
        for(const [host,value] of Object.entries(parsed.hosts)){
          if(!validHost(host)||!value||!Number.isSafeInteger(value.sequence)||value.sequence<0||!Array.isArray(value.seen)||value.seen.length>2000||value.seen.some(id=>typeof id!=='string'||id.length>1000)||value.pending!==undefined&&(!Array.isArray(value.pending)||value.pending.length>10000||value.pending.some(id=>typeof id!=='string'||id.length>1000)))throw Error();
        }
        this.ledger=parsed;
      }finally{closeSync(fd);}
    }catch{this.blocked=true;this.error='Saved notification delivery state could not be read. Alerts are paused to avoid duplicates.';}
  }
  status(){return {supported:this.adapter.supported(),...((this.error??this.preferencesError)?{error:this.error??this.preferencesError}:{})};}
  preferenceStatus(error?:string){this.preferencesError=error;this.adapter.statusChanged();}
  cursor(hostId:string){return this.ledger.hosts[hostId]?.sequence??0;}
  begin(hostId:string){
    if(!validHost(hostId))throw Error('Invalid notification host.');
    this.streams.set(hostId,{ready:false,known:Object.hasOwn(this.ledger.hosts,hostId),pending:[]});
  }
  event(hostId:string,sequence:number,notice:HostNotification){
    const stream=this.streams.get(hostId);if(!stream||!validNotice(notice)||!Number.isSafeInteger(sequence)||sequence<0)return;
    if(!stream.ready){stream.pending.push({sequence,notice});return;}
    if(notice.state==='resolved'){this.resolve(hostId,notice.id);this.record(hostId,sequence,notice.id,false);return;}
    this.deliver(hostId,sequence,notice);
  }
  /** The authenticated state frame ends the server's replay batch. Its pending
   * snapshot is authoritative, including when the replay window was exceeded. */
  snapshot(hostId:string,sequence:number,pending:HostNotification[]|undefined,replayComplete=false){
    const stream=this.streams.get(hostId);if(!stream||!Number.isSafeInteger(sequence)||sequence<0||(!stream.ready&&!replayComplete))return;
    const current=(pending??[]).filter(notice=>validNotice(notice)&&notice.state==='open'&&notice.kind!=='completion');
    if(pending!==undefined){
      const ids=new Set(current.map(item=>item.id));
      for(const [key,item] of this.active)if(item.hostId===hostId&&item.notice.kind!=='completion'&&!ids.has(item.notice.id)){item.handle.close();this.active.delete(key);}
    }
    if(!stream.ready){
      // New attachment starts with current questions only, never old completions.
      // A reconnect can deliver missed completions, with durable ID deduplication.
      const resolved=new Set(stream.pending.filter(item=>item.notice.state==='resolved').map(item=>item.notice.id));
      for(const {notice,sequence:noticeSequence} of stream.pending){
        if(notice.state==='resolved')this.resolve(hostId,notice.id);
        else if(stream.known&&notice.kind==='completion'&&!resolved.has(notice.id))this.deliver(hostId,noticeSequence,notice);
      }
      stream.ready=true;stream.pending=[];
    }
    for(const notice of current)this.deliver(hostId,sequence,notice);
    this.record(hostId,sequence,undefined,undefined,pending===undefined?undefined:current.map(item=>item.id));
  }
  preferencesChanged(){
    for(const [key,item]of this.active)if(!this.allowed(item.notice)){item.handle.close();this.active.delete(key);}
  }
  dispose(){for(const item of this.active.values())item.handle.close();this.active.clear();}
  private allowed(notice:HostNotification){
    const prefs=notificationPreferences(this.adapter.preferences());
    return notice.kind==='permission'?prefs.approvalRequired:notice.kind==='question'?prefs.questionRequired:
      prefs.completionPolicy==='always'||prefs.completionPolicy==='unfocused'&&!this.adapter.focused();
  }
  private resolve(hostId:string,id:string){const key=JSON.stringify([hostId,id]),item=this.active.get(key);if(item){item.handle.close();this.active.delete(key);}}
  private deliver(hostId:string,sequence:number,notice:HostNotification){
    if(this.blocked||this.ledger.hosts[hostId]?.seen.includes(notice.id)||this.ledger.hosts[hostId]?.pending?.includes(notice.id)||this.active.has(JSON.stringify([hostId,notice.id])))return;
    if(!this.record(hostId,sequence,notice.id,notice.kind!=='completion'))return;
    if(!this.allowed(notice)||!this.adapter.supported())return;
    const key=JSON.stringify([hostId,notice.id]);
    try{
      const handle=this.adapter.show(notice,{silent:!notificationPreferences(this.adapter.preferences()).sound,
        onClick:()=>this.adapter.navigate({hostId,sessionId:notice.sessionId}),
        onClosed:()=>{this.active.delete(key);},
        onFailed:()=>{this.error='The system could not display a notification. Check system notification settings.';this.adapter.statusChanged();}});
      this.active.set(key,{hostId,notice,handle});
    }catch{this.error='The system could not display a notification. Check system notification settings.';this.adapter.statusChanged();}
  }
  private record(hostId:string,sequence:number,id?:string,pin?:boolean,pendingSnapshot?:string[]){
    if(this.blocked)return false;
    const previous=this.ledger.hosts[hostId]??{sequence:0,seen:[]};
    const pending=pendingSnapshot ? (previous.pending??[]).filter(id=>pendingSnapshot.includes(id)) : pin===true&&id ? [...new Set([...(previous.pending??[]),id])] : pin===false&&id ? (previous.pending??[]).filter(value=>value!==id) : previous.pending??[];
    if(Object.hasOwn(this.ledger.hosts,hostId)&&sequence<=previous.sequence&&(!id||previous.seen.includes(id))&&JSON.stringify(pending)===JSON.stringify(previous.pending??[]))return true;
    const next:DeliveryLedger={version:1,hosts:{...this.ledger.hosts,[hostId]:{sequence:Math.max(sequence,previous.sequence),pending,seen:id&&!previous.seen.includes(id)?[...previous.seen,id].slice(-2000):previous.seen}}};
    const temp=`${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try{
      if(pending.length>10000||Object.keys(next.hosts).length>1000||Buffer.byteLength(JSON.stringify(next))>4*1024*1024)throw Error();
      mkdirSync(dirname(this.file),{recursive:true,mode:0o700});const fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
      try{writeFileSync(fd,JSON.stringify(next)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
      renameSync(temp,this.file);this.ledger=next;return true;
    }catch{this.blocked=true;this.error='Notification delivery state could not be saved. Alerts are paused to avoid duplicates.';this.adapter.statusChanged();return false;}
    finally{try{unlinkSync(temp);}catch{}}
  }
}
function validHost(value:string){return typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value)&&!['__proto__','constructor','prototype'].includes(value);}
function validNotice(value:HostNotification){return value&&typeof value.id==='string'&&value.id.length>0&&value.id.length<=1000&&validHost(value.sessionId)&&['completion','question','permission'].includes(value.kind)&&['open','resolved'].includes(value.state)&&Number.isFinite(value.createdAt)&&typeof value.title==='string'&&value.title.length<=300&&typeof value.body==='string'&&value.body.length<=1000;}
