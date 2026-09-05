import type { NativeTerminalAttachment, NativeTerminalBridge, NativeTerminalCapabilities, NativeTerminalInfo, NativeTerminalInput, NativeTerminalInputReceipt, NativeTerminalInputRequest, NativeTerminalReplay, TerminalChunk } from "../../../../packages/shared/src/terminals";

export type NativeTerminalGeneration = Pick<NativeTerminalAttachment, "id" | "inputEpoch" | "geometryRevision">;
const sameGeneration = (a: NativeTerminalGeneration | undefined, b: NativeTerminalGeneration | undefined) => a?.id === b?.id && a?.inputEpoch === b?.inputEpoch && a?.geometryRevision === b?.geometryRevision;
const describe = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const size = (input: NativeTerminalInput) => input.kind === "bytes" ? Math.ceil(input.base64.length * 3 / 4) : new TextEncoder().encode(JSON.stringify(input)).length;

export function hasNativeTerminalBridge(value: object): value is NativeTerminalBridge {
  return ["getNativeTerminalCapabilities", "nativeTerminalQuery", "nativeTerminalAction", "writeNativeTerminal", "subscribeNativeTerminals"].every(key => typeof (value as Record<string, unknown>)[key] === "function");
}

/** Only an explicit old-host response permits the separate, labelled legacy terminal path. */
export function unsupportedNativeTerminal(cause: unknown): boolean {
  const value = cause as { code?: unknown; status?: unknown } | null;
  return value?.code === "NATIVE_TERMINAL_UNSUPPORTED" || value?.code === "UNSUPPORTED_TERMINAL_PROTOCOL" || value?.status === 404;
}
export function verifyNativeTerminalCapabilities(value: NativeTerminalCapabilities): void {
  if (value.protocol !== "tmux-v1" || value.tmuxVersion !== "3.7c" || !value.inputEpoch) throw new Error("The host terminal protocol is not supported by this desktop version.");
}

/** Input is never reinterpreted under a newer geometry/attachment or retried after lost receipts. */
export class NativeTerminalInputQueue {
  private generation?: NativeTerminalGeneration;
  private acknowledged = false;
  private connected = true;
  private clientId = crypto.randomUUID();
  private sequence = 0;
  private queue: { input: NativeTerminalInput; generation: NativeTerminalGeneration; bytes: number }[] = [];
  private bytes = 0;
  private running?: Promise<void>;
  private disposed = false;
  paused = false;
  error?: string;
  constructor(private terminalId: string, private send: (request: NativeTerminalInputRequest) => Promise<NativeTerminalInputReceipt>, private changed: () => void) {}
  get busy() { return this.running !== undefined; }
  get ready() { return !this.disposed && this.connected && this.acknowledged && !!this.generation && !this.paused; }
  get pendingBytes() { return this.bytes; }
  setGeneration(generation?: NativeTerminalGeneration): void {
    if (sameGeneration(this.generation, generation)) return;
    if (this.running || this.queue.length) this.pause("The terminal attachment or grid changed during input. Check the pane before resuming; queued input was discarded.");
    this.generation = generation ? { ...generation } : undefined; this.acknowledged = false;
    this.clientId = crypto.randomUUID(); this.sequence = 0;
    this.changed();
  }
  acknowledge(generation: NativeTerminalGeneration): void { if (sameGeneration(this.generation, generation)) { this.acknowledged = true; this.changed(); } }
  setConnected(connected: boolean): void {
    if (!connected && (this.running || this.queue.length)) this.pause("Connection lost during input. Delivery may be uncertain; queued input was discarded.");
    this.connected = connected; if (!connected) this.acknowledged = false; this.changed();
  }
  enqueue(input: NativeTerminalInput): void {
    if (this.disposed) return;
    if (!this.ready) { this.error ??= "Input was not submitted. Wait for the current terminal grid to reconnect and be acknowledged."; this.changed(); return; }
    const bytes = size(input);
    if (bytes > 65_536 || this.bytes + bytes > 65_536) { this.pause("Terminal input exceeds 64 KiB. Queued input was discarded; check the pane before resuming."); return; }
    this.queue.push({ input, generation: { ...this.generation! }, bytes }); this.bytes += bytes;
    if (!this.running) this.running = Promise.resolve().then(() => this.pump()).finally(() => { this.running = undefined; this.changed(); });
  }
  private async pump(): Promise<void> {
    while (this.queue.length && this.ready) {
      const item = this.queue.shift()!; this.bytes -= item.bytes;
      if (!sameGeneration(this.generation, item.generation)) { this.pause("Stale terminal input was not submitted. Check the current pane before resuming."); return; }
      const request: NativeTerminalInputRequest = { terminalId: this.terminalId, attachmentId: item.generation.id, inputEpoch: item.generation.inputEpoch, geometryRevision: item.generation.geometryRevision, clientId: this.clientId, sequence: ++this.sequence, input: item.input };
      try {
        const receipt = await this.send(request);
        if (receipt.sequence !== request.sequence) throw new Error("The input receipt sequence did not match.");
        if (receipt.outcome !== "accepted") { this.pause(`${receipt.outcome === "uncertain" ? "Input delivery is uncertain" : "Input was not submitted"}${receipt.code ? ` (${receipt.code})` : ""}${receipt.message ? `: ${receipt.message}` : "."} Queued input was discarded; check the pane before resuming.`); return; }
      } catch (cause) { if (!this.disposed) this.pause(`Input delivery is uncertain: ${describe(cause)} Queued input was discarded; check the pane before resuming.`); return; }
    }
  }
  pause(reason: string): void { this.queue = []; this.bytes = 0; this.paused = true; this.error = reason; this.changed(); }
  resume(): void {
    if (this.disposed || this.running || !this.connected || !this.acknowledged) return;
    this.queue = []; this.bytes = 0; this.clientId = crypto.randomUUID(); this.sequence = 0; this.paused = false; this.error = undefined; this.changed();
  }
  settled(): Promise<void> { return this.running ?? Promise.resolve(); }
  dispose(): void { this.disposed = true; this.queue = []; this.bytes = 0; }
}

/** A cursor belongs to one real attach PTY. An evicted tail is never parsed as a screen. */
export class NativeTerminalReplayCursor {
  sequence = 0;
  attachment?: NativeTerminalAttachment;
  constructor(private reset: (attachment: NativeTerminalAttachment) => void, private write: (chunks: TerminalChunk[]) => Promise<void>) {}
  begin(attachment: NativeTerminalAttachment): void { this.attachment = { ...attachment }; this.sequence = 0; this.reset(attachment); }
  async apply(replay: NativeTerminalReplay): Promise<"applied" | "stale" | "reset-required"> {
    if (replay.attachment.id !== this.attachment?.id) return "stale";
    if (replay.resetRequired || replay.attachment.inputEpoch !== this.attachment.inputEpoch || replay.attachment.geometryRevision !== this.attachment.geometryRevision) return "reset-required";
    if (replay.lastSequence < this.sequence) return "stale";
    const chunks = replay.chunks.filter(chunk => chunk.sequence > this.sequence); let next = this.sequence;
    for (const chunk of chunks) { if (chunk.sequence !== next + 1) return "reset-required"; next = chunk.sequence; }
    if (next !== replay.lastSequence) return "reset-required";
    const attachmentId = this.attachment.id;
    if (chunks.length) await this.write(chunks);
    if (this.attachment?.id !== attachmentId) return "stale";
    this.sequence = next; this.attachment = { ...replay.attachment }; return "applied";
  }
}

export function newestNativeTerminal(current: NativeTerminalInfo | undefined, next: NativeTerminalInfo): NativeTerminalInfo {
  if (!current || current.serverGeneration !== next.serverGeneration || current.inputEpoch !== next.inputEpoch) return next;
  if (next.geometryRevision < current.geometryRevision) return current;
  const rank = { starting: 0, running: 1, closing: 2, exited: 3, error: 3, interrupted: 3 };
  return rank[current.status] > rank[next.status] ? current : next;
}
