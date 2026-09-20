import { expect, test } from "bun:test";
import { ExtensionUiHttp } from "./extension-ui-http";
import { NativeExtensionUi } from "./omp/extension-ui";
import { EXTENSION_UI_OWNER_HEADER } from "../../../packages/shared/src/extension-ui";
test("read captures original existing owner and refuses its late result after replacement", async () => {
  const original = new NativeExtensionUi("session", () => {}), replacement = new NativeExtensionUi("session", () => {});
  original.setStatus("key", "original"); replacement.setStatus("key", "replacement");
  const held = Promise.withResolvers<void>(); let observed = false;
  let owner = { getExtensionUi: async () => { const snapshot = original.snapshot(); observed = true; await held.promise; return snapshot; } };
  let reads = 0;
  const route = new ExtensionUiHttp({ hostId: "host", sessionExists: () => true, existing: async () => { reads++; return owner; } });
  const request = () => new Request("http://127.0.0.1/v1/sessions/session/extension-ui", { headers: { [EXTENSION_UI_OWNER_HEADER]: "host" } });
  const pending = route.route(request()); while (!observed) await Bun.sleep(0);
  owner = { getExtensionUi: async () => replacement.snapshot() }; held.resolve();
  expect(await (await pending)!.json()).toMatchObject({ availability: "unavailable" });
  expect(await (await route.route(request()))!.json()).toMatchObject({ availability: "available", value: { epoch: replacement.epoch, statuses: [{ key: "key", text: "replacement" }] } });
  expect(reads).toBe(4);
});
