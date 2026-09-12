import { expect, test } from "bun:test";
import { TailnetNetwork } from "./network";
import type { TailscaleAuthorization, TailscalePeer } from "./tailscale";
import type { DeviceAccessPolicy } from "../../../packages/shared/src/device-access";
const peer: TailscalePeer = { nodeId: "node-work", userId: "1", hostname: "Work", dnsName: "work.test", os: "macOS", addresses: ["100.64.0.2"], online: true, expired: false, tags: [], sameUser: true, appAvailability: "unknown" };
const accepted: TailscaleAuthorization = { authorized: true, peer, checkedAt: 1 };
const unusedDiscovery = async (): Promise<never> => { throw new Error("Unexpected discovery"); };

test("cached identity never caches access: revoke, restore and disable take effect immediately", async () => {
  let policy: DeviceAccessPolicy = { revision: 0, enabled: true, revokedNodeIds: [] }; let checks = 0;
  const network = new TailnetNetwork(() => policy, { discover: unusedDiscovery, authorizePeer: async () => { checks++; return accepted; } });
  expect(await network.authenticate(peer.addresses[0]!)).toBe(peer.nodeId);
  policy = { ...policy, revision: 1, revokedNodeIds: [peer.nodeId] };
  expect(await network.verify(peer.addresses[0]!)).toBe(false);
  policy = { ...policy, revision: 2, revokedNodeIds: [] };
  expect(await network.verify(peer.addresses[0]!)).toBe(true);
  policy = { ...policy, revision: 3, enabled: false };
  expect(await network.verify(peer.addresses[0]!)).toBe(false);
  expect(checks).toBe(1);
});

test("identity completing after revoke is denied without replaying identity verification", async () => {
  let complete!: (result: TailscaleAuthorization) => void;
  let policy: DeviceAccessPolicy = { revision: 0, enabled: true, revokedNodeIds: [] };
  const network = new TailnetNetwork(() => policy, { discover: unusedDiscovery, authorizePeer: () => new Promise(resolve => { complete = resolve; }) });
  const result = network.authenticate(peer.addresses[0]!);
  policy = { ...policy, revision: 1, revokedNodeIds: [peer.nodeId] };
  complete(accepted);
  expect(await result).toBeUndefined();
});

test("local allow cannot override failed Tailscale identity or unavailable policy", async () => {
  const network = new TailnetNetwork(() => ({ revision: 0, enabled: true, revokedNodeIds: [] }), { discover: unusedDiscovery,
    authorizePeer: async () => ({ authorized: false, code: "WRONG_USER", message: "Not the same user" }) });
  expect(await network.verify(peer.addresses[0]!)).toBe(false);
  const broken = new TailnetNetwork(() => { throw new Error("corrupt policy"); }, { discover: unusedDiscovery, authorizePeer: async () => accepted });
  await expect(broken.verify(peer.addresses[0]!)).rejects.toThrow("corrupt policy");
});
