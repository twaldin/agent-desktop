import { constants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { parseTitleSlotLine } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";

/** Captured by the host before worker startup; not a filesystem lease. */
export interface SessionStartupIdentity { id: string; cwd: string; directory: string }

export async function requireDirectory(directory: string): Promise<string> {
  const resolved = await realpath(directory);
  if (!(await stat(resolved)).isDirectory()) throw new Error("OMP working directory must be a directory");
  await access(resolved, constants.R_OK | constants.X_OK);
  return resolved;
}

export async function readSessionHeader(sessionFile: string): Promise<{ id: string; cwd: string }> {
  const file = await open(sessionFile, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(buffer);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    // 18.1.10 may put its fixed-width physical title slot before the semantic
    // session header. Use native slot recognition and retain legacy support.
    const headerLine = parseTitleSlotLine(lines[0]) ? lines[1] : lines[0];
    const header: unknown = JSON.parse(headerLine);
    if (!header || typeof header !== "object" || !("type" in header) || header.type !== "session"
      || !("id" in header) || typeof header.id !== "string"
      || !("cwd" in header) || typeof header.cwd !== "string") {
      throw new Error("Cannot open an OMP session without a valid native identity and working directory");
    }
    return { id: header.id, cwd: header.cwd };
  } finally { await file.close(); }
}

