import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultWindowView } from "../window-state";
import { WindowStateStore as CurrentStore } from "./window-state";
const WindowStateStore: typeof CurrentStore = process.env.AGENT_DESKTOP_WINDOW_DURABILITY_SOURCE
  ? (await import(process.env.AGENT_DESKTOP_WINDOW_DURABILITY_SOURCE)).WindowStateStore : CurrentStore;

// POSIX owner permissions cannot force a denial for root; do not count that as failure-path proof.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("directory acknowledgement failure after rename is not reported as a successful window save", () => {
  const root = mkdtempSync(join(tmpdir(), "window-directory-sync-"));
  try {
    const store = new WindowStateStore(root, "primary");
    const before = defaultWindowView(), next = { ...before, route: { hostId: "owner", sessionId: "next-session" } };
    expect(store.saveView(before)).toEqual({});
    // Write/search permits temporary-file write and rename, but forbids opening the directory for read/fsync.
    chmodSync(root, 0o300);
    const result = store.saveView(next);
    expect(result.error).toContain("could not be saved");
    expect(store.bootstrap().state).toEqual(before);
    expect(store.bootstrap().error).toBe(result.error);
    // Failure was AFTER rename, not a rollback or a failed temporary-file write.
    expect(JSON.parse(readFileSync(store.file, "utf8")).view).toEqual(next);
    chmodSync(root, 0o700);
    expect(readdirSync(root)).toEqual(["window-primary-v1.json"]);
    expect(store.saveView(next)).toEqual({});
    expect(new WindowStateStore(root, "primary").bootstrap()).toEqual({ ownerSlot: "primary", state: next });
  } finally { chmodSync(root, 0o700); rmSync(root, { recursive: true, force: true }); }
});

test("successful view and geometry saves retain each other's acknowledged fields across reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "window-directory-reopen-"));
  try {
    const store = new WindowStateStore(root, "primary"), view = { ...defaultWindowView(), sidebarOpen: false };
    const bounds = { x: 10, y: 40, width: 1440, height: 1000 };
    expect(store.saveView(view)).toEqual({}); expect(store.saveGeometry(bounds, false)).toEqual({});
    const reopened = new WindowStateStore(root, "primary");
    expect(reopened.bootstrap()).toEqual({ ownerSlot: "primary", state: view });
    expect(reopened.geometry()).toEqual({ bounds, maximized: false });
    expect(readdirSync(root)).toEqual(["window-primary-v1.json"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
