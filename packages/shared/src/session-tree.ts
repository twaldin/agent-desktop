/** A tree ticket belongs to one loaded native session and its complete history. */
export const SESSION_TREE_CAPABILITY = { version: 1, commandVersion: 23 } as const;
export const SESSION_TREE_OWNER_HEADER = "X-Agent-Tree-Host-Id";
export const MAX_TREE_BYTES = 8 * 1024 * 1024;
export interface TreeTicket { nativeSessionId: string; epoch: string; revision: string }
export interface TreeEntry {
  id: string; parentId: string | null; timestamp: string; kind: string;
  text: string; label?: string; active: boolean; editable: boolean; imageCount: number;
}
export interface TreeDraft { text: string; images: { type: "image"; data: string; mimeType: string }[] }
export interface TreeDraftRecovery { commandId: string; targetId: string; draft: TreeDraft }
export interface SessionTree {
  ticket: TreeTicket; leafId: string | null; entries: TreeEntry[];
  summariesEnabled: boolean; nativeCommandAvailable: boolean;
  reconciliationRequired: boolean; busyReason?: string; recoveredDraft?: TreeDraftRecovery;
}
export type TreeMutation = { action: "navigate"; targetId: string; summarize: boolean; customInstructions?: string }
  | { action: "label"; targetId: string; label: string | null };
export interface TreeMutationRequest { sessionId: string; ticket: TreeTicket; mutation: TreeMutation }
export interface TreeMutationResult { commandId: string; state: SessionTree; cancelled: boolean; draft?: TreeDraft; askReanswerCommitted?: boolean }
export interface TreeJournalReceipt { commandId: string; state: "absent" | "pending" | "unknown" | "failed" | "succeeded"; result?: TreeMutationResult; submission?: { kind: "user-message" | "skill-message" | "native-command"; entryId?: string }; error?: string }
export interface SessionTreeResponse { hostId: string; sessionId: string; tree: SessionTree | null; unavailable?: string; receipt?: TreeJournalReceipt }
const fail = (field: string): never => { throw new Error(`Invalid native history ${field}.`); };
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) return fail("object");
  return value as Record<string, unknown>;
}
const text = (value: unknown, max = 200, empty = false): string => typeof value === "string" && (empty || value.length > 0) && value.length <= max && !value.includes("\0") ? value : fail("text");
const bool = (value: unknown): boolean => typeof value === "boolean" ? value : fail("boolean");
const nullableId = (value: unknown): string | null => value === null ? null : text(value);
export function parseTreeCommandId(value: unknown): string { const id = text(value); return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id) ? id : fail("command identity"); }
export function parseTreeTicket(value: unknown): TreeTicket {
  const v = record(value, ["nativeSessionId", "epoch", "revision"]);
  return { nativeSessionId: text(v.nativeSessionId), epoch: text(v.epoch), revision: text(v.revision) };
}
export function parseTreeDraft(value: unknown): TreeDraft {
  const v = record(value, ["text", "images"]);
  if (!Array.isArray(v.images) || v.images.length > 64) return fail("images");
  const draft: TreeDraft = { text: text(v.text, MAX_TREE_BYTES, true), images: v.images.map(raw => {
    const image = record(raw, ["type", "data", "mimeType"]);
    if (image.type !== "image") return fail("image type");
    const data = text(image.data, MAX_TREE_BYTES), mimeType = text(image.mimeType, 100);
    if (!/^image\/[a-zA-Z0-9.+-]+$/.test(mimeType) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) return fail("image content");
    return { type: "image", data, mimeType };
  }) };
  if (new TextEncoder().encode(JSON.stringify(draft)).length > MAX_TREE_BYTES) fail("draft size");
  return draft;
}
export function parseSessionTree(value: unknown): SessionTree {
  const v = record(value, ["ticket", "leafId", "entries", "summariesEnabled", "nativeCommandAvailable", "reconciliationRequired", "busyReason", "recoveredDraft"]);
  if (!Array.isArray(v.entries) || v.entries.length > 100000) return fail("entries");
  const ids = new Set<string>();
  const entries = v.entries.map(raw => {
    const e = record(raw, ["id", "parentId", "timestamp", "kind", "text", "label", "active", "editable", "imageCount"]);
    const id = text(e.id); if (ids.has(id)) fail("duplicate entry"); ids.add(id);
    const parentId = nullableId(e.parentId); if (parentId !== null && !ids.has(parentId) || parentId === id) fail("parent order");
    if (!Number.isSafeInteger(e.imageCount) || (e.imageCount as number) < 0) fail("image count");
    return { id, parentId, timestamp: text(e.timestamp), kind: text(e.kind), text: text(e.text, MAX_TREE_BYTES, true),
      ...(e.label === undefined ? {} : { label: text(e.label, 4096, true) }), active: bool(e.active), editable: bool(e.editable), imageCount: e.imageCount as number };
  });
  const leafId = nullableId(v.leafId); if (leafId !== null && !ids.has(leafId)) fail("leaf");
  let recoveredDraft: TreeDraftRecovery | undefined;
  if (v.recoveredDraft !== undefined) {
    const d = record(v.recoveredDraft, ["commandId", "targetId", "draft"]);
    recoveredDraft = { commandId: parseTreeCommandId(d.commandId), targetId: text(d.targetId), draft: parseTreeDraft(d.draft) };
    if (!ids.has(recoveredDraft.targetId)) fail("draft target");
  }
  const result: SessionTree = { ticket: parseTreeTicket(v.ticket), leafId, entries, summariesEnabled: bool(v.summariesEnabled), nativeCommandAvailable: bool(v.nativeCommandAvailable), reconciliationRequired: bool(v.reconciliationRequired),
    ...(v.busyReason === undefined ? {} : { busyReason: text(v.busyReason, 4096) }), ...(recoveredDraft ? { recoveredDraft } : {}) };
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_TREE_BYTES * 2) fail("state size");
  return result;
}
export function parseTreeMutationRequest(value: unknown): TreeMutationRequest {
  const v = record(value, ["sessionId", "ticket", "mutation"]), m = record(v.mutation, ["action", "targetId", "summarize", "customInstructions", "label"]);
  const sessionId = text(v.sessionId), ticket = parseTreeTicket(v.ticket), targetId = text(m.targetId);
  if (sessionId !== ticket.nativeSessionId) fail("owner");
  let mutation: TreeMutation;
  if (m.action === "navigate") {
    if (m.label !== undefined) fail("navigation fields");
    const summarize = bool(m.summarize);
    if (m.customInstructions !== undefined && !summarize) fail("summary instructions");
    mutation = { action: "navigate", targetId, summarize, ...(m.customInstructions === undefined ? {} : { customInstructions: text(m.customInstructions, 65536, true) }) };
  } else if (m.action === "label") {
    if (m.summarize !== undefined || m.customInstructions !== undefined) fail("label fields");
    mutation = { action: "label", targetId, label: m.label === null ? null : text(m.label, 4096, true) };
  } else return fail("mutation");
  return { sessionId, ticket, mutation };
}
export function parseTreeMutationResult(value: unknown, commandId?: string): TreeMutationResult {
  const v = record(value, ["commandId", "state", "cancelled", "draft", "askReanswerCommitted"]), id = parseTreeCommandId(v.commandId);
  if (commandId !== undefined && id !== commandId) fail("result identity");
  const cancelled = bool(v.cancelled);
  if (cancelled && (v.draft !== undefined || v.askReanswerCommitted !== undefined)) fail("cancelled result");
  return { commandId: id, state: parseSessionTree(v.state), cancelled, ...(v.draft === undefined ? {} : { draft: parseTreeDraft(v.draft) }), ...(v.askReanswerCommitted === undefined ? {} : { askReanswerCommitted: bool(v.askReanswerCommitted) }) };
}
export function parseTreeJournalReceipt(value: unknown, commandId: string): TreeJournalReceipt {
  const v = record(value, ["commandId", "state", "result", "submission", "error"]);
  if (parseTreeCommandId(v.commandId) !== commandId || !["absent", "pending", "unknown", "failed", "succeeded"].includes(String(v.state)) || (v.state === "succeeded") !== (v.result !== undefined || v.submission !== undefined) || v.result !== undefined && v.submission !== undefined) fail("receipt");
  let submission: TreeJournalReceipt["submission"];
  if (v.submission !== undefined) {
    const input = record(v.submission, ["kind", "entryId"]);
    if (!["user-message", "skill-message", "native-command"].includes(String(input.kind)) || input.kind !== "native-command" && input.entryId === undefined) fail("submission receipt");
    submission = { kind: input.kind as NonNullable<TreeJournalReceipt["submission"]>["kind"], ...(input.entryId === undefined ? {} : { entryId: text(input.entryId) }) };
  }
  return { commandId, state: v.state as TreeJournalReceipt["state"], ...(submission ? { submission } : {}), ...(v.result === undefined ? {} : { result: parseTreeMutationResult(v.result, commandId) }), ...(v.error === undefined ? {} : { error: text(v.error, 4096) }) };
}
export function parseSessionTreeResponse(value: unknown, hostId: string, sessionId: string, commandId?: string): SessionTreeResponse {
  const v = record(value, ["hostId", "sessionId", "tree", "unavailable", "receipt"]);
  if (v.hostId !== hostId || v.sessionId !== sessionId || (commandId !== undefined) !== (v.receipt !== undefined)) fail("response owner");
  const tree = v.tree === null ? null : parseSessionTree(v.tree);
  const receipt = commandId === undefined ? undefined : parseTreeJournalReceipt(v.receipt, commandId);
  if (tree && tree.ticket.nativeSessionId !== sessionId || receipt?.result && receipt.result.state.ticket.nativeSessionId !== sessionId) fail("native owner");
  return { hostId, sessionId, tree, ...(v.unavailable === undefined ? {} : { unavailable: text(v.unavailable, 4096) }), ...(receipt ? { receipt } : {}) };
}
