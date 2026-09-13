import { isDeepStrictEqual } from "node:util";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { supportsExternalThinking } from "@oh-my-pi/pi-coding-agent/tools/think";
import type { SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { ANTHROPIC_THINKING } from "@oh-my-pi/pi-ai/stream";
import { compareRevision, parseRevision } from "@oh-my-pi/pi-catalog/identity";
import { defaultSupportedEffort } from "@oh-my-pi/pi-catalog/model-thinking";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ResolvedAnthropicCompat } from "@oh-my-pi/pi-catalog/types";
import { OMP_TOP_K_VALUES, type OmpAdvancedStreamControls, type OmpLegacyStreamField, type OmpSessionControlMutation, type OmpStreamSelection } from "@agent-desktop/shared";
import { OmpSettingsError, validateSettingValue } from "./schema";

type NativeModel = NonNullable<AgentSession["model"]>;
type Mutation = Extract<OmpSessionControlMutation, { operation: "advanced-stream" }>;
type Field = keyof OmpStreamSelection;
type FieldControls = NonNullable<OmpAdvancedStreamControls["fields"]>;
type SupportedFamily = "gemini" | "anthropic";
const ENTRY = "agent-desktop.advanced-stream.v1";
const TOP_K_ENTRY = "agent-desktop.advanced-stream.top-k.v1";
const installed = new WeakSet<AgentSession>();
const legacyFields = ["temperature", "topP", "maxTokens"] as const satisfies readonly OmpLegacyStreamField[];
const fields = [...legacyFields, "topK"] as const satisfies readonly Field[];
const ANTHROPIC_INTERLEAVED_THINKING = process.env.PI_NO_INTERLEAVED_THINKING !== "1";
const ANTHROPIC_OUTPUT_BUDGET_NOTE = "Requested max tokens is an output budget, not a hard cap: native thinking may increase it, and Anthropic OAuth may cap it at 64000.";
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function sameModel(left: { provider: string; id: string; api: string }, right: { provider: string; id: string; api: string }) {
  return left.provider === right.provider && left.id === right.id && left.api === right.api;
}
/** Native registry IDs are not provenance: models.yml can replace their endpoints.
 * Only pinned bundled identities with unchanged API/endpoint/transport establish
 * this bounded contract. Account headers and configured limits remain native.
 */
function supportedFamily(model: NativeModel): SupportedFamily | undefined {
  if (model.transport === "pi-native") return undefined;
  const bundled = getBundledModel(model.provider, model.id);
  if (!bundled || model.api !== bundled.api || model.baseUrl !== bundled.baseUrl || model.transport !== bundled.transport) return undefined;
  if ((model.provider === "google" && model.api === "google-generative-ai"
    || model.provider === "google-vertex" && model.api === "google-vertex") && bundled.identity?.class === "gemini") return "gemini";
  if (model.provider === "anthropic" && model.api === "anthropic-messages"
    && bundled.identity?.class === "anthropic" && isDeepStrictEqual(model.identity, bundled.identity)) return "anthropic";
  return undefined;
}
function maximum(model: NativeModel): number | null {
  return typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : null;
}
/** Mirrors only the pinned mapper/builder's sampling gate, never its request.
 * stream.ts:1925-1939,2021-2115; anthropic.ts:3952-4005,4082-4094.
 * The SDK still owns reasoning normalization, budget expansion and wire output.
 */
function anthropicSamplingReason(model: NativeModel, options: SimpleStreamOptions | undefined): string | undefined {
  const bundled = getBundledModel<"anthropic-messages">(model.provider, model.id);
  if (model.api !== "anthropic-messages" || bundled?.api !== "anthropic-messages")
    return "Sampling is unavailable for this native API.";
  // Model<Api> is generic rather than a discriminated union; the API is checked above.
  const compat = model.compat as ResolvedAnthropicCompat;
  if (!bundled.compat.supportsSamplingParams || !compat.supportsSamplingParams)
    return "The pinned native model compatibility suppresses sampling parameters.";
  if (model.requestModelId !== bundled.requestModelId || !isDeepStrictEqual(model.thinking?.effortRouting, bundled.thinking?.effortRouting))
    return "Sampling is unavailable because this model's wire identity differs from the pinned built-in model.";
  // Prefix binding materializes adaptive thinking even on the omitted/off path.
  if (model.thinking?.mode === "anthropic-adaptive" && model.thinking.prefixBinding && compat.supportsThinkingBindingControls)
    return "Native prefix binding requires adaptive thinking and suppresses sampling.";
  if (!model.reasoning) return undefined;
  if (compat.requiresThinkingEnabled) return "Native compatibility requires thinking; sampling parameters are suppressed.";
  let reasoning = options?.reasoning;
  let disabled = options?.disableReasoning || options?.forceReasoningOff;
  if (model.thinking?.requiresEffort && !model.thinking.suppressWhenOff && (!reasoning || disabled)) {
    const floor = defaultSupportedEffort(model);
    if (floor !== undefined) { reasoning = floor; disabled = false; }
  }
  let thinking = !!reasoning && !disabled && !((options?.thinkingBudgets?.[reasoning] ?? ANTHROPIC_THINKING[reasoning]) <= 0);
  // With interleaving disabled the mapper can exhaust a lowered native ceiling
  // and turn thinking off. Use the same arithmetic, without changing its budget.
  if (thinking && !ANTHROPIC_INTERLEAVED_THINKING && model.thinking?.mode !== "anthropic-adaptive") {
    const budget = options?.thinkingBudgets?.[reasoning!] ?? ANTHROPIC_THINKING[reasoning!];
    const base = options?.maxTokens ?? model.maxTokens ?? undefined;
    const total = Math.min(base === undefined ? 64000 : base + budget, model.maxTokens ?? Infinity);
    if (total <= budget && total <= 1024) thinking = false;
  }
  return thinking ? "The effective native request uses thinking and suppresses sampling. Change thinking only if appropriate for your task; saved sampling stays retained." : undefined;
}

function exclusiveAnthropicSampling(model: NativeModel): boolean {
  // Provider restriction, absent from native compat: Opus 4.1 and the 4.5+
  // generation accept temperature OR top_p. Use trusted baked revisions, not IDs.
  // Sources and the earlier models' different contract are recorded in README.
  const revision = model.identity?.revision && parseRevision(model.identity.revision);
  return !!revision && compareRevision(revision, [4, 1, 0]) >= 0;
}

function samplingConflict(model: NativeModel, selection: OmpStreamSelection, options?: SimpleStreamOptions): string | undefined {
  const temperature = selection.temperature === undefined ? options?.temperature : selection.temperature;
  const topP = selection.topP === undefined ? options?.topP : selection.topP;
  if (temperature != null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 1))
    return "Anthropic temperature must be between 0 and 1. Replace the saved value, choose Provider default (omit), or follow a valid native baseline.";
  if (topP != null && (!Number.isFinite(topP) || topP < 0 || topP > 1))
    return "Anthropic Top P must be between 0 and 1. Replace the saved value, choose Provider default (omit), or follow a valid native baseline.";
  if (exclusiveAnthropicSampling(model) && temperature != null && topP != null)
    return "This model accepts Temperature or Top P, not both, including native baseline values. Choose Provider default (omit) for one field and save it before setting the other. Follow native session can restore a conflicting baseline; no other saved setting was changed.";
}
function topKControl(model: NativeModel, family: SupportedFamily | undefined): NonNullable<FieldControls["topK"]> {
  const bounds = { minimum: 1, maximum: null };
  if (family !== "gemini") return { ...bounds, supported: false, reason: "Top K is unavailable for the current native model and endpoint." };
  const bundled = getBundledModel(model.provider, model.id);
  if (model.requestModelId !== bundled?.requestModelId || !isDeepStrictEqual(model.identity, bundled?.identity))
    return { ...bounds, supported: false, reason: "Top K is unavailable because this model's wire identity differs from the built-in model." };
  if (model.api === "google-vertex") return { ...bounds, supported: false,
    reason: model.id === "gemini-2.5-flash" || model.id === "gemini-2.5-pro"
      ? "Vertex publishes a fixed Top K of 64 for this model; it is not an adjustable sampling control."
      : "This Vertex model has no verified adjustable Top K capability." };
  if (typeof model.topK === "number" && Number.isSafeInteger(model.topK) && model.topK > 0)
    return { ...bounds, supported: true, reason: `Google's native model discovery reports Top K sampling with a default of ${model.topK}. This default is not a maximum.` };
  return { ...bounds, supported: false, reason: model.topK === undefined
    ? "Native model discovery has not reported Top K support. Select this model again in Session settings to refresh its metadata."
    : "Google's model metadata does not advertise adjustable Top K sampling for this model." };
}
function fieldControls(model: NativeModel, family: SupportedFamily | undefined, options?: SimpleStreamOptions, includeTopK = false): FieldControls {
  const outputMaximum = maximum(model);
  const topK = includeTopK ? { topK: topKControl(model, family) } : {};
  if (family === "gemini") return {
    temperature: { supported: true, reason: "Gemini supports an explicit sampling temperature.", minimum: 0, maximum: 2 },
    topP: { supported: true, reason: "Gemini supports an explicit Top P value.", minimum: 0, maximum: 1 },
    maxTokens: { supported: true, reason: "Gemini supports a bounded output limit.", minimum: 1, maximum: outputMaximum },
    ...topK,
  };
  if (family === "anthropic") {
    const reason = anthropicSamplingReason(model, options);
    return {
      temperature: { supported: !reason, reason: reason ?? "The pinned native request accepts temperature for this effective thinking configuration.", minimum: 0, maximum: 1 },
      topP: { supported: !reason, reason: reason ?? "The pinned native request accepts Top P for this effective thinking configuration.", minimum: 0, maximum: 1 },
      maxTokens: { supported: true, reason: "Set the requested Anthropic output budget; native request construction remains authoritative.", minimum: 1, maximum: outputMaximum },
      ...topK,
    };
  }
  const reason = "This field is unavailable for the current native model and endpoint.";
  return {
    temperature: { supported: false, reason, minimum: 0, maximum: 2 },
    topP: { supported: false, reason, minimum: 0, maximum: 1 },
    maxTokens: { supported: false, reason, minimum: 1, maximum: outputMaximum },
    ...topK,
  };
}
function validate(field: Field, value: unknown, model?: NativeModel): void {
  if (value === null && field !== "maxTokens") return;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new OmpSettingsError("invalid-value", "Enter a finite numeric stream value.");
  if (field === "topK") {
    if (!Number.isSafeInteger(value) || !OMP_TOP_K_VALUES.includes(value as typeof OMP_TOP_K_VALUES[number]))
      throw new OmpSettingsError("invalid-value", "Top K must be one of the pinned native values: 1, 20, 40, or 100.");
  } else if (field === "maxTokens") {
    if (!Number.isSafeInteger(value) || value < 1) throw new OmpSettingsError("invalid-value", "Output limit must be a positive integer.");
    const outputMaximum = model && maximum(model);
    if (outputMaximum !== null && outputMaximum !== undefined && value > outputMaximum)
      throw new OmpSettingsError("invalid-value", "Output limit exceeds the current native model limit; change it or follow the native session.");
  } else {
    validateSettingValue(field, value);
    if (value < 0 || value > (field === "temperature" ? 2 : 1))
      throw new OmpSettingsError("invalid-value", field === "temperature" ? "Temperature must be between 0 and 2." : "Top P must be between 0 and 1.");
  }
}

/** One wrapper on the owning AgentSession, around (never instead of) its SDK stream chain.
 * Agent has sampling setters but no maxTokens setter; global setters would also leak
 * model-bound intent into retry/fallback models. Read the current native branch at
 * dispatch so native branch/reload operations cannot leave cached selections active.
 * Native disposal fences future requests and a reopened worker owns a fresh Agent.
 */
export class NativeAdvancedStreamControls {
  constructor(private session: AgentSession) {
    if (installed.has(session)) throw new Error("Advanced stream controls already own this native session.");
    installed.add(session);
    const original = session.agent.streamFn;
    session.agent.streamFn = (model, context, options) => {
      const family = supportedFamily(model);
      if (!family) return original(model, context, options);
      const selection = this.selection(model);
      const effective = family === "anthropic" ? this.effectiveOptions(model, options, selection) : options;
      const controls = fieldControls(model, family, effective, family === "gemini" || Object.hasOwn(selection, "topK"));
      if (family === "anthropic" && controls.temperature.supported) {
        const conflict = samplingConflict(model, selection, effective);
        if (conflict) throw new OmpSettingsError("invalid-value", conflict);
      }
      let next = options;
      for (const field of fields) {
        if (!controls[field]?.supported || !Object.hasOwn(selection, field)) continue;
        validate(field, selection[field], model);
        if (!next || next === options) next = { ...options };
        next[field] = selection[field] ?? undefined;
      }
      return original(model, context, next);
    };
  }
  private effectiveOptions(model: NativeModel, options?: SimpleStreamOptions, selection?: OmpStreamSelection): SimpleStreamOptions | undefined {
    if (selection?.maxTokens !== undefined) options = { ...options, maxTokens: selection.maxTokens };
    // This flag is added by the original SDK wrapper AFTER ours. Observe its
    // exact native eligibility without modifying or replacing that wrapper.
    const external = this.session.settings.get("externalThinking")
      && this.session.agent.state.tools.some(tool => tool.name === "think") && supportsExternalThinking(model);
    return external ? { ...options, forceReasoningOff: true } : options;
  }
  private baselineOptions(model: NativeModel, selection: OmpStreamSelection): SimpleStreamOptions | undefined {
    const agent = this.session.agent;
    return this.effectiveOptions(model, { reasoning: agent.state.thinkingLevel, disableReasoning: agent.state.disableReasoning,
      thinkingBudgets: agent.thinkingBudgets, temperature: agent.temperature, topP: agent.topP, topK: agent.topK }, selection);
  }
  private legacySelection(model: NativeModel): OmpStreamSelection {
    const branch = this.session.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index]!;
      if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
      const data: unknown = entry.data;
      if (!record(data) || !record(data.model) || typeof data.model.provider !== "string" || typeof data.model.id !== "string" || typeof data.model.api !== "string" || !record(data.selection))
        throw new OmpSettingsError("read-failed", "The native stream receipt is invalid; no selection was silently replaced.");
      if (!sameModel(data.model as { provider: string; id: string; api: string }, model)) continue;
      if (Object.keys(data.selection).some(field => !legacyFields.includes(field as OmpLegacyStreamField)))
        throw new OmpSettingsError("read-failed", "The native stream receipt contains unsupported options.");
      // A later native model-limit change must not make saved intent or the
      // revision needed to clear it unreadable. Writes and dispatch still pass
      // the current model to validation and reject an excessive request limit.
      for (const field of legacyFields) if (Object.hasOwn(data.selection, field)) validate(field, data.selection[field]);
      return { ...data.selection } as OmpStreamSelection;
    }
    return {};
  }
  private topKSelection(model: NativeModel): Pick<OmpStreamSelection, "topK"> {
    const branch = this.session.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index]!;
      if (entry.type !== "custom" || entry.customType !== TOP_K_ENTRY) continue;
      const data: unknown = entry.data;
      if (!record(data) || !record(data.model) || typeof data.model.provider !== "string" || typeof data.model.id !== "string" || typeof data.model.api !== "string" || !record(data.selection))
        throw new OmpSettingsError("read-failed", "The native Top K receipt is invalid; no selection was silently replaced.");
      if (!sameModel(data.model as { provider: string; id: string; api: string }, model)) continue;
      if (Object.keys(data.selection).some(field => field !== "topK"))
        throw new OmpSettingsError("read-failed", "The native Top K receipt contains unsupported options.");
      if (Object.hasOwn(data.selection, "topK")) validate("topK", data.selection.topK);
      return { ...data.selection } as Pick<OmpStreamSelection, "topK">;
    }
    return {};
  }
  private selection(model: NativeModel): OmpStreamSelection {
    return { ...this.legacySelection(model), ...this.topKSelection(model) };
  }
  read(): OmpAdvancedStreamControls {
    const model = this.session.model;
    const family = model ? supportedFamily(model) : undefined;
    const selection = model ? this.selection(model) : {};
    const outputMaximum = model && maximum(model);
    const outputLimitConflict = selection.maxTokens !== undefined && outputMaximum !== null && outputMaximum !== undefined
      && selection.maxTokens > outputMaximum
      ? { saved: selection.maxTokens, maximum: outputMaximum } : undefined;
    const options = model && family === "anthropic" ? this.baselineOptions(model, selection) : undefined;
    const controls = model && fieldControls(model, family, options, family === "gemini" || Object.hasOwn(selection, "topK"));
    const conflict = model && family === "anthropic" && controls?.temperature.supported ? samplingConflict(model, selection, options) : undefined;
    return {
      // Older clients treat this flag as support for ALL three controls.
      supported: family === "gemini",
      reason: family === "gemini"
        ? "Customize sampling and the output limit for this conversation’s current Gemini model."
        : family === "anthropic"
          ? "Update your desktop to edit Anthropic fields individually; availability depends on the pinned model and effective native thinking."
          : "These controls are available for trusted built-in Gemini and Anthropic models using their pinned provider endpoints.",
      fields: controls ?? {
        temperature: { supported: false, reason: "No native model is selected.", minimum: 0, maximum: 2 },
        topP: { supported: false, reason: "No native model is selected.", minimum: 0, maximum: 1 },
        maxTokens: { supported: false, reason: "No native model is selected.", minimum: 1, maximum: null },
      },
      ...(family === "anthropic" ? { outputBudgetNote: ANTHROPIC_OUTPUT_BUDGET_NOTE } : {}),
      ...(family === "anthropic" && model && controls?.temperature.supported && exclusiveAnthropicSampling(model) ? { samplingConstraint: "Use Temperature or Top P, not both. To switch, explicitly save Provider default (omit) for the other field first, including when it follows a native baseline." } : {}),
      ...(conflict ? { samplingConflict: conflict } : {}),
      model: model ? { provider: model.provider, id: model.id, api: model.api } : null,
      selection,
      ...(outputLimitConflict ? { outputLimitConflict } : {}),
      native: { temperature: this.session.agent.temperature ?? null, topP: this.session.agent.topP ?? null, maxTokens: model?.maxTokens ?? null, topK: this.session.agent.topK ?? null },
      persistence: "owning-session-branch-model-api",
    };
  }
  mutate(request: Mutation): void {
    const model = this.session.model;
    if (!model || !sameModel(request.model, model)) throw new OmpSettingsError("conflict", "The native model changed; reload before editing stream controls.");
    const family = supportedFamily(model);
    if (!fields.includes(request.field)) throw new OmpSettingsError("invalid-value", "Unknown advanced stream field.");
    const selection = this.selection(model);
    const options = family === "anthropic" ? this.baselineOptions(model, selection) : undefined;
    const control = fieldControls(model, family, options, family === "gemini" || Object.hasOwn(selection, "topK"))[request.field];
    if (request.field === "topK" && !control)
      throw new OmpSettingsError("unsupported", "The current native model does not advertise a Top K control.");
    if (request.action === "inherit") {
      if (request.value !== undefined) throw new OmpSettingsError("invalid-value", "Inherit does not accept a value.");
      delete selection[request.field];
    } else if (!control?.supported) {
      throw new OmpSettingsError("unsupported", control?.reason ?? "This field is unavailable for the current native model and endpoint.");
    } else if (request.action === "provider-default") {
      if (request.field === "maxTokens" || request.value !== undefined) throw new OmpSettingsError("invalid-value", "Only sampling controls have an explicit provider default.");
      selection[request.field] = null;
    } else if (request.action === "set") {
      validate(request.field, request.value, model);
      selection[request.field] = request.value;
    } else throw new OmpSettingsError("invalid-value", "Unknown advanced stream action.");
    // Clearing a field always remains possible, even on an untrusted endpoint
    // or while a different retained field needs recovery. Never rewrite it.
    if (family === "anthropic" && control?.supported && request.field !== "maxTokens" && request.action !== "inherit") {
      const conflict = samplingConflict(model, selection, options);
      if (conflict) throw new OmpSettingsError("invalid-value", conflict);
    }
    const modelReceipt = { provider: model.provider, id: model.id, api: model.api };
    if (request.field === "topK") {
      const topK = Object.hasOwn(selection, "topK") ? { topK: selection.topK } : {};
      this.session.sessionManager.appendCustomEntry(TOP_K_ENTRY, { model: modelReceipt, selection: topK });
    } else {
      const legacy = Object.fromEntries(legacyFields.filter(field => Object.hasOwn(selection, field)).map(field => [field, selection[field]]));
      this.session.sessionManager.appendCustomEntry(ENTRY, { model: modelReceipt, selection: legacy });
    }
  }
}
