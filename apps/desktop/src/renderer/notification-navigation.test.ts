import { expect, test } from "bun:test";
import type { DesktopBridge, NotificationNavigationRequest } from "@agent-desktop/shared";
import { defaultWindowView, type WindowViewState } from "../window-state";
import { NotificationNavigationOwner } from "./notification-navigation-owner";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const request = (id = "click-one", hostId = "host-one", sessionId = "session-one"): NotificationNavigationRequest => ({ id, target: { hostId, sessionId } });
const view = (hostId = "host-one", sessionId = "session-one"): WindowViewState => ({ ...defaultWindowView(), route: { hostId, sessionId } });

function fixture() {
  let listener: ((request: NotificationNavigationRequest) => void) | undefined;
  const acknowledged: string[] = [], navigated: unknown[] = [];
  const bridge: Pick<DesktopBridge, "subscribeNotificationNavigation" | "acknowledgeNotificationNavigation"> = {
    subscribeNotificationNavigation: next => { listener = next; return () => { listener = undefined; }; },
    acknowledgeNotificationNavigation: id => { acknowledged.push(id); },
  };
  const owner = new NotificationNavigationOwner(bridge);
  owner.setNavigate(target => navigated.push(target)); owner.start();
  return { owner, acknowledged, navigated, emit(value: NotificationNavigationRequest) { listener?.(value); } };
}

test("the exact owner route is acknowledged only after commit and durable save", async () => {
  const f = fixture(), input = request();
  f.owner.committed(view("host-two", "session-two"));
  f.owner.saved(view("host-two", "session-two"));
  f.emit(input);
  expect(f.navigated).toEqual([input.target]);
  f.owner.committed(view()); await tick(); expect(f.acknowledged).toEqual([]);
  f.owner.saved(view()); await tick(); expect(f.acknowledged).toEqual([input.id]);
});

test("an already selected conversation still waits for its covering surface to close and save", async () => {
  const f = fixture(), input = request();
  const covered = { ...view(), settingsOpen: true };
  f.owner.committed(covered); f.owner.saved(covered); f.emit(input);
  await tick(); expect(f.acknowledged).toEqual([]);
  f.owner.committed(view()); f.owner.saved(view()); await tick();
  expect(f.acknowledged).toEqual([input.id]);
});

test("an offline cached owner still saves its exact route without falling back", async () => {
  const f = fixture(), input = request("offline", "remote-host", "remote-session");
  f.emit(input);
  f.owner.committed(view("remote-host", "remote-session"));
  f.owner.saved(view("remote-host", "remote-session"));
  await tick();
  expect(f.navigated).toEqual([{ hostId: "remote-host", sessionId: "remote-session" }]);
  expect(f.acknowledged).toEqual(["offline"]);
});

test("stale saves, route replacement, save failure and document loss never acknowledge", async () => {
  for (const action of ["stale-save", "replacement", "failed", "dispose"] as const) {
    const f = fixture(), input = request(action);
    f.emit(input); f.owner.committed(view());
    if (action === "stale-save") f.owner.saved(view("host-two", "session-two"));
    if (action === "replacement") f.owner.committed(view("host-two", "session-two"));
    if (action === "failed") f.owner.failed("disk failed");
    if (action === "dispose") f.owner.dispose();
    await tick(); expect(f.acknowledged).toEqual([]);
  }
});

test("a newer click fences a late save for the old click", async () => {
  const f = fixture();
  f.emit(request("old", "host-one", "session-one"));
  f.owner.committed(view("host-one", "session-one"));
  f.emit(request("new", "host-two", "session-two"));
  f.owner.saved(view("host-one", "session-one"));
  f.owner.committed(view("host-two", "session-two"));
  f.owner.saved(view("host-two", "session-two"));
  await tick();
  expect(f.acknowledged).toEqual(["new"]);
  expect(f.navigated).toEqual([
    { hostId: "host-one", sessionId: "session-one" },
    { hostId: "host-two", sessionId: "session-two" },
  ]);
});

test("invalid targets cannot navigate or acknowledge", async () => {
  const f = fixture();
  f.emit({ id: "bad", target: { hostId: "__proto__", sessionId: "session" } });
  await tick();
  expect(f.navigated).toEqual([]);
  expect(f.acknowledged).toEqual([]);
});
