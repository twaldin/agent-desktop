import { afterAll, expect, test } from "bun:test";
import { SESSION_ACTIVITY_OWNER_HEADER } from "@agent-desktop/shared";
import { HostRequestError } from "./host-transport";
import { requestSessionActivity } from "./session-activity-transport";

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const prefix = new URL(request.url).pathname.split("/")[1];
  if (prefix === "plain") return Response.json({ error: "Not found" }, { status: 404 });
  if (prefix === "coded") return Response.json({ error: { code: "STALE_TARGET", message: "Gone" } }, { status: 404 });
  if (prefix === "auth") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const owner = prefix === "wrong" ? "other" : "owner";
  return Response.json({ protocolVersion: 1, hostId: owner, sessionId: "native",
    goal: { availability: "available", value: null }, jobs: { availability: "unavailable", reason: "none" },
    agents: { availability: "available", value: [] }, sources: { availability: "unsupported", reason: "none" } },
  { headers: { [SESSION_ACTIVITY_OWNER_HEADER]: owner } });
} });
const endpoint = (prefix: string) => ({ origin: `http://127.0.0.1:${server.port}/${prefix}`, hostId: "owner" });
afterAll(() => server.stop(true));

test("activity transport validates owner and protocol identity", async () => {
  expect(await requestSessionActivity(endpoint("ok"), "native")).toMatchObject({ hostId: "owner", sessionId: "native" });
  await expect(requestSessionActivity(endpoint("wrong"), "native")).rejects.toMatchObject({ status: 409, code: "OWNER_MISMATCH" });
});

test("activity transport falls back only for a plain route 404", async () => {
  expect(await requestSessionActivity(endpoint("plain"), "native")).toBeNull();
  await expect(requestSessionActivity(endpoint("coded"), "native")).rejects.toBeInstanceOf(HostRequestError);
  await expect(requestSessionActivity(endpoint("auth"), "native")).rejects.toMatchObject({ status: 401 });
});
