import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHost } from "./server";
import { ThemeAssets } from "./theme-assets";

// A one-pixel PNG fixture exercises byte storage and transfer, not visual parity.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+iSgAAAABJRU5ErkJggg==", "base64");
test("private image storage verifies hashes, preserves bytes and rejects invalid formats and paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-desktop-theme-assets-")); const assets = new ThemeAssets(root);
  try {
    const stored = await assets.put(png);
    expect(stored).toMatchObject({ mimeType: "image/png", bytes: png.length });
    expect((await assets.get(stored.sha256))?.bytes).toEqual(png);
    expect((await stat(join(assets.directory, stored.sha256))).mode & 0o777).toBe(0o600);
    await expect(assets.put(png, "0".repeat(64))).rejects.toThrow("checksum");
    await expect(assets.put(Buffer.from("<svg></svg>"))).rejects.toThrow("PNG, JPEG or WebP");
    await expect(assets.get("../theme.json")).rejects.toThrow("SHA-256");
    await writeFile(join(assets.directory, stored.sha256), Buffer.concat([png, Buffer.from("corrupted")]));
    await expect(assets.get(stored.sha256)).rejects.toThrow("checksum");
  } finally { await assets.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("an absent image reaches another host through authenticated binary HTTP and survives reopening", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-desktop-theme-asset-http-"));
  const agentDirectory = join(root, "native"); await mkdir(agentDirectory);
  const remote = await startHost({ dataDirectory: join(root, "remote"), agentDirectory, discoveryDirectory: root });
  const local = new ThemeAssets(join(root, "local"));
  try {
    const uri = `${remote.connection.origin}/v1/theme/assets`;
    expect((await fetch(uri, { method: "POST", body: png })).status).toBe(401);
    const upload = await fetch(uri, { method: "POST", body: png, headers: { Authorization: `Bearer ${remote.connection.token}` } });
    expect(upload.status).toBe(200);
    const stored = await upload.json() as { sha256: string };
    expect(await local.get(stored.sha256)).toBeNull();
    const peer = { hostId: remote.connection.hostId, origin: remote.connection.origin, token: remote.connection.token };
    expect(await local.sync(stored.sha256, [{ ...peer, token: "wrong" }])).toBe(false);
    expect(await local.sync(stored.sha256, [peer])).toBe(true);
    expect((await local.get(stored.sha256))?.bytes).toEqual(png);
    expect(await local.sync(stored.sha256, [peer])).toBe(false);
    const reopened = new ThemeAssets(join(root, "local"));
    expect((await reopened.get(stored.sha256))?.bytes).toEqual(png); await reopened.dispose();
    expect(await local.sync("0".repeat(64), [peer])).toBe(false);
  } finally { await local.dispose(); await remote.stop(); await rm(root, { recursive: true, force: true }); }
}, 15_000);
