import { WORKSPACE_OWNER_HEADER } from "@agent-desktop/shared";
import type { NativeTerminalInfo } from "../../../../packages/shared/src/terminals";
import type { WorkspaceTarget } from "../../../../packages/shared/src/workspace";
import type { LocalEnvironmentWorkerEnvironment } from "../local-environments/environment";
import { TerminalCreationInputMismatch, parseTerminalCreationRequest, type TerminalCreationRecords,
  type TerminalCreationRequest, type TerminalCreationReceipt, type TerminalCreationObservation } from "./creation-records";
import type { TmuxTerminalManager } from "./native-manager";
import { TerminalError } from "./error";

async function body(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("Missing terminal creation body.");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0, expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, 5000);
  try {
    for (;;) {
      const next = await reader.read();
      if (expired) throw new Error("Terminal creation body timed out.");
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 16384) throw new Error("Terminal creation body exceeds its bound.");
      chunks.push(next.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { clearTimeout(timer); reader.releaseLock(); }
}
function matches(terminal: NativeTerminalInfo, terminalId: string, request: TerminalCreationRequest): boolean {
  const target = terminal?.target;
  return terminal?.id === terminalId && terminal.protocol === "tmux-v1" && !!target
    && Object.keys(target).length === 1
    && ("projectId" in request.target ? "projectId" in target && target.projectId === request.target.projectId
      : "sessionId" in target && target.sessionId === request.target.sessionId);
}

/** Called only behind the server's existing authenticated host/device boundary.
 * A durable claim precedes target resolution; observation never starts work. */
export class TerminalCreationHttp {
  private stopped = false;
  private readonly requests = new Set<Promise<Response>>();
  constructor(private readonly options: {
    hostId: string;
    controlEpoch: string;
    records: TerminalCreationRecords;
    manager: Pick<TmuxTerminalManager, "create" | "get">;
    resolveTarget(target: WorkspaceTarget): string;
    environmentForTarget(target: WorkspaceTarget): LocalEnvironmentWorkerEnvironment | undefined;
  }) {}
  async dispose(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.requests]);
  }
  handle(request: Request): Promise<Response> | undefined {
    const path = new URL(request.url).pathname;
    if (!["/v2/terminals/creation-capabilities", "/v2/terminals/create", "/v2/terminals/creation-status"].includes(path)) return;
    const result = this.respond(request, path);
    this.requests.add(result);
    void result.then(() => this.requests.delete(result), () => this.requests.delete(result));
    return result;
  }
  private async respond(request: Request, path: string): Promise<Response> {
    const headers = { "Cache-Control": "no-store", [WORKSPACE_OWNER_HEADER]: this.options.hostId };
    const fail = (code: string, message: string, status = 503) => Response.json({ error: { code, message } }, { status, headers });
    if (request.headers.get(WORKSPACE_OWNER_HEADER) !== this.options.hostId) return fail("OWNER_MISMATCH", "The terminal owner does not match this host.", 409);
    if (this.stopped) return fail("TERMINALS_STOPPING", "Terminal creation routes are stopping.");
    const capabilities = path.endsWith("/creation-capabilities");
    if (request.method !== (capabilities ? "GET" : "POST")) return fail("METHOD_NOT_ALLOWED", capabilities ? "Use GET." : "Use POST.", 405);
    const base = { version: 1, hostId: this.options.hostId };
    if (capabilities) return Response.json({ ...base, controlEpoch: this.options.controlEpoch }, { headers });
    let input: TerminalCreationRequest;
    try { input = parseTerminalCreationRequest(await body(request)); }
    catch { return fail("INVALID_TERMINAL_CREATE_REQUEST", "Invalid terminal creation request.", 400); }
    if (this.stopped) return fail("TERMINALS_STOPPING", "Terminal creation routes are stopping.");
    const envelope = { ...base, requestId: input.requestId };
    const observe = (): TerminalCreationObservation => this.options.records.observe(input, this.options.controlEpoch);
    if (path.endsWith("/creation-status")) {
      try {
        const observation = observe();
        // Read only the reserved identity. Missing metadata is not acquisition authority.
        const terminalId = observation.status === "unavailable" ? undefined
          : observation.status === "pending" ? observation.terminalId : observation.receipt.terminalId;
        let terminal: NativeTerminalInfo | undefined;
        if (terminalId) {
          try { terminal = this.options.manager.get(terminalId); }
          catch (error) { if (!(error instanceof TerminalError) || error.code !== "TERMINAL_NOT_FOUND") throw error; }
          if (terminal && !matches(terminal, terminalId, input)) throw new Error("Reserved terminal ownership does not match.");
        }
        return Response.json({ ...envelope, ...observation, ...(terminal ? { terminal } : {}) }, { headers });
      } catch (error) {
        return error instanceof TerminalCreationInputMismatch ? fail("TERMINAL_CREATE_INPUT_MISMATCH", error.message, 409)
          : fail("TERMINAL_CREATE_OBSERVATION_FAILED", "Terminal creation state could not be read; do not replay creation.");
      }
    }
    let terminalId: string;
    try {
      const prior = this.options.records.get(input);
      if (prior) return Response.json({ ...envelope, ...observe() }, { headers });
      if (input.controlEpoch !== this.options.controlEpoch) return fail("TERMINAL_CREATE_EPOCH_CHANGED", "Refresh terminal creation capabilities before a new request.", 409);
      const claim = this.options.records.claim(input);
      if (!claim.fresh) return Response.json({ ...envelope, ...observe() }, { headers });
      terminalId = claim.record.terminalId;
    } catch (error) {
      return error instanceof TerminalCreationInputMismatch ? fail("TERMINAL_CREATE_INPUT_MISMATCH", error.message, 409)
        : fail("TERMINAL_CREATE_ADMISSION_FAILED", "Terminal creation could not be durably admitted; do not replay this request.");
    }
    let dispatched = false, receipt: TerminalCreationReceipt;
    try {
      const cwd = this.options.resolveTarget(input.target), environment = this.options.environmentForTarget(input.target);
      dispatched = true;
      const terminal = await this.options.manager.create({ target: input.target, cols: input.cols, rows: input.rows, cwd }, environment, undefined, { terminalId, validateOwner: () => {
        if (this.options.resolveTarget(input.target) !== cwd) throw new Error("The terminal target changed before dispatch.");
      } });
      if (!matches(terminal, terminalId, input) || (terminal.status !== "running" && terminal.status !== "exited"))
        throw new Error("Terminal creation returned an unconfirmed identity or state.");
      receipt = { outcome: "completed", terminalId };
    } catch {
      receipt = { outcome: dispatched ? "unknown" : "not-submitted", terminalId,
        message: dispatched ? "Terminal creation was not confirmed. Inspect the reserved terminal; do not replay creation."
          : "The terminal workspace could not be prepared. No terminal creation was dispatched." };
    }
    try {
      this.options.records.finish(input, receipt);
      return Response.json({ ...envelope, status: "settled", receipt }, { headers });
    } catch { return fail("TERMINAL_CREATE_SETTLEMENT_FAILED", "Terminal creation lacks a durable completion receipt. Inspect this request; do not replay it."); }
  }
}
