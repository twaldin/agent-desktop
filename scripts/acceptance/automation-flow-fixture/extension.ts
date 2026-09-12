import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
/** Real native extension command only. No provider response/model is registered. */
export default function(pi: ExtensionAPI) {
  pi.registerCommand('automation-flow',{description:'Record a disposable automation invocation',handler:async(args,context)=>{
    await appendFile(join(context.cwd,'automation-command-receipts.txt'),args+'\n');
  }});
}
