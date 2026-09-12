import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { API, SymbolFlags, type Snapshot } from "typescript/unstable/async";
import type { FileSystem } from "typescript/unstable/fs";
import { getTouchingPropertyName, type Node } from "typescript/unstable/ast";
import { isToken } from "typescript/unstable/ast/is";
import { parseSymbolDefinitionRequest, symbolLanguage, symbolOffset, symbolPosition, type SymbolCapability, type SymbolDefinition, type SymbolDefinitionRequest, type SymbolDefinitionResult } from "../../../../packages/shared/src/symbol-navigation";
import type { WorkspaceService } from "./service";

const digest = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const inside = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
interface CapturedFile { text: string; revision: string; canonical: string }

/** No native-FS fallback: compiler imports/config extends cannot escape the owner.
 * Reads are memoized for one immutable query and rechecked before returning locations.
 * This API cannot execute plugins, emit files, apply edits or share OMP LSP buffers. */
class DefinitionFiles {
  readonly files = new Map<string, CapturedFile>();
  private bytes = 0;
  constructor(readonly root: string, readonly overlays: Map<string, string>) {}
  private owned(path: string): string | null {
    const lexical = resolve(this.root, path);
    if (!inside(this.root, lexical)) return null;
    try { const canonical = realpathSync(lexical); return inside(this.root, canonical) ? canonical : null; }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null; throw error; }
  }
  capture(path: string): CapturedFile | null {
    const lexical = resolve(this.root, path), previous = this.files.get(lexical);
    if (previous) return previous;
    const canonical = this.owned(lexical);
    if (!canonical) return null;
    if (lexical.toLowerCase().endsWith(".json") && this.overlays.has(canonical))
      throw new Error(`Save or close unsaved JSON compiler input ${relative(this.root, lexical)} before looking up definitions.`);
    const file = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(file);
      if (!before.isFile()) return null;
      if (before.size > 2 * 1024 * 1024 || this.files.size >= 1000 || this.bytes + before.size > 32 * 1024 * 1024)
        throw new Error("The compiler snapshot exceeds 1000 files, 32 MiB total or 2 MiB per file. Use a smaller workspace before retrying.");
      const buffer = Buffer.alloc(before.size + 1);
      let count = 0;
      while (count < buffer.length) { const read = readSync(file, buffer, count, buffer.length - count, count); if (!read) break; count += read; }
      const bytes = buffer.subarray(0, count), after = fstatSync(file);
      if (before.size !== bytes.length || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || this.owned(lexical) !== canonical)
        throw new Error("A source file changed during symbol analysis. Retry after refreshing.");
      if (bytes.includes(0)) return null;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const value = { canonical, text, revision: digest(bytes) };
      this.files.set(lexical, value); this.bytes += bytes.length;
      return value;
    } finally { closeSync(file); }
  }
  readonly fs: FileSystem = {
    readFile: path => { const file = this.capture(path); return file ? this.overlays.get(file.canonical) ?? file.text : null; },
    fileExists: path => { const owned = this.owned(path); return owned !== null && statSync(owned).isFile(); },
    directoryExists: path => { const owned = this.owned(path); return owned !== null && statSync(owned).isDirectory(); },
    getAccessibleEntries: path => {
      const owned = this.owned(path);
      if (!owned || !statSync(owned).isDirectory()) return { files: [], directories: [] };
      const entries = readdirSync(owned, { withFileTypes: true });
      if (entries.length > 20_000) throw new Error("The compiler directory exceeds 20000 entries.");
      return { files: entries.filter(entry => entry.isFile()).map(entry => entry.name), directories: entries.filter(entry => entry.isDirectory() && entry.name !== ".git").map(entry => entry.name) };
    },
    realpath: path => this.owned(path) ?? resolve(path),
  };
  async verify(workspace: WorkspaceService): Promise<void> {
    for (const [path, captured] of this.files) {
      const current = await workspace.readText(relative(this.root, path));
      if (current.revision !== captured.revision || await workspace.externalFilePath(relative(this.root, path)) !== captured.canonical)
        throw new Error("A source dependency changed during symbol analysis. Refresh and retry.");
    }
  }
}

export function definitionCapability(path: string, source: SymbolDefinitionRequest["source"]): SymbolCapability {
  const language = symbolLanguage(path);
  return { available: source === "working-tree" && language !== null, provider: "typescript-7.0.2", language,
    reason: source !== "working-tree" ? "Historical Git content has no symbol provider. Open the working file explicitly to look up its symbols."
      : !language ? "Definitions are supported for JavaScript, JSX, TypeScript and TSX source files only."
      : "TypeScript 7.0.2 semantic definitions in this workspace, including unsaved buffers. Imports and configuration outside the owning workspace are unavailable; no language plugins or external standard-library files are loaded." };
}

export async function readSymbolDefinitions(workspace: WorkspaceService, input: SymbolDefinitionRequest): Promise<SymbolDefinitionResult> {
  const request = parseSymbolDefinitionRequest(input), capability = definitionCapability(request.path, request.source);
  if (!capability.available) return { status: "unsupported", capability, message: capability.reason };
  let api: API | undefined, activeSnapshot: Snapshot | undefined, timer: ReturnType<typeof setTimeout> | undefined, timedOut = false;
  try {
    const absolute = await workspace.externalFilePath(request.path), source = await workspace.readText(request.path);
    if (source.kind !== "text") return { status: "unsupported", capability: { ...capability, available: false }, message: "Open an editable UTF-8 text file to navigate definitions." };
    if (source.revision !== request.revision) return { status: "stale", capability, message: "The host source changed. Refresh or resolve the file conflict before retrying." };
    const overlays = new Map<string, string>();
    for (const buffer of request.buffers) {
      const path = await workspace.externalFilePath(buffer.path), content = await workspace.readText(buffer.path);
      if ((!symbolLanguage(buffer.path) && !buffer.path.toLowerCase().endsWith(".json")) || content.kind !== "text")
        return { status: "unsupported", capability, message: `Save or close unsupported dirty buffer ${buffer.path} before looking up definitions.` };
      if (content.revision !== buffer.revision) return { status: "stale", capability, message: `Resolve the changed host version of ${buffer.path} before looking up definitions.` };
      overlays.set(path, buffer.text);
    }
    const files = new DefinitionFiles(workspace.cwd, overlays);
    // Pin the source in the same snapshot as imports and unsaved overlays.
    if (files.capture(absolute)?.revision !== source.revision) return { status: "stale", capability, message: "The source changed before analysis. Refresh and retry." };
    const text = overlays.get(absolute) ?? source.text, offset = symbolOffset(text, request.position);
    api = new API({ cwd: workspace.cwd, fs: files.fs });
    const compiler = api;
    const operation = async (): Promise<SymbolDefinitionResult> => {
      const snapshot = await compiler.updateSnapshot({ openFiles: [absolute] });
      activeSnapshot = snapshot;
      try {
        const project = await snapshot.getDefaultProjectForFile(absolute);
        if (!project) return { status: "unsupported", capability: { ...capability, available: false }, message: "The TypeScript compiler could not load this file. Check the workspace tsconfig/jsconfig and retry." };
        const configurationErrors = await project.program.getConfigFileParsingDiagnostics();
        if (configurationErrors.length) return { status: "unsupported", capability: { ...capability, available: false }, message: "The workspace TypeScript configuration could not be resolved inside its owner boundary. Correct tsconfig/jsconfig errors or move required configuration into this workspace, then retry." };
        const diagnostics = await project.program.getSyntacticDiagnostics(absolute);
        if (diagnostics.length) return { status: "error", capability, message: "This source has syntax errors. Correct them before resolving definitions." };
        const sourceFile = await project.program.getSourceFile(absolute);
        if (!sourceFile) return { status: "error", capability, message: "The compiler did not retain the selected source snapshot. Refresh and retry." };
        const token = getTouchingPropertyName(sourceFile, offset);
        // Trivia can resolve to SourceFile, whose module symbol is a real but
        // unrelated definition. Require an actual parser token at this cursor;
        // touching an identifier's end remains valid for a selected symbol.
        if (!isToken(token) || offset < token.getStart() || offset > token.end)
          return { status: "no-definition", capability, message: "No semantic definition at this cursor. Select a source identifier, not whitespace or a comment." };
        let symbol = await project.checker.getSymbolAtLocation(token);
        if (symbol && symbol.flags & SymbolFlags.Alias) symbol = await project.checker.getAliasedSymbol(symbol);
        if (!symbol || await project.checker.isUnknownSymbol(symbol)) return { status: "no-definition", capability, message: "No semantic definition at this cursor. Select an identifier; unresolved imports may require a workspace-local dependency or valid project configuration." };
        const definitions: SymbolDefinition[] = [], seen = new Set<string>();
        if (symbol.declarations.length > 100) return { status: "error", capability, message: "This symbol has more than 100 declarations. Narrow the selected symbol before retrying." };
        for (const handle of symbol.declarations) {
          const node = await handle.resolve();
          if (!node) continue;
          // NodeHandle.path is TypeScript's case-folded lookup key on macOS,
          // not an OS filename. The resolved SourceFile retains actual casing.
          const path = resolve(node.getSourceFile().fileName);
          if (!inside(workspace.cwd, path)) continue;
          const captured = files.capture(path);
          if (!captured) continue;
          const named = node as Node & { name?: Node };
          const target = named.name ?? node, targetText = overlays.get(captured.canonical) ?? captured.text;
          const start = symbolPosition(targetText, target.getStart()), end = symbolPosition(targetText, target.end);
          const key = `${path}:${target.getStart()}:${target.end}`;
          if (seen.has(key)) continue;
          seen.add(key);
          definitions.push({ path: relative(workspace.cwd, path), revision: captured.revision, textHash: digest(targetText), name: symbol.name, selection: { start, end, direction: "forward" } });
        }
        return definitions.length ? { status: "definitions", capability, definitions }
          : { status: "no-definition", capability, message: "The compiler found no readable definition inside this workspace. External library and historical definitions cannot be opened here." };
      } finally { await snapshot.dispose(); if (!timedOut) await files.verify(workspace); }
    };
    const timeout = Promise.withResolvers<never>();
    timer = setTimeout(() => {
      timedOut = true;
      // 7.0.2 dispose unregisters synchronously before its release RPC. Retire the
      // snapshot first so API.close can close the transport rather than await
      // another release on an unresponsive compiler. The timeout is the error.
      void activeSnapshot?.dispose().catch(() => {});
      timeout.reject(new Error("Symbol analysis timed out after 20 seconds. Check project configuration or use a smaller workspace, then retry."));
    }, 20_000);
    return await Promise.race([operation(), timeout.promise]);
  } catch (error) {
    return { status: "error", capability: { ...capability, available: false }, message: `${error instanceof Error ? error.message : String(error)} Your editor buffers are unchanged. Retry after correcting the file or compiler installation.` };
  } finally { clearTimeout(timer); await api?.close(); }
}
