/** Host-local access restrictions, applied after Tailscale authenticates the same-user device. */
export interface DeviceAccessPolicy {
  revision: number;
  enabled: boolean;
  revokedNodeIds: string[];
}
export type DeviceAccessChange =
  | { type: "availability"; enabled: boolean }
  | { type: "device"; nodeId: string; allowed: boolean };
export interface DeviceAccessUpdate { expectedRevision: number; change: DeviceAccessChange }
export interface DeviceAccessState { hostId: string; supported: boolean; policy: DeviceAccessPolicy }

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).length === expected.length && Object.keys(value).every(key => expected.includes(key));
const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
const nodeId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(value);

export function parseDeviceAccessPolicy(value: unknown): DeviceAccessPolicy {
  if (!record(value) || !keys(value, ["revision", "enabled", "revokedNodeIds"]) || !revision(value.revision)
    || typeof value.enabled !== "boolean" || !Array.isArray(value.revokedNodeIds) || value.revokedNodeIds.length > 10000
    || !value.revokedNodeIds.every(nodeId) || new Set(value.revokedNodeIds).size !== value.revokedNodeIds.length) throw new Error("Invalid device access policy.");
  return { revision: value.revision, enabled: value.enabled, revokedNodeIds: [...value.revokedNodeIds].sort() };
}
export function parseDeviceAccessUpdate(value: unknown): DeviceAccessUpdate {
  if (!record(value) || !keys(value, ["expectedRevision", "change"]) || !revision(value.expectedRevision) || !record(value.change)) throw new Error("Invalid device access update.");
  const change = value.change;
  if (change.type === "availability" && keys(change, ["type", "enabled"]) && typeof change.enabled === "boolean") return { expectedRevision: value.expectedRevision, change: { type: "availability", enabled: change.enabled } };
  if (change.type === "device" && keys(change, ["type", "nodeId", "allowed"]) && nodeId(change.nodeId) && typeof change.allowed === "boolean") return { expectedRevision: value.expectedRevision, change: { type: "device", nodeId: change.nodeId, allowed: change.allowed } };
  throw new Error("Invalid device access update.");
}
export function deviceAccessAllowed(policy: DeviceAccessPolicy, nodeId: string): boolean {
  return policy.enabled && !policy.revokedNodeIds.includes(nodeId);
}
export class DeviceAccessConflictError extends Error {
  constructor() { super("Device access changed in another window. Refresh before trying again."); this.name = "DeviceAccessConflictError"; }
}
