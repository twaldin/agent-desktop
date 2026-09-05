import { describe, expect, test } from "bun:test";
import { ThemeImageState } from "./theme-image-state";
const one = "1".repeat(64), two = "2".repeat(64);
const result = (id: string) => ({ asset: { sha256: id, mimeType: "image/png" as const, bytes: 1 }, dataUrl: "data:image/png;base64,AA==" });
describe("theme image delivery state", () => {
  test("a missing peer asset retains its hash and refreshes after delivery", async () => {
    let arrived = false; const data = new ThemeImageState({ getThemeBackground: async id => arrived ? result(id) : null }, async () => {});
    data.select(one); await data.refresh(); expect(data.sha256).toBe(one); expect(data.status).toBe("unavailable"); expect(data.dataUrl).toBeUndefined();
    arrived = true; await data.refresh(); expect(data.status).toBe("ready"); expect(data.asset?.sha256).toBe(one);
  });
  test("a slower previous selection cannot replace a newly loaded image", async () => {
    let resolve!: (value: ReturnType<typeof result>) => void;
    const data = new ThemeImageState({ getThemeBackground: id => id === one ? new Promise(done => { resolve = done; }) : Promise.resolve(result(id)) }, async () => {});
    data.select(one); data.select(two); await data.refresh(); resolve(result(one)); await Promise.resolve(); await Promise.resolve();
    expect(data.asset?.sha256).toBe(two); expect(data.sha256).toBe(two);
  });
  test("foreign hashes and arbitrary URLs never become image sources", async () => {
    const foreign = new ThemeImageState({ getThemeBackground: async () => result(two) }, async () => {}); foreign.select(one); await foreign.refresh(); expect(foreign.status).toBe("error"); expect(foreign.dataUrl).toBeUndefined();
    let decodes = 0; const url = new ThemeImageState({ getThemeBackground: async () => ({ ...result(one), dataUrl: "https://example.invalid/background.png" }) }, async () => { decodes++; }); url.select(one); await url.refresh(); expect(url.status).toBe("error"); expect(decodes).toBe(0);
  });
  test("failed browser decoding leaves the selected document unchanged", async () => {
    const data = new ThemeImageState({ getThemeBackground: async id => result(id) }, async () => { throw new Error("Image decoding failed"); }); data.select(one); await data.refresh(); expect(data.status).toBe("error"); expect(data.sha256).toBe(one); expect(data.dataUrl).toBeUndefined();
    data.select(); expect(data.status).toBe("none"); expect(data.sha256).toBeUndefined();
  });
});
