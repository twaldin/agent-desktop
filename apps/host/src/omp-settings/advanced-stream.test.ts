import { expect, test } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { NativeAdvancedStreamControls } from "./advanced-stream";

const ENTRY = "agent-desktop.advanced-stream.v1";
type CapturedCall = { model: Model; context: unknown; options: Record<string, unknown> | undefined };
type Receipt = { type: "custom"; customType: string; data: unknown };

/** Controlled session/stream seam: exercises production ownership, receipt, validation,
 * and forwarding logic without constructing an AgentSession or claiming native SDK proof.
 */
function controlledSession(initialModel: Model, initialSelection?: Record<string, unknown>) {
  let model = initialModel;
  const branch: Receipt[] = initialSelection ? [{ type: "custom", customType: ENTRY, data: {
    model: { provider: model.provider, id: model.id, api: model.api }, selection: { ...initialSelection },
  } }] : [];
  const calls: CapturedCall[] = [];
  const original = (callModel: Model, context: unknown, options: Record<string, unknown> | undefined) => {
    calls.push({ model: callModel, context, options });
    return { controlled: true };
  };
  const agent = { streamFn: original, temperature: 0.35, topP: 0.8 };
  const session = {
    get model() { return model; },
    agent,
    sessionManager: {
      getBranch: () => branch,
      appendCustomEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
    },
  } as unknown as AgentSession;
  return { session, branch, calls, setModel: (next: Model) => { model = next; } };
}
function identity(model: Model) { return { provider: model.provider, id: model.id, api: model.api }; }
function mutation(model: Model, field: "temperature" | "topP" | "maxTokens", action: "set" | "inherit" | "provider-default", value?: number) {
  return { operation: "advanced-stream" as const, expectedRevision: "controlled-revision", model: identity(model), field, action, ...(action === "set" ? { value } : {}) };
}
function expectCode(run: () => unknown, code: string) {
  try { run(); throw new Error("Expected controlled mutation to fail."); }
  catch (error) { expect((error as { code?: string }).code).toBe(code); }
}

function dispatch(session: AgentSession, model: Model, options: Record<string, unknown>) {
  return (session.agent.streamFn as unknown as (model: Model, context: unknown, options: Record<string, unknown>) => unknown)(model, { messages: [] }, options);
}

test("trusted Anthropic models expose only an output budget and forward only that retained field", async () => {
  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  const controlled = controlledSession(model, { temperature: 0.2, topP: 0.7, maxTokens: 2048 });
  const controls = new NativeAdvancedStreamControls(controlled.session);

  const state = controls.read();
  expect(state.supported).toBe(false); // Older clients must not offer all three fields.
  expect(state.reason).toContain("Update your desktop"); // Legacy clients render this message without editable rows.
  expect(state.fields).toEqual({
    temperature: { supported: false, reason: expect.stringContaining("effective thinking mode"), minimum: 0, maximum: 1 },
    topP: { supported: false, reason: expect.stringContaining("mutually exclusive provider parameters"), minimum: 0, maximum: 1 },
    maxTokens: { supported: true, reason: expect.stringContaining("native request construction"), minimum: 1, maximum: 64000 },
  });
  expect(state.outputBudgetNote).toContain("native thinking may increase it");
  expect(state.outputBudgetNote).toContain("OAuth may cap it at 64000");
  expect(state.selection).toEqual({ temperature: 0.2, topP: 0.7, maxTokens: 2048 });

  const nativeOptions = { temperature: 0.55, topP: 0.66, cacheRetention: "short", maxRetryDelayMs: 1234 };
  await dispatch(controlled.session, model, nativeOptions);
  expect(controlled.calls[0]!.options).toEqual({ ...nativeOptions, maxTokens: 2048 });
  expect(controlled.calls[0]!.options?.temperature).toBe(0.55);
  expect(controlled.calls[0]!.options?.topP).toBe(0.66);

  expectCode(() => controls.mutate(mutation(model, "temperature", "set", 0.1)), "unsupported");
  expectCode(() => controls.mutate(mutation(model, "topP", "provider-default")), "unsupported");
  expectCode(() => controls.mutate(mutation(model, "maxTokens", "set", 64001)), "invalid-value");

  controls.mutate(mutation(model, "temperature", "inherit"));
  expect(controls.read().selection).toEqual({ topP: 0.7, maxTokens: 2048 });
  expect((controlled.branch.at(-1)!.data as { selection: unknown }).selection).toEqual({ topP: 0.7, maxTokens: 2048 });
});

test("Anthropic lowered-limit recovery preserves intent, blocks dispatch, and clears only explicitly inherited fields", async () => {
  const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
  const lowered = { ...bundled, maxTokens: 128 } satisfies Model;
  const controlled = controlledSession(lowered, { temperature: 0.2, maxTokens: 512 });
  const controls = new NativeAdvancedStreamControls(controlled.session);

  expect(controls.read().outputLimitConflict).toEqual({ saved: 512, maximum: 128 });
  expectCode(() => dispatch(controlled.session, lowered, { cacheRetention: "short" }), "invalid-value");
  expect(controlled.calls).toHaveLength(0);
  expectCode(() => controls.mutate(mutation(lowered, "maxTokens", "set", 512)), "invalid-value");

  controls.mutate(mutation(lowered, "maxTokens", "inherit"));
  const recovered = controls.read();
  expect(recovered.outputLimitConflict).toBeUndefined();
  expect(recovered.selection).toEqual({ temperature: 0.2 });
  await dispatch(controlled.session, lowered, { cacheRetention: "short" });
  expect(controlled.calls[0]!.options).toEqual({ cacheRetention: "short" });
});

test("Gemini field support remains complete while untrusted Anthropic and Codex models remain unavailable", async () => {
  const gemini = getBundledModel("google", "gemini-2.5-flash");
  const geminiControlled = controlledSession(gemini);
  const geminiControls = new NativeAdvancedStreamControls(geminiControlled.session);
  const geminiState = geminiControls.read();
  expect(geminiState.supported).toBe(true);
  expect(geminiState.fields).toEqual({
    temperature: { supported: true, reason: expect.any(String), minimum: 0, maximum: 2 },
    topP: { supported: true, reason: expect.any(String), minimum: 0, maximum: 1 },
    maxTokens: { supported: true, reason: expect.any(String), minimum: 1, maximum: gemini.maxTokens },
  });
  expect(geminiState.outputBudgetNote).toBeUndefined();
  geminiControls.mutate(mutation(gemini, "temperature", "provider-default"));
  geminiControls.mutate(mutation(gemini, "topP", "set", 0.4));
  geminiControls.mutate(mutation(gemini, "maxTokens", "set", 256));
  await dispatch(geminiControlled.session, gemini, { cacheRetention: "short" });
  expect(geminiControlled.calls[0]!.options).toEqual({ cacheRetention: "short", temperature: undefined, topP: 0.4, maxTokens: 256 });

  const anthropic = getBundledModel("anthropic", "claude-sonnet-4-5");
  const rerouted = { ...anthropic, baseUrl: "https://controlled.invalid/v1" } satisfies Model;
  const untrustedControlled = controlledSession(rerouted, { maxTokens: 256 });
  const untrustedControls = new NativeAdvancedStreamControls(untrustedControlled.session);
  expect(untrustedControls.read().supported).toBe(false);
  expect(Object.values(untrustedControls.read().fields!).every(field => !field.supported)).toBe(true);
  const originalOptions = { maxTokens: 99, cacheRetention: "short" };
  await dispatch(untrustedControlled.session, rerouted, originalOptions);
  expect(untrustedControlled.calls[0]!.options).toBe(originalOptions);
  expectCode(() => untrustedControls.mutate(mutation(rerouted, "maxTokens", "set", 256)), "unsupported");

  const codex = getBundledModel("openai-codex", "gpt-5.4-mini");
  const codexControls = new NativeAdvancedStreamControls(controlledSession(codex).session);
  expect(codexControls.read().supported).toBe(false);
  expect(Object.values(codexControls.read().fields!).every(field => !field.supported)).toBe(true);
});
