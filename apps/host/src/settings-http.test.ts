import { expect, test } from "bun:test";
import { parseSessionControlMutation } from "./settings-http";

const base = { expectedRevision: "controlled", operation: "advanced-stream", model: { provider: "google", id: "gemini-2.5-flash", api: "google-generative-ai" } } as const;

test("advanced stream parser accepts Top K actions and retains finite-number framing", () => {
  expect(parseSessionControlMutation({ ...base, field: "topK", action: "set", value: 20 })).toEqual({ ...base, field: "topK", action: "set", value: 20 });
  expect(parseSessionControlMutation({ ...base, field: "topK", action: "provider-default" })).toEqual({ ...base, field: "topK", action: "provider-default" });
  expect(parseSessionControlMutation({ ...base, field: "topK", action: "inherit" })).toEqual({ ...base, field: "topK", action: "inherit" });
  expect(() => parseSessionControlMutation({ ...base, field: "topK", action: "set", value: Number.NaN })).toThrow();
});
