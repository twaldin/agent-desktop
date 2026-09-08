import type { ComposerAction, ComposerActionsCatalog, ComposerCompletions } from "../../../../packages/shared/src/composer-actions";
import { skillInsertionIssue } from "../../../../packages/shared/src/composer-actions";
import type { WorkspaceTarget } from "../../../../packages/shared/src/workspace-protocol";

export interface ComposerToken { kind: "command" | "skill" | "file" | "reference" | "command-argument"; start: number; end: number; caret: number; query: string; commandName?: string }
/** Completion owns one whitespace-delimited token, never a selection, email,
 * escaped sigil, code span, or another slash command's arguments. */
export function composerToken(text: string, start: number, end = start, catalog?: ComposerActionsCatalog): ComposerToken | undefined {
  if (start !== end || start < 0 || start > text.length) return;
  const before = text.slice(0, start);
  const invocation = /^\s*\/([^\s]+)[ \t]+([^\r\n]*)$/.exec(before);
  if (invocation) {
    const name = invocation[1]!;
    const command = catalog?.commands.find(entry => (entry.name === name || entry.aliases?.includes(name)) && available(entry));
    if (command?.argumentCompletions) return { kind: "command-argument", start: start - invocation[2]!.length, end: start, caret: start, query: invocation[2]!, commandName: name };
  }
  const reference = /(?:^|[\s"'`(<=])([a-z][a-z0-9+.-]*:\/{1,2}[^\s"'`()<>]*)$/i.exec(before);
  if (reference && catalog?.referenceSchemes?.includes(reference[1]!.split(":")[0]!.toLowerCase())) {
    const value = reference[1]!;
    return { kind: "reference", start: start - value.length, end: start, caret: start, query: value };
  }
  // Native OMP quotes references containing spaces as @"path to/file".
  const quoted = /(?:^|[\s(])(@"[^"\r\n]*)$/.exec(before);
  if (quoted) {
    const from = start - quoted[1]!.length;
    if ((before.slice(0, from).match(/`/g)?.length ?? 0) % 2) return;
    const closing = text.indexOf('"', start);
    return { kind: "file", start: from, end: closing < 0 ? start : closing + 1, caret: start, query: quoted[1]!.slice(1) };
  }
  const match = /(?:^|[\s(])([@$][^\s@$]*|\/[^\s]*)$/.exec(before);
  if (!match) return;
  const token = match[1]!, from = start - token.length;
  if (token[0] === "/" && text.slice(0, from).trim()) return;
  // Keep inline/fenced code literal; do not reinterpret URLs or paths.
  if ((before.slice(0, from).match(/`/g)?.length ?? 0) % 2) return;
  const tail = /^[^\s)]*/.exec(text.slice(start))?.[0] ?? "";
  return { kind: token[0] === "/" ? "command" : token[0] === "$" ? "skill" : "file", start: token[0] === "/" ? 0 : from, end: start + tail.length, caret: start, query: token.slice(1) };
}
export function replaceComposerToken(text: string, token: ComposerToken, insertion: string): { text: string; caret: number } {
  const suffix = text.slice(token.end);
  // Native insertion owns quoting/prefixes. Only avoid a doubled separator at
  // the existing suffix; never reinterpret file contents or a skill name.
  const value = /\s$/.test(insertion) && /^\s/.test(suffix) ? insertion.replace(/\s+$/, "") : insertion;
  return { text: text.slice(0, token.start) + value + suffix, caret: token.start + value.length };
}
export interface ComposerAppAction { id: string; name: string; description: string; icon: "sideChat" | "archive" | "folder" | "terminal" | "compose" | "refresh" | "more"; reason?: string; run(): void | Promise<void> }
export interface ComposerSuggestion { id: string; label: string; description: string; origin: string; insertText: string; icon: ComposerAppAction["icon"] | "skill" | "file" | "command"; disabled?: string; action?: ComposerAppAction; native?: ComposerAction; source?: { hostId: string; path: string } }
export function targetIdentity(target?: WorkspaceTarget): string { return target ? "sessionId" in target ? `session:${target.sessionId}` : `project:${target.projectId}` : "default"; }
export function assertComposerOwner<T extends Pick<ComposerActionsCatalog, "hostId" | "target" | "protocolVersion"> | null>(value: T, hostId: string, target?: WorkspaceTarget): asserts value is NonNullable<T> {
  if (!value) throw new Error("Update the owning host to load native commands and skills.");
  if (value.protocolVersion !== 1 || value.hostId !== hostId || targetIdentity(value.target) !== targetIdentity(target)) throw new Error("The completion response belongs to a different host or workspace. Refresh this menu.");
}
const available = (entry: ComposerAction) => entry.availability === "executable" || entry.availability === "partial";
export function catalogSuggestions(catalog: ComposerActionsCatalog | undefined, token: ComposerToken, text: string, app: ComposerAppAction[]): ComposerSuggestion[] {
  const query = token.query.toLocaleLowerCase();
  const matches = (name: string, aliases: string[] = []) => [name, ...aliases].some(value => value.toLocaleLowerCase().includes(query));
  const native = token.kind === "skill" ? catalog?.skills ?? [] : token.kind === "command" ? catalog?.commands ?? [] : [];
  const issue = token.kind === "skill" ? skillInsertionIssue(text.slice(0, token.start), text.slice(token.end)) : undefined;
  const result: ComposerSuggestion[] = native.filter(entry => matches(entry.name, entry.aliases)).map(entry => ({
    id: `native:${entry.id}`, label: entry.name, description: entry.reason ?? entry.description, origin: entry.source.label,
    insertText: entry.insertText, icon: token.kind === "skill" ? "skill" : "command", native: entry,
    disabled: issue ?? (!available(entry) ? entry.reason ?? `This command is ${entry.availability}.` : undefined),
  }));
  if (token.kind === "command") result.unshift(...app.filter(entry => matches(entry.name, [entry.id])).map(action => ({ id: `app:${action.id}`, label: action.name, description: action.description, origin: "App", insertText: `/${action.id}`, icon: action.icon, disabled: action.reason, action })));
  return result.sort((a, b) => Number(!a.label.toLocaleLowerCase().startsWith(query)) - Number(!b.label.toLocaleLowerCase().startsWith(query)));
}
export function fileSuggestions(result: ComposerCompletions): ComposerSuggestion[] {
  return result.items.map(item => ({ id: `file:${item.id}`, label: item.label, description: item.description ?? (item.kind === "directory-reference" ? "Folder reference" : "File reference"), origin: item.kind === "command-argument" || item.kind === "native-reference" ? "OMP" : "Files", insertText: item.insertText, icon: item.kind === "command-argument" ? "command" : item.kind === "directory-reference" ? "folder" : "file", ...(item.path === undefined ? {} : { source: { hostId: result.hostId, path: item.path } }) }));
}
export function nextSuggestion(items: ComposerSuggestion[], current: string | undefined, direction: 1 | -1): string | undefined {
  const enabled = items.filter(item => !item.disabled); if (!enabled.length) return;
  const index = enabled.findIndex(item => item.id === current);
  return enabled[index < 0 ? direction === 1 ? 0 : enabled.length - 1 : (index + direction + enabled.length) % enabled.length]!.id;
}
