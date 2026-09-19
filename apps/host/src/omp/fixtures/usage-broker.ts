import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const directory = process.argv[2]!; assert.equal(process.env.HOME, directory);
const actualFetch = globalThis.fetch; let brokerReads = 0, providerReads = 0, consumes = 0;
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === "https://chatgpt.com" && url.pathname === "/backend-api/wham/rate-limit-reset-credits")
    return Response.json({ available_count: 1, credits: [{ id: "broker-fixture-credit", status: "available", expires_at: "2099-01-01T00:00:00Z" }] });
  if (url.pathname.endsWith("/consume")) { consumes++; throw new Error("Unexpected fixture consume."); }
  if (url.hostname !== "127.0.0.1") throw new Error("Nonlocal fetch prohibited in native broker fixture.");
  if (url.pathname === "/v1/usage") brokerReads++;
  return actualFetch(input, init);
}, { preconnect() {} }) as typeof fetch;
const { AuthStorage } = await import("@oh-my-pi/pi-ai");
const { startAuthBroker } = await import("@oh-my-pi/pi-ai/auth-broker/server");
const { resolveCredentialIdentityKey } = await import("@oh-my-pi/pi-ai/auth/sqlite-credential-store");
const canonical = await AuthStorage.create(path.join(directory, "canonical.db"), { usageFetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init); assert.equal(new URL(request.url).pathname, "/backend-api/wham/usage");
  providerReads++; if (request.method === "POST") consumes++;
  return Response.json({ plan_type: "plus", rate_limit: { allowed: true, limit_reached: false,
    primary_window: { used_percent: 11, limit_window_seconds: 18000, reset_at: 4_000_000_000 } } });
}, { preconnect() {} }) as typeof fetch });
const credentials = ["first", "second"].map(id => ({ type: "oauth" as const, access: `fixture-private-${id}`, refresh: `fixture-refresh-${id}`,
  accountId: id, email: `${id}@fixture.invalid`, orgId: `org-${id}`, expires: Date.now() + 86_400_000 }));
await canonical.set("openai-codex", credentials);
const broker = startAuthBroker({ storage: canonical, bind: "127.0.0.1:0", bearerTokens: ["fixture-broker-token"], disableRefresher: true });
const agentDir = path.join(directory, "agent"), cwd = path.join(directory, "project");
await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
await writeFile(path.join(agentDir, "config.yml"), `extensions: []\nauth:\n  broker:\n    url: ${broker.url}\n    token: fixture-broker-token\ncodexResets:\n  autoRedeem: yes\n`);
await writeFile(path.join(agentDir, "models.yml"), JSON.stringify({ providers: { "usage-fixture": { api: "openai-completions", baseUrl: "http://127.0.0.1:1", auth: "none", models: ["model", "other-model"].map(id => ({ id, name: "Fixture", contextWindow: 10000, maxTokens: 1024, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) } } }));
const { createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, AgentRegistry, Settings } = await import("@oh-my-pi/pi-coding-agent");
const { NativeSessionUsage } = await import("../session-usage");
const { discoverAuthStorage: discoverScopedAuthStorage } = await import("@oh-my-pi/pi-coding-agent/session/auth-broker-config");
const auth = await discoverScopedAuthStorage(agentDir, { accountPool: new Map([["openai-codex", new Set([resolveCredentialIdentityKey("openai-codex", credentials[0]!)!])]]) });
const settings = await Settings.loadReadOnly({ agentDir, cwd });
const registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings });
const manager = SessionManager.create(cwd, path.join(agentDir, "sessions"));
let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined, controller: InstanceType<typeof NativeSessionUsage> | undefined;
try {
  session = (await createAgentSession({ agentDir, cwd, settings, authStorage: auth, modelRegistry: registry,
    agentRegistry: new AgentRegistry(), sessionManager: manager, model: registry.find("usage-fixture", "model"), hasUI: false, interactivePrompts: false, deferUsageReserveConfirmation: true })).session;
  controller = new NativeSessionUsage(session, () => { assert(!session!.isStreaming); }, () => {});
  const reports = await controller.read("reports"); assert(reports);
  assert.equal(reports.reports.length, 1, JSON.stringify(reports.reports)); assert.equal(reports.reports[0]!.identity.accountId, "first");
  assert(brokerReads > 0); assert.equal(providerReads, 2); assert.equal(consumes, 0);
  assert.equal(auth.listOAuthAccounts("openai-codex", session.sessionId).length, 1);
  const loaded = (await controller.read("credits"))!;
  const prepared = await controller.prepare({ sessionId: session.sessionId, epoch: loaded.epoch, revision: loaded.revision, accountRef: loaded.credits[0]!.accountRef });
  session.settings.set("codexResets.keepCredits", 1);
  assert.deepEqual(await controller.redeem(prepared.ticket, "policy-must-not-send"), { state: "rejected", outcome: "admission_rejected" });
  const selected = (await controller.read("credits"))!;
  const modelPrepared = await controller.prepare({ sessionId: session.sessionId, epoch: selected.epoch, revision: selected.revision, accountRef: selected.credits[0]!.accountRef });
  await session.setModel(registry.find("usage-fixture", "other-model")!);
  assert.deepEqual(await controller.redeem(modelPrepared.ticket, "model-must-not-send"), { state: "rejected", outcome: "admission_rejected" });
  assert.equal(consumes, 0);
  // Native runtime overrides suppress OAuth credits; the adapter doesn't create another store.
  auth.setRuntimeApiKey("openai-codex", "fixture-runtime-override");
  const credits = await controller.read("credits"); assert.equal(credits!.credits.length, 0); assert.equal(consumes, 0);
  assert(!JSON.stringify(reports).includes("fixture-private"));
  process.stdout.write(JSON.stringify({ brokerReportRoute: true, poolFiltered: true, canonicalProviderReads: 2, runtimeOverrideSuppressedOAuth: true, nativePolicyAndModelGuards: true, consumes }) + "\n");
} finally { controller?.dispose(); await session?.dispose(); auth.close(); await broker.close(); canonical.close(); }
