// Production worker/SDK entry with outbound fetch disabled before SDK import.
export {};
globalThis.fetch = Object.assign(async () => { throw new Error("Outbound fetch is disabled in environment composer acceptance"); }, { preconnect: () => {} }) as typeof fetch;
await import("../../../../apps/host/src/omp-workers/entry");
