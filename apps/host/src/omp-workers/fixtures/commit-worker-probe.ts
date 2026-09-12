import { writeFileSync } from "node:fs";
writeFileSync(process.env.COMMIT_WORKER_PID!, String(process.pid));
globalThis.fetch = Object.assign(async () => {
  writeFileSync(process.env.COMMIT_WORKER_FETCH!, "invoked");
  throw new Error("Network access is disabled in the commit worker contract.");
}, { preconnect: () => {} }) as typeof fetch;
await import("../entry");
