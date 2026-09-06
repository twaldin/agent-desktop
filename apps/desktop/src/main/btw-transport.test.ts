import { expect, test } from 'bun:test';
import { requestBtw } from './btw-transport';
import { BTW_OWNER_HEADER } from '../../../../packages/shared/src/btw';

const snapshot = {runId:'run',sessionId:'session',question:'question',answer:'',status:'complete',startedAt:1,updatedAt:2};
test('actual HTTP side-chat transport preserves a maximally JSON-escaped bounded answer and fences its owner',async()=>{
 const answer='\u0000'.repeat(1024*1024);let authenticated=false;
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
  authenticated=request.headers.get('authorization')==='Bearer isolated-test-token'&&request.headers.get(BTW_OWNER_HEADER)==='owner';
  return Response.json({protocolVersion:1,hostId:'owner',sessionId:'session',value:{...snapshot,answer}},{headers:{[BTW_OWNER_HEADER]:'owner'}});
 }});
 try {const result=await requestBtw({origin:server.url.origin,hostId:'owner',token:'isolated-test-token'},'session');expect(authenticated).toBe(true);expect(result.value?.answer).toBe(answer);}finally{server.stop(true);}
});
test('actual HTTP side-chat transport rejects foreign ownership and oversized bodies',async()=>{
 let mode='header';
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){
  if(mode==='large')return new Response(' '.repeat(8*1024*1024+1),{headers:{[BTW_OWNER_HEADER]:'owner'}});
  return Response.json({protocolVersion:1,hostId:'owner',sessionId:'session',value:{...snapshot,sessionId:'foreign'}},{headers:{[BTW_OWNER_HEADER]:mode==='header'?'foreign':'owner'}});
 }});
 try {const endpoint={origin:server.url.origin,hostId:'owner'};
  await expect(requestBtw(endpoint,'session')).rejects.toThrow('another host');mode='body';
  await expect(requestBtw(endpoint,'session')).rejects.toThrow('another session');mode='large';
  await expect(requestBtw(endpoint,'session')).rejects.toThrow('oversized');
 }finally{server.stop(true);}
});
