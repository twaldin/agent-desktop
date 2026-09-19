import type { Database } from "bun:sqlite";
import { PLAN_EXTERNAL_EDITOR_PAGE_SIZE, parsePlanExternalEditorCursor, parsePlanExternalEditorObservation, parsePlanExternalEditorRequest,
  type PlanExternalEditorRequest, type PlanExternalEditorResult } from "../../../packages/shared/src/plan-external-editor";
import { ExternalEditorRecords } from "./external-editor-records";
export { EditorInputMismatch as PlanEditorInputMismatch } from "./external-editor-records";
/** Compatibility wrapper: the original Plan namespace, serialized shape and hashes are unchanged. */
export class PlanExternalEditorRecords extends ExternalEditorRecords<PlanExternalEditorRequest, PlanExternalEditorResult> {
  constructor(db: Database, hostId: string, requireSchema: () => void) {
    super(db, hostId, requireSchema, { namespace: "plan-external-editor:v1:", pageSize: PLAN_EXTERNAL_EDITOR_PAGE_SIZE,
      maxRecordBytes: 1024 * 1024, parseRequest: parsePlanExternalEditorRequest,
      parseObservation: parsePlanExternalEditorObservation, parseCursor: parsePlanExternalEditorCursor,
      unknownResult: () => ({ outcome: "unknown", message: "The owning host restarted before saving this editor result. Inspect the original terminal and Plan; this request will not run again." }) });
  }
}
