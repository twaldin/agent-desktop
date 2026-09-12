import { expect, test } from "bun:test";
import { browserCloseIdentity } from "../../../../packages/shared/src/browser-close";
import type { BrowserCloseWindowIntent } from "../browser-close-window-intent";
import { defaultWindowView, type WindowViewState } from "../window-state";
import { BrowserCloseCheckpoint } from "./browser-close-checkpoint";

const intent = (): BrowserCloseWindowIntent => ({ version: 1, hostId: "host", owner: { kind: "session", sessionId: "session" },
  source: { hostId: "host", target: "session:session", tabId: "tab", instanceId: '["original","tab"]', kind: "browser", destination: "right" },
  request: { requestId: "close", controlEpoch: "epoch", observedAt: 1, target: { workerPid: 1, name: "browser", targetId: "target" } } });
const view = (...browserCloses: BrowserCloseWindowIntent[]): WindowViewState => ({ ...defaultWindowView(), browserCloses });
const signal = () => new AbortController().signal;
const turn = async () => { await Promise.resolve(); await Promise.resolve(); };
test("new request and receipt each wait for their exact committed then saved publication", async () => {
  const checkpoint = new BrowserCloseCheckpoint(), pending = intent(); let dispatches = 0, removals = 0;
  checkpoint.committed(view()); checkpoint.saved(view());
  const ready = checkpoint.wait(pending, signal(), null).then(() => { dispatches++; });
  checkpoint.saved(view()); await turn(); expect(dispatches).toBe(0);
  checkpoint.committed(view(pending)); await turn(); expect(dispatches).toBe(0);
  const latest = { ...view(pending), route: { hostId: "other-host", sessionId: "other-session" }, expandedProjects: ["other-host:project"] };
  checkpoint.committed(latest); checkpoint.saved(latest); await ready; expect(dispatches).toBe(1);
  const completed: BrowserCloseWindowIntent = { ...pending, receipt: { ...browserCloseIdentity(pending.hostId, pending.owner, pending.request), outcome: "completed", released: true } };
  const removal = checkpoint.wait(completed, signal(), pending).then(() => { removals++; });
  checkpoint.committed(latest); checkpoint.saved(latest); await turn(); expect(removals).toBe(0);
  checkpoint.committed({ ...latest, browserCloses: [completed] }); await turn(); expect(removals).toBe(0);
  checkpoint.saved({ ...latest, browserCloses: [completed] }); await removal; expect(removals).toBe(1);
  expect(latest.route).toEqual({ hostId: "other-host", sessionId: "other-session" });
  expect(latest.expandedProjects).toEqual(["other-host:project"]);
  checkpoint.dispose();
});
test("queued publication cannot replace another request or continue through a changed predecessor", async () => {
  const checkpoint = new BrowserCloseCheckpoint(), original = intent(); checkpoint.committed(view(original));
  const receipt: BrowserCloseWindowIntent = { ...original, receipt: { ...browserCloseIdentity(original.hostId, original.owner, original.request), outcome: "unknown", message: "Unknown" } };
  const waiting = checkpoint.wait(receipt, signal(), original);
  const rejected = waiting.catch(error => error);
  checkpoint.committed(view({ ...original, source: { ...original.source, instanceId: "replacement" } })); expect(await rejected).toMatchObject({ message: expect.stringContaining("changed") });
  await expect(checkpoint.wait(receipt, signal(), original)).rejects.toThrow("not committed");
  await expect(checkpoint.wait({ ...receipt, request: { ...receipt.request, target: { ...receipt.request.target, targetId: "foreign" } }, receipt: undefined }, signal(), original)).rejects.toThrow("changed its original");
  checkpoint.dispose();
});
test.each(["dropped", "malformed"] as const)("%s commit rejects waiting admission and late acknowledgement cannot recover it", async kind => {
  const checkpoint = new BrowserCloseCheckpoint(), original = intent(); let calls = 0;
  checkpoint.committed(view(original));
  const waiting = checkpoint.wait(original, signal()).then(() => { calls++; });
  const rejected = waiting.catch(error => error);
  checkpoint.committed(kind === "dropped" ? view() : { ...view(original), browserCloses: [{ ...original, version: 2 }] } as unknown as WindowViewState);
  expect(await rejected).toBeInstanceOf(Error); checkpoint.saved(view(original));
  await expect(checkpoint.wait(original, signal())).rejects.toThrow(); expect(calls).toBe(0);
  checkpoint.committed(view(original));
  const fresh = checkpoint.wait(original, signal()).then(() => { calls++; });
  await turn(); expect(calls).toBe(0); checkpoint.saved(view(original)); await fresh; expect(calls).toBe(1);
  checkpoint.dispose();
});
test("save projection loss and failure reject while subsequent valid commits require fresh saves", async () => {
  const checkpoint = new BrowserCloseCheckpoint(), original = intent(); checkpoint.committed(view(original));
  const first = checkpoint.wait(original, signal()).catch(error => error); checkpoint.saved(view()); expect(await first).toMatchObject({ message: expect.stringContaining("did not retain") });
  const second = checkpoint.wait(original, signal()).catch(error => error); checkpoint.failed("disk unavailable"); expect(await second).toMatchObject({ message: "disk unavailable" });
  checkpoint.saved(view(original)); await expect(checkpoint.wait(original, signal())).rejects.toThrow("live committed");
  checkpoint.committed(view(original)); const recovery = checkpoint.wait(original, signal()); checkpoint.saved(view(original)); await recovery;
  checkpoint.dispose();
});
test("abort and disposal settle pending acknowledgements without dispatch and isolate window owners", async () => {
  const checkpoint = new BrowserCloseCheckpoint(), other = new BrowserCloseCheckpoint(), original = intent();
  checkpoint.committed(view(original)); other.committed(view(original)); other.saved(view(original));
  let calls = 0; const abort = new AbortController();
  const aborted = checkpoint.wait(original, abort.signal).then(() => { calls++; }); const rejection = aborted.catch(error => error);
  await turn(); expect(calls).toBe(0); abort.abort(); expect(await rejection).toMatchObject({ message: expect.stringContaining("cancelled") });
  const closed = checkpoint.wait(original, signal()).catch(error => error); checkpoint.dispose(); expect(await closed).toMatchObject({ message: expect.stringContaining("window closed") });
  checkpoint.saved(view(original)); await expect(checkpoint.wait(original, signal())).rejects.toThrow("live committed"); expect(calls).toBe(0);
  other.dispose();
});
