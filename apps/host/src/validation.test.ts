import { expect, test } from "bun:test";
import { parseCommandEnvelope } from "./validation";
import type { ImageAttachmentRef } from "@agent-desktop/shared";

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

test("preserves the captured draft revision for prompts and steering", () => {
  for (const type of ["session.prompt", "session.steer"]) {
    const parsed = parseCommandEnvelope({ id: "c", command: { type, sessionId: "s", text: "hello", draft: { id: "d", revision: 3 } } });
    expect(parsed.command).toMatchObject({ draft: { id: "d", revision: 3 } });
  }
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
