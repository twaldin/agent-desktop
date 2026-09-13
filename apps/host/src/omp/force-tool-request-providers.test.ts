import { expect, test } from "bun:test";
import { runForceNativeFixture } from "./fixtures/force-native-subprocess";

const groups: Record<string, string[]> = {
  codex: ["codex-function", "codex-custom-wire-name", "codex-native-computer"],
  responses: ["responses-named", "responses-narrowed-required", "responses-quarantined-requested-tool", "responses-owned-inband-suppresses-both-legs", "responses-native-error-requeue", "responses-native-abort-requeue"],
  azure: ["azure-actual-forwarding-named-true", "azure-actual-forwarding-named-false", "azure-native-computer-forwarding", "azure-distinct-no-common-quarantine"],
  completions: ["completions-named", "completions-narrowed-required", "completions-no-tool-choice", "completions-forced-downgrade", "completions-missing-emitted-name", "completions-native-kimi-k3"],
  anthropic: ["anthropic-forced-thinking", "anthropic-oauth-encoded-name", "anthropic-claude-fable-5-native-downgrade", "anthropic-claude-mythos-5-native-downgrade", "anthropic-required-thinking-compat"],
  bedrock: ["bedrock-forced-removes-thinking", "bedrock-prefix-thinking-auto", "bedrock-none-history-empty-false", "bedrock-none-history-empty-true"],
  ollama: ["ollama-narrowed-required-and-none", "ollama-missing-offered-name-still-required"],
};
for (const [group, labels] of Object.entries(groups)) test(`native force ${group}: original stream and pinned builder, both queue legs`, async () => {
  const result = await runForceNativeFixture("force-provider-requests.ts", group);
  if (!("observations" in result) || !Array.isArray(result.observations)) throw new Error("Missing provider assertion evidence");
  const observed = result.observations.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("label" in entry) || typeof entry.label !== "string") throw new Error("Invalid provider observation");
    return entry.label;
  });
  expect(observed).toEqual(labels);
}, 120_000);
