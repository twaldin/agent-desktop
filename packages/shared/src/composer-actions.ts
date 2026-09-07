import type { TextDocument, WorkspaceTarget } from "./workspace";

export const COMPOSER_ACTIONS_PROTOCOL_VERSION = 1;
export const COMPOSER_OWNER_HEADER = "X-Agent-Host-Id";
export type ComposerAvailability = "executable" | "partial" | "pending" | "disabled" | "shadowed";
export interface ComposerActionSource {
  kind: "builtin" | "extension" | "custom" | "mcp-prompt" | "file-command" | "prompt-template" | "skill";
  label: string;
  path?: string;
}
export interface ComposerAction {
  id: string;
  name: string;
  description: string;
  insertText: string;
  aliases?: string[];
  source: ComposerActionSource;
  availability: ComposerAvailability;
  reason?: string;
  argumentHint?: string;
  subcommands?: Array<{ name: string; description: string; usage?: string; availability?: ComposerAvailability; reason?: string }>;
  argumentCompletions: boolean;
  /** Desktop-owned route for a native command whose TUI handler is intentionally not dispatched. */
  desktopAction?: "side-chat";
}
export interface ComposerActionsCatalog {
  protocolVersion: typeof COMPOSER_ACTIONS_PROTOCOL_VERSION;
  hostId: string;
  target?: WorkspaceTarget;
  cwd: string;
  revision: string;
  commands: ComposerAction[];
  skills: ComposerAction[];
  /** Schemes currently backed by a native OMP completion handler, without ://. */
  referenceSchemes?: string[];
  diagnostics: string[];
}
export interface NativeSkillInventory {
  protocolVersion: typeof COMPOSER_ACTIONS_PROTOCOL_VERSION;
  hostId: string;
  target?: WorkspaceTarget;
  cwd: string;
  revision: string;
  skills: Array<ComposerAction & { disabledByName: boolean }>;
  /** Effective master discovery setting. Inventory discovery itself remains read-only. */
  enabled: boolean;
  /** Effective registration of discovered skills as /skill:name commands. */
  commandsEnabled: boolean;
  diagnostics: string[];
}
export interface ComposerSkillDetail {
  protocolVersion: typeof COMPOSER_ACTIONS_PROTOCOL_VERSION;
  hostId: string;
  target?: WorkspaceTarget;
  cwd: string;
  revision: string;
  skillId: string;
  content: string;
}
export interface NativeSkillFileRef {
  skillId: string;
  sourcePath: string;
  inventory: boolean;
  target?: WorkspaceTarget;
}
export interface NativeSkillFileDocument {
  protocolVersion: typeof COMPOSER_ACTIONS_PROTOCOL_VERSION;
  hostId: string;
  ref: NativeSkillFileRef;
  catalogRevision: string;
  document: TextDocument;
  reveal: { label: string; available: boolean; reason?: string };
}
export interface NativeSkillFileWriteResult {
  type: "skill.file.write";
  file: NativeSkillFileDocument;
  conflict: boolean;
}
export interface NativeSkillFileRevealResult { type: "skill.file.reveal" }
export interface ComposerCompletionQuery {
  target?: WorkspaceTarget;
  kind: "file" | "reference" | "command-argument";
  /** Partial token: file queries omit @; reference queries include their native URI scheme. */
  query: string;
  commandName?: string;
  catalogRevision?: string;
  limit?: number;
}
export interface ComposerCompletion {
  id: string;
  label: string;
  description?: string;
  insertText: string;
  kind: "file-reference" | "directory-reference" | "native-reference" | "command-argument";
}
export interface ComposerCompletions {
  protocolVersion: typeof COMPOSER_ACTIONS_PROTOCOL_VERSION;
  hostId: string;
  target?: WorkspaceTarget;
  cwd: string;
  revision: string;
  items: ComposerCompletion[];
  truncated: boolean;
  diagnostics: string[];
}

const inventoryRecord = (value: unknown, message: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
};
const inventoryText = (value: unknown, limit: number, message: string): string => {
  if (typeof value !== "string" || value.length > limit || value.includes("\0")) throw new Error(message);
  return value;
};
function parseInventoryTarget(value: unknown): WorkspaceTarget | undefined {
  if (value === undefined) return undefined;
  const target = inventoryRecord(value, "Native skill inventory target is invalid.");
  const keys = Object.keys(target);
  if (keys.length !== 1) throw new Error("Native skill inventory target is invalid.");
  if (keys[0] === "projectId") { const projectId = inventoryText(target.projectId, 200, "Native skill inventory target is invalid."); if (!projectId) throw new Error("Native skill inventory target is invalid."); return { projectId }; }
  if (keys[0] === "sessionId") { const sessionId = inventoryText(target.sessionId, 200, "Native skill inventory target is invalid."); if (!sessionId) throw new Error("Native skill inventory target is invalid."); return { sessionId }; }
  throw new Error("Native skill inventory target is invalid.");
}

export function parseNativeSkillFileRef(value: unknown): NativeSkillFileRef {
  const input = inventoryRecord(value, "Native skill file reference is invalid.");
  if (Object.keys(input).some(key => !["skillId", "sourcePath", "inventory", "target"].includes(key))
    || typeof input.inventory !== "boolean") throw new Error("Native skill file reference is invalid.");
  const skillId = inventoryText(input.skillId, 512, "Native skill file reference is invalid.");
  const sourcePath = inventoryText(input.sourcePath, 32_768, "Native skill file reference is invalid.");
  if (!skillId || !sourcePath.startsWith("/") || /[\r\n]/.test(skillId) || /[\r\n]/.test(sourcePath)) throw new Error("Native skill file reference is invalid.");
  return { skillId, sourcePath, inventory: input.inventory, ...(input.target === undefined ? {} : { target: parseInventoryTarget(input.target) }) };
}

function parseTextDocument(value: unknown): TextDocument {
  const input = inventoryRecord(value, "Native skill file document is invalid.");
  if (Object.keys(input).some(key => !["path", "size", "modifiedAt", "mode", "kind", "text", "revision", "bom", "encoding"].includes(key))
    || input.kind !== "text" || input.encoding !== "utf8" || typeof input.text !== "string" || typeof input.bom !== "boolean"
    || typeof input.path !== "string" || !input.path || input.path.length > 32_768 || input.path.includes("\0")
    || !Number.isSafeInteger(input.size) || Number(input.size) < 0 || typeof input.modifiedAt !== "number" || !Number.isFinite(input.modifiedAt)
    || !Number.isSafeInteger(input.mode) || Number(input.mode) < 0 || Number(input.mode) > 0o777
    || typeof input.revision !== "string" || !/^[a-f0-9]{64}$/.test(input.revision)
    || new TextEncoder().encode(input.text).byteLength > 1024 * 1024) throw new Error("Native skill file document is invalid.");
  return input as unknown as TextDocument;
}

/** Validate and copy an owner-bound editable native skill response. */
export function parseNativeSkillFileDocument(value: unknown): NativeSkillFileDocument {
  const input = inventoryRecord(value, "Native skill file response is invalid.");
  if (Object.keys(input).some(key => !["protocolVersion", "hostId", "ref", "catalogRevision", "document", "reveal"].includes(key))
    || input.protocolVersion !== COMPOSER_ACTIONS_PROTOCOL_VERSION || typeof input.hostId !== "string" || !input.hostId || input.hostId.length > 200
    || typeof input.catalogRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.catalogRevision)) throw new Error("Native skill file response is invalid.");
  const reveal = inventoryRecord(input.reveal, "Native skill file response is invalid.");
  if (Object.keys(reveal).some(key => !["label", "available", "reason"].includes(key)) || typeof reveal.label !== "string" || !reveal.label || reveal.label.length > 200
    || typeof reveal.available !== "boolean" || reveal.reason !== undefined && (typeof reveal.reason !== "string" || !reveal.reason || reveal.reason.length > 4096)) throw new Error("Native skill file response is invalid.");
  const result: NativeSkillFileDocument = {
    protocolVersion: COMPOSER_ACTIONS_PROTOCOL_VERSION, hostId: input.hostId,
    ref: parseNativeSkillFileRef(input.ref), catalogRevision: input.catalogRevision,
    document: parseTextDocument(input.document), reveal: reveal as unknown as NativeSkillFileDocument["reveal"],
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 2 * 1024 * 1024) throw new Error("Native skill file response is invalid.");
  return result;
}
function parseInventorySkill(value: unknown): ComposerAction & { disabledByName: boolean } {
  const row = inventoryRecord(value, "Native skill inventory row is invalid.");
  const source = inventoryRecord(row.source, "Native skill inventory source is invalid.");
  if (source.kind !== "skill" || typeof row.disabledByName !== "boolean" || typeof row.argumentCompletions !== "boolean") throw new Error("Native skill inventory row is invalid.");
  const availability = row.availability;
  if (!["executable", "partial", "pending", "disabled", "shadowed"].includes(String(availability))) throw new Error("Native skill inventory row is invalid.");
  const parsed: ComposerAction & { disabledByName: boolean } = {
    id: inventoryText(row.id, 512, "Native skill inventory row is invalid."),
    name: inventoryText(row.name, 512, "Native skill inventory row is invalid."),
    description: inventoryText(row.description, 4096, "Native skill inventory row is invalid."),
    insertText: inventoryText(row.insertText, 2048, "Native skill inventory row is invalid."),
    source: {
      kind: "skill",
      label: inventoryText(source.label, 4096, "Native skill inventory source is invalid."),
      ...(source.path === undefined ? {} : { path: inventoryText(source.path, 32_768, "Native skill inventory source is invalid.") }),
    },
    availability: availability as ComposerAvailability,
    argumentCompletions: row.argumentCompletions,
    disabledByName: row.disabledByName,
  };
  if (!parsed.id || !parsed.name || !parsed.insertText || !parsed.source.label || !parsed.source.path) throw new Error("Native skill inventory row is invalid.");
  if (row.reason !== undefined) parsed.reason = inventoryText(row.reason, 4096, "Native skill inventory row is invalid.");
  return parsed;
}

/** Validate and copy the read-only inventory projection before renderer use. */
export function parseNativeSkillInventory(value: unknown): NativeSkillInventory {
  const input = inventoryRecord(value, "Native skill inventory response is invalid.");
  if (input.protocolVersion !== COMPOSER_ACTIONS_PROTOCOL_VERSION || typeof input.enabled !== "boolean" || typeof input.commandsEnabled !== "boolean"
    || typeof input.hostId !== "string" || !input.hostId || input.hostId.length > 200
    || typeof input.revision !== "string" || !/^[a-f0-9]{64}$/.test(input.revision)
    || !Array.isArray(input.skills) || input.skills.length > 2048 || !Array.isArray(input.diagnostics) || input.diagnostics.length > 2048) {
    throw new Error("Native skill inventory response is invalid.");
  }
  const result: NativeSkillInventory = {
    protocolVersion: COMPOSER_ACTIONS_PROTOCOL_VERSION,
    hostId: input.hostId,
    ...(input.target === undefined ? {} : { target: parseInventoryTarget(input.target) }),
    cwd: inventoryText(input.cwd, 32_768, "Native skill inventory response is invalid."),
    revision: input.revision,
    skills: input.skills.map(parseInventorySkill),
    enabled: input.enabled,
    commandsEnabled: input.commandsEnabled,
    diagnostics: input.diagnostics.map(value => inventoryText(value, 4096, "Native skill inventory diagnostic is invalid.")),
  };
  if (!result.cwd || new TextEncoder().encode(JSON.stringify(result)).byteLength > 2 * 1024 * 1024) throw new Error("Native skill inventory response is invalid.");
  return result;
}

/** The native skill parser excludes leading non-skill commands and local execution.
 * The displayed $ selector inserts /skill:name, which the native parser also
 * recognizes mid-prompt. It invokes one skill; additional tokens are references. */
export function skillInsertionIssue(before: string, after = ""): string | undefined {
  const candidate = `${before}/skill:__selected_skill__ ${after}`.trimStart();
  if (candidate.startsWith("/") && !candidate.startsWith("/skill:")) return "A skill invocation cannot be nested inside another leading slash command.";
  if (candidate.startsWith("!") || /^\${1,2}(?:\s|$)/.test(candidate)) return "A skill invocation cannot be nested inside a native local-execution command.";
  if (/(?:^|\s)\/skill:[^\s]+/.test(before)) return "Native OMP invokes the first skill token. Remove the earlier invocation before selecting another skill.";
  return undefined;
}
