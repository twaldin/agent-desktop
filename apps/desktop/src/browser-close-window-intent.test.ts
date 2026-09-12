import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserCloseIdentity } from "../../../packages/shared/src/browser-close";
import { parseBrowserCloseWindowIntent, parseBrowserCloseWindowIntents, type BrowserCloseWindowIntent } from "./browser-close-window-intent";
import { WindowStateStore } from "./main/window-state";
import { defaultWindowView, parseWindowView } from "./window-state";
import { draftBrowserDockTarget } from "./renderer/dock-state";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function intent(): BrowserCloseWindowIntent {
  return { version: 1, hostId: "host-one", owner: { kind: "session", sessionId: "session-one" },
    source: { hostId: "host-one", target: "session:session-one", tabId: "original-tab", instanceId: '["seed","original-tab"]', kind: "browser", destination: "right" },
    request: { requestId: "close-one", controlEpoch: "epoch-one", observedAt: 10, target: { workerPid: 50, name: "browser-one", targetId: "native-one" } } };
}
test("window close history survives acknowledged disk save and reopening without a live tab", async () => {
  const selected = process.env.BROWSER_CLOSE_WINDOW_STORE;
  const Store: typeof WindowStateStore = selected ? (await import(selected)).WindowStateStore : WindowStateStore;
  const profile = mkdtempSync(join(tmpdir(), "browser-close-window-")); directories.push(profile);
  const original = intent(), unknown = intent(); unknown.request.requestId = "close-two";
  unknown.receipt = { ...browserCloseIdentity(unknown.hostId, unknown.owner, unknown.request), outcome: "unknown", message: "Disconnected after dispatch." };
  const view = { ...defaultWindowView(), route: { hostId: "new-host", sessionId: "new-session" }, expandedProjects: ["new-host:project"], browserCloses: [original, unknown] };
  const store = new Store(profile, "primary");
  expect(store.saveView(view)).toEqual({});
  const reopened = new Store(profile, "primary");
  expect(reopened.bootstrap().state?.browserCloses).toEqual([original, unknown]);
  expect(reopened.bootstrap().state?.route).toEqual(view.route);
  expect(reopened.bootstrap().state?.expandedProjects).toEqual(view.expandedProjects);
  expect(new Store(profile, "second").bootstrap().state).toBeUndefined();
  original.request.target.targetId = "caller-change";
  expect(reopened.bootstrap().state?.browserCloses?.[0]?.request.target.targetId).toBe("native-one");
  const returned = reopened.bootstrap(); returned.state!.browserCloses![0]!.source.instanceId = "returned-change";
  expect(reopened.bootstrap().state?.browserCloses?.[0]?.source.instanceId).toBe('["seed","original-tab"]');
});
test("draft and session requests retain distinct exact owners and cloned receipt targets", () => {
  const session = intent(), draft = intent();
  draft.owner = { kind: "draft", ownerId: "session-one", draftId: "draft with spaces", draftRevision: 3 };
  draft.source.target = draftBrowserDockTarget(draft.owner.draftId); draft.source.destination = "bottom";
  draft.receipt = { ...browserCloseIdentity(draft.hostId, draft.owner, draft.request), outcome: "completed", released: true };
  const parsed = parseBrowserCloseWindowIntents([session, draft]);
  expect(parsed).toEqual([session, draft]);
  draft.receipt.target.targetId = "caller-mutated"; draft.owner.draftRevision = 4;
  expect(parsed[1]!.receipt!.target.targetId).toBe("native-one");
  expect(parsed[1]!.owner).toEqual({ kind: "draft", ownerId: "session-one", draftId: "draft with spaces", draftRevision: 3 });
  parsed[0]!.request.target.name = "parsed-change";
  expect(session.request.target.name).toBe("browser-one");
});
test("invalid close bindings or receipt projection reject the whole window instead of dropping history", () => {
  const original = intent();
  const invalid: unknown[] = [
    { ...original, version: 2 }, { ...original, extra: true },
    { ...original, source: { ...original.source, hostId: "foreign" } },
    { ...original, source: { ...original.source, target: "session:replacement" } },
    { ...original, source: { ...original.source, instanceId: "" } },
    { ...original, source: { ...original.source, destination: "left" } },
    { ...original, request: { ...original.request, target: { ...original.request.target, targetId: "" } } },
    { ...original, receipt: { ...browserCloseIdentity(original.hostId, original.owner, original.request), outcome: "completed", released: false } },
    { ...original, receipt: { ...browserCloseIdentity(original.hostId, original.owner, original.request), outcome: "unknown", message: "unknown", requestId: "other" } },
  ];
  for (const value of invalid) {
    expect(() => parseBrowserCloseWindowIntent(value)).toThrow();
    expect(parseWindowView({ ...defaultWindowView(), browserCloses: [value] })).toBeUndefined();
  }
  expect(() => parseBrowserCloseWindowIntents([original, original])).toThrow("Duplicate");
  expect(() => parseBrowserCloseWindowIntents(Array.from({ length: 101 }, (_, index) => ({ ...original, request: { ...original.request, requestId: `close-${index}` } })))).toThrow("Too many");
  expect(parseWindowView(defaultWindowView())?.browserCloses).toBeUndefined();
});
test.each(["all-hole", "trailing-hole"] as const)("sparse close history %s rejects before disk acknowledgement and preserves the prior window", kind => {
  const profile = mkdtempSync(join(tmpdir(), "browser-close-sparse-")); directories.push(profile);
  const store = new WindowStateStore(profile, "primary");
  const prior = { ...defaultWindowView(), route: { hostId: "saved-host", sessionId: "saved-session" }, browserCloses: [intent()] };
  expect(store.saveView(prior)).toEqual({});
  const bytes = readFileSync(store.file, "utf8");
  const entries: BrowserCloseWindowIntent[] = kind === "all-hole" ? new Array(1) : [intent()];
  if (kind === "trailing-hole") entries.length = 2;
  const result = store.saveView({ ...prior, route: { hostId: "other-host", sessionId: null }, browserCloses: entries });
  const reopened = new WindowStateStore(profile, "primary").bootstrap();
  expect({ acknowledged: !result.error, state: reopened.state, readError: Boolean(reopened.error), diskUnchanged: readFileSync(store.file, "utf8") === bytes })
    .toEqual({ acknowledged: false, state: prior, readError: false, diskUnchanged: true });
  expect(store.bootstrap().state).toEqual(prior);
  expect(parseWindowView({ ...prior, browserCloses: entries })).toBeUndefined();
  expect(() => parseBrowserCloseWindowIntents(entries)).toThrow();
});
