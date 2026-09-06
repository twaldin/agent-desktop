import { createRoot } from "react-dom/client";
import { useWorkbenchDock } from "../../apps/desktop/src/renderer/use-workbench-dock";
import { defaultWindowView, parseDockSnapshot } from "../../apps/desktop/src/window-state";
import type { DesktopBridge } from "../../packages/shared/src/protocol";
const root = createRoot(document.getElementById("root")!);
const calls: { metadata: number; create: number } = { metadata: 0, create: 0 };
let mode: "start" | "unknown" | "cmux" = "start";
let release = Promise.withResolvers<void>();
const meta = (availability: "not-started" | "running", tabs: any[] = []) => ({
  protocolVersion: 1 as const,
  hostId: "host",
  sessionId: "session",
  availability,
  reason: "not started",
  ...(availability === "running"
    ? {
        workerPid: 9,
        tabs,
        creationTicket: { controlEpoch: "epoch", observedAt: 1 },
      }
    : { creationTicket: { controlEpoch: "epoch", observedAt: 1 } }),
});
const bridge = {
  getBrowserMetadata: async () => {
    calls.metadata++;
    return mode === "start"
      ? meta("not-started")
      : meta("running", [
          {
            name: "cmux tab",
            targetId: "surface:1",
            backend: "cmux",
            kindTag: "cmux",
            state: "alive",
            url: "about:blank",
            title: "CMUX",
          },
        ]);
  },
  createBrowserTab: async () => {
    calls.create++;
    await release.promise;
    return mode === "unknown"
      ? {
          protocolVersion: 1,
          hostId: "host",
          sessionId: "session",
          requestId: "x",
          outcome: "unknown",
          message: "lost",
        }
      : {
          protocolVersion: 1,
          hostId: "host",
          sessionId: "session",
          requestId: "x",
          outcome: "completed",
          workerPid: 9,
          tab: {
            name: "cmux tab",
            targetId: "surface:1",
            backend: "cmux",
            kindTag: "cmux",
            state: "alive",
            url: "about:blank",
            title: "CMUX",
          },
          targetDisposition: "created-surface",
        };
  },
  subscribe: () => () => {},
} as unknown as DesktopBridge;
let dock: any;
let error = "";
function App() {
  dock = useWorkbenchDock(
    bridge,
    defaultWindowView(),
    "host",
    { sessionId: "session" },
    true,
    message => { error = message; },
  );
  return <pre>{JSON.stringify(dock.snapshot)}</pre>;
}
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
const wait = async (f: () => unknown) => {
  for (let i = 0; i < 100; i++) {
    if (f()) return;
    await sleep(10);
  }
  throw Error("timeout");
};
Object.assign(window, {
  browserDockHookProgress: () => ({ calls, error, tabs: dock?.snapshot.tabs }),
  runBrowserDockHook: async () => {
    root.render(<App />);
    await wait(() => dock);
    dock.browser("right", true);
    dock.browser("right", true);
    await wait(() => calls.create === 1);
    release.resolve();
    await wait(() => dock.snapshot.tabs.length === 1);
    let tab = dock.snapshot.tabs[0];
    if (tab.title !== "CMUX" || tab.browserTarget?.name !== "cmux tab")
      throw Error("cmux target not persisted");
    const id = tab.id;
    mode = "unknown";
    release = Promise.withResolvers<void>();
    dock.browser("bottom", true);
    await wait(() => calls.create === 2);
    release.resolve();
    await sleep(30);
    if (calls.create !== 2 || dock.snapshot.tabs.length !== 1)
      throw Error("unknown retried or fabricated tab");
    mode = "cmux";
    await dock.browser("bottom", false);
    await sleep(20);
    if (calls.metadata !== 3 || calls.create !== 2 || !dock.snapshot.tabs.some((x: any) => x.id === id) || error !== "lost") throw Error("existing target lookup or unknown feedback failed");
    dock.updateBrowserTitle(id, "x".repeat(8192));
    await wait(() => dock.snapshot.tabs[0].title.length === 1000);
    if (!parseDockSnapshot(dock.snapshot)) throw Error("native long title invalidated durable dock");
    const unchanged = dock.snapshot;
    dock.updateBrowserTitle(id, "x".repeat(8192)); await sleep(20);
    if (dock.snapshot !== unchanged) throw Error("unchanged native title repeatedly dirtied window state");
    dock.updateBrowserTitle(id, "about:blank");
    await wait(() => dock.snapshot.tabs[0].title === "New tab");
    return { passed: true, calls, tabs: dock.snapshot.tabs, checks: ["ticketed inactive creation", "pending click dedup", "unknown outcome without replay and visible feedback", "existing CMUX identity", "bounded durable title and unchanged-title persistence", "blank native page title"] };
  },
});
