import { expect, test } from "bun:test";
import { defaultFileTreeView } from "../window-state";
import { fileTreeResize, fileTreeWidth } from "./file-tree-layout";

test("file tree clamps width and closes only below the native half-minimum threshold", () => {
  const view = { open: true, width: 250 };
  expect(fileTreeResize(view, 99, 1000)).toEqual({ open: false, width: 250 });
  expect(fileTreeResize(view, 100, 1000)).toEqual({ open: true, width: 200 });
  expect(fileTreeResize(view, 199, 1000)).toEqual({ open: true, width: 200 });
  expect(fileTreeResize(view, 5000, 1000)).toEqual({ open: true, width: 600 });
  expect(fileTreeWidth(300, 400)).toBe(240);
  // CSS max-width:60% supplies the final bound when the parent itself is narrower than 333px.
  expect(fileTreeWidth(250, 200)).toBe(200);
  expect(defaultFileTreeView()).toEqual({ open: false, width: 250 });
});
