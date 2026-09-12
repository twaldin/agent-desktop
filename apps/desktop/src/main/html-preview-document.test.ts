import { expect, test } from 'bun:test';
import { HtmlPreviewDocument } from './html-preview-document';
const request = { epoch: 'epoch', output: { kind: 'html-preview' as const, branch: 'b'.repeat(64), path: '/task/index.html', entryId: 'entry', turnId: 'turn', revision: 'a'.repeat(64), label: 'index.html' } };
const leaseId = '12345678-1234-1234-1234-123456789012';
const lease = { leaseId, epoch: 'epoch', branch: 'b'.repeat(64), entryId: 'entry', revision: request.output.revision, url: `http://127.0.0.1:5555/${leaseId}/index.html`, workerPid: 10, validForMs: 10000, expiresAt: 100 };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
test('retiring during open retains original endpoint and drains late acquired lease', async () => {
  const open = deferred<typeof lease>(), release = deferred<undefined>(), calls: any[] = [];
  const original = { hostId: 'host', origin: 'http://127.0.0.1:1' };
  const owner = new HtmlPreviewDocument({ current: () => true, connect: async () => original, request: async (endpoint, session, input) => { calls.push([endpoint.origin, session, input]); return 'output' in input ? open.promise : release.promise; } });
  const opening = owner.dispatch('session', request, 'host'); await Promise.resolve();
  let done = false; const drain = owner.retire().then(() => { done = true; });
  open.resolve(lease); await new Promise(resolve => setTimeout(resolve, 0));
  expect(calls[1]).toEqual([original.origin, 'session', { leaseId }]); expect(done).toBe(false);
  release.resolve(undefined); await expect(opening).rejects.toThrow('retired'); await drain; expect(done).toBe(true);
});
test('release stays bound to the original host and cleanup failure remains visible to joining drain', async () => {
  let origin = 'http://127.0.0.1:1'; const calls: string[] = [];
  const owner = new HtmlPreviewDocument({ current: () => true, connect: async () => ({ hostId: 'host', origin }), request: async (endpoint, _session, input) => { calls.push(endpoint.origin); if ('output' in input) return lease; throw new Error('Original release failed'); } });
  await owner.dispatch('session', request, 'host'); origin = 'http://127.0.0.1:2';
  await expect(owner.dispatch('foreign', { leaseId }, 'host')).rejects.toThrow('different document');
  await expect(owner.dispatch('session', { leaseId }, 'host')).rejects.toThrow('Original release failed');
  await expect(owner.retire()).rejects.toThrow('not confirmed'); expect(calls).toEqual(['http://127.0.0.1:1', 'http://127.0.0.1:1']);
});
test('document loss while endpoint resolves never dispatches an acquisition', async () => {
  const connection = deferred<{ hostId: string; origin: string }>(); let dispatched = 0;
  const owner = new HtmlPreviewDocument({ current: () => true, connect: () => connection.promise, request: async () => { dispatched++; return lease; } });
  const open = owner.dispatch('session', request, 'host'); const drain = owner.retire();
  connection.resolve({ hostId: 'host', origin: 'http://127.0.0.1:1' });
  await expect(open).rejects.toThrow('host changed'); await drain; expect(dispatched).toBe(0);
});
