import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { asarRows, fileEvidence, sha256, sourcePath } from "../upstream-artifacts";

export const PINNED_ASAR_SHA256 = "077cc65356aeae34c5d8b4de0b4cc383f6fb137ed1d69a9b3dfe69ffafa058ab";
export interface Member {
  order: number; path: string; surface: string; extension: string;
  status: "extracted" | "external-unpacked" | "link-declaration";
  bytes: number | null; sha256: string | null; dataOffset: number | null; archiveOffset: number | null;
  executableDeclaration: boolean; link: unknown; declaredIntegrity: unknown;
  integrity: "verified-sha256-and-blocks" | "absent" | "not-in-archive";
}
export interface ExtractionManifest {
  version: 1; archive: { sha256: string; bytes: number }; header: { sha256: string; bytes: number; dataOffset: number };
  members: Member[]; counts: Record<string, number>; memberSetSha256: string;
}
const safeName = (name: string) => {
  if (!name || name === "." || name === ".." || /[\0/\\]/.test(name)) throw new Error(`Unsafe ASAR name: ${JSON.stringify(name)}`);
};
const integer = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}`);
  return value;
};
export function surface(path: string): string {
  return path.startsWith("webview/") ? "webview" : path.startsWith(".vite/build/") ? "main-preload" : path.startsWith("node_modules/") ? "dependency" : "package";
}
function verifyIntegrity(bytes: Buffer, value: any, path: string): Member["integrity"] {
  if (value == null) return "absent";
  if (value.algorithm !== "SHA256" || !/^[a-f0-9]{64}$/.test(value.hash ?? "") || !Array.isArray(value.blocks)) throw new Error(`Unsupported integrity declaration: ${path}`);
  const blockSize = integer(value.blockSize, "integrity block size");
  if (blockSize === 0 || sha256(bytes) !== value.hash) throw new Error(`Member SHA256 mismatch: ${path}`);
  const blocks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += blockSize) blocks.push(sha256(bytes.subarray(offset, offset + blockSize)));
  // Electron versions can declare the empty file as either zero blocks or one empty block.
  if (!bytes.length && value.blocks.length === 1) blocks.push(sha256(bytes));
  if (JSON.stringify(blocks) !== JSON.stringify(value.blocks)) throw new Error(`Member block integrity mismatch: ${path}`);
  return "verified-sha256-and-blocks";
}

/** Data-only extraction. Does not import members, follow archive links, read unpacked siblings, or preserve executable permissions. */
export async function extractAsar(archive: string, output: string, expectedSha256: string): Promise<ExtractionManifest> {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("An explicit canonical archive SHA256 is required");
  const before = await fileEvidence(archive);
  if (before.sha256 !== expectedSha256) throw new Error("Archive SHA256 differs from expected preserved artifact");
  const rows = await asarRows(archive); // Reuse the maintained size/header validation and inventory traversal.
  const file = await open(archive, "r");
  let created = false;
  try {
    const prefix = Buffer.alloc(16);
    await file.read(prefix, 0, 16, 0);
    const headerBytes = Buffer.alloc(prefix.readUInt32LE(12));
    await file.read(headerBytes, 0, headerBytes.length, 16);
    const dataOffset = prefix.readUInt32LE(4) + 8, header = JSON.parse(headerBytes.toString("utf8"));
    const leaves = new Map<string, any>(), destinations = new Set<string>();
    function visit(files: Record<string, any>, parent: string) {
      for (const [name, entry] of Object.entries(files)) {
        safeName(name);
        const path = parent + name;
        sourcePath(output, path);
        // Reject collisions even on case-insensitive / normalization-insensitive hosts.
        const destination = path.normalize("NFD").toLowerCase();
        if (destinations.has(destination)) throw new Error(`Colliding ASAR destination: ${path}`);
        destinations.add(destination);
        if (entry.files) visit(entry.files, `${path}/`); else leaves.set(path, entry);
      }
    }
    visit(header.files, "");
    if (leaves.size !== rows.length) throw new Error("ASAR traversal mismatch");
    const members: Member[] = rows.map((row, order) => {
      const entry = leaves.get(row.id), status = entry.link != null ? "link-declaration" : entry.unpacked ? "external-unpacked" : "extracted";
      const size = entry.size == null && status === "link-declaration" ? null : integer(entry.size, `member size: ${row.id}`);
      const offset = status !== "extracted" ? null : typeof entry.offset === "string" && /^(0|[1-9][0-9]*)$/.test(entry.offset) ? integer(Number(entry.offset), `member offset: ${row.id}`) : (() => { throw new Error(`Invalid member offset: ${row.id}`); })();
      if (offset != null && (size! > 256 * 1024 * 1024 || offset + size! > before.bytes! - dataOffset)) throw new Error(`Member out of bounds / 256 MiB extraction limit: ${row.id}`);
      return { order, path: row.id, surface: surface(row.id), extension: extname(row.id).toLowerCase(), status, bytes: size, sha256: null,
        dataOffset: offset, archiveOffset: offset == null ? null : dataOffset + offset, executableDeclaration: !!entry.executable,
        link: entry.link ?? null, declaredIntegrity: entry.integrity ?? null, integrity: status === "extracted" ? "absent" : "not-in-archive" };
    });
    const ranges = members.filter(m => m.status === "extracted" && m.bytes).sort((a, b) => a.dataOffset! - b.dataOffset!);
    for (let i = 1; i < ranges.length; i++) if (ranges[i]!.dataOffset! < ranges[i - 1]!.dataOffset! + ranges[i - 1]!.bytes!) throw new Error(`Overlapping ASAR members: ${ranges[i]!.path}`);
    // Fresh root only: never overwrite files or follow pre-existing output symlinks.
    await mkdir(resolve(output), { mode: 0o700 }); created = true;
    await mkdir(resolve(output, "tree"), { mode: 0o700 });
    await writeFile(resolve(output, "header.json"), headerBytes, { mode: 0o600, flag: "wx" });
    for (const member of members) {
      if (member.status !== "extracted") continue;
      const bytes = Buffer.alloc(member.bytes!);
      let read = 0;
      while (read < bytes.length) {
        const result = await file.read(bytes, read, bytes.length - read, member.archiveOffset! + read);
        if (!result.bytesRead) throw new Error(`Truncated member: ${member.path}`);
        read += result.bytesRead;
      }
      member.sha256 = sha256(bytes);
      member.integrity = verifyIntegrity(bytes, member.declaredIntegrity, member.path);
      const target = sourcePath(resolve(output, "tree"), member.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
      if (sha256(await readFile(target)) !== member.sha256) throw new Error(`Extracted readback mismatch: ${member.path}`);
    }
    const after = await fileEvidence(archive);
    if (before.sha256 !== after.sha256 || before.bytes !== after.bytes) throw new Error("Archive changed during extraction");
    const counts: Record<string, number> = {};
    for (const member of members) for (const key of [member.status, `surface:${member.surface}`, `extension:${member.extension || "(none)"}`]) counts[key] = (counts[key] ?? 0) + 1;
    const manifest: ExtractionManifest = { version: 1, archive: { sha256: before.sha256!, bytes: before.bytes! }, header: { sha256: sha256(headerBytes), bytes: headerBytes.length, dataOffset }, members, counts, memberSetSha256: sha256(Buffer.from(JSON.stringify(members))) };
    await writeFile(resolve(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return manifest;
  } catch (error) {
    if (created) await writeFile(resolve(output, "INCOMPLETE.json"), JSON.stringify({ error: String(error) }) + "\n", { flag: "wx", mode: 0o600 });
    throw error;
  } finally { await file.close(); }
}
