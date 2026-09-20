import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const sessionPinAccounts = [
  { accountId: "pin-alpha", email: "alpha@fixture.invalid", orgId: "pin-org-alpha", orgName: "North Research Team" },
  { accountId: "pin-beta", email: "duplicate@fixture.invalid", orgId: "pin-org-beta", orgName: "South Research Team" },
  { accountId: "pin-gamma", email: "duplicate@fixture.invalid", orgId: "pin-org-gamma", orgName: "West Research Team" },
] as const;
export const sessionPinModel = { provider: "openai-codex", id: "gpt-5.4" };
/** Unsigned disposable credentials: never accepted by any real provider. */
export function sessionPinAccess(accountId: string, expires: number): string {
  return `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId }, exp: Math.floor(expires / 1000),
  })).toString("base64url")}.session-pin-not-a-signature`;
}
export interface SessionPinRequest {
  sequence: number;
  accountId: string;
  sessionId: string;
  model: string;
  input: unknown;
  instructions: unknown;
}
export type SessionPinControl =
  | { op: "snapshot" | "restore" }
  | { op: "fault"; boundary: "read" | "output" | "flush" }
  | { op: "dispatch"; text: string; noModel?: boolean };

export interface SessionPinFixture {
  agentDir: string;
  cwd: string;
  workerPath: string;
  model: { provider: string; id: string };
  requestsFile: string;
  environment: Record<string, string | undefined>;
  accounts: typeof sessionPinAccounts;
  hold(): void;
  release(): void;
  waitForRequests(count: number): Promise<void>;
  control(pid: number, command: SessionPinControl): Promise<unknown>;
  stop(): Promise<void>;
}

function successSse(sequence: number): string {
  const id = `msg_session_pin_${sequence}`, responseId = `resp_session_pin_${sequence}`;
  const text = `Controlled session pin response ${sequence}.`;
  const item = { id, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: responseId, status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_text.done", item_id: id, output_index: 0, content_index: 0, text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: responseId, status: "completed", output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

/** Prepare once. Keep this parent-owned server alive across worker/host restarts.
 * Consumers must drain all hosts/workers before stop(), then remove their directory.
 * requestsFile contains no headers, access tokens, refresh tokens or auth-store rows.
 */
export async function prepareSessionPinFixture(directory: string): Promise<SessionPinFixture> {
  directory = await realpath(directory);
  const agentDir = path.join(directory, "agent"), cwd = path.join(directory, "project");
  await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
  await writeFile(path.join(agentDir, "config.yml"), "extensions: []\ndefaultThinkingLevel: low\n");
  const requestsFile = path.join(directory, "requests.jsonl");
  await writeFile(requestsFile, "");
  const expires = Date.now() + 86_400_000;
  await writeFile(path.join(directory, "session-pin-fixture.json"), JSON.stringify({ expires }));
  // Keep diagnostic Unix sockets below macOS's pathname limit even when the
  // caller stores durable evidence under a long directory name.
  const controlDir = await mkdtemp(path.join(tmpdir(), "pin-ctl-"));
  const requests: SessionPinRequest[] = [];
  let gate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let journal = Promise.resolve();
  const waiters = new Set<{ count: number; resolve(): void }>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const account = sessionPinAccounts.find(candidate => candidate.accountId === request.headers.get("chatgpt-account-id"));
      assert.ok(account, "Loopback requires a known synthetic account");
      assert.ok(request.headers.get("authorization") === `Bearer ${sessionPinAccess(account.accountId, expires)}`, "Synthetic authorization required");
      assert.equal(url.search, "");
      if (url.pathname === "/backend-api/wham/usage" && request.method === "GET") {
        return Response.json({ plan_type: "plus", rate_limit: { allowed: true, limit_reached: false,
          primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_after_seconds: 18000, reset_at: Math.floor(expires / 1000) } } });
      }
      assert.equal(url.pathname, "/backend-api/codex/responses"); assert.equal(request.method, "POST");
      const body = await request.json() as Record<string, unknown>;
      const sessionId = request.headers.get("session_id"); assert.ok(sessionId);
      assert.equal(body.model, sessionPinModel.id);
      const record = { sequence: requests.length + 1, accountId: account.accountId, sessionId,
        model: String(body.model), input: body.input, instructions: body.instructions };
      // Journal only approved payload fields. Never serialize request headers.
      const encoded = JSON.stringify(record);
      assert.ok(!encoded.includes("session-pin-not-a-signature") && !encoded.includes("session-pin-refresh"));
      requests.push(record);
      journal = journal.then(() => appendFile(requestsFile, `${encoded}\n`));
      await journal;
      for (const waiter of waiters) if (requests.length >= waiter.count) { waiters.delete(waiter); waiter.resolve(); }
      const held = gate;
      if (held) {
        const aborted = Promise.withResolvers<void>();
        const onAbort = () => aborted.resolve();
        if (request.signal.aborted) onAbort(); else request.signal.addEventListener("abort", onAbort, { once: true });
        try { await Promise.race([held.promise, aborted.promise]); }
        finally { request.signal.removeEventListener("abort", onAbort); }
      }
      return new Response(successSse(record.sequence), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const workerPath = fileURLToPath(new URL("./session-pin-worker.ts", import.meta.url));
  const environment: Record<string, string | undefined> = {
    HOME: directory, PATH: process.env.PATH, TMPDIR: tmpdir(), TERM: "dumb", PI_CODING_AGENT_DIR: agentDir,
    PI_DISABLE_DOTENV: "1", PI_CODEX_WEBSOCKET: "0", PI_CODEX_ZSTD: "0",
    SESSION_PIN_ROOT: directory, SESSION_PIN_ORIGIN: `http://127.0.0.1:${server.port}`,
    SESSION_PIN_CONTROL_DIR: controlDir,
  };
  try {
    const seed = Bun.spawn([process.execPath, "--no-env-file", workerPath, "--seed"], { env: environment, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([seed.exited, new Response(seed.stdout).text(), new Response(seed.stderr).text()]);
    assert.equal(exit, 0, `Synthetic account seed failed: ${stderr || stdout}`);
  } catch (error) {
    const cleanup = await Promise.allSettled([server.stop(true), rm(controlDir, { recursive: true, force: true })]);
    const failures = cleanup.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
    throw failures.length ? new AggregateError([error, ...failures], "Synthetic seed failed before cleanup failed", { cause: error }) : error;
  }
  return {
    agentDir, cwd, workerPath, model: { ...sessionPinModel }, requestsFile, environment, accounts: sessionPinAccounts,
    hold() { assert.equal(gate, undefined, "Only one provider gate may be held"); gate = Promise.withResolvers<void>(); },
    release() { gate?.resolve(); gate = undefined; },
    async waitForRequests(count: number) {
      if (requests.length >= count) return;
      const pending = Promise.withResolvers<void>();
      const waiter = { count, resolve: () => pending.resolve() };
      waiters.add(waiter);
      const timer = setTimeout(() => pending.reject(new Error(`Expected ${count} loopback requests; observed ${requests.length}`)), 30_000);
      try { await pending.promise; }
      finally { clearTimeout(timer); waiters.delete(waiter); }
    },
    control(pid: number, command: SessionPinControl): Promise<unknown> {
      const pending = Promise.withResolvers<unknown>();
      const socket = connect(path.join(controlDir, `pin-${pid}.sock`));
      let text = "", settled = false;
      const fail = (error: Error) => { if (!settled) { settled = true; pending.reject(error); } socket.destroy(); };
      socket.setTimeout(30_000, () => fail(new Error("Native pin control timed out")));
      socket.on("error", fail);
      socket.on("connect", () => socket.write(`${JSON.stringify(command)}\n`));
      socket.on("data", chunk => {
        text += chunk;
        if (!text.includes("\n")) return;
        try {
          const value = JSON.parse(text.slice(0, text.indexOf("\n")));
          settled = true; socket.end();
          if (value.error) pending.reject(Object.assign(new Error(value.error.message), { code: value.error.code })); else pending.resolve(value.result);
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      });
      socket.on("close", () => { if (!settled) fail(new Error("Native pin control closed without a response")); });
      return pending.promise;
    },
    async stop() {
      gate?.resolve(); gate = undefined; await server.stop(true); await journal;
      await rm(controlDir, { recursive: true, force: true });
    },
  };
}
