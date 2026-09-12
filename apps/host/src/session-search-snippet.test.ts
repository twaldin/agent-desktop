import { expect, test } from "bun:test";
import { sessionSearchSnippet } from "./session-search";

test("late double-space match is located before display whitespace normalization", () => {
  const text = `Unrelated opening ${"x".repeat(450)} actual needle  phrase with context`;
  const snippet = sessionSearchSnippet(text, "needle  phrase");
  expect(snippet).toContain("actual needle phrase with context");
  expect(snippet).not.toContain("Unrelated opening");
  expect(snippet.startsWith("…")).toBe(true); expect(snippet.length).toBeLessThanOrEqual(240);
});
test("nearby single-space lookalike does not replace the later exact double-space occurrence", () => {
  const text = `wrong needle phrase ${"x".repeat(450)} right needle  phrase`;
  expect(sessionSearchSnippet(text, "needle  phrase")).toContain("right needle phrase");
  expect(sessionSearchSnippet(text, "needle  phrase")).not.toContain("wrong");
});
test("case-fold expansion before the match does not shift the source excerpt past it", () => {
  const text = `${"İ".repeat(450)} actual NEEDLE  phrase`;
  expect(sessionSearchSnippet(text, "needle  phrase")).toContain("actual NEEDLE phrase");
  expect(() => sessionSearchSnippet(text, "absent")).toThrow();
});
