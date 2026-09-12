import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
/** Fixture-only policy hooks loaded by the real native session extension runner. */
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", event => {
    if (event.toolName !== "mcp__fixture_increment") return;
    if (event.input.by === 13) return { block: true, reason: "Fixture extension blocked this app call" };
    if (event.input.by === 3) return { input: { by: 4 } };
  });
  pi.on("tool_result", event => {
    if (event.toolName === "mcp__fixture_increment" && event.input.by === 4) return { content: [{ type: "text", text: "Extension replaced the app result" }] };
  });
}
