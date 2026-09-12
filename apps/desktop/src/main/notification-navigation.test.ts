import { expect, test } from "bun:test";
import { NotificationNavigation } from "./notification-navigation";

const target = (hostId = "host-one", sessionId = "session-one") => ({ hostId, sessionId });

test("a click is assigned to one ready renderer and only that renderer can acknowledge it", () => {
  const navigation = new NotificationNavigation();
  const first: unknown[] = [], second: unknown[] = [];
  navigation.ready({ id: 1, send: request => first.push(request) });
  navigation.ready({ id: 2, send: request => second.push(request) });
  const request = navigation.open(target(), 2);
  expect(first).toEqual([]);
  expect(second).toEqual([request]);
  expect(navigation.acknowledge(1, request.id)).toBe(false);
  expect(navigation.acknowledge(2, "older-click")).toBe(false);
  expect(navigation.current()).toEqual(request);
  expect(navigation.acknowledge(2, request.id)).toBe(true);
  expect(navigation.current()).toBeUndefined();
});

test("renderer reload and loss reassign the retained target without changing its identity", () => {
  const navigation = new NotificationNavigation();
  const first: unknown[] = [], replacement: unknown[] = [];
  navigation.ready({ id: 4, send: request => first.push(request) });
  const request = navigation.open(target());
  navigation.unready(4);
  expect(navigation.current()).toEqual(request);
  navigation.ready({ id: 5, send: current => replacement.push(current) });
  expect(first).toEqual([request]);
  expect(replacement).toEqual([request]);
  expect(navigation.acknowledge(4, request.id)).toBe(false);
  expect(navigation.acknowledge(5, request.id)).toBe(true);
});

test("a newer click supersedes the old target and stale acknowledgement", () => {
  const navigation = new NotificationNavigation();
  const messages: unknown[] = [];
  navigation.ready({ id: 7, send: request => messages.push(request) });
  const old = navigation.open(target("host-one", "session-one"));
  const current = navigation.open(target("host-two", "session-two"));
  expect(messages).toEqual([old, current]);
  expect(navigation.acknowledge(7, old.id)).toBe(false);
  expect(navigation.current()).toEqual(current);
});

test("an absent or throwing renderer cannot lose a pending click", () => {
  const navigation = new NotificationNavigation();
  const request = navigation.open(target());
  navigation.ready({ id: 8, send: () => { throw new Error("renderer gone"); } });
  expect(navigation.current()).toEqual(request);
  const messages: unknown[] = [];
  navigation.ready({ id: 9, send: value => messages.push(value) });
  expect(messages).toEqual([request]);
});

test("invalid notification targets are rejected before ownership changes", () => {
  const navigation = new NotificationNavigation();
  expect(() => navigation.open({ hostId: "__proto__", sessionId: "session" })).toThrow("Invalid");
  expect(navigation.current()).toBeUndefined();
});
