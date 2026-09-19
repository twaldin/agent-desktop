import { parseSessionExportReceipt, type CommandEnvelope, type DesktopBridge, type SessionExportStatus, type SessionExportTheme } from "@agent-desktop/shared";
export class SessionExportState {
  status?: SessionExportStatus;
  pending?: CommandEnvelope;
  busy = false;
  error?: string;
  readonly key: string;
  constructor(readonly bridge: DesktopBridge, readonly hostId: string, readonly sessionId: string, private storage: { getItem(key: string): string | null; setItem(key: string, value: string): void }, private initialCommandId?: string) {
    this.key = `session-export.v1:${hostId}:${sessionId}`;
    const raw = initialCommandId ? null : storage.getItem(this.key);
    if (raw) {
      const saved = JSON.parse(raw) as CommandEnvelope;
      if (!saved.id || saved.command.type !== "session.export" || saved.command.sessionId !== sessionId || saved.commandVersion !== 20 || !["web", "user"].includes(saved.command.theme)) throw new Error("The saved export request is invalid.");
      this.pending = saved;
    }
  }
  async inspect() {
    if (this.busy) return;
    this.busy = true; this.error = undefined;
    try {
      if (!this.bridge.getSessionExport) throw new Error("Update the desktop to inspect native exports.");
      this.status = await this.bridge.getSessionExport(this.sessionId, this.pending?.id ?? this.initialCommandId ?? "latest", this.hostId);
      if (this.status.hostId !== this.hostId || this.status.sessionId !== this.sessionId || this.pending && this.status.commandId !== this.pending.id) throw new Error("The original export owner changed.");
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
    finally { this.busy = false; }
  }
  get unresolved() { return Boolean(this.pending && !this.status || this.status && ["pending", "unknown"].includes(this.status.state)); }
  async run(theme: SessionExportTheme) {
    if (this.busy || this.unresolved) return;
    // Absent means the original command was never seen: an explicit retry uses that exact saved envelope.
    const envelope: CommandEnvelope = this.pending && this.status?.state === "absent" ? this.pending : { id: crypto.randomUUID(), commandVersion: 20, command: { type: "session.export", sessionId: this.sessionId, theme } };
    try { this.storage.setItem(this.key, JSON.stringify(envelope)); }
    catch { this.error = "The export request could not be saved locally. Nothing was exported."; return; }
    this.pending = envelope; this.busy = true; this.error = undefined;
    this.status = { hostId: this.hostId, sessionId: this.sessionId, commandId: envelope.id, state: "pending" };
    try {
      const result = await this.bridge.command(envelope, this.hostId);
      if (result.commandId !== envelope.id) throw new Error("The export acknowledgement belongs to a different command.");
      this.status = result.ok ? { ...this.status, state: "complete", receipt: parseSessionExportReceipt(result.value, this.hostId, this.sessionId, envelope.id) }
        : { ...this.status, state: result.error.code === "OUTCOME_UNKNOWN" ? "unknown" : "failed", message: result.error.message };
    } catch (error) { this.status = { ...this.status, state: "unknown" }; this.error = error instanceof Error ? error.message : String(error); }
    finally { this.busy = false; }
  }
}
