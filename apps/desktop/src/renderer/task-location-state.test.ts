import { expect, test } from "bun:test";
import type { DesktopBridge, TaskLocationSnapshot } from "@agent-desktop/shared";
import { createTaskLocationActions } from "./task-location-state";

const snapshot: TaskLocationSnapshot = { version: 1, sessionId: "task-a", hostId: "home", revision: "4", current: { kind: "local", cwd: "/repo", gitRoot: "/repo", branch: "main", managed: false }, local: { available: true }, localCheckoutBranches: ["feature/local"], worktree: { available: true, destination: { kind: "worktree", cwd: "/repo/.worktrees/a", gitRoot: "/repo", branch: "codex/a", managed: true } } };

test("task location commands retain the captured host/session/revision and reject stale ownership", async () => {
  const sent: unknown[] = [];
  const bridge = {
    async command(envelope: any, hostId?: string) {
      sent.push({ envelope, hostId });
      return { ok: true as const, commandId: envelope.id, value: { type: "session.location.move" as const, operation: { id: envelope.id, hostId: "home", sessionId: "task-a" }, session: {} } };
    },
  } as unknown as DesktopBridge;
  const owner = { current: { hostId: "home", sessionId: "task-a" } };
  const actions = createTaskLocationActions(bridge, owner, owner.current, async () => {}, () => true);
  await actions.move(snapshot, { kind: "worktree", branch: "codex/a", localCheckoutBranch: "main" }, "move-id");
  expect(sent).toEqual([{ hostId: "home", envelope: { id: expect.any(String), command: { type: "session.location.move", sessionId: "task-a", expectedRevision: "4", target: { kind: "worktree", branch: "codex/a", localCheckoutBranch: "main" } } }}]);
  owner.current = { hostId: "work", sessionId: "task-b" };
  await expect(actions.resume(snapshot, "op")).rejects.toThrow("task changed");
});

test("response fence rejects superseded reads, disconnects, and an ABA owner generation", () => {
  const fence = new (require("./task-location-state") as typeof import("./task-location-state")).TaskLocationRequestFence();
  const firstGeneration = fence.reset(), first = fence.request(firstGeneration), newer = fence.request(firstGeneration);
  expect(fence.accepts(first, true)).toBe(false); expect(fence.accepts(newer, true)).toBe(true); expect(fence.accepts(newer, false)).toBe(false);
  const away = fence.reset(), returned = fence.reset();
  expect(away).not.toBe(returned); expect(fence.accepts(newer, true)).toBe(false);
  const returnedRequest = fence.request(returned); expect(fence.accepts(returnedRequest, true)).toBe(true);
});

test("a command completion from an ABA owner generation cannot refresh a returned owner", async () => {
  const pending = Promise.withResolvers<any>(); let valid = true, refreshes = 0;
  const bridge = { command: async () => pending.promise } as unknown as DesktopBridge;
  const owner = { current: { hostId: "home", sessionId: "task-a" } };
  const actions = createTaskLocationActions(bridge, owner, owner.current, async () => { refreshes++; }, () => valid);
  const move = actions.move(snapshot, { kind: "worktree", branch: "codex/a", localCheckoutBranch: "main" }, "operation-a");
  valid = false; pending.resolve({ ok: true, commandId: "operation-a", value: { type: "session.location.move", operation: { id: "operation-a", hostId: "home", sessionId: "task-a" }, session: {} } });
  await expect(move).rejects.toThrow("changed while"); expect(refreshes).toBe(0);
});

test("a successful command must acknowledge the exact command and original operation identities", async () => {
  const owner = { current: { hostId: "home", sessionId: "task-a" } };
  const wrongCommand = { command: async () => ({ ok: true, commandId: "other-command", value: { type: "session.location.move", operation: { id: "move-a", hostId: "home", sessionId: "task-a" }, session: {} } }) } as unknown as DesktopBridge;
  await expect(createTaskLocationActions(wrongCommand, owner, owner.current, async () => {}, () => true).move(snapshot, { kind: "worktree", branch: "codex/a", localCheckoutBranch: "feature/local" }, "move-a")).rejects.toThrow("different task location command");
  const wrongOperation = { command: async (envelope: { id: string }) => ({ ok: true, commandId: envelope.id, value: { type: "session.location.move", operation: { id: "replacement", hostId: "home", sessionId: "task-a" }, session: {} } }) } as unknown as DesktopBridge;
  await expect(createTaskLocationActions(wrongOperation, owner, owner.current, async () => {}, () => true).resume(snapshot, "original")).rejects.toThrow("different task location operation");
});
