import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "./store";
import { DeviceAccessHttp } from "./device-access-http";
const roots: string[] = [], stores: HostStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function fixture(supported = true) {
  const root = mkdtempSync(join(tmpdir(), "device-access-http-")); roots.push(root);
  const store = new HostStore(root); stores.push(store);
  const observations: unknown[] = [];
  const http = new DeviceAccessHttp(store, supported, () => { observations.push(store.getDeviceAccessPolicy()); });
  const request = (change: unknown, remote = false) => http.route(new Request("http://localhost/v1/device-access", { method: "POST", body: JSON.stringify(change) }), remote);
  return { store, http, request, observations };
}
const revoke = { expectedRevision: 0, change: { type: "device", nodeId: "work", allowed: false } };
test("local policy mutation notifies after durable save; stale and remote mutations never notify", async () => {
  const { store, http, request, observations } = fixture();
  const response = await request(revoke); expect(response!.status).toBe(200);
  expect((await response!.json() as any).policy).toEqual({ revision: 1, enabled: true, revokedNodeIds: ["work"] });
  expect(observations).toEqual([store.getDeviceAccessPolicy()]);
  expect((await request(revoke))!.status).toBe(409);
  expect((await request({ ...revoke, expectedRevision: 1 }, true))!.status).toBe(403);
  expect((await http.route(new Request("http://localhost/v1/device-access"), true))!.status).toBe(403);
  expect(observations.length).toBe(1); expect(store.getDeviceAccessPolicy().revision).toBe(1);
});
test("unsupported host exposes truthful state and rejects access changes", async () => {
  const { store, http, request, observations } = fixture(false);
  const response = await http.route(new Request("http://localhost/v1/device-access"), false);
  expect(await response!.json()).toEqual({ hostId: store.host.id, supported: false, policy: { revision: 0, enabled: true, revokedNodeIds: [] } });
  expect((await request(revoke))!.status).toBe(409); expect(observations).toEqual([]);
});
