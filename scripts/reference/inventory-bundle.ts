import { lstat, mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileEvidence, sha256 } from "../upstream-artifacts";
import { PINNED_ASAR_SHA256 } from "./asar-extract";

/** Optional installed-package supplement. Reads bytes and metadata only; never runs the app or follows bundle symlinks. */
export async function inventoryBundle(bundle: string, output: string, expectedSha256: string) {
  const archive = join(bundle, "Contents/Resources/app.asar"), before = await fileEvidence(archive);
  if (before.sha256 !== expectedSha256) throw new Error("Installed ASAR does not match the preserved reference; supplement is not attributable to this pin");
  const entries: any[] = [];
  async function visit(directory: string, relative: string) {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const path = relative ? `${relative}/${name}` : name, absolute = join(directory, name), info = await lstat(absolute);
      if (info.isSymbolicLink()) { entries.push({ path, kind: "symlink", target: await readlink(absolute), status: "not-followed" }); continue; }
      if (info.isDirectory()) { await visit(absolute, path); continue; }
      if (!info.isFile()) { entries.push({ path, kind: "special", status: "not-read" }); continue; }
      const entry: any = { path, kind: "file", bytes: info.size, mode: info.mode & 0o777, sha256: null, status: "size-only" };
      const unpacked = path.startsWith("Contents/Resources/app.asar.unpacked/");
      const metadata = /(?:^Contents\/Info\.plist$|^Contents\/PkgInfo$|^Contents\/Resources\/[^/]+\.(?:txt|sdef|json|ini|html|plist)$|\/Resources\/Info\.plist$)/i.test(path);
      const selected = unpacked || metadata || path.startsWith("Contents/Resources/native/") || path.startsWith("Contents/Resources/plugins/") || path.startsWith("Contents/MacOS/") || /(?:\.node|\.dylib|\.asar|\.map|\.pdb|\.debug)$|\.dSYM\/|\/(?:Codex Framework|Electron Framework|Sparkle)$/i.test(path);
      if (selected) {
        const evidence = path === "Contents/Resources/app.asar" ? before : await fileEvidence(absolute);
        entry.sha256 = evidence.sha256; entry.status = "hashed";
      }
      entry.debugOrMapCandidate = /\.map$|\.dSYM\/|\.pdb$|\.debug$/i.test(path);
      entry.copyMetadata = metadata && info.size <= 4 * 1024 * 1024;
      entries.push(entry);
    }
  }
  await visit(resolve(bundle), "");
  if ((await fileEvidence(archive)).sha256 !== before.sha256) throw new Error("Installed ASAR changed during supplement inventory");
  await mkdir(resolve(output), { mode: 0o700 });
  for (const entry of entries.filter(e => e.copyMetadata)) {
    const bytes = await readFile(join(bundle, entry.path));
    if (sha256(bytes) !== entry.sha256) throw new Error(`Metadata changed before preservation: ${entry.path}`);
    const target = join(output, "metadata", entry.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
  }
  const manifest = { version: 1, bundle: resolve(bundle), matchingArchive: before,
    scope: "Non-atomic read-only installed-package inventory. All leaf paths and file sizes recorded; selected metadata/native/unpacked/plugins/debug/ASAR payloads hashed. Symlinks not followed; only small text/plist metadata copied. No app code executed.",
    counts: { entries: entries.length, files: entries.filter(e => e.kind === "file").length, symlinks: entries.filter(e => e.kind === "symlink").length, hashed: entries.filter(e => e.status === "hashed").length, copiedMetadata: entries.filter(e => e.copyMetadata).length, debugOrMapCandidates: entries.filter(e => e.debugOrMapCandidate).length }, entries };
  await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return manifest;
}
if (import.meta.main) {
  const args = process.argv.slice(2), options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--bundle", "--output", "--sha256"].includes(args[i]!) || !args[i + 1] || options.has(args[i]!)) throw new Error("Usage: bun scripts/reference/inventory-bundle.ts --bundle /Applications/ChatGPT.app --output fresh-private-directory [--sha256 exact-pin]");
    options.set(args[i]!, args[i + 1]!);
  }
  if (!options.get("--bundle") || !options.get("--output")) throw new Error("Explicit --bundle and --output required");
  const result = await inventoryBundle(options.get("--bundle")!, options.get("--output")!, options.get("--sha256") ?? PINNED_ASAR_SHA256);
  console.log(JSON.stringify({ output: resolve(options.get("--output")!), archive: result.matchingArchive.sha256, counts: result.counts }, null, 2));
}
