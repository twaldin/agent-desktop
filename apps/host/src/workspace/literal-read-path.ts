import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";

/** Bun 1.3.14 realpath treats POSIX backslashes as separators. Preserve native
 * filename bytes for read-only viewers while resolving every symlink component.
 * Callers still enforce owning-root containment and opened-file identity. */
export async function canonicalReadPath(path: string): Promise<string> {
  if (sep !== "/") return realpath(path);
  if (!isAbsolute(path)) throw new Error("Canonical read paths must be absolute.");
  const parts = path.split("/"); let current = "/", links = 0;
  while (parts.length) {
    const part = parts.shift()!;
    if (!part || part === ".") continue;
    if (part === "..") { current = dirname(current); continue; }
    const next = join(current, part), metadata = await lstat(next);
    if (metadata.isSymbolicLink()) {
      if (++links > 40) throw Object.assign(new Error("Too many symbolic links in file path."), { code: "ELOOP" });
      const target = await readlink(next);
      if (isAbsolute(target)) current = "/";
      parts.unshift(...target.split("/"));
    } else {
      if (parts.some(component => component && component !== ".") && !metadata.isDirectory())
        throw Object.assign(new Error("A file path component is not a directory."), { code: "ENOTDIR" });
      current = next;
    }
  }
  return current;
}
