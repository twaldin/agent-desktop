import { expect, test } from "bun:test";
import type { HostEvent, SessionSummary } from "@agent-desktop/shared";
import { NotificationEvents } from "./notification-events";

const session: SessionSummary = { id: "s", hostId: "h", projectId: null, cwd: "/tmp", title: "Bounded session", status: "idle",
  sessionFile: "/tmp/s.jsonl", model: null, createdAt: 1, updatedAt: 1, archived: false };

function fixture(existing: HostEvent[] = []) {
  const events = [...existing];
  const source = new NotificationEvents({
    eventsAfter: (after, limit) => events.filter(event => event.sequence > after).slice(0, limit),
    emit: input => events.push({ ...input, sequence: events.length + 1 }),
    session: id => id === session.id ? session : undefined,
  });
  return { source, events };
}

test("native interactions use stable ids and only explicit markers classify permission", () => {
  const f = fixture();
  f.source.interactionRequested({ id: "generic", sessionId: "s", method: "confirm", title: "Secret prompt", message: "secret", actions: [], createdAt: 10 });
  f.source.interactionRequested({ id: "approved", sessionId: "s", method: "select", notificationKind: "permission", title: "secret tool", options: [], actions: [], createdAt: 11 });
  expect(f.source.current()).toEqual([
    { id: "interaction:s:generic", sessionId: "s", kind: "question", state: "open", createdAt: 10, title: "Bounded session", body: "Your answer is needed" },
    { id: "interaction:s:approved", sessionId: "s", kind: "permission", state: "open", createdAt: 11, title: "Bounded session", body: "Permission required" },
  ]);
  expect(JSON.stringify(f.events)).not.toContain("Secret prompt"); expect(JSON.stringify(f.events)).not.toContain("secret tool");
  f.source.interactionResolved("s", "generic"); f.source.interactionResolved("s", "generic");
  expect(f.events.filter(event => event.type === "notification" && event.notification.id === "interaction:s:generic")).toHaveLength(2);
});

test("detached journal reconciliation is idempotent across source restart and resolves missing opens", () => {
  const f = fixture();
  const open = { questionId: "q", questionEntryId: "entry", originRunId: "run", openedAt: 20, questions: [], status: "open" as const, delivery: { status: "waiting" as const } };
  f.source.reconcileDetached("s", [open]); f.source.reconcileDetached("s", [open]);
  expect(f.events).toHaveLength(1);
  const reopened = fixture(f.events);
  expect(reopened.source.current()).toEqual([]);
  expect(reopened.source.recoverySessionIds()).toEqual(["s"]);
  reopened.source.reconcileDetached("s", [open]);
  expect(reopened.events).toHaveLength(1); expect(reopened.source.current()).toHaveLength(1);
  reopened.source.reconcileDetached("s", []);
  expect(reopened.events.at(-1)).toMatchObject({ type: "notification", notification: { id: "question:s:entry", state: "resolved" } });
});

test("completion outcomes are durable replay events but never pending snapshot items", () => {
  const f = fixture();
  f.source.completion("s", "completion:s:command:c", "completed", 30);
  f.source.completion("s", "completion:s:command:c", "completed", 31);
  expect(f.events).toHaveLength(1);
  expect(f.events[0]).toMatchObject({ type: "notification", notification: { state: "open", body: "Conversation completed" } });
  expect(f.source.current()).toEqual([]);
});

test("failed durable event append does not suppress a later native reconciliation", () => {
  let fail = true;
  const events: HostEvent[] = [];
  const source = new NotificationEvents({eventsAfter: () => [], session: () => session, emit: event => {
    if (fail) throw new Error("Journal unavailable");
    events.push({...event, sequence: events.length + 1});
  }});
  const interaction = { id:"journal-question",sessionId:"s",method:"input" as const,title:"Question",actions:[],createdAt:1 };
  expect(() => source.interactionRequested(interaction)).toThrow("Journal unavailable");
  expect(source.current()).toEqual([]);
  fail = false; source.interactionRequested(interaction);
  expect(events).toHaveLength(1); expect(source.current()).toHaveLength(1);
});
