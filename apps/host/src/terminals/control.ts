import { TerminalError } from "./error";

export class NativeControlError extends TerminalError {
  constructor(code: string, message: string, readonly outcome: "not-submitted" | "uncertain") { super(code, message); }
}
interface Pending { marker: string; lines: string[]; bytes: number; resolve: (lines: string[]) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
/** One FIFO stdin is the only user-input path. Never put user bytes in process argv or a shell. */
export class TmuxControl {
  readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private tail: Promise<void> = Promise.resolve();
  private pending?: Pending;
  private closed?: Error;
  private queued = 0;
  private buffer = "";
  private block?: { id: string; lines: string[] };
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  constructor(args: string[], environment: Record<string, string | undefined>, private readonly timeoutMs = 10_000) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // Mark handled even when the owning host exits before its first operation.
    this.ready.catch(() => {});
    this.child = Bun.spawn(args, { env: environment, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    void this.read(); void this.drainErrors();
    void this.child.exited.then(() => this.fail(new Error("The native terminal control connection closed.")));
  }
  get isClosed(): boolean { return !!this.closed; }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = error; this.rejectReady(error);
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new NativeControlError("TERMINAL_INPUT_UNCERTAIN", "The native control connection was lost after submission. This input will not be replayed.", "uncertain")); this.pending = undefined; }
    try { this.child.kill(); } catch { /* Already exited. */ }
  }
  private async drainErrors(): Promise<void> {
    let bytes = 0;
    try { for await (const chunk of this.child.stderr) { bytes += chunk.byteLength; if (bytes > 64 * 1024) { this.fail(new Error("Native control error output exceeded its bound.")); break; } } }
    catch { this.fail(new Error("Native control error stream failed.")); }
  }
  private async read(): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const bytes of this.child.stdout) {
        this.buffer += decoder.decode(bytes, { stream: true });
        if (this.buffer.length > 512 * 1024) throw new Error("Native control line exceeded its bound.");
        let index: number;
        while ((index = this.buffer.indexOf("\n")) >= 0) { const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1); this.line(line); }
      }
    } catch (error) { this.fail(error instanceof Error ? error : new Error("Native control output failed.")); }
    finally { this.fail(new Error("Native control output closed.")); }
  }
  private line(line: string): void {
    if (line.startsWith("%begin ")) { if (this.block) throw new Error("Nested native control output block."); this.block = { id: line.slice(7), lines: [] }; return; }
    if (line.startsWith("%end ") || line.startsWith("%error ")) {
      const block = this.block; this.block = undefined;
      const id = line.slice(line.startsWith("%end ") ? 5 : 7);
      if (!block || block.id !== id) throw new Error("Mismatched native control output block.");
      if (line.startsWith("%error ")) { this.fail(new Error("Native control command failed.")); return; }
      if (this.pending) {
        this.pending.lines.push(...block.lines);
        if (block.lines.includes(this.pending.marker)) { const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer); pending.resolve(pending.lines.filter(value => value !== pending.marker)); }
      }
      return;
    }
    if (line.startsWith("%session-changed ")) this.resolveReady();
    else if (this.block) {
      this.block.lines.push(line);
      if (this.pending) { this.pending.bytes += Buffer.byteLength(line); if (this.pending.bytes > 512 * 1024) this.fail(new Error("Native control reply exceeded its bound.")); }
      else if (this.block.lines.length > 1024) this.fail(new Error("Native control startup reply exceeded its bound."));
    }
  }
  execute(command: string): Promise<string[]> {
    if (this.closed) return Promise.reject(new NativeControlError("TERMINAL_INPUT_NOT_SUBMITTED", "The native input connection is unavailable; input was not submitted.", "not-submitted"));
    if (command.includes("\n") || command.includes("\r") || Buffer.byteLength(command) > 512 * 1024 || this.queued >= 1024) return Promise.reject(new NativeControlError("TERMINAL_INPUT_BUSY", "The native input queue is full or the operation exceeds its bound.", "not-submitted"));
    this.queued++;
    const operation = this.tail.then(async () => {
      if (this.closed) throw new NativeControlError("TERMINAL_INPUT_NOT_SUBMITTED", "The preceding input lost its connection; this queued input was never submitted.", "not-submitted");
      let readyTimer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([this.ready, new Promise<never>((_, reject) => { readyTimer = setTimeout(() => reject(new Error("Native input connection did not become ready.")), this.timeoutMs); })]); }
      catch { throw new NativeControlError("TERMINAL_INPUT_NOT_SUBMITTED", "The native input connection did not become ready; input was not submitted.", "not-submitted"); }
      finally { clearTimeout(readyTimer); }
      if (this.closed) throw new NativeControlError("TERMINAL_INPUT_NOT_SUBMITTED", "The native input connection closed before submission.", "not-submitted");
      return await new Promise<string[]>((resolve, reject) => {
        const marker = `AGENT_ACK_${crypto.randomUUID().replaceAll("-", "")}`;
        this.pending = { marker, resolve, reject, lines: [], bytes: 0, timer: setTimeout(() => this.fail(new Error("Native input acknowledgement timed out.")), this.timeoutMs) };
        try { this.child.stdin.write(`${command} ; display-message -p ${marker}\n`); void Promise.resolve(this.child.stdin.flush()).catch(error => this.fail(error)); }
        catch (error) { this.fail(error instanceof Error ? error : new Error("Native input write failed.")); }
      });
    });
    this.tail = operation.then(() => {}, () => {}).finally(() => { this.queued--; });
    return operation;
  }
  async close(): Promise<void> {
    this.fail(new Error("The owning host detached its input controller."));
    await this.child.exited;
  }
}
