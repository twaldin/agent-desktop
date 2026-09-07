import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const root=process.argv[2]!;
await mkdir(join(root,'agent'),{recursive:true});
const {startHost}=await import('../../apps/host/src/server');
const host=await startHost({dataDirectory:join(root,'data'),agentDirectory:join(root,'agent'),discoveryDirectory:root,
  workerPath:join(import.meta.dir,'../../apps/host/src/omp-workers/fixtures/no-provider-worker.ts'),tailscale:false,port:0});
await writeFile(join(root,'ready.json'),JSON.stringify(host.connection),{mode:0o600});
process.on('message',()=>void host.stop().then(()=>process.exit(0)));
