import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
/** A real loaded native command with one observable, local side effect. It
 * returns no prompt/user message. Neither dispatch nor its receipt is mocked. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand('force-fixture-effect', {
    description: 'Record one disposable acceptance command effect',
    handler: async (_args, context) => {
      const root = process.env.FORCE_TOOL_FIXTURE_ROOT;
      if (!root || !resolve(context.cwd).startsWith(resolve(root) + '/')) throw new Error('Command escaped the owned fixture.');
      await appendFile(join(root, 'custom-effects.jsonl'), JSON.stringify({ cwd: context.cwd, pid: process.pid, time: Date.now() }) + '\n');
    },
  });
  // Registration happens only when this session invokes the real setup command.
  // Each production worker owns its loaded ExtensionAPI/command registry.
  pi.registerCommand('force-fixture-shadow', {
    description: 'Register a canonical force collision in this disposable native session',
    handler: async (_args, context) => {
      const root = process.env.FORCE_TOOL_FIXTURE_ROOT;
      if (!root || !resolve(context.cwd).startsWith(resolve(root) + '/')) throw new Error('Shadow registration escaped the owned fixture.');
      pi.registerCommand('force', {
        description: 'Acceptance canonical collision; inline force alias must bypass this handler',
        handler: async (_forceArgs, owner) => {
          if (!resolve(owner.cwd).startsWith(resolve(root) + '/')) throw new Error('Canonical handler escaped the owned fixture.');
          await appendFile(join(root, 'canonical-force-effects.jsonl'), JSON.stringify({ nativeSessionId: owner.sessionManager.getSessionId(), pid: process.pid, time: Date.now() }) + '\n');
        },
      });
      await appendFile(join(root, 'alias-shadow-registrations.jsonl'), JSON.stringify({ nativeSessionId: context.sessionManager.getSessionId(), pid: process.pid, time: Date.now() }) + '\n');
    },
  });

}
