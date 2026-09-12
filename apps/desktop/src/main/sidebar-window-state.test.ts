import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCollapsedSidebarSections, defaultWindowView, maximumCollapsedSidebarSections, parseWindowView, type SidebarSectionKey } from "../window-state";
import { WindowStateStore } from "./window-state";

const directories: string[] = [];
function temporary() { const root = mkdtempSync(join(tmpdir(), "sidebar-window-")); directories.push(root); return root; }
afterEach(() => directories.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const custom = "custom:9e9b7f1d-3261-4cad-8e66-fcaa78f14e76" as const;
const savedView = () => ({ ...defaultWindowView(), route: { hostId: "work", sessionId: "selected" }, expandedProjects: ["work:project"],
  collapsedSidebarSections: ["recents", custom, "pinned"] as SidebarSectionKey[], browserCloses: [], terminalCreations: [] });

test("collapsed sections survive actual Store save/reopen without changing route, project expansion or browser history", () => {
  const root = temporary(), store = new WindowStateStore(root, "primary"), view = savedView();
  expect(store.saveView(view)).toEqual({});
  expect(new WindowStateStore(root, "primary").bootstrap().state).toEqual(view);
  const next = { ...view, collapsedSidebarSections: ["recents"] as SidebarSectionKey[] };
  expect(store.saveView(next)).toEqual({});
  expect(new WindowStateStore(root, "primary").bootstrap().state).toEqual(next);
  expect(JSON.parse(readFileSync(store.file, "utf8")).view.collapsedSidebarSections).toEqual(["recents"]);
});

test("legacy windows remain readable and omission differs from explicitly expanded Recents", () => {
  const { collapsedSidebarSections: _, ...legacy } = savedView();
  const root = temporary(), store = new WindowStateStore(root, "primary");
  writeFileSync(store.file, JSON.stringify({ version: 1, view: legacy }));
  const restored = new WindowStateStore(root, "primary").bootstrap();
  expect(restored.error).toBeUndefined();
  expect(restored.state).toEqual(legacy);
  expect(restored.state?.collapsedSidebarSections ?? defaultCollapsedSidebarSections()).toEqual(["recents"]);
  expect(store.saveView({ ...legacy, collapsedSidebarSections: [] })).toEqual({});
  expect(new WindowStateStore(root, "primary").bootstrap().state?.collapsedSidebarSections).toEqual([]);
});

test("separate window slots keep independent disclosure state", () => {
  const root = temporary(), first = new WindowStateStore(root, "primary"), second = new WindowStateStore(root, "second");
  expect(first.saveView(savedView())).toEqual({});
  expect(second.saveView({ ...savedView(), collapsedSidebarSections: ["projects"] })).toEqual({});
  expect(new WindowStateStore(root, "primary").bootstrap().state?.collapsedSidebarSections).toEqual(["recents", custom, "pinned"]);
  expect(new WindowStateStore(root, "second").bootstrap().state?.collapsedSidebarSections).toEqual(["projects"]);
});

test("sparse, duplicate and malformed sections are refused before ACK or any disk change", () => {
  const root = temporary(), store = new WindowStateStore(root, "primary"), before = savedView();
  expect(store.saveView(before)).toEqual({});
  const originalBytes = readFileSync(store.file, "utf8");
  const holeAfterValid = ["pinned"]; holeAfterValid.length = 2;
  const inheritedHole = new Array(1); Object.setPrototypeOf(inheritedHole, Object.assign(Object.create(Array.prototype), { 0: "pinned" }));
  for (const invalid of [new Array(1), holeAfterValid, inheritedHole, ["pinned", "pinned"], [custom, custom], ["unknown"], ["custom:"], ["custom:not-a-section"], [42], [null], null, false]) {
    expect(store.saveView({ ...before, collapsedSidebarSections: invalid }).error).toContain("invalid");
    expect(readFileSync(store.file, "utf8")).toBe(originalBytes);
    expect(store.bootstrap().state).toEqual(before);
    expect(new WindowStateStore(root, "primary").bootstrap().state).toEqual(before);
  }
});

test("section bound accepts three defaults and one thousand identities but rejects overflow", () => {
  const customSections = Array.from({ length: 1000 }, (_, index) => `custom:00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}` as SidebarSectionKey);
  const sections: SidebarSectionKey[] = ["pinned", "projects", "recents", ...customSections];
  expect(sections).toHaveLength(maximumCollapsedSidebarSections);
  expect(parseWindowView({ ...defaultWindowView(), collapsedSidebarSections: sections })?.collapsedSidebarSections).toEqual(sections);
  expect(parseWindowView({ ...defaultWindowView(), collapsedSidebarSections: [...sections, custom] })).toBeUndefined();
});

test("caller and returned-view mutations cannot change acknowledged section state", () => {
  const root = temporary(), store = new WindowStateStore(root, "primary"), input = savedView();
  expect(store.saveView(input)).toEqual({});
  input.collapsedSidebarSections.splice(0, input.collapsedSidebarSections.length, "projects");
  expect(store.bootstrap().state?.collapsedSidebarSections).toEqual(["recents", custom, "pinned"]);
  const returned = store.bootstrap().state!;
  returned.collapsedSidebarSections!.splice(0, 1);
  expect(store.bootstrap().state?.collapsedSidebarSections).toEqual(["recents", custom, "pinned"]);
  expect(input.collapsedSidebarSections).toEqual(["projects"]);
  expect(new WindowStateStore(root, "primary").bootstrap().state?.collapsedSidebarSections).toEqual(["recents", custom, "pinned"]);
});
