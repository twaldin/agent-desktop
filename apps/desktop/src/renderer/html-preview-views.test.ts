import { expect, test } from 'bun:test';
import type { DesktopBridge } from '@agent-desktop/shared';
import { HtmlPreviewViews } from './html-preview-views';
const leaseId = '12345678-1234-1234-1234-123456789012';
const output = { kind: 'html-preview' as const, branch: 'b'.repeat(64), path: '/task/index.html', entryId: 'entry', turnId: 'turn', revision: 'a'.repeat(64), label: 'index.html' };
const lease = { leaseId, epoch: 'epoch', branch: 'b'.repeat(64), entryId: 'entry', revision: output.revision, url: `http://127.0.0.1:5555/${leaseId}/index.html`, workerPid: 11, validForMs: 10000, expiresAt: Date.now() + 10000 };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
test('source loss during native preparation releases original lease without a browser queue', async () => {
  const pending = deferred<typeof lease>(), releases: any[] = []; let current = true, queued = 0;
  const bridge = { openHtmlPreview: () => pending.promise, releaseHtmlPreview: async (...args: any[]) => { releases.push(args); } } as unknown as DesktopBridge;
  const owner = new HtmlPreviewViews(() => {});
  const opening = owner.open({ bridge, hostId: 'host', sessionId: 'session', epoch: 'epoch', output, admitted: () => current, retained: () => current, queue: () => { queued++; return undefined; } });
  current = false; pending.resolve(lease); await expect(opening).rejects.toThrow('selection changed'); expect(queued).toBe(0); expect(releases).toEqual([['session', leaseId, 'host']]); owner.dispose();
});
test('queued refusal releases while accepted original tab retains until actual removal', async () => {
  const releases: string[] = [], acceptance = deferred<boolean>();
  const bridge = { openHtmlPreview: async () => lease, releaseHtmlPreview: async (_session: string, id: string) => { releases.push(id); } } as unknown as DesktopBridge;
  const owner = new HtmlPreviewViews(() => {});
  const opening = owner.open({ bridge, hostId: 'host', sessionId: 'session', epoch: 'epoch', output, admitted: () => true, retained: () => true, queue: () => ({ tabId: 'original', queued: acceptance.promise }) });
  await Promise.resolve(); owner.observe(['original']); acceptance.resolve(true); await opening; expect(releases).toEqual([]);
  owner.observe([]); await Promise.resolve(); expect(releases).toEqual([leaseId]); owner.dispose();
  const refused = new HtmlPreviewViews(() => {});
  await refused.open({ bridge, hostId: 'host', sessionId: 'session', epoch: 'epoch', output, admitted: () => true, retained: () => true, queue: () => ({ tabId: 'refused', queued: Promise.resolve(false) }) });
  expect(releases).toEqual([leaseId, leaseId]); refused.dispose();
});
test('cleanup errors remain visible while no new acquisition is allowed after disposal', async () => {
  const errors: string[] = [];
  const bridge = { openHtmlPreview: async () => lease, releaseHtmlPreview: async () => { throw new Error('Offline release'); } } as unknown as DesktopBridge;
  const owner = new HtmlPreviewViews(message => errors.push(message)); owner.observe(['tab']);
  await owner.open({ bridge, hostId: 'host', sessionId: 'session', epoch: 'epoch', output, admitted: () => true, retained: () => true, queue: () => ({ tabId: 'tab', queued: Promise.resolve(true) }) });
  owner.dispose(); await Promise.resolve(); await Promise.resolve(); expect(errors).toEqual(['Offline release']);
  await expect(owner.open({ bridge, hostId: 'host', sessionId: 'session', epoch: 'epoch', output, admitted: () => true, retained: () => true, queue: () => undefined })).rejects.toThrow('no longer selected');
});

test('remote host clock does not decide the local browser admission deadline', async () => {
  const owner = new HtmlPreviewViews(() => {}); owner.observe(['tab']);
  const bridge = { openHtmlPreview: async () => ({ ...lease, expiresAt: 1 }), releaseHtmlPreview: async () => {} } as unknown as DesktopBridge;
  const before = Date.now(); let deadline = 0;
  await owner.open({ bridge, hostId: 'host', sessionId: 'session', epoch: 'epoch', output, admitted: () => true, retained: () => true,
    queue: (_url, _current, preview) => { deadline = preview.expiresAt; return { tabId: 'tab', queued: Promise.resolve(true) }; } });
  expect(deadline).toBeGreaterThanOrEqual(before + lease.validForMs);
  expect(deadline).toBeLessThanOrEqual(Date.now() + lease.validForMs);
  owner.dispose();
});
test('failed queue and failed original release retain both operational errors', async () => {
  const owner = new HtmlPreviewViews(() => {});
  const bridge = { openHtmlPreview: async () => lease, releaseHtmlPreview: async () => { throw new Error('Release offline'); } } as unknown as DesktopBridge;
  const error = await owner.open({ bridge, hostId: 'host', sessionId: 'session', epoch: 'epoch', output, admitted: () => true, retained: () => true,
    queue: () => { throw new Error('Queue failed'); } }).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors.map((cause: Error) => cause.message)).toEqual(['Queue failed', 'Release offline']);
  owner.dispose();
});
