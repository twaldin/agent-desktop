import type { WorkspaceTarget } from './protocol';
import type { IntegrationScope } from './integrations';

export interface NativeMarketplaceSourceOptions { ref?: string; sparsePaths?: string[] }

/** Mirrors pinned OMP source classification without importing its native runtime into the renderer. */
export function assertMarketplaceGitSource(source: string): void {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    try { if (!new URL(source).pathname.endsWith('.json')) return; } catch { /* Native fetcher will also reject malformed URLs. */ }
  } else if (source.startsWith('git@') || source.startsWith('ssh://') || /^[a-z0-9-]+\/[a-z0-9._-]+$/i.test(source)) return;
  throw new Error('Git ref and sparse paths require a Git repository source. Clear them to add a local folder or JSON catalog.');
}

/** Bound untrusted renderer/registry options before handing them to the native fetcher. */
export function parseMarketplaceSourceOptions(value: unknown): NativeMarketplaceSourceOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid marketplace source options.');
  const options = value as Record<string, unknown>;
  if (Object.keys(options).some(key => key !== 'ref' && key !== 'sparsePaths')) throw new Error('Unsupported marketplace source option.');
  if (options.ref !== undefined && (typeof options.ref !== 'string' || !options.ref || options.ref.length > 256 || /^-/.test(options.ref) || /[\x00-\x20\x7f~^:?*[\\]/.test(options.ref) || options.ref.includes('..') || options.ref.includes('@{'))) throw new Error('Enter a branch, tag or commit SHA for Git ref.');
  if (options.sparsePaths !== undefined && (!Array.isArray(options.sparsePaths) || options.sparsePaths.length > 128 || options.sparsePaths.some(item =>
    typeof item !== 'string' || !item || item.length > 1024 || item.startsWith('-') || /[\\\x00-\x1f\x7f]/.test(item) || item.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) || options.sparsePaths.join('\n').length > 32768)) throw new Error('Sparse paths must be repository-relative file or folder paths, one per line.');
  return {...(options.ref === undefined ? {} : {ref: options.ref as string}), ...(options.sparsePaths === undefined ? {} : {sparsePaths: [...options.sparsePaths as string[]]})};
}

export interface NativeMarketplaceCatalog {
  revision: string;
  projectScopeAvailable: boolean;
  marketplaces: Array<{
    name: string;
    sourceType: 'github' | 'git' | 'url' | 'local';
    sourceOptions?: NativeMarketplaceSourceOptions;
    catalogAvailable: boolean;
    description?: string;
    plugins: Array<{ name: string; description?: string; version?: string; installable: boolean; unavailabilityReason?: string }>;
  }>;
  installed: Array<{ id: string; scope: IntegrationScope; version: string; enabled: boolean }>;
}

export type NativePluginAcquisition =
  | { operation: 'marketplace.add'; source: string; sourceOptions?: NativeMarketplaceSourceOptions }
  | { operation: 'marketplace.update' | 'marketplace.remove'; name: string }
  | { operation: 'plugin.install'; name: string; marketplace: string; scope: IntegrationScope }
  | { operation: 'plugin.upgrade'; pluginId: string; scope: IntegrationScope }
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
