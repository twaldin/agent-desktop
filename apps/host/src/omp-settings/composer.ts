import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { getModelMatchPreferences, pickDefaultAvailableModel, resolveAllowedModels, resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { AUTO_THINKING, concreteThinkingLevel, parseConfiguredThinkingLevel, resolveProvisionalAutoLevel, resolveThinkingLevelForModel } from "@oh-my-pi/pi-coding-agent/thinking";
import type { OmpComposerCatalog, OmpComposerModel } from "@agent-desktop/shared";
import { approvalMode } from "../approval";
type Model = ReturnType<ModelRegistry["getAll"]>[number];

/** Read the same pinned native role/fallback/thinking rules as SDK startup.
 * No session is created and no extension factory or provider prompt is run.
 * This is a registry preview; the real session still chooses its own default.
 */
export async function composerCatalog(cwd: string, settings: Settings, registry: ModelRegistry): Promise<OmpComposerCatalog> {
  const preferences = getModelMatchPreferences(settings);
  const allowed = await resolveAllowedModels(registry, settings, preferences);
  const role = resolveModelRoleValue(settings.getModelRole("default"), allowed, { settings, matchPreferences: preferences });
  const selected = role.model ?? pickDefaultAvailableModel(allowed.filter(model => registry.hasConfiguredAuth(model)), provider => registry.hasConcreteAuth(provider));
  const available = new Set(registry.getAvailable().map(model => `${model.provider}/${model.id}`));
  const configuredDefault = parseConfiguredThinkingLevel(settings.get("defaultThinkingLevel"));
  const thinking = (model: Model, level = model.thinking?.defaultLevel ?? configuredDefault) => ({
    thinkingLevel: level,
    effectiveThinkingLevel: level === AUTO_THINKING ? resolveProvisionalAutoLevel(model) : resolveThinkingLevelForModel(model, concreteThinkingLevel(level)),
  });
  const project = (model: Model): OmpComposerModel => {
    const defaults = thinking(model);
    return {
      id: model.id, provider: model.provider, name: model.name, reasoning: model.reasoning,
      input: [...model.input], contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      thinkingLevels: model.reasoning ? ["auto", "off", ...(model.thinking?.efforts ?? [])] : ["off"],
      authenticated: registry.hasConfiguredAuth(model), available: available.has(`${model.provider}/${model.id}`),
      disabledInSettings: settings.get("disabledProviders").includes(model.provider),
      defaultThinkingLevel: defaults.thinkingLevel, effectiveDefaultThinkingLevel: defaults.effectiveThinkingLevel,
    };
  };
  const models = registry.getAll().map(project);
  return { cwd, models, resolution: "native-registry-preview", default: selected ? {
    model: models.find(model => model.provider === selected.provider && model.id === selected.id) ?? project(selected),
    ...thinking(selected, role.model && role.explicitThinkingLevel ? role.thinkingLevel : undefined),
    source: role.model ? "configured-role" : "native-fallback",
    approvalMode: approvalMode(settings.get("tools.approvalMode")),
  } : { model: null, source: "unavailable", approvalMode: approvalMode(settings.get("tools.approvalMode")) } };
}
