import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { OmpAdvancedStreamControls, OmpSessionControlMutation, OmpStreamSelection } from "@agent-desktop/shared";
import { OmpSettingsError, validateSettingValue } from "./schema";

type NativeModel = NonNullable<AgentSession["model"]>;
type Mutation = Extract<OmpSessionControlMutation, { operation: "advanced-stream" }>;
const ENTRY = "agent-desktop.advanced-stream.v1";
const installed = new WeakSet<AgentSession>();
const fields = ["temperature", "topP", "maxTokens"] as const;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function sameModel(left: { provider: string; id: string; api: string }, right: { provider: string; id: string; api: string }) {
  return left.provider === right.provider && left.id === right.id && left.api === right.api;
}
/** Source-scoped support, not a claim that arbitrary custom endpoints accept these options. */
function supported(model: NativeModel): boolean {
  return model.transport !== "pi-native" && model.id.startsWith("gemini-")
    && (model.provider === "google" && model.api === "google-generative-ai"
      || model.provider === "google-vertex" && model.api === "google-vertex");
}
function validate(field: typeof fields[number], value: unknown, model: NativeModel): void {
  if (value === null && field !== "maxTokens") return;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new OmpSettingsError("invalid-value", "Enter a finite numeric stream value.");
  if (field === "maxTokens") {
    if (!Number.isSafeInteger(value) || value < 1 || typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens) && model.maxTokens > 0 && value > model.maxTokens)
      throw new OmpSettingsError("invalid-value", "Output limit must be a positive integer within the native model limit.");
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
      if (!supported(model)) return original(model, context, options);
      const selection = this.selection(model);
      if (!fields.some(field => Object.hasOwn(selection, field))) return original(model, context, options);
      const next = { ...options };
      for (const field of fields) {
        if (!Object.hasOwn(selection, field)) continue;
        validate(field, selection[field], model);
        next[field] = selection[field] ?? undefined;
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
      if (Object.keys(data.selection).some(field => !fields.includes(field as typeof fields[number])))
        throw new OmpSettingsError("read-failed", "The native stream receipt contains unsupported options.");
      for (const field of fields) if (Object.hasOwn(data.selection, field)) validate(field, data.selection[field], model);
      return { ...data.selection } as OmpStreamSelection;
    }
    return {};
  }
  read(): OmpAdvancedStreamControls {
    const model = this.session.model;
    const available = !!model && supported(model);
    return {
      supported: available,
      reason: available
        ? "Direct Gemini sampling and output limit. Applies only to this session branch and exact model/API; provider acceptance is not verified."
        : "This bounded section supports native Gemini models on google-generative-ai and google-vertex only. Other providers, models and stream fields remain required coverage.",
      model: model ? { provider: model.provider, id: model.id, api: model.api } : null,
      selection: model ? this.selection(model) : {},
      native: { temperature: this.session.agent.temperature ?? null, topP: this.session.agent.topP ?? null, maxTokens: model?.maxTokens ?? null },
      persistence: "owning-session-branch-model-api",
    };
  }
  mutate(request: Mutation): void {
    const model = this.session.model;
    if (!model || !sameModel(request.model, model)) throw new OmpSettingsError("conflict", "The native model changed; reload before editing stream controls.");
    if (!supported(model)) throw new OmpSettingsError("unsupported", "Advanced stream controls are not supported for this native model/API.");
    if (!fields.includes(request.field)) throw new OmpSettingsError("invalid-value", "Unknown advanced stream field.");
    const selection = this.selection(model);
    if (request.action === "inherit") {
      if (request.value !== undefined) throw new OmpSettingsError("invalid-value", "Inherit does not accept a value.");
      delete selection[request.field];
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
