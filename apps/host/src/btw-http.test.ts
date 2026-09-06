import { expect, test } from "bun:test";
import { BTW_OWNER_HEADER } from "@agent-desktop/shared";
import { BtwHttp } from "./btw-http";
import type { BtwService } from "./btw";

const snapshot = { runId: "r", sessionId: "s", question: "q", status: "running" as const, answer: "", startedAt: 1, updatedAt: 1 };
function request(owner = "host") { return new Request("http://localhost/v1/sessions/s/btw", { headers: { [BTW_OWNER_HEADER]: owner } }); }
function http(value: typeof snapshot | null = snapshot) { return new BtwHttp({ hostId: "host", sessionExists: id => id === "s", service: { snapshot: () => value } as unknown as BtwService }); }

test("btw GET is owner fenced and reads retained state without opening a worker", async () => {
  const response = await http().route(request());
  expect(response?.status).toBe(200);
  expect(await response!.json()).toMatchObject({ protocolVersion: 1, hostId: "host", sessionId: "s", value: snapshot });
  expect((await http(null).route(request()))?.status).toBe(200);
  expect((await http().route(request("other")))?.status).toBe(409);
});

test("btw GET rejects missing sessions and non-GET requests", async () => {
  expect((await new BtwHttp({ hostId: "host", sessionExists: () => false, service: {} as BtwService }).route(request()))?.status).toBe(409);
  expect((await http().route(new Request(request(), { method: "POST" })))?.status).toBe(405);
});
