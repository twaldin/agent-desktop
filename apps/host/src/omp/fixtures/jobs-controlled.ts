// Controlled native background-jobs fixture. Owns exactly three seams and no
// native job API: (1) a loopback OpenAI chat-completions SSE server that gates
// real subagent turns by an assignment token, (2) a private disposable agent
// directory/project with a non-blocking child agent definition so the ORIGINAL
// task tool registers actual detached AsyncJobManager jobs, and (3) a short
// control-socket directory through which `jobs-worker.ts` exposes the original
// captured native session of each production worker. Nothing here imports the
// native SDK, so every caller can install its network guard first.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const JOBS_FIXTURE_PROVIDER = "jobs-fixture";
export const JOBS_FIXTURE_MODEL = { provider: JOBS_FIXTURE_PROVIDER, id: "base" } as const;
export const JOBS_FIXTURE_CHILD_AGENT = "jobs-child";
export const JOBS_FIXTURE_INDEPENDENT_OWNER = "jobs-fixture-independent-owner";
export const JOBS_FIXTURE_CHILD_RESULT = "controlled child complete";
export const JOBS_FIXTURE_CHILD_FAILURE = "controlled child failure";
export const JOBS_FIXTURE_ROOT_RESULT = "Controlled root acknowledgement.";

export interface InferenceRequest {
  seq: number; at: number; kind: "child" | "root"; token?: string; held: boolean; outcome: "yield" | "text" | "fail" | "aborted"; releasedAt?: number;
}
export interface InferenceHold {
  readonly token: string;
  /** Resolves once the original native child turn has reached the loopback server. */
  readonly reached: Promise<InferenceRequest>;
  release(): void;
  /** Answer the held child turn with a real `yield` failure so the original task job settles as failed. */
  fail(): void;
}
export interface JobsInference {
  readonly origin: string;
  readonly requests: readonly InferenceRequest[];
  hold(token: string): InferenceHold;
  stop(): Promise<void>;
}

/** Loopback controlled provider: child turns (tool `yield` offered) yield, root turns answer with text. */
export function startJobsInference(): JobsInference {
  const requests: InferenceRequest[] = [];
  const holds = new Map<string, { hold: InferenceHold; reached: ReturnType<typeof Promise.withResolvers<InferenceRequest>>; decision: ReturnType<typeof Promise.withResolvers<"yield" | "fail">> }>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") return new Response("Not found", { status: 404 });
      const raw = await request.text();
      const body = JSON.parse(raw) as { messages?: unknown[]; tools?: Array<{ function?: { name?: string } }> };
      assert.ok(Array.isArray(body.messages), "Controlled inference expects chat messages");
      const child = (body.tools ?? []).some(tool => tool.function?.name === "yield");
      const held = [...holds.entries()].find(([token]) => raw.includes(token));
      const record: InferenceRequest = { seq: requests.length + 1, at: Date.now(), kind: child ? "child" : "root", token: held?.[0], held: Boolean(held), outcome: child ? "yield" : "text" };
      requests.push(record);
      let decision: "yield" | "fail" = "yield";
      if (held) {
        const [token, entry] = held;
        entry.reached.resolve(record);
        const aborted = Promise.withResolvers<"aborted">();
        request.signal.addEventListener("abort", () => aborted.resolve("aborted"), { once: true });
        const outcome = await Promise.race([entry.decision.promise, aborted.promise]);
        holds.delete(token);
        record.releasedAt = Date.now();
        if (outcome === "aborted") { record.outcome = "aborted"; return new Response(null, { status: 499 }); }
        decision = outcome;
      }
      const id = `jobs-fixture-${record.seq}`;
      const chunk = (delta: Record<string, unknown>, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      if (decision === "fail") record.outcome = "fail";
      // A failing child reports failure through the real `yield` tool; the
      // original task job then settles as `failed` with the agent's error text.
      const yielded = decision === "fail" ? { error: JOBS_FIXTURE_CHILD_FAILURE } : { data: JOBS_FIXTURE_CHILD_RESULT };
      const stream = child
        ? chunk({ role: "assistant", tool_calls: [{ index: 0, id: `${id}-yield`, type: "function", function: { name: "yield", arguments: JSON.stringify(yielded) } }] }, null) + chunk({}, "tool_calls")
        : chunk({ role: "assistant", content: JOBS_FIXTURE_ROOT_RESULT }, null) + chunk({}, "stop");
      return new Response(`${stream}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`, requests,
    hold(token) {
      assert.ok(token && !holds.has(token), "A controlled inference hold needs a unique token");
      const reached = Promise.withResolvers<InferenceRequest>(), decision = Promise.withResolvers<"yield" | "fail">();
      const hold: InferenceHold = { token, reached: reached.promise, release: () => decision.resolve("yield"), fail: () => decision.resolve("fail") };
      holds.set(token, { hold, reached, decision });
      return hold;
    },
    async stop() { for (const entry of holds.values()) entry.decision.resolve("yield"); holds.clear(); await server.stop(true); },
  };
}

/** Fail-closed process network guard: only the owned loopback inference origin may be fetched. */
export function installJobsNetworkGuard(allowedOrigin: string, label: string) {
  const blocked: Array<{ kind: "fetch" | "preconnect" | "websocket"; url: string }> = [];
  const originalFetch = globalThis.fetch;
  const deny = (kind: "fetch" | "preconnect" | "websocket", url: string): never => {
    blocked.push({ kind, url });
    throw new Error(`Outbound ${kind} is disabled in the ${label}: ${url}`);
  };
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== allowedOrigin) return deny("fetch", `${url.origin}${url.pathname}`);
    return originalFetch(input, { ...init, redirect: "error" });
  }, { preconnect: (input: string | URL) => { const url = new URL(String(input)); if (url.origin !== allowedOrigin) deny("preconnect", url.origin); } }) as typeof fetch;
  process.env.PI_CODEX_WEBSOCKET = "0";
  globalThis.WebSocket = new Proxy(globalThis.WebSocket, { construct(_target, args): never { return deny("websocket", String(args[0])); } });
  return blocked;
}

/** Owner-scoped, non-consuming projection of one original manager row. */
export interface JobsFixtureJob {
  id: string; type: string; status: "running" | "completed" | "failed" | "cancelled"; queued: boolean; label: string; startTime: number;
  ownerId?: string; agentId?: string; resultText?: string; errorText?: string; consumed: boolean; settled: boolean; seeded: boolean;
}
export interface JobsWorkerStatus {
  pid: number; captured: boolean; sessionId?: string; sessionFile?: string; agentId?: string; isDisposed?: boolean; manager: boolean;
  jobs: JobsFixtureJob[]; delivery?: { queued: number; delivering: boolean; nextRetryAt?: number; pendingJobIds: string[] };
  blocked: Array<{ kind: string; url: string }>; children: Array<{ id: string; sessionId?: string; agentId?: string; status: string }>;
}
export type JobsWorkerCommand =
  | { op: "status" }
  | { op: "spawnTask"; name: string; token: string }
  | { op: "seed"; label: string; type?: "bash" | "eval"; owner?: "original" | "independent"; queued?: boolean; id?: string }
  | { op: "markRunning"; jobId: string }
  | { op: "release"; jobId: string; outcome?: "complete" | "fail"; text?: string }
  | { op: "job"; jobId: string }
  | { op: "waitJob"; jobId: string; status?: JobsFixtureJob["status"]; settled?: boolean; queued?: boolean; timeoutMs?: number };

export interface JobsWorkerControl {
  readonly socket: string;
  request<T = unknown>(command: JobsWorkerCommand): Promise<T>;
  status(): Promise<JobsWorkerStatus>;
  spawnTask(name: string, token: string): Promise<{ jobId: string; agentId: string; ownerId?: string; startTime: number; toolCallId: string; accepted: string }>;
  seed(input: Omit<Extract<JobsWorkerCommand, { op: "seed" }>, "op">): Promise<{ jobId: string; ownerId: string; startTime: number }>;
  release(jobId: string, outcome?: "complete" | "fail", text?: string): Promise<JobsFixtureJob>;
  job(jobId: string): Promise<JobsFixtureJob | null>;
  waitJob(input: Omit<Extract<JobsWorkerCommand, { op: "waitJob" }>, "op">): Promise<JobsFixtureJob>;
}

/** Errors that mean the socket's worker is gone or leaving, not that the request was refused. */
const DEAD_SOCKET_CODES: readonly string[] = ["ECONNREFUSED", "ENOENT", "ECONNRESET", "EPIPE"];
export function requestWorkerControl<T>(socket: string, command: JobsWorkerCommand): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const connection = createConnection(socket); let text = "";
  connection.once("error", reject);
  connection.once("connect", () => connection.write(`${JSON.stringify(command)}\n`));
  connection.on("data", chunk => { text += chunk.toString(); });
  connection.once("end", () => {
    // A worker that exits mid-request closes the socket without a reply.
    if (!text) { reject(Object.assign(new Error("Controlled worker closed without a reply"), { code: "ECONNRESET", socket, command })); return; }
    try {
      const reply = JSON.parse(text) as { ok: boolean; value?: T; error?: string };
      if (!reply.ok) reject(Object.assign(new Error(reply.error ?? "Controlled worker refused the request"), { socket, command }));
      else resolve(reply.value as T);
    } catch (error) { reject(error); }
  });
  return promise;
}

function workerControl(socket: string): JobsWorkerControl {
  const request = <T,>(command: JobsWorkerCommand) => requestWorkerControl<T>(socket, command);
  return {
    socket, request,
    status: () => request({ op: "status" }),
    spawnTask: (name, token) => request({ op: "spawnTask", name, token }),
    seed: input => request({ op: "seed", ...input }),
    release: (jobId, outcome, text) => request({ op: "release", jobId, outcome, text }),
    job: jobId => request({ op: "job", jobId }),
    waitJob: input => request({ op: "waitJob", ...input }),
  };
}

export interface JobsControl {
  readonly directory: string;
  /** Live control sockets of fixture workers, oldest first. Dead sockets are skipped. */
  workers(): Promise<Array<{ socket: string; status: JobsWorkerStatus }>>;
  /** The control of the worker whose ORIGINAL captured native session is `sessionId`. */
  session(sessionId: string, timeoutMs?: number): Promise<JobsWorkerControl>;
  socket(socket: string): JobsWorkerControl;
}

export interface JobsFixture {
  directory: string; agentDir: string; cwd: string; workerPath: string; model: typeof JOBS_FIXTURE_MODEL;
  environment: Record<string, string>; control: JobsControl; inference: JobsInference;
  /** Stops the loopback provider and removes the short control directory; every failure is preserved. */
  stop(): Promise<void>;
}

export const JOBS_FIXTURE_ENV = { root: "JOBS_FIXTURE_ROOT", controlDir: "JOBS_FIXTURE_CONTROL_DIR", inferenceOrigin: "JOBS_FIXTURE_INFERENCE_ORIGIN" } as const;

export function jobsFixtureConfig(): string {
  return [
    "extensions: []", "defaultThinkingLevel: off", "retry:", "  enabled: false", "async:", "  enabled: true", "  maxJobs: 8",
    "task:", "  maxConcurrency: 1", "  agentIdleTtlMs: 60000", "  maxRuntimeMs: 3600000", "tools:", "  approvalMode: yolo", "",
  ].join("\n");
}

export async function writeJobsFixtureFiles(agentDir: string, cwd: string, inferenceOrigin: string): Promise<void> {
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await mkdir(path.join(cwd, ".omp", "agents"), { recursive: true });
  await writeFile(path.join(agentDir, "config.yml"), jobsFixtureConfig());
  await writeFile(path.join(agentDir, "models.yml"), JSON.stringify({ providers: { [JOBS_FIXTURE_PROVIDER]: {
    api: "openai-completions", baseUrl: `${inferenceOrigin}/v1`, auth: "none",
    models: [{ id: JOBS_FIXTURE_MODEL.id, name: "Controlled loopback jobs model", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  // No `blocking: true`: the original task tool registers this child as a
  // detached AsyncJobManager job whenever async execution is enabled.
  await writeFile(path.join(cwd, ".omp", "agents", `${JOBS_FIXTURE_CHILD_AGENT}.md`), [
    "---", `name: "${JOBS_FIXTURE_CHILD_AGENT}"`, 'description: "Controlled detached background child"', `model: "${JOBS_FIXTURE_PROVIDER}/${JOBS_FIXTURE_MODEL.id}"`,
    "tools: [yield]", "---", "Return through yield immediately.", "",
  ].join("\n"));
}

/** A short socket directory: macOS limits Unix socket paths to ~104 bytes. */
export async function createControlDirectory(): Promise<string> {
  const base = process.platform !== "win32" && existsSync("/tmp") ? "/tmp" : tmpdir();
  const directory = await mkdtemp(path.join(base, "adnj-"));
  assert.ok(directory.length < 80, `Control directory is too long for Unix sockets: ${directory}`);
  return directory;
}

export function createJobsControl(directory: string): JobsControl {
  const workers = async () => {
    const entries = (await readdir(directory)).filter(name => name.endsWith(".sock")).sort();
    const live: Array<{ socket: string; status: JobsWorkerStatus }> = [];
    for (const name of entries) {
      const socket = path.join(directory, name);
      try { live.push({ socket, status: await requestWorkerControl<JobsWorkerStatus>(socket, { op: "status" }) }); }
      catch (error) { if (!DEAD_SOCKET_CODES.includes(String((error as NodeJS.ErrnoException).code))) throw error; }
    }
    return live;
  };
  return {
    directory, workers, socket: workerControl,
    async session(sessionId, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const match = (await workers()).find(worker => worker.status.captured && worker.status.sessionId === sessionId);
        if (match) return workerControl(match.socket);
        if (Date.now() > deadline) throw new Error(`No controlled worker captured the original native session ${sessionId}`);
        await Bun.sleep(25);
      }
    },
  };
}

export async function prepareJobsFixture(directory: string, options?: { inference?: JobsInference }): Promise<JobsFixture> {
  assert.ok(path.isAbsolute(directory), "prepareJobsFixture needs an absolute disposable directory");
  const inference = options?.inference ?? startJobsInference();
  const owned = !options?.inference;
  const agentDir = path.join(directory, "agent"), cwd = path.join(directory, "project");
  let controlDir: string | undefined;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeJobsFixtureFiles(agentDir, cwd, inference.origin);
    controlDir = await createControlDirectory();
  } catch (error) {
    const failures: unknown[] = [error];
    if (owned) await inference.stop().catch(cause => failures.push(cause));
    if (controlDir) await rm(controlDir, { recursive: true, force: true }).catch(cause => failures.push(cause));
    throw failures.length === 1 ? error : new AggregateError(failures, "Native jobs fixture preparation failed");
  }
  const environment: Record<string, string> = {
    HOME: directory, PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: directory, TERM: "dumb", NO_COLOR: "1", PI_DISABLE_DOTENV: "1", PI_NO_TITLE: "1",
    PI_TELEMETRY_DISABLED: "1", PI_CODEX_WEBSOCKET: "0", PI_CODING_AGENT_DIR: agentDir,
    XDG_CONFIG_HOME: path.join(directory, "xdg-config"), XDG_DATA_HOME: path.join(directory, "xdg-data"), XDG_CACHE_HOME: path.join(directory, "xdg-cache"), XDG_STATE_HOME: path.join(directory, "xdg-state"),
    [JOBS_FIXTURE_ENV.root]: directory, [JOBS_FIXTURE_ENV.controlDir]: controlDir, [JOBS_FIXTURE_ENV.inferenceOrigin]: inference.origin,
  };
  let stopped = false;
  return {
    directory, agentDir, cwd, workerPath: fileURLToPath(new URL("./jobs-worker.ts", import.meta.url)), model: JOBS_FIXTURE_MODEL,
    environment, control: createJobsControl(controlDir), inference,
    async stop() {
      if (stopped) return; stopped = true;
      const failures: unknown[] = [];
      if (owned) await inference.stop().catch(cause => failures.push(cause));
      const stale = (await readdir(controlDir!).catch(() => [] as string[])).filter(name => name.endsWith(".sock"));
      for (const name of stale) {
        // A worker that is still listening is not ours to remove; report it instead of hiding it.
        const alive = await requestWorkerControl(path.join(controlDir!, name), { op: "status" }).then(() => true, error => DEAD_SOCKET_CODES.includes(String((error as NodeJS.ErrnoException).code)) ? false : error);
        if (alive === true) failures.push(new Error(`Controlled worker socket ${name} is still alive after fixture stop`));
        else if (alive !== false) failures.push(alive);
      }
      await rm(controlDir!, { recursive: true, force: true }).catch(cause => failures.push(cause));
      if (failures.length) throw new AggregateError(failures, "Native jobs fixture stop failed");
    },
  };
}
