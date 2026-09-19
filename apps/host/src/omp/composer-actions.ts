import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentSession, Extension, Settings } from "@oh-my-pi/pi-coding-agent";
import { discoverPromptTemplates, discoverSessionExtensionPaths } from "@oh-my-pi/pi-coding-agent/sdk";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { loadSlashCommands } from "@oh-my-pi/pi-coding-agent/extensibility/slash-commands";
import { discoverCustomCommands } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/loader";
import { withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BUILTIN_SLASH_COMMANDS_INTERNAL, lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { buildArgumentCompletions, buildMcpArgumentCompletions } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-completions";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { getInternalUrlSuggestions } from "@oh-my-pi/pi-coding-agent/modes/internal-url-autocomplete";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { CombinedAutocompleteProvider, type AutocompleteItem } from "@oh-my-pi/pi-tui";
import type { ComposerAction, ComposerActionsCatalog, ComposerAvailability, ComposerCompletionQuery, ComposerCompletions, NativeSkillInventory } from "@agent-desktop/shared";

export type NativeComposerCatalog = Omit<ComposerActionsCatalog, "hostId" | "target">;
export type NativeComposerCompletions = Omit<ComposerCompletions, "hostId" | "target">;
export type NativeSkillInventoryCatalog = Omit<NativeSkillInventory, "hostId" | "target">;
const MAX_CATALOG_ENTRIES = 2048;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bounded = (value: unknown, limit = 4096) => typeof value === "string" ? value.slice(0, limit) : "";

/** These reviewed native text handlers neither change the owned native identity
 * nor require a TUI controller. Others remain visible with a concrete gap. */
const supportedBuiltins = new Set(["force", "model", "switch", "fast", "skillful", "computer", "prewalk", "rename", "jobs", "tools", "context", "changelog", "dump"]);
const identityCommands = new Set(["new", "fresh", "clear", "drop", "handoff", "resume", "branch", "fork", "tree", "move", "wt", "quit", "join", "leave"]);
export function builtinAvailability(name: string, args?: string): { availability: ComposerAvailability; reason?: string } {
  if (name === "export") return { availability: "executable" };
  if (supportedBuiltins.has(name)) return { availability: "executable" };
  // These commands use the owning Plan controller and its durable decisions.
  if (name === "plan" || name === "plan-review") return { availability: "executable" };
  if (name === "mcp") {
    if (args === undefined) return {availability:"partial",reason:"Native help, live resource/prompt/notification lists, runtime reload, server reconnect and OAuth reauthorization are connected. Other subcommands retain their native integration requirements."};
    const verb=args.trim().split(/\s+/,1)[0]?.toLowerCase();
    if (!verb || ["reload", "help", "resources", "prompts", "notifications", "reconnect", "reauth"].includes(verb)) return {availability:"executable"};
    return {availability:"pending",reason:"This MCP operation requires its remaining native manager, configuration or interactive authorization bridge."};
  }
  if (name === "btw") return { availability: "partial", reason: "Ask a side question using this conversation’s context." };
  if (name === "session") {
    if (args === undefined) return { availability: "partial", reason: "Session info is connected. Deletion and account pin commands require the owning desktop lifecycle/account bridge." };
    if (!args.trim() || args.trim() === "info") return { availability: "executable" };
    return { availability: "pending", reason: "Use session/account controls until native deletion and pin command receipts are connected." };
  }
  if (identityCommands.has(name)) return { availability: "pending", reason: "This command can change native session/file ownership or the owning process. Its desktop ownership transition is not connected." };
  if (name === "usage") return { availability: "pending", reason: "Native usage/reset output and explicit reset-credit confirmation are not connected to this command. Account controls remain available." };
  if (["login", "logout", "security"].includes(name)) return { availability: "pending", reason: "Use the desktop account/permission controls; the native command's interactive policy and durable receipt are not connected." };
  if (["plugins", "marketplace", "reload-plugins", "ssh"].includes(name)) return { availability: "pending", reason: "Native configuration changes require coordinated registry reload and interaction handling before this command can execute." };
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
    ...(command.name === "btw" ? { desktopAction: "side-chat" as const } : {}),
  }));
}

/** A desktop /btw route is valid only while native dispatch still resolves the
 * exact command name to the pinned builtin. Shadowing rows remain visible, but
 * must never be converted into a different side-chat operation. */
export function hasNativeBtwComposerWinner(catalog: NativeComposerCatalog): boolean {
  const builtin = catalog.commands.find(row => row.id === "builtin:btw");
  return builtin?.name === "btw" && builtin.source.kind === "builtin"
    && builtin.desktopAction === "side-chat" && builtin.availability === "partial";
}

/** Turn the exact native @ completion value into an owner-host path only after
 * the pinned provider has identified a regular file. Its insertion syntax is
 * intentionally retained for the editor; this metadata is for structured file
 * ownership, where directories and ambiguous open quotes must not be treated
 * as attachable files. */
async function completionFilePath(cwd: string, value: string): Promise<string | undefined> {
  if (!value.startsWith("@")) return;
  let candidate = value.slice(1);
  if (candidate.startsWith('"')) {
    if (!candidate.endsWith('"') || candidate.length < 2) return;
    candidate = candidate.slice(1, -1);
  }
  if (!candidate || candidate.endsWith("/")) return;
  if (candidate === "~") candidate = homedir();
  else if (candidate.startsWith("~/")) candidate = path.join(homedir(), candidate.slice(2));
  const absolute = path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(cwd, candidate);
  try {
    return (await stat(absolute)).isFile() ? absolute : undefined;
  } catch {
    return;
  }
}

function finish(cwd: string, commands: ComposerAction[], skills: ComposerAction[], diagnostics: string[]): NativeComposerCatalog {
  if (commands.length + skills.length > MAX_CATALOG_ENTRIES) throw new Error(`Native composer catalog exceeds ${MAX_CATALOG_ENTRIES} entries. Narrow the configured native extension roots.`);
  const referenceSchemes = InternalUrlRouter.instance().completionSchemes().filter(value => /^[a-z][a-z0-9+.-]*$/.test(value)).slice(0, 100);
  const result = { protocolVersion: 1 as const, cwd, commands, skills, referenceSchemes, diagnostics: diagnostics.map(value => bounded(value)) };
  if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) throw new Error("Native composer catalog exceeds its 2 MiB response limit.");
  return { ...result, revision: hash(result) };
}

function skillRows(skills: AgentSession["skills"], enabled: boolean): ComposerAction[] {
  // File identity survives edits to frontmatter; catalog revisions still track names and availability.
  return skills.map(skill => ({ id: `skill:${hash(skill.filePath)}`, name: skill.name,
    description: bounded(skill.description), insertText: `/skill:${skill.name} `,
    source: { kind: "skill", label: bounded(skill.source), path: skill.filePath },
    availability: enabled ? "executable" : "disabled", reason: enabled ? undefined : "Native skills.enableSkillCommands is disabled for this scope.", argumentCompletions: false }));
}

/** Inventory discovery deliberately overrides only the master and per-name
 * skill gates. Provider/plugin/root selection remains exactly as configured. */
export async function discoverSkillInventory(cwd: string, settings: Settings): Promise<NativeSkillInventoryCatalog> {
  return withActiveSettings(settings, async () => {
    const configuredDisabled = settings.get("disabledExtensions");
    const disabledNames = new Set(configuredDisabled.filter(value => value.startsWith("skill:")).map(value => value.slice(6)));
    const extensionRoots = { explicit: [], mode: "merge" as const, configured: settings.get("extensions"), configuredLevel: settings.extensionsSourceLevel() };
    const result = await loadSkills({ cwd, ...settings.getGroup("skills"), enabled: true,
      disabledExtensions: configuredDisabled.filter(value => !value.startsWith("skill:")), extensionRoots });
    const enabled = settings.get("skills.enabled"), commandsEnabled = settings.get("skills.enableSkillCommands");
    const skills = result.skills.map(skill => {
      const disabledByName = disabledNames.has(skill.name);
      const executable = enabled && commandsEnabled && !disabledByName;
      const reason = !enabled ? "Native skills.enabled is disabled for this scope."
        : disabledByName ? "This native skill is disabled by name for this scope."
        : !commandsEnabled ? "Native skills.enableSkillCommands is disabled for this scope." : undefined;
      return { ...skillRows([skill], executable)[0]!, disabledByName, ...(reason ? { reason } : {}) };
    });
    if (skills.length > MAX_CATALOG_ENTRIES) throw new Error(`Native skill inventory exceeds ${MAX_CATALOG_ENTRIES} entries. Narrow the configured native skill roots.`);
    const base = { protocolVersion: 1 as const, cwd, skills, enabled, commandsEnabled,
      diagnostics: result.warnings.map(warning => bounded(`${warning.skillPath}: ${warning.message}`)) };
    if (Buffer.byteLength(JSON.stringify(base)) > 2 * 1024 * 1024) throw new Error("Native skill inventory exceeds its 2 MiB response limit.");
    return { ...base, revision: hash(base) };
  });
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

export async function composerCompletions(catalog: NativeComposerCatalog, query: ComposerCompletionQuery, session?: AgentSession, mcpManager?: MCPManager): Promise<NativeComposerCompletions> {
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
    } else if (!command && !session?.customCommands.some(command => command.command.name === query.commandName)) {
      const spec = lookupBuiltinSlashCommand(query.commandName);
      if (spec?.name === "mcp" && spec.subcommands && session) {
        // Pinned native completer reads only ctx.mcpManager and its own scoped
        // configuration APIs. It does not render or invoke a TUI controller.
        const runtime = { ctx: { mcpManager } } as TuiSlashCommandRuntime;
        items = await buildMcpArgumentCompletions(spec.subcommands, runtime)(query.query) ?? [];
      } else if (spec?.subcommands) items = await buildArgumentCompletions(spec.subcommands)(query.query) ?? [];
      else if (catalog.commands.some(row => row.name === query.commandName && row.argumentCompletions)) diagnostics.push("This command callback is not loaded in the selected native session.");
    }
    prefix = query.query;
  } else throw new Error("Unsupported native completion kind.");
  if (!Array.isArray(items) || items.length > 1000) throw new Error("Native completion returned too many or invalid entries.");
  const selected = await Promise.all(items.slice(0, limit).map(async (item, index) => {
    if (!item || typeof item.value !== "string" || item.value.length > 16_384 || /[\0\r\n]/.test(item.value) || typeof item.label !== "string") throw new Error("Native completion returned an invalid insertion.");
    const insertText = query.kind === "file" ? provider.applyCompletion([prefix], 0, prefix.length, item, prefix).lines.join("\n") : `${item.value}${query.kind === "reference" ? " " : ""}`;
    const kind = query.kind === "file" ? (item.value.replace(/"$/, "").endsWith("/") ? "directory-reference" as const : "file-reference" as const) : query.kind === "reference" ? "native-reference" as const : "command-argument" as const;
    const filePath = kind === "file-reference" ? await completionFilePath(catalog.cwd, item.value) : undefined;
    return { id: hash([query.kind, item.value, index]), label: bounded(item.label, 16_384), description: bounded(item.description), insertText, kind,
      ...(filePath === undefined ? {} : { path: filePath }) };
  }));
  return { protocolVersion: 1, cwd: catalog.cwd, revision: catalog.revision, items: selected, truncated: items.length > limit, diagnostics };
}
