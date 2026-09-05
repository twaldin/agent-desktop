import { createHash } from "node:crypto";
import type { AgentSession, Extension, Settings } from "@oh-my-pi/pi-coding-agent";
import { discoverPromptTemplates, discoverSessionExtensionPaths } from "@oh-my-pi/pi-coding-agent/sdk";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { loadSlashCommands } from "@oh-my-pi/pi-coding-agent/extensibility/slash-commands";
import { discoverCustomCommands } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/loader";
import { withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BUILTIN_SLASH_COMMANDS_INTERNAL, lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { buildArgumentCompletions } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-completions";
import { getInternalUrlSuggestions } from "@oh-my-pi/pi-coding-agent/modes/internal-url-autocomplete";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { CombinedAutocompleteProvider, type AutocompleteItem } from "@oh-my-pi/pi-tui";
import type { ComposerAction, ComposerActionsCatalog, ComposerAvailability, ComposerCompletionQuery, ComposerCompletions } from "@agent-desktop/shared";

export type NativeComposerCatalog = Omit<ComposerActionsCatalog, "hostId" | "target">;
export type NativeComposerCompletions = Omit<ComposerCompletions, "hostId" | "target">;
const MAX_CATALOG_ENTRIES = 2048;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bounded = (value: unknown, limit = 4096) => typeof value === "string" ? value.slice(0, limit) : "";

/** These reviewed native text handlers neither change the owned native identity
 * nor require a TUI controller. Others remain visible with a concrete gap. */
const supportedBuiltins = new Set(["model", "switch", "fast", "skillful", "computer", "prewalk", "rename", "jobs", "tools", "context", "changelog", "dump"]);
const identityCommands = new Set(["new", "fresh", "clear", "drop", "handoff", "resume", "branch", "fork", "tree", "move", "wt", "quit", "join", "leave"]);
export function builtinAvailability(name: string, args?: string): { availability: ComposerAvailability; reason?: string } {
  if (supportedBuiltins.has(name)) return { availability: "executable" };
  if (name === "session") {
    if (args === undefined) return { availability: "partial", reason: "Session info is connected. Deletion and account pin commands require the owning desktop lifecycle/account bridge." };
    if (!args.trim() || args.trim() === "info") return { availability: "executable" };
    return { availability: "pending", reason: "Use session/account controls until native deletion and pin command receipts are connected." };
  }
  if (identityCommands.has(name)) return { availability: "pending", reason: "This command can change native session/file ownership or the owning process. Its desktop ownership transition is not connected." };
  if (name === "usage") return { availability: "pending", reason: "Native usage/reset output and explicit reset-credit confirmation are not connected to this command. Account controls remain available." };
  if (["login", "logout", "security"].includes(name)) return { availability: "pending", reason: "Use the desktop account/permission controls; the native command's interactive policy and durable receipt are not connected." };
  if (["plugins", "marketplace", "reload-plugins", "mcp", "ssh"].includes(name)) return { availability: "pending", reason: "Native configuration changes require coordinated registry reload and interaction handling before this command can execute." };
  const spec = lookupBuiltinSlashCommand(name);
  return { availability: "pending", reason: spec?.handle
    ? "This native text handler requires its remaining desktop lifecycle/output integration and acceptance before execution."
    : "The pinned command requires native TUI/application controls that are not connected to this dispatcher yet." };
}

function nativeBuiltinRows(): ComposerAction[] {
  return BUILTIN_SLASH_COMMANDS_INTERNAL.map(command => ({
    id: `builtin:${command.name}`, name: command.name, description: command.acpDescription ?? command.description,
    insertText: `/${command.name} `, aliases: command.aliases ? [...command.aliases] : undefined,
    source: { kind: "builtin", label: "Native OMP 18.1.10 registry" }, ...builtinAvailability(command.name),
    argumentHint: command.acpInputHint ?? command.inlineHint,
    subcommands: command.subcommands?.map(sub => ({ ...sub, ...builtinAvailability(command.name, sub.name) })),
    argumentCompletions: Boolean(command.subcommands?.length),
  }));
}

function finish(cwd: string, commands: ComposerAction[], skills: ComposerAction[], diagnostics: string[]): NativeComposerCatalog {
  if (commands.length + skills.length > MAX_CATALOG_ENTRIES) throw new Error(`Native composer catalog exceeds ${MAX_CATALOG_ENTRIES} entries. Narrow the configured native extension roots.`);
  const referenceSchemes = InternalUrlRouter.instance().completionSchemes().filter(value => /^[a-z][a-z0-9+.-]*$/.test(value)).slice(0, 100);
  const result = { protocolVersion: 1 as const, cwd, commands, skills, referenceSchemes, diagnostics: diagnostics.map(value => bounded(value)) };
  if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) throw new Error("Native composer catalog exceeds its 2 MiB response limit.");
  return { ...result, revision: hash(result) };
}

function skillRows(skills: AgentSession["skills"], enabled: boolean): ComposerAction[] {
  return skills.map(skill => ({ id: `skill:${hash([skill.name, skill.filePath])}`, name: skill.name,
    description: bounded(skill.description), insertText: `/skill:${skill.name} `,
    source: { kind: "skill", label: bounded(skill.source), path: skill.filePath },
    availability: enabled ? "executable" : "disabled", reason: enabled ? undefined : "Native skills.enableSkillCommands is disabled for this scope.", argumentCompletions: false }));
}

/** Read-only discovery: native path scanners and markdown loaders only. Executable
 * registration factories are never imported just to open a new-chat menu. */
export async function discoverComposerActions(cwd: string, agentDir: string, settings: Settings): Promise<NativeComposerCatalog> {
  return withActiveSettings(settings, async () => {
    const extensionRoots = { explicit: [], mode: "merge" as const, configured: settings.get("extensions"), configuredLevel: settings.extensionsSourceLevel() };
    const [skills, files, templates, extensions, custom] = await Promise.all([
      loadSkills({ cwd, ...settings.getGroup("skills"), disabledExtensions: settings.get("disabledExtensions"), extensionRoots }),
      loadSlashCommands({ cwd, extensionRoots }), discoverPromptTemplates(cwd, agentDir),
      discoverSessionExtensionPaths({}, cwd, settings), discoverCustomCommands({ cwd, agentDir }),
    ]);
    const commands = nativeBuiltinRows();
    for (const command of files) commands.push({ id: `file:${hash([command.name, command.source])}`, name: command.name, description: bounded(command.description), insertText: `/${command.name} `,
      source: { kind: "file-command", label: command.source }, availability: "executable", argumentCompletions: false });
    for (const command of templates) commands.push({ id: `template:${hash([command.name, command.source])}`, name: command.name, description: bounded(command.description), insertText: `/${command.name} `,
      source: { kind: "prompt-template", label: command.source }, availability: "executable", argumentCompletions: false });
    const reason = "Native registration code is not run by catalog queries. Command names and callbacks become available when an explicitly created session loads this module.";
    for (const file of extensions) commands.push({ id: `extension-module:${hash(file)}`, name: file, description: "Native extension module", insertText: "", source: { kind: "extension", label: "Discovered native extension", path: file }, availability: "pending", reason, argumentCompletions: false });
    for (const entry of custom.paths) commands.push({ id: `custom-module:${hash(entry.path)}`, name: entry.path, description: "Native TypeScript command module", insertText: "", source: { kind: "custom", label: entry.source, path: entry.path }, availability: "pending", reason, argumentCompletions: false });
    // Bundled custom command factories are also instantiated only by session setup.
    for (const name of ["green", "review"]) commands.push({ id: `custom:bundled:${name}`, name, description: "Native bundled custom command", insertText: `/${name} `,
      source: { kind: "custom", label: "Native bundled command", path: `bundled:${name}` }, availability: "executable", argumentCompletions: false });
    markShadows(commands);
    return finish(cwd, commands, skillRows(skills.skills, settings.get("skills.enableSkillCommands")), [
      ...skills.warnings.map(warning => `${warning.skillPath}: ${warning.message}`),
      ...(extensions.length || custom.paths.length ? [reason] : []),
      "MCP prompt registrations and native internal-resource completions are available from a loaded session; catalog queries do not start servers or tools.",
    ]);
  });
}

/** Keep every row, including collisions, while matching the existing dispatcher:
 * extension exact-name (last registered), custom exact-name (first), builtin,
 * file expansion then prompt template. Skills use their separate native parser. */
function markShadows(commands: ComposerAction[]): void {
  const active = new Map<string, ComposerAction>();
  const rank = (row: ComposerAction) => row.source.kind === "extension" ? 0 : row.source.kind === "custom" || row.source.kind === "mcp-prompt" ? 1 : row.source.kind === "builtin" ? 2 : row.source.kind === "file-command" ? 3 : 4;
  for (const row of [...commands].sort((a, b) => rank(a) - rank(b))) {
    if (!row.insertText) continue;
    const previous = active.get(row.name) ?? (active.get(row.name.split(":")[0]!)?.source.kind === "builtin" ? active.get(row.name.split(":")[0]!) : undefined);
    if (previous) { row.availability = "shadowed"; row.reason = `Native dispatch resolves /${row.name} to ${previous.source.label} (${previous.name}).`; }
    else { active.set(row.name, row); for (const alias of row.aliases ?? []) if (!active.has(alias)) active.set(alias, row); }
  }
}

export function sessionComposerActions(session: AgentSession, extensions: readonly Extension[]): NativeComposerCatalog {
  const commands: ComposerAction[] = [];
  for (const extension of [...extensions].reverse()) for (const command of extension.commands.values()) commands.push({
    id: `extension:${hash([extension.resolvedPath, command.name])}`, name: command.name, description: bounded(command.description), insertText: `/${command.name} `,
    source: { kind: "extension", label: extension.label ?? "Native extension", path: extension.resolvedPath }, availability: "executable", argumentCompletions: Boolean(command.getArgumentCompletions),
  });
  const mcp = new Set(session.mcpPromptCommands);
  for (const command of session.customCommands) commands.push({ id: `custom:${hash([command.resolvedPath, command.command.name])}`, name: command.command.name, description: bounded(command.command.description), insertText: `/${command.command.name} `,
    source: { kind: mcp.has(command) ? "mcp-prompt" : "custom", label: mcp.has(command) ? "Native MCP prompt" : `Native ${command.source} command`, path: command.resolvedPath }, availability: "executable", argumentCompletions: false });
  commands.push(...nativeBuiltinRows());
  for (const command of session.slashCommands) commands.push({ id: `file:${hash([command.name, command.source])}`, name: command.name, description: bounded(command.description), insertText: `/${command.name} `,
    source: { kind: "file-command", label: command.source }, availability: "executable", argumentCompletions: false });
  for (const command of session.promptTemplates) commands.push({ id: `template:${hash([command.name, command.source])}`, name: command.name, description: bounded(command.description), insertText: `/${command.name} `,
    source: { kind: "prompt-template", label: command.source }, availability: "executable", argumentCompletions: false });
  markShadows(commands);
  return finish(session.sessionManager.getCwd(), commands, skillRows(session.skills, session.skillsSettings?.enableSkillCommands === true), session.skillWarnings.map(warning => `${warning.skillPath}: ${warning.message}`));
}

export async function composerCompletions(catalog: NativeComposerCatalog, query: ComposerCompletionQuery, session?: AgentSession): Promise<NativeComposerCompletions> {
  if (query.catalogRevision && query.catalogRevision !== catalog.revision) throw new Error("The native composer catalog changed. Refresh the selected target before using this completion.");
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || typeof query.query !== "string" || query.query.length > 2048 || /[\0\r\n]/.test(query.query)) throw new Error("Invalid native completion query.");
  const diagnostics: string[] = [];
  let items: AutocompleteItem[] = [];
  let prefix = "";
  const provider = new CombinedAutocompleteProvider([], catalog.cwd);
  const signal = AbortSignal.timeout(2000);
  if (query.kind === "file") {
    const text = `@${query.query}`;
    const result = await provider.getSuggestions([text], 0, text.length, signal);
    if (signal.aborted) throw new Error("Native file completion timed out. Narrow the path prefix.");
    items = result?.items ?? []; prefix = result?.prefix ?? text;
  } else if (query.kind === "reference") {
    if (!session) diagnostics.push("Native internal-resource completions require a loaded session; no tools were started for this query.");
    else { const result = await getInternalUrlSuggestions(query.query, catalog.cwd, signal); items = result?.items ?? []; prefix = result?.prefix ?? query.query; }
  } else if (query.kind === "command-argument") {
    if (!query.commandName || query.commandName.length > 200 || /[\s\0]/.test(query.commandName)) throw new Error("Invalid native command name.");
    const command = session?.extensionRunner?.getCommand(query.commandName);
    if (command?.getArgumentCompletions) {
      try { items = await session!.extensionRunner!.runScoped(() => command.getArgumentCompletions!(query.query)) ?? []; }
      catch (error) { diagnostics.push(`Native argument completion failed: ${bounded(error instanceof Error ? error.message : error)}`); }
    } else {
      const spec = lookupBuiltinSlashCommand(query.commandName);
      if (spec?.subcommands) items = await buildArgumentCompletions(spec.subcommands)(query.query) ?? [];
      else if (catalog.commands.some(row => row.name === query.commandName && row.argumentCompletions)) diagnostics.push("This command callback is not loaded in the selected native session.");
    }
    prefix = query.query;
  } else throw new Error("Unsupported native completion kind.");
  if (!Array.isArray(items) || items.length > 1000) throw new Error("Native completion returned too many or invalid entries.");
  const selected = items.slice(0, limit).map((item, index) => {
    if (!item || typeof item.value !== "string" || item.value.length > 16_384 || /[\0\r\n]/.test(item.value) || typeof item.label !== "string") throw new Error("Native completion returned an invalid insertion.");
    const insertText = query.kind === "file" ? provider.applyCompletion([prefix], 0, prefix.length, item, prefix).lines.join("\n") : `${item.value}${query.kind === "reference" ? " " : ""}`;
    return { id: hash([query.kind, item.value, index]), label: bounded(item.label, 16_384), description: bounded(item.description), insertText,
      kind: query.kind === "file" ? (item.value.replace(/"$/, "").endsWith("/") ? "directory-reference" as const : "file-reference" as const) : query.kind === "reference" ? "native-reference" as const : "command-argument" as const };
  });
  return { protocolVersion: 1, cwd: catalog.cwd, revision: catalog.revision, items: selected, truncated: items.length > limit, diagnostics };
}
