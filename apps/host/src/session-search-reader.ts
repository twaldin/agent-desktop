import { constants } from "node:fs";
import { open, realpath, lstat } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import type { ReadStoredSession } from "./session-search";
import { searchSessionStream } from "./session-search-stream";

/** This mirrors native import's read-only identity fence. Unlike loading an
 * AgentSession, streaming a journal never repairs, writes, resolves image
 * blobs, takes a writer lock, or initializes configuration/providers. */
export const readStoredSessionText: ReadStoredSession = async (session, query, signal) => {
  signal.throwIfAborted();
  if (!isAbsolute(session.sessionFile)) throw new Error("Invalid catalog session file.");
  const canonical = await realpath(session.sessionFile);
  if (canonical !== resolve(session.sessionFile)) throw new Error("Catalog session alias changed.");
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || !Number.isSafeInteger(before.size)) throw new Error("Session is not a regular journal.");
    const buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    async function* chunks() {
      while (size <= before.size) {
        signal.throwIfAborted();
        const read = await file.read(buffer, 0, Math.min(buffer.length, before.size + 1 - size), size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
        yield buffer.subarray(0, read.bytesRead);
      }
    }
    const result = await searchSessionStream(chunks(), session.id, query, signal);
    const after = await file.stat();
    if (await realpath(session.sessionFile) !== canonical) throw new Error("Session alias changed while searched.");
    // Observe path identity after resolving it, not just the unchanged spelling
    // of a pathname whose entry could have been replaced since the prior stat.
    const visible = await lstat(canonical);
    const same = (a: typeof before, b: typeof before) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
    if (size !== before.size || !same(before, after) || !same(after, visible)) throw new Error("Session changed while searched.");
    signal.throwIfAborted();
    return result;
  } finally { await file.close(); }
};
