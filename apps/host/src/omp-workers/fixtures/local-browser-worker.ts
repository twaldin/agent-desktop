// Contract-test entrypoint: production worker/SDK code with only loopback fetch
// allowed. Provider and external network calls fail before any SDK import.
export {};
const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("External fetch is disabled in the native browser frame contract");
  return nativeFetch(input, init);
}, { preconnect: () => {} }) as typeof fetch;
await import("../entry");
