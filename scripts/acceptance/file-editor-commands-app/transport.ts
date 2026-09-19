import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Hold = { arrived: Promise<void>; release(): void };
export async function interceptOwnedHost(fixture: string, output: string) {
  const locator = join(fixture, "data/connection.json");
  const connection: unknown = JSON.parse(await readFile(locator, "utf8"));
  if (!connection || typeof connection !== "object" || !("origin" in connection) || typeof connection.origin !== "string"
    || !("token" in connection) || typeof connection.token !== "string" || !/^[a-f0-9]{64}$/.test(connection.token)
    || !("pid" in connection) || typeof connection.pid !== "number" || !("hostId" in connection) || typeof connection.hostId !== "string"
    || new URL(connection.origin).hostname !== "127.0.0.1") throw new Error("The race fixture requires a valid actual owned loopback connection.");
  const origin = connection.origin;
  let hold: { arrived(): void; released: Promise<void> } | undefined;
  const upstreams = new Set<WebSocket>();
  const releases = new Set<() => void>();
  const server = Bun.serve<{ url: string; protocols: string[]; upstream?: WebSocket; queued: Array<string | Buffer<ArrayBuffer>> }>({
    hostname: "127.0.0.1", port: 0,
    async fetch(request, server) {
      const requestAt = Date.now();
      const url = new URL(request.url), destination = new URL(url.pathname + url.search, origin);
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        destination.protocol = "ws:";
        return server.upgrade(request, { data: { url: destination.href, protocols: request.headers.get("sec-websocket-protocol")?.split(",").map(value => value.trim()) ?? [], queued: [] }, headers: { "Sec-WebSocket-Protocol": "agent-desktop" } }) ? undefined : new Response("Upgrade refused", { status: 400 });
      }
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
      let type: string | undefined, path: string | undefined, position: unknown;
      if (url.pathname === "/v1/workspace/query" && body) {
        const input: unknown = JSON.parse(new TextDecoder().decode(body));
        if (!input || typeof input !== "object" || !("query" in input) || !input.query || typeof input.query !== "object"
          || !("type" in input.query) || typeof input.query.type !== "string") throw new Error("Invalid real workspace query envelope.");
        if ("path" in input.query && typeof input.query.path === "string") path = input.query.path;
        type = input.query.type;
        if ("request" in input.query && input.query.request && typeof input.query.request === "object") {
          if ("path" in input.query.request && typeof input.query.request.path === "string") path = input.query.request.path;
          if ("position" in input.query.request) position = input.query.request.position;
        }
      }
      const selected = type === "file.definitions" ? hold : undefined;
      if (selected) hold = undefined;
      const response = await fetch(destination, { method: request.method, headers: request.headers, body });
      const bytes = await response.arrayBuffer();
      if (type?.startsWith("file.")) await appendFile(join(output, "compiler-transport.jsonl"), JSON.stringify({ type, path, position, status: response.status, held: Boolean(selected), requestAt, responseAt: Date.now() }) + "\n");
      if (selected) { selected.arrived(); await selected.released; }
      return new Response(bytes, { status: response.status, headers: response.headers });
    },
    websocket: {
      open(client) {
        const upstream = new WebSocket(client.data.url, client.data.protocols); client.data.upstream = upstream; upstreams.add(upstream);
        upstream.onopen = () => { for (const message of client.data.queued) upstream.send(message); client.data.queued = []; };
        upstream.onmessage = event => { client.send(event.data); };
        upstream.onclose = event => { upstreams.delete(upstream); client.close(event.code === 1005 ? 1000 : event.code, event.reason); };
        upstream.onerror = () => { client.close(1011, "Actual owned host transport failed"); };
      },
      message(client, message) { if (client.data.upstream?.readyState === WebSocket.OPEN) client.data.upstream.send(message); else client.data.queued.push(message); },
      close(client) { client.data.upstream?.close(); },
    },
  });
  await writeFile(locator, JSON.stringify({ ...connection, origin: `http://127.0.0.1:${server.port}` }), { mode: 0o600 });
  return {
    holdNextDefinitions(): Hold {
      if (hold) throw new Error("A compiler response hold is already armed.");
      let arrived!: () => void, resolveRelease!: () => void;
      let deadline: ReturnType<typeof setTimeout>;
      const arrival = new Promise<void>((resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("The actual compiler response did not arrive at the armed hold.")), 25_000);
        arrived = () => { clearTimeout(deadline); resolve(); };
      });
      const released = new Promise<void>(resolve => { resolveRelease = resolve; });
      const release = () => { clearTimeout(deadline); releases.delete(release); resolveRelease(); };
      releases.add(release); hold = { arrived, released };
      return { arrived: arrival, release };
    },
    async close() { for (const release of releases) release(); for (const upstream of upstreams) upstream.close(); await server.stop(true); },
  };
}
