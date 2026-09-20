import {mkdir,writeFile} from 'node:fs/promises';import {join,resolve} from 'node:path';
const fixture=resolve(process.argv[2]!);if(process.env.HOME!==fixture||process.env.PI_CODING_AGENT_DIR!==join(fixture,'agent'))throw Error('Disposable host required');
for(const name of ['data','agent','project'])await mkdir(join(fixture,name),{recursive:true});
await writeFile(join(fixture,'project/package.json'),'{}');await writeFile(join(fixture,'agent/config.yml'),'extensions: []\n');
const {getConfigDirPaths}=await import('@oh-my-pi/pi-coding-agent/config');const user=join(getConfigDirPaths('',{user:true,project:false})[0]!,'lsp.json');await mkdir(resolve(user,'..'),{recursive:true});
await writeFile(user,JSON.stringify({servers:{fixture:{command:'fixture-not-installed',fileTypes:['.fixture'],rootMarkers:['package.json'],settings:{preserved:true}}}}));
const originalFetch=globalThis.fetch;globalThis.fetch=Object.assign(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=new URL(input instanceof Request?input.url:String(input));if(url.hostname!=='127.0.0.1')throw Error('Nonlocal network forbidden in fixture');return originalFetch(input,init);},{preconnect:()=>{throw Error('No fixture preconnect');}})as typeof fetch;
const{startHost}=await import('../../../apps/host/src/server');const host=await startHost({dataDirectory:join(fixture,'data'),agentDirectory:join(fixture,'agent'),discoveryDirectory:join(fixture,'project'),tailscale:false,port:0});await writeFile(join(fixture,'connection.json'),JSON.stringify(host.connection),{mode:0o600});
for await(const input of Bun.stdin.stream()){if(new TextDecoder().decode(input).includes('stop'))break;}await host.stop();
