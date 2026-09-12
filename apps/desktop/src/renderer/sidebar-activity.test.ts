import { expect, test } from "bun:test";
import type { HostState, SessionSummary } from "../../../../packages/shared/src/protocol";
import { sidebarActivity } from "./sidebar-activity";
import { sessionUnreadKey } from "./session-read-state";

test("activity includes unread/running/waiting local chats but not read, archived or another host's waiting state", () => {
  const session = (hostId: string, id: string, status: SessionSummary["status"] = "idle", archived = false): SessionSummary => ({ hostId, id, projectId: null, model: null, status, archived, title: id, createdAt: 1, updatedAt: 2, cwd: "/fixture", sessionFile: "/fixture/chat.jsonl" });
  const groups: { hostState: HostState }[] = ["one", "two"].map(id => ({ hostState: { protocolVersion: 1, host: { id, name: id, platform: "darwin", architecture: "arm64" }, projects: [], models: [], drafts: [], lastEventSequence: 1, sessions: [session(id, "same"), session(id, "read"), session(id, "active", "running"), session(id, "archived", "running", true)], notifications: [] } }));
  groups[0]!.hostState.notifications = [{ id: "question", sessionId: "same", kind: "question", state: "open", title: "Needs response", body: "Question requires a response", createdAt: 1 }];
  const result = sidebarActivity(groups, new Set([sessionUnreadKey("two", "read")]));
  expect(result.map(item => [item.session.hostId, item.session.id, item.reason])).toEqual([
    ["one", "same", "Awaiting response"], ["one", "active", "Running"], ["two", "active", "Running"], ["two", "read", "Unread"],
  ]);
  groups[0]!.hostState.notifications = [];
  expect(sidebarActivity(groups, new Set()).map(item => item.session.id)).toEqual(["active", "active"]);
});
