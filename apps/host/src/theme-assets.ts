import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ThemeAsset } from "../../../packages/shared/src/theme";
import type { PreferencePeer } from "./preferences-sync";

const MAX_BYTES = 20 * 1024 * 1024;
export function parseThemeAssetId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("A theme image requires a SHA-256 digest.");
  return value;
}
function describe(bytes: Uint8Array): ThemeAsset {
  if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) throw new Error("Theme images must be smaller than 20 MiB.");
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mimeType = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
    : buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255 ? "image/jpeg"
    : buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : undefined;
  if (!mimeType) throw new Error("Theme images must be PNG, JPEG or WebP files.");
  return { sha256: createHash("sha256").update(buffer).digest("hex"), mimeType, bytes: buffer.length };
}
async function boundedBody(response: Response | Request): Promise<Uint8Array> {
  if (!response.body) throw new Error("The image body is missing.");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const item = await reader.read(); if (item.done) break; bytes += item.value.length; if (bytes > MAX_BYTES) throw new Error("Theme images must be smaller than 20 MiB."); chunks.push(item.value); }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}

/** Immutable, content-addressed private images; only the selected digest is fetched from peers. */
export class ThemeAssets {
  readonly directory: string;
  #downloads = new Map<string, Promise<boolean>>();
  #controller = new AbortController();
  constructor(dataDirectory: string) { this.directory = join(dataDirectory, "theme-assets"); }
  async get(id: string): Promise<{ asset: ThemeAsset; bytes: Uint8Array } | null> {
    const path = join(this.directory, parseThemeAssetId(id));
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > MAX_BYTES) throw new Error("The stored theme image is invalid.");
      const bytes = await readFile(path); const asset = describe(bytes);
      if (asset.sha256 !== id) throw new Error("The stored theme image failed its checksum.");
      return { asset, bytes };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async put(bytes: Uint8Array, expectedId?: string): Promise<ThemeAsset> {
    const asset = describe(bytes);
    if (expectedId && parseThemeAssetId(expectedId) !== asset.sha256) throw new Error("The theme image failed its transfer checksum.");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, asset.sha256); const temporary = join(this.directory, `.image-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes); await file.sync(); await file.close(); await rename(temporary, path);
      const directory = await open(this.directory, "r"); try { await directory.sync(); } finally { await directory.close(); }
    } finally { await file.close(); await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
    return asset;
  }
  sync(id: string, peers: PreferencePeer[]): Promise<boolean> {
    parseThemeAssetId(id);
    const current = this.#downloads.get(id); if (current) return current;
    if (this.#controller.signal.aborted || this.#downloads.size >= 4) return Promise.resolve(false);
    const pending = (async () => {
      if (await this.get(id).catch(() => null)) return false;
      for (const peer of peers) {
        if (this.#controller.signal.aborted) return false;
        try {
          const response = await fetch(`${peer.origin}/v1/theme/assets/${id}`, {
            headers: peer.token ? { Authorization: `Bearer ${peer.token}` } : {}, redirect: "error",
            signal: AbortSignal.any([this.#controller.signal, AbortSignal.timeout(10_000)]),
          });
          if (!response.ok) { await response.body?.cancel(); continue; }
          await this.put(await boundedBody(response), id); return true;
        } catch { /* Try the next authenticated app host; missing assets remain explicit in the desktop. */ }
      }
      return false;
    })().finally(() => this.#downloads.delete(id));
    this.#downloads.set(id, pending); return pending;
  }
  async handle(request: Request): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (path === "/v1/theme/assets" && request.method === "POST") return Response.json(await this.put(await boundedBody(request)), { headers: { "Cache-Control": "no-store" } });
    const match = /^\/v1\/theme\/assets\/([^/]+)$/.exec(path);
    if (!match || request.method !== "GET") return null;
    const value = await this.get(match[1]!);
    return value ? new Response(new Uint8Array(value.bytes), { headers: { "Content-Type": value.asset.mimeType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } })
      : Response.json({ error: "This image has not reached this host yet." }, { status: 404 });
  }
  async dispose(): Promise<void> { this.#controller.abort(); await Promise.allSettled(this.#downloads.values()); }
}
