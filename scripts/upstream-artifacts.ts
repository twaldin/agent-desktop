import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { object, string, type Evidence, type InventoryRow } from "./upstream-inventory";

export interface JsonArtifact { value: any; evidence: Evidence }
export function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function same(a: { size: number; mtimeMs: number; ino: number }, b: { size: number; mtimeMs: number; ino: number }): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}
export async function fileEvidence(path: string): Promise<Evidence> {
  const absolute = resolve(path), file = await open(absolute, "r");
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error(`Not a regular file: ${absolute}`);
    const hash = createHash("sha256");
    for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes);
    if (!same(before, await file.stat()) || !same(before, await stat(absolute))) throw new Error(`Artifact changed while reading: ${absolute}`);
    return { path: absolute, sha256: hash.digest("hex"), bytes: before.size };
  } finally { await file.close(); }
}
export async function readJson(path: string): Promise<JsonArtifact> {
  const absolute = resolve(path), file = await open(absolute, "r");
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 40 * 1024 * 1024) throw new Error(`JSON artifact must be a regular file no larger than 40 MiB: ${absolute}`);
    const bytes = await file.readFile();
    if (!same(before, await file.stat()) || !same(before, await stat(absolute))) throw new Error(`Artifact changed while reading: ${absolute}`);
    return { value: JSON.parse(bytes.toString("utf8")), evidence: { path: absolute, sha256: sha256(bytes), bytes: bytes.length } };
  } finally { await file.close(); }
}
export async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
export async function metadata(path: string): Promise<JsonArtifact> {
  if (!path.endsWith(".plist")) return readJson(path);
  const evidence = await fileEvidence(path);
  // Only the system plist parser runs. No executable or script from the input is invoked.
  if (process.platform !== "darwin") throw new Error("Info.plist parsing requires macOS; supply a reference-metadata.json artifact instead");
  const proc = Bun.spawn(["/usr/bin/plutil", "-convert", "json", "-o", "-", resolve(path)], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(proc.stdout).text();
  if (await proc.exited !== 0) throw new Error(`Could not parse plist: ${resolve(path)}`);
  if ((await fileEvidence(path)).sha256 !== evidence.sha256) throw new Error(`Metadata changed while parsing: ${resolve(path)}`);
  return { value: JSON.parse(output), evidence };
}
export const CODEX_METADATA_KEYS = ["CFBundleIdentifier", "CFBundleDisplayName", "CFBundleShortVersionString", "CFBundleVersion", "ChromiumBaseVersion", "LSMinimumSystemVersion"] as const;
export function codexMetadataRows(artifact: JsonArtifact): InventoryRow[] {
  const value = object(artifact.value, "Codex metadata");
  if (value.CFBundleIdentifier !== "com.openai.codex") throw new Error("Reference metadata does not identify com.openai.codex");
  for (const key of ["CFBundleShortVersionString", "CFBundleVersion"]) string(value[key], key);
  return CODEX_METADATA_KEYS.map(key => ({ id: key, facets: { value: value[key] ?? null }, source: { ...artifact.evidence, pointer: `/${key}` } }));
}
/** Reads Electron's ASAR header only. Integrity values remain header declarations. */
export async function asarRows(path: string): Promise<InventoryRow[]> {
  const file = await open(path, "r");
  try {
    const before = await file.stat(), prefix = Buffer.alloc(16);
    if ((await file.read(prefix, 0, 16, 0)).bytesRead !== 16) throw new Error("Truncated ASAR header");
    const headerSize = prefix.readUInt32LE(4), jsonSize = prefix.readUInt32LE(12);
    if (prefix.readUInt32LE(0) !== 4 || headerSize < 8 || jsonSize > 32 * 1024 * 1024 || jsonSize > headerSize - 8 || headerSize + 8 > before.size) throw new Error("Invalid ASAR header sizes");
    const bytes = Buffer.alloc(jsonSize);
    if ((await file.read(bytes, 0, jsonSize, 16)).bytesRead !== jsonSize) throw new Error("Truncated ASAR JSON");
    const header = object(JSON.parse(bytes.toString("utf8")), "ASAR header"), rows: InventoryRow[] = [];
    function visit(files: Record<string, any>, prefix: string) {
      for (const [name, raw] of Object.entries(files)) {
        const entry = object(raw, "ASAR entry"), id = prefix + name;
        if (entry.files) visit(object(entry.files, "ASAR files"), `${id}/`);
        else rows.push({ id, facets: { size: entry.size ?? null, unpacked: !!entry.unpacked, link: entry.link ?? null,
          declaredIntegrity: entry.integrity ?? null, executable: !!entry.executable }, source: { path: resolve(path), pointer: `ASAR header: ${id}`, note: "Header declaration; per-member payload and external unpacked files are not verified" } });
      }
    }
    visit(object(header.files, "ASAR files"), "");
    if (!same(before, await stat(path))) throw new Error(`Archive changed while reading header: ${path}`);
    return rows;
  } finally { await file.close(); }
}
export async function packageRoot(repository: string, name: string, from?: string): Promise<string> {
  // Resolve from the REAL installed package directory; resolving from a symlink
  // can accidentally pick up a user's unrelated ancestor node_modules tree.
  if (!from) return realpath(join(repository, "node_modules", name));
  // This is a static inventory, not a module import. Bun's process-wide resolver
  // can return virtual file:file:... paths after native OMP modules have loaded.
  // Walk standard node_modules locations without evaluating exports or hooks.
  let directory = await realpath(from);
  for (;;) {
    if (basename(directory) !== "node_modules") {
      try { return await realpath(join(directory, "node_modules", name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const parent = dirname(directory);
    if (parent === directory) throw Object.assign(new Error(`Installed package ${name} was not found from ${from}`), { code: "MODULE_NOT_FOUND" });
    directory = parent;
  }
}
export function sourcePath(root: string, path: string): string {
  if (path.includes("\\") || path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error(`Invalid inventory source path: ${path}`);
  return join(root, path);
}
