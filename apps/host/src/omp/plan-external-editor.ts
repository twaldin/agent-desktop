import { isAbsolute } from "node:path";
import { MAX_PLAN_CONTENT_BYTES } from "../../../../packages/shared/src/session-plan";
import { parsePlanExternalEditorRequest, type PlanExternalEditorRequest } from "../../../../packages/shared/src/plan-external-editor";

/** Host/worker IPC only. In particular, environment and command must never be
 * projected into public capabilities, terminal metadata, or a client receipt. */
export interface PreparedPlanExternalEditor {
  request: PlanExternalEditorRequest;
  nativeSessionId: string;
  sessionFile: string;
  cwd: string;
  content: string;
  extension: string;
  trimTrailingNewline: boolean;
  editorCommand: string;
  environment: Record<string, string>;
}

export function parsePreparedPlanExternalEditor(raw: unknown, expected: PlanExternalEditorRequest): PreparedPlanExternalEditor {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid prepared Plan editor.");
  const v = raw as Record<string, unknown>;
  const keys = ["request", "nativeSessionId", "sessionFile", "cwd", "content", "extension", "trimTrailingNewline", "editorCommand", "environment"];
  if (Object.keys(v).length !== keys.length || Object.keys(v).some(key => !keys.includes(key))) throw new Error("Invalid prepared Plan editor fields.");
  const request = parsePlanExternalEditorRequest(v.request);
  if (JSON.stringify(request) !== JSON.stringify(parsePlanExternalEditorRequest(expected))) throw new Error("The prepared Plan editor belongs to another request.");
  const text = (value: unknown, bytes: number, empty = false): string => {
    if (typeof value !== "string" || !empty && !value || value.includes("\0") || Buffer.byteLength(value) > bytes)
      throw new Error("Invalid prepared Plan editor value.");
    return value;
  };
  const nativeSessionId = text(v.nativeSessionId, 200), sessionFile = text(v.sessionFile, 16_384), cwd = text(v.cwd, 16_384);
  if (nativeSessionId !== request.ticket.nativeSessionId || !isAbsolute(sessionFile) || !isAbsolute(cwd))
    throw new Error("The prepared Plan editor has an invalid native owner.");
  const content = text(v.content, MAX_PLAN_CONTENT_BYTES, true), extension = text(v.extension, 256);
  if (!extension.startsWith(".") || /[\\/]/.test(extension) || typeof v.trimTrailingNewline !== "boolean"
    || v.trimTrailingNewline !== (request.edit.kind === "annotation")
    || request.edit.kind === "annotation" && (extension !== ".md" || content !== request.edit.note))
    throw new Error("The prepared Plan editor changed its editing purpose.");
  if (!v.environment || typeof v.environment !== "object" || Array.isArray(v.environment)) throw new Error("Invalid prepared editor environment.");
  const entries = Object.entries(v.environment);
  if (entries.length > 4096) throw new Error("Prepared editor environment exceeds its bound.");
  let bytes = 0;
  const environment = Object.fromEntries(entries.map(([key, value]) => {
    text(key, 4096); if (key.includes("=")) throw new Error("Invalid prepared editor environment key.");
    const item = text(value, 1024 * 1024, true); bytes += Buffer.byteLength(key) + Buffer.byteLength(item);
    if (bytes > 8 * 1024 * 1024) throw new Error("Prepared editor environment exceeds its bound.");
    return [key, item];
  }));
  return { request, nativeSessionId, sessionFile, cwd, content, extension, trimTrailingNewline: v.trimTrailingNewline,
    editorCommand: text(v.editorCommand, 65_536), environment };
}
