import { expect, test } from "bun:test";
import type { HostEvent, HostState, Project, SessionSummary } from "@agent-desktop/shared";
import { sidebarChatActions, sidebarItemKey, sidebarLayout } from "./sidebar-layout";

import { parseDetachedQuestionsSnapshot } from "../../../../packages/shared/src/detached-questions";
import { NotificationEvents } from "../../../host/src/notification-events";
import { sessionUnreadKey } from "./session-read-state";

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


test("same-named entities on different hosts keep distinct component and organization menu identities", () => {
  const first = { kind: "session" as const, value: session("home", "same") };
  const remote = { kind: "session" as const, value: session("work", "same") };
  const projectItem = { kind: "project" as const, value: project("home", "same") };
  expect(new Set([first, remote, projectItem].map(sidebarItemKey)).size).toBe(3);
  expect(sidebarItemKey({ ...first, value: { ...first.value, title: "Renamed" } })).toBe(sidebarItemKey(first));
});

test("grouping changes visible placement and numbered navigation without losing owners or duplicating pinned project children", () => {
  const { data, groups } = fixture();
  const modes = ["project", "connection", "list"] as const;
  for (const grouping of modes) {
    const layout = sidebarLayout({ ...data, get: () => ({ grouping, projectSort: "updated_at", chatSort: "updated_at" }) }, groups, "", false, new Set());
    expect(layout.chatSlots).toHaveLength(5);
    expect(new Set(layout.chatSlots.map(row => JSON.stringify([row.hostId, row.sessionId]))).size).toBe(5);
    expect(layout.loose.map(row => row.value.id)).toEqual(grouping === "list" ? ["loose", "same"] : ["loose"]);
    expect(layout.pinned.map(row => row.value.id)).toEqual(["home-project", "pin"]);
  }
});

test("priority uses owned unread and attention while manual order remains recoverable", () => {
  const { data, groups, organization } = fixture();
  groups[0]!.hostState.projects = []; groups[1]!.hostState.projects = [];
  groups[0]!.hostState.sessions = [session("home", "old", undefined, false, 1), session("home", "new", undefined, false, 100)];
  groups[1]!.hostState.sessions = [session("work", "old", undefined, false, 2)];
  organization.set("session:home:new", { sectionId: null, position: 0 });
  organization.set("session:work:old", { sectionId: null, position: 1024 });
  organization.set("session:home:old", { sectionId: null, position: 2048 });
  const unread = new Set([JSON.stringify(["home", "old"])]);
  const ordered = (chatSort: "priority" | "updated_at" | "manual") => sidebarLayout({ ...data, get: () => ({ grouping: "list", projectSort: "manual", chatSort }) }, groups, "", false, new Set(), unread).chatSlots.map(row => `${row.hostId}:${row.sessionId}`);
  expect(ordered("priority")).toEqual(["home:old", "home:new", "work:old"]);
  expect(ordered("updated_at")).toEqual(["home:new", "work:old", "home:old"]);
  expect(ordered("manual")).toEqual(["home:new", "work:old", "home:old"]);
});

test("new unsorted items append after explicit manual positions instead of displacing the saved order", () => {
  const { data, groups, organization } = fixture();
  groups[0]!.hostState.projects = []; groups[1]!.hostState.sessions = [];
  groups[0]!.hostState.sessions = [session("home", "saved", undefined, false, 1), session("home", "new", undefined, false, 100)];
  organization.set("session:home:saved", { sectionId: null, position: 8000 });
  expect(sidebarLayout(data, groups, "", false, new Set()).loose.map(item => item.value.id)).toEqual(["saved", "new"]);
});

test("pinned Priority rank is waiting, unread, active, idle; accepted answer delivery and errors do not invent waiting", () => {
  const { data, groups } = fixture();
  groups[0]!.hostState.projects = []; groups[1]!.hostState.sessions = [];
  const rows = ["error", "delivery", "active", "unread", "waiting"].map((id,index) => ({ ...session("home",id,undefined,false,100-index), status: id === "active" ? "running" : id === "error" ? "error" : "idle", questionDeliveryPending: id === "delivery" })) as SessionSummary[];
  const hostState = { ...groups[0]!.hostState, sessions:rows, notifications:[{id:"notice",sessionId:"waiting",kind:"question" as const,state:"open" as const,createdAt:1,title:"Question",body:"Waiting"}] };
  const layout=sidebarLayout({...data,get:()=>({grouping:"list",projectSort:"priority",chatSort:"priority"})},[{hostState}],"",false,new Set(),new Set([JSON.stringify(["home","unread"])]));
  expect(layout.chatSlots.map(row=>row.sessionId)).toEqual(["waiting","unread","active","error","delivery"]);
});

test("accepted question delivery does not hide a different open permission from Priority", () => {
  const { data } = fixture();
  const pending = { ...session("home", "pending", undefined, false, 1), questionDeliveryPending: true };
  const unread = session("home", "unread", undefined, false, 20);
  const events: HostEvent[] = [];
  const notifications = new NotificationEvents({
    eventsAfter: (after, limit) => events.filter(event => event.sequence > after).slice(0, limit),
    emit: event => events.push({ ...event, sequence: events.length + 1 }),
    session: id => id === pending.id ? pending : undefined,
  });
  const question = { questionId: "question-a", questionEntryId: "entry-a", originRunId: "run-a", openedAt: 1,
    questions: [{ id: "answer", multi: false, question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }], status: "open" as const, delivery: { status: "waiting" as const } };
  notifications.reconcileDetached(pending.id, [question]);
  notifications.interactionRequested({ id: "permission-b", sessionId: pending.id, method: "confirm", notificationKind: "permission", title: "Permission", actions: [], createdAt: 2 });
  const accepted = parseDetachedQuestionsSnapshot({ protocolVersion: 1, hostId: "home", sessionId: pending.id, questions: [{ ...question, status: "accepted", acceptance: { commandId: "answer-a", acceptanceEntryId: "accepted-a", acceptedAt: 3, answers: [{ questionId: "answer", selectedOptions: ["Yes"] }] } }] });
  notifications.reconcileDetached(pending.id, accepted.questions);
  expect(notifications.current()).toMatchObject([{ id: "interaction:pending:permission-b", kind: "permission", state: "open" }]);
  expect(events).toContainEqual(expect.objectContaining({ type: "notification", notification: expect.objectContaining({ id: "question:pending:entry-a", state: "resolved" }) }));
  const ranked = () => sidebarLayout({ ...data, get: () => ({ grouping: "list", projectSort: "priority", chatSort: "priority" }) },
    [{ hostState: { host: { id: "home" } as HostState["host"], projects: [], sessions: [pending, unread], notifications: notifications.current() } }], "", false, new Set(), new Set([sessionUnreadKey("home", "unread")])).loose.map(row => row.value.id);
  expect(ranked()).toEqual(["pending", "unread"]);
  notifications.interactionResolved(pending.id, "permission-b");
  expect(notifications.current()).toEqual([]);
  expect(pending.questionDeliveryPending).toBe(true);
  expect(ranked()).toEqual(["unread", "pending"]);
});

test("pinned sort is independent from the Recents chat sort", () => {
  const { data, groups, organization } = fixture();
  groups[0]!.hostState.projects = []; groups[1]!.hostState.projects = [];
  groups[0]!.hostState.sessions = [session("home", "older", undefined, false, 1), session("home", "newer", undefined, false, 20)];
  organization.set("session:home:older", { sectionId: "pinned", position: 0 });
  organization.set("session:home:newer", { sectionId: "pinned", position: 1024 });
  const pinnedSort = () => "updated_at" as const;
  const layout = sidebarLayout({ ...data, pinnedSort, get: () => ({ grouping: "list", projectSort: "manual", chatSort: "manual" }) }, groups, "", false, new Set());
  expect(layout.pinned.map(item => item.value.id)).toEqual(["newer", "older"]);
});
