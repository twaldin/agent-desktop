import type { TerminalChunk, TerminalInfo, TerminalInputReceipt, TerminalInputRequest, TerminalReplay } from "../../../../packages/shared/src/terminals";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** One ephemeral writer. Transport failures never turn into automatic keystroke retries. */
export class OrderedTerminalInput {
  private clientId = crypto.randomUUID();
  private sequence = 0;
  private queue: { data: string; encoding?: "utf8" | "base64"; reply?: TerminalInputRequest["reply"] }[] = [];
  private bytes = 0;
  private running?: Promise<void>;
  private disposed = false;
  private connected = true;
  paused = false;
  error?: string;
  constructor(private readonly terminalId: string, private readonly send: (input: TerminalInputRequest) => Promise<TerminalInputReceipt>, private readonly changed: () => void) {}
  get pendingBytes(): number { return this.bytes; }
  get busy(): boolean { return this.running !== undefined; }

  enqueue(data: string, encoding?: "utf8" | "base64", reply?: TerminalInputRequest["reply"]): void {
    if (this.disposed || !data) return;
    if (!this.connected || this.paused) { this.error = this.paused ? this.error : "The host is offline. Terminal input is not queued."; this.changed(); return; }
    const bytes = encoding === "base64" ? Math.floor(data.length * 3 / 4) : new TextEncoder().encode(data).length;
    if (this.bytes + bytes > 65_536) { this.pause("Queued terminal input exceeds 64 KiB. Check the terminal before resuming."); return; }
    this.queue.push({ data, encoding, reply }); this.bytes += bytes;
    if (!this.running) {
      this.running = Promise.resolve().then(() => this.pump()).finally(() => { this.running = undefined; this.changed(); });
    }
  }
  private pause(reason: string): void { this.paused = true; this.error = reason; this.changed(); }
  private async pump(): Promise<void> {
    while (this.queue.length && !this.paused && this.connected && !this.disposed) {
      const item = this.queue.shift()!; const bytes = item.encoding === "base64" ? Math.floor(item.data.length * 3 / 4) : new TextEncoder().encode(item.data).length; this.bytes -= bytes;
      const request = { terminalId: this.terminalId, clientId: this.clientId, sequence: ++this.sequence, ...item };
      const before = performance.now();
      try {
        const receipt = await this.send(request);
        if (receipt.sequence !== request.sequence) throw new Error("Terminal input acknowledgement did not match its sequence.");
      } catch (error) {
        if (!this.disposed) this.pause(`Input delivery is uncertain: ${message(error)} Check the terminal before resuming. Queued keystrokes will be discarded.`);
        return;
      }
      // Match host admission rate without flooding its native queue during a paste.
      const rest = Math.ceil(Math.max(bytes, 256) / 128 - (performance.now() - before));
      if (rest > 0 && !this.disposed) await new Promise(resolve => setTimeout(resolve, rest));
    }
  }
  setConnected(connected: boolean): void {
    this.connected = connected;
    if (!connected && (this.running || this.queue.length)) this.pause("Connection lost during terminal input. Check the terminal before resuming. Queued keystrokes will be discarded.");
  }
  resume(): void {
    if (!this.connected || this.running || this.disposed) return;
    this.queue = []; this.bytes = 0; this.sequence = 0; this.clientId = crypto.randomUUID(); this.paused = false; this.error = undefined; this.changed();
  }
  settled(): Promise<void> { return this.running ?? Promise.resolve(); }
  dispose(): void { this.disposed = true; this.queue = []; this.bytes = 0; }
}

/** Advance the cursor only after the real emulator has parsed the corresponding data. */
export class TerminalReplayCursor {
  sequence = 0;
  constructor(private readonly write: (data: string, sequence: number) => Promise<void>, private readonly reset: () => void, private readonly gap: () => void, private readonly writeBatch?: (chunks: TerminalChunk[]) => Promise<void>) {}
  restart(): void { this.reset(); this.sequence = 0; }
  async apply(replay: TerminalReplay): Promise<void> {
    if (replay.lastSequence < this.sequence) return; // An older in-flight response cannot rewind a view.
    if (replay.truncated && replay.firstSequence > this.sequence + 1) { this.reset(); this.sequence = replay.firstSequence - 1; this.gap(); }
    const chunks = replay.chunks.filter(chunk => chunk.sequence > this.sequence); let next = this.sequence;
    for (const chunk of chunks) {
      if (chunk.sequence !== next + 1) throw new Error("Terminal output has a sequence gap. Refresh its retained output.");
      next = chunk.sequence;
    }
    if (!chunks.length) return;
    if (this.writeBatch) { await this.writeBatch(chunks); this.sequence = next; }
    else for (const chunk of chunks) { await this.write(chunk.data, chunk.sequence); this.sequence = chunk.sequence; }
  }
}

export function newestTerminalInfo(current: TerminalInfo | undefined, incoming: TerminalInfo): TerminalInfo {
  const rank = { starting: 0, running: 1, closing: 2, exited: 3, error: 3 };
  return current && rank[current.status] > rank[incoming.status] ? current : incoming;
}
