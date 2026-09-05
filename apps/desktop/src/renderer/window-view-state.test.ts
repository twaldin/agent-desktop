import { afterEach, expect, test } from "bun:test";
import { defaultWindowView } from "../window-state";
import { readWindowRestoration } from "./window-view-state";
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window"), originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
afterEach(() => {
  for (const [key, original] of [["window", originalWindow], ["sessionStorage", originalStorage]] as const) {
    if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key);
  }
});
function fixture(initial?: unknown, legacy: Record<string, string> = {}) {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { agentDesktopWindow: { initial } } });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key: string) => legacy[key] ?? null } });
}
test("synchronous persisted owner wins over stale renderer tab state before any host is known", () => {
  const saved = { ...defaultWindowView(), route: { hostId: "offline-owner", sessionId: "session" }, workspaceOpen: true, workspaceTab: "changes" as const };
  fixture({ state: saved }, { "agent-desktop:navigation:v2": JSON.stringify({ hostId: "local-owner", sessionId: null }) });
  expect(readWindowRestoration()).toEqual({ state: saved, error: undefined });
});
test("legacy local/tab navigation is migrated only when no durable window view exists", () => {
  fixture({}, { "agent-desktop:navigation:v2": JSON.stringify({ hostId: "legacy-remote", sessionId: "legacy-session" }) });
  expect(readWindowRestoration()).toMatchObject({ state: { route: { hostId: "legacy-remote", sessionId: "legacy-session" } }, migrate: true });
  fixture({}, { "agent-desktop:session": "old-local-session" });
  expect(readWindowRestoration()).toMatchObject({ state: { route: { sessionId: "old-local-session" } }, migrate: true });
});
test("invalid bootstrap and native storage failure stay visible while usable navigation defaults remain", () => {
  fixture({ state: { route: { hostId: "/arbitrary/file", sessionId: null } } });
  expect(readWindowRestoration().error).toContain("invalid"); expect(readWindowRestoration().state).toEqual(defaultWindowView());
  fixture({ error: "Disk read failed" }); expect(readWindowRestoration().error).toBe("Disk read failed");
  Object.defineProperty(window, "agentDesktopWindow", { get() { throw new Error("bridge unavailable"); } });
  expect(readWindowRestoration().error).toContain("storage is unavailable");
});
