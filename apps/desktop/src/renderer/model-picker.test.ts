import { expect, test } from "bun:test";
import { filterModelOptions, nextModelOption, type ModelPickerOption } from "./model-picker";

test("large native catalogs are searched by provider, exact identity and all query terms without merging names", () => {
  const options: ModelPickerOption[] = Array.from({ length: 4900 }, (_, index) => ({ value: `provider-${index}\0same-name`, label: "Same displayed name", provider: `provider-${index}`, detail: `Context ${index}`, disabled: index === 4899 }));
  expect(filterModelOptions(options, "PROVIDER-4899 context 4899")).toEqual([options[4899]!]);
  expect(filterModelOptions(options, "same-name")).toHaveLength(4900);
  expect(filterModelOptions(options, "   ")).toHaveLength(4900);
  expect(filterModelOptions(options, "no matches")).toEqual([]);
  expect(options[4899]!.disabled).toBe(true);
});

test("keyboard navigation skips disabled entries, preserves the native default, and stops at each bound", () => {
  const options = [{ value: "", label: "Native default" }, { value: "off", label: "Disabled provider", disabled: true }, { value: "real", label: "Available model" }];
  expect(nextModelOption(options, -1, 1)).toBe(0);
  expect(nextModelOption(options, 0, 1)).toBe(2);
  expect(nextModelOption(options, 2, 1)).toBe(2);
  expect(nextModelOption(options, 2, -1)).toBe(0);
  expect(nextModelOption(options, 0, -1)).toBe(0);
  expect(nextModelOption([{ value: "none", label: "Disabled", disabled: true }], -1, 1)).toBe(-1);
});
