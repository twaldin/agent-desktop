import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageAttachmentsHttp } from '../../../host/src/attachment-http';
import { requestTranscriptImage } from './attachment-transport';
const data = Buffer.from('retained generated pixels'), sha256 = createHash('sha256').update(data).digest('hex');
test('generated namespace forwards the original entry/index and requires explicit server confirmation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'generated-transport-'));
  const calls: unknown[][] = [];
  const http = new ImageAttachmentsHttp({ dataDirectory: directory, hostId: 'owner', getNativeImage: async (...args) => {
    calls.push(args); return { data, sha256, bytes: data.length, mimeType: 'image/png' };
  } });
  let legacy = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    const response = (await http.handle(request))!;
    if (legacy) response.headers.delete('X-Agent-Image-Source');
    return response;
  } });
  try {
    const endpoint = { origin: server.url.origin, hostId: 'owner' };
    expect((await requestTranscriptImage(endpoint, 'session', 'entry', 3, 'generated')).sha256).toBe(sha256);
    expect(calls).toEqual([['session', 'entry', 3, 'generated']]);
    legacy = true; await expect(requestTranscriptImage(endpoint, 'session', 'entry', 3, 'generated')).rejects.toThrow('namespace');
    expect((await requestTranscriptImage(endpoint, 'session', 'entry', 3)).sha256).toBe(sha256);
    expect(calls.at(-1)).toEqual(['session', 'entry', 3, undefined]);
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
});
