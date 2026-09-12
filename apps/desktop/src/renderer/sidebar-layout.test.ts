import { expect, test } from "bun:test";
import type { HostState, Project, SessionSummary } from "@agent-desktop/shared";
import { sidebarChatActions, sidebarLayout } from "./sidebar-layout";

const project = (hostId: string, id: string) => ({ hostId, id, name: id, path: `/${id}` }) as Project;
const session = (hostId: string, id: string, projectId?: string, archived = false, updatedAt = 1) => ({ hostId, id, projectId,
  title: id, cwd: `/${projectId ?? id}`, archived, updatedAt }) as SessionSummary;
function fixture() {
  const organization = new Map<string, { sectionId: string | null; position: number }>([
    ["project:home:home-project", { sectionId: "pinned", position: 0 }],
    ["session:home:pin", { sectionId: "pinned", position: 100 }],
    ["session:home:custom", { sectionId: "one", position: 0 }],
  ]);
  const data = {
    sections: () => [{ id: "one", name: "First section", position: 0 }],
    sectionFor: (kind: string, id: string, host: string) => organization.get(`${kind}:${host}:${id}`)?.sectionId ?? null,
    entity: (kind: string, id: string, hostId: string) => {
      const value = organization.get(`${kind}:${hostId}:${id}`); return value && { hostId, ...value };
    },
  };
  const groups = [
    { hostState: { host: { id: "home" }, projects: [project("home", "home-project")], sessions: [session("home", "pin"), session("home", "same", "home-project"), session("home", "custom"), session("home", "archived", undefined, true), session("home", "loose", undefined, false, 50)] } },
    { hostState: { host: { id: "work" }, projects: [project("work", "work-project")], sessions: [session("work", "same", "work-project")] } },
  ] as { hostState: Pick<HostState, "host" | "projects" | "sessions"> }[];
  return { data, groups, organization };
}

test("one layout preserves pinned, custom, host projects and loose order with full host identity", () => {
  const { data, groups, organization } = fixture();
  const expanded = new Set(["home:home-project", "work:work-project"]);
  const layout = sidebarLayout(data, groups, "", false, expanded);
  expect(layout.chatSlots).toEqual([
    { hostId: "home", sessionId: "same" }, { hostId: "home", sessionId: "pin" },
    { hostId: "home", sessionId: "custom" }, { hostId: "work", sessionId: "same" }, { hostId: "home", sessionId: "loose" },
  ]);
  expect(layout.pinned.map(item => item.value.id)).toEqual(["home-project", "pin"]);
  expect(layout.custom[0]!.items.map(item => item.value.id)).toEqual(["custom"]);
  expect(layout.hostProjects[1]!.map(item => item.value.id)).toEqual(["work-project"]);
  expanded.delete("home:home-project");
  expect(sidebarLayout(data, groups, "", false, expanded).chatSlots.map(item => `${item.hostId}:${item.sessionId}`))
    .toEqual(["home:same", "home:pin", "home:custom", "work:same", "home:loose"]);
  organization.set("session:home:pin", { sectionId: "one", position: 200 });
  expect(sidebarLayout(data, groups, "", false, expanded).chatSlots.slice(0, 3).map(item => item.sessionId)).toEqual(["same", "custom", "pin"]);
});

test("archive/search filtering and nine-slot cap follow the same logical rows without mutating input", () => {
  const { data, groups } = fixture(), before = JSON.stringify(groups);
  expect(sidebarLayout(data, groups, "", true, new Set()).chatSlots).toEqual([{ hostId: "home", sessionId: "archived" }]);
  expect(sidebarLayout(data, groups, "same", false, new Set()).chatSlots).toEqual([{ hostId: "home", sessionId: "same" }, { hostId: "work", sessionId: "same" }]);
  expect(JSON.stringify(groups)).toBe(before);
  groups[0]!.hostState.sessions = Array.from({ length: 12 }, (_, i) => session("home", `loose-${i}`, undefined, false, i));
  groups[1]!.hostState.sessions = [];
  expect(sidebarLayout(data, groups, "", false, new Set()).chatSlots.map(item => item.sessionId))
    .toEqual(["loose-11", "loose-10", "loose-9", "loose-8", "loose-7", "loose-6", "loose-5", "loose-4", "loose-3"]);
});

test("only existing slots receive actions and dispatch retains cross-host destinations", () => {
  const calls: string[] = [], slots = [{ hostId: "home", sessionId: "same" }, { hostId: "work", sessionId: "same" }];
  const actions = sidebarChatActions(slots, (session, host) => calls.push(`${host}:${session}`));
  expect(Object.keys(actions)).toEqual(["thread-1", "thread-2"]);
  actions["thread-2"]!(); actions["thread-1"]!();
  expect(calls).toEqual(["work:same", "home:same"]);
  expect(sidebarChatActions([], () => { throw new Error("no destination"); })).toEqual({});
});
