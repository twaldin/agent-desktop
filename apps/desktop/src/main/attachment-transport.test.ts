import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IMAGE_ATTACHMENT_OWNER_HEADER } from "@agent-desktop/shared";
import { ImageAttachmentsHttp } from "../../../host/src/attachment-http";
import { requestImageAttachment } from "./attachment-transport";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+iSgAAAABJRU5ErkJggg==", "base64");
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "agent-image-download-"));
  const images: Array<{ sha256: string; bytes: number }> = [];
  const api = new ImageAttachmentsHttp({ dataDirectory: directory, hostId: "owner", getNativeImage: async (sessionId, entryId, index) => {
    expect(sessionId).toBe("fixture-session"); expect(index).toBe(1);
    const image = await api.store.readValidatedImage(images[Number(entryId)]!.sha256);
    return { data: image.bytes, ...image.metadata };
  } });
  for (let index = 1; index <= 4; index++) {
    const bytes = await new Bun.Image(png).resize(index, 1).png().bytes();
    images.push(await api.store.putImage(hash(bytes), bytes));
  }
  const statuses: number[] = [];
  let readBarrier: { arrived: number; release: ReturnType<typeof Promise.withResolvers<void>> } | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.headers.get("authorization") !== "Bearer isolated-download-fixture") return new Response(null, { status: 401 });
    const barrier = readBarrier;
    if (barrier) { if (++barrier.arrived === 4) { readBarrier = undefined; barrier.release.resolve(); } await barrier.release.promise; }
    const response = await api.handle(request) ?? new Response(null, { status: 404 }); statuses.push(response.status); return response;
  } });
  return { api, images, statuses, endpoint: { origin: server.url.origin, hostId: "owner", token: "isolated-download-fixture" },
    synchronizeIndependentClients() { readBarrier = { arrived: 0, release: Promise.withResolvers<void>() }; },
    async close() { readBarrier?.release.resolve(); server.stop(true); await rm(directory, { recursive: true, force: true }); } };
}

test("four uncached images queue within the host bound and two independent desktop processes retry native/original read contention", async () => {
  const f = await fixture();
  try {
    const values = await Promise.all(f.images.map(image => requestImageAttachment(f.endpoint, image.sha256)));
    expect(values.map(image => image.sha256)).toEqual(f.images.map(image => image.sha256));
    expect(f.statuses).toEqual([200, 200, 200, 200]);
    f.statuses.length = 0;
    f.synchronizeIndependentClients();
    const entry = fileURLToPath(new URL("./fixtures/image-download-client.ts", import.meta.url));
    const children = [0, 1].map(() => Bun.spawn([process.execPath, entry, f.endpoint.origin, JSON.stringify(f.images)], { stdout: "pipe", stderr: "pipe" }));
    try {
      const results = await Promise.all(children.map(async child => ({ exit: await child.exited, output: await new Response(child.stdout).text(), errors: await new Response(child.stderr).text() })));
      for (const result of results) { expect(result.errors).toBe(""); expect(result.exit).toBe(0); expect(JSON.parse(result.output)).toEqual(f.images.map(({ sha256, bytes }) => ({ sha256, bytes }))); }
      expect(f.statuses.filter(status => status === 200)).toHaveLength(8);
      expect(f.statuses).toContain(429);
    } finally { for (const child of children) if (child.exitCode === null) child.kill(); }
  } finally { await f.close(); }
});

test("downloads wait through two real streaming upload slots without replaying uploads", async () => {
  const f = await fixture();
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const uploads = [0, 1].map(() => f.api.handle(new Request(`${f.endpoint.origin}/v1/attachments/images/${hash(png)}`, { method: "PUT", headers: { [IMAGE_ATTACHMENT_OWNER_HEADER]: "owner" },
    body: new ReadableStream<Uint8Array>({ start(controller) { controllers.push(controller); } }) })));
  try {
    const downloads = Promise.all(f.images.map(image => requestImageAttachment(f.endpoint, image.sha256)));
    const deadline = Date.now() + 1000;
    while (!f.statuses.includes(429) && Date.now() < deadline) await Bun.sleep(5);
    expect(f.statuses).toContain(429);
    for (const controller of controllers) { controller.enqueue(png); controller.close(); }
    expect((await Promise.all(uploads)).map(response => response?.status)).toEqual([200, 200]);
    expect((await downloads).map(image => image.sha256)).toEqual(f.images.map(image => image.sha256));
  } finally { for (const controller of controllers) { try { controller.close(); } catch {} } await Promise.allSettled(uploads); await f.close(); }
});

test("only typed host contention retries; authentication, owner, missing, generic rate limits and server errors fail once", async () => {
  for (const [status, code] of [[401, undefined], [409, "OWNER_MISMATCH"], [404, "IMAGE_NOT_FOUND"], [429, undefined], [429, "OTHER_LIMIT"], [500, "IMAGE_TRANSFER_BUSY"]] as const) {
    let calls = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return Response.json({ code, error: "Expected fixture rejection" }, { status }); } });
    try { await expect(requestImageAttachment({ origin: server.url.origin, hostId: "owner" }, hash(png))).rejects.toMatchObject({ status }); expect(calls).toBe(1); }
    finally { server.stop(true); }
  }
});

test("the image queue has two active identities and at most 32 waiting; overflow stays visible and later reads recover", async () => {
  const gate = Promise.withResolvers<void>();
  let active = 0, peak = 0, calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    calls++; peak = Math.max(peak, ++active); await gate.promise; active--;
    return new Response(png, { headers: { [IMAGE_ATTACHMENT_OWNER_HEADER]: "owner", "Content-Type": "image/png", "Content-Length": String(png.length), "X-Image-Sha256": hash(png) } });
  } });
  const endpoint = { origin: server.url.origin, hostId: "owner" };
  try {
    const pending = Array.from({ length: 40 }, () => requestImageAttachment(endpoint, hash(png)).then(() => ({ ok: true }), error => ({ ok: false, message: error.message })));
    const deadline = Date.now() + 1000;
    while (calls < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(calls).toBe(2); gate.resolve();
    const results = await Promise.all(pending);
    expect(results.filter(result => result.ok)).toHaveLength(34);
    expect(results.filter(result => !result.ok)).toEqual(Array.from({ length: 6 }, () => ({ ok: false, message: "Too many image previews are waiting on this host. Retry this image after other previews load." })));
    expect(peak).toBe(2);
    expect((await requestImageAttachment(endpoint, hash(png))).sha256).toBe(hash(png));
  } finally { gate.resolve(); server.stop(true); }
});
