import { expect, test } from 'bun:test';
import { SESSION_MCP_OWNER_HEADER, parseNativeSessionMcpResponse, parseNativeSessionMcpReload } from '@agent-desktop/shared';
import { SessionMcpHttp } from './session-mcp-http';
import { requestSessionMcp } from '../../desktop/src/main/session-mcp-transport';

test('MCP status binds both owners, is read-only, and leaves unloaded sessions unloaded',async()=>{
  let reads=0;
  const service=new SessionMcpHttp({hostId:'host',sessionExists:id=>id==='session',existing:async()=>{reads++;return undefined;}});
  const request=(method='GET',owner='host',session='session')=>service.route(new Request(`http://localhost/v1/sessions/${session}/mcp`,{method,headers:{[SESSION_MCP_OWNER_HEADER]:owner}}));
  expect((await request('GET','wrong'))?.status).toBe(409);
  expect((await request('GET','host','other'))?.status).toBe(409);
  expect((await request('POST'))?.status).toBe(405);expect(reads).toBe(0);
  const response=(await request())!;expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(parseNativeSessionMcpResponse(await response.json(),'host','session')).toMatchObject({value:null,unavailable:expect.any(String)});expect(reads).toBe(1);
});

test('desktop metadata transport authenticates exact host and rejects mismatched or oversized responses',async()=>{
  const snapshot={epoch:'generation',revision:1,available:true,servers:[]};
  let mode='good',authorization='';
  const server=Bun.serve({port:0,hostname:'127.0.0.1',fetch(request){authorization=request.headers.get('Authorization')??'';
    return Response.json(mode==='oversize'?{text:'x'.repeat(8*1024*1024)}:{protocolVersion:1,hostId:mode==='body-owner'?'other':'host',sessionId:'session',value:snapshot}, {headers:{[SESSION_MCP_OWNER_HEADER]:mode==='header-owner'?'other':'host'}});
  }});
  try {
    const endpoint={origin:`http://127.0.0.1:${server.port}`,hostId:'host',token:'fixture-token'};
    expect((await requestSessionMcp(endpoint,'session')).value).toEqual(snapshot);expect(authorization).toBe('Bearer fixture-token');
    for(const kind of ['header-owner','body-owner','oversize']){mode=kind;await expect(requestSessionMcp(endpoint,'session')).rejects.toThrow();}
    expect(()=>parseNativeSessionMcpReload({epoch:'generation',expectedRevision:-1})).toThrow();
    expect(()=>parseNativeSessionMcpReload({epoch:'generation',expectedRevision:1,config:{secret:'never-accepted'}})).toThrow();
  } finally {await server.stop(true);}
});

test('native status errors cannot expose configuration credentials',async()=>{
  const service=new SessionMcpHttp({hostId:'host',sessionExists:()=>true,existing:async()=>({getSessionMcp:async()=>{throw new Error('Bearer secret-native-config');}})});
  const response=(await service.route(new Request('http://localhost/v1/sessions/session/mcp',{headers:{[SESSION_MCP_OWNER_HEADER]:'host'}})))!;
  expect(response.status).toBe(503);expect(await response.text()).not.toContain('secret-native-config');
});
