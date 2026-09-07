import type { OmpSettingsMutation, OmpSettingsSnapshot, OmpSettingState, SettingsScope, SettingJson } from "@agent-desktop/shared";

const DISABLED_EXTENSIONS = "disabledExtensions";

export interface SkillToggleState {
  valid: true;
  name: string;
  disabled: boolean;
  scopedDisabled: boolean;
  masterEnabled: boolean;
  commandsEnabled: boolean;
  scope: SettingsScope;
  scopeConfigured: boolean;
  effectiveDisabledExtensions: string[];
  overriddenByProject: boolean;
  warning?: string;
}

function invalid(message: string): never { throw new Error(`Invalid native skill settings snapshot: ${message}`); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function array(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === "string" && item.length > 0 && !item.includes("\0"))) invalid(`${label} must be an array of strings`);
  return [...value] as string[];
}
function validateName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !name || name.trim() !== name || /\s|[\u0000-\u001f\u007f]/.test(name)) invalid("skill name is invalid");
}
function validateScope(scope: unknown): asserts scope is SettingsScope {
  if (scope !== "global" && scope !== "project") invalid("scope is invalid");
}
function validateSnapshot(snapshot: OmpSettingsSnapshot): void {
  if (!record(snapshot) || typeof snapshot.revision !== "string" || !snapshot.revision || typeof snapshot.cwd !== "string" || !Array.isArray(snapshot.entries)
    || !record(snapshot.sources) || typeof snapshot.sources.globalPath !== "string" || typeof snapshot.sources.projectWritePath !== "string"
    || snapshot.sources.projectRead !== "native-capability-merged" || snapshot.sources.overlays !== "native-process-configuration"
    || snapshot.mutationEffects !== "new-sessions-read-updated-config") invalid("snapshot shape is unsupported");
  for (const item of snapshot.entries) {
    if (!record(item) || typeof item.path !== "string" || typeof item.configured !== "boolean" || typeof item.globalConfigured !== "boolean"
      || typeof item.projectConfigured !== "boolean" || typeof item.credential !== "boolean" || !["default", "global", "project", "runtime", "native-overlay-or-normalization"].includes(item.origin)) invalid("entry shape is unsupported");
  }
}
function entry(snapshot: OmpSettingsSnapshot, path: string): OmpSettingState {
  validateSnapshot(snapshot);
  const found = snapshot.entries.find(item => record(item) && item.path === path);
  if (!found) invalid(`missing ${path}`);
  return found;
}
function bool(state: OmpSettingState, label: string): boolean {
  if (typeof state.effective !== "boolean") invalid(`${label} is not boolean`);
  return state.effective;
}
function effectiveDisabled(state: OmpSettingState): string[] { return array(state.effective, "disabledExtensions"); }
function scopedDisabled(state: OmpSettingState, scope: SettingsScope): { values: string[]; configured: boolean } {
  const value = scope === "global" ? state.global : state.project;
  if (state[scope === "global" ? "globalConfigured" : "projectConfigured"]) return { values: array(value, `${scope} disabledExtensions`), configured: true };
  return { values: scope === "global" ? [] : effectiveDisabled(state), configured: false };
}
function unique(values: string[]): string[] { return [...new Set(values)]; }

export function skillToggleState(snapshot: OmpSettingsSnapshot, name: string, scope: SettingsScope = "project"): SkillToggleState {
  validateName(name); validateScope(scope); validateSnapshot(snapshot);
  const enabled = entry(snapshot, "skills.enabled");
  const commands = entry(snapshot, "skills.enableSkillCommands");
  const disabled = entry(snapshot, DISABLED_EXTENSIONS);
  const scoped = scopedDisabled(disabled, scope);
  const key = `skill:${name}`;
  const projectOverride = scope === "global" && disabled.projectConfigured;
  const warnings = projectOverride ? ["A project disabledExtensions value overrides this global change for the selected project."] : [];
  if (disabled.origin === "runtime" || disabled.origin === "native-overlay-or-normalization") warnings.push("The effective disabledExtensions value comes from a native runtime or overlay; persisted edits may not change this session.");
  return {
    valid: true, name, disabled: effectiveDisabled(disabled).includes(key), scopedDisabled: scoped.values.includes(key), masterEnabled: bool(enabled, "skills.enabled"),
    commandsEnabled: bool(commands, "skills.enableSkillCommands"), scope, scopeConfigured: scoped.configured,
    effectiveDisabledExtensions: unique(effectiveDisabled(disabled)), overriddenByProject: projectOverride,
    ...(warnings.length ? { warning: warnings.join(" ") } : {}),
  };
}

export function skillEnabledMutation(snapshot: OmpSettingsSnapshot, name: string, enabled: boolean, scope: SettingsScope = "project"): OmpSettingsMutation {
  validateName(name); validateScope(scope); validateSnapshot(snapshot);
  if (typeof enabled !== "boolean") invalid("enabled must be boolean");
  const disabled = entry(snapshot, DISABLED_EXTENSIONS);
  const scoped = scopedDisabled(disabled, scope);
  const key = `skill:${name}`;
  const values = unique(scoped.values).filter(item => item !== key);
  if (!enabled) values.push(key);
  return { expectedRevision: snapshot.revision, scope, path: DISABLED_EXTENSIONS, operation: "set", value: values as SettingJson };
}
