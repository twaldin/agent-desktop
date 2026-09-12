import { expect, test } from "bun:test";
import type { CommandEnvelope } from "@agent-desktop/shared";
import { commandEndpoint, requestVersionedCommand } from "./command-endpoints";
import { HostRequestError } from "./host-transport";

const remote = { type: "branch" as const, branchName: "topic", remoteRef: "refs/remotes/origin/topic" };
const create: CommandEnvelope = { id: "original", command: { type: "session.create", projectId: "project", worktree: remote, environment: null, draft: { id: "draft", revision: 4 } } };

test("remote creation and draft writes choose only v12 even with an earlier explicit marker", async () => {
  const inputs: CommandEnvelope[] = [create, { ...create, commandVersion: 9 },
    { id: "save", command: { type: "draft.put", expectedRevision: 4, draft: { id: "draft", text: "keep", projectId: "project", model: null, execution: { type: "worktree", startingState: remote } } } },
    { id: "clear", commandVersion: 12, command: { type: "draft.put", expectedRevision: 4, draft: { id: "draft", text: "keep", projectId: "project", model: null, execution: { type: "local" } } } },
    { id: "resume", commandVersion: 12, command: { type: "session.environment.resume", preparationId: "original", expectedRevision: 2 } },
  ];
  for (const envelope of inputs) {
    expect(commandEndpoint(envelope)).toBe("/v12/commands");
    const calls: Array<{ path: string; body: unknown }> = [];
    expect(await requestVersionedCommand(async (path, body) => { calls.push({ path, body }); throw new HostRequestError("Not found", 404); }, envelope))
      .toMatchObject({ ok: false, commandId: envelope.id, error: { code: "REMOTE_WORKTREE_PROTOCOL_UNSUPPORTED" } });
    expect(calls).toEqual([{ path: "/v12/commands", body: envelope }]);
    expect(calls[0]!.body).toBe(envelope);
  }
});

test("v12 coded errors and uncertain delivery retain the original error with no retry", async () => {
  for (const error of [new HostRequestError("unauthorized", 401), new HostRequestError("source missing", 404, "PROJECT_MISSING"), new Error("timeout after admission")]) {
    let calls = 0;
    await expect(requestVersionedCommand(async () => { calls++; throw error; }, create)).rejects.toBe(error);
    expect(calls).toBe(1);
  }
  expect(commandEndpoint({ id: "ordinary", command: { type: "session.create", projectId: "project", worktree: { type: "branch", branchName: "main" } } })).toBe("/v4/commands");
});
