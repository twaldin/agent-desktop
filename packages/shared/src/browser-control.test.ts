import { expect, test } from "bun:test";
import { parseBrowserControlRequest, parseBrowserDocumentContext } from "./browser-control";

const navigation = { entryId: 7, canGoBack: true, canGoForward: false };
const context = { documentId: "loader", width: 640, height: 480, scrollX: 0, scrollY: 0, navigation };
const request = (action: unknown, value: unknown = context) => ({ requestId: "request-1", controlEpoch: "epoch-1", capturedAt: 1,
  target: { workerPid: 42, name: "main", targetId: "target" }, context: value, action });

test("browser document context preserves bounded native history state", () => {
  expect(parseBrowserDocumentContext(context)).toEqual(context);
  expect(parseBrowserDocumentContext({ ...context, navigation: undefined })).not.toHaveProperty("navigation");
  for (const invalid of [
    { entryId: -1, canGoBack: true, canGoForward: false },
    { entryId: 1.5, canGoBack: true, canGoForward: false },
    { entryId: 1, canGoBack: "yes", canGoForward: false },
  ]) expect(() => parseBrowserDocumentContext({ ...context, navigation: invalid })).toThrow();
});

test("browser resize and history actions require a current native history context", () => {
  expect(parseBrowserControlRequest(request({ type: "resize", width: 800, height: 600 })).action).toEqual({ type: "resize", width: 800, height: 600 });
  expect(parseBrowserControlRequest(request({ type: "back" })).action).toEqual({ type: "back" });
  const legacy = { ...context, navigation: undefined };
  expect(() => parseBrowserControlRequest(request({ type: "resize", width: 800, height: 600 }, legacy))).toThrow("Refresh");
  expect(() => parseBrowserControlRequest(request({ type: "forward" }, legacy))).toThrow("Refresh");
  for (const size of [[0, 600], [800, 0], [16_384, 16_384], [640.5, 480]]) {
    expect(() => parseBrowserControlRequest(request({ type: "resize", width: size[0], height: size[1] }))).toThrow();
  }
});

test("stop loading retains the captured owner context",()=>{
  expect(parseBrowserControlRequest(request({type:"stop"})).action).toEqual({type:"stop"});
});
