import { expect, test } from "bun:test";
import { selectLastTurn, type TurnCandidates } from "./selection";
const turn = (turnId: string | null, recorded: string | null = null, derived: string | null = null): TurnCandidates<string> => ({ turnId, recorded, derived });

test("final recorded diff wins over final derived evidence", () => {
  expect(selectLastTurn([turn("old", "old recorded"), turn("last", "last recorded", "last derived")])).toEqual({ turnId: "last", source: "recorded", value: "last recorded" });
});
test("final derived evidence wins over an older recorded result", () => {
  expect(selectLastTurn([turn("old", "old recorded"), turn("last", null, "last derived")])).toEqual({ turnId: "last", source: "derived", value: "last derived" });
});
test("an older derived result beats a newer different recorded result after an empty final turn", () => {
  expect(selectLastTurn([turn("derived", null, "older derived"), turn("recorded", "newer recorded"), turn("empty")])).toEqual({ turnId: "derived", source: "derived", value: "older derived" });
});
test("same-turn recorded evidence replaces the selected older derived fallback", () => {
  expect(selectLastTurn([turn("old", "recorded", "derived"), turn("empty")])).toEqual({ turnId: "old", source: "recorded", value: "recorded" });
});
test("without any derived candidate the latest recorded evidence survives empty turns", () => {
  expect(selectLastTurn([turn("first", "first"), turn("second", "second"), turn("empty")])).toEqual({ turnId: "second", source: "recorded", value: "second" });
});
test("source identity equality is preserved even for null native turn IDs", () => {
  expect(selectLastTurn([turn(null, "recorded"), turn("other", null, "derived"), turn(null)])).toEqual({ turnId: null, source: "recorded", value: "recorded" });
});
test("missing evidence has no selected candidate and cannot invent an empty available turn", () => {
  expect(selectLastTurn([])).toBeNull();
  expect(selectLastTurn([turn("empty")])).toBeNull();
});
