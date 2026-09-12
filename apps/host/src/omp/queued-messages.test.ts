import { expect, test } from "bun:test";
import { AgentRegistry, createAgentSession, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeQueuedMessages, NativeQueueConflictError } from "./queued-messages";
import { NativeSteerAdmission } from "./steer";

type AgentMessage = Parameters<AgentSession["agent"]["steer"]>[0];
const text = (value: string, timestamp: number): AgentMessage => ({
  role: "user", content: [{ type: "text", text: value }], timestamp, attribution: "user",
} as AgentMessage);
const hidden = (timestamp: number): AgentMessage => ({
  role: "custom", customType: "ultrathink-notice", content: "hidden", display: false,
  attribution: "user", timestamp,
} as AgentMessage);

test("native queued-message inventory preserves object ownership, companions, revisions and races", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-desktop-native-queue-"));
  const cwd = path.join(root, "project"), agentDir = path.join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  await writeFile(path.join(agentDir, "config.yml"), "extensions: []\n");
  const manager = SessionManager.create(cwd, path.join(root, "sessions"));
  const { session } = await createAgentSession({ cwd, agentDir, sessionManager: manager,
    agentRegistry: new AgentRegistry(), settings: await Settings.loadReadOnly({ cwd, agentDir }), hasUI: false });
  const admission = new NativeSteerAdmission(session, manager);
  // Queue objects and replaceQueues are the real native implementation. The
  // streaming predicate is controlled here so this test never invokes a model.
  const running = new Proxy(session, { get(target, property) {
    if (property === "isStreaming") return true;
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const queue = new NativeQueuedMessages(running, admission, "fixture-worker");
  try {
    const one = text("first", 1), companion = hidden(2), two = text("second", 3), later = text("later", 4);
    session.agent.replaceQueues([one], [companion, two, later]);
    const observed: number[] = [];
    const unsubscribe = queue.subscribe(snapshot => observed.push(snapshot.revision));
    const initial = queue.snapshot();
    expect(initial.messages.map(item => [item.id, item.lane, item.text])).toEqual([
      ["fixture-worker:1", "steer", "first"],
      ["fixture-worker:2", "follow-up", "second"],
      ["fixture-worker:3", "follow-up", "later"],
    ]);
    expect(initial.messages.every(item => item.ownership === "native" && !item.editable)).toBe(true);
    expect(() => queue.mutate({ type: "reorder", expectedRevision: initial.revision,
      messageIds: [initial.messages[1]!.id, initial.messages[0]!.id, initial.messages[2]!.id] })).toThrow("delivery lanes");

    const reordered = queue.mutate({ type: "reorder", expectedRevision: initial.revision,
      messageIds: [initial.messages[0]!.id, initial.messages[2]!.id, initial.messages[1]!.id] });
    expect(session.agent.peekFollowUpQueue()).toEqual([later, companion, two]);
    expect(reordered.snapshot.messages.map(item => item.text)).toEqual(["first", "later", "second"]);
    expect(observed.at(-1)).toBe(reordered.snapshot.revision);

    const second = reordered.snapshot.messages.find(item => item.text === "second")!;
    const promoted = queue.mutate({ type: "promote", expectedRevision: reordered.snapshot.revision, messageId: second.id });
    expect([...session.agent.peekSteeringQueue()]).toEqual([one, companion, two]);
    expect(session.agent.peekFollowUpQueue()).toEqual([later]);
    expect(promoted.snapshot.messages.find(item => item.id === second.id)?.lane).toBe("steer");

    const stale = promoted.snapshot;
    session.agent.replaceQueues(session.agent.peekSteeringQueue().slice(1), [...session.agent.peekFollowUpQueue()]);
    expect(() => queue.mutate({ type: "remove", expectedRevision: stale.revision, messageId: stale.messages[0]!.id }))
      .toThrow(NativeQueueConflictError);

    const refreshed = queue.snapshot(), remaining = refreshed.messages.find(item => item.text === "later")!;
    queue.mutate({ type: "remove", expectedRevision: refreshed.revision, messageId: remaining.id });
    expect(session.agent.peekFollowUpQueue()).toEqual([]);
    unsubscribe();

    const restarted = new NativeQueuedMessages(session, admission, "replacement-worker");
    try {
      expect(restarted.snapshot().messages.every(item => item.id.startsWith("replacement-worker:"))).toBe(true);
    } finally { restarted.close(); }
  } finally {
    queue.close(); admission.cancelQueued("fixture cleanup");
    await session.dispose(); await admission.settleCancelled("fixture cleanup"); admission.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("removing an owned native follow-up settles its pending receipt without touching foreign queue entries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-desktop-owned-queue-"));
  const cwd = path.join(root, "project"), agentDir = path.join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  await writeFile(path.join(agentDir, "config.yml"), "extensions: []\n");
  const manager = SessionManager.create(cwd, path.join(root, "sessions"));
  const { session } = await createAgentSession({ cwd, agentDir, sessionManager: manager,
    agentRegistry: new AgentRegistry(), settings: await Settings.loadReadOnly({ cwd, agentDir }), hasUI: false });
  const admission = new NativeSteerAdmission(session, manager);
  const queue = new NativeQueuedMessages(session, admission, "owned-worker");
  try {
    const foreign = text("foreign", 10); session.agent.followUp(foreign);
    const pending = admission.submitFollowUp("owned");
    const deadline = Date.now() + 2_000;
    while (queue.snapshot().messages.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    const snapshot = queue.snapshot(), owned = snapshot.messages.find(item => item.text === "owned")!;
    expect(owned.ownership).toBe("desktop-pending");
    queue.mutate({ type: "remove", expectedRevision: snapshot.revision, messageId: owned.id });
    expect(await pending).toEqual({ kind: "not-recorded", reason: "Queued input was removed before native delivery" });
    expect(session.agent.peekFollowUpQueue()).toEqual([foreign]);
  } finally {
    queue.close(); admission.cancelQueued("fixture cleanup");
    await session.dispose(); await admission.settleCancelled("fixture cleanup"); admission.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
