/** Pinned Ufe grammar. Paths are Git's display strings (possibly quoted), not
 * decoded filesystem paths and never inputs to a later Git command. */
export function readCheckoutConflict(output: string): { conflictedPaths: string[] } | undefined {
  const header = /^(error:\s*)?.*\bwould be overwritten by checkout:\s*$/i;
  const paths = new Set<string>();
  let found = false;
  for (const line of output.split(/\r?\n/)) {
    const value = line.replace(/\r$/, "").trim();
    if (!found) { if (header.test(value)) found = true; continue; }
    if (!value) continue;
    const lower = value.toLowerCase();
    if (lower.startsWith("please ") || lower.startsWith("error:") || lower === "aborting") break;
    paths.add(value);
  }
  return found ? { conflictedPaths: [...paths] } : undefined;
}
