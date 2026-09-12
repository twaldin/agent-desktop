import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "bun:test";
import { startHost } from "../server";
import { TailnetNetwork } from "../network";
import { TailscaleClient } from "../tailscale";
const home = process.env.HOME!;
if (!home.includes("device-access-server-")) throw new Error("Isolated HOME required");
const remoteOrigin = "http://127.0.0.1:47827";
// Controlled socket identity, never a real Tailscale account or CLI invocation.
TailscaleClient.prototype.authorizePeer = async () => ({ authorized: true, checkedAt: Date.now(), peer: {
  nodeId: "controlled-work", userId: "1", hostname: "Work", dnsName: "work.invalid", os: "darwin", addresses: ["127.0.0.1"], online: true, expired: false, tags: [], sameUser: true, appAvailability: "unknown",
} });
TailnetNetwork.prototype.refresh = async function () { return this.state = { status: "connected", ownNodeId: "controlled-home", ownName: "Home", listenAddress: "127.0.0.1", hosts: [], checkedAt: Date.now() }; };
for (const dir of ["data", "agent", "project"]) await mkdir(join(home, dir), { recursive: true });
const host = await startHost({ dataDirectory: join(home, "data"), agentDirectory: join(home, "agent"), discoveryDirectory: join(home, "project"), tailscale: true, port: 0, workerPath: join(import.meta.dir, "../omp-workers/fixtures/no-provider-worker.ts") });
const local = (path: string, body?: unknown) => fetch(host.connection.origin + path, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${host.connection.token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
let socket: WebSocket | undefined;
try {
  expect((await fetch(host.connection.origin + "/v1/device-access")).status).toBe(401);
  // Wait for this exact host's remote listener and verify ownership before sending any mutation.
  for (let i = 0; ; i++) {
    try { const health = await fetch(remoteOrigin + "/v1/health"); const value = await health.json() as any; if (value.hostId !== host.store.host.id) throw new Error("Remote fixture port is owned by another host"); break; }
    catch (error) { if (i >= 20 || String(error).includes("owned by another")) throw error; await Bun.sleep(25); }
  }
  expect((await fetch(remoteOrigin + "/v1/device-access")).status).toBe(403);
  expect((await fetch(remoteOrigin + "/v1/device-access", { method: "POST", body: JSON.stringify({ expectedRevision: 0, change: { type: "availability", enabled: false } }) })).status).toBe(403);
  const initial = await local("/v1/device-access"); expect(initial.status).toBe(200);
  expect((await initial.json() as any).policy.revision).toBe(0);
  socket = new WebSocket(remoteOrigin.replace("http:", "ws:") + "/v1/events", ["agent-desktop"]);
  await new Promise<void>((resolve, reject) => { socket!.onmessage = () => resolve(); socket!.onerror = () => reject(new Error("Fixture event socket failed")); });
  const closed = new Promise<CloseEvent>(resolve => { socket!.onclose = resolve; });
  expect((await local("/v1/device-access", { expectedRevision: 0, change: { type: "device", nodeId: "controlled-work", allowed: false } })).status).toBe(200);
  const event = await Promise.race([closed, Bun.sleep(2000).then(() => { throw new Error("Revoked socket stayed open"); })]);
  expect(event.code).toBe(1008);
  expect((await fetch(remoteOrigin + "/v1/state")).status).toBe(401);
  expect((await local("/v1/state")).status).toBe(200);
  expect((await local("/v1/device-access", { expectedRevision: 1, change: { type: "device", nodeId: "controlled-work", allowed: true } })).status).toBe(200);
  expect((await fetch(remoteOrigin + "/v1/state")).status).toBe(200);
  expect((await local("/v1/device-access", { expectedRevision: 2, change: { type: "availability", enabled: false } })).status).toBe(200);
  expect((await fetch(remoteOrigin + "/v1/state")).status).toBe(401);
  expect(host.store.listSessions()).toHaveLength(0);
  console.log("isolated device policy HTTP, remote restriction and event revocation passed");
} finally { socket?.close(); await host.stop(); }
