import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import type { TranscriptMessage } from "../../../../packages/shared/src/protocol";
import { TranscriptMirror } from "../../../host/src/omp/transcript";
import { TranscriptItem, TranscriptMessages } from "./Transcript";
import { messageBlocks, toolLinks, toolOutcome, TranscriptDisclosureState } from "./transcript-state";

// Production projection plus renderer/state contracts with deterministic native
// fixtures. These do not substitute for installed Electron interaction checks.
const call = (id: string, name = "read") => ({ type: "toolCall" as const, id, name, arguments: { path: `${id}.txt` } });
const project = (messages: unknown[]) => new TranscriptMirror().snapshot(messages, messages.map((message, index) => ({ id: `entry-${index}`, message })));
const render = (messages: TranscriptMessage[], connected = true) => renderToStaticMarkup(<TranscriptMessages messages={messages} contextKey="fixture-host:fixture-session" connected={connected}/>);

describe("ordered transcript renderer", () => {
  test("thinking, text, calls, text and results keep native positions without flattened-text duplication", () => {
    const messages = project([
      { role: "assistant", timestamp: 1, content: [{ type: "text", text: "Before marker" }, { type: "thinking", thinking: "Reason marker" }, call("a"), { type: "text", text: "After marker" }] },
      { role: "user", timestamp: 2, content: "Intervening marker" },
      { role: "toolResult", toolCallId: "a", toolName: "read", timestamp: 3, isError: false, content: [{ type: "text", text: "Output marker" }] },
    ]);
    const html = render(messages);
    const markers = ["Before marker", "Reason marker", 'class="transcript-tool-invocation"', "After marker", "Intervening marker", "Output marker"];
    expect(markers.map(marker => html.indexOf(marker))).toEqual(markers.map(marker => html.indexOf(marker)).toSorted((a, b) => a - b));
    expect(markers.every(marker => html.includes(marker))).toBe(true);
    expect(html.match(/Before marker/g)).toHaveLength(1);
    expect(html.match(/After marker/g)).toHaveLength(1);
    expect(html).toContain("Completed");
    const href = html.match(/class="transcript-call-reference" href="#([^"]+)"/)?.[1];
    expect(href).toBeDefined();
    expect(html).toContain(`id="${decodeURIComponent(href!)}"`);
  });

  test("parallel results link by native call ID and a reused ID links to its new invocation", () => {
    const messages = project([
      { role: "assistant", timestamp: 1, content: [call("a"), call("b", "bash")] },
      { role: "toolResult", timestamp: 2, toolCallId: "b", toolName: "bash", isError: true, content: "failed b" },
      { role: "toolResult", timestamp: 3, toolCallId: "a", toolName: "read", isError: false, content: "done a" },
      { role: "assistant", timestamp: 4, content: [call("a")] },
      { role: "toolResult", timestamp: 5, toolCallId: "a", toolName: "read", isError: false, content: "new a" },
    ]);
    const links = toolLinks(messages);
    expect(links.results.get(messages[1].id)?.call.id).toBe("b");
    expect(links.results.get(messages[2].id)?.messageId).toBe(messages[0].id);
    expect(links.results.get(messages[4].id)?.messageId).toBe(messages[3].id);
    expect(toolOutcome(links.calls.get(`${messages[0].id}:block:1`)?.result)).toEqual({ label: "Failed", tone: "error" });
    expect(links.calls.size).toBe(3);
  });

  test("ambiguous call IDs and old-host results stay honest generic fallbacks", () => {
    const messages = project([{ role: "assistant", timestamp: 1, content: [call("duplicate"), call("duplicate")] }, { role: "toolResult", timestamp: 2, toolCallId: "duplicate", content: [] }]);
    expect(toolLinks(messages).results.size).toBe(0);
    const old: TranscriptMessage = { id: "old", role: "toolResult", text: "Legacy output", blocks: [{ type: "text", text: "Legacy output" }] };
    expect(toolOutcome(old).label).toBe("Outcome unavailable");
    const html = render([old]);
    expect(html).toContain("Legacy output");
    expect(html).not.toContain("Completed");
    expect(html).not.toContain("Running");
    expect(messageBlocks({ ...old, blocks: [call("a"), { type: "redactedThinking", data: "not-displayable" }] })).toEqual([call("a"), { type: "unsupported", nativeType: "redactedThinking" }]);
  });

  test("empty completed output, failed output, unknown outcome and offline running are distinct", () => {
    const mirror = new TranscriptMirror();
    for (const [id, isError] of [["ok", false], ["error", true], ["unknown", undefined]] as const) {
      mirror.accept({ type: "tool_execution_end", toolCallId: id, toolName: id, result: { content: [] }, isError });
    }
    mirror.accept({ type: "tool_execution_start", toolCallId: "running", toolName: "read", args: {} });
    const messages = mirror.snapshot([], []);
    expect(messages.map(message => toolOutcome(message, false).label)).toEqual(["Completed", "Failed", "Finished · outcome unavailable", "Last observed running"]);
    const html = render(messages, false);
    expect(html).toContain("No output was returned.");
    expect(html).toContain("The tool failed without output.");
    expect(html).toContain("No output has been received.");
    expect(html).toContain("Last observed running");
  });

  test("native output remains literal and complete across separate blocks, including trailing whitespace", () => {
    const source = "  <script>literal()</script>\n```js\nnotMarkdown()\n```\n\tfinal  \n";
    const messages = project([{ role: "toolResult", toolCallId: "literal", toolName: "read", isError: false, content: [{ type: "text", text: source }, { type: "text", text: "second output block\n" }] }]);
    const html = render(messages);
    expect(html).toContain("&lt;script&gt;literal()&lt;/script&gt;\n```js\nnotMarkdown()\n```\n\tfinal  \n");
    expect(html).toContain("second output block\n");
    expect(html).not.toContain("<script>");
    expect(html).toContain('aria-label="Copy output"');
  });

  test("explicit disclosure choices survive durable IDs and reconnect row remounts", () => {
    const mirror = new TranscriptMirror(), state = new TranscriptDisclosureState();
    mirror.accept({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: {} });
    const live = mirror.snapshot([], [])[0];
    const item = (message: TranscriptMessage) => renderToStaticMarkup(<TranscriptItem message={message} connected disclosures={state} calls={new Map()}/>);
    expect(item(live)).toContain('aria-expanded="true"');
    state.set(live.id, false);
    expect(item(live)).toContain('aria-expanded="false"');
    const nativeMessage = { role: "toolResult", toolCallId: "a", timestamp: 2, isError: false, content: [] };
    mirror.accept({ type: "message_end", message: nativeMessage } as AgentSessionEvent);
    const durable = mirror.snapshot([nativeMessage], [{ id: "entry", message: nativeMessage }])[0];
    expect(durable.id).toBe(live.id);
    expect(item(durable)).toContain('aria-expanded="false"');
    state.set(durable.id, true);
    const reconnected = new TranscriptMirror().snapshot([nativeMessage], [{ id: "entry", message: nativeMessage }])[0];
    const html = item(reconnected);
    expect(html).toContain('aria-expanded="true"');
    const controls = html.match(/aria-controls="([^"]+)"/)?.[1];
    expect(html).toContain(`id="${controls}"`);
    expect(html).not.toContain('hidden=""');
    expect(new TranscriptDisclosureState().get(durable.id)).toBe(false); // Navigation/reload persistence remains a later scope.
  });

  test("only completed native error/abort/length metadata produces terminal notices", () => {
    for (const [stopReason, expected] of [["error", "Native provider error"], ["aborted", "This response was interrupted."], ["length", "The response reached its output limit."]] as const) {
      const [message] = project([{ role: "assistant", timestamp: 1, content: [], stopReason, ...(stopReason === "error" ? { errorMessage: expected } : {}) }]);
      expect(render([message])).toContain(expected);
      expect(render([{ ...message, lifecycle: "streaming" }])).not.toContain(expected);
    }
    const [metadata] = project([{ role: "assistant", timestamp: 1, provider: "fixture-provider", model: "fixture-model", content: "Text", duration: 30, usage: { input: 7, output: 3 } }]);
    const html = render([metadata]);
    expect(html).toContain("fixture-provider"); expect(html).toContain("fixture-model"); expect(html).toContain("30 ms"); expect(html).toContain("Reported usage");
  });

  test("unknown roles, withheld reasoning and a view without image support stay visible without raw data", () => {
    const messages = project([{ role: "extensionNotice", content: "Native note" }, { role: "assistant", content: [{ type: "redactedThinking", data: "fixture-hidden" }, { type: "image", mimeType: "image/png", data: "fixture-image" }] }]);
    const html = render(messages);
    expect(html).toContain("Native extensionNotice message"); expect(html).toContain("Native note");
    expect(html).toContain("The provider withheld this reasoning content."); expect(html).toContain("Image preview is unavailable in this view.");
    expect(html).not.toContain("fixture-hidden"); expect(html).not.toContain("fixture-image");
  });
});
