import { expect, test } from "bun:test";
import { QueuedMessagesState } from "./queued-messages-state";
import type { DesktopBridge } from "../../../../packages/shared/src/protocol";
import type { NativeQueuedMessagesResponse, NativeQueuedMessageMutationReceipt, NativeQueuedMessageMutation } from "../../../../packages/shared/src/queued-messages";
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i=0;i<8;i++) await Promise.resolve(); };
const response = (revision=1, id="worker-a:1"): NativeQueuedMessagesResponse => ({ protocolVersion:1,hostId:"home",sessionId:"session",revision,streaming:true,messages:[{ id,lane:"steer",text:"Original queued prompt",imageCount:0,position:0,ownership:"desktop-pending",editable:false,removable:true,promotable:false }] });
function fixture() {
  const reads: ReturnType<typeof deferred<NativeQueuedMessagesResponse>>[] = [];
  const writes: {session:string;host:string;mutation:NativeQueuedMessageMutation;reply:ReturnType<typeof deferred<NativeQueuedMessageMutationReceipt>>}[]=[];
  let notify: ((event:{hostId:string;sessionId:string})=>void)|undefined;
  const bridge: Pick<DesktopBridge,"getQueuedMessages"|"mutateQueuedMessages"|"subscribeQueuedMessages"> = {
    getQueuedMessages: async (session,host) => { expect([session,host]).toEqual(["session","home"]);const read=deferred<NativeQueuedMessagesResponse>();reads.push(read);return read.promise; },
    mutateQueuedMessages: async (session,mutation,host) => {const reply=deferred<NativeQueuedMessageMutationReceipt>();writes.push({session,host,mutation,reply});return reply.promise;},
    subscribeQueuedMessages: listener => {notify=listener;return()=>{notify=undefined;};},
  };
  const state=new QueuedMessagesState(bridge,"home","session");state.start();
  return {state,reads,writes,notify:(hostId="home",sessionId="session")=>notify?.({hostId,sessionId})};
}
test("queue invalidations retain exact owner and refetch when changed during a held read",async()=>{
 const f=fixture();f.notify("foreign");expect(f.reads).toHaveLength(1);f.notify();f.reads[0]!.resolve(response());await tick();expect(f.reads).toHaveLength(2);
 f.reads[1]!.resolve(response(2,"worker-a:2"));await tick();expect(f.state.value.snapshot?.messages[0]?.id).toBe("worker-a:2");f.state.stop();f.notify();expect(f.reads).toHaveLength(2);
});
test("retired queue reads and retained actions cannot publish or mutate after owner disposal",async()=>{
 const f=fixture();f.state.stop();f.reads[0]!.resolve(response());await tick();expect(f.state.value.snapshot).toBeUndefined();await f.state.mutate({type:"remove",expectedRevision:1,messageId:"worker-a:1"});expect(f.writes).toHaveLength(0);
 f.state.start();f.reads[1]!.resolve({...response(),hostId:"foreign"});await tick();expect(f.state.value.error).toContain("different conversation");expect(f.state.value.snapshot).toBeUndefined();f.state.stop();
});
test("a command captures original revision and IDs, ignores stale reads, and never retries mutations",async()=>{
 const f=fixture();f.reads[0]!.resolve(response());await tick();
 await f.state.mutate({type:"remove",expectedRevision:0,messageId:"worker-a:1"});expect(f.writes).toHaveLength(0);
 f.notify();const mutation:NativeQueuedMessageMutation={type:"remove",expectedRevision:1,messageId:"worker-a:1"};const done=f.state.mutate(mutation);mutation.messageId="replacement";
 expect(f.writes[0]).toMatchObject({host:"home",session:"session",mutation:{type:"remove",expectedRevision:1,messageId:"worker-a:1"}});
 f.reads[1]!.resolve(response(1));await tick();f.writes[0]!.reply.resolve({type:"native-queued-messages",mutation:"remove",messageId:"worker-a:1",snapshot:{revision:2,streaming:true,messages:[]}});await done;
 expect(f.state.value.snapshot?.messages).toEqual([]);expect(f.writes).toHaveLength(1);f.reads[2]!.resolve({...response(2),messages:[]});await tick();expect(f.state.value.snapshot?.messages).toEqual([]);f.state.stop();
});
test("failed mutation remains visible until deliberate refresh and does not replay on invalidation",async()=>{
 const f=fixture();f.reads[0]!.resolve(response());await tick();const done=f.state.mutate({type:"remove",expectedRevision:1,messageId:"worker-a:1"});f.writes[0]!.reply.reject(new Error("Queue was already consumed"));await done;
 expect(f.state.value.error).toBe("Queue was already consumed");f.notify();expect(f.reads).toHaveLength(1);expect(f.writes).toHaveLength(1);
 const refresh=f.state.refresh();f.reads[1]!.resolve({...response(2),messages:[]});await refresh;expect(f.state.value.error).toBeUndefined();expect(f.state.value.snapshot?.messages).toEqual([]);expect(f.writes).toHaveLength(1);f.state.stop();
});
