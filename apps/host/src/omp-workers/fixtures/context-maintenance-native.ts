// Actual pinned native context-maintenance fixture. Run only with an owned
// disposable HOME/PI_CODING_AGENT_DIR. Provider traffic is restricted to the
// loopback server below; every session and artifact is written below argv[2].
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";

const root = path.resolve(process.argv[2] ?? ""), scenario = process.argv[3] ?? "";
assert.ok(root && scenario, "usage: context-maintenance-native.ts <owned-root> <scenario>");
assert.equal(process.env.HOME, root);
const agentDir = path.join(root, "agent"), cwd = path.join(root, "project");
assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir);
await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });

type ProviderRequest = { stream: boolean; body: Record<string, unknown>; parseFailure?: { name: string; message: string } };
const requests: ProviderRequest[] = [];
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
  assert.equal(request.method, "POST");
  // Reserve the slot before parsing because concurrent request bodies can
  // finish parsing in a different order from their arrival at the server.
  const recorded: ProviderRequest = { stream: false, body: {} };
  requests.push(recorded);
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch (error) {
    recorded.parseFailure = error instanceof Error ? { name: error.name, message: error.message }
      : { name: "UnknownThrownValue", message: String(error) };
    throw error;
  }
  const stream = body.stream === true;
  recorded.stream = stream; recorded.body = body;
  if (scenario === "compact-error" || scenario === "compact-remote-fallback" && !stream)
    return Response.json({ error: { message: "controlled compact provider failure" } }, { status: 400 });
  if (!stream) return Response.json({ choices: [{ message: { content: "Controlled remote compact summary." } }] });
  const id = `context-maintenance-${requests.length}`;
  const chunk = (delta: Record<string, unknown>, finish_reason: string | null, usage?: Record<string, number>) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`;
  return new Response(chunk({ role: "assistant", content: "Controlled soft compact summary." }, null)
    + chunk({}, "stop", { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 }) + "data: [DONE]\n\n",
  { headers: { "content-type": "text/event-stream" } });
} });
const origin = `http://127.0.0.1:${provider.port}`;
const originalFetch = globalThis.fetch;
let blockedFetches = 0;
globalThis.fetch = Object.assign(async (input: Request | URL | string, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== origin) { blockedFetches++; throw new Error(`Nonloopback fetch blocked: ${url.origin}${url.pathname}`); }
  return originalFetch(input, init);
}, { preconnect: (input: URL | string) => {
  const url = new URL(String(input));
  if (url.origin !== origin) throw new Error(`Nonloopback preconnect blocked: ${url.origin}`);
} }) as typeof fetch;

await writeFile(path.join(agentDir, "config.yml"), [
  "extensions: []", "defaultThinkingLevel: off", "compaction:", "  enabled: true", "  methodOrder: [soft]",
  "  keepRecentTokens: 1000", "  reserveTokens: 2048", `  remoteEndpoint: ${origin}/v1/chat/completions`,
  "  remoteStreamingV2Enabled: false", "retry:", "  enabled: false", "",
].join("\n"));
await writeFile(path.join(agentDir, "models.yml"), JSON.stringify({ providers: { "context-maintenance": {
  api: "openai-completions", baseUrl: `${origin}/v1`, auth: "none", models: [{ id: "fixture", name: "Controlled context maintenance",
    reasoning: false, input: ["text", "image"], contextWindow: 128000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));

const native = await import("@oh-my-pi/pi-coding-agent");
const { beginNativePrompt } = await import("../../omp/prompt");
const { dispatchNativePrompt } = await import("../../omp/commands");
type Session = Awaited<ReturnType<typeof create>>;
async function create(file?: string, extensions?: NonNullable<Parameters<typeof native.createAgentSession>[0]>["extensions"]): Promise<{
  session: import("@oh-my-pi/pi-coding-agent").AgentSession;
  manager: import("@oh-my-pi/pi-coding-agent").SessionManager;
  auth: Awaited<ReturnType<typeof native.discoverAuthStorage>>;
}> {
  const auth = await native.discoverAuthStorage(agentDir);
  const settings = await native.Settings.loadReadOnly({ agentDir, cwd });
  const registry = new native.ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings });
  const manager = file ? await native.SessionManager.open(file) : native.SessionManager.create(cwd, path.join(agentDir, "sessions"));
  try {
    const created = await native.createAgentSession({ agentDir, cwd, settings, authStorage: auth, modelRegistry: registry,
      agentRegistry: new native.AgentRegistry(), sessionManager: manager, model: file ? undefined : registry.find("context-maintenance", "fixture"),
      extensions: extensions ?? [], disableExtensionDiscovery: extensions === undefined, hasUI: false, interactivePrompts: false,
      enableMCP: false, enableLsp: false, toolNames: [], restrictToolNames: extensions === undefined, skills: [], rules: [], contextFiles: [],
      getApiKey: () => "controlled-loopback-key", systemPrompt: "Controlled context maintenance fixture." });
    await manager.ensureOnDisk();
    return { session: created.session, manager, auth };
  } catch (error) { await manager.close(); auth.close(); throw error; }
}
async function close(value: Session) { try { await value.session.dispose(); } finally { value.auth.close(); } }
const failure = (reason: unknown) => reason instanceof Error
  ? { name: reason.name, message: reason.message, ...("code" in reason ? { code: reason.code } : {}) }
  : { thrown: reason };
async function dispatch(value: Session, text: string, failAdmissionFlush = false) {
  const originalFlush = value.manager.flush.bind(value.manager);
  const run = beginNativePrompt(value.manager, async () => {
    const result = await dispatchNativePrompt(value.session, text);
    if (failAdmissionFlush) value.manager.flush = async () => { throw new Error("controlled post-command flush failure"); };
    return result;
  }, () => value.session.settleInFlightMessagePersistence());
  const [accepted, completion] = await Promise.allSettled([run.accepted, run.completion]);
  value.manager.flush = originalFlush;
  if (failAdmissionFlush) return {
    accepted: accepted.status === "fulfilled" ? { status: "fulfilled", value: accepted.value }
      : { status: "rejected", reason: failure(accepted.reason) },
    completion: completion.status === "fulfilled" ? { status: "fulfilled", value: completion.value }
      : { status: "rejected", reason: failure(completion.reason) },
  };
  if (accepted.status === "rejected") throw accepted.reason;
  if (completion.status === "rejected") throw completion.reason;
  return { accepted: accepted.value, completion: completion.value };
}
const usage = { input: 3000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 4000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function seedCompact(value: Session) {
  for (let index = 0; index < 12; index++) {
    value.manager.appendMessage({ role: "user", content: `Owned compact user ${index} ` + "detail ".repeat(1200), timestamp: index * 2 + 1 });
    value.manager.appendMessage({ role: "assistant", content: [{ type: "text", text: `Owned compact assistant ${index} ` + "detail ".repeat(1200) }],
      api: "openai-completions", provider: "context-maintenance", model: "fixture", usage, stopReason: "stop", timestamp: index * 2 + 2 } as AssistantMessage);
  }
}
function seedShake(value: Session) {
  value.manager.appendMessage({ role: "user", content: [{ type: "text", text: "Owned image context" },
    { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }], timestamp: 1 });
  value.manager.appendMessage({ role: "assistant", content: [{ type: "thinking", thinking: "Owned private reasoning" },
    { type: "text", text: "```text\n" + "heavy block ".repeat(900) + "\n```" }], api: "openai-completions",
    provider: "context-maintenance", model: "fixture", usage, stopReason: "stop", timestamp: 2 } as AssistantMessage);
  value.manager.appendMessage({ role: "toolResult", toolCallId: "owned-call", toolName: "read",
    content: [{ type: "text", text: "Owned tool result ".repeat(1800) }], isError: false, timestamp: 3 } as ToolResultMessage);
  value.manager.appendMessage({ role: "user", content: "Recent tail " + "keep ".repeat(1200), timestamp: 4 });
}
const rows = async (file: string) => (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
const commandRows = (entries: any[]) => entries.filter(row => row.type === "custom" && row.customType === "agent-desktop.command-output");
const projection = (branch: unknown[], messages: unknown[], entries: any[]) => {
  const serialized = JSON.stringify(branch), context = JSON.stringify(messages);
  return { branchLength: branch.length, compactions: branch.filter((row: any) => row.type === "compaction").map((row: any) => ({
    method: row.method, summary: row.summary, firstKeptEntryId: row.firstKeptEntryId,
  })), commands: commandRows(entries), contextMessages: messages.length,
  images: (serialized.match(/"type":"image"/g) ?? []).length,
  thinking: (serialized.match(/"type":"(?:thinking|redactedThinking)"/g) ?? []).length,
  shaken: (serialized.match(/\[shaken ~/g) ?? []).length,
  artifactLinks: (serialized.match(/artifact:\/\//g) ?? []).length,
  contextHasControlledSummary: context.includes("Controlled soft compact summary") || context.includes("Controlled remote compact summary") };
};
const requestProjection = (request: ProviderRequest) => ({
  stream: request.stream,
  body: JSON.stringify(request.body),
  ...(request.parseFailure ? { parseFailure: request.parseFailure } : {}),
});
const emit = async (result: unknown) => {
  await writeFile(path.join(root, "result.json"), JSON.stringify(result));
  process.stdout.write(JSON.stringify({ scenario, resultFile: "result.json" }) + "\n");
};
let current: Session | undefined;
try {
  if (scenario === "precedence") {
    const customDir = path.join(agentDir, "commands", "shake"); await mkdir(customDir, { recursive: true });
    const customEffect = path.join(root, "custom.effect");
    await writeFile(path.join(customDir, "index.ts"), `import { writeFile } from "node:fs/promises";\nexport default () => ({ name: "shake", description: "Owned shadow", execute: async () => { await writeFile(${JSON.stringify(customEffect)}, "custom\\n"); } });\n`);
    let extensionCalls = 0;
    current = await create(undefined, [pi => { pi.registerCommand("compact", { description: "Owned shadow",
      handler: async () => { extensionCalls++; } }); }]);
    const extensionLoaded = Boolean(current.session.extensionRunner?.getCommand("compact"));
    const customLoaded = current.session.customCommands.some(value => value.command.name === "shake");
    const compact = await dispatch(current, "/compact soft must remain shadowed");
    const shake = await dispatch(current, "/shake thinking must remain shadowed");
    const customEffectText = await readFile(customEffect, "utf8").catch(() => undefined);
    const compactions = current.manager.getBranch().filter(row => row.type === "compaction").length;
    await close(current); current = undefined;
    const inverseDir = path.join(agentDir, "commands", "compact"); await mkdir(inverseDir, { recursive: true });
    const inverseEffect = path.join(root, "inverse.effect");
    await writeFile(path.join(inverseDir, "index.ts"), `import { writeFile } from "node:fs/promises";\nexport default () => ({ name: "compact", description: "Owned inverse shadow", execute: async () => { await writeFile(${JSON.stringify(inverseEffect)}, "inverse\\n"); } });\n`);
    let inverseExtensionCalls = 0;
    current = await create(undefined, [pi => { pi.registerCommand("shake", { description: "Owned inverse shadow",
      handler: async () => { inverseExtensionCalls++; } }); }]);
    const inverseCustomLoaded = current.session.customCommands.some(value => value.command.name === "compact");
    const inverseExtensionLoaded = Boolean(current.session.extensionRunner?.getCommand("shake"));
    const inverseCompact = await dispatch(current, "/compact remote must remain shadowed");
    const inverseShake = await dispatch(current, "/shake images must remain shadowed");
    const inverseEffectText = await readFile(inverseEffect, "utf8").catch(() => undefined);
    await emit({ scenario, compact, shake, extensionLoaded, customLoaded, extensionCalls,
      customEffect: customEffectText, requests: requests.length, blockedFetches,
      compactions, inverse: { compact: inverseCompact, shake: inverseShake, customLoaded: inverseCustomLoaded,
        extensionLoaded: inverseExtensionLoaded, extensionCalls: inverseExtensionCalls, customEffect: inverseEffectText,
        compactions: current.manager.getBranch().filter(row => row.type === "compaction").length } });
    await close(current); current = undefined;
    process.exitCode = 0;
  } else if (scenario === "precedence-removal") {
    const customDir = path.join(agentDir, "commands", "compact"); await mkdir(customDir, { recursive: true });
    await writeFile(path.join(customDir, "index.ts"), "export default () => ({ name: 'compact', description: 'Owned removable shadow', execute: async () => {} });\n");
    current = await create(undefined, []);
    const shadowLoaded = current.session.customCommands.some(value => value.command.name === "compact");
    await close(current); current = undefined; await rm(customDir, { recursive: true });
    current = await create(undefined, []); seedCompact(current);
    const shadowRemoved = !current.session.customCommands.some(value => value.command.name === "compact");
    const compact = await dispatch(current, "/compact snapcompact");
    await emit({ scenario, shadowLoaded, shadowRemoved, compact, requests: requests.length,
      compactions: current.manager.getBranch().filter(row => row.type === "compaction").map((row: any) => row.method) });
    await close(current); current = undefined;
  } else if (scenario === "compact-hook-veto") {
    let hookCalls = 0;
    current = await create(undefined, [pi => { pi.on("session_before_compact", async () => { hookCalls++; return { cancel: true }; }); }]);
    seedCompact(current);
    const compact = await dispatch(current, "/compact soft vetoed focus");
    await emit({ scenario, hookCalls, compact, requests: requests.length,
      compactions: current.manager.getBranch().filter(row => row.type === "compaction").length });
    await close(current); current = undefined;
  } else current = await create();
  if (!current) {
    // Precedence has already emitted and closed its actual native session.
  } else {
  const file = current.manager.getSessionFile()!;
  let command: string;
  if (scenario.startsWith("compact-")) {
    seedCompact(current);
    command = scenario === "compact-default" ? "/compact"
      : scenario === "compact-legacy-focus" ? "/compact exact legacy focus"
      : scenario === "compact-soft" ? "/compact soft exact owned focus"
      : scenario === "compact-remote" ? "/compact remote exact owned focus"
      : scenario === "compact-remote-fallback" ? "/compact remote fallback focus"
      : scenario === "compact-snapcompact" ? "/compact snapcompact"
      : scenario === "compact-error" || scenario === "compact-flush-error" ? "/compact soft" : "/compact snapcompact forbidden focus";
  } else if (scenario.startsWith("shake-")) {
    if (scenario !== "shake-noop") seedShake(current);
    command = scenario === "shake-default" || scenario === "shake-noop" ? "/shake" : `/shake ${scenario.slice("shake-".length)}`;
  } else throw new Error(`Unknown fixture scenario: ${scenario}`);
  await current.manager.flush();
  const before = current.manager.getBranch().length;
  const result = await dispatch(current, command, scenario === "compact-flush-error");
  const liveRows = await rows(file), liveBranch = current.manager.getBranch();
  const live = projection(liveBranch, current.session.messages, liveRows);
  const originalIdentity = { id: current.session.sessionId, cwd: current.manager.getCwd(), file };
  const artifactId = /artifact:\/\/([\w-]+)/.exec(JSON.stringify(liveBranch))?.[1];
  const artifactPath = artifactId ? await current.manager.getArtifactPath(artifactId) : null;
  const artifact = artifactPath ? { id: artifactId, pathWithinOwnedRoot: path.relative(root, artifactPath).split(path.sep)[0] !== "..",
    content: await readFile(artifactPath, "utf8") } : undefined;
  await close(current); current = undefined;
  const reopened = await create(file);
  const reopenedProjection = projection(reopened.manager.getBranch(), reopened.session.messages, await rows(file));
  await close(reopened);
  const { OmpRuntime } = await import("../../omp/runtime");
  const runtime = new OmpRuntime({ agentDir });
  try {
    const commandRequestCount = requests.length;
    let followup: boolean | undefined;
    let followupAccepted: unknown;
    let runtimeIdentity: unknown;
    if (scenario !== "compact-error" && scenario !== "compact-flush-error") {
      const handle = await runtime.open({ sessionFile: file });
      runtimeIdentity = { id: handle.id, cwd: handle.cwd, file: handle.sessionFile,
        sameFile: await realpath(handle.sessionFile) === await realpath(file) };
      const run = handle.startPrompt("Controlled follow-up after cold reopen.");
      [followupAccepted, followup] = await Promise.all([run.accepted, run.completion]);
      await handle.dispose();
    }
    await emit({ scenario, command, result, requests: requests.slice(0, commandRequestCount).map(value => { const body = JSON.stringify(value.body); return { stream: value.stream,
      focus: ["exact owned focus", "exact legacy focus", "fallback focus"].find(focus => body.includes(focus)),
      ...(value.parseFailure ? { parseFailure: value.parseFailure } : {}) }; }),
      followup, followupAccepted, originalIdentity, runtimeIdentity,
      followupRequests: requests.slice(commandRequestCount).map(requestProjection), artifact, blockedFetches, before,
      live, reopened: reopenedProjection,
    });
  } finally { await runtime.dispose(); }
  }
} finally { if (current) await close(current); provider.stop(true); }
