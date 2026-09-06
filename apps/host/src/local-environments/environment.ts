import { isAbsolute, resolve } from "node:path";

export interface LocalEnvironmentEnvironmentDelta {
  version: 1;
  set: Record<string, string>;
  unset: string[];
}

export interface LocalEnvironmentWorkerEnvironment {
  environmentDelta: LocalEnvironmentEnvironmentDelta | null;
  sourceRoot: string;
  worktreeRoot: string;
}

const maximumEnvironmentBytes = 4 * 1024 * 1024;
const protectedEnvironment = new Set([
  "CODEX_HOME", "CODEX_SETUP_EXIT_CODE", "CODEX_SOURCE_TREE_PATH", "CODEX_WORKTREE_PATH",
  "AGENT_SOURCE_TREE_PATH", "AGENT_WORKTREE_PATH", "HOME", "OLDPWD", "PI_CODING_AGENT_DIR", "PWD", "SHELLOPTS", "SHLVL", "_",
]);
const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isProtectedLocalEnvironmentKey(key: string): boolean {
  return protectedEnvironment.has(key) || key.startsWith("AGENT_DESKTOP_") || key.startsWith("BASH_FUNC_");
}

function ownedPath(value: string, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("\0")) {
    throw new Error(`${label} must be a normalized absolute path.`);
  }
  return value;
}

/** Construct one worker-only environment without changing the daemon environment. */
export function localEnvironmentForWorker(
  base: Record<string, string | undefined>,
  input: LocalEnvironmentWorkerEnvironment,
): Record<string, string> {
  const sourceRoot = ownedPath(input.sourceRoot, "Local environment source root");
  const worktreeRoot = ownedPath(input.worktreeRoot, "Local environment worktree root");
  const environment = Object.fromEntries(Object.entries(base).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]));
  const delta = input.environmentDelta;
  let bytes = 0;
  if (delta !== null) {
    if (delta?.version !== 1 || !delta.set || typeof delta.set !== "object" || Array.isArray(delta.set) || !Array.isArray(delta.unset)) {
      throw new Error("Invalid local environment delta.");
    }
    const seen = new Set<string>();
    for (const [key, value] of Object.entries(delta.set)) {
      if (!environmentName.test(key) || typeof value !== "string" || value.includes("\0")) throw new Error("Invalid local environment delta.");
      if (seen.has(key)) throw new Error("Local environment delta contains duplicate operations.");
      seen.add(key); bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
      if (!isProtectedLocalEnvironmentKey(key)) environment[key] = value;
    }
    for (const key of delta.unset) {
      if (typeof key !== "string" || !environmentName.test(key) || seen.has(key)) throw new Error("Local environment delta contains invalid or duplicate operations.");
      seen.add(key); bytes += Buffer.byteLength(key);
      if (!isProtectedLocalEnvironmentKey(key)) delete environment[key];
    }
  }
  if (bytes > maximumEnvironmentBytes) throw new Error("Local environment delta exceeds 4 MiB.");
  Object.assign(environment, {
    CODEX_SOURCE_TREE_PATH: sourceRoot,
    CODEX_WORKTREE_PATH: worktreeRoot,
    AGENT_SOURCE_TREE_PATH: sourceRoot,
    AGENT_WORKTREE_PATH: worktreeRoot,
  });
  return environment;
}
