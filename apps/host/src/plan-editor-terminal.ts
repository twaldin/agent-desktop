import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NativeTerminalInfo } from "../../../packages/shared/src/terminals";
import type { PlanEditorProcessOptions } from "./plan-editor-process";
export interface PreparedEditorTerminal extends PlanEditorProcessOptions {
  request: { requestId: string; sessionId: string }; cwd: string; environment: Record<string, string>;
}
import { cleanupPlanEditorProcessFiles, createPlanEditorProcessFiles, planEditorProcessCommand,
  readPlanEditorProcessResult, readPlanEditorOriginalContent, type PlanEditorProcessFiles, type PlanEditorProcessResult } from "./plan-editor-process";
import type { TmuxTerminalManager } from "./terminals/native-manager";
import { atomicPrivateText, privateDirectory, privateFile } from "./terminals/native-store";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export interface PlanEditorTerminalRun {
  terminalId: string;
  completion: Promise<PlanEditorProcessResult>;
  cancel(): Promise<void>;
  cleanup(options?: { preserveEditedResult?: boolean; preserveOriginalContent?: boolean }): void;
}
interface PlanEditorTerminalManifest {
  version: 1;
  requestId: string;
  terminalId: string;
  sessionId: string;
  files: PlanEditorProcessFiles;
  launched?: { createdAt: number; serverGeneration: string };
}

/** A configured editor is a real program in the existing private tmux pane.
 * Its completion is the pane's exit plus the helper's exact result receipt. */
export class PlanEditorTerminals {
  private readonly directory: string;
  constructor(dataDirectory: string, private readonly terminals: Pick<TmuxTerminalManager,
    "createOwnedCommand" | "get" | "subscribe" | "close">, private readonly namespace: "plan" | "todo" = "plan") {
    this.directory = privateDirectory(join(dataDirectory, `${namespace}-editors-v1`));
  }

  async start(terminalId: string, prepared: PreparedEditorTerminal, validateOwner: () => void): Promise<PlanEditorTerminalRun> {
    const directory = this.requestDirectory(prepared.request.requestId);
    if (existsSync(directory)) throw new Error("The original Plan editor files already exist; this operation must be inspected, not replayed.");
    validateOwner();
    const files = createPlanEditorProcessFiles(directory, prepared);
    const manifestPath = join(directory, "files.json");
    const manifest: PlanEditorTerminalManifest = { version: 1, requestId: prepared.request.requestId,
      terminalId, sessionId: prepared.request.sessionId, files };
    atomicPrivateText(manifestPath, JSON.stringify(manifest)); privateFile(manifestPath);
    const command = planEditorProcessCommand(files, prepared.environment);
    // Once creation is dispatched, files remain until a verified settlement.
    // A lost create acknowledgement is not permission to erase or relaunch.
    const terminal = await this.terminals.createOwnedCommand({ target: { sessionId: prepared.request.sessionId }, cwd: prepared.cwd }, command,
      { terminalId, validateOwner });
    manifest.launched = { createdAt: terminal.createdAt, serverGeneration: terminal.serverGeneration };
    atomicPrivateText(manifestPath, JSON.stringify(manifest)); privateFile(manifestPath);
    let settled = false;
    let close: Promise<void> | undefined;
    const completion = this.waitForExit(terminalId).then(info => {
      settled = true;
      if (info.cancelled) return { version: 1 as const, outcome: "cancelled" as const };
      if (info.exitCode !== 0) throw new Error("The Plan editor helper did not complete. Its edited output, if any, was retained.");
      const result = readPlanEditorProcessResult(files);
      if (!result) throw new Error("The exited Plan editor has no completion receipt. Its files were retained.");
      return result;
    });
    // A caller may attach its observer after returning through another await.
    // Keep the original rejecting promise, while preventing incidental reporting.
    void completion.catch(() => {});
    return { terminalId, completion,
      cancel: () => {
        if (close) return close;
        close = this.cancelOriginal(prepared.request.requestId, terminalId);
        return close;
      },
      cleanup: options => {
        if (!settled) throw new Error("The Plan editor still owns its temporary files.");
        cleanupPlanEditorProcessFiles(files, options);
      },
    };
  }

  /** Cancel only the acknowledged pane recorded for this request. A lost
   * launch receipt or changed terminal owner is retained for inspection. */
  async cancelOriginal(requestId: string, terminalId: string): Promise<void> {
    const manifest = this.readManifest(requestId);
    if (manifest.terminalId !== terminalId || !manifest.launched) throw new Error("The original Plan editor launch is not acknowledged; cancellation was not dispatched.");
    const before = this.terminals.get(terminalId);
    if (before.id !== terminalId || before.createdAt !== manifest.launched.createdAt || before.serverGeneration !== manifest.launched.serverGeneration
      || !("sessionId" in before.target) || before.target.sessionId !== manifest.sessionId)
      throw new Error("The current terminal is not the original Plan editor pane; cancellation was not dispatched.");
    const closed = await this.terminals.close(terminalId);
    if (closed.id !== terminalId || closed.createdAt !== manifest.launched.createdAt || closed.serverGeneration !== manifest.launched.serverGeneration
      || closed.status !== "exited") throw new Error("The original Plan editor termination was not confirmed.");
    cleanupPlanEditorProcessFiles(manifest.files, { preserveEditedResult: true, preserveOriginalContent: this.namespace === "todo" });
  }

  /** Inspect only saved output of the original request, never a new editor. */
  recovery(requestId: string): PlanEditorProcessResult | undefined {
    const directory = this.requestDirectory(requestId), path = join(directory, "files.json");
    if (!existsSync(path)) return;
    return readPlanEditorProcessResult(this.readManifest(requestId).files);
  }

  /** Only the original prepared Markdown; no command, environment or scratch buffer. */
  original(requestId: string): string | undefined {
    const directory = this.requestDirectory(requestId);
    if (!existsSync(join(directory, "files.json"))) return;
    return readPlanEditorOriginalContent(this.readManifest(requestId).files);
  }

  private readManifest(requestId: string): PlanEditorTerminalManifest {
    const directory = this.requestDirectory(requestId), path = join(directory, "files.json");
    if (!existsSync(directory) || !existsSync(path)) throw new Error("The original Plan editor manifest does not exist.");
    privateDirectory(directory); privateFile(path);
    const raw = readFileSync(path);
    if (raw.byteLength > 16_384) throw new Error("The saved Plan editor file index exceeds its bound.");
    const value = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    if (Object.keys(value).some(key => !["version", "requestId", "terminalId", "sessionId", "files", "launched"].includes(key))
      || value.version !== 1 || value.requestId !== requestId || typeof value.terminalId !== "string" || !UUID.test(value.terminalId)
      || typeof value.sessionId !== "string" || !value.sessionId || value.sessionId.includes("\0")
      || !value.files || typeof value.files !== "object" || Array.isArray(value.files)) throw new Error("The saved Plan editor file index is invalid.");
    const files = value.files as Record<string, unknown>;
    const ownerId = typeof files.inputPath === "string" ? files.inputPath.slice(directory.length + 1, -".input.json".length) : "";
    if (!UUID.test(ownerId) || Object.keys(files).length !== 6 || Object.keys(files).some(key => !["directory", "inputPath", "contentPath", "editedPath", "resultPath", "scratchPath"].includes(key))
      || files.directory !== directory || ![files.inputPath, files.contentPath, files.editedPath, files.resultPath, files.scratchPath]
        .every(item => typeof item === "string" && item.startsWith(`${directory}/`) && item.slice(directory.length + 1).indexOf("/") === -1)
      || files.inputPath !== join(directory, `${ownerId}.input.json`) || files.contentPath !== join(directory, `${ownerId}.content`)
      || files.editedPath !== join(directory, `${ownerId}.edited`) || files.resultPath !== join(directory, `${ownerId}.result.json`)
      || files.scratchPath !== join(directory, `${ownerId}.tmp`))
      throw new Error("The saved Plan editor file index changed its owner.");
    let launched: PlanEditorTerminalManifest["launched"];
    if (value.launched !== undefined) {
      if (!value.launched || typeof value.launched !== "object" || Array.isArray(value.launched)) throw new Error("The saved Plan editor launch receipt is invalid.");
      const receipt = value.launched as Record<string, unknown>;
      if (Object.keys(receipt).length !== 2 || typeof receipt.createdAt !== "number" || !Number.isSafeInteger(receipt.createdAt)
        || receipt.createdAt <= 0 || typeof receipt.serverGeneration !== "string" || !UUID.test(receipt.serverGeneration)) throw new Error("The saved Plan editor launch receipt is invalid.");
      launched = { createdAt: receipt.createdAt, serverGeneration: receipt.serverGeneration };
    }
    return { version: 1, requestId, terminalId: value.terminalId, sessionId: value.sessionId,
      files: files as unknown as PlanEditorProcessFiles, ...(launched ? { launched } : {}) };
  }

  private requestDirectory(requestId: string): string {
    if (!UUID.test(requestId))
      throw new Error("Invalid Plan editor request identity.");
    return join(this.directory, requestId);
  }

  private waitForExit(terminalId: string): Promise<NativeTerminalInfo> {
    return new Promise((resolve, reject) => {
      let done = false;
      let unsubscribe: (() => void) | undefined;
      const finish = (info?: NativeTerminalInfo, error?: unknown) => {
        if (done) return;
        done = true; unsubscribe?.();
        if (error) reject(error); else resolve(info!);
      };
      const inspect = () => {
        try {
          const info = this.terminals.get(terminalId);
          if (info.status === "exited") finish(info);
          else if (info.status === "interrupted" || info.status === "error")
            finish(undefined, new Error("The original Plan editor pane was lost; completion is unknown."));
        } catch (error) { finish(undefined, error); }
      };
      unsubscribe = this.terminals.subscribe(event => {
        if (event.type === "removed" && event.terminalId === terminalId) finish(undefined, new Error("The original Plan editor pane was removed."));
        else if (event.type === "state" && event.terminal.id === terminalId) inspect();
      });
      if (done) unsubscribe(); else inspect();
    });
  }
}
