import type { WorkspaceEntry } from "@agent-desktop/shared";

export interface FileTreeRow {
  entry: Pick<WorkspaceEntry, "path" | "name" | "kind" | "linkState">;
  level: number;
  parent?: string;
  expanded: boolean;
  loading: boolean;
  error?: string;
}

interface SearchNode {
  entry: FileTreeRow["entry"];
  children: Map<string, SearchNode>;
}

/** Xt/Kt: a separate result-only tree, first duplicate wins, ancestors open and
 * empty directory chains flattened. Never read directory caches or re-rank the
 * host's bounded matches. Sibling groups retain their first host occurrence. */
export function fileTreeSearchRows(entries: readonly WorkspaceEntry[], collapsed: ReadonlySet<string>): FileTreeRow[] {
  const roots = new Map<string, SearchNode>(), seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    const parts = entry.path.split("/");
    let children = roots;
    for (let index = 0; index < parts.length; index++) {
      const path = parts.slice(0, index + 1).join("/"), leaf = index === parts.length - 1;
      // A trailing slash distinguishes structural ancestors from host entries,
      // as Bho distinguishes paths that also name an ancestor in the widget.
      const key = leaf ? path : `${path}/`;
      let node = children.get(key);
      if (!node) {
        node = { entry: leaf ? entry : { path, name: parts[index]!, kind: "directory" }, children: new Map() };
        children.set(key, node);
      }
      children = node.children;
    }
  }
  const rows: FileTreeRow[] = [];
  const visit = (children: Map<string, SearchNode>, level: number, parent?: string) => {
    for (let node of children.values()) {
      let name = node.entry.name;
      let closed = collapsed.has(node.entry.path);
      while (!closed && node.entry.kind === "directory" && node.children.size === 1) {
        const child = node.children.values().next().value!;
        if (child.entry.kind !== "directory") break;
        node = child; name += `/${node.entry.name}`;
        closed ||= collapsed.has(node.entry.path);
      }
      const expanded = node.entry.kind === "directory" && !closed;
      rows.push({ entry: name === node.entry.name ? node.entry : { ...node.entry, name }, level, parent, expanded, loading: false });
      if (expanded) visit(node.children, level + 1, node.entry.path);
    }
  };
  visit(roots, 1);
  return rows;
}
