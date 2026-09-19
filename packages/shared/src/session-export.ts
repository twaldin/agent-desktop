/** Native HTML is kept on its owning host. No filesystem path crosses this contract. */
export const SESSION_EXPORT_CAPABILITY = { version: 1, commandVersion: 20 } as const;
export const MAX_SESSION_EXPORT_BYTES = 32 * 1024 * 1024;
export type SessionExportTheme = "web" | "user";
export interface SessionExportReceipt { type: "session.export"; hostId: string; sessionId: string; commandId: string; artifactId: string; sha256: string; bytes: number; theme: SessionExportTheme }
export interface SessionExportStatus { hostId: string; sessionId: string; commandId: string; state: "absent" | "pending" | "unknown" | "failed" | "complete"; receipt?: SessionExportReceipt; message?: string }
export function exportId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid export owner or command.");
  return value;
}
export function exportTheme(value: unknown): SessionExportTheme {
  if (value !== "web" && value !== "user") throw new Error("Choose web or native user themes.");
  return value;
}
export function parseSessionExportReceipt(value: unknown, hostId: string, sessionId: string, commandId?: string): SessionExportReceipt {
  const v = value as SessionExportReceipt;
  if (!v || v.type !== "session.export" || v.hostId !== hostId || v.sessionId !== sessionId || commandId !== undefined && v.commandId !== commandId
    || !/^[a-f0-9]{64}$/.test(v.artifactId) || !/^[a-f0-9]{64}$/.test(v.sha256) || !Number.isSafeInteger(v.bytes) || v.bytes <= 0 || v.bytes > MAX_SESSION_EXPORT_BYTES) throw new Error("The HTML export receipt does not match its owner.");
  return { type: "session.export", hostId: exportId(hostId), sessionId: exportId(sessionId), commandId: exportId(v.commandId), artifactId: v.artifactId, sha256: v.sha256, bytes: v.bytes, theme: exportTheme(v.theme) };
}
