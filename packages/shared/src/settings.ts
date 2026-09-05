import type { ModelInfo } from "./protocol";

export interface OmpComposerModel extends Omit<ModelInfo, "authenticated"> {
  /** Older capability endpoints do not report authentication or availability. */
  authenticated?: boolean;
  defaultThinkingLevel?: string;
  effectiveDefaultThinkingLevel?: string;
}
export interface OmpComposerCatalog {
  cwd: string | null;
  models: OmpComposerModel[];
  default: {
    model: OmpComposerModel | null;
    thinkingLevel?: string;
    effectiveThinkingLevel?: string;
    source: "configured-role" | "native-fallback" | "unavailable" | "unknown-older-host";
  };
  /** Metadata only. Native session startup can load additional extension models. */
  resolution: "native-registry-preview" | "legacy-capabilities";
}

export type SettingsScope = "global" | "project";
export type SettingJson = null | boolean | number | string | SettingJson[] | { [key: string]: SettingJson };
export type SettingValueSchema = (
  | { kind: "string" | "number" | "boolean" | "json" }
  | { kind: "enum"; values: string[] }
  | { kind: "array"; item: SettingValueSchema }
  | { kind: "map"; value: SettingValueSchema }
  | { kind: "object"; fields: Record<string, { schema: SettingValueSchema; optional?: boolean }> }
  | { kind: "union"; alternatives: SettingValueSchema[] }) & {
    writeOnly?: boolean;
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    exclusiveMaximum?: number;
    description?: string;
  };
export interface OmpSettingDescriptor {
  path: string;
  type: "boolean" | "number" | "string" | "enum" | "array" | "record";
  label: string;
  description?: string;
  metadataSource: "native-ui" | "schema-path";
  tab: string;
  group: string;
  advanced: boolean;
  warning?: string;
  condition?: string;
  credential: boolean;
  defaultValue?: SettingJson;
  schema: SettingValueSchema;
  control: "toggle" | "number" | "text" | "secret" | "select" | "ordered-list" | "list" | "record";
  options?: Array<{ value: string; label: string; description?: string }>;
  dynamicOptions?: "runtime";
  scopes: SettingsScope[];
  applicability: "native-runtime" | "native-terminal" | "host-configuration" | "native-internal";
  application: "next-session" | "terminal-only";
  source: { version: "18.1.10"; commit: string; file: string };
}
export interface OmpSettingsCatalog {
  version: "18.1.10";
  sourceCommit: string;
  settings: OmpSettingDescriptor[];
  groups: Record<string, string[]>;
  tabs: Array<{ id: string; label: string; icon: string }>;
  extensionSettings: "not-in-core-schema";
}
export interface OmpSettingState {
  path: string;
  effective?: SettingJson;
  global?: SettingJson;
  project?: SettingJson;
  configured: boolean;
  globalConfigured: boolean;
  projectConfigured: boolean;
  credential: boolean;
  /** Effective origin is unknown when native overlays/normalization differ. */
  origin: "default" | "global" | "project" | "runtime" | "native-overlay-or-normalization";
}
export interface OmpSettingsSnapshot {
  revision: string;
  cwd: string;
  entries: OmpSettingState[];
  sources: { globalPath: string; projectWritePath: string; projectRead: "native-capability-merged"; overlays: "native-process-configuration" };
  mutationEffects: "new-sessions-read-updated-config";
}
export interface OmpSettingOptions {
  path: string;
  options: Array<{ value: string; label: string; description?: string }>;
  source: "native-static" | "native-theme-registry" | "native-thinking-selectors" | "native-composer-builtins";
  extensionCoverage: "not-applicable" | "requires-session-registry";
}
export interface OmpSettingsMutation {
  expectedRevision: string;
  scope: SettingsScope;
  path: string;
  operation: "set" | "reset";
  value?: SettingJson;
}
export type OmpSettingsErrorCode = "invalid-setting" | "invalid-value" | "conflict" | "read-failed" | "write-failed" | "unsupported";

export interface OmpModelCapabilities {
  provider: string;
  id: string;
  api: string;
  name: string;
  contextWindow: number | null;
  maxTokens: number | null;
  input: string[];
  reasoning: boolean;
  thinkingSelectors: string[];
  serviceTierOptions: Record<string, string[]>;
  thinking?: {
    mode: string; efforts: string[]; defaultLevel?: string; effortMap?: Record<string, string>;
    supportsDisplay?: boolean; prefixBinding?: boolean; effortRouting?: Record<string, string>;
    effortBudgets?: Record<string, number>; suppressWhenOff?: boolean; requiresEffort?: boolean;
  };
  supportsTools: boolean;
  supportsComputerUse?: boolean;
  capabilities: Record<string, SettingJson>;
  /** Native compat is data, not a promise each provider honors each stream option. */
  compatibility: Record<string, SettingJson>;
  settingsPaths: string[];
  excludedSensitiveFields: string[];
  unmappedCapabilityFields: string[];
}
export interface OmpSessionControls {
  revision: string;
  sessionId: string;
  model: { provider: string; id: string } | null;
  thinkingLevel?: string;
  serviceTiers: Record<string, string | undefined>;
  capabilities: OmpModelCapabilities | null;
  settings: OmpSettingState[];
  overrides: string[];
  runtimeMutablePaths: string[];
  persistence: "native-session-model-thinking-tiers; runtime-settings-until-dispose";
}
export type OmpSessionControlMutation = { expectedRevision: string } & (
  | { operation: "model"; model: { provider: string; id: string } }
  | { operation: "thinking"; level?: string }
  | { operation: "service-tier"; family: "openai" | "anthropic" | "google"; tier?: "auto" | "default" | "flex" | "scale" | "priority" }
  | { operation: "override"; path: string; value: SettingJson }
  | { operation: "clear-override"; path: string }
);

export type ModelDefinitionPath = Array<string | number>;
export interface OmpModelDefinitionsCatalog {
  version: "18.1.10";
  sourceCommit: string;
  schema: SettingValueSchema;
  sourceFile: string;
  validator: "native-models-config-schema-and-provider-validation";
  rules: string[];
}
export interface OmpModelDefinitionsSnapshot {
  revision: string;
  sourcePath: string;
  writePath: string;
  format: "yml" | "yaml" | "legacy-json" | "missing";
  document: Record<string, SettingJson>;
  concealed: Array<{ path: ModelDefinitionPath; configured: boolean }>;
  unsupportedPaths: ModelDefinitionPath[];
  application: "discovery-refresh-and-new-sessions";
}
export interface OmpModelDefinitions {
  catalog: OmpModelDefinitionsCatalog;
  snapshot: OmpModelDefinitionsSnapshot;
}
export interface OmpModelDefinitionsMutation {
  expectedRevision: string;
  /** Compound set operations preserve existing concealed fields. Explicit
   * remove operations are required to clear a concealed field. */
  changes: Array<
    | { path: ModelDefinitionPath; operation: "set"; value: SettingJson }
    | { path: ModelDefinitionPath; operation: "remove" }
  >;
}
