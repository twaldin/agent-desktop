import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { OmpApprovalMode, OmpModelCapabilities, OmpSessionControls, OmpSessionControlMutation, SettingJson } from "@agent-desktop/shared";
import { approvalMode } from "../approval";
import { isCredential } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { SERVICE_TIER_OPENAI_VALUES, SERVICE_TIER_ANTHROPIC_VALUES, SERVICE_TIER_GOOGLE_VALUES, isServiceTierFamily, isServiceTierForFamily } from "@oh-my-pi/pi-coding-agent/config/service-tier";
import { parseCliThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";
import { OmpSettingsError, requireSetting, settingPaths, validateSettingValue } from "./schema";
import { settingStates } from "./store";
import { publicModelCompatibility } from "./model-definitions";
type NativeModel = NonNullable<AgentSession["model"]>;

const PUBLIC_MODEL_FIELDS = [
  "requiresGlyphTokenization", "requiresCursorToolSchemaProjection", "requestModelId", "reasoningMode", "tokenizer", "imageInputDecoder",
  "supportsComputerUseConfig", "gitlabDuoWorkflowRootNamespaceId", "cursorMaxMode", "premiumMultiplier", "omitMaxOutputTokens",
  "transport", "preferWebsockets", "useResponsesLite", "toolMode", "contextPromotionTarget", "compactionModel", "priority",
  "description", "isNew", "isBeta", "isRecommended", "int", "tps", "applyPatchToolType", "isOAuth", "guardrailIdentifier", "guardrailVersion", "guardrailTrace",
] as const;
// Structural dictionaries such as extraBody/requestMetadata/headers can contain
// user secrets. Only known flat protocol capability fields are projected.
const PUBLIC_COMPAT_FIELDS = new Set([
  "supportsStore", "supportsDeveloperRole", "supportsMultipleSystemMessages", "supportsReasoningEffort", "supportsUsageInStreaming",
  "maxTokensField", "requiresToolResultName", "requiresAssistantAfterToolResult", "requiresThinkingAsText", "requiresMistralToolIds",
  "thinkingFormat", "kimiApiFormat", "reasoningDisableMode", "omitReasoningEffort", "includeEncryptedReasoning", "filterReasoningHistory", "thinkingKeep",
  "reasoningContentField", "requiresReasoningContentForToolCalls", "requiresReasoningContentForAllAssistantTurns", "allowsSyntheticReasoningContentForToolCalls",
  "replayReasoningContent", "qwenPreserveThinking", "qwenTemplateReasoningEffort", "requiresAssistantContentForToolCalls", "supportsToolChoice",
  "supportsForcedToolChoice", "supportsNamedToolChoice", "disableReasoningOnForcedToolChoice", "disableReasoningOnToolChoice", "wireModelIdMode",
  "promptCacheSessionHeader", "cacheControlFormat", "supportsPromptCacheBreakpoints", "promptCacheBreakpointTtl", "supportsStrictMode", "toolSchemaFlavor",
  "streamFirstEventTimeoutMs", "streamIdleTimeoutMs", "supportsLongPromptCacheRetention", "toolStrictMode", "supportsReasoningParams", "supportsReasoningSummary",
  "supportsSamplingParams", "supportsPenaltyAndStopParams", "alwaysSendMaxTokens", "strictResponsesPairing", "supportsImageDetailOriginal", "reasoningDeltasMayBeCumulative",
  "stripDeepseekSpecialTokens", "streamMarkupHealingPattern", "emptyLengthFinishIsContextError", "usesOpenAIToolCallIdLimit", "nativeKimiK3Reasoning",
  "zaiReasoningEffortDialect", "clampOutputToModelMax", "stripImageInput", "thinkingLoopGuard", "supportsContextManagement", "supportsOutputEffort",
  "disableStrictTools", "disableAdaptiveThinking", "supportsEagerToolInputStreaming", "supportsLongCacheRetention", "supportsMidConversationSystem",
  "supportsTurnScopedSystem", "supportsMidConversationToolChanges", "supportsPerMessageEffort", "supportsThinkingBindingControls", "requiresToolResultId",
  "allowAnthropicHeaderOverrides", "replayUnsignedThinking", "requiresThinkingEnabled", "escapeBuiltinToolNames", "injectClaudeCodeInstruction",
  "officialEndpoint", "promptCacheMode", "supportsCacheControl", "supportsCachePoint", "toolSearch",
]);
function scalar(value: unknown): value is null | string | number | boolean {
  return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
}
function numbers(value: object | undefined, keys: string[]): Record<string, number> {
  return Object.fromEntries(Object.entries(value ?? {}).filter((entry): entry is [string, number] => keys.includes(entry[0]) && typeof entry[1] === "number" && Number.isFinite(entry[1])));
}
export function modelCapabilities(model: NativeModel): OmpModelCapabilities {
  const capabilities: Record<string, SettingJson> = {};
  capabilities.identity = Object.fromEntries(Object.entries(model.identity ?? {}).filter(([key, value]) => ["class", "family", "revision", "effort", "thinkingVariant", "logicalId"].includes(key) && scalar(value))) as Record<string, SettingJson>;
  for (const key of PUBLIC_MODEL_FIELDS) { const value = model[key]; if (scalar(value)) capabilities[key] = value; }
  const costKeys = ["input", "output", "cacheRead", "cacheWrite"];
  capabilities.cost = numbers(model.cost, costKeys);
  if (model.cost.longContext) capabilities.longContextCost = { ...numbers(model.cost.longContext, [...costKeys, "inputThreshold"]), inputThresholdInclusive: model.cost.longContext.inputThresholdInclusive ?? false };
  if (model.serviceTierCost) capabilities.serviceTierCost = numbers(model.serviceTierCost, ["flex", "priority"]);
  if (model.remoteCompaction) {
    capabilities.remoteCompaction = Object.fromEntries(Object.entries(model.remoteCompaction).filter(([key, value]) => ["enabled", "api", "v2StreamingEnabled", "model"].includes(key) && scalar(value))) as Record<string, SettingJson>;
    capabilities.remoteCompactionEndpointsConfigured = !!(model.remoteCompaction.endpoint || model.remoteCompaction.v2Endpoint || model.remoteCompaction.streamingEndpoint);
  }
  const compatibility = { ...publicModelCompatibility(model.compat), ...Object.fromEntries(Object.entries(model.compat ?? {}).filter(([key, value]) => PUBLIC_COMPAT_FIELDS.has(key) && scalar(value))) } as Record<string, SettingJson>;
  const projected = new Set<string>([...PUBLIC_MODEL_FIELDS, "identity", "provider", "id", "api", "name", "contextWindow", "maxTokens", "input", "reasoning", "thinking", "supportsTools", "supportsComputerUse", "cost", "serviceTierCost", "remoteCompaction", "compat"]);
  const excluded = ["headers", "baseUrl", "requestMetadata", "compat.extraBody", "compat.signingEndpoint", "compatConfig", "remoteCompaction.endpoint", "remoteCompaction.v2Endpoint", "remoteCompaction.streamingEndpoint"];
  return { provider: model.provider, id: model.id, api: model.api, name: model.name,
    contextWindow: model.contextWindow, maxTokens: model.maxTokens, input: [...model.input], reasoning: model.reasoning,
    thinkingSelectors: model.reasoning ? ["auto", "off", ...(model.thinking?.efforts ?? [])] : ["off"],
    serviceTierOptions: { openai: [...SERVICE_TIER_OPENAI_VALUES], anthropic: [...SERVICE_TIER_ANTHROPIC_VALUES], google: [...SERVICE_TIER_GOOGLE_VALUES] },
    ...(model.thinking ? { thinking: {
      mode: model.thinking.mode, efforts: [...model.thinking.efforts], defaultLevel: model.thinking.defaultLevel,
      effortMap: { ...model.thinking.effortMap }, effortRouting: { ...model.thinking.effortRouting }, effortBudgets: { ...model.thinking.effortBudgets },
      supportsDisplay: model.thinking.supportsDisplay, prefixBinding: model.thinking.prefixBinding,
      suppressWhenOff: model.thinking.suppressWhenOff, requiresEffort: model.thinking.requiresEffort,
    } } : {}),
    supportsTools: model.supportsTools !== false, supportsComputerUse: model.supportsComputerUse,
    capabilities, compatibility,
    settingsPaths: settingPaths.filter(key => /^(model\.|providers\.|provider\.|thinking|defaultThinkingLevel|tier\.|compaction\.|context|extendedContext|tool|retry\.|advisor\.|plan)/.test(key)),
    excludedSensitiveFields: excluded,
    unmappedCapabilityFields: [
      ...Object.keys(model).filter(key => !projected.has(key) && !excluded.includes(key)),
      ...Object.keys(model.compat ?? {}).filter(key => !Object.hasOwn(compatibility, key) && !excluded.includes(`compat.${key}`)).map(key => `compat.${key}`),
    ],
  };
}

/** Settings read during a turn or controlled by native effective-change hooks.
 * Construction-only/auth/TUI controls remain owning-host settings for new sessions. */
export function supportsSessionOverride(key: string): boolean {
  return /^(thinkingBudgets\.|compaction\.|contextPromotion\.|model\.|retry\.|tools\.approval(?:Mode)?$|providers\.(?:openai|anthropic|google|kimi|synthetic|antigravity)|provider\.appendOnlyContext$|extendedContext$)/.test(key);
}
export class NativeSessionControls {
  #fingerprint?: string;
  #revision = crypto.randomUUID();
  #overrides = new Set<string>();
  #durableApprovalOverride?: OmpApprovalMode;
  constructor(private session: AgentSession, durableApprovalOverride?: OmpApprovalMode) {
    this.#durableApprovalOverride = durableApprovalOverride;
    if (durableApprovalOverride !== undefined) this.#overrides.add("tools.approvalMode");
  }
  /** The caller has durably saved intent before invoking this native apply. */
  setApprovalOverride(mode: OmpApprovalMode | undefined, expectedRevision: string): OmpSessionControls {
    if (expectedRevision !== this.read().revision) throw new OmpSettingsError("conflict", "Native session controls changed; reload before editing");
    if (mode === undefined) {
      this.session.settings.clearOverride("tools.approvalMode");
      this.#overrides.delete("tools.approvalMode");
    } else {
      this.session.settings.override("tools.approvalMode", approvalMode(mode));
      this.#overrides.add("tools.approvalMode");
    }
    this.#durableApprovalOverride = mode;
    return this.read();
  }
  read(): OmpSessionControls {
    const session = this.session;
    const states = settingStates(session.settings);
    for (const state of states) if (this.#overrides.has(state.path)) state.origin = "runtime";
    const output: OmpSessionControls = { revision: this.#revision, sessionId: session.sessionId,
      model: session.model ? { provider: session.model.provider, id: session.model.id } : null,
      thinkingLevel: session.configuredThinkingLevel(), serviceTiers: { ...session.serviceTierByFamily },
      capabilities: session.model ? modelCapabilities(session.model) : null,
      settings: states, overrides: [...this.#overrides], runtimeMutablePaths: settingPaths.filter(key => supportsSessionOverride(key) && !isCredential(key)),
      persistence: "native-session-model-thinking-tiers; runtime-settings-until-dispose",
      ...(this.#durableApprovalOverride === undefined ? {} : { durableApprovalOverride: this.#durableApprovalOverride }) };
    const fingerprint = JSON.stringify({ ...output, revision: undefined });
    if (fingerprint !== this.#fingerprint) { this.#fingerprint = fingerprint; this.#revision = crypto.randomUUID(); }
    output.revision = this.#revision;
    return output;
  }
  async mutate(request: OmpSessionControlMutation, changeModel: (choice: { provider: string; id: string }) => Promise<void>): Promise<OmpSessionControls> {
    if (request.expectedRevision !== this.read().revision) throw new OmpSettingsError("conflict", "Native session controls changed; reload before editing");
    switch (request.operation) {
      case "model": await changeModel(request.model); break;
      case "thinking": {
        const level = request.level === undefined ? undefined : parseCliThinkingLevel(request.level);
        if (request.level !== undefined && level === undefined) throw new OmpSettingsError("invalid-value", "Unknown native thinking selector");
        this.session.setThinkingLevel(level, false); break;
      }
      case "service-tier":
        if (!isServiceTierFamily(request.family) || request.tier !== undefined && !isServiceTierForFamily(request.family, request.tier)) throw new OmpSettingsError("invalid-value", "Unsupported native service tier for this provider family");
        this.session.setServiceTierFamily(request.family, request.tier); break;
      case "override": {
        const key = requireSetting(request.path);
        if (key === "tools.approvalMode") throw new OmpSettingsError("unsupported", "Native permission edits require the owning host's durable approval path");
        if (isCredential(key) || !supportsSessionOverride(key)) throw new OmpSettingsError("unsupported", "This setting requires owning-host configuration and a new session");
        const value = validateSettingValue(key, request.value);
        this.session.settings.override(key, value as never); this.#overrides.add(key); break;
      }
      case "clear-override": {
        const key = requireSetting(request.path);
        if (key === "tools.approvalMode") throw new OmpSettingsError("unsupported", "Native permission edits require the owning host's durable approval path");
        if (!this.#overrides.has(key)) throw new OmpSettingsError("unsupported", "No desktop runtime override exists for this setting");
        this.session.settings.clearOverride(key); this.#overrides.delete(key); break;
      }
      default: throw new OmpSettingsError("unsupported", "Unknown native session control operation");
    }
    await this.session.sessionManager.flush();
    return this.read();
  }
}
