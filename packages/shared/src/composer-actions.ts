import type { WorkspaceTarget } from "./workspace";

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
