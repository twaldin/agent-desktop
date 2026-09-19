import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { parseExportArgs } from "@oh-my-pi/pi-coding-agent/export/html/args";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { parseSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse";
import type { SessionExportTheme } from "@agent-desktop/shared";
export interface NativeSessionExportInput { sessionId: string; sessionFile: string; cwd: string; outputPath: string; theme: SessionExportTheme; text?: string }
export type NativeExportIntent = { theme: SessionExportTheme; guidance?: string } | null;
/** Match dispatchNativePrompt's extension/custom-before-builtin ordering. */
export function nativeExportIntent(session: AgentSession, text: string): NativeExportIntent {
  if (!text.startsWith("/")) return null;
  const space = text.indexOf(" "), name = space < 0 ? text.slice(1) : text.slice(1, space);
  if (session.extensionRunner?.getCommand(name) || session.customCommands.some(c => c.command.name === name)) return null;
  const parsed = parseSlashCommand(text);
  if (!parsed || lookupBuiltinSlashCommand(parsed.name)?.name !== "export") return null;
  const args = parseExportArgs(parsed.args), theme = args.useUserThemes ? "user" : "web";
  if (["--copy", "clipboard", "copy"].includes(args.outputPath ?? "")) return { theme, guidance: "Use /dump to copy the session to clipboard." };
  if (args.outputPath) return { theme, guidance: "Export destinations are selected with Save as after the native HTML export. Use /export or /export --themes." };
  return { theme };
}
export async function exportNativeSession(session: AgentSession, input: NativeSessionExportInput, ready: () => void): Promise<void> {
  const check = () => {
    ready();
    if (!session.sessionFile || session.sessionId !== input.sessionId || session.sessionFile !== input.sessionFile || session.sessionManager.getCwd() !== input.cwd)
      throw new Error("The original saved native session changed before HTML export.");
    if (!session.messages.length) throw new Error("The conversation has no messages to export.");
    if (input.text !== undefined) {
      const intent = nativeExportIntent(session, input.text);
      if (!intent || intent.guidance || intent.theme !== input.theme) throw new Error("The native /export command owner changed before export.");
    }
  };
  check();
  await session.sessionManager.flush();
  check();
  // Reserve the host-generated file exclusively. The native exporter writes the
  // already-open descriptor on supported macOS/Linux hosts, so replacing a path
  // with a symlink cannot redirect its write into a different file.
  const file = await open(input.outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    check();
    const destination = `/dev/fd/${file.fd}`;
    const output = await session.exportToHtml(destination, input.theme === "user");
    await file.sync();
    check();
    if (output !== destination) throw new Error("Native HTML exporter returned an unexpected destination.");
  } finally { await file.close(); }
}
