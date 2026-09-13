import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Api, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";

/** Must run in a disposable subprocess, never in the test runner's credential environment. */
export async function createForceFixture(root: string, fetchBoundary?: typeof fetch) {
  assert.ok(root.includes("force-native-")); assert.equal(process.env.HOME, root);
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project");
  assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir);
  globalThis.fetch = Object.assign(async () => { throw new Error("Unowned force fixture network request"); }, { preconnect: () => {} }) as typeof fetch;
  await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
  await writeFile(path.join(agentDir, "config.yml"), "extensions: []\nretry:\n  enabled: false\ntools:\n  format: native\n", { flag: "wx" });
  // Intentionally test native loading only after the outbound guard; static imports run discovery too early.
  const native = await import("@oh-my-pi/pi-coding-agent");
  const { parseCliThinkingLevel } = await import("@oh-my-pi/pi-coding-agent/thinking");
  const { resolveAwsRegistryApiKey } = await import("@oh-my-pi/pi-ai/registry/aws");
  const { NativeForceToolController } = await import("../force-tool");
  const codingAgentUrl = import.meta.resolve("@oh-my-pi/pi-coding-agent");
  const { Type } = await import(import.meta.resolve("@oh-my-pi/omptype/typebox", codingAgentUrl));
  const { resolveOwnedDialectFromEnv } = await import(import.meta.resolve("@oh-my-pi/pi-agent-core/agent-loop", codingAgentUrl));
  const { BUILTIN_CONTROL_SLASH_COMMANDS } = await import("@oh-my-pi/pi-coding-agent/slash-commands/builtin-control");
  const force = BUILTIN_CONTROL_SLASH_COMMANDS.find(command => command.name === "force")!;
  const auth = await native.discoverAuthStorage(agentDir);
  const settings = await native.Settings.loadReadOnly({ agentDir, cwd });
  const registry = new native.ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings });
  const inertKey = "force-native-fixture-not-a-credential";
  const tool: ToolDefinition = { name: "force_fixture", label: "Force fixture", description: "Disposable native force tool", loadMode: "essential", approval: "read",
    parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "fixture invoked" }], details: {} }) };
  function model<TApi extends Api>(api: TApi, predicate: (candidate: Model<Api>) => boolean = () => true): Model<TApi> {
    const found = registry.getAll().find(candidate => candidate.api === api && predicate(candidate));
    assert.ok(found, `Pinned native catalog has no matching ${api} model; do not fabricate a PASS.`);
    // The original registry row was selected by exact API above.
    return found as Model<TApi>;
  }
  async function create(selected: Model<Api>, options: { file?: string; thinking?: "off" | "high"; credential?: string; streamOptions?: SimpleStreamOptions; mcpManager?: MCPManager } = {}) {
    const manager = options.file ? await native.SessionManager.open(options.file) : native.SessionManager.create(cwd, path.join(agentDir, "sessions"));
    const sessionSettings = await native.Settings.loadReadOnly({ agentDir, cwd });
    const nativeApiKey = options.credential ?? (selected.api === "bedrock-converse-stream" ? resolveAwsRegistryApiKey() : inertKey);
    assert.ok(nativeApiKey, "The owned fixture must provide its intended native authentication route.");
    const result = await native.createAgentSession({ agentDir, cwd, authStorage: auth, modelRegistry: registry,
      settings: sessionSettings, agentRegistry: new native.AgentRegistry(), sessionManager: manager,
      model: selected, thinkingLevel: parseCliThinkingLevel(options.thinking ?? "off"), getApiKey: () => nativeApiKey,
      hasUI: false, interactivePrompts: false, disableExtensionDiscovery: true, enableMCP: !!options.mcpManager,
      ...(options.mcpManager ? { mcpManager: options.mcpManager } : {}), enableLsp: false,
      toolNames: [], restrictToolNames: false, customTools: [tool, { ...tool, name: "force_other" }],
      extensions: [api => { api.registerTool({ ...tool, name: "force_extension" }); }],
      skills: [], rules: [], contextFiles: [], systemPrompt: "Owned force-native fixture, no live provider transport." });
    const session = result.session;
    await session.setActiveToolsByName(["force_fixture", "force_other", "force_extension", ...session.getActiveToolNames()]);
    const original = session.agent.streamFn;
    if (fetchBoundary || options.streamOptions) session.agent.streamFn = (model, context, streamOptions) => original(model, context,
      { ...streamOptions, ...options.streamOptions, ...(fetchBoundary ? { fetch: fetchBoundary } : {}) });
    let ownershipReason: string | undefined, busyReason: string | undefined;
    let ownershipRevision = 0;
    const controller = new NativeForceToolController(session, {
      getDialect: () => result.nativeDialect ?? resolveOwnedDialectFromEnv(Bun.env.PI_DIALECT),
      getOwnershipReason: () => ownershipReason, getOwnershipRevision: () => ownershipRevision, getBusyReason: () => busyReason,
    });
    await manager.ensureOnDisk();
    const invoke = (args: string, output: (text: string) => Promise<void> = async () => {}) => {
      const result = force.handle!({ name: "force", args } as never, { session, output } as never);
      assert.ok(result instanceof Promise, "The pinned original /force handler must retain its async contract.");
      return result;
    };
    return { session, manager, controller, invoke,
      setOwnershipReason(value?: string) {
        if (ownershipReason !== value) { ownershipReason = value; ownershipRevision++; }
      },
      setBusyReason(value?: string) { busyReason = value; },
      async close() { controller.dispose(); await session.dispose(); await manager.close(); } };
  }
  return { native, auth, registry, model, create, inertKey, Type, agentDir, cwd };
}
