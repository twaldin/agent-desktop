import { readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseForceToolReceipt } from '../../../packages/shared/src/force-tool';
// Guard before either SDK or production worker is loaded. No credentials or
// provider implementation is injected into the native runtime.
const root = process.env.FORCE_TOOL_FIXTURE_ROOT;
if (!root || process.env.HOME !== root || process.env.PI_DISABLE_DOTENV !== '1') throw new Error('Missing isolated force worker environment.');
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Non-loopback fetch forbidden in force worker fixture.');
  return originalFetch(input, { ...init, redirect: 'error' });
}, { preconnect: () => {} }) as typeof fetch;
const { SessionManager } = await import('@oh-my-pi/pi-coding-agent');
const originalFlush = SessionManager.prototype.flush;
SessionManager.prototype.flush = async function (...args: Parameters<typeof originalFlush>) {
  const result = await originalFlush.apply(this, args);
  // The sole scheduling hook runs AFTER the original durable flush. It never
  // appends/replaces entries, consumes/requeues directives, or invents an error.
  const gatePath = join(root, 'arm-next.json');
  if (!await Bun.file(gatePath).exists()) return result;
  const gate = JSON.parse(await readFile(gatePath, 'utf8')) as { commandId: string };
  const entry = this.getEntries().findLast(entry => {
    if (entry.type !== 'custom' || entry.customType !== 'agent-desktop.force-tool' || !entry.data || typeof entry.data !== 'object'
      || !('forceToolReceipt' in entry.data)) return false;
    const receipt = entry.data.forceToolReceipt;
    return !!receipt && typeof receipt === 'object' && 'commandId' in receipt && receipt.commandId === gate.commandId;
  });
  if (!entry || entry.type !== 'custom' || !entry.data || typeof entry.data !== 'object' || !('forceToolReceipt' in entry.data)) return result;
  const receipt = parseForceToolReceipt(entry.data.forceToolReceipt, gate.commandId);
  if (receipt.arm !== 'armed') throw new Error('Hold requires a real armed native journal entry.');
  const sessionFile = this.getSessionFile();
  if (!sessionFile || !resolve(sessionFile).startsWith(resolve(root) + '/')) throw new Error('Held journal is outside the fixture.');
  const bytes = await readFile(sessionFile, 'utf8');
  if (!bytes.split('\n').filter(Boolean).some(line => {
    const recorded = JSON.parse(line); return recorded.id === entry.id && recorded.data?.forceToolReceipt?.commandId === gate.commandId;
  })) throw new Error('Original flush returned without the actual force entry on disk.');
  try { await rename(gatePath, join(root, 'arm-claimed.json')); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return result; throw cause; }
  await writeFile(join(root, 'arm-held.json'), JSON.stringify({ commandId: gate.commandId, receipt, entryId: entry.id, sessionFile, pid: process.pid, originalFlushCompleted: true, time: Date.now() }));
  const deadline = Date.now() + 45_000;
  while (!await Bun.file(join(root, 'arm-release')).exists()) {
    if (Date.now() > deadline) throw new Error('Missing hook: interrupt did not acknowledge before the real flush hold deadline.');
    await Bun.sleep(20);
  }
  await writeFile(join(root, 'arm-released.json'), JSON.stringify({ commandId: gate.commandId, time: Date.now() }));
  return result;
};
await import('../../../apps/host/src/omp-workers/entry');
