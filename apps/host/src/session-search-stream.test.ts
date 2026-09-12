import { expect, test } from "bun:test";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { searchSessionStream } from "./session-search-stream";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + "\n");
const header = encode({ type: "session", id: "native", version: 3, timestamp: "2026-09-08T00:00:00Z", cwd: "/project" });
const message = (text: string) => encode({ type: "message", id: "entry", parentId: null, message: { role: "user", content: text } });
const signal = () => new AbortController().signal;

test("finds a late match beyond 8MiB without receiving a whole-journal buffer", async () => {
  const block = message("padding ".repeat(800));
  let count = 0, total = 0;
  async function* source() {
    yield header; total += header.byteLength;
    for (let i = 0; i < 1600; i++) { count++; total += block.byteLength; yield block; }
    const last = message("Late journal sapphire"); total += last.byteLength; yield last;
  }
  const result = await searchSessionStream(source(), "native", "sapphire", signal());
  expect(total).toBeGreaterThan(8 * 1024 * 1024); expect(result.bytes).toBe(total);
  expect(result.snippet).toBe("Late journal sapphire"); expect(count).toBe(1600);
});

test("native title slot, CRLF, escaped text and UTF8 crossing byte boundaries are searchable", async () => {
  const title = serializeTitleSlot({ title: "title slot", updatedAt: "2026-09-08T00:00:00Z" });
  const content = new TextEncoder().encode(title + new TextDecoder().decode(header) + new TextDecoder().decode(message('Café 🪶 says "sapphire"')).trimEnd());
  async function* source() { for (const byte of content) yield new Uint8Array([byte]); }
  const result = await searchSessionStream(source(), "native", '🪶 says "sapphire"', signal());
  expect(result.bytes).toBe(content.byteLength); expect(result.snippet).toBe('Café 🪶 says "sapphire"');
  async function* crlf() { yield new TextEncoder().encode(new TextDecoder().decode(header).replace("\n", "\r\n")); yield message("crlf"); }
  expect((await searchSessionStream(crlf(), "native", "crlf", signal())).snippet).toBe("crlf");
});

test("malformed trailing records and invalid UTF8 cannot turn an earlier match into complete success", async () => {
  for (const tail of [new TextEncoder().encode("{incomplete"), new Uint8Array([0xff])]) {
    async function* source() { yield header; yield message("sapphire"); yield tail; }
    await expect(searchSessionStream(source(), "native", "sapphire", signal())).rejects.toThrow();
  }
});

test("cancellation between parser batches rejects and closes the source iterator", async () => {
  const controller = new AbortController(); let closed = false, yielded = 0;
  async function* source() {
    try { yield header; for (let i = 0; i < 300; i++) { yielded++; yield message("no match"); } }
    finally { closed = true; }
  }
  await expect(searchSessionStream(source(), "native", "sapphire", controller.signal, async () => { controller.abort(); })).rejects.toThrow();
  expect(closed).toBe(true); expect(yielded).toBeLessThan(300);
});
