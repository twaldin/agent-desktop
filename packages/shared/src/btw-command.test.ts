import { expect, test } from "bun:test";
import { nativeBtwQuestion } from "./btw";

test("nativeBtwQuestion follows the pinned lexical /btw route", () => {
  expect(nativeBtwQuestion("/btw explain this ")).toBe("explain this");
  expect(nativeBtwQuestion("/btw\n  explain this\n")).toBe("explain this");
  expect(nativeBtwQuestion("/btw")).toBe("");
  for (const text of [" /btw hidden", "/BTW hidden", "/btween hidden", "before /btw hidden"]) expect(nativeBtwQuestion(text)).toBeUndefined();
});
