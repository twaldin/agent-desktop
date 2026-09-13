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
  const agent = { streamFn: original, temperature: 0.35 as number | undefined, topP: 0.8 as number | undefined,
    state: { thinkingLevel: "high" as "high" | undefined, disableReasoning: false, tools: [] as Array<{ name: string }> },
    thinkingBudgets: undefined as { high?: number } | undefined };
  const settings = { externalThinking: false, get: () => settings.externalThinking };
  const session = {
    get model() { return model; },
    agent,
    settings,
    sessionManager: {
      getBranch: () => branch,
      appendCustomEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
    },
  } as unknown as AgentSession;
  return { session, agent, settings, branch, calls, setModel: (next: Model) => { model = next; } };
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

test("thinking-enabled Anthropic retains unsupported sampling while applying the output budget", async () => {
  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  const controlled = controlledSession(model, { temperature: 0.2, topP: 0.7, maxTokens: 2048 });
  const controls = new NativeAdvancedStreamControls(controlled.session);

  const state = controls.read();
  expect(state.supported).toBe(false); // Older clients must not offer all three fields.
  expect(state.fields!.temperature.supported).toBe(false);
  expect(state.fields!.topP.supported).toBe(false);
  expect(state.fields!.maxTokens.supported).toBe(true);
  expect(state.samplingConstraint).toBeUndefined();
  expect(state.selection).toEqual({ temperature: 0.2, topP: 0.7, maxTokens: 2048 });

  const nativeOptions = { reasoning: "high", temperature: 0.55, topP: 0.66, cacheRetention: "short", maxRetryDelayMs: 1234 };
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
  expectCode(() => dispatch(controlled.session, lowered, { reasoning: "high", cacheRetention: "short" }), "invalid-value");
  expect(controlled.calls).toHaveLength(0);
  expectCode(() => controls.mutate(mutation(lowered, "maxTokens", "set", 512)), "invalid-value");

  controls.mutate(mutation(lowered, "maxTokens", "inherit"));
  const recovered = controls.read();
  expect(recovered.outputLimitConflict).toBeUndefined();
  expect(recovered.selection).toEqual({ temperature: 0.2 });
  await dispatch(controlled.session, lowered, { reasoning: "high", cacheRetention: "short" });
  expect(controlled.calls[0]!.options).toEqual({ reasoning: "high", cacheRetention: "short" });
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

test("Anthropic sampling off uses explicit omission to switch parameters without rewriting saved intent", async () => {
  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  const native = controlledSession(model);
  native.agent.state.disableReasoning = true;
  const controls = new NativeAdvancedStreamControls(native.session);
  expect(controls.read().fields!.temperature.supported).toBe(true);
  expect(controls.read().fields!.temperature.maximum).toBe(1);
  expect(controls.read().samplingConstraint).toContain("Use Temperature or Top P, not both.");
  expect(controls.read().samplingConflict).toBeDefined(); // Both native baselines are numeric.
  expectCode(() => controls.mutate(mutation(model, "temperature", "set", 0)), "invalid-value");
  expect(native.branch).toHaveLength(0);
  controls.mutate(mutation(model, "topP", "provider-default"));
  controls.mutate(mutation(model, "temperature", "set", 0));
  const before = controls.read().selection;
  expectCode(() => controls.mutate(mutation(model, "topP", "set", 0.9)), "invalid-value");
  expect(controls.read().selection).toEqual(before);
  await dispatch(native.session, model, { reasoning: "high", disableReasoning: true, temperature: 0.35, topP: 0.8, cacheRetention: "short" });
  expect(native.calls.at(-1)!.options).toEqual({ reasoning: "high", disableReasoning: true, temperature: 0, topP: undefined, cacheRetention: "short" });
  expectCode(() => controls.mutate(mutation(model, "temperature", "set", 1.01)), "invalid-value");
  controls.mutate(mutation(model, "temperature", "provider-default"));
  controls.mutate(mutation(model, "topP", "set", 1));
  expect(controls.read().selection).toEqual({ temperature: null, topP: 1 });
  await dispatch(native.session, model, { forceReasoningOff: true, reasoning: "high", temperature: 0.35 });
  expect(native.calls.at(-1)!.options?.topP).toBe(1);
  expect(native.calls.at(-1)!.options?.temperature).toBeUndefined();
});

test("request reasoning, not the last displayed selector, governs sampling application", async () => {
  const model = getBundledModel("anthropic", "claude-haiku-4-5");
  const native = controlledSession(model, { temperature: 0.2, topP: null });
  native.agent.state.disableReasoning = true;
  const controls = new NativeAdvancedStreamControls(native.session);
  expect(controls.read().fields!.temperature.supported).toBe(true);
  await dispatch(native.session, model, { reasoning: "high", temperature: 0.7 });
  expect(native.calls.at(-1)!.options?.temperature).toBe(0.7); // Saved value is not applied.
  await dispatch(native.session, model, { reasoning: "high", thinkingBudgets: { high: 0 }, temperature: 0.7 });
  expect(native.calls.at(-1)!.options?.temperature).toBe(0.2);
  native.agent.state.disableReasoning = false;
  expect(controls.read().fields!.temperature.supported).toBe(false);
  expect(controls.read().selection).toEqual({ temperature: 0.2, topP: null });
  controls.mutate(mutation(model, "temperature", "inherit"));
  expect(controls.read().selection).toEqual({ topP: null });
});

test("adaptive and mandatory thinking follow native normalization without broadening compatibility", async () => {
  const adaptive = getBundledModel("anthropic", "claude-opus-4-6");
  const native = controlledSession(adaptive, { temperature: 0.2, topP: null });
  const controls = new NativeAdvancedStreamControls(native.session);
  expect(controls.read().fields!.temperature.supported).toBe(false);
  native.agent.state.disableReasoning = true;
  expect(controls.read().fields!.temperature.supported).toBe(true); // Native 4.6 off omits thinking.
  await dispatch(native.session, adaptive, { reasoning: "high", disableReasoning: true });
  expect(native.calls.at(-1)!.options?.temperature).toBe(0.2);
  const mandatory = { ...adaptive, thinking: { ...adaptive.thinking!, requiresEffort: true } };
  native.setModel(mandatory);
  expect(controls.read().fields!.temperature.supported).toBe(false);
  await dispatch(native.session, mandatory, { reasoning: "high", disableReasoning: true, forceReasoningOff: true });
  expect(native.calls.at(-1)!.options?.temperature).toBeUndefined();
  expect(native.calls.at(-1)!.options?.disableReasoning).toBe(true); // App does not normalize native inputs.
  const later = getBundledModel("anthropic", "claude-opus-4-8");
  native.setModel(later);
  expect(controls.read().fields!.temperature.supported).toBe(false);
  expectCode(() => controls.mutate(mutation(later, "temperature", "set", 0.2)), "unsupported");
  const forgedCompat = { ...later, compat: { ...later.compat, supportsSamplingParams: true } } as Model;
  native.setModel(forgedCompat);
  expect(controls.read().fields!.temperature.supported).toBe(false);
});

test("retained conflicts remain readable and recover field by field without sending contradictory options", async () => {
  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  const native = controlledSession(model, { temperature: 1.5, topP: 0.7, maxTokens: 256 });
  native.agent.state.disableReasoning = true;
  const controls = new NativeAdvancedStreamControls(native.session);
  expect(controls.read().selection.temperature).toBe(1.5);
  expect(controls.read().samplingConflict).toBeDefined();
  expectCode(() => dispatch(native.session, model, {}), "invalid-value");
  expect(native.calls).toHaveLength(0);
  controls.mutate(mutation(model, "maxTokens", "set", 512)); // Other fields can recover independently.
  controls.mutate(mutation(model, "temperature", "inherit"));
  expect(controls.read().selection).toEqual({ topP: 0.7, maxTokens: 512 });
  expect(controls.read().samplingConflict).toBeDefined(); // Native temperature remains.
  expectCode(() => dispatch(native.session, model, { temperature: 0.35 }), "invalid-value");
  controls.mutate(mutation(model, "temperature", "provider-default"));
  expect(controls.read().samplingConflict).toBeUndefined();
  await dispatch(native.session, model, { temperature: 0.35 });
  expect(native.calls.at(-1)!.options).toEqual({ temperature: undefined, topP: 0.7, maxTokens: 512 });
});

test("earlier native Anthropic identities retain their two-parameter contract", async () => {
  const model = getBundledModel("anthropic", "claude-3-haiku-20240307");
  const native = controlledSession(model);
  const controls = new NativeAdvancedStreamControls(native.session);
  controls.mutate(mutation(model, "temperature", "set", 1));
  controls.mutate(mutation(model, "topP", "set", 0));
  await dispatch(native.session, model, {});
  expect(native.calls.at(-1)!.options).toEqual({ temperature: 1, topP: 0 });
});

test("untrusted identity and endpoint changes retain but never apply sampling, and allow explicit clearing", async () => {
  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  const native = controlledSession(model, { temperature: 0.2, topP: null });
  native.agent.state.disableReasoning = true;
  const controls = new NativeAdvancedStreamControls(native.session);
  const rerouted = { ...model, baseUrl: "https://untrusted.invalid" };
  native.setModel(rerouted);
  expect(controls.read().selection).toEqual({ temperature: 0.2, topP: null });
  await dispatch(native.session, rerouted, { temperature: 0.5 });
  expect(native.calls.at(-1)!.options).toEqual({ temperature: 0.5 });
  expectCode(() => controls.mutate(mutation(rerouted, "temperature", "set", 0.4)), "unsupported");
  controls.mutate(mutation(rerouted, "temperature", "inherit"));
  expect(controls.read().selection).toEqual({ topP: null });
  native.setModel({ ...model, identity: { ...model.identity!, revision: "3.5.0" } } as Model);
  expect(controls.read().fields!.temperature.supported).toBe(false);
  native.setModel({ ...model, requestModelId: "untrusted-wire-model" });
  expect(controls.read().fields!.temperature.supported).toBe(false);
  native.setModel(model);
  expect(controls.read().fields!.temperature.supported).toBe(true);
});

test("sampling receipts follow the current journal branch and model rather than wrapper caches", async () => {
  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  const other = getBundledModel("anthropic", "claude-haiku-4-5");
  const native = controlledSession(model, { temperature: 0.2, topP: null });
  native.agent.state.disableReasoning = true;
  const controls = new NativeAdvancedStreamControls(native.session);
  const fork = native.branch.slice();
  controls.mutate(mutation(model, "temperature", "set", 0.4));
  native.setModel(other);
  expect(controls.read().selection).toEqual({});
  native.setModel(model);
  expect(controls.read().selection.temperature).toBe(0.4);
  native.branch.splice(0, native.branch.length, ...fork);
  await dispatch(native.session, model, {});
  expect(native.calls.at(-1)!.options?.temperature).toBe(0.2);
});

test("external thinking eligibility observes the original SDK's native tool and compatibility gates", async () => {
  const model = getBundledModel("anthropic", "claude-sonnet-4-5");
  const native = controlledSession(model, { temperature: 0.2, topP: null });
  const controls = new NativeAdvancedStreamControls(native.session);
  native.settings.externalThinking = true;
  expect(controls.read().fields!.temperature.supported).toBe(false); // No think tool.
  native.agent.state.tools.push({ name: "think" });
  expect(controls.read().fields!.temperature.supported).toBe(true);
  await dispatch(native.session, model, { reasoning: "high" });
  expect(native.calls.at(-1)!.options?.temperature).toBe(0.2);
  expect(native.calls.at(-1)!.options?.forceReasoningOff).toBeUndefined(); // Only the original SDK adds it.
  const mandatory = { ...model, thinking: { ...model.thinking!, requiresEffort: true } };
  native.setModel(mandatory);
  expect(controls.read().fields!.temperature.supported).toBe(false);
  const required = { ...model, compat: { ...model.compat, requiresThinkingEnabled: true } } as Model;
  native.setModel(required); native.agent.state.disableReasoning = true;
  expect(controls.read().fields!.temperature.supported).toBe(false);
});

test("API, transport and unlisted identities cannot acquire sampling support from a familiar name", async () => {
  const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
  const variants = [
    { ...bundled, api: "openai-completions" } as Model,
    { ...bundled, transport: "pi-native" } as Model,
    { ...bundled, id: "claude-sonnet-private" },
  ];
  for (const model of variants) {
    const native = controlledSession(model, { temperature: 0.2, topP: null });
    const controls = new NativeAdvancedStreamControls(native.session);
    expect(controls.read().fields!.temperature.supported).toBe(false);
    expectCode(() => controls.mutate(mutation(model, "temperature", "set", 0.4)), "unsupported");
    await dispatch(native.session, model, { temperature: 0.8 });
    expect(native.calls.at(-1)!.options).toEqual({ temperature: 0.8 });
    controls.mutate(mutation(model, "temperature", "inherit"));
    expect(controls.read().selection).toEqual({ topP: null });
  }
});
