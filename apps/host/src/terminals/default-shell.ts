import { userInfo } from "node:os";
import { isAbsolute } from "node:path";

const usable = (value: unknown): value is string => typeof value === "string" && isAbsolute(value) && !value.includes("\0");

/** Missing OS metadata (including Bun's literal "unknown") must not prevent unrelated host routes. */
export function defaultTerminalShell(): { application: string; args: string[] } {
  let loginShell: unknown;
  try { loginShell = userInfo().shell; } catch { /* Service/isolated accounts may have no passwd metadata. */ }
  const application = usable(loginShell) ? loginShell : usable(process.env.SHELL) ? process.env.SHELL : "/bin/sh";
  return { application, args: ["-l", "-i"] };
}
