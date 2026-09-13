// Guard before either SDK or production worker is loaded. No credentials or
// provider implementation is injected into the native runtime.
const root = process.env.PLAN_APP_FIXTURE_ROOT;
if (!root || process.env.HOME !== root || process.env.PI_DISABLE_DOTENV !== '1') throw new Error('Missing isolated Plan worker environment.');
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Non-loopback fetch forbidden in Plan worker fixture.');
  return originalFetch(input, { ...init, redirect: 'error' });
}, { preconnect: () => {} }) as typeof fetch;
await import('../../../apps/host/src/omp-workers/entry');
export {};
