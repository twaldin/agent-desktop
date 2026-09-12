import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { IMAGE_ATTACHMENT_OWNER_HEADER, MAX_IMAGE_ATTACHMENT_BYTES, type ImageAttachmentRef } from "@agent-desktop/shared";
import { ImageAttachmentsHttp } from "./attachment-http";
import { inspectImageAttachment, requestImageAttachment, requestImageAttachmentCapabilities, requestTranscriptImage, uploadImageAttachment } from "../../desktop/src/main/attachment-transport";
import { HostRequestError } from "../../desktop/src/main/host-transport";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+iSgAAAABJRU5ErkJggg==", "base64");
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
let root: string, api: ImageAttachmentsHttp;
const servers: ReturnType<typeof Bun.serve>[] = [];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "agent-image-http-")); api = new ImageAttachmentsHttp({ dataDirectory: root, hostId: "owner", getNativeImage: async () => { throw new Error("No native fixture image"); } }); });
afterEach(async () => { for (const server of servers.splice(0)) server.stop(true); await rm(root, { recursive: true, force: true }); });
function endpoint(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 24 * 1024 * 1024, fetch: handler }); servers.push(server);
  return { origin: server.url.origin, hostId: "owner", token: "isolated-transport-test-token" };
}
function serving() {
  return endpoint(async request => {
    if (request.headers.get("authorization") !== "Bearer isolated-transport-test-token" || request.headers.has("origin")) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return await api.handle(request) ?? Response.json({ error: "Not found" }, { status: 404 });
  });
}
function reference(metadata: Awaited<ReturnType<typeof api.store.putImage>>, id = "chip"): ImageAttachmentRef {
  return { id, hostId: "owner", kind: "image", sha256: metadata.sha256, name: "captured.png", bytes: metadata.bytes, mimeType: metadata.mimeType };
}

test("local inspection supplies original metadata for offline decoding without uploading or claiming compressed-pixel validation", async () => {
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
  for (const bytes of [png, gif, await new Bun.Image(png).resize(3, 2).jpeg().bytes(), await new Bun.Image(png).resize(2, 3).webp().bytes()]) {
    expect(inspectImageAttachment(bytes)).toEqual(await api.store.putImage(hash(bytes), bytes));
  }
  expect(() => inspectImageAttachment(Buffer.from('<svg width="1" height="1"/>'))).toThrow();
  expect(() => inspectImageAttachment(new Uint8Array(MAX_IMAGE_ATTACHMENT_BYTES + 1))).toThrow();
  const incomplete = png.subarray(0, 33);
  expect(inspectImageAttachment(incomplete)).toMatchObject({ sha256: hash(incomplete), width: 1, height: 1 });
  await expect(api.store.putImage(hash(incomplete), incomplete)).rejects.toMatchObject({ code: "INVALID_IMAGE_DATA" });
  const huge = Buffer.from(png); huge.writeUInt32BE(16_777_217, 16);
  expect(() => inspectImageAttachment(huge)).toThrow("pixels");
});

test("actual privileged HTTP and main binary transport preserve original bytes and owner metadata across storage reopen", async () => {
  const target = serving();
  expect(await requestImageAttachmentCapabilities(target)).toEqual(api.capabilities);
  for (const bytes of [png, await new Bun.Image(png).resize(3, 2).jpeg().bytes(), await new Bun.Image(png).webp().bytes()]) {
    const sha256 = hash(bytes), captured = Uint8Array.from(bytes);
    const pending = uploadImageAttachment(target, sha256, captured);
    captured.fill(0);
    const metadata = await pending;
    expect(metadata.sha256).toBe(sha256);
    expect(metadata.bytes).toBe(bytes.length);
    expect(await uploadImageAttachment(target, sha256, bytes)).toEqual(metadata);
    api = new ImageAttachmentsHttp({ dataDirectory: root, hostId: "owner", getNativeImage: async () => { throw new Error("No native fixture image"); } });
    const downloaded = await requestImageAttachment(target, sha256);
    expect(downloaded.data).toEqual(Uint8Array.from(bytes));
    expect(downloaded.mimeType).toBe(metadata.mimeType);
    expect(await readFile(join(root, "attachments", "images", sha256.slice(0, 2), sha256))).toEqual(Buffer.from(bytes));
    expect(JSON.stringify(metadata)).not.toContain("data");
  }
  await expect(requestImageAttachmentCapabilities({ ...target, token: "wrong" })).rejects.toBeInstanceOf(HostRequestError);
  const denied = await fetch(`${target.origin}/v1/attachments/capabilities`, { headers: { authorization: `Bearer ${target.token}`, origin: "https://untrusted.invalid" } });
  expect(denied.status).toBe(401);
  expect(await requestImageAttachmentCapabilities(endpoint(() => Response.json({ error: "Not found" }, { status: 404 })))).toBeNull();
  await expect(requestImageAttachmentCapabilities(endpoint(() => Response.json({ code: "OWNER_MISSING", error: "Unavailable" }, { status: 404 })))).rejects.toMatchObject({ code: "OWNER_MISSING" });
});

test("owner preparation rejects missing, changed, foreign and mislabeled sources before invoking native work", async () => {
  const metadata = await api.store.putImage(hash(png), png), ref = reference(metadata);
  let invoked = 0;
  const prepare = (refs: ImageAttachmentRef[]) => api.withPrepared(refs, async images => { invoked++; return images; });
  const original = structuredClone(ref);
  const pending = prepare([ref, { ...ref, id: "duplicate-bytes" }]);
  ref.name = "changed-after-capture";
  const prepared = await pending;
  expect(prepared.map(image => image.attachment)).toEqual([original, { ...original, id: "duplicate-bytes" }]);
  expect(prepared.every(image => hash(image.data) === original.sha256)).toBe(true);
  for (const invalid of [{ ...ref, hostId: "other" }, { ...ref, bytes: ref.bytes + 1 }, { ...ref, mimeType: "image/jpeg" as const }, { ...ref, sha256: "0".repeat(64) }]) await expect(prepare([invalid])).rejects.toThrow();
  expect(invoked).toBe(1);
  const location = join(root, "attachments", "images", ref.sha256.slice(0, 2), ref.sha256);
  await writeFile(location, Buffer.alloc(png.length));
  await expect(prepare([ref])).rejects.toMatchObject({ code: "CORRUPT_IMAGE_STORAGE" });
  expect(invoked).toBe(1);
});

test("byte transfers reject missing or stale owning hosts before body, storage, native callbacks or slot admission", async () => {
  let nativeReads = 0;
  api = new ImageAttachmentsHttp({ dataDirectory: root, hostId: "owner", getNativeImage: async () => {
    nativeReads++; return { data: png, bytes: png.length, mimeType: "image/png", sha256: hash(png) };
  } });
  const target = serving();
  for (const hostId of ["stale-owner", undefined]) {
    const headers = { authorization: `Bearer ${target.token}`, ...(hostId ? { [IMAGE_ATTACHMENT_OWNER_HEADER]: hostId } : {}) };
    for (const path of [`/v1/attachments/images/${hash(png)}`, "/v1/sessions/session/images/entry/1"]) {
      const response = await fetch(`${target.origin}${path}`, { headers });
      expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "OWNER_MISMATCH" });
    }
    const response = await fetch(`${target.origin}/v1/attachments/images/${hash(png)}`, { method: "PUT", headers, body: png });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "OWNER_MISMATCH" });
  }
  expect(nativeReads).toBe(0);
  expect(await Bun.file(join(root, "attachments", "images", hash(png).slice(0, 2), hash(png))).exists()).toBe(false);
  await expect(uploadImageAttachment({ ...target, hostId: "stale-owner" }, hash(png), png)).rejects.toMatchObject({ code: "OWNER_MISMATCH", status: 409 });
  await expect(requestImageAttachment({ ...target, hostId: "stale-owner" }, hash(png))).rejects.toMatchObject({ code: "OWNER_MISMATCH", status: 409 });

  // Owner rejection must precede the occupied global image-operation bound too.
  const gate = Promise.withResolvers<void>(), metadata = await api.store.putImage(hash(png), png);
  const held = [api.withPrepared([reference(metadata, "one")], async () => gate.promise), api.withPrepared([reference(metadata, "two")], async () => gate.promise)];
  try {
    const response = await api.handle(new Request(`${target.origin}/v1/attachments/images/${hash(png)}`, { method: "PUT", headers: { "content-length": String(MAX_IMAGE_ATTACHMENT_BYTES + 1) } }));
    expect(response?.status).toBe(409); expect(await response?.json()).toMatchObject({ code: "OWNER_MISMATCH" });
  } finally { gate.resolve(); await Promise.all(held); }

  for (const claimedOwner of [undefined, "different-owner"]) {
    const falseOwner = endpoint(() => new Response(png, { headers: { ...(claimedOwner ? { [IMAGE_ATTACHMENT_OWNER_HEADER]: claimedOwner } : {}), "Content-Type": "image/png", "Content-Length": String(png.length), "X-Image-Sha256": hash(png) } }));
    await expect(requestImageAttachment(falseOwner, hash(png))).rejects.toMatchObject({ code: "OWNER_MISMATCH", status: 409 });
    await expect(uploadImageAttachment(falseOwner, hash(png), png)).rejects.toMatchObject({ code: "OWNER_MISMATCH", status: 409 });
  }
});

test("bounded streaming uploads reject a third operation and recover slots after real body deadlines", async () => {
  api = new ImageAttachmentsHttp({ dataDirectory: root, hostId: "owner", readTimeoutMs: 25, getNativeImage: async () => { throw new Error("unused"); } });
  const url = `http://local/v1/attachments/images/${hash(png)}`;
  let cancelled = 0;
  const owned = { [IMAGE_ATTACHMENT_OWNER_HEADER]: "owner" };
  const stalled = () => new Request(url, { method: "PUT", headers: owned, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(png.subarray(0, 10)); }, cancel() { cancelled++; } }) });
  const first = api.handle(stalled()), second = api.handle(stalled());
  const third = await api.handle(new Request(url, { method: "PUT", headers: owned, body: png }));
  expect(third?.status).toBe(429);
  expect(await third?.json()).toMatchObject({ code: "IMAGE_TRANSFER_BUSY" });
  const timedOut = await Promise.all([first, second]);
  expect(timedOut.map(response => response?.status)).toEqual([408, 408]);
  expect(cancelled).toBe(2);
  expect((await api.handle(new Request(url, { method: "PUT", headers: owned, body: png })))?.status).toBe(200);
  for (const request of [
    new Request(url, { method: "PUT", body: png, headers: { ...owned, "content-length": String(MAX_IMAGE_ATTACHMENT_BYTES + 1) } }),
    new Request(url, { method: "PUT", headers: owned, body: new Uint8Array(MAX_IMAGE_ATTACHMENT_BYTES + 1) }),
  ]) expect((await api.handle(request))?.status).toBe(413);
  expect((await api.handle(new Request(url, { method: "PUT", body: png, headers: { ...owned, "content-encoding": "gzip" } })))?.status).toBe(415);
  expect((await api.handle(new Request(url, { method: "PUT", body: png, headers: { ...owned, "content-length": String(png.length + 1) } })))?.status).toBe(400);
});

test("binary downloads validate hashes and bounds; scoped native routes never request client paths", async () => {
  const calls: unknown[] = [];
  api = new ImageAttachmentsHttp({ dataDirectory: root, hostId: "owner", getNativeImage: async (...identity) => {
    calls.push(identity); return { data: png, mimeType: "image/png", sha256: hash(png), bytes: png.length };
  } });
  const target = serving();
  expect((await requestTranscriptImage(target, "session/opaque", "entry#opaque", 2)).data).toEqual(Uint8Array.from(png));
  expect(calls).toEqual([["session/opaque", "entry#opaque", 2]]);
  await expect(requestTranscriptImage(target, "s", "entry", -1)).rejects.toThrow();
  expect(calls).toHaveLength(1);
  for (const override of [{ "X-Image-Sha256": "0".repeat(64) }, { "Content-Type": "text/html" }]) {
    const bad = endpoint(() => new Response(png, { headers: { [IMAGE_ATTACHMENT_OWNER_HEADER]: "owner", "Content-Type": "image/png", "Content-Length": String(png.length), "X-Image-Sha256": hash(png), ...override } }));
    await expect(requestImageAttachment(bad, hash(png))).rejects.toThrow();
  }
  const corrupt = endpoint(() => new Response(Buffer.alloc(png.length), { headers: { [IMAGE_ATTACHMENT_OWNER_HEADER]: "owner", "Content-Type": "image/png", "Content-Length": String(png.length), "X-Image-Sha256": hash(png) } }));
  await expect(requestImageAttachment(corrupt, hash(png))).rejects.toThrow("digest");
  const redirect = endpoint(() => Response.redirect(`${target.origin}/v1/attachments/capabilities`));
  await expect(requestImageAttachment(redirect, hash(png))).rejects.toThrow();

  // Bun.serve corrects Content-Length to the supplied body's size. A raw HTTP
  // peer is necessary to actually deliver a dishonest oversized declaration.
  const peers = new Set<Socket>();
  const raw = createServer(socket => {
    peers.add(socket); socket.once("close", () => peers.delete(socket));
    socket.once("data", () => {
      socket.write(`HTTP/1.1 200 OK\r\n${IMAGE_ATTACHMENT_OWNER_HEADER}: owner\r\nContent-Type: image/png\r\nContent-Length: ${MAX_IMAGE_ATTACHMENT_BYTES + 1}\r\nX-Image-Sha256: ${hash(png)}\r\nConnection: close\r\n\r\n`);
      socket.write(Buffer.alloc(1));
    });
  });
  raw.listen(0, "127.0.0.1"); await once(raw, "listening");
  try {
    const address = raw.address();
    if (!address || typeof address === "string") throw new Error("Missing isolated HTTP listener");
    await expect(requestImageAttachment({ ...target, origin: `http://127.0.0.1:${address.port}` }, hash(png))).rejects.toThrow("headers");
  } finally {
    for (const socket of peers) socket.destroy();
    await new Promise<void>(resolve => raw.close(() => resolve()));
  }
});
