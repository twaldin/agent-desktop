import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_OWNER_HEADER, type TerminalCreationRequest } from "@agent-desktop/shared";
import { HostStore } from "../../../host/src/store";
import { TerminalCreationHttp } from "../../../host/src/terminals/creation-http";
import { nativeTerminalResult } from "./host-transport";
import { requestTerminalCreationCapabilities, requestTerminalCreate, requestTerminalCreationStatus } from "./terminal-create-transport";

const hostId = "10000000-0000-4000-8000-000000000001";
const terminalId = "20000000-0000-4000-8000-000000000002";
const otherId = "30000000-0000-4000-8000-000000000003";
const input: TerminalCreationRequest = { version: 1, requestId: "40000000-0000-4000-8000-000000000004",
  controlEpoch: "50000000-0000-4000-8000-000000000005", target: { projectId: otherId }, cols: 120, rows: 40 };
const endpoint = { origin: "http://unused.invalid", hostId, token: "test-token" };
const base = { version: 1, hostId, requestId: input.requestId };
const pending = { ...base, status: "pending", terminalId };
const completed = { ...base, status: "settled", receipt: { outcome: "completed", terminalId } };
const metadata = { id: terminalId, target: input.target, cwd: "/fixture", protocol: "tmux-v1",
  serverGeneration: otherId, status: "running", attachable: true };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
function response(value: unknown, status = 200, owner = hostId) {
  return Response.json(value, { status, headers: { [WORKSPACE_OWNER_HEADER]: owner } });
}
function serve(value: unknown, status = 200, owner = hostId) {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return response(value, status, owner); }) as unknown as typeof fetch;
  return () => calls;
}

test("capability and keyed create use exact owner, identity, body and one request each", async () => {
  const calls: Request[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init); calls.push(request);
    expect(request.headers.get(WORKSPACE_OWNER_HEADER)).toBe(hostId);
    expect(request.headers.get("Authorization")).toBe("Bearer test-token");
    expect(init?.redirect).toBe("error"); expect(init?.signal).toBeInstanceOf(AbortSignal);
    return request.method === "GET" ? response({ version: 1, hostId, controlEpoch: input.controlEpoch }) : response(pending);
  }) as unknown as typeof fetch;
  expect(await requestTerminalCreationCapabilities(endpoint)).toEqual<unknown>({ version: 1, hostId, controlEpoch: input.controlEpoch });
  expect(await requestTerminalCreate(endpoint, input)).toEqual<unknown>(pending);
  expect(calls.map(r => [r.method, r.url])).toEqual<unknown>([
    ["GET", `${endpoint.origin}/v2/terminals/creation-capabilities`], ["POST", `${endpoint.origin}/v2/terminals/create`],
  ]);
  expect(await calls[1]!.json()).toEqual<unknown>(input);
});

test("completed, unknown and not-submitted receipts stay distinct without automatic observation or retry", async () => {
  for (const outcome of ["completed", "unknown", "not-submitted"] as const) {
    const value = { ...completed, receipt: { outcome, terminalId, ...(outcome === "completed" ? {} : { message: "Inspect original request." }) } };
    const count = serve(value);
    expect(await requestTerminalCreate(endpoint, input)).toEqual<unknown>(value);
    expect(count()).toBe(1);
  }
});

test("status is read-only transport and projects identity metadata without upgrading unknown", async () => {
  const calls: string[] = [];
  const value = { ...completed, receipt: { outcome: "unknown", terminalId, message: "Interrupted owner." }, terminal: { ...metadata, screen: "not transported", history: ["private output"] } };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url)); expect(JSON.parse(String(init?.body))).toEqual<unknown>(input); return response(value);
  }) as unknown as typeof fetch;
  expect(await requestTerminalCreationStatus(endpoint, input)).toEqual<unknown>({ ...value, terminal: metadata });
  expect(calls).toEqual<unknown>([`${endpoint.origin}/v2/terminals/creation-status`]);
  const count = serve({ ...base, status: "unavailable" });
  expect(await requestTerminalCreationStatus(endpoint, input)).toEqual<unknown>({ ...base, status: "unavailable" });
  expect(count()).toBe(1);
});

test("capability absence, wrong version or owner never fall back to legacy terminal actions", async () => {
  for (const body of [{ version: 2, hostId, controlEpoch: input.controlEpoch }, { version: 1, hostId: otherId, controlEpoch: input.controlEpoch },
    { version: 1, hostId, controlEpoch: "" }, { version: 1, hostId, controlEpoch: input.controlEpoch, extra: true }]) {
    const count = serve(body); await expect(requestTerminalCreationCapabilities(endpoint)).rejects.toThrow(); expect(count()).toBe(1);
  }
  const count = serve({ error: "Not found" }, 404);
  await expect(requestTerminalCreationCapabilities(endpoint)).rejects.toMatchObject({ status: 404 }); expect(count()).toBe(1);
});

test("coded host failures survive the existing IPC result envelope without a retry", async () => {
  for (const [status, code] of [[409, "TERMINAL_INPUT_MISMATCH"], [503, "TERMINAL_STORAGE_FAILED"], [401, "UNAUTHORIZED"]] as const) {
    const count = serve({ error: { code, message: "Controlled failure." } }, status);
    expect(await nativeTerminalResult(() => requestTerminalCreate(endpoint, input))).toEqual<unknown>({ ok: false, error: { status, code, message: "Controlled failure." } });
    expect(count()).toBe(1);
  }
});

test("request, epoch, dimensions and explicit host are validated before any network call", async () => {
  const count = serve(pending);
  for (const bad of [{ ...input, version: 2 }, { ...input, requestId: "" }, { ...input, controlEpoch: "old" },
    { ...input, target: { projectId: otherId, sessionId: otherId } }, { ...input, rows: 0 }, { ...input, cols: 65536 },
    { ...input, rows: 1.5 }, { ...input, command: "unexpected" }]) {
    await expect(requestTerminalCreate(endpoint, bad as TerminalCreationRequest)).rejects.toThrow();
    await expect(requestTerminalCreationStatus(endpoint, bad as TerminalCreationRequest)).rejects.toThrow();
  }
  await expect(requestTerminalCreate({ ...endpoint, hostId: "" }, input)).rejects.toThrow();
  await expect(requestTerminalCreationCapabilities({ ...endpoint, hostId: "" })).rejects.toThrow(); expect(count()).toBe(0);
});

test("malformed or mismatched acknowledgements cannot become confirmed terminals", async () => {
  for (const bad of [{ ...pending, hostId: otherId }, { ...pending, requestId: otherId }, { ...pending, version: 2 },
    { ...pending, terminalId: "" }, { ...pending, receipt: completed.receipt }, { ...completed, terminalId },
    { ...completed, receipt: { outcome: "completed", terminalId, message: "extra" } },
    { ...completed, receipt: { outcome: "unknown", terminalId, message: " " } }, { ...base, status: "unavailable" },
    { ...completed, terminal: metadata }, { ...pending, status: "ready" }, { ...pending, extra: true }]) {
    const count = serve(bad); await expect(requestTerminalCreate(endpoint, input)).rejects.toThrow(); expect(count()).toBe(1);
  }
});

test("recovery rejects invalid durable identity, target, protocol, generation and state", async () => {
  for (const bad of [{ ...metadata, id: otherId }, { ...metadata, id: "" }, { ...metadata, target: { sessionId: otherId } },
    { ...metadata, target: { projectId: otherId, sessionId: otherId } }, { ...metadata, protocol: "legacy" },
    { ...metadata, serverGeneration: "" }, { ...metadata, cwd: "relative" }, { ...metadata, cwd: "/bad\0path" },
    { ...metadata, status: ["running"] }, { ...metadata, status: "error" }, { ...metadata, attachable: "true" }]) {
    const count = serve({ ...completed, terminal: bad });
    await expect(requestTerminalCreationStatus(endpoint, input)).rejects.toThrow(); expect(count()).toBe(1);
  }
  const value = { ...pending, terminal: { ...metadata, status: "interrupted", attachable: false } };
  serve(value); expect(await requestTerminalCreationStatus(endpoint, input)).toEqual<unknown>(value);
});

test("wrong owner header rejects even an error response and cancels its body", async () => {
  let cancelled = false, calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { status: 401, headers: { [WORKSPACE_OWNER_HEADER]: otherId } }); }) as unknown as typeof fetch;
  await expect(requestTerminalCreate(endpoint, input)).rejects.toThrow("another host");
  expect(cancelled).toBe(true); expect(calls).toBe(1);
});

test("oversized and invalid UTF8 replies fail closed; failed fetch is never repeated", async () => {
  let cancelled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream({ start(s) { s.enqueue(new Uint8Array(65537)); }, cancel() { cancelled = true; } }),
    { headers: { [WORKSPACE_OWNER_HEADER]: hostId } })) as unknown as typeof fetch;
  await expect(requestTerminalCreate(endpoint, input)).rejects.toThrow("bound"); expect(cancelled).toBe(true);
  globalThis.fetch = (async () => new Response(new Uint8Array([0xff]), { headers: { [WORKSPACE_OWNER_HEADER]: hostId } })) as unknown as typeof fetch;
  await expect(requestTerminalCreationStatus(endpoint, input)).rejects.toThrow();
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("Reply lost."); }) as unknown as typeof fetch;
  await expect(requestTerminalCreate(endpoint, input)).rejects.toThrow("Reply lost."); expect(calls).toBe(1);
});

test("actual transport and route retain one SQLite reservation across a lost reply and read-only recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "terminal-transport-")), store = new HostStore(root);
  let creates = 0, gets = 0, lost = false;
  const route = new TerminalCreationHttp({ hostId: store.host.id, controlEpoch: input.controlEpoch, records: store.terminalCreations,
    resolveTarget: () => root, environmentForTarget: () => undefined, manager: {
      async create(options, _environment, _action, reservation) {
        creates++; reservation!.validateOwner();
        expect(store.terminalCreations.get(input)?.terminalId).toBe(reservation!.terminalId);
        return { id: reservation!.terminalId, target: options.target, cwd: root, shell: "fixture", pid: null,
          cols: 120, rows: 40, createdAt: 1, protocol: "tmux-v1", status: "running", serverGeneration: otherId, geometryRevision: 1, inputEpoch: otherId };
      },
      get(id) { gets++; return { id, target: input.target, cwd: root, shell: "fixture", pid: null, cols: 120, rows: 40,
        createdAt: 1, protocol: "tmux-v1", status: "running", serverGeneration: otherId, geometryRevision: 1, inputEpoch: otherId }; },
    } });
  const paths: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init); paths.push(new URL(request.url).pathname);
    const result = await route.handle(request); if (!result) throw new Error("Unrecognized terminal route.");
    if (paths.at(-1) === "/v2/terminals/create" && !lost) { lost = true; await result.body?.cancel(); throw new Error("Discarded fulfilled reply."); }
    return result;
  }) as unknown as typeof fetch;
  const owned = { ...endpoint, hostId: store.host.id };
  try {
    expect((await requestTerminalCreationCapabilities(owned)).controlEpoch).toBe(input.controlEpoch);
    await expect(requestTerminalCreate(owned, input)).rejects.toThrow("Discarded fulfilled reply.");
    const observed = await requestTerminalCreationStatus(owned, input);
    expect(observed).toMatchObject({ status: "settled", receipt: { outcome: "completed", terminalId: store.terminalCreations.get(input)!.terminalId },
      terminal: { id: store.terminalCreations.get(input)!.terminalId, target: input.target, cwd: root } });
    expect(creates).toBe(1); expect(gets).toBe(1);
    expect(paths).toEqual<unknown>(["/v2/terminals/creation-capabilities", "/v2/terminals/create", "/v2/terminals/creation-status"]);
  } finally { await route.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
