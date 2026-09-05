import { expect, test } from "bun:test";
import { framePoint } from "./browser-input";

const context = {
  documentId: "document-1",
  width: 800,
  height: 400,
  scrollX: 12,
  scrollY: 30,
};
const image = { left: 10, top: 20, width: 400, height: 200 };

test("maps displayed JPEG pixels to captured viewport coordinates", () => {
  expect(framePoint(image, context, 210, 120)).toEqual({ x: 400, y: 200 });
  expect(framePoint(image, context, 110, 70)).toEqual({ x: 200, y: 100 });
  expect(framePoint(image, context, 409.9, 219.9)).toEqual({
    x: 799.8,
    y: 399.8,
  });
});

test("rejects letterbox margins and the exclusive frame edge", () => {
  expect(framePoint(image, context, 9, 20)).toBeUndefined();
  expect(framePoint(image, context, 410, 220)).toBeUndefined();
  expect(framePoint({ ...image, width: 0 }, context, 10, 20)).toBeUndefined();
});
