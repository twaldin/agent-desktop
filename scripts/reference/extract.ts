import { resolve } from "node:path";
import { extractAsar, PINNED_ASAR_SHA256 } from "./asar-extract";
import { indexPackage } from "./static-index";

if (import.meta.main) {
  const args = process.argv.slice(2), options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--archive", "--output", "--sha256"].includes(args[i]!) || !args[i + 1] || options.has(args[i]!)) throw new Error("Usage: bun scripts/reference/extract.ts [--archive path --sha256 exact-sha] [--output fresh-private-directory]");
    options.set(args[i]!, args[i + 1]!);
  }
  if (options.has("--archive") && !options.has("--sha256")) throw new Error("Explicit archive input requires explicit expected --sha256");
  const archive = resolve(options.get("--archive") ?? ".reference/codex-26.901.41600/app.asar");
  const output = resolve(options.get("--output") ?? ".reference/codex-26.901.41600/full-package-v1");
  const manifest = await extractAsar(archive, output, options.get("--sha256") ?? PINNED_ASAR_SHA256);
  const counts = await indexPackage(output, manifest);
  console.log(JSON.stringify({ output, archive: manifest.archive, memberSetSha256: manifest.memberSetSha256, extraction: manifest.counts, index: counts }, null, 2));
}
