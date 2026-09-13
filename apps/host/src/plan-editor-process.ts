import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { activateBundledRuntime, assertBundledRuntime, getBundledRuntimeRoot } from "./runtime-ownership";
import { atomicPrivateText, privateDirectory, privateFile } from "./terminals/native-store";
import type { NativeOwnedCommand } from "./terminals/native-manager";

const MAX_CONTENT_BYTES = 12 * 1024 * 1024;
const MAX_EDITOR_COMMAND_BYTES = 64 * 1024;
const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export interface PlanEditorProcessFiles {
  directory: string;
  inputPath: string;
  contentPath: string;
  editedPath: string;
  resultPath: string;
  scratchPath: string;
}
export interface PlanEditorProcessOptions {
  editorCommand: string;
  content: string;
  extension: string;
  trimTrailingNewline: boolean;
}
interface PlanEditorProcessInput {
  version: 1;
  editorCommand: string;
  contentPath: string;
  editedPath: string;
  resultPath: string;
  scratchPath: string;
  extension: string;
  trimTrailingNewline: boolean;
  bundledRuntimeRoot?: string;
}
export type PlanEditorProcessResult =
  | { version: 1; outcome: "completed"; content: string; contentSha256: string }
  | { version: 1; outcome: "cancelled" };

function validExtension(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(".") && Buffer.byteLength(value) <= 256
    && !value.includes("/") && !value.includes("\\") && !value.includes("\0");
}

function ownedFile(path: string, directory: string, mustExist: boolean): string {
  if (!isAbsolute(path) || resolve(path) !== path || (path !== directory && !path.startsWith(`${directory}${sep}`))) throw new Error("The Plan editor file is outside its private owner.");
  if (!mustExist) { if (existsSync(path)) throw new Error("The Plan editor output already exists."); return path; }
  privateFile(path); if (realpathSync(path) !== path) throw new Error("The Plan editor file is not canonical."); return path;
}
function ownedDirectory(path: string, directory: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || !path.startsWith(`${directory}${sep}`)) throw new Error("The Plan editor scratch directory is outside its private owner.");
  const value = privateDirectory(path);
  if (value !== path) throw new Error("The Plan editor scratch directory is not canonical.");
  return value;
}
function parseInput(path: string): PlanEditorProcessInput {
  const directory = privateDirectory(dirname(path)); ownedFile(path, directory, true);
  const bytes = readFileSync(path); if (bytes.byteLength > 128 * 1024) throw new Error("The Plan editor input exceeds its bound.");
  const value = JSON.parse(bytes.toString("utf8")) as Partial<PlanEditorProcessInput>;
  if (value.version !== 1 || typeof value.editorCommand !== "string" || !value.editorCommand.trim() || value.editorCommand.includes("\0") || Buffer.byteLength(value.editorCommand) > MAX_EDITOR_COMMAND_BYTES
    || !validExtension(value.extension)
    || typeof value.trimTrailingNewline !== "boolean" || typeof value.contentPath !== "string" || typeof value.editedPath !== "string" || typeof value.resultPath !== "string" || typeof value.scratchPath !== "string"
    || value.bundledRuntimeRoot !== undefined && (typeof value.bundledRuntimeRoot !== "string" || !isAbsolute(value.bundledRuntimeRoot) || resolve(value.bundledRuntimeRoot) !== value.bundledRuntimeRoot))
    throw new Error("The Plan editor input is invalid.");
  ownedFile(value.contentPath, directory, true); ownedFile(value.editedPath, directory, false); ownedFile(value.resultPath, directory, false); ownedDirectory(value.scratchPath, directory);
  return value as PlanEditorProcessInput;
}

/** Create only private host inputs. The browser never supplies any of these paths. */
export function createPlanEditorProcessFiles(directory: string, options: PlanEditorProcessOptions): PlanEditorProcessFiles {
  const owner = privateDirectory(directory);
  if (typeof options.content !== "string" || Buffer.byteLength(options.content) > MAX_CONTENT_BYTES) throw new Error("The Plan editor content exceeds its bound.");
  if (typeof options.editorCommand !== "string" || !options.editorCommand.trim() || options.editorCommand.includes("\0") || Buffer.byteLength(options.editorCommand) > MAX_EDITOR_COMMAND_BYTES) throw new Error("A bounded configured editor command is required.");
  if (!validExtension(options.extension)) throw new Error("A bounded Plan editor file extension is required.");
  const id = randomUUID(), files = {
    directory: owner,
    inputPath: join(owner, `${id}.input.json`),
    contentPath: join(owner, `${id}.content`),
    editedPath: join(owner, `${id}.edited`),
    resultPath: join(owner, `${id}.result.json`),
    scratchPath: join(owner, `${id}.tmp`),
  };
  privateDirectory(files.scratchPath);
  atomicPrivateText(files.contentPath, options.content); privateFile(files.contentPath);
  const bundledRuntimeRoot = getBundledRuntimeRoot();
  atomicPrivateText(files.inputPath, JSON.stringify({ version: 1, editorCommand: options.editorCommand,
    contentPath: files.contentPath, editedPath: files.editedPath, resultPath: files.resultPath, scratchPath: files.scratchPath,
    extension: options.extension, trimTrailingNewline: options.trimTrailingNewline,
    ...(bundledRuntimeRoot ? { bundledRuntimeRoot } : {}) } satisfies PlanEditorProcessInput));
  privateFile(files.inputPath); return files;
}

/** Fixed app-owned Bun/helper argv plus the exact private worker environment. */
export function planEditorProcessCommand(files: PlanEditorProcessFiles, environment: Readonly<Record<string, string>>): NativeOwnedCommand {
  const bundledRuntimeRoot = getBundledRuntimeRoot();
  const executable = bundledRuntimeRoot ? assertBundledRuntime(bundledRuntimeRoot).executablePath : realpathSync(process.execPath);
  const helper = realpathSync(import.meta.path);
  if (bundledRuntimeRoot && relative(bundledRuntimeRoot, helper).startsWith("..")) throw new Error("The Plan editor helper is outside the bundled runtime.");
  return { application: executable,
    args: [...(environment.PI_DISABLE_DOTENV === "1" ? ["--no-env-file"] : []), helper, "--run", files.inputPath],
    // OMP's native helper resolves os.tmpdir() in this process. Confining all
    // temporary copies lets a verified close remove only this job's residue.
    environment: { ...environment, TMPDIR: files.scratchPath, TMP: files.scratchPath, TEMP: files.scratchPath } };
}

export function readPlanEditorProcessResult(files: PlanEditorProcessFiles): PlanEditorProcessResult | undefined {
  if (!existsSync(files.resultPath)) return;
  const directory = privateDirectory(files.directory); ownedFile(files.resultPath, directory, true);
  const bytes = readFileSync(files.resultPath); if (bytes.byteLength > 128 * 1024) throw new Error("The Plan editor result exceeds its bound.");
  const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  if (value.version !== 1 || value.outcome !== "cancelled" && value.outcome !== "completed") throw new Error("The Plan editor result is invalid.");
  if (value.outcome === "cancelled") {
    if (Object.keys(value).some(key => !["version", "outcome"].includes(key))) throw new Error("The Plan editor cancellation result is invalid.");
    return { version: 1, outcome: "cancelled" };
  }
  const contentSha256 = value.contentSha256;
  if (Object.keys(value).some(key => !["version", "outcome", "contentSha256"].includes(key))
    || typeof contentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(contentSha256) || !existsSync(files.editedPath)) throw new Error("The Plan editor completion result is invalid.");
  ownedFile(files.editedPath, directory, true); const contentBytes = readFileSync(files.editedPath);
  if (contentBytes.byteLength > MAX_CONTENT_BYTES || sha256(contentBytes) !== contentSha256) throw new Error("The Plan editor completion bytes do not match their receipt.");
  return { version: 1, outcome: "completed", content: contentBytes.toString("utf8"), contentSha256 };
}

export function cleanupPlanEditorProcessFiles(files: PlanEditorProcessFiles, options: { preserveEditedResult?: boolean } = {}): void {
  const directory = privateDirectory(files.directory);
  const paths = options.preserveEditedResult ? [files.inputPath, files.contentPath] : [files.inputPath, files.contentPath, files.editedPath, files.resultPath];
  for (const path of paths) {
    if (!existsSync(path)) continue; ownedFile(path, directory, true); unlinkSync(path);
  }
  if (existsSync(files.scratchPath)) { ownedDirectory(files.scratchPath, directory); rmSync(files.scratchPath, { recursive: true }); }
}

export async function runPlanEditorProcess(inputPath: string): Promise<PlanEditorProcessResult> {
  const input = parseInput(inputPath);
  if (input.bundledRuntimeRoot) activateBundledRuntime(input.bundledRuntimeRoot);
  const native = await import("@oh-my-pi/pi-coding-agent/utils/external-editor");
  if (native.getEditorCommand() !== input.editorCommand) throw new Error("The configured editor changed before the private process started.");
  const contentBytes = readFileSync(input.contentPath); if (contentBytes.byteLength > MAX_CONTENT_BYTES) throw new Error("The Plan editor content exceeds its bound.");
  const edited = await native.openInEditor(input.editorCommand, contentBytes.toString("utf8"), {
    extension: input.extension, trimTrailingNewline: input.trimTrailingNewline });
  const result: PlanEditorProcessResult = edited === null ? { version: 1, outcome: "cancelled" }
    : { version: 1, outcome: "completed", content: edited, contentSha256: sha256(edited) };
  if (edited !== null) { atomicPrivateText(input.editedPath, edited); privateFile(input.editedPath); }
  atomicPrivateText(input.resultPath, JSON.stringify(result.outcome === "completed"
    ? { version: 1, outcome: "completed", contentSha256: result.contentSha256 } : result)); privateFile(input.resultPath);
  return result;
}

if (import.meta.main) {
  const [mode, inputPath] = process.argv.slice(2);
  if (mode !== "--run" || !inputPath) { console.error("Invalid Plan editor helper invocation."); process.exit(2); }
  try { await runPlanEditorProcess(inputPath); }
  catch { console.error("Plan editor helper failed."); process.exit(1); }
}
