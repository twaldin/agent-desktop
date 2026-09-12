import { expect, test } from "bun:test";
import { browserBackendCapabilities } from "./BrowserPanel";

const indexed = { documentId: "loader", width: 640, height: 480, scrollX: 0, scrollY: 0,
  navigation: { entryId: 3, canGoBack: true, canGoForward: false } };
const opaque = { documentId: "cmux-document", width: 640, height: 480, scrollX: 0, scrollY: 0,
  opaqueHistoryTraversal: true as const };

test("worker controls use disclosed history bounds and full page input", () => {
  expect(browserBackendCapabilities("worker", indexed)).toEqual({
    historyEntries: true, stop: true, pageInput: true, resize: true, back: true, forward: false,
  });
});

test("cmux exposes only opaque traversal and reload around its viewport", () => {
  expect(browserBackendCapabilities("cmux", opaque)).toEqual({
    historyEntries: false, stop: false, pageInput: false, resize: false, back: true, forward: true,
  });
  expect(browserBackendCapabilities("cmux", undefined)).toEqual({
    historyEntries: false, stop: false, pageInput: false, resize: false, back: false, forward: false,
  });
});
