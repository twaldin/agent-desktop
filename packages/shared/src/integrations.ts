export type IntegrationScope = 'user' | 'project';
export interface PluginSetting {
  key: string; type: 'string' | 'number' | 'boolean' | 'enum'; description?: string;
  secret: boolean; configured: boolean; overridden?: boolean;
  value?: string | number | boolean; default?: string | number | boolean;
  values?: string[]; min?: number; max?: number; step?: number;
}
export interface NativePlugin {
  id: string; name: string; title: string; description?: string; version: string;
  scope: IntegrationScope; kind: 'package' | 'marketplace'; enabled: boolean; shadowed?: boolean;
  /** Host-validated native acquisition identity. Present only for marketplace installs. */
  acquisition?: { pluginId: string; scope: IntegrationScope };
  canToggle: boolean; canSetFeatures: boolean; canSetSettings: boolean; configurationReason?: string;
  features: Array<{ name: string; description?: string; enabled: boolean; default: boolean }>;
  enabledFeatures: string[] | null; settings: PluginSetting[];
}
export interface NativePluginCatalog {
  revision: string; plugins: NativePlugin[]; application: 'new-sessions';
}
export type NativePluginMutation = { expectedRevision: string; pluginId: string } & (
  | { operation: 'enabled'; enabled: boolean }
  | { operation: 'features'; features: string[] | null }
  | { operation: 'setting'; key: string; value: string | number | boolean }
  | { operation: 'reset-setting'; key: string }
);
export interface NativeMcpServer {
  id: string; name: string; transport: 'stdio' | 'http' | 'sse' | 'unknown'; scope: 'user' | 'project' | 'native';
  source: string; enabled: boolean; removable: boolean; editable?: boolean; shadowed?: boolean;
}
export interface NativeMcpCatalog {
  revision: string; servers: NativeMcpServer[]; application: 'new-sessions';
}
export interface NativeMcpDetailRequest { serverId: string; expectedRevision: string }
export interface NativeMcpDetail { revision: string; server: NativeMcpServer; config: Record<string, unknown> }
export type NativeMcpMutation = { expectedRevision: string } & (
  | { operation: 'enabled'; serverId: string; enabled: boolean }
  | { operation: 'remove'; serverId: string }
  | { operation: 'update'; serverId: string; config: Record<string, unknown> }
  | { operation: 'add'; scope: IntegrationScope; name: string; config: Record<string, unknown> }
);
