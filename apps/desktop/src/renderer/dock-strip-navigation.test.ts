import { expect, test } from "bun:test";
import { dockStripFocusTarget } from "./dock-strip-navigation";

const ids = ["chat", "file-a", "browser-b"];
test("one roving group wraps between Chat and content in LTR and RTL", () => {
  expect(dockStripFocusTarget(ids,"chat","ArrowLeft","ltr")).toBe("browser-b");
  expect(dockStripFocusTarget(ids,"browser-b","ArrowRight","ltr")).toBe("chat");
  expect(dockStripFocusTarget(ids,"chat","ArrowLeft","rtl")).toBe("file-a");
  expect(dockStripFocusTarget(ids,"file-a","ArrowRight","rtl")).toBe("chat");
});
test("Home/End stay logical and unsupported keys/missing owners have no focus target", () => {
  for (const direction of ["ltr","rtl"] as const) {
    expect(dockStripFocusTarget(ids,"file-a","Home",direction)).toBe("chat");
    expect(dockStripFocusTarget(ids,"chat","End",direction)).toBe("browser-b");
    expect(dockStripFocusTarget(ids,"missing","ArrowLeft",direction)).toBeUndefined();
    for (const key of ["Delete","Tab","Enter","ArrowDown"]) expect(dockStripFocusTarget(ids,"chat",key,direction)).toBeUndefined();
  }
  expect(dockStripFocusTarget([],"chat","Home","ltr")).toBeUndefined();
});
