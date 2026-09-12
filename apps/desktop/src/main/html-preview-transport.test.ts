import { expect, test } from 'bun:test';
import { SESSION_OUTPUTS_OWNER_HEADER } from '@agent-desktop/shared';
import { HtmlPreviewHttp } from '../../../host/src/html-preview-http';
import { requestHtmlPreview } from './html-preview-transport';
const input = { epoch: 'epoch', output: { kind: 'html-preview' as const, path: '/task/index.html', entryId: 'entry', turnId: 'turn', revision: 'a'.repeat(64), label: 'index.html' } };
const leaseId = '12345678-1234-1234-1234-123456789012';
const lease = { leaseId, epoch: 'epoch', entryId: 'entry', revision: input.output.revision, url: `http://127.0.0.1:5555/${leaseId}/index.html`, workerPid: 10, expiresAt: 100, validForMs: 1000 };
test('actual fetch/host route preserves original ownership and confirms explicit release', async () => {
  const releases: string[] = [];
  const owner = { openHtmlPreview: async () => lease, releaseHtmlPreview: async (id: string) => { releases.push(id); } };
  const http = new HtmlPreviewHttp({ hostId: 'host', sessionExists: id => id === 'session', existing: async () => owner });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async req => req.headers.get('Authorization') === 'Bearer isolated' ? (await http.route(req))! : new Response(null, { status: 401 }) });
  try {
    const endpoint = { hostId: 'host', origin: server.url.origin, token: 'isolated' };
    expect(await requestHtmlPreview(endpoint, 'session', input)).toEqual(lease);
    await requestHtmlPreview(endpoint, 'session', { leaseId }); expect(releases).toEqual([leaseId]);
    await expect(requestHtmlPreview({ ...endpoint, hostId: 'wrong' }, 'session', input)).rejects.toThrow('host changed');
  } finally { await server.stop(true); }
});
test('foreign envelope, changed saved revision, overbound body and malformed release remain failures', async () => {
  let mode = 'foreign';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(mode === 'large' ? 'x'.repeat(32 * 1024 + 1) : JSON.stringify({ hostId: mode === 'foreign' ? 'other' : 'host', sessionId: 'session', value: { ...lease, revision: 'b'.repeat(64) }, released: false }), { headers: { [SESSION_OUTPUTS_OWNER_HEADER]: 'host' } }) });
  try {
    const endpoint = { hostId: 'host', origin: server.url.origin };
    await expect(requestHtmlPreview(endpoint, 'session', input)).rejects.toThrow('owner changed');
    mode = 'revision'; await expect(requestHtmlPreview(endpoint, 'session', input)).rejects.toThrow('different saved output');
    mode = 'large'; await expect(requestHtmlPreview(endpoint, 'session', input)).rejects.toThrow('exceeds its bound');
    mode = 'release'; await expect(requestHtmlPreview(endpoint, 'session', { leaseId })).rejects.toThrow('not confirmed');
  } finally { await server.stop(true); }
});
