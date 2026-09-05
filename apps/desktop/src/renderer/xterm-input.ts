import type { Terminal } from "@xterm/xterm";
import metadata from "@xterm/xterm/package.json";

export interface ParsedTerminalReply { data: string; outputSequence: number; ordinal: number }
interface PinnedCore {
  coreService: { triggerDataEvent(data: string, wasUserInput?: boolean): void };
  _inputHandler: { parse(data: string | Uint8Array, promiseResult?: boolean): void | Promise<boolean> };
}

/**
 * xterm 6's public onData combines keyboard/paste/mouse and terminal query answers.
 * This small pinned seam observes the parser's actual synchronous stack, so typing
 * between asynchronous write slices remains user input. No escape-byte guessing.
 */
export function separateXtermReplies(terminal: Terminal) {
  const core = (terminal as unknown as { _core?: PinnedCore })._core;
  if (metadata.version !== "6.0.0" || typeof core?.coreService?.triggerDataEvent !== "function" || typeof core?._inputHandler?.parse !== "function") throw new Error("The pinned terminal input adapter needs verification for this xterm version.");
  const originalData = core.coreService.triggerDataEvent;
  const originalParse = core._inputHandler.parse;
  let parsing = 0; let replies: ParsedTerminalReply[] = []; let bytes = 0; let overflow = false; let disposed = false;
  let queue: { sequence: number; ordinal: number; cancel(): void }[] = []; let busy = false;
  const parse: PinnedCore["_inputHandler"]["parse"] = function(data, promiseResult) { parsing++; try { return originalParse.call(core._inputHandler, data, promiseResult); } finally { parsing--; } };
  const data: PinnedCore["coreService"]["triggerDataEvent"] = function(value, wasUserInput = false) {
    if (parsing && !wasUserInput) {
      // Parser answers are never delivered through the user-input event, even for history.
      const frame = queue[0];
      if (frame && !overflow) {
        bytes += new TextEncoder().encode(value).length;
        if (replies.length >= 2048 || bytes > 65_536) overflow = true;
        else replies.push({ data: value, outputSequence: frame.sequence, ordinal: ++frame.ordinal });
      }
      return;
    }
    return originalData.call(core.coreService, value, wasUserInput);
  };
  core._inputHandler.parse = parse; core.coreService.triggerDataEvent = data;
  const adapter = {
    write(value: string, outputSequence: number): Promise<ParsedTerminalReply[]> { return adapter.writeBatch([{ data: value, sequence: outputSequence }]); },
    async writeBatch(chunks: { data: string; sequence: number }[]): Promise<ParsedTerminalReply[]> {
      if (disposed || busy) throw new Error("Terminal parser writes must be serialized.");
      busy = true; replies = []; bytes = 0; overflow = false;
      try {
        // Queue the batch at once: xterm drains it in its own time slices. Awaiting each
        // chunk separately introduces a browser timer per chunk, disastrous in hidden tabs.
        await Promise.all(chunks.map(chunk => new Promise<void>((resolve, reject) => { queue.push({ sequence: chunk.sequence, ordinal: 0, cancel: () => reject(new Error("Terminal parser attachment was disposed.")) }); terminal.write(chunk.data, () => { queue.shift(); resolve(); }); })));
        if (overflow) throw new Error("The terminal emitted too many protocol replies in one output chunk.");
        return replies;
      } finally { busy = false; queue = []; }
    },
    dispose() {
      disposed = true;
      for (const frame of queue) frame.cancel();
      if (core.coreService.triggerDataEvent === data) core.coreService.triggerDataEvent = originalData;
      if (core._inputHandler.parse === parse) core._inputHandler.parse = originalParse;
    },
  };
  return adapter;
}

export function binaryTerminalInput(value: string): string {
  if ([...value].some(character => character.charCodeAt(0) > 255)) throw new Error("Terminal binary input contains a non-byte character.");
  return btoa(value);
}
