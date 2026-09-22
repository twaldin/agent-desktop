import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TranscriptMirror } from "../../../host/src/omp/transcript";
import { TranscriptMessages } from "./Transcript";

test("native background completions use compact rows with original content in a closed disclosure", () => {
  const source = { role: "custom", customType: "async-result", display: true, timestamp: 1,
    content: "<system-notice>Original output & <script>literal</script></system-notice>",
    details: { jobs: [{ jobId: "agent-a", type: "task", durationMs: 2500 }, { jobId: "bg_2", type: "eval" }] } };
  const messages = new TranscriptMirror().snapshot([source], [{ id: "native", message: source }]);
  for (const connected of [true, false]) {
    const html = renderToStaticMarkup(<TranscriptMessages messages={messages} contextKey="owner:session" connected={connected}/>);
    expect(html).toContain('aria-label="Background job results"');
    expect(html.match(/Background job completed/g)).toHaveLength(2);
    expect(html).toContain("agent-a"); expect(html).toContain("2.5s"); expect(html).toContain("bg_2");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('hidden=""');
    expect(html).toContain("Original output");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("Cancel"); expect(html).not.toContain("Running");
  }
});

test("a textual completion lookalike remains the ordinary message", () => {
  const source = { role: "assistant", timestamp: 1, content: "Background job completed <system-notice>text</system-notice>" };
  const messages = new TranscriptMirror().snapshot([source], [{ id: "native", message: source }]);
  const html = renderToStaticMarkup(<TranscriptMessages messages={messages} contextKey="owner:session" connected/>);
  expect(html).not.toContain('aria-label="Background job results"');
  expect(html).toContain("Background job completed");
});
