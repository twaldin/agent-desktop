import { constants } from "node:fs";
import { access, chmod, link, lstat, open, readlink, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseNativeSkillFileRef, parseStandaloneFilePath, type NativeSkillFileRef } from "@agent-desktop/shared";
import type { WorkspaceQuery, WorkspaceQueryResult, WorkspaceTarget } from "@agent-desktop/shared";
import { HostRequestError, type HostEndpoint } from "./host-transport";

const CHUNK_BYTES = 1024 * 1024;
type CopyInfo = Extract<WorkspaceQueryResult, {type: "file.copy-info"}>;
export interface WorkspaceCopySource {
  local: boolean;
  query(query: WorkspaceQuery): Promise<WorkspaceQueryResult>;
}
export type WorkspaceCopyOutcome = {ok: true; value: {path: string | null}} | {ok: false; error: string};
/** Serialize expected failures before Electron adds internal IPC channel and Error-class text. */
export async function workspaceCopyOutcome(operation: () => Promise<{path: string | null}>): Promise<WorkspaceCopyOutcome> {
  try { return {ok: true, value: await operation()}; }
  catch (error) { return {ok: false, error: error instanceof Error ? error.message : "The file could not be copied."}; }
}

/** A single selected endpoint is retained for the entire copy; host credentials stay in main. */
export function workspaceCopySource(endpoint: HostEndpoint, target: WorkspaceTarget, local: boolean, signal?: AbortSignal): WorkspaceCopySource {
  return { local, async query(query) {
    const response = await fetch(`${endpoint.origin}/v1/workspace/query`, {
      method: "POST", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      headers: { "Content-Type": "application/json", "X-Agent-Host-Id": endpoint.hostId, ...(endpoint.token ? {Authorization: `Bearer ${endpoint.token}`} : {}) },
      body: JSON.stringify({target, query}),
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new HostRequestError("The owning host did not authorize this file copy. Reconnect before trying again.", response.status);
    }
    if (response.headers.get("X-Agent-Host-Id") !== endpoint.hostId) {
      await response.body?.cancel(); throw new Error("The file copy response belongs to a different host. Reconnect before trying again.");
    }
    const reader = response.body?.getReader(); if (!reader) throw new Error("The file copy response is empty.");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > 1.5 * CHUNK_BYTES) { await reader.cancel(); throw new Error("The file copy response exceeded its chunk limit."); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!response.ok) throw new HostRequestError(value?.error?.message ?? value?.error ?? "The host could not read this file.", response.status, value?.error?.code);
    return value as WorkspaceQueryResult;
  } };
}

function validateInput(target: WorkspaceTarget, path: string, hostId: string) {
  if (!target || typeof target !== "object" || Object.keys(target).length !== 1 ||
    !("projectId" in target || "sessionId" in target || "filePath" in target) || typeof Object.values(target)[0] !== "string" ||
    !Object.values(target)[0]) throw new Error("Select one owning project or session.");
  if ("filePath" in target) { parseStandaloneFilePath(target.filePath); if (basename(target.filePath) !== path) throw new Error("The standalone file path must match its file name."); }
  else if (Object.values(target)[0]!.length > 200) throw new Error("Select one owning project or session.");
  if (typeof hostId !== "string" || !hostId || hostId.length > 200) throw new Error("Select the file’s owning host.");
  if (typeof path !== "string" || !path || path.length > 16_384 || path.includes("\0") || path.includes("\\") || isAbsolute(path) || path.split("/").includes("..")) throw new Error("Select a relative file path in the owning workspace.");
}
function info(value: WorkspaceQueryResult, path: string): CopyInfo {
  if (value.type !== "file.copy-info" || value.path !== path || !Number.isSafeInteger(value.size) || value.size < 0 ||
    typeof value.absolutePath !== "string" || !isAbsolute(value.absolutePath) || !/^[a-f0-9]{64}$/.test(value.revision)) throw new Error("The host returned invalid file copy metadata.");
  return value;
}
export function workspaceCopyDefaultName(path: string): string {
  return basename(path.replace(/\/+$/, "")).replace(/[<>:"|?*\0]/g, "_") || "download";
}
async function fingerprint(path: string) {
  try {
    const stat = await lstat(path, {bigint: true});
    if (!stat.isFile()) throw new Error("The selected destination is not a regular file.");
    return { key: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"), mode: Number(stat.mode) & 0o777 };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function destinationPath(path: string, followedLinks = 0): Promise<string> {
  if (followedLinks > 40) throw new Error("The destination has too many symbolic links.");
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Native file writes follow links, including a link whose referent does not yet exist.
    const entry = await lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (entry?.isSymbolicLink()) return destinationPath(resolve(dirname(path), await readlink(path)), followedLinks + 1);
    if (entry) throw new Error("The selected destination cannot be resolved.");
    return join(await realpath(dirname(path)), basename(path));
  }
}

/** Native dialog first. No renderer destination path, forced editor save, or workspace mutation. */
export async function saveWorkspaceCopy(input: ({target: WorkspaceTarget} | {skill: NativeSkillFileRef}) & {path: string; hostId: string}, runtime: {
  choose(defaultName: string): Promise<string | null>;
  source(): Promise<WorkspaceCopySource>;
  signal?: AbortSignal;
}): Promise<{path: string | null}> {
  if ("target" in input) validateInput(input.target, input.path, input.hostId);
  else {
    const ref = parseNativeSkillFileRef(input.skill);
    if (input.path !== basename(ref.sourcePath) || typeof input.hostId !== "string" || !input.hostId || input.hostId.length > 200) throw new Error("Select the exact owning skill file.");
  }
  runtime.signal?.throwIfAborted();
  const selected = await runtime.choose(workspaceCopyDefaultName(input.path));
  if (selected === null) return {path: null};
  if (!isAbsolute(selected) || selected.includes("\0")) throw new Error("The native save dialog did not return an absolute destination.");
  runtime.signal?.throwIfAborted();
  const source = await runtime.source(), initial = info(await source.query({type: "file.copy-info", path: input.path}), input.path);
  const destination = await destinationPath(selected), before = await fingerprint(destination);
  // A remote file can have the same absolute path as a local file. Never infer ownership from that string.
  if (source.local && resolve(initial.absolutePath) === destination) return {path: selected};
  if (before) await access(destination, constants.W_OK);
  const parent = dirname(destination), parentStat = await lstat(parent, {bigint: true});
  const temporary = join(parent, `.agent-desktop-save-${randomUUID()}`);
  const output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let committed = false;
  try {
    for (let offset = 0; offset < initial.size;) {
      runtime.signal?.throwIfAborted();
      const chunk = await source.query({type: "file.copy-chunk", path: input.path, revision: initial.revision, offset});
      if (chunk.type !== "file.copy-chunk" || chunk.path !== input.path || chunk.revision !== initial.revision || chunk.size !== initial.size || chunk.offset !== offset || typeof chunk.dataBase64 !== "string") throw new Error("The host returned a different file or offset while copying.");
      const bytes = Buffer.from(chunk.dataBase64, "base64"), expected = Math.min(CHUNK_BYTES, initial.size - offset);
      if (bytes.length !== expected || bytes.toString("base64") !== chunk.dataBase64) throw new Error("The host returned an incomplete or invalid file chunk.");
      let written = 0;
      while (written < bytes.length) {
        const result = await output.write(bytes, written, bytes.length - written, offset + written);
        if (!result.bytesWritten) throw new Error("The destination stopped accepting file data.");
        written += result.bytesWritten;
      }
      offset += bytes.length;
    }
    const final = info(await source.query({type: "file.copy-info", path: input.path}), input.path);
    if (final.revision !== initial.revision || final.size !== initial.size || final.absolutePath !== initial.absolutePath) throw new Error("The source changed during copying. The destination was not replaced.");
    await output.sync(); await output.close();
    await chmod(temporary, before?.mode ?? (0o666 & ~process.umask()));
    runtime.signal?.throwIfAborted();
    if (await destinationPath(selected) !== destination || (await fingerprint(destination))?.key !== before?.key) throw new Error("The destination changed during copying. It was not replaced.");
    const currentParent = await lstat(parent, {bigint: true});
    if (currentParent.dev !== parentStat.dev || currentParent.ino !== parentStat.ino) throw new Error("The destination folder changed during copying.");
    if (before) {
      // Ordinary filesystem replacement cannot make this metadata check and rename atomic
      // against another process. Do not present it as cross-process compare-and-swap.
      await rename(temporary, destination);
    } else {
      // Publishing a new name must not overwrite a file created after the native dialog.
      await link(temporary, destination); await unlink(temporary);
    }
    committed = true;
    return {path: selected};
  } finally {
    await output.close().catch(() => {});
    if (!committed) await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}
