import { expect, test } from "bun:test";
import { jpegViewportDimensions, parseNativeBrowserFrame, validBrowserFrameTarget } from "./browser-frame";
import { jpeg3x2 } from "./fixtures/browser-frame";

const target = { workerPid: 42, name: "main", targetId: "target" };
const frame = { ...target, capturedAt: 1, mimeType: "image/jpeg", data: jpeg3x2, width: 3, height: 2, title: "", url: "about:blank" };

test("browser frames use actual JPEG dimensions and only permitted fields", () => {
  expect(jpegViewportDimensions(Buffer.from(jpeg3x2, "base64"))).toEqual({ width: 3, height: 2 });
  const parsed = parseNativeBrowserFrame({ ...frame, endpoint: "private", cookies: "private" }, target);
  expect(parsed.title).toBe(""); expect(parsed).not.toHaveProperty("endpoint"); expect(parsed).not.toHaveProperty("cookies"); expect(parsed).not.toHaveProperty("workerPid");
  for (const change of [{ name: "different" }, { targetId: "different" }, { width: 4 }, { height: 3 }, { data: jpeg3x2.slice(0, -4) }, { data: "not a jpeg" }, { mimeType: "text/html" }, { capturedAt: -1 }]) {
    expect(() => parseNativeBrowserFrame({ ...frame, ...change }, target)).toThrow();
  }
});

test("browser JPEG header rejects truncation and oversized decoded dimensions", () => {
  const bytes = Buffer.from(jpeg3x2, "base64");
  for (const length of [0, 3, 25, 100]) expect(() => jpegViewportDimensions(bytes.subarray(0, length))).toThrow();
  const oversized = Buffer.from(bytes), sof = oversized.indexOf(Buffer.from([255, 192]));
  expect(sof).toBeGreaterThan(0);
  oversized[sof + 5] = 255; oversized[sof + 6] = 255;
  expect(() => jpegViewportDimensions(oversized)).toThrow();
  expect(validBrowserFrameTarget({ ...target, workerPid: 0 })).toBe(false);
  expect(validBrowserFrameTarget({ ...target, name: "\0" })).toBe(false);
});
