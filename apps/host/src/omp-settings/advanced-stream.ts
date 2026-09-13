import { isDeepStrictEqual } from "node:util";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { OmpAdvancedStreamControls, OmpSessionControlMutation, OmpStreamSelection } from "@agent-desktop/shared";
import { OmpSettingsError, validateSettingValue } from "./schema";

type NativeModel = NonNullable<AgentSession["model"]>;
type Mutation = Extract<OmpSessionControlMutation, { operation: "advanced-stream" }>;
type Field = keyof OmpStreamSelection;
type FieldControls = NonNullable<OmpAdvancedStreamControls["fields"]>;
type SupportedFamily = "gemini" | "anthropic";
const ENTRY = "agent-desktop.advanced-stream.v1";
const installed = new WeakSet<AgentSession>();
const fields = ["temperature", "topP", "maxTokens"] as const satisfies readonly Field[];
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
function fieldControls(model: NativeModel, family: SupportedFamily | undefined): FieldControls {
  const outputMaximum = maximum(model);
  if (family === "gemini") return {
    temperature: { supported: true, reason: "Gemini supports an explicit sampling temperature.", minimum: 0, maximum: 2 },
    topP: { supported: true, reason: "Gemini supports an explicit Top P value.", minimum: 0, maximum: 1 },
    maxTokens: { supported: true, reason: "Gemini supports a bounded output limit.", minimum: 1, maximum: outputMaximum },
  };
  if (family === "anthropic") return {
    temperature: { supported: false, reason: "Anthropic sampling is unavailable here because support depends on the model and its effective thinking mode.", minimum: 0, maximum: 1 },
    topP: { supported: false, reason: "Anthropic sampling is unavailable here because support depends on the model, effective thinking mode, and mutually exclusive provider parameters.", minimum: 0, maximum: 1 },
    maxTokens: { supported: true, reason: "Set the requested Anthropic output budget; native request construction remains authoritative.", minimum: 1, maximum: outputMaximum },
  };
  const reason = "This field is unavailable for the current native model and endpoint.";
  return {
    temperature: { supported: false, reason, minimum: 0, maximum: 2 },
    topP: { supported: false, reason, minimum: 0, maximum: 1 },
    maxTokens: { supported: false, reason, minimum: 1, maximum: outputMaximum },
  };
}
function validate(field: Field, value: unknown, model?: NativeModel): void {
  if (value === null && field !== "maxTokens") return;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new OmpSettingsError("invalid-value", "Enter a finite numeric stream value.");
  if (field === "maxTokens") {
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
      const controls = fieldControls(model, family);
      let next = options;
      for (const field of fields) {
        if (!controls[field].supported || !Object.hasOwn(selection, field)) continue;
        validate(field, selection[field], model);
        next = { ...next, [field]: selection[field] ?? undefined };
      }
      return original(model, context, next);
    };
  }
  private selection(model: NativeModel): OmpStreamSelection {
    const branch = this.session.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index]!;
      if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
      const data: unknown = entry.data;
      if (!record(data) || !record(data.model) || typeof data.model.provider !== "string" || typeof data.model.id !== "string" || typeof data.model.api !== "string" || !record(data.selection))
        throw new OmpSettingsError("read-failed", "The native stream receipt is invalid; no selection was silently replaced.");
      if (!sameModel(data.model as { provider: string; id: string; api: string }, model)) continue;
      if (Object.keys(data.selection).some(field => !fields.includes(field as Field)))
        throw new OmpSettingsError("read-failed", "The native stream receipt contains unsupported options.");
      // A later native model-limit change must not make saved intent or the
      // revision needed to clear it unreadable. Writes and dispatch still pass
      // the current model to validation and reject an excessive request limit.
      for (const field of fields) if (Object.hasOwn(data.selection, field)) validate(field, data.selection[field]);
      return { ...data.selection } as OmpStreamSelection;
    }
    return {};
  }
  read(): OmpAdvancedStreamControls {
    const model = this.session.model;
    const family = model ? supportedFamily(model) : undefined;
    const selection = model ? this.selection(model) : {};
    const outputMaximum = model && maximum(model);
    const outputLimitConflict = selection.maxTokens !== undefined && outputMaximum !== null && outputMaximum !== undefined
      && selection.maxTokens > outputMaximum
      ? { saved: selection.maxTokens, maximum: outputMaximum } : undefined;
    return {
      // Older clients treat this flag as support for ALL three controls.
      supported: family === "gemini",
      reason: family === "gemini"
        ? "Customize sampling and the output limit for this conversation’s current Gemini model."
        : family === "anthropic"
          ? "Update your desktop to edit this Anthropic model’s output budget. Anthropic sampling is not yet integrated."
          : "These controls are available for trusted built-in Gemini and Anthropic models using their pinned provider endpoints.",
      fields: model ? fieldControls(model, family) : {
        temperature: { supported: false, reason: "No native model is selected.", minimum: 0, maximum: 2 },
        topP: { supported: false, reason: "No native model is selected.", minimum: 0, maximum: 1 },
        maxTokens: { supported: false, reason: "No native model is selected.", minimum: 1, maximum: null },
      },
      ...(family === "anthropic" ? { outputBudgetNote: ANTHROPIC_OUTPUT_BUDGET_NOTE } : {}),
      model: model ? { provider: model.provider, id: model.id, api: model.api } : null,
      selection,
      ...(outputLimitConflict ? { outputLimitConflict } : {}),
      native: { temperature: this.session.agent.temperature ?? null, topP: this.session.agent.topP ?? null, maxTokens: model?.maxTokens ?? null },
      persistence: "owning-session-branch-model-api",
    };
  }
  mutate(request: Mutation): void {
    const model = this.session.model;
    if (!model || !sameModel(request.model, model)) throw new OmpSettingsError("conflict", "The native model changed; reload before editing stream controls.");
    const family = supportedFamily(model);
    if (!family) throw new OmpSettingsError("unsupported", "Advanced stream controls are not supported for this native model/API.");
    if (!fields.includes(request.field)) throw new OmpSettingsError("invalid-value", "Unknown advanced stream field.");
    const selection = this.selection(model);
    const control = fieldControls(model, family)[request.field];
    if (request.action === "inherit") {
      if (request.value !== undefined) throw new OmpSettingsError("invalid-value", "Inherit does not accept a value.");
      delete selection[request.field];
    } else if (!control.supported) {
      throw new OmpSettingsError("unsupported", control.reason);
    } else if (request.action === "provider-default") {
      if (request.field === "maxTokens" || request.value !== undefined) throw new OmpSettingsError("invalid-value", "Only sampling controls have an explicit provider default.");
      selection[request.field] = null;
    } else if (request.action === "set") {
      validate(request.field, request.value, model);
      selection[request.field] = request.value;
    } else throw new OmpSettingsError("invalid-value", "Unknown advanced stream action.");
    this.session.sessionManager.appendCustomEntry(ENTRY, { model: { provider: model.provider, id: model.id, api: model.api }, selection });
  }
}
