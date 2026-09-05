import { afterEach, describe, expect, test } from "bun:test";
import { probeAppHost } from "./network";

const host = { id: "work-fixture", name: "Work fixture", platform: "darwin", architecture: "arm64" };
const health = { protocolVersion: 1, host };
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

function serve(fetch: (request: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  servers.push(server);
  return server.url.origin;
}

describe("app host health discovery", () => {
  test("a healthy owner responding after 1.5 seconds is available with its exact identity", async () => {
    const requests: string[] = [];
    const origin = serve(async request => {
      requests.push(new URL(request.url).pathname);
      await Bun.sleep(1700);
      return Response.json(health);
    });
    expect(await probeAppHost(origin)).toEqual({ availability: "available", host, origin });
    expect(requests).toEqual(["/v1/health"]);
  }, 5000);

  test("authorization failure and server failure remain unavailable", async () => {
    for (const status of [401, 403, 500, 503]) {
      const origin = serve(() => Response.json(health, { status }));
      expect(await probeAppHost(origin)).toEqual({ availability: "unavailable", error: `Host service returned ${status}.` });
    }
  });

  test("redirects never follow another origin or mark an owner available", async () => {
    let destinationRequests = 0;
    const destination = serve(() => { destinationRequests++; return Response.json(health); });
    const origin = serve(() => Response.redirect(`${destination}/v1/health`, 302));
    expect(await probeAppHost(origin)).toEqual({ availability: "unavailable", error: "App host service is not reachable." });
    expect(destinationRequests).toBe(0);
  });

  test("a successful status still requires the actual host identity and compatible protocol", async () => {
    for (const value of [
      { ...health, protocolVersion: 2 }, { host }, { protocolVersion: 1 },
      ...Object.keys(host).map(key => ({ ...health, host: { ...host, [key]: 42 } })),
    ]) {
      const origin = serve(() => Response.json(value));
      expect(await probeAppHost(origin)).toEqual({ availability: "unavailable", error: "Host service has an incompatible protocol." });
    }
    for (const body of ["not-json", "null"]) {
      const origin = serve(() => new Response(body));
      expect(await probeAppHost(origin)).toEqual({ availability: "unavailable", error: "App host service is not reachable." });
    }
  });

  test("an unanswered health request remains unavailable within its explicit deadline", async () => {
    let requests = 0;
    const origin = serve(async () => {
      requests++;
      await Bun.sleep(2000);
      return Response.json(health);
    });
    const start = performance.now();
    expect(await probeAppHost(origin, 100)).toEqual({ availability: "unavailable", error: "App host service is not reachable." });
    expect(performance.now() - start).toBeLessThan(1500);
    expect(requests).toBe(1);
  }, 3000);

  test("the deadline also bounds a response whose headers arrive but body never completes", async () => {
    const origin = serve(() => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"protocolVersion":1,"host":')); },
    }), { headers: { "content-type": "application/json" } }));
    const start = performance.now();
    expect(await probeAppHost(origin, 100)).toEqual({ availability: "unavailable", error: "App host service is not reachable." });
    expect(performance.now() - start).toBeLessThan(1500);
  }, 3000);
});
