// Run only in a disposable child HOME. Assertions exercise the production entry,
// original session account bridge, native parser/handler and actual Codex SSE.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { WorkerRuntime } from "../../omp-workers/runtime";
import type { WorkerSession } from "../../omp-workers/runtime";
import type { OmpPromptRun } from "../prompt";
import { prepareSessionPinFixture } from "./session-pin-controlled";
import type { SessionPinRequest } from "./session-pin-controlled";

const directory = process.argv[2]!, scenario = process.argv[3]!;
assert.equal(process.env.HOME, directory);
assert.ok(["selection", "boundaries", "shadows"].includes(scenario));
const fixture = await prepareSessionPinFixture(directory);
const runtime = new WorkerRuntime({ agentDir: fixture.agentDir, environment: fixture.environment,
  workerPath: fixture.workerPath, startupTimeoutMs: 30_000 });
const result: Record<string, unknown> = { scenario, checks: [], author: {
  provider: "openai-codex", model: "gpt-6-astra", thinking: "high", sessionId: "01a0bcd1-0cb4-7606-9491-7d9cd5433f73",
  source: "PinNative.jsonl model_change and actual assistant metadata; verified by Main before authoring",
} };
const checks: string[] = [];
const errors: unknown[] = [];
interface FailureEvidence { name: string; message: string; stack?: string; cause?: FailureEvidence; errors?: FailureEvidence[] }
function failureEvidence(error: unknown): FailureEvidence {
  if (!(error instanceof Error)) return { name: "NonError", message: String(error) };
  return { name: error.name, message: error.message, stack: error.stack,
    ...(error.cause !== undefined ? { cause: failureEvidence(error.cause) } : {}),
    ...(error instanceof AggregateError ? { errors: error.errors.map(failureEvidence) } : {}) };
}
async function command(session: WorkerSession, text: string) {
  const run = session.startPrompt(text), receipt = await run.accepted;
  assert.equal(await run.completion, false, `Local command must not invoke provider: ${text}`);
  assert.equal(receipt?.kind, "native-command");
  if (receipt?.kind !== "native-command") throw new Error("Expected native command receipt");
  assert.equal(receipt.command, "session");
  return receipt;
}
async function active(session: WorkerSession) {
  const view = await session.listAccountChoices();
  assert.equal(view.sessionId, session.id);
  return view.accounts.find(account => account.active)?.accountId;
}
async function rejected(run: OmpPromptRun, pattern: RegExp, code?: string) {
  const outcomes = await Promise.allSettled([run.accepted, run.completion]);
  const failures = outcomes.map((outcome, index) => {
    assert.equal(outcome.status, "rejected", "Failure must not become an acceptance receipt");
    if (outcome.status !== "rejected") throw new Error("Expected rejection");
    const error = outcome.reason;
    assert.ok(error instanceof Error); assert.match(error.message, pattern);
    if (code && index === 0) assert.equal((error as Error & { code?: string }).code, code);
    return { name: error.name, message: error.message, code: (error as Error & { code?: string }).code };
  });
  return failures;
}
async function turn(session: WorkerSession, text: string) {
  const run = session.startPrompt(text);
  assert.equal((await run.accepted)?.kind, "user-message");
  assert.equal(await run.completion, true);
  const messages = await session.getMessages();
  assert.ok(messages.some(message => message.role === "assistant" && message.text.includes("Controlled session pin response")), "Real SSE must produce assistant output");
}
async function requests(): Promise<SessionPinRequest[]> {
  return (await readFile(fixture.requestsFile, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}
try {
  const models = await runtime.listModels(fixture.cwd);
  assert.ok(models.some(model => model.provider === fixture.model.provider && model.id === fixture.model.id), "Bundled Codex model required");
  if (scenario === "selection") {
    let first = await runtime.create({ cwd: fixture.cwd, model: fixture.model });
    const second = await runtime.create({ cwd: fixture.cwd, model: fixture.model });
    const originalId = first.id, originalFile = first.sessionFile;
    const view = await first.listAccountChoices();
    assert.equal(view.providerId, fixture.model.provider); assert.deepEqual(view.selection?.model, fixture.model);
    assert.deepEqual(view.accounts.map(account => account.accountId), fixture.accounts.map(account => account.accountId));
    assert.equal(new Set(view.accounts.map(account => account.credentialId)).size, 3);
    const listed = await command(first, "/session pin");
    assert.ok(listed.output?.includes("alpha@fixture.invalid") && listed.output.includes("South Research Team") && listed.output.includes("West Research Team"));
    assert.equal(await active(first), undefined, "Listing must not select an account");
    await command(first, "/session pin 2"); assert.equal(await active(first), "pin-beta");
    await assert.rejects(first.pinAccount(view.accounts[0]!.credentialId, view.selection), /selection changed/);
    assert.equal(await active(first), "pin-beta", "Stale original UI selection must not replace command selection");
    await command(first, "/session pin active"); assert.equal(await active(first), "pin-beta");
    await command(first, "/session pin pin-gamma"); assert.equal(await active(first), "pin-gamma");
    await command(first, "/session\tPiN\t  NORTH Research TEAM  "); assert.equal(await active(first), "pin-alpha");
    await command(first, "/session:pin duplicate@fixture.invalid (South Research Team)"); assert.equal(await active(first), "pin-beta");
    for (const [text, pattern] of [
      ["/session pin duplicate@fixture.invalid", /matches multiple/],
      ["/session pin missing-account", /No .* account matches/],
      ["/session pin South Research", /No .* account matches/],
      ["/session pin 999", /No .* account matches/],
    ] as const) {
      assert.match((await command(first, text)).output ?? "", pattern); assert.equal(await active(first), "pin-beta");
    }
    await command(second, "/session pin 3");
    assert.equal(await active(second), "pin-gamma"); assert.equal(await active(first), "pin-beta");
    assert.equal((await requests()).length, 0, "All selector and refusal commands stay local");
    checks.push("list-and-selectors", "full-native-remainder", "duplicate-and-unknown-refusal", "stale-ui-token", "independent-sessions");
    const beforeOutput = await fixture.control(first.workerPid, { op: "snapshot" }) as { pins: unknown[] };
    assert.deepEqual(beforeOutput.pins, [], "Command output flush does not create a session-file credential pin");

    // First establish durable A through successful output, not desktop pinAccount.
    await command(first, "/session pin 1");
    await turn(first, "session-pin establish alpha");
    const savedAlpha = await fixture.control(first.workerPid, { op: "snapshot" }) as { pins: unknown[] };
    assert.equal(savedAlpha.pins.length, 1, "Successful assistant output records the serving provider");
    await command(first, "/session pin 2");
    assert.equal(await active(first), "pin-beta", "Command selects B immediately in live auth");
    const commandOnly = await fixture.control(first.workerPid, { op: "snapshot" }) as { pins: unknown[] };
    assert.deepEqual(commandOnly.pins, savedAlpha.pins, "Command does not rewrite the journal's served-account pin");
    const livePid = first.workerPid;
    await first.dispose();
    first = await runtime.open({ sessionFile: originalFile });
    assert.equal(first.id, originalId); assert.notEqual(first.workerPid, livePid);
    // Local AuthStorage also persists its routing cache. This is NOT a new
    // journal credential_pin and must not be misreported as session-file proof.
    assert.equal(await active(first), "pin-beta", "Local auth cache may retain the command-selected account across restart");
    const cachedBeta = await fixture.control(first.workerPid, { op: "snapshot" }) as { pins: unknown[] };
    assert.deepEqual(cachedBeta.pins, savedAlpha.pins);
    await command(first, "/session pin 2");
    await turn(first, "session-pin serve beta full payload");
    const savedBeta = await fixture.control(first.workerPid, { op: "snapshot" }) as { pins: unknown[] };
    assert.notDeepEqual(savedBeta.pins, savedAlpha.pins, "The successful B turn records its account in the session journal");
    // Public native release clears the auth sticky without recording a new pin.
    // Reopening can now restore B only from the original session's served pin.
    const servedView = await first.listAccountChoices();
    const released = await first.releaseAccountForReselection(servedView.selection);
    assert.equal(released.accounts.some(account => account.active), false);
    const releasedState = await fixture.control(first.workerPid, { op: "snapshot" }) as { pins: unknown[] };
    assert.deepEqual(releasedState.pins, savedBeta.pins);
    const servedPid = first.workerPid;
    await first.dispose();
    first = await runtime.open({ sessionFile: originalFile });
    assert.equal(first.id, originalId); assert.notEqual(first.workerPid, servedPid);
    assert.equal(await active(first), "pin-beta", "Successful assistant turn records B for cold original reopen");
    await turn(first, "session-pin cold beta continuation");
    const observed = await requests();
    assert.deepEqual(observed.map(request => request.accountId), ["pin-alpha", "pin-beta", "pin-beta"]);
    assert.ok(observed.every(request => request.sessionId === originalId && request.model === fixture.model.id));
    assert.ok(JSON.stringify(observed[1]!.input).includes("session-pin serve beta full payload"));
    assert.ok(JSON.stringify(observed[2]!.input).includes("session-pin cold beta continuation"));
    assert.ok(observed.every(request => typeof request.instructions === "string" && request.instructions.length > 0));
    assert.equal(await active(second), "pin-gamma");
    const snapshot = await fixture.control(first.workerPid, { op: "snapshot" }) as { blockedRequests: number; blockedPreconnects: number };
    assert.equal(snapshot.blockedRequests, 0);
    result.network = { refusedRequests: snapshot.blockedRequests, refusedPreconnects: snapshot.blockedPreconnects };
    checks.push("command-does-not-record-journal-pin", "local-auth-cache-distinguished", "real-provider-account-and-payload", "cold-original-session-restoration");
    result.persistence = { originalId, originalFile, accountSequence: observed.map(request => request.accountId), requests: observed.length,
      journalBeforeOutput: beforeOutput.pins, journalAfterAlpha: savedAlpha.pins, journalAfterCommand: commandOnly.pins,
      journalAfterBeta: savedBeta.pins, authCacheReleasedBeforeColdReopen: true };
  } else if (scenario === "boundaries") {
    const session = await runtime.create({ cwd: fixture.cwd, model: fixture.model });
    await command(session, "/session pin 1");
    const receipts: Record<string, unknown> = {};
    receipts.malformed = await rejected(session.startPrompt(" /session pin 2"), /must begin at the start/);
    receipts.pendingDelete = await rejected(session.startPrompt("/session delete"), /not connected/);
    assert.equal(await active(session), "pin-alpha");
    const noModel = await fixture.control(session.workerPid, { op: "dispatch", text: "/session pin 2", noModel: true }) as { output: string };
    assert.match(noModel.output, /Select a model/); assert.equal(await active(session), "pin-alpha");
    receipts.noModel = { output: noModel.output, seam: "temporary missing-model getter on original native session" };
    const apiModel = models.find(model => model.provider === "openai"); assert.ok(apiModel);
    await session.setModel(apiModel);
    const noAccounts = await command(session, "/session pin 1");
    assert.match(noAccounts.output ?? "", /No stored OAuth accounts/); assert.match(noAccounts.output ?? "", /Current auth comes from/);
    const otherView = await session.listAccountChoices();
    assert.equal(otherView.providerId, "openai"); assert.equal(otherView.accounts.length, 0);
    receipts.noAccounts = noAccounts;
    await session.setModel(fixture.model);
    assert.equal(await active(session), "pin-alpha");
    await fixture.control(session.workerPid, { op: "fault", boundary: "read" });
    try {
      receipts.readPreflight = await rejected(session.startPrompt("/session pin 2"), /Controlled session-pin read boundary failure/);
      const readError = await fixture.control(session.workerPid, { op: "dispatch", text: "/session pin 2" }) as { output: string; handledCommand: string; agentInvoked: boolean };
      assert.equal(readError.handledCommand, "session"); assert.equal(readError.agentInvoked, false);
      assert.match(readError.output ?? "", /Could not load provider accounts: Controlled session-pin read boundary failure/);
      receipts.read = readError;
    } finally { await fixture.control(session.workerPid, { op: "restore" }); }
    assert.equal(await active(session), "pin-alpha");
    for (const boundary of ["output", "flush"] as const) {
      await fixture.control(session.workerPid, { op: "fault", boundary });
      try { receipts[boundary] = await rejected(session.startPrompt(`/session pin ${boundary === "output" ? "2" : "3"}`), new RegExp(`Controlled session-pin ${boundary} boundary failure`), "OUTCOME_UNKNOWN"); }
      finally { await fixture.control(session.workerPid, { op: "restore" }); }
      assert.equal(await active(session), boundary === "output" ? "pin-beta" : "pin-gamma", "Post-effect error must not invent rollback");
    }
    checks.push("malformed-and-pending-refusal", "native-no-model-boundary", "current-provider-auth-source", "read-error-consumed-output", "post-effect-output-and-flush-errors");
    fixture.hold();
    const running = session.startPrompt("session-pin hold real streaming turn");
    const streamingErrors: unknown[] = [];
    try {
      assert.equal((await running.accepted)?.kind, "user-message");
      await fixture.waitForRequests(1);
      receipts.busy = await rejected(session.startPrompt("/session pin 1"), /running|busy|streaming|progress|wait/i);
      const streaming = await fixture.control(session.workerPid, { op: "dispatch", text: "/session pin 1" }) as { output: string };
      assert.match(streaming.output, /Cannot pin an account while the session is streaming/);
      assert.equal(await active(session), "pin-gamma");
      receipts.streaming = streaming;
    } catch (error) { streamingErrors.push(error); }
    finally {
      fixture.release();
      try { await running.completion; } catch (error) { streamingErrors.push(error); }
    }
    if (streamingErrors.length) throw streamingErrors.length === 1 ? streamingErrors[0]
      : new AggregateError(streamingErrors, "Streaming assertion failed before turn drain failed", { cause: streamingErrors[0] });
    assert.equal((await requests())[0]?.accountId, "pin-gamma");
    checks.push("public-busy-refusal", "native-streaming-refusal");
    await session.dispose();
    // A retired original owner cannot grant a native-command acceptance receipt.
    try { receipts.deadOwner = await rejected(session.startPrompt("/session pin 1"), /closed|closing|exited|disposed|stopping/i); }
    catch (error) {
      assert.ok(error instanceof Error); assert.match(error.message, /closed|closing|exited|disposed|stopping/i);
      receipts.deadOwner = { name: error.name, message: error.message };
    }
    checks.push("retired-owner-refusal"); result.receipts = receipts;
  } else {
    const effect = path.join(directory, "shadow-effects.jsonl"), extension = path.join(directory, "pin-extension.ts");
    const commandDir = path.join(fixture.agentDir, "commands", "session"); await mkdir(commandDir, { recursive: true });
    await writeFile(path.join(commandDir, "index.ts"), `import { appendFile } from "node:fs/promises";\nexport default () => ({ name: "session", description: "Controlled native custom shadow", async execute(args) { await appendFile(${JSON.stringify(effect)}, JSON.stringify({kind:"custom",args})+"\\n"); } });\n`);
    await writeFile(extension, `import { appendFile } from "node:fs/promises";\nexport default function(pi) { pi.registerCommand("session", {description:"Controlled extension shadow", async handler(args) { await appendFile(${JSON.stringify(effect)}, JSON.stringify({kind:"extension",args})+"\\n"); }}); }\n`);
    await writeFile(path.join(fixture.agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(extension)}\ndefaultThinkingLevel: low\n`);
    const extensionSession = await runtime.create({ cwd: fixture.cwd, model: fixture.model });
    await command(extensionSession, "/session pin South Research Team");
    assert.equal(await active(extensionSession), undefined);
    await extensionSession.dispose();
    await writeFile(path.join(fixture.agentDir, "config.yml"), "extensions: []\ndefaultThinkingLevel: low\n");
    const customSession = await runtime.create({ cwd: fixture.cwd, model: fixture.model });
    await command(customSession, "/session pin South Research Team");
    assert.equal(await active(customSession), undefined);
    const effects = (await readFile(effect, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(effects, [{ kind: "extension", args: "pin South Research Team" }, { kind: "custom", args: ["pin", "South", "Research", "Team"] }]);
    assert.equal((await requests()).length, 0);
    checks.push("real-extension-shadows-custom-and-builtin", "real-custom-shadows-builtin"); result.effects = effects;
  }
  result.checks = checks;
} catch (error) { errors.push(error); }
finally {
  fixture.release();
  try { await runtime.dispose(); } catch (error) { errors.push(error); }
  try { await fixture.stop(); } catch (error) { errors.push(error); }
}
if (errors.length) {
  await writeFile(path.join(directory, "result.json"), JSON.stringify({ ...result, ok: false, errors: errors.map(failureEvidence) }, null, 2));
  throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Native session-pin failure; first error is primary");
}
await writeFile(path.join(directory, "result.json"), JSON.stringify({ ...result, ok: true }, null, 2));
process.stdout.write(`session-pin ${scenario}: passed; result.json\n`);
