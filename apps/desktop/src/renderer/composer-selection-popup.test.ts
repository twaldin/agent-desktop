import { expect, test } from "bun:test";
import { filterModelOptions, nextModelOption } from "./model-picker";

test("the popup keeps every native result reachable and keyboard skips unavailable entries", () => {
  const models = Array.from({ length: 137 }, (_, index) => ({ value: `native\0model-${index}`, label: `Model ${index}`, provider: "native", disabled: index === 135 }));
  const all = filterModelOptions(models, "");
  expect(all).toHaveLength(137); expect(all.at(-1)?.label).toBe("Model 136");
  const filtered = filterModelOptions(models, "model-13");
  expect(filtered.map(item => item.label)).toContain("Model 136");
  expect(nextModelOption(all, 134, 1)).toBe(136);
});
