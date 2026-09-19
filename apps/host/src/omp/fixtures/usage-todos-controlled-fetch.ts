// Test-only provider transport: real native clients, no network or credit consume.
import { access, appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
export function installUsageTodosFetch(directory: string) {
  if (!directory || process.env.HOME !== directory) throw new Error("Disposable fixture HOME required.");
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.origin !== "https://chatgpt.com" || !["/backend-api/wham/usage", "/backend-api/wham/rate-limit-reset-credits"].includes(url.pathname)) throw new Error("Unapproved fixture network request.");
    await appendFile(path.join(directory, "calls"), `${url.pathname}\n`);
    const gate = await readFile(path.join(directory, "gate"), "utf8").catch(() => "");
    if (gate) {
      await writeFile(path.join(directory, `started-${gate}`), "started");
      const deadline = Date.now() + 10_000;
      while (!(await access(path.join(directory, `released-${gate}`)).then(() => true, () => false))) {
        if (Date.now() > deadline) throw new Error("Fixture gate deadline exceeded.");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    if (url.pathname.endsWith("/usage")) return Response.json({ plan_type: "plus", rate_limit: { allowed: true, limit_reached: false,
      primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 4_000_000_000 } } });
    return Response.json({ available_count: 1, credits: [{ id: "fixture-credit", status: "available", expires_at: "2099-01-01T00:00:00Z" }] });
  }, { preconnect() { throw new Error("Fixture preconnect prohibited."); } }) as typeof fetch;
}
