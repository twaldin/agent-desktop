import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandEnvelope, CommandResult, HostEvent, HostState, Project, WorkspaceQueryResult } from "@agent-desktop/shared";
import { acquireHostLease } from "./lease";
import { startHost } from "./server";

type Host = Awaited<ReturnType<typeof startHost>>;
type Options = Required<Pick<Parameters<typeof startHost>[0] & object, "dataDirectory" | "agentDirectory" | "discoveryDirectory">>;
const directories: string[] = [];
const hosts = new Set<Host>();
const sockets = new Set<WebSocket>();

async function isolatedOptions(): Promise<Options> {
  const directory = await mkdtemp(join(tmpdir(), "agent-desktop-server-"));
  directories.push(directory);
  const options = {
    dataDirectory: join(directory, "data"), agentDirectory: join(directory, "omp"), discoveryDirectory: join(directory, "project"),
  };
  await Promise.all(Object.values(options).map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  return options;
}

async function start(options: Options): Promise<Host> {
  const host = await startHost(options);
  hosts.add(host);
  return host;
}

async function stop(host: Host): Promise<void> {
  await host.stop();
  hosts.delete(host);
}

afterEach(async () => {
  for (const socket of sockets) socket.close();
  sockets.clear();
  const stopped = await Promise.allSettled([...hosts].map(host => host.stop()));
  hosts.clear();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  const failed = stopped.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Host shutdown failed");
});

function headers(host: Host): HeadersInit {
  return { Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json" };
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trimEnd();
}

async function command(host: Host, envelope: CommandEnvelope): Promise<CommandResult> {
  const response = await fetch(`${host.connection.origin}/v1/commands`, {
    method: "POST", headers: headers(host), body: JSON.stringify(envelope),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<CommandResult>;
}

async function state(host: Host): Promise<HostState> {
  const response = await fetch(`${host.connection.origin}/v1/state`, { headers: headers(host) });
  expect(response.status).toBe(200);
  return response.json() as Promise<HostState>;
}

function connect(host: Host, after = 0, protocols = ["agent-desktop", host.connection.token]): WebSocket {
  const url = host.connection.origin.replace("http:", "ws:") + `/v1/events?after=${after}`;
  const socket = new WebSocket(url, protocols);
  sockets.add(socket);
  return socket;
}

function eventMatching(socket: WebSocket, predicate: (event: HostEvent) => boolean): Promise<HostEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Timed out waiting for a host event")), 5000);
    const message = (message: MessageEvent) => {
      try {
        const event = JSON.parse(String(message.data)) as HostEvent;
        if (predicate(event)) finish(undefined, event);
      } catch (error) { finish(error); }
    };
    const error = () => finish(new Error("WebSocket connection failed"));
    const close = () => finish(new Error("WebSocket closed before the expected event"));
    function finish(error?: unknown, event?: HostEvent): void {
      clearTimeout(timer);
      socket.removeEventListener("message", message);
      socket.removeEventListener("error", errorListener);
      socket.removeEventListener("close", close);
      if (error) reject(error); else resolve(event!);
    }
    const errorListener = error;
    socket.addEventListener("message", message);
    socket.addEventListener("error", errorListener);
    socket.addEventListener("close", close);
  });
}

const initialDraft = {
  id: "new-conversation", text: "unsent work", projectId: null,
  model: { provider: "test-provider", id: "test-model" }, thinkingLevel: "high",
};

describe("isolated host transport", () => {
  test("HTTP requires a Bearer token and rejects browser origins", async () => {
    const host = await start(await isolatedOptions());
    const url = `${host.connection.origin}/v1/state`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { Authorization: "Bearer invalid-token" } })).status).toBe(401);
    expect((await fetch(url, { headers: { ...headers(host), Origin: "https://example.invalid" } })).status).toBe(401);
    expect((await fetch(url, { headers: { ...headers(host), Origin: "null" } })).status).toBe(401);
    const snapshot = await state(host);
    expect(snapshot.host.id).toBe(host.connection.hostId);
    expect(snapshot.projects).toEqual([]);
    expect(snapshot.sessions).toEqual([]);
    expect((await fetch(url, { headers: { Authorization: host.connection.token } })).status).toBe(401);
  });

  test("non-ASCII invalid credentials produce an authentication rejection", async () => {
    const host = await start(await isolatedOptions());
    const response = await fetch(`${host.connection.origin}/v1/state`, {
      headers: { Authorization: `Bearer ${"é".repeat(host.connection.token.length)}` },
    });
    expect(response.status).toBe(401);
  });

  test("malformed commands are rejected before recording claims", async () => {
    const host = await start(await isolatedOptions());
    const response = await fetch(`${host.connection.origin}/v1/commands`, {
      method: "POST", headers: headers(host), body: JSON.stringify({ id: "bad-path", command: { type: "project.add", path: "relative" } }),
    });
    expect(response.status).toBe(400);
    expect(host.store.getCommand("bad-path")).toBeUndefined();
    expect((await state(host)).projects).toEqual([]);
  });

  test("legacy clients cannot strip image intent or consume an image-aware draft; old receipts still replay", async () => {
    const host = await start(await isolatedOptions());
    const original: CommandEnvelope = { id: "legacy-saved", command: { type: "draft.put", draft: initialDraft, expectedRevision: 0 } };
    const receipt = await command(host, original);
    expect(receipt.ok).toBe(true);
    // Metadata fixture models a newer client's committed draft. It is not an
    // upload/native-image acceptance claim, and no provider/session is created.
    const attachments = [{ id: "image-chip", hostId: host.store.host.id, kind: "image" as const, sha256: "a".repeat(64), name: "image.png", bytes: 128, mimeType: "image/png" as const }];
    host.store.putDraft({ ...initialDraft, attachments }, 1);
    const before = host.store.getDraft(initialDraft.id);
    expect(await command(host, original)).toEqual(receipt);
    expect(host.store.getDraft(initialDraft.id)).toEqual(before);
    for (const version of [1, 2]) {
      const rawId = `raw-image-v${version}`;
      const response = await fetch(`${host.connection.origin}/v${version}/commands`, { method: "POST", headers: headers(host),
        body: JSON.stringify({ id: rawId, command: { type: "draft.put", draft: { ...initialDraft, attachments }, expectedRevision: 2 } }) });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: "ATTACHMENT_PROTOCOL_REQUIRED" });
      expect(host.store.getCommand(rawId)).toBeUndefined();
      for (const next of [
        { type: "draft.put", draft: initialDraft, expectedRevision: 2 },
        { type: "session.prompt", sessionId: "must-not-open", text: "old client text", draft: { id: initialDraft.id, revision: 2 } },
        { type: "session.steer", sessionId: "must-not-open", text: "old client steer", draft: { id: initialDraft.id, revision: 2 } },
      ]) {
        const result = await fetch(`${host.connection.origin}/v${version}/commands`, { method: "POST", headers: headers(host), body: JSON.stringify({ id: crypto.randomUUID(), command: next }) });
        expect(result.status).toBe(200);
        expect(await result.json()).toMatchObject({ ok: false, error: { code: "ATTACHMENT_PROTOCOL_REQUIRED" } });
        expect(host.store.getDraft(initialDraft.id)).toEqual(before);
        expect(host.store.listSessions()).toEqual([]);
      }
    }
  });

  test("simultaneous retries share one durable command result and project", async () => {
    const options = await isolatedOptions();
    const host = await start(options);
    const envelope: CommandEnvelope = { id: "add-project", command: { type: "project.add", path: options.discoveryDirectory } };
    const [first, concurrent] = await Promise.all([command(host, envelope), command(host, envelope)]);
    expect(first.ok).toBe(true);
    expect(concurrent).toEqual(first);
    expect(await command(host, envelope)).toEqual(first);
    expect((await state(host)).projects).toHaveLength(1);
    expect(await command(host, { ...envelope, command: { ...envelope.command, type: "project.add", path: options.agentDirectory } }))
      .toMatchObject({ ok: false, error: { code: "COMMAND_ID_REUSED" } });
    await stop(host);
    const reopened = await start(options);
    expect(await command(reopened, envelope)).toEqual(first);
    expect((await state(reopened)).projects).toHaveLength(1);
  });

  test("project rename and catalog removal preserve existing sessions and reject a new session", async () => {
    const options = await isolatedOptions(), host = await start(options);
    const added = await command(host, { id: "project-add", command: { type: "project.add", path: options.discoveryDirectory, name: "Original" } });
    expect(added.ok).toBe(true);
    if (!added.ok || !added.value || !("path" in added.value)) throw new Error("Project add failed");
    const project = added.value;
    const renamed = await command(host, { id: "project-rename", command: { type: "project.rename", projectId: project.id, name: "Renamed" } });
    expect(renamed).toMatchObject({ ok: true, value: { id: project.id, name: "Renamed" } });
    host.store.upsertSession({ id: "existing-session", hostId: host.store.host.id, projectId: project.id, cwd: project.path,
      title: "Existing", status: "idle", sessionFile: join(options.dataDirectory, "existing.jsonl"), model: null, createdAt: 1, updatedAt: 1, archived: false });
    expect(host.store.putDraft({ ...initialDraft, projectId: project.id }, 0).ok).toBe(true);
    const removed = await command(host, { id: "project-remove", command: { type: "project.remove", projectId: project.id } });
    expect(removed).toMatchObject({ ok: true, value: { id: project.id, removedAt: expect.any(Number) } });
    expect((await state(host)).projects).toEqual([]);
    expect(host.store.getSession("existing-session")?.projectId).toBe(project.id);
    expect(host.store.getDraft(initialDraft.id)?.projectId).toBe(project.id);
    const rejected = await command(host, { id: "removed-project-new-session", command: { type: "session.create", projectId: project.id } });
    expect(rejected).toMatchObject({ ok: false, error: { code: "COMMAND_FAILED", message: expect.stringContaining("selected project") } });
    expect(host.store.getDraft(initialDraft.id)?.projectId).toBe(project.id);
  });

  test("concurrent HTTP draft edits preserve both versions and failed sends retain the draft", async () => {
    const host = await start(await isolatedOptions());
    const [first, second] = await Promise.all([
      command(host, { id: "draft-a", command: { type: "draft.put", draft: initialDraft, expectedRevision: 0 } }),
      command(host, { id: "draft-b", command: { type: "draft.put", draft: { ...initialDraft, text: "other laptop's edit" }, expectedRevision: 0 } }),
    ]);
    expect([first, second].filter(result => result.ok)).toHaveLength(1);
    expect([first, second].filter(result => !result.ok)).toHaveLength(1);
    const conflict = [first, second].find(result => !result.ok)!;
    expect(conflict).toMatchObject({ ok: false, error: { code: "DRAFT_CONFLICT" } });
    const current = (await state(host)).drafts[0]!;
    const preserved = host.store.listDraftConflicts(initialDraft.id)[0]!;
    expect(new Set([current.text, preserved.attempted.text])).toEqual(new Set([initialDraft.text, "other laptop's edit"]));
    expect(await command(host, { id: "missing-session-send", command: {
      type: "session.prompt", sessionId: "missing-session", text: current.text,
      draft: { id: current.id, revision: current.revision },
    } })).toMatchObject({ ok: false, error: { code: "COMMAND_FAILED" } });
    expect((await state(host)).drafts).toEqual([current]);
  });

  test("workspace writes resolve catalog ownership, preserve conflicts, and deduplicate across restart", async () => {
    const options = await isolatedOptions();
    const host = await start(options);
    const added = await command(host, { id: "workspace-project", command: { type: "project.add", path: options.discoveryDirectory } });
    expect(added.ok).toBe(true);
    const project = added.ok ? added.value as Project : undefined;
    const target = { projectId: project!.id };
    const write: CommandEnvelope = { id: "workspace-write", command: { type: "workspace.mutate", target,
      action: { type: "file.write", path: "contract.txt", text: "first revision\n", expectedRevision: null } } };
    const [first, retry] = await Promise.all([command(host, write), command(host, write)]);
    expect(first).toEqual(retry);
    expect(first).toMatchObject({ ok: true, value: { type: "file.write", result: { ok: true, document: { text: "first revision\n" } } } });
    const conflict = await command(host, { id: "workspace-conflict", command: { ...write.command, type: "workspace.mutate", target,
      action: { type: "file.write", path: "contract.txt", text: "other client's revision\n", expectedRevision: null } } });
    expect(conflict).toMatchObject({ ok: true, value: { type: "file.write", result: { ok: false, code: "REVISION_CONFLICT", current: { text: "first revision\n" } } } });
    const query = async (target: unknown, path: string) => fetch(`${host.connection.origin}/v1/workspace/query`, {
      method: "POST", headers: headers(host), body: JSON.stringify({ target, query: { type: "file.read", path } }),
    });
    const response = await query(target, "contract.txt");
    expect(response.status).toBe(200);
    expect(await response.json() as WorkspaceQueryResult).toMatchObject({ type: "file.read", content: { kind: "text", text: "first revision\n" } });
    expect((await query({ cwd: options.discoveryDirectory }, "contract.txt")).status).toBe(400);
    expect((await query({ projectId: "another-host-project" }, "contract.txt")).status).toBe(400);
    expect((await query(target, "../omp/config.yml")).status).toBe(400);
    expect(host.store.getCommand(write.id)?.command).toBeUndefined();
    await stop(host);
    const reopened = await start(options);
    expect(await command(reopened, write)).toEqual(first);
    expect(await readFile(join(options.discoveryDirectory, "contract.txt"), "utf8")).toBe("first revision\n");
  });

  test("branch checkout is blocked while an owning session is active and succeeds after it becomes idle", async () => {
    const options = await isolatedOptions();
    git(options.discoveryDirectory, "init", "--initial-branch=main");
    git(options.discoveryDirectory, "config", "user.name", "Workspace Test");
    git(options.discoveryDirectory, "config", "user.email", "workspace-tests@example.invalid");
    await writeFile(join(options.discoveryDirectory, "tracked.txt"), "initial\n");
    git(options.discoveryDirectory, "add", "tracked.txt"); git(options.discoveryDirectory, "commit", "--message", "Initial");
    git(options.discoveryDirectory, "branch", "feature");
    const host = await start(options);
    const added = await command(host, { id: "checkout-project", command: { type: "project.add", path: options.discoveryDirectory } });
    const project = added.ok ? added.value as Project : undefined;
    const statusResponse = await fetch(`${host.connection.origin}/v1/workspace/query`, { method: "POST", headers: headers(host),
      body: JSON.stringify({ target: { projectId: project!.id }, query: { type: "git.status" } }) });
    const reviewed = await statusResponse.json() as Extract<WorkspaceQueryResult, { type: "git.status" }>;
    const now = Date.now();
    const active = host.store.upsertSession({ id: "active-checkout", hostId: host.connection.hostId, projectId: project!.id,
      cwd: await realpath(options.discoveryDirectory), title: "Active checkout", status: "running", sessionFile: join(options.dataDirectory, "active.jsonl"),
      model: null, createdAt: now, updatedAt: now, archived: false });
    const action = { type: "git.checkout" as const, branch: "feature", expectedRevision: reviewed.status.revision };
    expect(await command(host, { id: "blocked-checkout", command: { type: "workspace.mutate", target: { projectId: project!.id }, action } }))
      .toMatchObject({ ok: false, error: { code: "COMMAND_FAILED", message: expect.stringContaining("still working") } });
    expect(git(options.discoveryDirectory, "branch", "--show-current")).toBe("main");
    host.store.upsertSession({ ...active, status: "idle", updatedAt: now + 1 });
    expect(await command(host, { id: "allowed-checkout", command: { type: "workspace.mutate", target: { projectId: project!.id }, action } }))
      .toMatchObject({ ok: true, value: { type: "git.checkout", status: { branch: "feature" } } });
  });

  test("WebSockets require protocol authentication and deliver live and resumed events", async () => {
    const host = await start(await isolatedOptions());
    const unauthenticated = connect(host, 0, ["agent-desktop", "invalid-token"]);
    await expect(eventMatching(unauthenticated, () => true)).rejects.toThrow("WebSocket");
    // Bun supports request headers; the desktop DOM lib hides this constructor overload.
    const BunWebSocket = WebSocket as unknown as { new(url: string, options: Bun.WebSocketOptions): WebSocket };
    const browser = new BunWebSocket(host.connection.origin.replace("http:", "ws:") + "/v1/events", {
      protocols: ["agent-desktop", host.connection.token], headers: { Origin: "https://example.invalid" },
    });
    sockets.add(browser);
    await expect(eventMatching(browser, () => true)).rejects.toThrow("WebSocket");
    const socket = connect(host, host.store.lastEventSequence);
    const connected = await eventMatching(socket, event => event.type === "state");
    expect(socket.protocol).toBe("agent-desktop");
    expect(connected.type === "state" && connected.state.host.id).toBe(host.connection.hostId);
    expect(connected.type === "state" && connected.replayComplete).toBe(true);
    const live = eventMatching(socket, event => event.type === "state" && event.state.drafts.some(draft => draft.id === initialDraft.id));
    await command(host, { id: "stream-draft", command: { type: "draft.put", draft: initialDraft, expectedRevision: 0 } });
    const delivered = await live;
    expect(delivered.sequence).toBeGreaterThan(connected.sequence);
    socket.close();
    const resumed = connect(host, connected.sequence);
    expect(await eventMatching(resumed, event => event.sequence === delivered.sequence)).toEqual(delivered);
    resumed.close();
    const barrierSocket = connect(host, delivered.sequence);
    const barrier = await eventMatching(barrierSocket, event => event.type === "state" && event.replayComplete === true);
    expect(barrier.sequence).toBeGreaterThanOrEqual(delivered.sequence);
  });

  test("a second host cannot recover or modify the first host's running session", async () => {
    const options = await isolatedOptions();
    const host = await start(options);
    const now = Date.now();
    host.store.upsertSession({
      id: "running-catalog-fixture", hostId: host.connection.hostId, projectId: null, cwd: options.discoveryDirectory,
      title: "Running metadata", status: "running", sessionFile: join(options.dataDirectory, "not-opened.jsonl"),
      model: null, createdAt: now, updatedAt: now, archived: false,
    });
    await expect(startHost(options)).rejects.toThrow("already owns");
    expect(host.store.getSession("running-catalog-fixture")?.status).toBe("running");
    await stop(host);
    const recovered = await start(options);
    expect(recovered.connection.hostId).toBe(host.connection.hostId);
    expect(recovered.store.getSession("running-catalog-fixture")?.status).toBe("interrupted");
  });

  test("stop closes the endpoint, removes discovery credentials, and releases the host lease", async () => {
    const options = await isolatedOptions();
    const host = await start(options);
    const connectionFile = join(options.dataDirectory, "connection.json");
    expect((await stat(connectionFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(connectionFile, "utf8"))).toEqual(host.connection);
    await state(host);
    await stop(host);
    await expect(fetch(`${host.connection.origin}/v1/health`, { headers: headers(host) })).rejects.toThrow();
    await expect(stat(connectionFile)).rejects.toThrow();
    const lease = acquireHostLease(options.dataDirectory);
    expect(lease.acquired).toBe(true);
    lease.release();
  });

  test("a failed listen releases its data-directory lease", async () => {
    const occupied = await start(await isolatedOptions());
    const options = await isolatedOptions();
    await expect(startHost({ ...options, port: Number(new URL(occupied.connection.origin).port) })).rejects.toThrow();
    const lease = acquireHostLease(options.dataDirectory);
    expect(lease.acquired).toBe(true);
    lease.release();
  });
});
