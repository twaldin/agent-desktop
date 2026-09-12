import { test, expect } from 'bun:test';
import { BROWSER_METADATA_OWNER_HEADER, type BrowserControlRequest } from '@agent-desktop/shared';
import { BrowserControlHttp } from './browser-control-http';
import { requestBrowserControl } from '../../desktop/src/main/browser-control-transport';
const context = { documentId: 'document', width: 640, height: 480, scrollX: 0, scrollY: 0,
  navigation: { entryId: 7, canGoBack: true, canGoForward: false } };
const target = { workerPid: 42, name: 'main', targetId: 'native-target' };
const result = { name: 'main', targetId: 'native-target', context, url: 'http://localhost/page', title: '' };
function setup(control = async (_: BrowserControlRequest) => result, afterCompletedNavigation?: (sessionId:string,input:BrowserControlRequest)=>Promise<void>) {
  let now = 1_000_000, calls = 0;
  const handle = { workerPid: 42, controlBrowser: async (input: BrowserControlRequest) => { calls++; return control(input); } };
  let current: typeof handle | undefined = handle;
  const http = new BrowserControlHttp({ hostId: 'owner', sessionExists: () => true, getExistingHandle: async () => current, afterCompletedNavigation, now: () => now });
  const input: BrowserControlRequest = { requestId: crypto.randomUUID(), controlEpoch: http.epoch, capturedAt: now, target, context, action: { type: 'text', text: 'private input' } };
  const request = (value: unknown = input, owner = 'owner') => new Request('http://localhost/v1/sessions/session/browser-control', { method: 'POST', headers: { [BROWSER_METADATA_OWNER_HEADER]: owner }, body: JSON.stringify(value) });
  return { http, input, request, calls: () => calls, advance: (ms: number) => now += ms, replace: () => { current = undefined; } };
}
test('browser actions reject invalid owner, stale host/worker/document inputs before side effects', async () => {
  const s = setup();
  expect((await s.http.route(s.request(s.input, 'other')))?.status).toBe(409);
  expect((await (await s.http.route(s.request({ ...s.input, controlEpoch: 'old' })))!.json()).outcome).toBe('rejected');
  expect((await s.http.route(s.request({ ...s.input, action: { type: 'navigate', url: 'javascript:alert(1)' } })))?.status).toBe(400);
  expect((await s.http.route(s.request({ ...s.input, context: { ...context, width: Infinity } })))?.status).toBe(400);
  expect((await s.http.route(s.request({ ...s.input, action: { type: 'click', x: 640, y: 0 } })))?.status).toBe(400);
  expect((await s.http.route(s.request({ ...s.input, action: { type: 'resize', width: 16_384, height: 16_384 } })))?.status).toBe(400);
  s.advance(61_000); expect((await (await s.http.route(s.request()))!.json()).outcome).toBe('rejected');
  expect(s.calls()).toBe(0);
});
test('completed navigation observes host-owned history before returning but observation failure cannot erase its receipt', async () => {
  const observed:BrowserControlRequest[]=[];
  const s=setup(undefined,async(sessionId,input)=>{expect(sessionId).toBe('session');observed.push(input)});
  const navigation={...s.input,action:{type:'navigate' as const,url:'http://localhost/two'}};
  expect((await (await s.http.route(s.request(navigation)))!.json()).outcome).toBe('completed');expect(observed).toEqual([navigation]);
  expect((await (await s.http.route(s.request(navigation)))!.json()).outcome).toBe('completed');expect(observed).toEqual([navigation]);
  const failing=setup(undefined,async()=>{throw new Error('history unavailable')});
  expect((await (await failing.http.route(failing.request({...failing.input,action:{type:'navigate',url:'http://localhost/two'}})))!.json()).outcome).toBe('completed');
});
test('explicit resize admission preserves the exact native history and resulting viewport context', async () => {
  const resized = { ...context, width: 800, height: 600 };
  const s = setup(async input => {
    expect(input.action).toEqual({ type: 'resize', width: 800, height: 600 });
    return { ...result, context: resized };
  });
  const response = await s.http.route(s.request({ ...s.input, action: { type: 'resize', width: 800, height: 600 } }));
  expect(await response!.json()).toMatchObject({ outcome: 'completed', context: resized });
  expect(s.calls()).toBe(1);
});
test('concurrent action retries share one receipt; changed input cannot reuse identity', async () => {
  const gate = Promise.withResolvers<typeof result>(), s = setup(async () => gate.promise);
  const first = s.http.route(s.request()), retry = s.http.route(s.request()); await Bun.sleep(5);
  expect(s.calls()).toBe(1); gate.resolve(result);
  const [a,b] = await Promise.all([first, retry]); expect(await a!.json()).toEqual(await b!.json());
  const changed = await (await s.http.route(s.request({ ...s.input, action: { type: 'text', text: 'different' } })))!.json();
  expect(changed.outcome).toBe('rejected'); expect(s.calls()).toBe(1);
  const again = await (await s.http.route(s.request()))!.json(); expect(again.outcome).toBe('completed'); expect(JSON.stringify(again)).not.toContain('private input');
  s.advance(121_000); expect((await (await s.http.route(s.request()))!.json()).outcome).toBe('rejected'); expect(s.calls()).toBe(1);
});
test('native busy rejection and uncertain dispatch remain distinct and never auto replay', async () => {
  for (const name of ['BrowserActionRejected', 'Error']) {
    const s = setup(async () => { const error = new Error('private runtime details'); error.name = name; throw error; });
    const a = await (await s.http.route(s.request()))!.json(), b = await (await s.http.route(s.request()))!.json();
    expect(a).toEqual(b); expect(a.outcome).toBe(name === 'BrowserActionRejected' ? 'rejected' : 'unknown'); expect(JSON.stringify(a)).not.toContain('private'); expect(s.calls()).toBe(1);
  }
});
test('worker replacement after dispatch is uncertain even if old worker returns success', async () => {
  const gate = Promise.withResolvers<typeof result>(), s = setup(async () => gate.promise);
  const pending = s.http.route(s.request()); await Bun.sleep(5); s.replace(); gate.resolve(result);
  expect((await (await pending)!.json()).outcome).toBe('unknown'); expect(s.calls()).toBe(1);
});
test('production desktop transport submits once and validates exact authenticated receipt', async () => {
  const s = setup(), server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    expect(request.headers.get('authorization')).toBe('Bearer fixture-token');
    return (await s.http.route(request)) ?? new Response('', {status:404});
  } });
  try {
    const receipt = await requestBrowserControl({ hostId: 'owner', origin: server.url.origin, token: 'fixture-token' }, 'session', s.input);
    expect(receipt.outcome).toBe('completed'); expect(receipt.context).toEqual(context); expect(s.calls()).toBe(1);
  } finally { await server.stop(true); }
});
