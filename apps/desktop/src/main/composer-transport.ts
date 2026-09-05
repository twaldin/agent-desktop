import type { OmpComposerCatalog, OmpModelCapabilities, WorkspaceTarget } from "@agent-desktop/shared";
import { HostRequestError, requestHost, type HostEndpoint } from "./host-transport";

/** Negotiate before Electron strips custom Error fields. A missing route is
 * distinct from authentication, connection, malformed response or server errors.
 * Both requests use the exact same owning endpoint and catalog target.
 */
export async function requestComposerCatalog(endpoint: HostEndpoint, target?: WorkspaceTarget, refresh?: boolean): Promise<OmpComposerCatalog> {
  try { return await requestHost(endpoint, "/v1/models/composer", { target, refresh }) as OmpComposerCatalog; }
  catch (error) {
    if (!(error instanceof HostRequestError) || error.status !== 404 || error.code !== undefined) throw error;
  }
  const capabilities = await requestHost(endpoint, "/v1/models/capabilities", { target, refresh }) as OmpModelCapabilities[];
  return {
    cwd: null, resolution: "legacy-capabilities", default: { model: null, source: "unknown-older-host" },
    // The older endpoint has no native role resolution, auth/disabled state or
    // effective default thinking. Leave those unknown rather than infer them.
    models: capabilities.map(model => ({
      provider: model.provider, id: model.id, name: model.name, contextWindow: model.contextWindow,
      maxTokens: model.maxTokens, input: model.input, reasoning: model.reasoning,
      thinkingLevels: model.thinkingSelectors, defaultThinkingLevel: model.thinking?.defaultLevel,
    })),
  };
}
