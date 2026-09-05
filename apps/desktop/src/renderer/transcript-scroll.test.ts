import { test, expect } from "bun:test";
import { TranscriptReadingPositions } from "./transcript-scroll";

test("reading positions are host-scoped, survive reload, and retain only the newest 100 entries", () => {
  let data: string | null = null;
  const storage = { getItem: () => data, setItem: (_key: string, value: string) => { data = value; } };
  const positions = new TranscriptReadingPositions(storage);
  for (let i = 0; i < 102; i++) positions.set(`host-${i}:same-session`, { following: false, scrollTop: i * 10, anchor: { messageId: `native-${i}`, path: [0, 2], offset: -13.5 } });
  positions.flush();
  const restored = new TranscriptReadingPositions(storage);
  expect(restored.get("host-0:same-session")).toBeUndefined();
  expect(restored.get("host-1:same-session")).toBeUndefined();
  expect(restored.get("host-2:same-session")?.anchor?.messageId).toBe("native-2");
  expect(restored.get("host-101:same-session")?.scrollTop).toBe(1010);
  expect(JSON.parse(data!).length).toBe(100);
});

test("invalid positions are ignored without disabling valid entries or exposing stored extra fields", () => {
  const saved = [["negative", { following: false, scrollTop: -1 }], ["bad-path", { following: false, scrollTop: 1, anchor: { messageId: "m", path: [1.5], offset: 0 } }], ["okay", { following: true, scrollTop: 42, transcriptText: "must not be retained" }]];
  let written = "";
  const positions = new TranscriptReadingPositions({ getItem: () => JSON.stringify(saved), setItem: (_key, value) => { written = value; } });
  expect(positions.get("negative")).toBeUndefined(); expect(positions.get("bad-path")).toBeUndefined();
  expect(positions.get("okay")).toEqual({ following: true, scrollTop: 42 });
  positions.flush(); expect(written).not.toContain("must not be retained");
});

test("disabled session storage retains usable window memory", () => {
  const positions = new TranscriptReadingPositions({ getItem: () => { throw new Error("unavailable"); }, setItem: () => { throw new Error("unavailable"); } });
  positions.set("host:session", { following: false, scrollTop: 87 }); positions.flush();
  expect(positions.get("host:session")).toEqual({ following: false, scrollTop: 87 });
});
