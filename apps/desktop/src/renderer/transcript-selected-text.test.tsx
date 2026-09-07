import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TranscriptMessages } from "./Transcript";
import type { TranscriptMessage } from "@agent-desktop/shared";

const selectedText: NonNullable<TranscriptMessage["selectedText"]> = { contextEntryId: "context", submissionId: "send", bindingEntryId: "binding", attachments: [{ id: "snapshot", text: "captured value", source: { kind: "file", hostId: "other-host", path: "/missing.ts", range: { start: { line: 1, column: 1 }, end: { line: 1, column: 15 } } } }] };
const render = (message: TranscriptMessage) => renderToStaticMarkup(<TranscriptMessages messages={[message]} contextKey="test" connected={false}/>);
test("an excerpt-only sent message has a readonly chip without an empty bubble", () => {
  const html = render({ id: "user", nativeId: "native-user", role: "user", text: "", content: [{ type: "text", text: "" }], selectedText });
  expect(html).toContain("1 selection");
  expect(html).toContain('data-native-id="native-user"');
  expect(html).not.toContain('class="message-body"');
  expect(html).not.toContain("composer-selected-text-remove");
  expect(html).not.toContain("href=");
});
test("unlinked saved context is visibly distinct from an authored user message", () => {
  const { bindingEntryId: _, ...unlinked } = selectedText;
  const html = render({ id: "context-display", nativeId: "context", role: "selectedText", text: "", selectedText: unlinked });
  expect(html).toContain("Saved context · prompt not linked");
  expect(html).toContain('data-native-id="context"');
  expect(html).not.toContain('aria-label="Your message"');
  expect(html).not.toContain("composer-selected-text-remove");
});
