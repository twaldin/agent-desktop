import { expect, test } from "bun:test";
import { commandMenuRecents, type CommandMenuRecentCandidate } from "./command-menu-recents";
test("pinned preference order precedes newer chats and nine total entries fill remaining slots", () => {
  const items = Array.from({ length: 12 }, (_, index) => ({ hostId: "host", sessionId: String(index), updatedAt: index, pinned: index < 2, pinnedPosition: 1 - index }));
  const before = JSON.stringify(items), selected = commandMenuRecents(items);
  expect(selected.map(item => item.sessionId)).toEqual(["1", "0", "11", "10", "9", "8", "7", "6", "5"]);
  expect(JSON.stringify(items)).toBe(before);
});
test("dedupe retains native owner and a full pinned set leaves no recent slots", () => {
  const base: CommandMenuRecentCandidate = { hostId: "one", sessionId: "same", updatedAt: 5 };
  expect(commandMenuRecents([base, base, { ...base, hostId: "two" }]).map(entry => entry.hostId)).toEqual(["one", "two"]);
  const pinned = Array.from({ length: 10 }, (_, i) => ({ hostId: "host", sessionId: String(i), updatedAt: 1, pinned: true, pinnedPosition: i }));
  const selected = commandMenuRecents([...pinned, { ...base, updatedAt: 100 }]);
  expect(selected).toHaveLength(9); expect(selected.every(entry => entry.pinned)).toBe(true); expect(selected.map(entry => entry.sessionId)).toEqual(pinned.slice(0, 9).map(entry => entry.sessionId));
});
