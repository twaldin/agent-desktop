import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TailscaleClient } from "./tailscale";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

function fixtures() {
  const self = { ID: "self-stable", UserID: 12345, HostName: "home", DNSName: "home.test.ts.net.", OS: "macOS", Online: true, TailscaleIPs: ["100.64.0.1"] };
  const peer = { ID: "peer-stable", UserID: 12345, HostName: "work", DNSName: "work.test.ts.net.", OS: "linux", Online: true, TailscaleIPs: ["100.64.0.2", "fd7a:115c:a1e0::2"] };
  return {
    status: { BackendState: "Running", Self: self, Peer: { "raw-public-key": peer }, CurrentTailnet: { MagicDNSSuffix: "test.ts.net" }, AuthURL: "private-login-url" },
    whois: { Node: { StableID: peer.ID, User: peer.UserID, Online: true, Addresses: ["100.64.0.2/32", "fd7a:115c:a1e0::2/128"], Key: "raw-node-key", CapMap: { "private-capability": [] } }, UserProfile: { ID: peer.UserID, LoginName: "private-login-name" } },
  };
}

async function fakeCli(value: unknown, timeoutMs = 5000) {
  const directory = await mkdtemp(join(tmpdir(), "agent-desktop-tailscale-"));
  directories.push(directory);
  const dataPath = join(directory, "responses.json");
  const callsPath = join(directory, "calls.jsonl");
  const scriptPath = join(directory, "cli.ts");
  const binaryPath = join(directory, "tailscale");
  await writeFile(dataPath, JSON.stringify(value));
  await writeFile(scriptPath, `
    import { appendFileSync } from "node:fs";
    const args = process.argv.slice(2);
    appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
    const data = await Bun.file(${JSON.stringify(dataPath)}).json();
    if (data.mode === "fail") { process.stderr.write("private-cli-error"); process.exit(1); }
    if (data.mode === "hang") await new Promise(() => setInterval(() => {}, 1000));
    if (data.mode === "invalid") { process.stdout.write("not-json-private-data"); process.exit(0); }
    process.stdout.write(JSON.stringify(data[args[0]]));
  `);
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  await writeFile(binaryPath, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(scriptPath)} "$@"\n`);
  await chmod(binaryPath, 0o700);
  return {
    client: new TailscaleClient({ binaryPath, timeoutMs }),
    calls: async () => (await readFile(callsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]),
  };
}

describe("Tailscale presence and authorization", () => {
  test("discovery exposes only selected metadata and does not imply app installation", async () => {
    const fixture = fixtures();
    const { client, calls } = await fakeCli(fixture);
    const result = await client.discover();
    expect(result).toMatchObject({ backendState: "Running", self: { nodeId: "self-stable", userId: "12345" }, peers: [{ nodeId: "peer-stable", sameUser: true, appAvailability: "unknown", dnsName: "work.test.ts.net" }] });
    expect(JSON.stringify(result)).not.toContain("private-");
    expect(JSON.stringify(result)).not.toContain("raw-");
    expect(await calls()).toEqual([["status", "--json"]]);
  });

  test("a same-user direct peer requires matching whois identity", async () => {
    const { client, calls } = await fakeCli(fixtures());
    expect(await client.authorizePeer("100.64.0.2")).toMatchObject({ authorized: true, peer: { nodeId: "peer-stable" } });
    expect(await calls()).toEqual([["status", "--json"], ["whois", "--json", "100.64.0.2"]]);
  });

  test("IPv6 and IPv4-mapped socket addresses are normalized before identity checks", async () => {
    const { client, calls } = await fakeCli(fixtures());
    expect(await client.authorizePeer("fd7a:115c:a1e0:0:0:0:0:2")).toMatchObject({ authorized: true });
    expect(await client.authorizePeer("::ffff:100.64.0.2")).toMatchObject({ authorized: true });
    expect((await calls()).filter(args => args[0] === "whois")).toEqual([
      ["whois", "--json", "fd7a:115c:a1e0::2"], ["whois", "--json", "100.64.0.2"],
    ]);
  });

  test("a pairing allowlist narrows same-user access, including an empty deny-all list", async () => {
    const { client } = await fakeCli(fixtures());
    expect(await client.authorizePeer("100.64.0.2", { allowedNodeIds: ["peer-stable"] })).toMatchObject({ authorized: true });
    expect(await client.authorizePeer("100.64.0.2", { allowedNodeIds: [] })).toMatchObject({ authorized: false, code: "NOT_PAIRED" });
    expect(await client.authorizePeer("100.64.0.2", { allowedNodeIds: ["work"] })).toMatchObject({ authorized: false, code: "NOT_PAIRED" });
  });

  test("other users and tagged devices cannot inherit same-user or pairing authorization", async () => {
    const otherUser = fixtures();
    otherUser.status.Peer["raw-public-key"].UserID = 54321;
    const other = await fakeCli(otherUser);
    expect(await other.client.authorizePeer("100.64.0.2", { allowedNodeIds: ["peer-stable"] })).toMatchObject({ authorized: false, code: "WRONG_USER" });
    expect((await other.calls()).length).toBe(1);
    const tagged = fixtures();
    Object.assign(tagged.status.Peer["raw-public-key"], { Tags: ["tag:server"] });
    expect(await (await fakeCli(tagged)).client.authorizePeer("100.64.0.2")).toMatchObject({ authorized: false, code: "WRONG_USER" });
  });

  test("offline, expired and unavailable local identities fail closed", async () => {
    for (const change of [{ Online: false }, { Expired: true }, { KeyExpiry: "2000-01-01T00:00:00Z" }]) {
      const fixture = fixtures();
      Object.assign(fixture.status.Peer["raw-public-key"], change);
      expect(await (await fakeCli(fixture)).client.authorizePeer("100.64.0.2")).toMatchObject({ authorized: false, code: "PEER_UNAVAILABLE" });
    }
    const stopped = fixtures();
    stopped.status.BackendState = "Stopped";
    expect(await (await fakeCli(stopped)).client.authorizePeer("100.64.0.2")).toMatchObject({ authorized: false, code: "TAILSCALE_UNAVAILABLE" });
    const localTagged = fixtures();
    Object.assign(localTagged.status.Self, { Tags: ["tag:server"] });
    expect(await (await fakeCli(localTagged)).client.authorizePeer("100.64.0.2")).toMatchObject({ authorized: false, code: "LOCAL_IDENTITY_UNAVAILABLE" });
  });

  test("hostname, forwarded lists, loopback and routed subnet clients never authorize", async () => {
    const { client } = await fakeCli(fixtures());
    for (const address of ["work.test.ts.net", "100.64.0.2:443", "100.64.0.2, 100.64.0.1", "fe80::1%en0"]) {
      expect(await client.authorizePeer(address)).toMatchObject({ authorized: false, code: "INVALID_ADDRESS" });
    }
    for (const address of ["127.0.0.1", "::1", "192.168.1.2", "100.64.0.1"]) {
      expect(await client.authorizePeer(address)).toMatchObject({ authorized: false, code: "UNKNOWN_PEER" });
    }
  });

  test("whois disagreements about node, user, direct address or online status deny access", async () => {
    for (const change of [
      { StableID: "different-stable-id" }, { User: 54321 }, { Online: false },
      { Addresses: ["100.64.0.0/24"] }, { Tags: ["tag:server"] }, { Expired: true },
    ]) {
      const fixture = fixtures();
      Object.assign(fixture.whois.Node, change);
      expect(await (await fakeCli(fixture)).client.authorizePeer("100.64.0.2")).toMatchObject({ authorized: false, code: "IDENTITY_MISMATCH" });
    }
    const fixture = fixtures();
    fixture.whois.UserProfile.ID = 54321;
    expect(await (await fakeCli(fixture)).client.authorizePeer("100.64.0.2")).toMatchObject({ authorized: false, code: "IDENTITY_MISMATCH" });
  });

  test("CLI failure, timeout, invalid JSON and unsafe numeric IDs fail closed without raw output", async () => {
    for (const mode of ["fail", "hang", "invalid"]) {
      const { client } = await fakeCli({ mode }, mode === "hang" ? 100 : 5000);
      const result = await client.authorizePeer("100.64.0.2");
      expect(result).toMatchObject({ authorized: false, code: "TAILSCALE_UNAVAILABLE" });
      expect(JSON.stringify(result)).not.toContain("private-");
      await expect(client.discover()).rejects.toMatchObject({ code: mode === "invalid" ? "INVALID_RESPONSE" : "CLI_FAILED" });
    }
    const fixture = fixtures();
    fixture.status.Self.UserID = Number.MAX_SAFE_INTEGER + 1;
    expect(await (await fakeCli(fixture)).client.authorizePeer("100.64.0.2")).toMatchObject({ authorized: false, code: "TAILSCALE_UNAVAILABLE" });
    await expect(new TailscaleClient({ binaryPath: "/nonexistent/agent-desktop-tailscale" }).discover()).rejects.toMatchObject({ code: "CLI_NOT_FOUND" });
  });
});
