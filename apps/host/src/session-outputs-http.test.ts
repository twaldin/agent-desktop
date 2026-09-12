import { expect, test } from 'bun:test';
import { SessionOutputsHttp } from './session-outputs-http';
import { requestSessionOutputs } from '../../desktop/src/main/session-outputs-transport';
import { parseSessionOutputs, type SessionOutputs } from '@agent-desktop/shared';
const empty = (): SessionOutputs => ({ epoch: 'owner', revision: 'a'.repeat(64), outputs: [], warnings: [], truncated: false });
const request = () => new Request('http://fixture/v1/sessions/task/outputs', { headers: { 'X-Agent-Host-Id': 'host' } });
test('real bounded transport accepts only the exact current loaded task owner without creating one', async () => {
  let reads = 0, selected: { getSessionOutputs(): Promise<SessionOutputs> } | undefined = { getSessionOutputs: async () => { reads++; return empty(); } };
  const http = new SessionOutputsHttp({ hostId: 'host', sessionExists: () => true, existing: async () => selected });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async req => await http.route(req) ?? new Response('', { status: 404 }) });
  try {
    expect(await requestSessionOutputs({ hostId: 'host', origin: server.url.origin }, 'task')).toEqual(empty()); expect(reads).toBe(1);
    await expect(requestSessionOutputs({ hostId: 'foreign', origin: server.url.origin }, 'task')).rejects.toThrow('another host'); expect(reads).toBe(1);
    selected = undefined; await expect(requestSessionOutputs({ hostId: 'host', origin: server.url.origin }, 'task')).rejects.toThrow('Open the task'); expect(reads).toBe(1);
  } finally { server.stop(true); }
});
test('both held reads retain their reservation and discard a replaced or removed original owner', async () => {
  const held = Promise.withResolvers<SessionOutputs>(); let exists = true;
  const original = { getSessionOutputs: () => held.promise }; let current = original;
  const http = new SessionOutputsHttp({ hostId: 'host', sessionExists: () => exists, existing: async () => current });
  const a = http.route(request()), b = http.route(request());
  expect((await http.route(request()))?.status).toBe(429);
  current = { getSessionOutputs: async () => empty() }; exists = false; held.resolve(empty());
  expect((await a)?.status).toBe(409); expect((await b)?.status).toBe(409);
  exists = true; expect((await http.route(request()))?.status).toBe(200);
});
test('malformed dispatched output is not serialized as a successful response; sparse controls are rejected', async () => {
  const http = new SessionOutputsHttp({ hostId: 'host', sessionExists: () => true, existing: async () => ({ getSessionOutputs: async () => ({ ...empty(), outputs: new Array(1) }) }) });
  expect((await http.route(request()))?.status).toBe(503);
  expect(() => parseSessionOutputs({ ...empty(), warnings: new Array(1) })).toThrow();
});
test('desktop response owner and 2 MiB body limits reject before output publication', async () => {
  let mode = 'identity';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => mode === 'identity'
    ? Response.json({ hostId: 'host', sessionId: 'replacement', value: empty() }, { headers: { 'X-Agent-Host-Id': 'host' } })
    : new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'X-Agent-Host-Id': 'host' } }) });
  try {
    await expect(requestSessionOutputs({ hostId: 'host', origin: server.url.origin }, 'task')).rejects.toThrow('owner changed');
    mode = 'oversize'; await expect(requestSessionOutputs({ hostId: 'host', origin: server.url.origin }, 'task')).rejects.toThrow('2 MiB');
  } finally { server.stop(true); }
});
