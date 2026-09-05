// Contract-test entrypoint: production worker/SDK code, with outbound fetch
// rejected before any SDK import. No provider responses or sessions are mocked.
export {};
globalThis.fetch = Object.assign(
  async () => { throw new Error("Outbound fetch is disabled in the OMP worker lifecycle contract"); },
  { preconnect: () => {} },
) as typeof fetch;
await import("../entry");
