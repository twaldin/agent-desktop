// Isolated native-store/HTTP contracts. These credentials and the OAuth provider
// are fixtures, not proof of a live provider sign-in.
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerOAuthProvider, unregisterOAuthProvider } from "@oh-my-pi/pi-ai/registry";
import type { AccountAction, AccountInfo, CommandResult, LoginSnapshot, OmpInteraction, OmpInteractionResponse, ProviderCatalog, SessionSummary } from "@agent-desktop/shared";
import { startHost } from "../server";

const base = process.env.CONTRACT_DIRECTORY!;
assert(base);
const actualFetch = fetch;
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "127.0.0.1") throw new Error("External fetch blocked in account HTTP contract");
  return actualFetch(input, init);
}, { preconnect: () => {} }) as typeof fetch;
const agentDirectory = join(base, "native");
await mkdir(agentDirectory);
const extension = fileURLToPath(new URL("../omp-workers/fixtures/interaction-extension.ts", import.meta.url));
await writeFile(join(agentDirectory, "config.yml"), `extensions:\n  - ${JSON.stringify(extension)}\n`);
const host = await startHost({ dataDirectory: join(base, "host"), agentDirectory, discoveryDirectory: base,
  workerPath: fileURLToPath(new URL("../omp-workers/fixtures/no-provider-worker.ts", import.meta.url)) });
const providerId = "contract-http-oauth";
const submitted = "private-http-login-input";
const storedAccess = "private-http-access-token";
const storedRefresh = "private-http-refresh-token";
const apiKey = "private-http-api-key";
registerOAuthProvider({ id: providerId, name: "HTTP contract OAuth", login: async callbacks => {
  const value = await callbacks.onPrompt({ message: "Contract secret input", allowEmpty: false });
  assert.equal(value, submitted);
  return { access: storedAccess, refresh: storedRefresh, expires: Date.now() + 86_400_000, email: "contract@example.invalid" };
} });

const responses: unknown[] = [];
async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${host.connection.origin}${path}`, { headers: { Authorization: `Bearer ${host.connection.token}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const value = await response.json(); responses.push(value); return value as T;
}
async function action(value: AccountAction, status = 200) {
  const response = await fetch(`${host.connection.origin}/v1/accounts/actions`, {
    method: "POST", headers: { Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json" }, body: JSON.stringify(value),
  });
  assert.equal(response.status, status);
  const result = await response.json() as { login?: LoginSnapshot; accounts?: AccountInfo[]; error?: string };
  responses.push(result); return result;
}
let contractFailure: unknown;
try {
  const unauthenticated = await fetch(`${host.connection.origin}/v1/accounts/providers`);
  assert.equal(unauthenticated.status, 401);
  const origin = await fetch(`${host.connection.origin}/v1/accounts/providers`, { headers: { Authorization: `Bearer ${host.connection.token}`, Origin: "https://example.invalid" } });
  assert.equal(origin.status, 401);
  const catalog = await get<ProviderCatalog>("/v1/accounts/providers");
  assert(catalog.providers.some(provider => provider.id === "openai-codex" && provider.loginSupported));
  assert.equal(catalog.sessionSelectionConnected, true);
  const key = await action({ type: "key.set", providerId: "openai", key: apiKey });
  assert(key.accounts?.some(account => account.type === "api_key"));
  const keyId = key.accounts![0]!.credentialId;
  await action({ type: "key.set", providerId: "openai", key: "" }, 400);
  await action({ type: "credential.remove", providerId: "openai", credentialId: keyId });
  const started = (await action({ type: "login.start", providerId })).login!;
  let login = started;
  for (let attempts = 0; !login.prompts.length && attempts < 100; attempts++) {
    await Bun.sleep(10);
    login = (await get<LoginSnapshot[]>("/v1/accounts/logins")).find(value => value.loginId === started.loginId)!;
  }
  assert(login.prompts.length);
  const requestId = login.prompts[0]!.requestId;
  await action({ type: "login.respond", loginId: login.loginId, requestId, response: { value: submitted } });
  await action({ type: "login.respond", loginId: login.loginId, requestId, response: { value: submitted } }, 400);
  for (let attempts = 0; login.status === "running" && attempts < 100; attempts++) {
    await Bun.sleep(10);
    login = (await get<LoginSnapshot[]>("/v1/accounts/logins")).find(value => value.loginId === started.loginId)!;
  }
  assert.equal(login.status, "succeeded");
  assert.equal(login.auth, undefined);
  assert.equal(login.prompts.length, 0);
  assert.equal((await get<AccountInfo[]>(`/v1/accounts/credentials?provider=${providerId}`))[0]?.email, "contract@example.invalid");
  await action({ type: "key.set", providerId: "openai", key: apiKey });
  const sendCommand = async (command: unknown): Promise<CommandResult> => {
    const response = await fetch(`${host.connection.origin}/v1/commands`, {
      method: "POST", headers: { Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: crypto.randomUUID(), command }),
    });
    assert.equal(response.status, 200); return response.json() as Promise<CommandResult>;
  };
  const created = await sendCommand({ type: "session.create", projectId: null, cwd: base, model: { provider: "openai", id: "gpt-4.1" } });
  assert(created.ok);
  const sessionId = (created.value as SessionSummary).id;
  const pendingPrompt = sendCommand({ type: "session.prompt", sessionId, text: "/bridge-contract" });
  for (const [method, response] of [["select", { value: "Second" }], ["confirm", { value: false }], ["input", { value: "private-HTTP-interaction-answer" }], ["editor", { value: "Edited" }]] as Array<[string, OmpInteractionResponse]>) {
    let pending: OmpInteraction | undefined;
    for (let i = 0; i < 200 && !pending; i++) {
      pending = (await get<OmpInteraction[]>(`/v1/sessions/${sessionId}/interactions`)).find(value => value.method === method);
      if (!pending) await Bun.sleep(10);
    }
    assert(pending, `Missing ${method} interaction`);
    const answer = () => fetch(`${host.connection.origin}/v1/sessions/${sessionId}/interactions`, {
      method: "POST", headers: { Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ interactionId: pending!.id, response }),
    });
    // Simultaneous independent HTTP clients: the native callback resolves once.
    const attempted = await Promise.all([answer(), answer()]);
    assert.deepEqual(attempted.map(value => value.status).sort(), [200, 409]);
  }
  // A completed native slash command has its own admission receipt without a fabricated user message.
  const completed = await pendingPrompt;
  assert(completed.ok);
  assert.deepEqual(completed.admission, { kind: "native-command", command: "bridge-contract" });
  assert.deepEqual(await get<OmpInteraction[]>(`/v1/sessions/${sessionId}/interactions`), []);
  assert(host.store.lastEventSequence < 1000);
  const events = host.store.eventsAfter(0, 1000);
  assert(events.some(event => event.type === "accounts"));
  assert(events.some(event => event.type === "interactions"));
  assert(events.filter(event => event.type === "accounts").every(event => Object.keys(event).sort().join() === "sequence,type"));
  for (const secret of [submitted, storedAccess, storedRefresh, apiKey, "private-HTTP-interaction-answer"]) {
    assert(!JSON.stringify({ responses, events }).includes(secret));
    // Verify actual host database/WAL and files, not just projected responses.
    for (const file of await readdir(join(base, "host"), { withFileTypes: true })) {
      if (file.isFile()) assert(!(await readFile(join(base, "host", file.name))).includes(Buffer.from(secret)));
    }
  }
  process.stdout.write("native account HTTP and secret-isolation contracts passed\n");
} catch (error) {
  contractFailure = error;
  throw error;
} finally {
  unregisterOAuthProvider(providerId);
  try { await host.stop(); }
  catch (error) {
    const messages = (value: unknown): string => value instanceof AggregateError
      ? `${value.message}: ${value.errors.map(messages).join("; ")}`
      : value instanceof Error ? `${value.name}: ${value.message}` : "Unknown cleanup error";
    throw new Error(`${contractFailure ? `Account contract failed: ${messages(contractFailure)}; ` : ""}Isolated account fixture cleanup failed: ${messages(error)}`);
  }
}
