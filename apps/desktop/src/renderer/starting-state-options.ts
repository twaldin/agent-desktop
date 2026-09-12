import { parseWorktreeStartingState, type GitBranch, type WorktreeStartingState } from "@agent-desktop/shared";
import type { BranchInventorySnapshot } from "./branch-inventory";
import type { BranchSearchSnapshot } from "./branch-search";

export interface StartingStateOption { key: string; label: string; state: WorktreeStartingState; description?: string }
export interface StartingStateGroup { label?: string; rows: StartingStateOption[] }

/** Validate the distinct response before any row can become a saved intent. */
export function parseStartingSearchRows(value: unknown): GitBranch[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error("The host returned an invalid starting branch list.");
  const refs = new Set<string>();
  return value.map(branch => {
    if (!branch || typeof branch.name !== "string" || typeof branch.ref !== "string" || typeof branch.remote !== "boolean"
      || refs.has(branch.ref) || branch.ref !== `${branch.remote ? "refs/remotes/" : "refs/heads/"}${branch.name}`)
      throw new Error("The host returned an invalid starting branch identity.");
    parseWorktreeStartingState({ type: "branch", branchName: branch.name, ...(branch.remote ? { remoteRef: branch.ref } : {}) });
    refs.add(branch.ref);
    return branch as GitBranch;
  });
}

function startingStateNames(selected: WorktreeStartingState, current: string | null | undefined, inventory: BranchInventorySnapshot) {
  const saved = selected.type === "branch" ? selected.branchName : "main";
  const defaultBranch = inventory.defaultBranch ?? inventory.recent.slice(0, 10).find(name => name === "main" || name === "master");
  const effectiveCurrent = current ?? saved;
  const promoted = [effectiveCurrent, defaultBranch, ...inventory.recent].includes(saved) ? saved : undefined;
  const idle = [...new Set([defaultBranch, effectiveCurrent, promoted, ...inventory.recent].filter((name): name is string => Boolean(name)))];
  const first = idle[0] ?? current ?? saved;
  return { idle, first };
}

export function startingStateLabel(selected: WorktreeStartingState, current: string | null | undefined, inventory: BranchInventorySnapshot): string {
  if (selected.type === "working-tree") return `${current ?? startingStateNames(selected, current, inventory).first} (current)`;
  const base = inventory.baseBranch;
  return base && selected.branchName === base.local && selected.remoteRef === `refs/remotes/${base.remote}/${base.local}`
    ? `${base.remote}/${base.local}` : selected.branchName;
}

export function startingStateGroups(query: string, current: string | null | undefined, dirty: boolean, selected: WorktreeStartingState,
  inventory: BranchInventorySnapshot, search: BranchSearchSnapshot): StartingStateGroup[] {
  const needle = query.trim().toLowerCase(), matches = (name: string) => !needle || name.toLowerCase().includes(needle);
  const { idle, first } = startingStateNames(selected, current, inventory);
  const groups: StartingStateGroup[] = [];
  const localStateName = current ?? first;
  if (dirty && matches(localStateName)) groups.push({ label: "Local file state", rows: [{ key: `working-tree:${localStateName}`, label: localStateName,
    description: "with local code changes", state: { type: "working-tree" } }] });
  const base = inventory.baseBranch;
  if (base && matches(`${base.remote}/${base.local}`)) groups.push({ rows: [{ key: `refs/remotes/${base.remote}/${base.local}`, label: `${base.remote}/${base.local}`,
    state: { type: "branch", branchName: base.local, remoteRef: `refs/remotes/${base.remote}/${base.local}` } }] });
  const names = needle ? search.loading || search.error ? [] : search.branches.filter(branch => !branch.remote).map(branch => branch.name) : idle;
  // A saved remote's display fallback is not evidence of a local branch. Only
  // independently supplied local names may turn that label into local intent.
  const localNames = new Set([current, inventory.defaultBranch, ...inventory.recent,
    ...(!search.loading && !search.error ? search.branches.filter(branch => !branch.remote).map(branch => branch.name) : [])]);
  const locals = [...new Set([...(matches(first) ? [first] : []), ...names.filter(name => name !== first)])]
    .filter(name => selected.type !== "branch" || !selected.remoteRef || name !== selected.branchName || localNames.has(name));
  // Typed reads never expose idle fallback rows while pending or failed.
  groups.push({ label: "Local branches", rows: needle && (search.loading || search.error) ? [] : locals.map(name => ({ key: `refs/heads/${name}`, label: name, state: { type: "branch", branchName: name } })) });
  const remotes = needle && !search.loading && !search.error ? search.branches.filter(branch => branch.remote) : [];
  if (remotes.length) groups.push({ label: "Remote branches", rows: remotes.map(branch => ({ key: branch.ref, label: branch.name,
    state: { type: "branch", branchName: branch.name, remoteRef: branch.ref } })) });
  return groups;
}

export function startingStateSelected(a: WorktreeStartingState, b: WorktreeStartingState): boolean {
  return a.type === b.type && (a.type === "working-tree" || b.type === "branch" && (a.remoteRef || a.branchName) === (b.remoteRef || b.branchName));
}
