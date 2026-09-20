import { describe, expect, test } from "bun:test";
import { admitPackagedRendererDocument, rendererTargetSummary, selectPackagedRendererTarget } from "./smoke-release-renderer";

const appUrl = "file:///tmp/Agent%20Desktop.app/Contents/Resources/app/dist/renderer/index.html";
const moduleUrl = "file:///tmp/Agent%20Desktop.app/Contents/Resources/app/dist/renderer/assets/index-AbCd1234.js";

describe("packaged renderer CDP admission", () => {
  test("ignores transient and unrelated targets and selects the packaged app document", () => {
    const targets = [
      { type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://blank" },
      { type: "page", url: "file:///tmp/other.html", webSocketDebuggerUrl: "ws://other" },
      { type: "worker", url: appUrl, webSocketDebuggerUrl: "ws://worker" },
      { type: "page", url: appUrl, webSocketDebuggerUrl: "ws://app" },
    ];
    expect(selectPackagedRendererTarget(targets)).toEqual(targets[3]);
    expect(rendererTargetSummary(targets)).toContain("file:///tmp/other.html");
  });

  test("waits for navigation and loading before admitting the initialized app document", () => {
    expect(admitPackagedRendererDocument(appUrl, {
      href: "about:blank", readyState: "complete", rootPresent: false, moduleScripts: [],
    })).toBeUndefined();
    expect(admitPackagedRendererDocument(appUrl, {
      href: appUrl, readyState: "loading", rootPresent: false, moduleScripts: [],
    })).toBeUndefined();
    expect(admitPackagedRendererDocument(appUrl, {
      href: appUrl, readyState: "complete", rootPresent: true, moduleScripts: [moduleUrl],
    })).toBe(moduleUrl);
  });

  test("rejects a settled wrong document instead of importing an absent or foreign script", () => {
    expect(() => admitPackagedRendererDocument(appUrl, {
      href: appUrl, readyState: "complete", rootPresent: true, moduleScripts: [],
    })).toThrow(/not the initialized app document/);
    expect(() => admitPackagedRendererDocument(appUrl, {
      href: appUrl, readyState: "interactive", rootPresent: true, moduleScripts: ["https://example.test/index.js"],
    })).toThrow(/example\.test/);
    expect(() => admitPackagedRendererDocument(appUrl, {
      href: appUrl, readyState: "complete", rootPresent: true,
      moduleScripts: ["file:///tmp/Other.app/Contents/Resources/app/dist/renderer/assets/index-AbCd1234.js"],
    })).toThrow(/Other\.app/);
  });
});
