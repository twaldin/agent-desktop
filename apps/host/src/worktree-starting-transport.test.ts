import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { CommandEnvelope, Draft, HostCommand } from "@agent-desktop/shared";
import { hasRemoteWorktreeIntent, hasNewChatIntent, remoteWorktreeProtocolError } from "./new-chat-protocol";
import { hasApprovalIntent } from "./approval";
import { hasAttachmentIntent } from "./attachment-protocol";
import { hasEnvironmentIntent } from "./environment-protocol";
import { hasSelectedTextIntent } from "./selected-text-protocol";
import { hasWholeFileIntent, hasInlineFileIntent, hasRepeatedWholeFileIntent } from "./whole-file-protocol";
import { parseCommandEnvelope } from "./validation";

const remote = { type: "branch" as const, branchName: "topic", remoteRef: "refs/remotes/origin/topic" };
const command: HostCommand = { type: "session.create", projectId: "project", worktree: remote, environment: null, draft: { id: "draft", revision: 4 } };
const draft: Draft = { id: "draft", revision: 4, updatedAt: 0, text: "keep", projectId: "project", model: null,
  environment: null, execution: { type: "worktree", startingState: remote } };

/** Exercise the actual route body without launching its enclosing host service.
 * Authentication, command-ledger and native effects are not represented here. */
async function route() {
  const source = await readFile(new URL("./server.ts", import.meta.url), "utf8");
  const start = source.indexOf('        if (request.method === "POST" && ["/v1/commands"');
  const end = source.indexOf("        const messagePath =", start);
  if (start < 0 || end < 0) throw new Error("Command route source boundary changed");
  const calls: Array<{ envelope: CommandEnvelope; version: number }> = [];
  const deps = { parseCommandEnvelope, hasRemoteWorktreeIntent, hasNewChatIntent, hasApprovalIntent, hasAttachmentIntent, hasEnvironmentIntent,
    hasSelectedTextIntent, hasWholeFileIntent, hasInlineFileIntent, hasRepeatedWholeFileIntent,
    dispatch: async (envelope: CommandEnvelope, version: number) => { calls.push({ envelope, version }); return { ok: true }; } };
  const body = `return async function(request) { const url = new URL(request.url); ${source.slice(start, end)} return new Response(null, {status:404}); }`;
  const handle = new Function(...Object.keys(deps), body)(...Object.values(deps)) as (request: Request) => Promise<Response>;
  const send = (version: number, envelope: unknown) => handle(new Request(`http://fixture.invalid/v${version}/commands`, { method: "POST", body: JSON.stringify(envelope) }));
  return { calls, send, source };
}

test("actual command route admits v12 with exact remote fields and rejects every older endpoint before dispatch", async () => {
  const f = await route();
  for (let version = 1; version < 12; version++) {
    const response = await f.send(version, { id: "original", command });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "REMOTE_WORKTREE_PROTOCOL_REQUIRED" });
  }
  expect(f.calls).toHaveLength(0);
  expect((await f.send(12, { id: "original", commandVersion: 12, command })).status).toBe(200);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({ envelope: { id: "original", commandVersion: 12, command }, version: 12 });
});

test("v12 retains earlier command parser semantics and explicit version cannot downgrade", async () => {
  const f = await route();
  const keymap: HostCommand = { type: "preferences.keymap.mutate", mutation: { expectedRevision: null, edit: { type: "command", commandId: "search", update: { type: "reset" } } } };
  expect((await f.send(11, { id: "keymap", commandVersion: 12, command: keymap })).status).toBe(422);
  expect((await f.send(12, { id: "keymap", commandVersion: 12, command: keymap })).status).toBe(200);
  const source = { kind: "file" as const, hostId: "host", path: "/project/a.ts" };
  const prompt: HostCommand = { type: "session.prompt", sessionId: "session", text: "file", wholeFileAttachments: [
    { id: "one", textOffset: 0, source }, { id: "two", textOffset: 4, source: { ...source } },
  ] };
  expect((await f.send(12, { id: "prompt", command: prompt })).status).toBe(200);
  expect(f.calls.at(-1)?.envelope.command).toMatchObject(prompt);
  expect((await f.send(13, { id: "prompt-current", commandVersion: 13, command: prompt })).status).toBe(200);
  expect(f.calls.at(-1)?.envelope.command).toMatchObject(prompt);
  expect(f.calls.map(call => call.version)).toEqual([12, 12, 13]);
  expect(() => parseCommandEnvelope({ id: "bad", commandVersion: 999_999, command })).toThrow("Unsupported command version");
  expect(() => parseCommandEnvelope({ id: "bad", commandVersion: 12, command: { ...command, worktree: { ...remote, remoteRef: "origin/topic" } } })).toThrow("starting state");
});

test("stored remote intent and preparation resume require v12 while cancellation stays available", () => {
  const read = (id: string) => id === draft.id ? draft : undefined;
  const preparation = () => ({ startingState: remote });
  const commands: HostCommand[] = [
    command,
    { type: "draft.put", expectedRevision: 4, draft: { id: draft.id, text: "keep", projectId: "project", model: null, execution: { type: "local" }, environment: null } },
    { type: "session.prompt", sessionId: "session", text: "keep", draft: { id: draft.id, revision: 4 } },
    { type: "session.steer", sessionId: "session", text: "keep", draft: { id: draft.id, revision: 4 } },
    { type: "session.environment.resume", preparationId: "original", expectedRevision: 2 },
  ];
  for (const value of commands) {
    expect(remoteWorktreeProtocolError(value, 11, read, preparation)?.code).toBe("REMOTE_WORKTREE_PROTOCOL_REQUIRED");
    expect(remoteWorktreeProtocolError(value, 12, read, preparation)).toBeUndefined();
  }
  expect(remoteWorktreeProtocolError({ type: "session.environment.cancel", projectId: "project", preparationId: "original", runRevision: 2 }, 5, read, preparation)).toBeUndefined();
  expect(draft.execution).toEqual({ type: "worktree", startingState: remote });
  expect(draft.revision).toBe(4);
});

test("remote creation cannot use the legacy creator by dropping environment, worktree or captured draft", () => {
  if (command.type !== "session.create") throw new Error("Wrong fixture");
  for (const value of [{ ...command, environment: undefined }, { ...command, draft: undefined }, { ...command, worktree: undefined, environment: undefined }])
    expect(remoteWorktreeProtocolError(value, 12, () => draft, () => undefined)?.code).toBe("REMOTE_WORKTREE_PREPARATION_REQUIRED");
  expect(remoteWorktreeProtocolError(command, 12, () => draft, () => undefined)).toBeUndefined();
  expect(parseCommandEnvelope({ id: "original", commandVersion: 12, command }).command).toMatchObject({ worktree: remote, environment: null, draft: { id: "draft", revision: 4 } });
});

test("actual server execution gate rejects older remote commands", async () => {
  const { source } = await route();
  const start = source.indexOf("    const command = envelope.command;", source.indexOf("  async function execute("));
  const end = source.indexOf("    if (commandVersion < 11", start);
  const code = source.slice(start, end);
  const gate = new Function("envelope", "commandVersion", "store", "remoteWorktreeProtocolError", "fail", code) as (...args: unknown[]) => unknown;
  const store = { getDraft: () => draft, environmentPreparations: { get: () => ({ startingState: remote }) } };
  const fail = (id: string, error: string) => ({ id, error });
  expect(gate({ id: "original", command }, 11, store, remoteWorktreeProtocolError, fail)).toEqual({ id: "original", error: "REMOTE_WORKTREE_PROTOCOL_REQUIRED" });
  expect(gate({ id: "original", command }, 12, store, remoteWorktreeProtocolError, fail)).toBeUndefined();
});
