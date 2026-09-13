import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { CommandEnvelope, Draft, ImageAttachmentRef } from "@agent-desktop/shared";
import { DraftController } from "./drafts";
import { SubmissionController } from "./submissions";

// Execute the actual Restore message callback with the real controllers. This
// checks the App integration seam, without claiming a mounted React/DOM test.
const app = readFileSync(process.env.QUEUED_RESTORE_APP ?? new URL("./App.tsx", import.meta.url), "utf8");
const end = app.indexOf("}>Restore message</button>");
const start = app.lastIndexOf("onClick={", end);
if (start < 0 || end < start) throw new Error("Restore message callback is missing");
const callback = app.slice(start + "onClick={".length, end);
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(`function restore(values) {
  const { submissions, drafts, draftId, item, textarea, setActionError, errorMessage } = values;
  return (${callback})();
}`);
const restore = new Function(`${compiled}; return restore;`)() as (values: Record<string, unknown>) => void;
const image: ImageAttachmentRef = { id: "image-one", hostId: "host", kind: "image", name: "capture.png", mimeType: "image/png", bytes: 4, sha256: "a".repeat(64) };

for (const images of [undefined, [image]] as const) {
  test(`actual App restores ${images ? "image" : "legacy text"} follow-up into an emptied image-aware composer`, async () => {
    const draft: Draft = { id: "session-draft", revision: 3, text: "Restore this message", projectId: null,
      model: null, updatedAt: 1, ...(images ? { attachments: [...images] } : {}) };
    const submissions = new SubmissionController(async (envelope: CommandEnvelope) => ({ ok: true, commandId: envelope.id,
      value: { type: "session.follow-up", receipt: { version: 1, commandId: envelope.id, hostId: "host", sessionId: "session",
        delivery: "follow-up", phase: "settled", outcome: "not-recorded", message: "Removed from queue", revision: 2, createdAt: 1, updatedAt: 2 } } }), "host");
    const drafts = new DraftController(async () => { throw new Error("Unexpected offline draft write"); }, "host");
    try {
      await expect(submissions.submitActive(draft, "session", "follow-up")).rejects.toThrow("Removed from queue");
      const item = submissions.queuedEntries()[0]!;
      drafts.ingest({ ...draft, revision: 4, text: "", attachments: [] });
      const errors: string[] = []; let focused = 0;
      restore({ submissions, drafts, draftId: draft.id, item,
        textarea: { current: { focus() { focused++; } } }, setActionError: (message: string) => errors.push(message),
        errorMessage: (cause: unknown) => cause instanceof Error ? cause.message : String(cause) });
      expect(errors).toEqual([]);
      expect(drafts.get(draft.id).draft).toMatchObject({ text: draft.text, attachments: images ? [image] : [] });
      expect(submissions.queuedEntries()).toEqual([]);
      expect(focused).toBe(1);
    } finally { drafts.dispose(); }
  });
}
