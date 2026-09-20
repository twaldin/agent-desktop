import { expect, test } from "bun:test";
import { NativeExtensionUi } from "./extension-ui";
import { OmpInteractionBridge, UnsupportedOmpUIError } from "./interactions";
import { sanitizeStatusText } from "@oh-my-pi/pi-coding-agent/modes/shared";
import { projectWorkerEvent } from "../omp-workers/events";

test("native status sorting, exact keys, sanitation and no-op replacement", () => {
  const changes: number[] = [], state = new NativeExtensionUi("session", (_, revision) => changes.push(revision));
  const raw = "\x1b[31m ready\x1b[0m\t now\n\x00done\x1b]8;;https://invalid.test\x07 link\x1b]8;;\x07";
  for (const key of ["z", "__proto__", "", "á", "constructor"]) state.setStatus(key, raw);
  expect(state.snapshot().statuses.map(value => value.key)).toEqual(["z", "__proto__", "", "á", "constructor"].sort((a, b) => a.localeCompare(b)));
  expect(state.snapshot().statuses.every(value => value.text === sanitizeStatusText(raw))).toBe(true);
  state.setStatus("z", raw); state.setStatus("absent", undefined); expect(changes).toEqual([1, 2, 3, 4, 5]);
  state.setStatus("", undefined); expect(state.snapshot().statuses.some(value => value.key === "")).toBe(false);
});
test("widgets replace across placements, append on replacement and honor native ten-entry limit", () => {
  const state = new NativeExtensionUi("session", () => {});
  state.setWidget("first", ["one"]); state.setWidget("second", ["two"]); state.setWidget("first", ["new"]);
  expect(state.snapshot().widgets.map(value => value.key)).toEqual(["second", "first"]);
  const lines = Array.from({ length: 12 }, (_, index) => String(index)); state.setWidget("__proto__", lines, { placement: "belowEditor" }); lines[0] = "mutated";
  expect(state.snapshot().widgets[2]).toEqual({ key: "__proto__", placement: "belowEditor", lines: Array.from({ length: 10 }, (_, index) => String(index)), truncated: true });
  state.setWidget("first", [], { placement: "belowEditor" }); expect(state.snapshot().widgets.at(-1)?.placement).toBe("belowEditor");
  state.setWidget("first", undefined); expect(state.snapshot().widgets.map(value => value.key)).toEqual(["second", "__proto__"]);
});
test("factories are explicit unsupported, never invoked; disposed owner rejects late writes", () => {
  const events: unknown[] = [], bridge = new OmpInteractionBridge("session", event => events.push(projectWorkerEvent(event)));
  let called = false;
  expect(() => bridge.setWidget("factory", () => { called = true; return { render: () => [], invalidate() {} }; })).toThrow(UnsupportedOmpUIError);
  expect(called).toBe(false); expect(events).toContainEqual(expect.objectContaining({ type: "extension_ui_unsupported", surface: "setWidget(component factory)" }));
  bridge.setStatus("key", "active"); const epoch = bridge.presentation.epoch;
  bridge.dispose(); const count = events.length;
  expect(() => bridge.setStatus("key", "late")).toThrow("disposed"); expect(() => bridge.presentation.snapshot()).toThrow("disposed");
  expect(events.length).toBe(count); expect(events).toContainEqual({ type: "extension_ui_changed", sessionId: "session", epoch, revision: 2 });
});
