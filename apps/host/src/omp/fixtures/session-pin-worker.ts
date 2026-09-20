// Network guard and synthetic seed precede all value-level native imports.
// Main path imports the unmodified production worker entry. No streamFn override.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import type { AgentRegistry, AgentSession } from "@oh-my-pi/pi-coding-agent";
import { sessionPinAccess, sessionPinAccounts, type SessionPinControl } from "./session-pin-controlled";

const root = process.env.SESSION_PIN_ROOT!;
assert.ok(root && path.isAbsolute(root));
assert.equal(process.env.HOME, root);
assert.equal(process.env.PI_CODING_AGENT_DIR, path.join(root, "agent"));
const controlDir = process.env.SESSION_PIN_CONTROL_DIR!;
assert.ok(controlDir && path.isAbsolute(controlDir));
const origin = new URL(process.env.SESSION_PIN_ORIGIN!);
assert.equal(origin.hostname, "127.0.0.1"); assert.equal(origin.protocol, "http:");
const { expires } = JSON.parse(await readFile(path.join(root, "session-pin-fixture.json"), "utf8")) as { expires: number };
const nativeFetch = globalThis.fetch;
let blockedRequests = 0, blockedPreconnects = 0;
function deny(): never { blockedRequests++; throw new Error("Outbound request refused by isolated session-pin fixture"); }
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init), url = new URL(request.url);
  const account = sessionPinAccounts.find(candidate => candidate.accountId === request.headers.get("chatgpt-account-id"));
  const inference = url.pathname === "/backend-api/codex/responses" && request.method === "POST";
  const usage = url.pathname === "/backend-api/wham/usage" && request.method === "GET";
  if (url.origin !== "https://chatgpt.com" || url.search || (!inference && !usage) || !account
    || request.headers.get("authorization") !== `Bearer ${sessionPinAccess(account.accountId, expires)}`) return deny();
  return nativeFetch(`${origin.origin}${url.pathname}`, { method: request.method, headers: request.headers,
    body: request.body ? await request.text() : undefined, signal: request.signal, redirect: "error" });
}, { preconnect: () => { blockedPreconnects++; throw new Error("Preconnect refused by isolated session-pin fixture"); } }) as typeof fetch;
process.env.PI_CODEX_WEBSOCKET = "0";
process.env.PI_CODEX_ZSTD = "0";
globalThis.WebSocket = new Proxy(globalThis.WebSocket, { construct: deny });

const native = await import("@oh-my-pi/pi-coding-agent");
if (process.argv.includes("--seed")) {
  const auth = await native.discoverAuthStorage(process.env.PI_CODING_AGENT_DIR);
  try {
    for (const account of sessionPinAccounts) auth.upsertCredential("openai-codex", {
      type: "oauth", ...account, access: sessionPinAccess(account.accountId, expires),
      refresh: `session-pin-refresh-${account.accountId}`, expires,
    });
    // Separate provider with a real stored API-key source, but no OAuth accounts.
    auth.upsertCredential("openai", { type: "api_key", key: "session-pin-synthetic-api-key" });
  } finally { auth.close(); }
  process.stdout.write("session-pin synthetic accounts seeded\n");
} else {
  let registry: AgentRegistry | undefined, agentId: string | undefined;
  const register = native.AgentRegistry.prototype.register;
  native.AgentRegistry.prototype.register = function (input) {
    const result = register.call(this, input);
    if (input.kind === "main" && !registry) {
      registry = this; agentId = result.id;
      native.AgentRegistry.prototype.register = register;
    }
    return result;
  };
  function session(): AgentSession {
    const current = agentId && registry?.get(agentId)?.session;
    assert.ok(current, "Original production-entry session must be attached to its registry");
    return current;
  }
  let restore: (() => void) | undefined;
  const { dispatchNativePrompt } = await import("../commands");
  async function control(command: SessionPinControl) {
    const current = session();
    if (command.op === "restore") { restore?.(); restore = undefined; return { restored: true }; }
    if (command.op === "snapshot") return {
      sessionId: current.sessionId, model: current.model && { provider: current.model.provider, id: current.model.id },
      streaming: current.isStreaming, pins: [...current.sessionManager.getCredentialPins()], blockedRequests, blockedPreconnects,
    };
    if (command.op === "fault") {
      assert.equal(restore, undefined, "Restore the prior exceptional boundary first");
      const error = new Error(`Controlled session-pin ${command.boundary} boundary failure`);
      if (command.boundary === "read") {
        const auth = current.modelRegistry.authStorage, original = auth.reload;
        auth.reload = async () => { throw error; };
        restore = () => { auth.reload = original; };
      } else if (command.boundary === "output") {
        const manager = current.sessionManager, original = manager.appendCustomEntry;
        manager.appendCustomEntry = function (...args) {
          if (args[0] === "agent-desktop.command-output") throw error;
          return original.apply(this, args);
        };
        restore = () => { manager.appendCustomEntry = original; };
      } else {
        const manager = current.sessionManager, original = manager.flush;
        manager.flush = async () => { throw error; };
        restore = () => { manager.flush = original; };
      }
      return { boundary: command.boundary };
    }
    if (command.op === "dispatch") {
      // Agent.setModel requires a model; production creation selects a fallback.
      // This explicit missing-model seam changes only the getter for one dispatch.
      const descriptor = Object.getOwnPropertyDescriptor(current, "model");
      if (command.noModel) Object.defineProperty(current, "model", { configurable: true, get: () => undefined });
      try { return await dispatchNativePrompt(current, command.text); }
      finally {
        if (command.noModel) {
          if (descriptor) Object.defineProperty(current, "model", descriptor);
          else Reflect.deleteProperty(current, "model");
        }
      }
    }
    throw new Error("Unknown session-pin control operation");
  }
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    let buffer = "", used = false;
    socket.on("data", chunk => {
      buffer += chunk;
      if (used || !buffer.includes("\n")) return;
      used = true;
      void Promise.resolve().then(() => control(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))))).then(
        result => socket.end(`${JSON.stringify({ result })}\n`),
        error => socket.end(`${JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error), code: error?.code } })}\n`),
      );
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(path.join(controlDir, `pin-${process.pid}.sock`), listening.resolve);
  await listening.promise;
  process.once("exit", () => { restore?.(); server.close(); for (const socket of sockets) socket.destroy(); });
  await import("../../omp-workers/entry");
}
