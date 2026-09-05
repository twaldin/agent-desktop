import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { fileEvidence, sha256, sourcePath } from "../upstream-artifacts";
import type { ExtractionManifest, Member } from "./asar-extract";

export const FEATURE_MARKERS: Record<string, RegExp> = {
  menus: /context-menu|dropdown-menu|menubar|ContextMenu|DropdownMenu|MenuItem|menuitem/g,
  spinners: /spinner|Spinner|animate-spin|loading-indicator|progressbar/g,
  diff: /diffs-container|DiffEditor|DiffViewer|diff-view|diff-panel|@pierre\/diffs|shiki/g,
  browser: /browser-panel|browser-page|BrowserPanel|BrowserView|webContentsView|WebContentsView|browser-tab/g,
  panels: /ResizablePanel|PanelGroup|panel-layout|panel-group|panel-size|side-panel|bottom-panel|dock-position/g,
  terminal: /xterm|TerminalPanel|terminal-panel|terminal-tab|terminal-resize|terminalId/g,
  hover: /hover-card|HoverCard|Tooltip|tooltip|hover:|data-\[state=open\]/g,
  composerImages: /image-attachment|image-thumbnail|image-attachment-thumbnail|attachment-image|ImageAttachment|ImageThumbnail|object-cover|object-contain/g,
  animations: /@keyframes|animation-duration|transition-duration|prefers-reduced-motion|AnimatePresence/g,
  notices: /third-party-notices|open-source-licenses|@pierre\/diffs|@xterm\/xterm/g,
};
type Ref = { path: string; sha256: string; byteOffset: number; byteLength: number };
const ref = (member: Member, offset: number, length: number): Ref => ({ path: member.path, sha256: member.sha256!, byteOffset: offset, byteLength: length });
const textExtension = /\.(?:[cm]?js|jsx|tsx?|css|html?|json|map|svg|md|txt)$/i;
const jsExtension = /\.(?:[cm]?js|jsx|tsx?)$/i;
const maxMapBytes = 40 * 1024 * 1024;
export function resolveReference(from: string, specifier: string, members: Set<string>, relativeByDefault = false): { status: string; path?: string } {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(specifier)) return { status: "external-url-not-fetched" };
  if (specifier.includes("\\") || specifier.includes("\0")) return { status: "unresolved-escaped-or-unsafe" };
  const clean = specifier.split(/[?#]/, 1)[0]!;
  const candidate = clean.startsWith(".") || relativeByDefault && !clean.startsWith("/") ? posix.normalize(posix.join(posix.dirname(from), clean)) : clean.startsWith("/") && from.startsWith("webview/") ? `webview${clean}` : undefined;
  if (!candidate) return { status: "bare-or-runtime-reference" };
  if (candidate.startsWith("../") || candidate.startsWith("/")) return { status: "outside-archive-not-read" };
  return { status: members.has(candidate) ? "declared-member" : "missing-from-archive", path: candidate };
}
export function sourceMapCandidates(bytes: Buffer): Array<{ value: string; offset: number; bytes: number; kind: string }> {
  const latin = bytes.toString("latin1"), result: Array<{ value: string; offset: number; bytes: number; kind: string }> = [];
  // Comment-shaped lexical candidates, not a claim that each occurrence is an active directive.
  const pattern = /(?:\/\/[#@][ \t]*|\/\*[#@][ \t]*)(sourceMappingURL|sourceURL)[ \t]*=[ \t]*([^\s*]+)/g;
  for (const match of latin.matchAll(pattern)) result.push({ kind: match[1]!, value: match[2]!, offset: match.index!, bytes: match[0].length });
  return result;
}
export function decodeInlineMap(value: string): Buffer {
  if (!/^data:application\/json(?:;charset=[\w-]+)?(?:;base64)?,/i.test(value)) throw new Error("Unsupported inline source-map MIME / encoding");
  const comma = value.indexOf(","), body = value.slice(comma + 1);
  if (body.length > maxMapBytes * 4 / 3 + 16) throw new Error("Inline source map exceeds 40 MiB bound");
  if (/;base64$/i.test(value.slice(0, comma)) && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body)) throw new Error("Malformed base64 source map");
  const bytes = /;base64$/i.test(value.slice(0, comma)) ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body));
  if (bytes.length > maxMapBytes) throw new Error("Decoded source map exceeds 40 MiB bound");
  return bytes;
}
export function inspectMap(bytes: Buffer): { sections: number; sources: number; sourcesContent: number; names: number; mappingsBytes: number; recovered: Array<{ name: string; content: string; sha256: string }>; externalSections: unknown[] } {
  if (bytes.length > maxMapBytes) throw new Error("Source map exceeds 40 MiB bound");
  const result = { sections: 0, sources: 0, sourcesContent: 0, names: 0, mappingsBytes: 0, recovered: [] as Array<{ name: string; content: string; sha256: string }>, externalSections: [] as unknown[] };
  function visit(map: any, depth: number) {
    if (depth > 32 || !map || typeof map !== "object" || map.version !== 3) throw new Error("Invalid / over-nested v3 source map");
    if (Array.isArray(map.sections)) for (const section of map.sections) {
      result.sections++;
      if (section.map) visit(section.map, depth + 1); else result.externalSections.push(section.url ?? null);
    }
    if (Array.isArray(map.sources)) {
      result.sources += map.sources.length;
      for (let i = 0; i < map.sources.length; i++) if (typeof map.sourcesContent?.[i] === "string") {
        const content = map.sourcesContent[i]; result.sourcesContent++;
        result.recovered.push({ name: `${typeof map.sourceRoot === "string" ? map.sourceRoot : ""}${String(map.sources[i])}`, content, sha256: sha256(Buffer.from(content)) });
      }
    }
    result.names += Array.isArray(map.names) ? map.names.length : 0;
    result.mappingsBytes += typeof map.mappings === "string" ? Buffer.byteLength(map.mappings) : 0;
  }
  visit(JSON.parse(bytes.toString("utf8")), 0);
  return result;
}
export async function indexPackage(output: string, manifest: ExtractionManifest) {
  const tree = resolve(output, "tree"), memberPaths = new Set(manifest.members.map(m => m.path));
  const sources: any[] = [], modules: any[] = [], edges: any[] = [], maps: any[] = [], features: any[] = [], packages: any[] = [];
  const featureCounts = Object.fromEntries(Object.keys(FEATURE_MARKERS).map(name => [name, { matches: 0, files: 0 }]));
  const transpilers = Object.fromEntries((["js", "jsx", "ts", "tsx"] as const).map(loader => [loader, new Bun.Transpiler({ loader })]));
  const mapDigests = new Set<string>();
  async function mapRecord(bytes: Buffer, source: Ref, kind: string) {
    const digest = sha256(bytes);
    let inspection: ReturnType<typeof inspectMap>;
    try {
      inspection = inspectMap(bytes);
    } catch (error) { maps.push({ kind, source, sha256: digest, status: "unparseable", error: String(error) }); return; }
    const { recovered, ...summary } = inspection;
    const recoveredIndex: any[] = [];
    for (const item of recovered) {
      const target = `recovered-sources/${item.sha256}.txt`;
      // Authored source names are metadata only, never used as output paths.
      await mkdir(resolve(output, "recovered-sources"), { recursive: true, mode: 0o700 });
      try { await writeFile(resolve(output, target), item.content, { mode: 0o600, flag: "wx" }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || sha256(await readFile(resolve(output, target))) !== item.sha256) throw error; }
      recoveredIndex.push({ name: item.name, sha256: item.sha256, path: target });
    }
    maps.push({ kind, source, sha256: digest, status: "parsed-v3", duplicatePayload: mapDigests.has(digest), ...summary, recovered: recoveredIndex });
    mapDigests.add(digest);
  }
  for (const member of manifest.members) {
    if (member.status !== "extracted" || !textExtension.test(member.path)) continue;
    const bytes = await readFile(sourcePath(tree, member.path));
    if (sha256(bytes) !== member.sha256) throw new Error(`Index source differs from verified extraction: ${member.path}`);
    const latin = bytes.toString("latin1"), text = bytes.toString("utf8");
    const lines = text.split("\n");
    sources.push({ ...ref(member, 0, bytes.length), lines: lines.length, maxLineBytes: lines.reduce((max, line) => Math.max(max, Buffer.byteLength(line)), 0), surface: member.surface });
    if (jsExtension.test(member.path)) {
      try {
        const loader = member.path.endsWith(".tsx") ? "tsx" : member.path.endsWith(".ts") ? "ts" : member.path.endsWith(".jsx") ? "jsx" : "js";
        const scan = transpilers[loader]!.scan(bytes);
        modules.push({ source: ref(member, 0, bytes.length), parser: "Bun.Transpiler.scan", loader, exports: scan.exports, imports: scan.imports.length, status: "parsed" });
        for (const entry of scan.imports) {
          const literal = Buffer.from(entry.path).toString("latin1"), offsets: number[] = [];
          let at = -1;
          while ((at = latin.indexOf(literal, at + 1)) !== -1) offsets.push(at);
          edges.push({ source: ref(member, 0, bytes.length), kind: entry.kind, specifier: entry.path, literalByteOffsets: offsets,
            offsetMeaning: "All matching literal bytes; parser does not supply syntax ranges", ...resolveReference(member.path, entry.path, memberPaths) });
        }
      } catch (error) { modules.push({ source: ref(member, 0, bytes.length), status: "parse-failed", error: String(error) }); }
    }
    // Scanner intentionally does not claim computed CommonJS or runtime-generated references are resolved.
    const references = [
      { kind: "lexical-require-candidate", pattern: /\brequire(?:\.resolve)?\s*\(\s*["']([^"'\r\n]+)["']/g },
      { kind: "lexical-asset-candidate", pattern: /["']((?:\.\.?\/|\/|assets\/)[^"'\r\n]+\.(?:js|css|wasm|woff2?|ttf|otf|svg|png|jpe?g|webp|gif|mp4|html)(?:\?[^"'\r\n]*)?)["']/g },
    ];
    for (const { kind, pattern } of references) for (const match of latin.matchAll(pattern)) edges.push({ source: ref(member, match.index!, match[0].length), kind, specifier: match[1], ...resolveReference(member.path, match[1]!, memberPaths) });
    for (const candidate of sourceMapCandidates(bytes)) {
      const source = ref(member, candidate.offset, candidate.bytes);
      if (candidate.kind === "sourceURL") { maps.push({ kind: "sourceURL-debugger-name", source, value: candidate.value }); continue; }
      if (candidate.value.startsWith("data:")) {
        let decoded: Buffer;
        try { decoded = decodeInlineMap(candidate.value); }
        catch (error) { maps.push({ kind: "inline-comment-candidate", source, status: "unparseable", error: String(error) }); continue; }
        await mapRecord(decoded, source, "inline-comment-candidate");
      } else maps.push({ kind: "external-comment-candidate", source, value: candidate.value, ...resolveReference(member.path, candidate.value, memberPaths, true) });
    }
    if (member.path.endsWith(".map")) await mapRecord(bytes, ref(member, 0, bytes.length), "standalone-member");
    for (const [category, pattern] of Object.entries(FEATURE_MARKERS)) {
      let fileMatches = 0;
      for (const match of latin.matchAll(pattern)) {
        const start = Math.max(0, match.index! - 70), end = Math.min(bytes.length, match.index! + match[0].length + 100);
        features.push({ category, source: ref(member, match.index!, match[0].length), matched: match[0], contextByteOffset: start,
          context: bytes.subarray(start, end).toString("utf8") }); fileMatches++;
      }
      featureCounts[category]!.matches += fileMatches;
      if (fileMatches) featureCounts[category]!.files++;
    }
    if (posix.basename(member.path) === "package.json") {
      try {
        const value = JSON.parse(text);
        packages.push({ source: ref(member, 0, bytes.length), name: value.name ?? null, version: value.version ?? null, main: value.main ?? null,
          type: value.type ?? null, dependencies: value.dependencies ?? {}, optionalDependencies: value.optionalDependencies ?? {}, scripts: value.scripts ?? {} });
      } catch (error) { packages.push({ source: ref(member, 0, bytes.length), error: String(error) }); }
    }
  }
  const countBy = (values: any[], key: string) => values.reduce((result, value) => { result[value[key] ?? "unspecified"] = (result[value[key] ?? "unspecified"] ?? 0) + 1; return result; }, {} as Record<string, number>);
  const index = {
    version: 1, archiveSha256: manifest.archive.sha256, memberSetSha256: manifest.memberSetSha256,
    parser: { name: "Bun.Transpiler.scan", version: Bun.version, noImportsResolvedOrExecuted: true },
    attribution: "All offsets are zero-based UTF-8 bytes of exact extracted member. End = byteOffset + byteLength. Feature and comment hits are lexical research leads, not complete syntax or behavior inventories.",
    counts: { textSources: sources.length, moduleStatuses: countBy(modules, "status"), edgeKinds: countBy(edges, "kind"), edgeStatuses: countBy(edges, "status"), mapStatuses: countBy(maps, "status"), packages: packages.length, features: featureCounts },
    sources, modules, edges, maps, packages,
    specialMembers: manifest.members.filter(m => /(?:license|notice|\.node$|\.wasm$|\.woff2?$|\.ttf$|\.otf$|index\.html$)/i.test(m.path)),
    featureIndex: "features.jsonl",
  };
  await writeFile(join(output, "features.jsonl"), features.map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600, flag: "wx" });
  await writeFile(join(output, "index.json"), JSON.stringify(index, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await writeFile(join(output, "tool-provenance.json"), JSON.stringify({ runtime: { name: "bun", version: Bun.version }, scripts: await Promise.all(["asar-extract.ts", "static-index.ts", "extract.ts"].map(name => fileEvidence(join(import.meta.dirname, name)))), parserTypes: "node_modules/.bun/bun-types@1.3.14/node_modules/bun-types/bun.d.ts:2514" }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return index.counts;
}
