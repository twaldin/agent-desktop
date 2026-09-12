import { expect, test } from "bun:test";
import { followUpDeliveryForEnter, type FollowUpEnterKey } from "./follow-up-submit";
const key = (patch: Partial<FollowUpEnterKey> = {}): FollowUpEnterKey => ({ key: "Enter", altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, keyCode: 13, isComposing: false, ...patch });

test("Enter mode uses plain Enter normally and Command or Control Enter for the opposite lane", () => {
  expect(followUpDeliveryForEnter(key(), "enter", "follow-up")).toBe("follow-up");
  expect(followUpDeliveryForEnter(key({ metaKey: true }), "enter", "follow-up")).toBe("steer");
  expect(followUpDeliveryForEnter(key({ ctrlKey: true }), "enter", "steer")).toBe("follow-up");
  expect(followUpDeliveryForEnter(key({ shiftKey: true }), "enter", "follow-up")).toBeNull();
});

test("modified Enter mode uses Command Enter normally and Command Shift Enter for the opposite lane", () => {
  expect(followUpDeliveryForEnter(key({ metaKey: true }), "mod-enter", "steer")).toBe("steer");
  expect(followUpDeliveryForEnter(key({ metaKey: true, shiftKey: true }), "mod-enter", "steer")).toBe("follow-up");
  expect(followUpDeliveryForEnter(key(), "mod-enter", "steer")).toBeNull();
});

test("IME, keyCode 229, Alt Enter and unrelated keys never submit", () => {
  for (const event of [key({ isComposing: true }), key({ keyCode: 229 }), key({ altKey: true }), key({ key: "a" })])
    expect(followUpDeliveryForEnter(event, "enter", "follow-up")).toBeNull();
});
