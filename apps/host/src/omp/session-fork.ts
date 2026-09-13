import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { readSessionHeader } from "./session-files";

export interface NativeSessionForkInput {
  sourceSessionId: string;
  sourceSessionFile: string;
  cwd: string;
  sessionDirectory: string;
  sessionFile: string;
}

export interface NativeSessionForkResult {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  parentSessionId: string;
  createdAt: number;
}

function unknownOutcome(target: string, cause: unknown): Error {
  return Object.assign(new Error(`Native fork outcome is unconfirmed at ${target}. Inspect the recorded operation before continuing.`, { cause }), { code: "OUTCOME_UNKNOWN" });
}

/** Run only in a fresh one-shot worker, after the host durably records this target. */
export async function forkNativeSession(input: NativeSessionForkInput): Promise<NativeSessionForkResult> {
  if (!input.sourceSessionId || [input.sourceSessionFile, input.cwd, input.sessionDirectory, input.sessionFile].some(value => !path.isAbsolute(value)))
    throw new Error("Native fork requires an existing source and absolute owned paths.");
  const [source, cwd, directory, targetDirectory] = await Promise.all([
    realpath(input.sourceSessionFile), realpath(input.cwd), realpath(input.sessionDirectory), realpath(path.dirname(input.sessionFile)),
  ]);
  const target = path.join(targetDirectory, path.basename(input.sessionFile));
  if (targetDirectory !== directory || !target.endsWith(".jsonl") || target === source)
    throw new Error("Native fork target must be a distinct file in its owned session directory.");
  if ((await readSessionHeader(source)).id !== input.sourceSessionId)
    throw new Error("The native fork source identity changed before admission.");

  // Exclusive reservation prevents a retry or competing operation from replacing a child.
  const reservation = await open(target, "wx", 0o600);
  let manager: SessionManager | undefined;
  try {
    await reservation.close();
    manager = await SessionManager.forkFrom(source, cwd, directory, undefined, {
      sessionFile: target, copyArtifacts: true, suppressBreadcrumb: true,
    });
    await manager.flush();
    const header = manager.getHeader();
    const sessionId = manager.getSessionId();
    if (header?.parentSession !== input.sourceSessionId || sessionId === input.sourceSessionId
      || manager.getSessionFile() !== target || manager.getCwd() !== cwd)
      throw new Error("Native fork returned a different child authority.");
    return { sessionId, sessionFile: target, cwd, parentSessionId: input.sourceSessionId, createdAt: Date.parse(header.timestamp) };
  } catch (cause) {
    // The native file or artifact copy may already exist. Retain it; never replay here.
    throw unknownOutcome(target, cause);
  } finally {
    try { await manager?.close(); } catch (cause) { throw unknownOutcome(target, cause); }
  }
}
