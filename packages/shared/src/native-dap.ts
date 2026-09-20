import type { SettingJson, SettingValueSchema } from './settings';
export type DapValues = Record<string, SettingJson>;
export interface NativeDapSource {
  id: string; path: string; scope: 'project' | 'user' | 'plugin';
  writable: boolean; exists: boolean; error?: string; ignoredAdapters: string[]; adapters: Record<string, SettingJson>;
}
export interface NativeDapAdapter {
  name: string; builtin: boolean; configured: boolean; effective: DapValues;
  sources: string[]; fieldSources: Record<string, string>;
  defaultSources: { launchDefaults: Record<string, string>; attachDefaults: Record<string, string> };
  resolved: DapValues | null; applicability: 'ready' | 'missing-command' | 'invalid';
}
export interface NativeDapCatalog {
  revision: string; application: 'next-launch-or-attach'; sources: NativeDapSource[]; adapters: NativeDapAdapter[];
  warnings: string[]; overrideTargets: { user: string; project: string };
}
export type NativeDapMutation = { expectedRevision: string; sourceId: string; name: string } & (
  | { operation: 'save'; changes: DapValues; removeFields: string[] }
  | { operation: 'remove' }
);
export const dapAdapterFields: Record<string, { label: string; schema: SettingValueSchema; advanced?: boolean }> = {
  command: { label: 'Command', schema: { kind: 'string' } },
  args: { label: 'Arguments', schema: { kind: 'array', item: { kind: 'string' } } },
  languages: { label: 'Languages', schema: { kind: 'array', item: { kind: 'string' } } },
  fileTypes: { label: 'File types', schema: { kind: 'array', item: { kind: 'string' } } },
  rootMarkers: { label: 'Project root markers', schema: { kind: 'array', item: { kind: 'string' } } },
  connectMode: { label: 'Connection mode', schema: { kind: 'enum', values: ['stdio', 'socket', 'tcp'] } },
  acceptsDirectoryProgram: { label: 'Accept directory programs', schema: { kind: 'boolean' } },
  launchDefaults: { label: 'Launch defaults', schema: { kind: 'map', value: { kind: 'json' } }, advanced: true },
  attachDefaults: { label: 'Attach defaults', schema: { kind: 'map', value: { kind: 'json' } }, advanced: true },
};
