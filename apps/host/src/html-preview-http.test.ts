import { expect, test } from 'bun:test';
import { HtmlPreviewHttp } from './html-preview-http';
import { SESSION_OUTPUTS_OWNER_HEADER } from '@agent-desktop/shared';
const input = { epoch: 'epoch', output: { kind: 'html-preview' as const, path: '/task/index.html', entryId: 'entry', turnId: 'turn', revision: 'a'.repeat(64), label: 'index.html' } };
const leaseId = '12345678-1234-1234-1234-123456789012';
const lease = { leaseId, epoch: 'epoch', entryId: 'entry', revision: input.output.revision, url: `http://127.0.0.1:5555/${leaseId}/index.html`, workerPid: 10, expiresAt: 100, validForMs: 1000 };
const request = (body: unknown = input, owner = 'host', signal?: AbortSignal) => new Request('http://localhost/v1/sessions/session/html-preview/open', { method: 'POST', headers: { [SESSION_OUTPUTS_OWNER_HEADER]: owner }, body: JSON.stringify(body), signal });
test('wrong host, missing original worker and oversized body cannot acquire another owner', async () => {
  let lookups = 0;
  const http = new HtmlPreviewHttp({ hostId: 'host', sessionExists: () => true, existing: async () => { lookups++; return undefined; } });
  expect((await http.route(request(input, 'other')))!.status).toBe(409); expect(lookups).toBe(0);
  expect((await http.route(request()))!.status).toBe(409); expect(lookups).toBe(1);
  expect((await http.route(request({ text: 'x'.repeat(2 * 1024 * 1024 + 1) })))!.status).toBeGreaterThanOrEqual(400); expect(lookups).toBe(1);
});
test('worker replacement during held open releases only the original worker before refusing receipt', async () => {
  const gate = Promise.withResolvers<typeof lease>(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const calls: string[] = [];
  const original = { openHtmlPreview: async () => { entered.resolve(); return gate.promise; }, releaseHtmlPreview: async (id: string) => { calls.push(`original:${id}`); await release.promise; } };
  const replacement = { openHtmlPreview: async () => lease, releaseHtmlPreview: async () => { calls.push('replacement'); } };
  let owner = original;
  const http = new HtmlPreviewHttp({ hostId: 'host', sessionExists: () => true, existing: async () => owner });
  let settled = false; const response = http.route(request()).then(value => { settled = true; return value; }); await entered.promise;
  owner = replacement; gate.resolve(lease); await new Promise(resolve => setTimeout(resolve, 0));
  expect(settled).toBe(false); expect(calls).toEqual([`original:${leaseId}`]);
  release.resolve(); expect((await response)!.status).toBe(409);
});
test('aborted open drains a late original lease and reports a failed cleanup', async () => {
  const gate = Promise.withResolvers<typeof lease>(), entered = Promise.withResolvers<void>(), abort = new AbortController(); let released = 0;
  const owner = { openHtmlPreview: async () => { entered.resolve(); return gate.promise; }, releaseHtmlPreview: async () => { released++; throw new Error('Cleanup unavailable'); } };
  const http = new HtmlPreviewHttp({ hostId: 'host', sessionExists: () => true, existing: async () => owner });
  const response = http.route(request(input, 'host', abort.signal)); await entered.promise; abort.abort(); gate.resolve(lease);
  expect((await response)!.status).toBe(503); expect(released).toBe(1);
});
test('four pending opens bound admission and exact valid owner receipt survives the route', async () => {
  const gate = Promise.withResolvers<typeof lease>(); let starts = 0;
  const owner = { openHtmlPreview: async () => { starts++; return gate.promise; }, releaseHtmlPreview: async () => {} };
  const http = new HtmlPreviewHttp({ hostId: 'host', sessionExists: () => true, existing: async () => owner });
  const pending = Array.from({ length: 4 }, () => http.route(request()));
  expect((await http.route(request()))!.status).toBe(429);
  gate.resolve(lease); const responses = await Promise.all(pending); expect(starts).toBe(4);
  expect(await responses[0]!.json()).toEqual({ hostId: 'host', sessionId: 'session', value: lease });
});
