import type { WorkspaceTarget } from './protocol';
import type { IntegrationScope } from './integrations';

export interface NativeMarketplaceCatalog {
  revision: string;
  projectScopeAvailable: boolean;
  marketplaces: Array<{
    name: string;
    sourceType: 'github' | 'git' | 'url' | 'local';
    catalogAvailable: boolean;
    description?: string;
    plugins: Array<{ name: string; description?: string; version?: string; installable: boolean; unavailabilityReason?: string }>;
  }>;
  installed: Array<{ id: string; scope: IntegrationScope; version: string; enabled: boolean }>;
}

export type NativePluginAcquisition =
  | { operation: 'marketplace.add'; source: string }
  | { operation: 'marketplace.update' | 'marketplace.remove'; name: string }
  | { operation: 'plugin.install'; name: string; marketplace: string; scope: IntegrationScope }
  | { operation: 'plugin.uninstall'; pluginId: string; scope: IntegrationScope };

export interface NativePluginAcquisitionRequest {
  id: string;
  expectedRevision: string;
  action: NativePluginAcquisition;
}

/** Receipts contain operation metadata only, never a repository URL or config. */
export interface NativePluginAcquisitionReceipt {
  id: string;
  operation: NativePluginAcquisition['operation'];
  target?: WorkspaceTarget;
  state: 'running' | 'succeeded' | 'needs-review' | 'reviewed';
  createdAt: number;
  updatedAt: number;
  message?: string;
}
