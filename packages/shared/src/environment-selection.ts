/** A captured host-owned config revision. Null explicitly selects no environment. */
export type LocalEnvironmentSelection = { projectId: string; configPath: string; revision: string } | null;

/** Shape checks only. The owning host must resolve the config through its project store. */
export function parseEnvironmentSelection(value: unknown, projectId: string | null): LocalEnvironmentSelection {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Select an environment or explicitly select No environment.");
  const item = value as Record<string, unknown>;
  if (!projectId || item.projectId !== projectId) throw new Error("The environment belongs to a different project.");
  if (typeof item.configPath !== "string" || !item.configPath.startsWith("/") || item.configPath.includes("\0") || item.configPath.length > 16_384)
    throw new Error("Invalid environment config path.");
  if (typeof item.revision !== "string" || !/^[a-f0-9]{64}$/.test(item.revision)) throw new Error("Select the exact environment revision.");
  return { projectId, configPath: item.configPath, revision: item.revision };
}

export function sameEnvironmentSelection(a: LocalEnvironmentSelection | undefined, b: LocalEnvironmentSelection | undefined): boolean {
  if (a === undefined || a === null || b === undefined || b === null) return a === b;
  return a.projectId === b.projectId && a.configPath === b.configPath && a.revision === b.revision;
}
