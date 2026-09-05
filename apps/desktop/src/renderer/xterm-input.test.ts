import { expect, test } from "bun:test";
import { Terminal } from "@xterm/xterm";
import { binaryTerminalInput, separateXtermReplies } from "./xterm-input";

test("the pinned real xterm parser separates DSR/DA answers from keyboard and bracketed paste", async () => {
  const terminal = new Terminal({ cols: 80, rows: 24 });
  // The parser runs without a DOM. This supplies only paste's textarea cleanup target.
  (terminal as unknown as { _core: { textarea: { value: string } } })._core.textarea = { value: "" };
  const adapter = separateXtermReplies(terminal); const user: string[] = [];
  const listener = terminal.onData(data => user.push(data));
  try {
    const writing = adapter.write("\x1b[4;9H\x1b[6n\x1b[c\x1b[?2004h", 12);
    terminal.input("keyboard", true); terminal.paste("line one\nline two");
    const replies = await writing;
    expect(user).toEqual(["keyboard", "line one\rline two"]);
    expect(replies.map(reply => reply.data)).toEqual(["\x1b[4;9R", "\x1b[?1;2c"]);
    expect(replies.map(reply => [reply.outputSequence, reply.ordinal])).toEqual([[12, 1], [12, 2]]);
    terminal.paste("pasted\ntext");
    expect(user.at(-1)).toBe("\x1b[200~pasted\rtext\x1b[201~");
    terminal.options.disableStdin = true;
    expect(await adapter.write("\x1b[6n", 13)).toEqual([{ data: "\x1b[4;9R", outputSequence: 13, ordinal: 1 }]);
    expect(user.some(value => value.endsWith("R"))).toBe(false);
  } finally { listener.dispose(); adapter.dispose(); terminal.dispose(); }
});

test("binary mouse input preserves every byte and rejects non-byte strings", () => {
  const input = String.fromCharCode(0, 3, 27, 127, 128, 193, 254, 255);
  expect([...Buffer.from(binaryTerminalInput(input), "base64")]).toEqual([0, 3, 27, 127, 128, 193, 254, 255]);
  expect(() => binaryTerminalInput("\u{10000}")).toThrow("non-byte");
});

test("batched real parser writes retain exact chunk identities across split escape sequences", async () => {
  const terminal = new Terminal(); const adapter = separateXtermReplies(terminal); const user: string[] = [];
  const listener = terminal.onData(data => user.push(data));
  try {
    const chunks = [{ sequence: 1, data: "\x1b[7;11H\x1b[" }, { sequence: 2, data: "6n\x1b[c" }, ...Array.from({ length: 80 }, (_, index) => ({ sequence: index + 3, data: "\x1b[6n" }))];
    const replies = await adapter.writeBatch(chunks);
    expect(replies).toHaveLength(82); expect(replies[0]).toEqual({ data: "\x1b[7;11R", outputSequence: 2, ordinal: 1 });
    expect(replies[1]).toEqual({ data: "\x1b[?1;2c", outputSequence: 2, ordinal: 2 });
    expect(replies.slice(2).every((reply, index) => reply.outputSequence === index + 3 && reply.ordinal === 1)).toBe(true);
    expect(user).toEqual([]);
  } finally { listener.dispose(); adapter.dispose(); terminal.dispose(); }
});
