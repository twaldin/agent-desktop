import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { WorkspaceQuery, WorkspaceQueryResult } from "@agent-desktop/shared";
import { WorkspaceImageGrants } from "./workspace-image";

function source(bytes: Uint8Array, behavior?: { changed?: boolean; hold?: Promise<void> }) {
  const revision = createHash("sha256").update(bytes).digest("hex"), queries: WorkspaceQuery[] = [];
  let infos = 0;
  return { queries, create: (_signal: AbortSignal) => ({ local: false, async query(query: WorkspaceQuery): Promise<WorkspaceQueryResult> {
    queries.push(query);
    if (query.type === "file.copy-info") {
      infos++;
      return { type: query.type, path: query.path, absolutePath: "/remote/work/image.png", size: bytes.length,
        revision: behavior?.changed && infos > 1 ? "f".repeat(64) : revision };
    }
    if (query.type === "file.copy-chunk") {
      await behavior?.hold;
      const data = bytes.slice(query.offset, Math.min(bytes.length, query.offset + 1024 * 1024));
      return { type: query.type, path: query.path, size: bytes.length, revision, offset: query.offset, dataBase64: Buffer.from(data).toString("base64") };
    }
    throw new Error("Unexpected fixture query");
  } }), revision };
}

describe("sender-scoped workspace image streams", () => {
  test("streams large owner-fenced images in sequential chunks and rechecks final metadata", async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 17); for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
    const fixture = source(bytes), grants = new WorkspaceImageGrants();
    const grant = grants.acquire({ senderId: 7, target: { projectId: "project" }, path: "assets/image.PNG", hostId: "host", source: fixture.create });
    expect(grant.url).toBe(`agent-workspace-image://image/${grant.id}`);
    const response = await grants.response(grant.url);
    expect(response.headers.get("content-type")).toBe("image/png"); expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(fixture.queries.map(query => query.type)).toEqual(["file.copy-info", "file.copy-chunk", "file.copy-chunk", "file.copy-chunk", "file.copy-info"]);
    expect(fixture.queries.filter((query): query is Extract<WorkspaceQuery, {type:"file.copy-chunk"}> => query.type === "file.copy-chunk").map(query => query.offset))
      .toEqual([0, 1024 * 1024, 2 * 1024 * 1024]);
  });

  test("rejects changed final metadata instead of completing a mixed image", async () => {
    const fixture = source(Buffer.from("image"), {changed: true}), grants = new WorkspaceImageGrants();
    const grant = grants.acquire({ senderId: 1, target: { sessionId: "session" }, path: "image.webp", hostId: "host", source: fixture.create });
    const response = await grants.response(grant.url);
    const reader = response.body!.getReader();
    // The final identity check precedes the final enqueue, so Content-Length
    // consumers cannot accept bytes before discovering the changed source.
    await expect(reader.read()).rejects.toThrow("changed while it was loading");
  });

  test("only the original sender releases a grant and release cancels an active request", async () => {
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    const fixture = source(Buffer.alloc(10), {hold}), grants = new WorkspaceImageGrants();
    const grant = grants.acquire({ senderId: 9, target: { projectId: "project" }, path: "image.gif", hostId: "host", source: fixture.create });
    expect(grants.release(grant.id, 10)).toBe(false);
    expect((await grants.response(grant.url)).status).toBe(200);
    const response = await grants.response(grant.url), reading = response.arrayBuffer();
    await Promise.resolve(); expect(grants.release(grant.id, 9)).toBe(true); release();
    await expect(reading).rejects.toThrow();
    expect((await grants.response(grant.url)).status).toBe(404);
    const sameSender = grants.acquire({ senderId: 9, target: { projectId: "project" }, path: "again.gif", hostId: "host", source: fixture.create });
    const otherSender = grants.acquire({ senderId: 10, target: { projectId: "project" }, path: "other.gif", hostId: "host", source: fixture.create });
    grants.releaseSender(9);
    expect((await grants.response(sameSender.url)).status).toBe(404);
    expect((await grants.response(otherSender.url)).status).toBe(200);
  });

  test("accepts relative extensionless images with a safe fallback MIME and only opaque exact URLs", async () => {
    const grants = new WorkspaceImageGrants(), fixture = source(Buffer.alloc(0));
    for (const path of ["../image.png", "/tmp/image.png", "bad\\image.png", "bad\0image.png"]) {
      expect(() => grants.acquire({ senderId: 1, target: { projectId: "project" }, path, hostId: "host", source: fixture.create })).toThrow();
    }
    const grant = grants.acquire({ senderId: 1, target: { projectId: "project" }, path: "image", hostId: "host", source: fixture.create });
    for (const url of [`${grant.url}?path=/tmp/secret`, `${grant.url}#fragment`, grant.url.replace("//image/", "//user@image/"), grant.url.replace("//image/", "//image:42/"), `${grant.url}/extra`]) {
      expect((await grants.response(url)).status).toBe(404);
    }
    const response = await grants.response(grant.url); expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    const svg = grants.acquire({ senderId: 1, target: { projectId: "project" }, path: "empty.svg", hostId: "host", source: fixture.create });
    expect((await grants.response(svg.url)).headers.get("content-type")).toBe("image/svg+xml");
  });

  test("cleans up when source creation fails and honors an already aborted request", async () => {
    const grants = new WorkspaceImageGrants();
    const broken = grants.acquire({ senderId: 3, target: { projectId: "project" }, path: "image.png", hostId: "host", source: () => { throw new Error("source failed"); } });
    await expect(grants.response(broken.url)).rejects.toThrow("source failed");
    expect(grants.release(broken.id, 3)).toBe(true);

    let queried = false;
    const aborted = grants.acquire({ senderId: 4, target: { projectId: "project" }, path: "image.png", hostId: "host", source: signal => ({ local: false, async query() {
      queried = true; signal.throwIfAborted(); throw new Error("unreachable");
    } }) });
    const controller = new AbortController(); controller.abort(new Error("request canceled"));
    await expect(grants.response(aborted.url, controller.signal)).rejects.toThrow("request canceled");
    expect(queried).toBe(true); expect(grants.release(aborted.id, 4)).toBe(true);
  });
});
