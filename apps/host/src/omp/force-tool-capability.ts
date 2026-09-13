import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { Dialect } from "@oh-my-pi/pi-ai/dialect";
import { buildNamedToolChoice } from "@oh-my-pi/pi-coding-agent/utils/tool-choice";
import type { ForceToolAvailability } from "../../../../packages/shared/src/force-tool";

export interface NativeForceToolPolicy {
  model: Model<Api> | undefined;
  /** Actual owned dialect from native construction, including dispatch env fallback. */
  dialect: Dialect | undefined;
  reasoningActive: boolean;
}

/** Model's generic API parameter needs an explicit guard to narrow its native CompatOf view. */
function isNativeModelApi<TApi extends Api>(model: Model<Api>, api: TApi): model is Model<TApi> {
  return model.api === api;
}

/** Reports the pinned native setter and request policy, not provider acceptance. */
export function getNativeForceToolAvailability(policy: NativeForceToolPolicy): ForceToolAvailability {
  const { model, dialect, reasoningActive } = policy;
  if (!model) return { state: "unsupported", reason: "No native model is selected." };
  const choice = buildNamedToolChoice("native-force-capability", model);
  if (!choice || typeof choice === "string") return {
    state: "unsupported",
    reason: typeof choice === "string"
      ? `The pinned native setter rejects ${model.api}'s non-named ${choice} choice; its lower-level named mapper is not this operation.`
      : `The pinned native setter does not support a named choice for API ${model.api}.`,
  };
  if (dialect) return { state: "degraded", reason: `Native /force is accepted, but owned in-band dialect ${dialect} suppresses native tools and both tool-choice requests. No tool execution is guaranteed.` };
  if (isNativeModelApi(model, "openai-completions")) {
    const compat = model.compat;
    if (!compat) return { state: "degraded", reason: "Native /force is accepted, but resolved Completions compatibility is unavailable; no request guarantee." };
    if (!compat.supportsToolChoice) return { state: "degraded", reason: "Native /force is accepted; this compatibility policy omits tool_choice on both requests." };
    if (!compat.supportsForcedToolChoice) return { state: "degraded", reason: "Native /force is accepted; this compatibility policy downgrades forced choice to auto (which reasoning policy may also omit)." };
    if (compat.nativeKimiK3Reasoning && model.reasoning && reasoningActive) return { state: "degraded", reason: compat.supportsNamedToolChoice
      ? "Active native Kimi K3 reasoning changes the named request to required without narrowing the offered tools; any offered tool may be selected."
      : "Native string-only compatibility narrows offered tools before Kimi K3 required selection; emitted-schema filtering may still omit the requested choice." };
    return { state: "supported", reason: `${compat.supportsNamedToolChoice ? "Native named function choice" : "Native one-function catalogue plus required choice"}; missing or quarantined emitted names remove the choice. The next request asks for none when tools remain. Provider execution is not guaranteed.` };
  }
  if (isNativeModelApi(model, "anthropic-messages")) {
    const compat = model.compat;
    if (!compat) return { state: "degraded", reason: "Native /force is accepted, but resolved Anthropic compatibility is unavailable; no request guarantee." };
    if (!compat.supportsForcedToolChoice) return { state: "degraded", reason: "Native /force is accepted; resolved Fable/Mythos or required-thinking compatibility downgrades forced choice to auto. The next request asks for none." };
    return { state: "supported", reason: "Native named tool choice uses the original Anthropic name encoding; the next request asks for none. Provider execution is not guaranteed.",
      thinkingNote: "The forced request removes thinking and context management; adaptive-only models supporting output effort use low effort instead. This is native request policy, not a saved thinking change." };
  }
  if (isNativeModelApi(model, "openai-responses")) {
    const compat = model.compat;
    if (!compat) return { state: "degraded", reason: "Native /force is accepted, but resolved Responses compatibility is unavailable; no request guarantee." };
    return { state: "supported", reason: `Native Responses policy: ${compat.supportsNamedToolChoice ? "named offered-tool choice" : "one-function catalogue plus required"}. Quarantined or missing emitted tools remove choice; next request asks for none when tools remain. Endpoint acceptance is not guaranteed.` };
  }
  if (isNativeModelApi(model, "azure-openai-responses")) {
    const compat = model.compat;
    if (!compat) return { state: "degraded", reason: "Native /force is accepted, but resolved Azure compatibility is unavailable; no request guarantee." };
    return { state: compat.supportsNamedToolChoice ? "supported" : "degraded", reason: `The distinct native Azure adapter sends named function/computer choice only for emitted members, then none. It does not implement the common Responses string-only narrowing or schema quarantine.${compat.supportsNamedToolChoice ? "" : " This compatibility policy lacks named choice support, but native /force still sends the named object; endpoint rejection is possible."} No execution guarantee.` };
  }
  if (model.api === "bedrock-converse-stream") {
    if (model.thinking?.prefixBinding && model.reasoning && reasoningActive) return { state: "degraded", reason: "Native /force is accepted; prefix-bound thinking downgrades the forced Converse choice to auto. The none leg may retain tools or an empty-tools sentinel when tool history exists.", thinkingNote: "Native prefix-bound thinking is retained rather than disabled." };
    return { state: "supported", reason: "Native Converse named tool selection. The none leg removes tool configuration only without tool history; with history it retains tools or an empty-tools sentinel. No exactly-once execution guarantee.", thinkingNote: "Native forced Converse requests remove conflicting thinking request fields unless prefix-bound policy downgrades the choice." };
  }
  if (model.api === "openai-codex-responses")
    return { state: "supported", reason: "Native Codex maps the offered tool to function, supported freeform custom wire name, or supported computer choice; missing offered tools omit choice. The next request asks for none. No execution guarantee." };
  if (model.api === "ollama-chat")
    return { state: "supported", reason: "Native Ollama narrows tools to the requested name and sends required, then none. If the requested name is absent from the offered tools, the request has no tools but still sends required. Actual endpoint/model tool support and execution are not guaranteed." };
  // Eligibility above remains owned by the original helper, including future APIs.
  return { state: "degraded", reason: "The native setter accepts this API, but its request policy has not been characterized by this host. No named forcing guarantee." };
}
