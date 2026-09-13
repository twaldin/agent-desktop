import { describe, expect, test } from "bun:test";
const { assertCaptureTransition } = require("./capture-state.cjs") as {
  assertCaptureTransition(previous: Capture | undefined, current: Capture): void;
};
interface Capture { state: { open: boolean; modal: boolean }; sha256: string }
const closed = { open: false, modal: false }, open = { open: true, modal: true };
describe("native reset-dialog capture transitions", () => {
  test("rejects an old closed frame after opening and an old open frame after dismissal", () => {
    for (const [before, after] of [[closed, open], [open, closed]]) {
      expect(() => assertCaptureTransition({ state: before!, sha256: "same" }, { state: after!, sha256: "same" })).toThrow("previous frame");
    }
  });
  test("accepts changed native images across opening and dismissal", () => {
    for (const [before, after] of [[closed, open], [open, closed]]) {
      expect(() => assertCaptureTransition({ state: before!, sha256: "before" }, { state: after!, sha256: "after" })).not.toThrow();
    }
  });
  test("allows unchanged pixels without a dialog transition and the first capture", () => {
    expect(() => assertCaptureTransition({ state: open, sha256: "same" }, { state: open, sha256: "same" })).not.toThrow();
    expect(() => assertCaptureTransition(undefined, { state: closed, sha256: "first" })).not.toThrow();
  });
  test("a modal change also requires a different image", () => {
    expect(() => assertCaptureTransition({ state: { open: true, modal: false }, sha256: "same" }, { state: open, sha256: "same" })).toThrow("previous frame");
  });
});
