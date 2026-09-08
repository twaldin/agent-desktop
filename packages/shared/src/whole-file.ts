/** A literal file reference. The receiving host decides when and how to read it. */
export interface WholeFileAttachment {
  id: string;
  /** UTF-16 position in authored draft text. File atoms consume no text characters. */
  textOffset?: number;
  source: {
    kind: "file";
    hostId: string;
    path: string;
  };
}

/** Application transport bound, not a Codex/provider capability claim. */
export const MAX_WHOLE_FILE_ATTACHMENTS = 100;

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) throw new Error("Invalid whole-file attachment.");
  return value as Record<string, unknown>;
}

function label(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.length || value.length > maximum || /[\x00-\x1f\x7f]/.test(value))
    throw new Error("Invalid whole-file source.");
  return value;
}

function canonicalAbsolutePath(value: unknown): string {
  const path = label(value, 16_384);
  if (!path.startsWith("/") || path === "/" || path.includes("//") || path.endsWith("/")
    || path.split("/").some(part => part === "." || part === ".."))
    throw new Error("A canonical absolute whole-file source path is required.");
  return path;
}

/** File references may name another host. They grant no filesystem access. */
export function parseWholeFileAttachments(value: unknown, textLength?: number): WholeFileAttachment[] {
  if (!Array.isArray(value) || value.length > MAX_WHOLE_FILE_ATTACHMENTS)
    throw new Error(`A draft supports at most ${MAX_WHOLE_FILE_ATTACHMENTS} whole-file attachments.`);
  if (textLength !== undefined && (!Number.isSafeInteger(textLength) || textLength < 0)) throw new Error("Invalid whole-file text length.");
  const ids = new Set<string>(), sources = new Set<string>();
  const result: WholeFileAttachment[] = [];
  for (const raw of value) {
    const hasTextOffset = !!raw && typeof raw === "object" && !Array.isArray(raw) && Object.hasOwn(raw, "textOffset");
    const item = record(raw, hasTextOffset ? ["id", "textOffset", "source"] : ["id", "source"]);
    const source = record(item.source, ["kind", "hostId", "path"]);
    const id = label(item.id, 200), hostId = label(source.hostId, 200), path = canonicalAbsolutePath(source.path);
    if (source.kind !== "file") throw new Error("Invalid whole-file source.");
    const textOffset = item.textOffset;
    if (hasTextOffset && (!Number.isSafeInteger(textOffset) || (textOffset as number) < 0
      || textLength !== undefined && (textOffset as number) > textLength))
      throw new Error("A whole-file text offset must be a valid UTF-16 position in the authored draft text.");
    if (ids.has(id)) throw new Error("Whole-file attachment identities must be distinct.");
    ids.add(id);
    const sourceIdentity = `${hostId}\0${path}`;
    if (sources.has(sourceIdentity)) throw new Error("Whole-file attachment sources must be distinct.");
    sources.add(sourceIdentity);
    result.push({ id, ...(hasTextOffset ? { textOffset: textOffset as number } : {}), source: { kind: "file", hostId, path } });
  }
  return result;
}

export function copyWholeFileAttachments(value: readonly WholeFileAttachment[]): WholeFileAttachment[] {
  return value.map(item => ({ id: item.id, ...(item.textOffset !== undefined ? { textOffset: item.textOffset } : {}), source: { kind: "file", hostId: item.source.hostId, path: item.source.path } }));
}

export function sameWholeFileAttachments(left?: readonly WholeFileAttachment[], right?: readonly WholeFileAttachment[]): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((item, index) => {
    const other = right[index]!;
    return item.id === other.id && item.textOffset === other.textOffset && item.source.kind === other.source.kind
      && item.source.hostId === other.source.hostId && item.source.path === other.source.path;
  });
}

export function hasInlineFileIntent(value:unknown):boolean {
 if(!value||typeof value!=="object")return false;
 const command=value as Record<string,unknown>;
 const draft=command.type==='draft.put'&&command.draft&&typeof command.draft==='object'?command.draft as Record<string,unknown>:command;
 return Array.isArray(draft.wholeFileAttachments)&&draft.wholeFileAttachments.some(file=>file&&typeof file==='object'&&Object.hasOwn(file,'textOffset'));
}
