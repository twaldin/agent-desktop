import { expect, test } from "bun:test";
import { ExtensionUiState } from "./extension-ui-state";
import { extensionTextRuns } from "./extension-text";
import { parseNativeExtensionUiSnapshot, type ExtensionUiResult } from "../../../../packages/shared/src/extension-ui";
const result = (epoch = "epoch", revision = 1): ExtensionUiResult => ({ protocolVersion: 1, hostId: "host", sessionId: "session", availability: "available", value: { sessionId: "session", epoch, revision, statuses: [{ key: "__proto__", text: "native" }], widgets: [] } });
const tick = () => Bun.sleep(0);
test("disconnect retains last observed data and fences in-flight read; owner loss clears", async () => {
  let response = Promise.resolve(result()); const state = new ExtensionUiState("host", "session", () => response); state.start(); await tick();
  const pending = Promise.withResolvers<ExtensionUiResult>(); response = pending.promise; void state.refresh(); state.stop(); pending.resolve(result("late")); await tick();
  expect(state.snapshot().value?.epoch).toBe("epoch");
  response = Promise.resolve({ protocolVersion: 1, hostId: "host", sessionId: "session", availability: "unavailable", reason: "Original owner ended" }); state.start(); await tick();
  expect(state.snapshot().value).toBeUndefined(); expect(state.snapshot().unavailable).toBe("Original owner ended"); state.stop();
});
test("snapshot ordering rejects older revisions, retired epochs and foreign owners without a retry loop", async () => {
  let next = result(), calls = 0; const state = new ExtensionUiState("host", "session", async () => { calls++; return next; }); state.start(); await tick();
  next = result("epoch", 0); await state.refresh(); expect(state.snapshot().value?.revision).toBe(1);
  next = result("new", 2); await state.refresh(); next = result("epoch", 99); await state.refresh(); expect(state.snapshot().value?.epoch).toBe("new");
  next = { ...result("other"), hostId: "foreign" }; await state.refresh(); expect(state.snapshot().value?.epoch).toBe("new");
  await tick(); expect(calls).toBe(5); state.stop();
});
test("safe SGR preserves text styles and line breaks while terminal/OSC actions remain inert", () => {
  const runs = extensionTextRuns('\x1b[1;38;2;12;34;56mBold\x1b[0m\tplain\n<script>bad()</script>\x1b]8;;javascript:bad()\x07link\x1b]8;;\x07\x1b[2J\x00');
  expect(runs[0]).toMatchObject({ text: "Bold", style: { color: "rgb(12, 34, 56)", fontWeight: 600 } });
  expect(runs.map(run => run.text).join("")).toBe('\tplain\n<script>bad()</script>link'.replace(/^/, 'Bold'));
  expect(JSON.stringify(runs)).not.toContain('javascript:'); expect(extensionTextRuns("a\x1b]unclosed").map(run => run.text).join("")).toBe("a");
  expect(extensionTextRuns("\x1b[48;5;196mred")[0]?.style.backgroundColor).toBe("rgb(255, 0, 0)");
});
test("snapshot parser preserves arbitrary keys and refuses duplicates/malformed widget metadata", () => {
  const value = (result() as Extract<ExtensionUiResult, { availability: "available" }>).value;
  expect(parseNativeExtensionUiSnapshot(value).statuses[0]?.key).toBe("__proto__");
  expect(() => parseNativeExtensionUiSnapshot({ ...value, statuses: [...value.statuses, ...value.statuses] })).toThrow();
  expect(() => parseNativeExtensionUiSnapshot({ ...value, widgets: [{ key: "", lines: [1], placement: "aboveEditor", truncated: false }] })).toThrow();
});

test("a temporarily unavailable original worker can recover its same epoch; a replacement retires it", async () => {
  let next: ExtensionUiResult = result(); const state = new ExtensionUiState("host", "session", async () => next); state.start(); await tick();
  next = { protocolVersion: 1, hostId: "host", sessionId: "session", availability: "unavailable", reason: "Read unavailable" }; await state.refresh(); expect(state.snapshot().value).toBeUndefined();
  next = result("epoch", 2); await state.refresh(); expect(state.snapshot().value?.revision).toBe(2);
  next = result("replacement", 1); await state.refresh(); next = result("epoch", 100); await state.refresh(); expect(state.snapshot().value?.epoch).toBe("replacement"); state.stop();
});
test("concealed SGR text remains concealed until reset", () => {
  const runs = extensionTextRuns("\x1b[8mhidden\x1b[28mvisible"); expect(runs[0]?.style.visibility).toBe("hidden"); expect(runs[1]?.style.visibility).toBeUndefined();
});

test("an event arriving during a read rejects that older snapshot then reads the newest revision once", async () => {
  const pending = Promise.withResolvers<ExtensionUiResult>(); let calls = 0;
  const state = new ExtensionUiState("host", "session", async () => ++calls === 1 ? pending.promise : result("epoch", 3));
  state.start(); state.changed("epoch", 3); pending.resolve(result("epoch", 2)); await tick(); await tick();
  expect(state.snapshot().value?.revision).toBe(3); expect(calls).toBe(2); state.stop();
});
