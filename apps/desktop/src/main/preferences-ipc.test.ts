import { afterAll, expect, test } from "bun:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { requestHost } from "./host-transport";
import { registerPreferencesV2Handler } from "./preferences-ipc";
import { createPreferencesV2Bridge } from "./preferences-preload";

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  if (new URL(request.url).pathname === "/v2/preferences") return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ error: "Unexpected endpoint" }, { status: 500 });
} });
afterAll(() => server.stop(true));

function fixture(request: (path: string) => Promise<unknown>) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  registerPreferencesV2Handler({ handle(channel, handler) { handlers.set(channel, handler); } } as Pick<IpcMain, "handle">,
    () => {}, request);
  const bridge = createPreferencesV2Bridge(channel => {
    const handler = handlers.get(channel); if (!handler) return Promise.reject(new Error("Missing preferences handler."));
    return Promise.resolve(handler({} as IpcMainInvokeEvent));
  });
  return { bridge, handlers };
}

test("actual preferences main handler and preload preserve only an uncoded old-host 404", async () => {
  const endpoint = { origin: `http://127.0.0.1:${server.port}`, hostId: "preferences-ipc-test" };
  const f = fixture(path => requestHost(endpoint, path));
  await expect(f.bridge()).resolves.toEqual({ ok: false, error: { message: "Not found", status: 404 } });
  expect(f.handlers.has("host:preferences-v2")).toBe(true);
});

test("actual preferences preload rejects malformed successful payloads before renderer fallback can run", async () => {
  const f = fixture(async () => ({ version: 2, records: [{ key: "invalid" }] }));
  await expect(f.bridge()).rejects.toThrow();
});

test("actual preferences main handler and preload keep operational failures distinct from old-host capability", async () => {
  const f = fixture(async () => { throw new Error("Controlled timeout"); });
  await expect(f.bridge()).resolves.toEqual({ ok: false, error: { message: "Controlled timeout" } });
});
