import assert from "node:assert/strict";
import path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { parseForceToolReceipt } from "../../../../../packages/shared/src/force-tool";
import { createForceFixture } from "./force-native-fixture";

const fixture = await createForceFixture(path.resolve(process.argv[2] ?? ""));
let current = await fixture.create(fixture.model("openai-responses"));
const covered: string[] = [];
try {
  const { session, controller } = current;
  assert.ok(session.getActiveToolNames().includes("force_extension"), "Actual inline extension registration must be active.");
  const beforeUsage = session.toolChoiceQueue.snapshot();
  const usage = controller.captureArm({ commandId: "usage", toolName: "", promptRequested: false }, () => current.invoke(""));
  await usage.result;
  assert.deepEqual(parseForceToolReceipt(usage.receipt), { commandId: "usage", epoch: controller.epoch, toolName: "", arm: "not-armed", prompt: "not-requested" });
  assert.deepEqual(session.toolChoiceQueue.snapshot(), beforeUsage);
  for (const toolName of ["inactive-tool", "force_fixture"]) {
    const fresh = controller.getState();
    try {
      controller.captureArm({ commandId: "definite-refusal", toolName, promptRequested: true,
        ...(toolName === "force_fixture" ? { guard: { epoch: "old-worker", expectedRevision: fresh.revision, toolName } } : {}) }, () => { throw new Error("Must not invoke stale/inactive handler"); });
      assert.fail("Expected before-arm refusal");
    } catch (error) {
      assert.ok(error instanceof Error && "forceToolReceipt" in error);
      assert.deepEqual(parseForceToolReceipt(error.forceToolReceipt), { commandId: "definite-refusal", epoch: controller.epoch, toolName, arm: "not-armed", prompt: "not-recorded" });
    }
  }
  covered.push("definite-usage-missing-tool-stale-guard-not-armed");
  current.setBusyReason("other native admission");
  try {
    controller.captureArm({ commandId: "busy-refusal", toolName: "force_fixture", promptRequested: false }, () => { throw new Error("Busy handler must not run"); });
    assert.fail("Expected busy refusal");
  } catch (error) {
    assert.ok(error instanceof Error && "forceToolReceipt" in error);
    assert.equal(parseForceToolReceipt(error.forceToolReceipt).arm, "not-armed");
  } finally { current.setBusyReason(); }
  covered.push("definite-busy-not-armed");
  const ticket = controller.getState();
  const outputFailure = new Error("owned output failure");
  const output = Promise.reject(outputFailure); output.catch(() => {});
  let originalResult: Promise<unknown> | undefined;
  const armed = controller.captureArm({ commandId: "output-reject", toolName: "force_extension", promptRequested: true,
    guard: { epoch: ticket.epoch, expectedRevision: ticket.revision, toolName: "force_extension" } }, () => {
    const result = current.invoke("force_extension remaining prompt", () => output);
    originalResult = result; return result;
  });
  assert.equal(armed.result, originalResult); assert.equal(armed.receipt?.arm, "armed");
  await assert.rejects(armed.result, outputFailure);
  assert.equal(armed.receipt?.arm, "armed"); assert.equal(armed.receipt?.prompt, "not-recorded");
  assert.equal(controller.getState().directives[0]?.id, armed.receipt?.directiveId);
  covered.push("original-handler-synchronous-arm-independent-async-output-rejection", "real-active-extension");
  const stale = controller.getState();
  await session.setActiveToolsByName(["force_fixture", "force_other"]);
  assert.throws(() => controller.captureArm({ commandId: "stale-tool", toolName: "force_extension", promptRequested: false,
    guard: { epoch: stale.epoch, expectedRevision: stale.revision, toolName: "force_extension" } }, () => current.invoke("force_extension")), /stale/);
  assert.equal(session.nextToolChoiceDirective(), undefined);
  assert.equal(controller.getState().directives.length, 0, "Native unavailable rejection drops the complete sequence.");
  covered.push("native-unavailable-drop", "registry-stale-ticket");
  const beforeOwnLease = controller.getState();
  current.setBusyReason("this prompt's async preflight lease");
  await Promise.resolve(); // An external read while the owning preflight is suspended.
  const externalRead = controller.getState();
  assert.equal(externalRead.canArm, false); assert.equal(externalRead.revision, beforeOwnLease.revision);
  current.setBusyReason(); // Only the existing admission owner enters this synchronous scope.
  const ownLeaseArm = controller.captureArm({ commandId: "own-lease", toolName: "force_fixture", promptRequested: true,
    guard: { epoch: beforeOwnLease.epoch, expectedRevision: beforeOwnLease.revision, toolName: "force_fixture" } }, () => current.invoke("force_fixture remaining"));
  await ownLeaseArm.result;
  const beforeRecoveryLease = controller.getState();
  current.setBusyReason("this recovery's async preflight lease");
  await Promise.resolve();
  assert.equal(controller.getState().revision, beforeRecoveryLease.revision);
  current.setBusyReason();
  controller.assertRecovery({ epoch: beforeRecoveryLease.epoch, expectedRevision: beforeRecoveryLease.revision, directiveId: ownLeaseArm.receipt!.directiveId! });
  controller.cancel({ ticket: controller.getState(), directiveId: ownLeaseArm.receipt!.directiveId! });
  covered.push("own-preflight-external-read-does-not-stale-capture-or-recovery");

  let opaqueAdvanced = 0;
  session.toolChoiceQueue.push((function* () { opaqueAdvanced++; yield "required" as const; })(), { label: "opaque-earlier" });
  const earlier = controller.captureArm({ commandId: "earlier", toolName: "force_other", promptRequested: false }, () => current.invoke("force_other")); await earlier.result;
  const target = controller.captureArm({ commandId: "recovery", toolName: "force_fixture", promptRequested: true }, () => current.invoke("force_fixture remaining")); await target.result;
  const pending = controller.getState();
  controller.assertRecovery({ epoch: pending.epoch, expectedRevision: pending.revision, directiveId: target.receipt!.directiveId! });
  assert.equal(opaqueAdvanced, 0, "Recovery must not advance an opaque earlier iterator or impose a guessed head rule.");
  current.setBusyReason("other admission owns the idle fence");
  assert.throws(() => controller.assertRecovery({ epoch: pending.epoch, expectedRevision: pending.revision, directiveId: target.receipt!.directiveId! }), /stale|fence/);
  current.setBusyReason();
  const fresh = controller.getState();
  controller.cancel({ ticket: fresh, directiveId: target.receipt!.directiveId! });
  assert.equal(session.nextToolChoiceDirective(), "required"); session.toolChoiceQueue.resolve();
  assert.equal(opaqueAdvanced, 1);
  assert.deepEqual(session.nextToolChoiceDirective(), { type: "function", name: "force_other" });
  session.toolChoiceQueue.reject("aborted");
  const replay = controller.getState();
  assert.equal(replay.directives[0]?.id, earlier.receipt?.directiveId); assert.equal(replay.directives[0]?.requeued, true);
  controller.cancel({ ticket: replay, directiveId: earlier.receipt!.directiveId! });
  assert.equal(session.nextToolChoiceDirective(), undefined);
  covered.push("atomic-recovery-current-idle-fence", "recovery-preserves-opaque-earlier-and-native-force-FIFO", "exact-replayed-cancel");

  const stop = session.toolChoiceQueue.subscribe(event => {
    if (event.type === "push") { stop(); session.toolChoiceQueue.pushOnce("required", { label: "unrelated-reentrant" }); }
  });
  const ambiguous = controller.captureArm({ commandId: "ambiguous", toolName: "force_fixture", promptRequested: false }, () => current.invoke("force_fixture"));
  await ambiguous.result;
  assert.equal(ambiguous.receipt?.arm, "unknown"); assert.equal(ambiguous.receipt?.directiveId, undefined);
  assert.equal(session.toolChoiceQueue.snapshot().directives.length, 2, "Ambiguity cannot roll back either native operation.");
  session.toolChoiceQueue.clear();
  let innerReceipt: unknown;
  const outer = controller.captureArm({ commandId: "nested-outer", toolName: "force_fixture", promptRequested: false }, () => current.invoke("force_fixture", async () => {
    const inner = controller.captureArm({ commandId: "nested-inner", toolName: "force_other", promptRequested: false }, () => current.invoke("force_other"));
    innerReceipt = inner.receipt; await inner.result;
  }));
  await outer.result;
  assert.equal(parseForceToolReceipt(innerReceipt).arm, "unknown");
  assert.equal(parseForceToolReceipt(outer.receipt).arm, "unknown");
  assert.equal(session.toolChoiceQueue.snapshot().directives.length, 2);
  session.toolChoiceQueue.clear();
  covered.push("nested-original-handler-capture-unknown");
  const synchronous = new Error("after native arm");
  try {
    controller.captureArm({ commandId: "sync-throw", toolName: "force_fixture", promptRequested: false }, () => {
      session.setForcedToolChoice("force_fixture"); throw synchronous;
    });
    assert.fail("Synchronous handler throw must propagate");
  } catch (error) {
    assert.ok(error instanceof Error && "forceToolReceipt" in error);
    assert.equal(parseForceToolReceipt(error.forceToolReceipt).arm, "armed"); assert.equal(error.cause, synchronous);
  }
  session.toolChoiceQueue.clear();
  covered.push("reentrant-ambiguity-no-rollback", "synchronous-after-arm-error-receipt");

  const beforeModel = controller.getState();
  const changedCompatModel = { ...session.model!, compat: { ...session.model!.compat, supportsNamedToolChoice: false } } as Model<Api>;
  session.agent.setModel(changedCompatModel);
  assert.throws(() => controller.captureArm({ commandId: "stale-model", toolName: "force_fixture", promptRequested: false,
    guard: { epoch: beforeModel.epoch, expectedRevision: beforeModel.revision, toolName: "force_fixture" } }, () => current.invoke("force_fixture")), /stale/);
  const beforeDialect = controller.getState();
  process.env.PI_DIALECT = "glm";
  assert.equal(controller.getState().availability.state, "degraded"); assert.equal(controller.getState().canArm, true);
  assert.throws(() => controller.captureArm({ commandId: "stale-dialect", toolName: "force_fixture", promptRequested: false,
    guard: { epoch: beforeDialect.epoch, expectedRevision: beforeDialect.revision, toolName: "force_fixture" } }, () => current.invoke("force_fixture")), /stale/);
  const inband = controller.captureArm({ commandId: "inband", toolName: "force_fixture", promptRequested: false }, () => current.invoke("force_fixture"));
  await inband.result; assert.equal(inband.receipt?.arm, "armed"); delete process.env.PI_DIALECT;
  current.setOwnershipReason("extension shadows native force"); assert.equal(controller.getState().canArm, false);
  assert.throws(() => controller.assertRecovery({ epoch: controller.epoch, expectedRevision: controller.getState().revision, directiveId: inband.receipt!.directiveId! }), /shadows/);
  current.setOwnershipReason();
  covered.push("same-model-compat-ticket-change", "actual-env-dialect-change-degraded-still-native-allowed", "original-owner-change");

  current.manager.appendCustomEntry("agent-desktop.force-tool.v1", inband.receipt!);
  await current.manager.ensureOnDisk();
  const file = current.manager.getSessionFile()!, oldEpoch = controller.epoch, model = session.model!;
  await current.close(); current = await fixture.create(model, { file });
  assert.notEqual(current.controller.epoch, oldEpoch); assert.deepEqual(current.controller.getState().directives, []);
  assert.ok(current.manager.getEntries().some(entry => entry.type === "custom" && entry.customType === "agent-desktop.force-tool.v1"));
  covered.push("worker-reconstruction-new-epoch-history-never-replays");

  for (const api of ["google-generative-ai", "google-gemini-cli", "google-vertex", "openrouter", "anthropic-vertex", "cursor", "force-unknown-api"] as const) {
    const previous = current.session.model!;
    current.session.agent.setModel({ ...previous, api } as typeof previous);
    const before = current.session.toolChoiceQueue.snapshot();
    assert.throws(() => current.session.setForcedToolChoice("force_fixture"), /does not support/);
    assert.deepEqual(current.session.toolChoiceQueue.snapshot(), before);
    assert.equal(current.controller.getState().availability.state, "unsupported");
    current.session.agent.setModel(previous);
  }
  covered.push("three-google-original-setter-rejections", "remaining-api-original-setter-rejections");
  // Native MCPManager + stdio protocol + refreshMCPTools own registration. A name
  // merely resembling an MCP name is not evidence of actual active membership.
  const { MCPManager } = await import("@oh-my-pi/pi-coding-agent/mcp/manager");
  const mcp = new MCPManager(fixture.cwd, null, async () => ({
    configs: { force: { type: "stdio" as const, command: process.execPath, args: ["--no-env-file", path.join(import.meta.dir, "mcp-server.ts")] } },
    sources: { force: { provider: "fixture", providerName: "Force fixture", path: path.join(fixture.cwd, "mcp.json"), level: "project" as const } },
    exaApiKeys: [],
  }));
  try {
    const loaded = await mcp.discoverAndConnect();
    await mcp.waitForConnection("force");
    await current.close(); current = await fixture.create(model, { mcpManager: mcp });
    await current.session.refreshMCPTools(loaded.tools);
    const mcpNames = loaded.tools.map(loadedTool => loadedTool.name);
    assert.ok(mcpNames.length > 0, "Controlled stdio server must return a real native MCP tool.");
    // refreshMCPTools mounts discoverable tools under xdev. Promote through the
    // native presentation API; enabling alone intentionally retains their mount.
    await current.session.setActiveToolPresentation(["force_fixture", ...mcpNames], []);
    for (const name of mcpNames) {
      assert.ok(current.controller.getState().tools.some(tool => tool.name === name));
      const capture = current.controller.captureArm({ commandId: `mcp-${name}`, toolName: name, promptRequested: false }, () => current.invoke(name));
      await capture.result; assert.equal(capture.receipt?.arm, "armed");
      current.controller.cancel({ ticket: current.controller.getState(), directiveId: capture.receipt!.directiveId! });
    }
    covered.push("real-active-mcp");
  } finally { await mcp.disconnectAll(); }
  console.log(JSON.stringify({ evidenceClass: "real-AgentSession-original-native-handler-controller; no provider requests", covered }));
} finally { await current.close(); fixture.auth.close(); }
