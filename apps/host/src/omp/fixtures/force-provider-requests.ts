import assert from "node:assert/strict";
import path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { createForceFixture } from "./force-native-fixture";
import { forceProviderTransport } from "./force-provider-transport";
import type { ForceWireRequest, ForceWireTool } from "./force-provider-transport";

const transport = forceProviderTransport();
const fixture = await createForceFixture(path.resolve(process.argv[2] ?? ""), transport.fetchBoundary);
const group = process.argv[3];
const observations: Array<{ label: string; api: Api; first: unknown; second: unknown; availability: string; contextFiltered?: true }> = [];
interface CaseOptions {
  thinking?: "off" | "high";
  credential?: string;
  prepare?: (session: AgentSession) => void;
  beforeSecond?: (session: AgentSession) => void;
  state?: "supported" | "degraded";
  contextFiltered?: true;
  check: (first: ForceWireRequest, second: ForceWireRequest) => void;
}

async function runCase(label: string, model: Model<Api>, options: CaseOptions) {
  const origin = model.api === "bedrock-converse-stream" ? "https://bedrock-runtime.us-east-1.amazonaws.com" : new URL(model.baseUrl).origin;
  transport.select(model.api, origin);
  const native = await fixture.create(model, { thinking: options.thinking, credential: options.credential,
    streamOptions: { preferWebsockets: false } });
  try {
    options.prepare?.(native.session);
    const state = native.controller.getState();
    if (options.state) assert.equal(state.availability.state, options.state, label);
    const start = transport.requests.length;
    const captured = native.controller.captureArm({ commandId: label, toolName: "force_fixture", promptRequested: true,
      guard: { epoch: state.epoch, expectedRevision: state.revision, toolName: "force_fixture" } }, () => native.invoke("force_fixture owned request"));
    assert.equal(captured.receipt?.arm, "armed", label); await captured.result;
    await native.session.agent.prompt(`Owned first leg ${label}.`);
    await native.session.waitForIdle();
    assert.equal(transport.requests.length, start + 1, `${label}: first original native stream must reach the real builder exactly once.`);
    assert.equal(native.controller.getState().directives[0]?.phase, "pending-final-response", label);
    options.beforeSecond?.(native.session);
    await native.session.agent.prompt(`Owned final response leg ${label}.`);
    await native.session.waitForIdle();
    assert.equal(transport.requests.length, start + 2, `${label}: second native none leg must reach the real builder.`);
    assert.deepEqual(native.controller.getState().directives, [], `${label}: completed request sequence is not tool-execution proof.`);
    const first = transport.requests[start]!, second = transport.requests[start + 1]!;
    options.check(first, second);
    observations.push({ label, api: model.api, first: first.body.tool_choice ?? first.body.toolConfig ?? null,
      second: second.body.tool_choice ?? second.body.toolConfig ?? null, availability: state.availability.state,
      ...(options.contextFiltered ? { contextFiltered: true as const } : {}) });
  } finally { await native.close(); }
}

type ForceFixtureTool = AgentSession["agent"]["state"]["tools"][number];
function updateSelectedTool(session: AgentSession, metadata: Partial<ForceFixtureTool>): void {
  const tool = session.agent.state.tools.find(tool => tool.name === "force_fixture");
  assert.ok(tool, "Actual native active registry tool is required.");
  // Native wrappers expose metadata through getters. Replace the Agent's offered
  // descriptor through its public setter, retaining the original execution owner.
  session.agent.setTools(session.agent.state.tools.map(candidate => candidate === tool
    ? { ...tool, name: tool.name, label: tool.label, description: tool.description,
      parameters: tool.parameters, execute: tool.execute.bind(tool), ...metadata }
    : candidate));
}

try {
  if (group === "codex") {
    const model = fixture.model("openai-codex-responses", candidate => candidate.provider === "openai-codex" && candidate.id === "gpt-5.4");
    await runCase("codex-function", model, { check(first, second) {
      assert.deepEqual(first.body.tool_choice, { type: "function", name: "force_fixture" });
      assert.ok(first.body.tools!.some((tool: ForceWireTool) => tool.type === "function" && tool.name === "force_fixture"));
      assert.equal(second.body.tool_choice, "none"); assert.equal(first.body.prompt_cache_key, second.body.prompt_cache_key);
    } });
    await runCase("codex-custom-wire-name", { ...model, applyPatchToolType: "freeform" }, {
      prepare(session) { updateSelectedTool(session, { customWireName: "force_wire", customFormat: { syntax: "regex", definition: ".*" } }); },
      check(first, second) { assert.deepEqual(first.body.tool_choice, { type: "custom", name: "force_wire" });
        assert.ok(first.body.tools!.some((tool: ForceWireTool) => tool.type === "custom" && tool.name === "force_wire")); assert.equal(second.body.tool_choice, "none"); },
    });
    await runCase("codex-native-computer", { ...model, supportsComputerUse: true }, {
      prepare(session) { updateSelectedTool(session, { native: { type: "computer" } }); },
      check(first, second) { assert.deepEqual(first.body.tool_choice, { type: "computer" });
        assert.ok(first.body.tools!.some((tool: ForceWireTool) => tool.type === "computer")); assert.equal(second.body.tool_choice, "none"); },
    });
  } else if (group === "responses") {
    const model = fixture.model("openai-responses", candidate => candidate.provider === "openai" && candidate.id === "gpt-5.4");
    await runCase("responses-named", model, { check(first, second) {
      assert.deepEqual(first.body.tool_choice, { type: "function", name: "force_fixture" }); assert.equal(second.body.tool_choice, "none");
    } });
    await runCase("responses-narrowed-required", { ...model, compat: { ...model.compat, supportsNamedToolChoice: false } }, { check(first, second) {
      assert.equal(first.body.tool_choice, "required"); assert.deepEqual(first.body.tools!.map((tool: ForceWireTool) => tool.name), ["force_fixture"]); assert.equal(second.body.tool_choice, "none");
    } });
    await runCase("responses-quarantined-requested-tool", model, {
      prepare(session) { updateSelectedTool(session, { parameters: { type: "object", properties: { impossible: { type: "string", enum: [1] } }, required: ["impossible"], additionalProperties: false } }); },
      check(first, second) { assert.equal(first.body.tool_choice, undefined);
        assert.ok(first.body.tools!.every((tool: ForceWireTool) => tool.name !== "force_fixture")); assert.ok(first.body.tools!.some((tool: ForceWireTool) => tool.name === "force_other")); assert.equal(second.body.tool_choice, "none"); },
    });
    process.env.PI_DIALECT = "glm";
    try {
      await runCase("responses-owned-inband-suppresses-both-legs", model, { state: "degraded", check(first, second) {
        assert.equal(first.body.tool_choice, undefined); assert.equal(second.body.tool_choice, undefined);
        assert.equal(first.body.tools?.length ?? 0, 0); assert.equal(second.body.tools?.length ?? 0, 0);
      } });
    } finally { delete process.env.PI_DIALECT; }
    for (const failure of ["error", "abort"] as const) {
      const label = `responses-native-${failure}-requeue`;
      transport.select(model.api, new URL(model.baseUrl).origin);
      const native = await fixture.create(model, { streamOptions: { preferWebsockets: false } });
      const nativeStops: string[] = [];
      const unsubscribe = native.session.subscribe(event => {
        if (event.type === "turn_end" && "stopReason" in event.message && typeof event.message.stopReason === "string")
          nativeStops.push(event.message.stopReason);
      });
      try {
        const arm = native.controller.captureArm({ commandId: label, toolName: "force_fixture", promptRequested: true }, () => native.invoke("force_fixture original error/abort request"));
        await arm.result;
        const start = transport.requests.length;
        const reached = failure === "abort" ? transport.blockUntilAbort() : undefined;
        if (failure === "error") transport.failRequests();
        const completion = native.session.agent.prompt(`Owned actual ${failure} lifecycle.`).catch(() => {});
        if (reached) { await reached; native.session.agent.abort(); }
        await completion;
        await native.session.waitForIdle();
        assert.ok(transport.requests.length > start, "Failure must come after the actual pinned builder reached the owned transport.");
        assert.ok(nativeStops.includes(failure === "abort" ? "aborted" : "error"), "Actual native turn_end must carry the intended failure.");
        assert.deepEqual(transport.requests[start]!.body.tool_choice, { type: "function", name: "force_fixture" });
        const requeued = native.controller.getState().directives;
        assert.equal(requeued.length, 1);
        assert.equal(requeued[0]!.id, arm.receipt!.directiveId);
        assert.equal(requeued[0]!.phase, "pending-tool"); assert.equal(requeued[0]!.requeued, true);
        transport.clearFailure();
        const retryStart = transport.requests.length;
        await native.session.agent.prompt("Owned explicit new native request after failure.");
        await native.session.waitForIdle();
        assert.deepEqual(transport.requests[retryStart]!.body.tool_choice, { type: "function", name: "force_fixture" });
        assert.equal(native.controller.getState().directives[0]!.id, arm.receipt!.directiveId);
        assert.equal(native.controller.getState().directives[0]!.phase, "pending-final-response");
        await native.session.agent.prompt("Owned final response after replay.");
        await native.session.waitForIdle();
        assert.equal(transport.requests.at(-1)!.body.tool_choice, "none");
        assert.deepEqual(native.controller.getState().directives, []);
        observations.push({ label, api: model.api, first: transport.requests[start]!.body.tool_choice,
          second: transport.requests.at(-1)!.body.tool_choice, availability: native.controller.getState().availability.state });
      } finally { transport.clearFailure(); unsubscribe(); await native.close(); }
    }
  } else if (group === "azure") {
    const original = fixture.model("azure-openai-responses", candidate => candidate.id === "gpt-5.4");
    const model = { ...original, baseUrl: "https://force-native.openai.azure.com/openai/v1" };
    for (const named of [true, false]) await runCase(`azure-actual-forwarding-named-${named}`, { ...model, compat: { ...model.compat, supportsNamedToolChoice: named } }, {
      state: named ? "supported" : "degraded",
      check(first, second) {
        const url = new URL(first.url); assert.equal(url.pathname, "/openai/v1/responses"); assert.equal(url.searchParams.get("api-version"), "v1");
        assert.equal(first.headers.get("api-key"), fixture.inertKey); assert.equal(first.headers.has("authorization"), false);
        assert.deepEqual(first.body.tool_choice, { type: "function", name: "force_fixture" });
        assert.ok(first.body.tools!.length > 1, "Distinct Azure adapter does not apply common Responses string-only narrowing.");
        assert.equal(second.body.tool_choice, "none");
      },
    });
    await runCase("azure-native-computer-forwarding", { ...model, supportsComputerUse: true }, {
      prepare(session) { updateSelectedTool(session, { native: { type: "computer" } }); },
      check(first, second) { assert.deepEqual(first.body.tool_choice, { type: "computer" });
        assert.ok(first.body.tools!.some(tool => tool.type === "computer")); assert.equal(second.body.tool_choice, "none"); },
    });
    await runCase("azure-distinct-no-common-quarantine", model, {
      prepare(session) { updateSelectedTool(session, { parameters: { type: "object", properties: { impossible: { type: "string", enum: [1] } }, required: ["impossible"], additionalProperties: false } }); },
      check(first, second) { assert.deepEqual(first.body.tool_choice, { type: "function", name: "force_fixture" });
        assert.ok(first.body.tools!.some(tool => tool.name === "force_fixture")); assert.equal(second.body.tool_choice, "none"); },
    });
  } else if (group === "completions") {
    const model = fixture.model("openai-completions", candidate => candidate.provider === "groq" && candidate.id === "llama-3.3-70b-versatile");
    await runCase("completions-named", model, { check(first, second) {
      assert.deepEqual(first.body.tool_choice, { type: "function", function: { name: "force_fixture" } }); assert.equal(second.body.tool_choice, "none");
    } });
    await runCase("completions-narrowed-required", { ...model, compat: { ...model.compat, supportsNamedToolChoice: false } }, { check(first, second) {
      assert.equal(first.body.tool_choice, "required"); assert.deepEqual(first.body.tools!.map((tool: ForceWireTool) => tool.function?.name), ["force_fixture"]); assert.equal(second.body.tool_choice, "none");
    } });
    await runCase("completions-no-tool-choice", { ...model, compat: { ...model.compat, supportsToolChoice: false } }, { state: "degraded", check(first, second) {
      assert.equal(first.body.tool_choice, undefined); assert.equal(second.body.tool_choice, undefined); assert.ok(first.body.tools!.some((tool: ForceWireTool) => tool.function?.name === "force_fixture"));
    } });
    await runCase("completions-forced-downgrade", { ...model, compat: { ...model.compat, supportsForcedToolChoice: false } }, { state: "degraded", check(first, second) {
      assert.equal(first.body.tool_choice, "auto"); assert.equal(second.body.tool_choice, "none");
    } });
    await runCase("completions-missing-emitted-name", model, {
      prepare(session) { updateSelectedTool(session, { parameters: { type: "object", properties: { impossible: { type: "string", enum: [1] } }, required: ["impossible"], additionalProperties: false } }); },
      check(first, second) { assert.equal(first.body.tool_choice, undefined); assert.ok(first.body.tools!.every((tool: ForceWireTool) => tool.function?.name !== "force_fixture")); assert.equal(second.body.tool_choice, "none"); },
    });
    const kimi = fixture.model("openai-completions", candidate => candidate.provider === "moonshot" && candidate.id === "kimi-k3" && candidate.compat !== undefined && "nativeKimiK3Reasoning" in candidate.compat && candidate.compat.nativeKimiK3Reasoning === true && candidate.reasoning);
    await runCase("completions-native-kimi-k3", kimi, { thinking: "high", state: "degraded", check(first, second) {
      assert.equal(first.body.tool_choice, "required"); assert.ok(first.body.tools!.length > 1); assert.equal(second.body.tool_choice, "none");
    } });
  } else if (group === "anthropic") {
    const model = fixture.model("anthropic-messages", candidate => candidate.provider === "anthropic" && candidate.id === "claude-sonnet-4-5");
    await runCase("anthropic-forced-thinking", model, { thinking: "high", check(first, second) {
      assert.deepEqual(first.body.tool_choice, { type: "tool", name: "force_fixture" }); assert.equal(first.body.thinking, undefined); assert.equal(first.body.context_management, undefined);
      assert.deepEqual(second.body.tool_choice, { type: "none" });
    } });
    await runCase("anthropic-oauth-encoded-name", model, { credential: "fixture-sk-ant-oat-force-native-not-auth", check(first, second) {
      const choice = first.body.tool_choice;
      assert.ok(choice && typeof choice === "object" && "name" in choice && typeof choice.name === "string");
      const chosen = choice.name;
      assert.notEqual(chosen, "force_fixture", "OAuth name encoding must actually change this nonbuiltin tool name.");
      assert.ok(first.body.tools!.some((tool: ForceWireTool) => tool.name === chosen)); assert.deepEqual(second.body.tool_choice, { type: "none" });
    } });
    for (const id of ["claude-fable-5", "claude-mythos-5"]) {
      const required = fixture.model("anthropic-messages", candidate => candidate.provider === "anthropic" && candidate.id === id);
      await runCase(`anthropic-${id}-native-downgrade`, required, { thinking: "high", state: "degraded", check(first, second) {
        assert.deepEqual(first.body.tool_choice, { type: "auto" }); assert.ok(first.body.thinking); assert.deepEqual(second.body.tool_choice, { type: "none" });
      } });
    }
    await runCase("anthropic-required-thinking-compat", { ...model, compat: { ...model.compat, supportsForcedToolChoice: false } }, { thinking: "high", state: "degraded", check(first, second) {
      assert.deepEqual(first.body.tool_choice, { type: "auto" }); assert.ok(first.body.thinking); assert.deepEqual(second.body.tool_choice, { type: "none" });
    } });
  } else if (group === "bedrock") {
    const model = fixture.model("bedrock-converse-stream", candidate => candidate.provider === "amazon-bedrock" && candidate.id === "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
    await runCase("bedrock-forced-removes-thinking", model, { thinking: "high", check(first, second) {
      assert.deepEqual(first.body.toolConfig!.toolChoice, { tool: { name: "force_fixture" } }); assert.equal(first.body.additionalModelRequestFields, undefined);
      assert.match(first.headers.get("authorization") ?? "", /^AWS4-HMAC-SHA256 /); assert.equal(second.body.toolConfig, undefined);
    } });
    const prefix = fixture.model("bedrock-converse-stream", candidate => candidate.id === "us.anthropic.claude-fable-5-1" && !!candidate.thinking?.prefixBinding);
    await runCase("bedrock-prefix-thinking-auto", prefix, { thinking: "high", state: "degraded", check(first, second) {
      assert.deepEqual(first.body.toolConfig!.toolChoice, { auto: {} }); assert.ok(first.body.additionalModelRequestFields); assert.equal(second.body.toolConfig, undefined);
    } });
    for (const empty of [false, true]) await runCase(`bedrock-none-history-empty-${empty}`, model, {
      beforeSecond(session) {
        // Actual native history conversion, not a fake toolConfig mapper. The none
        // leg is non-named, so removing all active tools does not reject its root.
        session.agent.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "owned-history-call", name: "force_fixture", arguments: {} }],
          api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: 1,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
        session.agent.appendMessage({ role: "toolResult", toolCallId: "owned-history-call", toolName: "force_fixture", content: [{ type: "text", text: "owned historical result" }], isError: false, timestamp: 2 });
        if (empty) session.agent.setTools([]);
      },
      check(first, second) { assert.deepEqual(first.body.toolConfig!.toolChoice, { tool: { name: "force_fixture" } });
        if (empty) { assert.equal(second.body.toolConfig!.tools.length, 1); assert.deepEqual(second.body.toolConfig!.toolChoice, { auto: {} }); assert.notEqual(second.body.toolConfig!.tools[0]?.toolSpec?.name, "force_fixture"); }
        else { assert.ok(second.body.toolConfig!.tools.some((tool: ForceWireTool) => tool.toolSpec?.name === "force_fixture")); assert.equal(second.body.toolConfig!.toolChoice, undefined); }
      },
    });
  } else if (group === "ollama") {
    const model = fixture.model("ollama-chat");
    await runCase("ollama-narrowed-required-and-none", model, { check(first, second) {
      assert.equal(first.body.tool_choice, "required"); assert.deepEqual(first.body.tools!.map((tool: ForceWireTool) => tool.function?.name), ["force_fixture"]); assert.equal(second.body.tool_choice, "none");
    } });
    await runCase("ollama-missing-offered-name-still-required", model, {
      contextFiltered: true,
      // Controlled offered-context boundary after native queue admission. This
      // characterizes the pinned mapper; it does not prove an App removal race.
      prepare(session) {
        const original = session.agent.streamFn;
        session.agent.streamFn = (model, context, options) => original(model,
          { ...context, tools: context.tools?.filter(tool => tool.name !== "force_fixture") }, options);
      },
      check(first, second) { assert.equal(first.body.tools, undefined); assert.equal(first.body.tool_choice, "required"); assert.equal(second.body.tool_choice, "none"); },
    });
  } else throw new Error(`Unknown force provider fixture group ${group}`);
  console.log(JSON.stringify({ evidenceClass: "production-controller-real-AgentSession-original-Agent-loop-stream-and-pinned-provider-builders; controlled-fetch-and-SigV4; no live-provider acceptance", group, observations }));
} finally { fixture.auth.close(); }
