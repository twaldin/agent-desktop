import { expect, test } from "bun:test";
import type { BrowserFrameTarget } from "@agent-desktop/shared";
import { projectNativeBrowserFrame } from "./frame";

// 1x1 JPEG, used only to prove native-byte projection and target binding.
const jpeg = Uint8Array.from(Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAEoP//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8hf//aAAwDAQACAAMAAAAQH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8Qf//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8Qf//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8Qf//Z", "base64"));
const target: BrowserFrameTarget = { workerPid: 12, name: "tab", targetId: "target" };

test("native browser frame projection preserves exact owner and image dimensions", () => {
  const frame = projectNativeBrowserFrame({ ownerSessionId: "owner", name: "tab", targetId: "target", data: jpeg, url: "http://127.0.0.1/", title: "Page" }, target, "owner");
  expect(frame).toMatchObject({ name: "tab", targetId: "target", mimeType: "image/jpeg", width: 1, height: 1, url: "http://127.0.0.1/", title: "Page" });
  expect(() => projectNativeBrowserFrame({ ownerSessionId: "other", name: "tab", targetId: "target", data: jpeg, url: "http://127.0.0.1/", title: "Page" }, target, "owner")).toThrow("invalid owner");
});
