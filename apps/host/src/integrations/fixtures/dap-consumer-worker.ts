/** Real SDK AgentSession and its registered native DebugTool, no provider stream. */
export {};
globalThis.fetch=Object.assign(async()=>{throw Error('Provider/network fetch disabled in DAP consumer fixture');},{preconnect(){}})as typeof fetch;
const {createAgentSession}=await import('@oh-my-pi/pi-coding-agent');
const {dapSessionManager}=await import('@oh-my-pi/pi-coding-agent/dap/session');
let session:Awaited<ReturnType<typeof createAgentSession>>['session']|undefined;
self.onmessage=async(event:MessageEvent)=>{const {id,operation,cwd,agentDir,params}=event.data;try{
 if(operation==='start'){const created=await createAgentSession({cwd,agentDir,hasUI:false,skipPythonPreflight:true,toolNames:['debug'],restrictToolNames:true,disableExtensionDiscovery:true});session=created.session;await session.setActiveToolsByName(['debug']);const tool=session.agent.state.tools.find(t=>t.name==='debug');if(!tool)throw Error('Native DebugTool missing');self.postMessage({id,ok:true,value:{sessionId:session.sessionId,tools:session.agent.state.tools.map(t=>t.name)}});}
 else if(operation==='execute'){const tool=session?.agent.state.tools.find(t=>t.name==='debug');if(!tool)throw Error('Original native session missing');self.postMessage({id,ok:true,value:await tool.execute('owned-dap-fixture-'+id,params)});}
 else if(operation==='stop'){for(const current of dapSessionManager.listSessions()){await dapSessionManager.terminate(undefined,2000).catch(()=>{});}await session?.dispose();self.postMessage({id,ok:true,value:null});self.close();}
 else throw Error('Unknown fixture operation');
 }catch(error){self.postMessage({id,ok:false,error:String(error)});}};
self.postMessage({ready:true});
