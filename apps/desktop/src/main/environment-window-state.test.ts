import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultWindowView, environmentSectionKeys, parseWindowView } from "../window-state";
import { WindowStateStore } from "./window-state";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("Environment disclosure survives store reconstruction without changing another window", () => {
  const directory = mkdtempSync(join(tmpdir(), "environment-window-"));
  directories.push(directory);
  const original = { ...defaultWindowView(), route: { hostId: "remote", sessionId: "idle" }, environmentOpen: true, environmentCollapsed: [...environmentSectionKeys] };
  const first = new WindowStateStore(directory, "primary"), second = new WindowStateStore(directory, "second");
  expect(first.saveView(original)).toEqual({});
  expect(second.saveView(defaultWindowView())).toEqual({});
  expect(new WindowStateStore(directory, "primary").bootstrap().state).toEqual(original);
  expect(new WindowStateStore(directory, "second").bootstrap().state).toEqual(defaultWindowView());
  expect(first.saveView({ ...original, environmentCollapsed: [] })).toEqual({});
  expect(new WindowStateStore(directory, "primary").bootstrap().state?.environmentCollapsed).toEqual([]);
});

test("old window profiles remain valid and disclosure input is bounded and projected", () => {
  const old = defaultWindowView();
  expect(parseWindowView(old)).toEqual(old);
  expect(parseWindowView({ ...old, environmentCollapsed: ["jobs", "jobs"] })?.environmentCollapsed).toEqual(["jobs"]);
  for (const invalid of [null, "jobs", {}, ["unknown"], [false], Array(6).fill("jobs")]) {
    expect(parseWindowView({ ...old, environmentCollapsed: invalid })).toBeUndefined();
  }
});
