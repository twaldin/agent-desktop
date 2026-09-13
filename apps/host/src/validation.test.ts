import { expect, test } from "bun:test";
import { parseCommandEnvelope } from "./validation";
import type { ImageAttachmentRef } from "@agent-desktop/shared";

test("side questions reach their dedicated start and cancel commands with bounded native inputs", () => {
  const command = { type: "session.btw.start", sessionId: "parent", question: "  Explain this  " } as const;
  expect(parseCommandEnvelope({ id: "side-1", commandVersion: 5, command })).toEqual({
    id: "side-1", commandVersion: 5, command: { ...command, question: "Explain this" },
  });
  expect(parseCommandEnvelope({ id: "stop-1", command: { type: "session.btw.cancel", sessionId: "parent", runId: "side-1" } }).command)
    .toEqual({ type: "session.btw.cancel", sessionId: "parent", runId: "side-1" });
  for (const question of [null, " ", "x".repeat(32_769), "é".repeat(16_385)]) {
    expect(() => parseCommandEnvelope({ id: "side-1", command: { ...command, question } })).toThrow();
  }
  expect(() => parseCommandEnvelope({ id: "side-1", command: { ...command, attachments: [] } })).toThrow();
  expect(() => parseCommandEnvelope({ id: "bad/id", command })).toThrow();
  expect(() => parseCommandEnvelope({ id: "stop-1", command: { type: "session.btw.cancel", sessionId: "parent", runId: "../other" } })).toThrow();
  expect(parseCommandEnvelope({ id: "composer-side", command: { ...command, question: "Explain this", nativeCommand: "btw",
    draft: { id: "session:parent", revision: 7 } } }).command).toEqual({ ...command, question: "Explain this", nativeCommand: "btw",
      draft: { id: "session:parent", revision: 7 } });
  expect(() => parseCommandEnvelope({ id: "composer-side", command: { ...command, nativeCommand: "btw" } })).toThrow("exact main composer draft");
  expect(() => parseCommandEnvelope({ id: "composer-side", command: { ...command, nativeCommand: "btw", draft: { id: "btw:parent", revision: 1 } } })).toThrow();
  expect(() => parseCommandEnvelope({ id: "composer-side", command: { ...command, nativeCommand: "BTW", draft: { id: "session:parent", revision: 1 } } })).toThrow();
});

test("image-aware validation preserves ordered metadata and allows image-only prompts without silently accepting unknown image fields", () => {
  const image: ImageAttachmentRef = { id: "chip", hostId: "owner", kind: "image", sha256: "a".repeat(64), name: "image.png", bytes: 10, mimeType: "image/png" };
  const prompt = { type: "session.prompt", sessionId: "s", text: "", attachments: [image] };
  const parsed = parseCommandEnvelope({ id: "capture", command: prompt });
  image.name = "later";
  expect(parsed.command).toMatchObject({ text: "", attachments: [{ name: "image.png" }] });
  expect(() => parseCommandEnvelope({ id: "empty", command: { ...prompt, attachments: [] } })).toThrow();
  expect(() => parseCommandEnvelope({ id: "large", command: { ...prompt, text: "x".repeat(500_001) } })).toThrow();
  expect(() => parseCommandEnvelope({ id: "url", command: { ...prompt, attachments: [{ ...image, url: "file:///private/image" }] } })).toThrow();
  expect(() => parseCommandEnvelope({ id: "strip", command: { type: "session.interrupt", sessionId: "s", attachments: [] } })).toThrow();
  expect(() => parseCommandEnvelope({ id: "forged", command: { type: "draft.put", expectedRevision: 0, draft: { id: "d", text: "", projectId: null, model: null, attachments: [], lastConsumption: { commandId: "c", submittedRevision: 1 } } } })).toThrow();
});

test("rejects malformed transport commands before runtime or filesystem calls", () => {
  for (const command of [
    { type: "project.add", path: "relative/path" },
    { type: "session.archive", sessionId: "a", archived: "false" },
    { type: "session.prompt", sessionId: "a", text: null },
    { type: "draft.put", expectedRevision: -1, draft: {} },
    { type: "execute-anything", command: "ignored" },
  ]) expect(() => parseCommandEnvelope({ id: "c", command })).toThrow();
});

test("project catalog mutations accept only bounded project identities and names", () => {
  expect(parseCommandEnvelope({ id: "rename", command: { type: "project.rename", projectId: "project", name: "Renamed" } }).command)
    .toEqual({ type: "project.rename", projectId: "project", name: "Renamed" });
  expect(parseCommandEnvelope({ id: "remove", command: { type: "project.remove", projectId: "project" } }).command)
    .toEqual({ type: "project.remove", projectId: "project" });
  for (const command of [{ type: "project.rename", projectId: "", name: "Name" }, { type: "project.rename", projectId: "project", name: "" }, { type: "project.remove", projectId: "" }])
    expect(() => parseCommandEnvelope({ id: "catalog", command })).toThrow();
});

test("preserves the captured draft revision for prompts and steering", () => {
  for (const type of ["session.prompt", "session.steer"]) {
    const parsed = parseCommandEnvelope({ id: "c", command: { type, sessionId: "s", text: "hello", draft: { id: "d", revision: 3 } } });
    expect(parsed.command).toMatchObject({ draft: { id: "d", revision: 3 } });
  }
});

test("only command version 9 accepts repeated anchored whole-file sources", () => {
  const source = { kind: "file" as const, hostId: "host", path: "/project/repeat.ts" };
  const command = { type: "session.prompt", sessionId: "s", text: "read", wholeFileAttachments: [
    { id: "first", textOffset: 0, source }, { id: "second", textOffset: 4, source: { ...source } },
  ] } as const;
  expect(parseCommandEnvelope({ id: "repeat", commandVersion: 9, command })).toMatchObject({ commandVersion: 9, command });
  expect(() => parseCommandEnvelope({ id: "old", commandVersion: 8, command })).toThrow("sources");
  expect(() => parseCommandEnvelope({ id: "legacy", commandVersion: 9, command: { ...command,
    wholeFileAttachments: command.wholeFileAttachments.map(({ textOffset: _, ...file }) => file) } })).toThrow("offsets");
});

test("branch checkout requires an exact reviewed status and preserves only its bounded native inputs", () => {
  const revision = "a".repeat(64);
  expect(parseCommandEnvelope({ id: "switch", command: { type: "workspace.mutate", target: { projectId: "project" },
    action: { type: "git.checkout", branch: "feature/local", expectedRevision: revision, create: true } } })).toMatchObject({ command: {
      target: { projectId: "project" }, action: { type: "git.checkout", branch: "feature/local", expectedRevision: revision, create: true },
    } });
  for (const action of [
    { type: "git.checkout", branch: "feature" },
    { type: "git.checkout", branch: "feature", expectedRevision: "stale" },
    { type: "git.checkout", branch: "feature", expectedRevision: revision, create: "yes" },
    { type: "git.checkout", branch: "", expectedRevision: revision },
  ]) expect(() => parseCommandEnvelope({ id: "switch", command: { type: "workspace.mutate", target: { projectId: "project" }, action } })).toThrow();
});

test("force intent requires version18 and preserves one exact detached guard", () => {
  const forceTool = { epoch: "worker-epoch", expectedRevision: 7, toolName: "read" };
  const base = { id: "force-command", command: { type: "session.prompt", sessionId: "session", text: "/force read inspect this", forceTool } };
  expect(() => parseCommandEnvelope(base, 17)).toThrow("version 18");
  const accepted = parseCommandEnvelope(base, 18);
  forceTool.expectedRevision = 8;
  expect(accepted.command).toMatchObject({ forceTool: { epoch: "worker-epoch", expectedRevision: 7, toolName: "read" } });
  expect(() => parseCommandEnvelope({ ...base, commandVersion: 17 }, 18)).toThrow("version 18");
  expect(() => parseCommandEnvelope({ ...base, command: { ...base.command, forceRecovery: { epoch: "worker-epoch", expectedRevision: 8, directiveId: "directive" } } }, 18)).toThrow("mutually exclusive");
  expect(() => parseCommandEnvelope({ ...base, command: { ...base.command, type: "session.steer" } }, 18)).toThrow();
  expect(() => parseCommandEnvelope({ ...base, command: { ...base.command, forceTool: { ...forceTool, expectedRevision: -1 } } }, 18)).toThrow();
});

test("force cancellation preserves exact ticket and rejects extra or stale-format fields", () => {
  const ticket = { epoch: "worker-epoch", revision: 3 };
  const input = { id: "cancel-command", command: { type: "session.force.cancel", sessionId: "session", ticket, directiveId: "original-directive" } };
  const accepted = parseCommandEnvelope(input, 18);
  ticket.epoch = "replacement";
  expect(accepted.command).toEqual({ type: "session.force.cancel", sessionId: "session", ticket: { epoch: "worker-epoch", revision: 3 }, directiveId: "original-directive" });
  expect(() => parseCommandEnvelope(input, 17)).toThrow("version 18");
  expect(() => parseCommandEnvelope({ ...input, command: { ...input.command, all: true } }, 18)).toThrow();
  expect(() => parseCommandEnvelope({ ...input, command: { ...input.command, directiveId: "" } }, 18)).toThrow();
});

test("Plan execution retry requires v19 and preserves only durable continuation identities", () => {
  const command = { type: "session.plan.execution.retry", sessionId: "destination", originSessionId: "origin",
    originalCommandId: "approve", expectedAttemptId: "retry-one" } as const;
  expect(parseCommandEnvelope({ id: "retry-two", commandVersion: 19, command }, 19)).toEqual({ id: "retry-two", commandVersion: 19, command });
  expect(() => parseCommandEnvelope({ id: "retry-two", command }, 18)).toThrow("version 19");
  expect(() => parseCommandEnvelope({ id: "retry-two", commandVersion: 19, command: { ...command, phaseId: "private" } }, 19)).toThrow("keys");
  expect(() => parseCommandEnvelope({ id: "retry-two", commandVersion: 19, command: { ...command, expectedAttemptId: "bad/id" } }, 19)).toThrow("identity");
});
