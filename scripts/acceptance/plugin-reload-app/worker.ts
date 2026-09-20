// Actual worker entry, controlled provider transport only. Never reaches a network provider.
import { appendFile, readFile } from "node:fs/promises";
const directory = process.env.PLUGIN_RELOAD_FIXTURE_DIRECTORY!;
if (!directory || process.env.HOME !== directory) throw new Error("Usage worker fixture requires disposable HOME.");
await appendFile(`${directory}/worker-starts.jsonl`, JSON.stringify({ pid: process.pid }) + "\n");
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init), url = new URL(request.url);
  if (url.origin !== "https://chatgpt.com" || !url.pathname.startsWith("/backend-api/wham/")) throw new Error("Unexpected fixture network request.");
  const account = request.headers.get("chatgpt-account-id");
  let mode = await readFile(`${directory}/wire-mode`, "utf8").catch(() => "normal");
  if (url.pathname.endsWith("/consume")) {
    const body = JSON.parse(await request.text());
    await appendFile(`${directory}/consume.jsonl`, JSON.stringify({ account, body }) + "\n");
    if (mode === "unknown") throw new Error("Fixture lost response after consume.");
    if (mode === "malformed") return new Response("not-json");
    return Response.json({ code: "reset" });
  }
  if (url.pathname.endsWith("rate-limit-reset-credits")) {
    if (mode === "hold-list") {
      await appendFile(`${directory}/held-credit-read.jsonl`, JSON.stringify({ pid: process.pid }) + "\n");
      while ((mode = await readFile(`${directory}/wire-mode`, "utf8").catch(() => "hold-list")) === "hold-list") await Bun.sleep(10);
    }
    if (mode === "list-error") return new Response("Fixture private provider error", { status: 503 });
    const credits = [{ id: `${account}-later`, status: "available", expires_at: "2099-03-01T00:00:00Z" },
      { id: `${account}-soon`, title: "Fixture saved reset", status: mode === "redeemed" ? "redeemed" : "available", expires_at: "2099-01-01T00:00:00Z" }];
    return Response.json({ available_count: 2, credits });
  }
  if (url.pathname.endsWith("/usage")) {
    await appendFile(`${directory}/usage-pids.jsonl`, JSON.stringify({ pid: process.pid }) + "\n");
    if (mode === "hold-exit") {
      await appendFile(`${directory}/held-read.jsonl`, JSON.stringify({ pid: process.pid }) + "\n");
      while ((mode = await readFile(`${directory}/wire-mode`, "utf8").catch(() => "hold-exit")) === "hold-exit") await Bun.sleep(10);
      if (mode === "exit-held") process.exit(73);
    }
    return Response.json({ plan_type: "plus", rate_limit: { allowed: true, limit_reached: false,
    primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 4_000_000_000 } }, rate_limit_reset_credits: { available_count: 2 } });
  }
  throw new Error("Unexpected native usage fixture endpoint.");
}, { preconnect: () => { throw new Error("Fixture preconnect prohibited."); } }) as typeof fetch;
await import("../../../apps/host/src/omp-workers/entry");
