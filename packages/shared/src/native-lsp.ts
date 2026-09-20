import type { SettingJson, SettingValueSchema } from './settings';
export type LspValues = Record<string, SettingJson>;
export interface NativeLspSource {
  id: string; path: string; kind: 'file' | 'marketplace'; scope: 'project' | 'user' | 'plugin';
  writable: boolean; exists: boolean; error?: string; servers: Record<string, LspValues>; idleTimeoutMs?: number;
}
export interface NativeLspServer {
  name: string; builtin: boolean; configured: boolean; effective: LspValues;
  sources: string[]; fieldSources: Record<string, string>;
  applicability: 'ready' | 'disabled' | 'missing-root' | 'missing-binary' | 'typescript-alternative' | 'invalid';
  rootMarkersMatch: boolean; resolvedCommand: string | null;
  runtimeClient?: 'Biome' | 'SwiftLint'; runtimePidArguments: boolean;
}
export interface NativeLspCatalog {
  revision: string; application: 'new-sessions'; sources: NativeLspSource[]; servers: NativeLspServer[];
  idleTimeoutMs?: number; idleTimeoutSource?: string; warnings: string[];
  overrideTargets: { user: string; project: string };
}
export type NativeLspMutation = { expectedRevision: string; sourceId: string } & (
  | { operation: 'save'; name: string; changes: LspValues; removeFields: string[] }
  | { operation: 'remove'; name: string }
  | { operation: 'idle-timeout'; value: number | null }
);
const optional = (schema: SettingValueSchema) => ({ optional: true, schema });
export const lspServerFields: Record<string, { label: string; schema: SettingValueSchema; advanced?: boolean }> = {
  command: { label: 'Command', schema: { kind: 'string' } },
  args: { label: 'Arguments', schema: { kind: 'array', item: { kind: 'string' } } },
  fileTypes: { label: 'File types', schema: { kind: 'array', item: { kind: 'string' } } },
  rootMarkers: { label: 'Project root markers', schema: { kind: 'array', item: { kind: 'string' } } },
  languageId: { label: 'Language ID', schema: { kind: 'string' } },
  disabled: { label: 'Disabled', schema: { kind: 'boolean' } },
  warmupTimeoutMs: { label: 'Warmup timeout (ms)', schema: { kind: 'number', minimum: 0 }, advanced: true },
  workspaceReadyTimings: { label: 'Workspace ready timings', advanced: true, schema: { kind: 'object', fields: Object.fromEntries(['timeoutMs','pollMs','settleMs','statusRequestTimeoutMs'].map(key => [key, optional({ kind: 'number', minimum: 0 })])) } },
  capabilities: { label: 'Capabilities', advanced: true, schema: { kind: 'object', fields: Object.fromEntries(['flycheck','ssr','expandMacro','runnables','relatedTests'].map(key => [key, optional({ kind: 'boolean' })])) } },
  isLinter: { label: 'Linter / formatter', schema: { kind: 'boolean' }, advanced: true },
  initOptions: { label: 'Initialization options', schema: { kind: 'map', value: { kind: 'json' } }, advanced: true },
  settings: { label: 'Server settings', schema: { kind: 'map', value: { kind: 'json' } }, advanced: true },
  extensionToLanguage: { label: 'Extension to language alias', schema: { kind: 'map', value: { kind: 'json' } }, advanced: true },
  initializationOptions: { label: 'Initialization options alias', schema: { kind: 'map', value: { kind: 'json' } }, advanced: true },
};
