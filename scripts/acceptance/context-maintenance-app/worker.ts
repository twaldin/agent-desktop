// Actual production worker entry with network constrained to the owned loopback provider.
import { appendFile, readFile } from "node:fs/promises";
const directory = process.env.CONTEXT_MAINTENANCE_FIXTURE_DIRECTORY!;
if (!directory || process.env.HOME !== directory) throw new Error("Context-maintenance fixture requires disposable HOME.");
await appendFile(`${directory}/worker-starts.jsonl`, JSON.stringify({ pid: process.pid, at: Date.now() }) + "\n");
const origin = (await readFile(`${directory}/provider-origin`, "utf8")).trim(), originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init), url = new URL(request.url);
  if (url.origin !== origin) throw new Error(`Nonloopback fixture request blocked: ${url.origin}${url.pathname}`);
  return originalFetch(request);
}, { preconnect: (input: URL | string) => { if (new URL(String(input)).origin !== origin) throw new Error("Fixture preconnect blocked"); } }) as typeof fetch;
await import("../../../apps/host/src/omp-workers/entry");
