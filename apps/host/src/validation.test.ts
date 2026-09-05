import { expect, test } from "bun:test";
import { parseCommandEnvelope } from "./validation";

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
