import type { Database } from "bun:sqlite";
import { TODO_EXTERNAL_EDITOR_PAGE_SIZE, parseTodoExternalEditorCursor, parseTodoExternalEditorObservation, parseTodoExternalEditorRequest,
  type TodoExternalEditorRequest, type TodoExternalEditorResult } from "../../../packages/shared/src/todo-external-editor";
import { ExternalEditorRecords } from "./external-editor-records";
/** Job metadata only; native Todo state remains on its original branch. */
export class TodoExternalEditorRecords extends ExternalEditorRecords<TodoExternalEditorRequest, TodoExternalEditorResult> {
  constructor(db: Database, hostId: string, requireSchema: () => void) {
    super(db, hostId, requireSchema, { namespace: "todo-external-editor:v1:", pageSize: TODO_EXTERNAL_EDITOR_PAGE_SIZE,
      maxRecordBytes: 32 * 1024 * 1024, parseRequest: parseTodoExternalEditorRequest,
      parseObservation: parseTodoExternalEditorObservation, parseCursor: parseTodoExternalEditorCursor,
      unknownResult: () => ({ outcome: "unknown", message: "The owning host restarted before saving this editor result. Inspect the original terminal and Todos; this request will not run again." }) });
  }
}
