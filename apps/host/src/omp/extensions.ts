import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { runExtensionCompact, runExtensionSetModel } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/compact-handler";
import { getSessionSlashCommands } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/get-commands-handler";
import type { OmpInteractionBridge } from "./interactions";

/** Same native action bindings as 18.1.10 modes/runtime-init, with host-owned
 * identity changes unavailable until the daemon can admit their new files. */
export async function initializeDesktopExtensions(session: AgentSession, ui: OmpInteractionBridge): Promise<void> {
  const runner = session.extensionRunner;
  if (!runner) return;
  const report = (error: unknown) => ui.notify(error instanceof Error ? error.message : "Native extension operation failed", "error");
  let starting = true;
  const startupSends = new Set<Promise<unknown>>();
  const trackSend = (task: Promise<unknown>) => {
    if (starting) startupSends.add(task);
    void task.catch(report).finally(() => { startupSends.delete(task); });
  };
  runner.initialize({
    sendMessage: (message, options) => { trackSend(session.sendCustomMessage(message, options)); },
    sendUserMessage: (content, options) => { trackSend(session.sendUserMessage(content, options)); },
    appendEntry: (type, data) => { session.sessionManager.appendCustomEntry(type, data); },
    setLabel: (id, label) => { session.sessionManager.appendLabelChange(id, label); },
    getActiveTools: () => session.getEnabledToolNames(),
    getAllTools: () => session.getAllToolInfos(),
    setActiveTools: names => session.setActiveToolsByName(names),
    getCommands: () => getSessionSlashCommands(session),
    setModel: model => runExtensionSetModel(session, model),
    getThinkingLevel: () => session.thinkingLevel,
    setThinkingLevel: level => session.setThinkingLevel(level),
    getServiceTiers: () => session.serviceTierByFamily,
    setServiceTier: (family, tier) => session.setServiceTierFamily(family, tier),
    getSessionName: () => session.sessionManager.getSessionName(),
    setSessionName: async name => { await session.sessionManager.setSessionName(name, "user"); },
  }, {
    getModel: () => session.model,
    isIdle: () => !session.isStreaming,
    abort: () => session.abort(),
    hasPendingMessages: () => session.queuedMessageCount > 0,
    shutdown: () => ui.unsupported("extension.shutdown: daemon-owned lifecycle"),
    getContextUsage: () => session.getContextUsage(),
    getSystemPrompt: () => session.systemPrompt,
    compact: options => runExtensionCompact(session, options),
  }, {
    getContextUsage: () => session.getContextUsage(),
    waitForIdle: () => session.agent.waitForIdle(),
    newSession: async () => ui.unsupported("extension.newSession: daemon-owned session identity"),
    branch: async () => ui.unsupported("extension.branch: daemon-owned session identity"),
    navigateTree: async (id, options) => {
      const result = await session.navigateTree(id, { summarize: options?.summarize });
      return { cancelled: result.cancelled };
    },
    switchSession: async () => ui.unsupported("extension.switchSession: daemon-owned session identity"),
    reload: async () => ui.unsupported("extension.reload: requires bridge reinitialization"),
    compact: options => runExtensionCompact(session, options),
  }, ui, "rpc");
  runner.onError(error => ui.notify(`Native extension ${error.event}: ${error.error}`, "error"));
  await runner.emit({ type: "session_start" });
  // Fire-and-forget startup sends can outlive the hook itself. Finish them
  // before the caller installs the submitted draft's user-entry observer.
  while (startupSends.size) await Promise.allSettled([...startupSends]);
  starting = false;
}
