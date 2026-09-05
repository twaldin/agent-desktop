import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { ServerWebSocket } from "bun";
import { register as registerExitCleanup } from "@oh-my-pi/pi-utils/postmortem";
import type { CommandEnvelope, CommandResult, HostCommand, HostEvent, HostState, ModelInfo, SessionSummary } from "@agent-desktop/shared";
import { acquireHostLease } from "./lease";
import { WorkerRuntime, type WorkerSession } from "./omp-workers";
import { getDataDirectory, type LocalConnection } from "./paths";
import { HostStore, type EventInput } from "./store";
import { parseCommandEnvelope } from "./validation";
import { TailnetNetwork, TAILNET_PORT } from "./network";
import { AccountsHttp } from "./accounts-http";
import { parseInteractionAnswer } from "./interaction-http";
import { HostWorkspaces, parseWorkspaceQuery, parseWorkspaceTarget } from "./workspace-http";
import { PreferencesSync } from "./preferences-sync";
import { SettingsHttp } from "./settings-http";
import { ThemeFile, ThemeConflictError } from "./theme-file";
import { TerminalManager, TmuxTerminalManager, TmuxTerminalsHttp } from "./terminals";
import { TerminalsHttp } from "./terminals-http";
import { ThemeAssets } from "./theme-assets";

type SocketData = { after: number; remoteAddress?: string };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function startHost(options: { dataDirectory?: string; port?: number; agentDirectory?: string; discoveryDirectory?: string; tailscale?: boolean; workerPath?: string; nativeTerminalBundle?: string } = {}) {
  const dataDirectory = options.dataDirectory ?? getDataDirectory();
  const lease = acquireHostLease(dataDirectory);
  let store!: HostStore;
  let runtime!: WorkerRuntime;
  let accounts: AccountsHttp | undefined;
  let preferences: PreferencesSync | undefined;
  let settings: SettingsHttp | undefined;
  let theme: ThemeFile | undefined;
  let terminals: TerminalManager | undefined;
  let terminalsHttp: TerminalsHttp | undefined;
  let nativeTerminals: TmuxTerminalManager | undefined;
  let nativeTerminalsHttp: TmuxTerminalsHttp | undefined;
  let themeAssets: ThemeAssets | undefined;
  let server: ReturnType<typeof Bun.serve<SocketData>> | undefined;
  let publishedConnection = false;
  let tailServer: ReturnType<typeof Bun.serve<SocketData>> | undefined;
  let networkTimer: ReturnType<typeof setInterval> | undefined;
  let networkCall: Promise<void> | undefined;
  const network = options.tailscale ? new TailnetNetwork() : undefined;
  const temporary = join(dataDirectory, `connection.${process.pid}.tmp`);
  try {
  store = new HostStore(dataDirectory);
  const removingWorktrees = new Set<string>();
  const within = (parent: string, path: string) => path === parent || path.startsWith(parent + sep);
  const workspaces = new HostWorkspaces(store, dataDirectory, path => {
    if (store.listSessions().some(session => within(path, session.cwd) && (session.status === "running" || executions.has(session.id)))) {
      throw new Error("A session is still working in this worktree. Stop it and wait for its work to finish before removing the worktree.");
    }
    if ([...(terminals?.list() ?? []), ...(nativeTerminals?.list() ?? [])].some(terminal => within(path, terminal.cwd) && terminal.exitedAt === undefined)) {
      throw new Error("A terminal is still open in this worktree. Close it before removing the worktree.");
    }
    removingWorktrees.add(path);
    return () => { removingWorktrees.delete(path); };
  });
  function assertWorkspaceAvailable(cwd: string): void {
    if ([...removingWorktrees].some(path => within(path, cwd))) throw new Error("This worktree is being removed. Wait for removal to finish before starting work.");
  }
  // Native postmortem allows 10s for this process's cleanup. Leave time to
  // settle command receipts and remove our locator after a stuck child exits.
  runtime = new WorkerRuntime({ agentDir: options.agentDirectory, workerPath: options.workerPath, shutdownTimeoutMs: 5000, onWorkerFailure(failure) {
    if (stopping) return;
    if (failure.sessionId && store.getSession(failure.sessionId)) {
      updateSession(failure.sessionId, { status: "error", error: failure.message });
      const failed = handles.get(failure.sessionId);
      void failed?.then(handle => handle.dispose()).finally(() => {
        if (handles.get(failure.sessionId!) === failed) handles.delete(failure.sessionId!);
      }).catch(error => console.error("Failed worker cleanup:", errorMessage(error)));
    } else {
      modelsError = failure.message; modelsLoading = false; publishState();
    }
  } });
  const token = randomBytes(32).toString("hex");
  const peers = new Set<ServerWebSocket<SocketData>>();
  const handles = new Map<string, Promise<WorkerSession>>();
  const commands = new Map<string, Promise<CommandResult>>();
  const sessionTails = new Map<string, Promise<unknown>>();
  const executions = new Map<string, Promise<unknown>>();
  const runtimeErrors = new Map<string, string>();
  let models: ModelInfo[] = [];
  let modelsLoading = true;
  let modelsError: string | undefined;
  let stopping = false;
  let modelsRefresh: Promise<void> | undefined;
  let refreshRequested = false;
  let preferencePeers: Parameters<PreferencesSync["sync"]>[0] = [];
  themeAssets = new ThemeAssets(dataDirectory);
  function syncThemeAsset(): void {
    const background = preferences?.store.get("theme.background");
    if (background && !background.deleted && background.key === "theme.background" && background.value.kind === "asset") {
      void themeAssets!.sync(background.value.sha256, preferencePeers).then(changed => { if (changed && !stopping) publish({ type: "preferences" }); }).catch(() => {});
    }
  }
  preferences = new PreferencesSync(store, () => { theme?.schedule(); syncThemeAsset(); publish({ type: "preferences" }); publishState(); });
  theme = new ThemeFile({ dataDirectory, store, preferences, changed: () => publish({ type: "preferences" }) });
  await theme.start();
  terminals = new TerminalManager();
  const resolveTerminalTarget: ConstructorParameters<typeof TerminalsHttp>[0]["resolveTarget"] = target => {
    const cwd = "sessionId" in target ? store.getSession(target.sessionId)?.cwd : store.getProject(target.projectId)?.path;
    if (!cwd) throw new Error("The selected terminal owner does not exist on this host.");
    assertWorkspaceAvailable(cwd);
    return cwd;
  };
  terminalsHttp = new TerminalsHttp({ manager: terminals, resolveTarget: resolveTerminalTarget, invalidate: event => {
    if (stopping) return;
    const payload = JSON.stringify({ type: "terminal", event });
    for (const peer of peers) {
      if (peer.getBufferedAmount() > 8 * 1024 * 1024) peer.close(1013, "Reconnect to resume terminal output");
      else peer.send(payload);
    }
  } });
  const nativeBundle = options.nativeTerminalBundle ?? join(import.meta.dir, "../../../runtime/tmux", `${process.platform}-${process.arch}`);
  if (options.nativeTerminalBundle || existsSync(nativeBundle)) {
    nativeTerminals = await TmuxTerminalManager.open({ dataDirectory, hostId: store.host.id, bundleDirectory: nativeBundle });
    nativeTerminalsHttp = new TmuxTerminalsHttp({ manager: nativeTerminals, resolveTarget: resolveTerminalTarget, invalidate: event => {
      if (stopping) return;
      const payload = JSON.stringify({ type: "native-terminal", event });
      for (const peer of peers) {
        if (peer.getBufferedAmount() > 8 * 1024 * 1024) peer.close(1013, "Reconnect to resume native terminal output");
        else peer.send(payload);
      }
    } });
  } else if (existsSync(join(dataDirectory, "native-terminals-v1/catalog.json"))) {
    throw new Error("The private terminal bundle is missing. Restore this host's installed runtime before reopening its terminal catalog.");
  }

  function refreshModels(): void {
    refreshRequested = true;
    if (modelsRefresh || stopping) return;
    modelsRefresh = (async () => {
      do {
        refreshRequested = false;
        modelsLoading = true; publishState();
        try { models = await runtime.listModels(options.discoveryDirectory ?? homedir(), { refresh: true }); modelsError = undefined; }
        catch (error) { modelsError = errorMessage(error); }
        finally { modelsLoading = false; publishState(); }
      } while (refreshRequested && !stopping);
    })().finally(() => { modelsRefresh = undefined; });
  }
  function ordered<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const pending = (sessionTails.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(operation);
    sessionTails.set(sessionId, pending);
    const finish = () => { if (sessionTails.get(sessionId) === pending) sessionTails.delete(sessionId); };
    void pending.then(finish, finish);
    return pending;
  }
  accounts = new AccountsHttp({ agentDir: options.agentDirectory, cwd: options.discoveryDirectory ?? homedir(),
    selection: {
      list: async id => (await getHandle(id)).listAccountChoices(),
      pin: (id, credentialId) => ordered(id, async () => (await getHandle(id)).pinAccount(credentialId)),
    },
    release: id => ordered(id, async () => (await getHandle(id)).releaseAccountForReselection()),
    changed: refresh => { publish({ type: "accounts" }); if (refresh) refreshModels(); },
  });
  settings = new SettingsHttp({ agentDir: options.agentDirectory, defaultCwd: options.discoveryDirectory ?? homedir(), runtime,
    resolveCwd: target => {
      if (!target) return options.discoveryDirectory ?? homedir();
      const cwd = "sessionId" in target ? store.getSession(target.sessionId)?.cwd : store.getProject(target.projectId)?.path;
      if (!cwd) throw new Error("The selected settings owner does not exist on this host.");
      return cwd;
    },
    getHandle: async id => ({
      getControls: async () => (await getHandle(id)).getControls(),
      mutateControls: mutation => ordered(id, async () => {
        const result = await (await getHandle(id)).mutateControls(mutation);
        if (!stopping) updateSession(id, { model: result.model });
        return result;
      }),
    }),
    changed: change => {
      publish({ type: "settings", ...change });
      if (!change.sessionId) refreshModels();
    },
  });

  function snapshot(): HostState {
    const preferenceError = Object.keys(preferences?.errors ?? {}).length ? "App preferences are waiting to synchronize with some connected hosts." : undefined;
    return { protocolVersion: 1, host: store.host, projects: store.listProjects(), sessions: store.listSessions(),
      drafts: store.listDrafts(), models, modelsLoading, diagnostics: modelsError || preferenceError ? { models: modelsError, preferences: preferenceError } : undefined,
      lastEventSequence: store.lastEventSequence };
  }
  function publish(input: EventInput): void {
    if (stopping) return;
    const event = store.appendEvent(input);
    const payload = JSON.stringify(event);
    for (const peer of peers) {
      if (peer.getBufferedAmount() > 8 * 1024 * 1024) peer.close(1013, "Reconnect to resume events");
      else peer.send(payload);
    }
  }
  function publishState(): void { publish({ type: "state", state: snapshot() }); }
  function updateSession(id: string, update: Partial<SessionSummary>): SessionSummary {
    const current = store.getSession(id);
    if (!current) throw new Error("Session does not exist on this host.");
    const result = store.upsertSession({ ...current, ...update, updatedAt: Date.now() });
    publishState();
    return result;
  }
  function onRuntimeEvent(sessionId: string, event: unknown): void {
    if (stopping) return;
    const value = event as { type?: string; message?: { errorMessage?: string } };
    if (value.type === "extension_interaction_requested" || value.type === "extension_interaction_resolved") {
      publish({ type: "interactions", sessionId }); return;
    }
    if (value.type === "message_end" && value.message?.errorMessage) runtimeErrors.set(sessionId, value.message.errorMessage);
    publish({ type: "runtime", sessionId, event });
  }
  async function getHandle(sessionId: string): Promise<WorkerSession> {
    let pending = handles.get(sessionId);
    if (!pending) {
      const session = store.getSession(sessionId);
      if (!session) throw new Error("Session does not exist on this host.");
      pending = runtime.open({ sessionFile: session.sessionFile, interactions: true, onEvent: event => onRuntimeEvent(sessionId, event) });
      handles.set(sessionId, pending);
      pending.catch(() => { if (handles.get(sessionId) === pending) handles.delete(sessionId); });
    }
    return pending;
  }
  function clearSubmittedDraft(reference: { id: string; revision: number } | undefined): void {
    if (reference) store.consumeDraft(reference);
  }
  function fail(id: string, code: string, message: string): CommandResult {
    return { ok: false, commandId: id, error: { code, message } };
  }

  async function execute(envelope: CommandEnvelope): Promise<CommandResult> {
    const command = envelope.command;
    const ok = (value?: Extract<CommandResult, { ok: true }>["value"], admission?: Extract<CommandResult, { ok: true }>["admission"]): CommandResult =>
      ({ ok: true, commandId: envelope.id, value, ...(admission ? { admission } : {}) });
    switch (command.type) {
      case "preferences.put": return ok({ type: command.type, preference: preferences!.put(command.change) });
      case "workspace.mutate": {
        try { return ok(await workspaces.mutate(command.target, command.action)); }
        finally { publish({ type: "workspace", target: command.target }); }
      }
      case "project.add": return ok(store.addProject(command));
      case "draft.put": {
        const result = store.putDraft(command.draft, command.expectedRevision);
        return result.ok ? ok(result.draft) : { ...fail(envelope.id, "DRAFT_CONFLICT", "The draft changed elsewhere. Both versions were preserved."), currentDraft: result.currentDraft } as CommandResult;
      }
      case "session.create": {
        const project = command.projectId ? store.getProject(command.projectId) : undefined;
        if (command.projectId && !project) throw new Error("The selected project is not on this host.");
        const cwd = project?.path ?? command.cwd ?? join(dataDirectory, "workspaces", crypto.randomUUID());
        assertWorkspaceAvailable(cwd);
        if (!project && !command.cwd) await mkdir(cwd, { recursive: true, mode: 0o700 });
        let sessionId: string | undefined;
        const handle = await runtime.create({ cwd, model: command.model, interactions: true, onEvent: event => { if (sessionId) onRuntimeEvent(sessionId, event); } });
        sessionId = handle.id;
        handles.set(handle.id, Promise.resolve(handle));
        const now = Date.now();
        return ok(store.upsertSession({ id: handle.id, hostId: store.host.id, projectId: project?.id ?? null,
          cwd: handle.cwd, title: handle.title || "New conversation", status: "idle", sessionFile: handle.sessionFile,
          model: handle.model, createdAt: Number.isFinite(handle.createdAt) ? handle.createdAt : now, updatedAt: now,
          archived: false, error: handle.modelFallbackMessage }));
      }
      case "session.rename": return ok(updateSession(command.sessionId, { title: command.title.trim() || "New conversation" }));
      case "session.archive": return ok(updateSession(command.sessionId, { archived: command.archived }));
      case "session.interrupt": {
        const handle = await getHandle(command.sessionId);
        await handle.abort();
        return ok(updateSession(command.sessionId, { status: "interrupted", error: undefined }));
      }
      case "session.steer": {
        const handle = await getHandle(command.sessionId);
        if (!executions.has(command.sessionId) || !handle.isStreaming) throw new Error("There is no running turn to steer.");
        let receipt;
        try { receipt = await handle.steer(command.text); }
        catch (error) {
          // A lost worker/RPC response cannot prove the native queue was never
          // consumed. Keep this command identity and its draft for reconciliation.
          return fail(envelope.id, "OUTCOME_UNKNOWN", `Steer admission could not be verified: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (receipt.kind === "not-recorded") return fail(envelope.id, "STEER_NOT_RECORDED", receipt.reason);
        if (receipt.kind === "outcome-unknown") return fail(envelope.id, "OUTCOME_UNKNOWN", receipt.reason);
        clearSubmittedDraft(command.draft);
        return ok(undefined, receipt);
      }
      case "session.prompt": {
        if (executions.has(command.sessionId)) throw new Error("This session is running. Steer or stop its current turn first.");
        const handle = await getHandle(command.sessionId);
        runtimeErrors.delete(command.sessionId);
        assertWorkspaceAvailable(handle.cwd);
        const nativeTitleBefore = handle.title;
        updateSession(command.sessionId, { status: "running", error: undefined });
        const turn = handle.startPrompt(command.text, { model: command.model, thinkingLevel: command.thinkingLevel });
        const completion = turn.completion.then(() => {
          const error = runtimeErrors.get(command.sessionId);
          const current = store.getSession(command.sessionId);
          if (current && !stopping) updateSession(command.sessionId, {
            model: handle.model, status: error ? "error" : current.status === "interrupted" ? "interrupted" : "idle", error,
          });
        }).catch(error => {
          if (!stopping) updateSession(command.sessionId, { status: "error", error: errorMessage(error) });
        }).finally(() => executions.delete(command.sessionId));
        executions.set(command.sessionId, completion);
        const accepted = await turn.accepted;
        if (!accepted) return fail(envelope.id, "PROMPT_NOT_RECORDED", "OMP neither recorded a user message nor completed a native command. The draft was retained; inspect its outcome before retrying.");
        clearSubmittedDraft(command.draft);
        const current = store.getSession(command.sessionId)!;
        if (handle.title && handle.title !== nativeTitleBefore) updateSession(command.sessionId, { title: handle.title });
        else if (accepted.kind === "user-message" && current.title === "New conversation") updateSession(command.sessionId, { title: command.text.trim().split("\n")[0]!.slice(0, 90) });
        return ok(store.getSession(command.sessionId), accepted);
      }
    }
  }

  async function dispatch(envelope: CommandEnvelope): Promise<CommandResult> {
    if (stopping) return fail(envelope.id, "HOST_STOPPING", "The host is stopping; reconnect before sending.");
    const hash = createHash("sha256").update(JSON.stringify(envelope.command)).digest("hex");
    // Workspace contents are already owned by their files. Persist the receipt/hash,
    // not another full copy of each submitted editor buffer in the pending journal.
    const claim = store.claimCommand(envelope.id, hash, envelope.command.type === "workspace.mutate" ? undefined : envelope.command);
    if (claim.kind === "conflict") return fail(envelope.id, "COMMAND_ID_REUSED", "This command ID belongs to a different request.");
    if (claim.kind === "done") return claim.record.result!;
    if (claim.kind === "pending") return commands.get(envelope.id)
      ?? fail(envelope.id, "OUTCOME_UNKNOWN", "This command was pending when the service stopped. Inspect its outcome before issuing a new command.");
    const command = envelope.command;
    const key = command.type === "workspace.mutate" ? `workspace:${JSON.stringify(command.target)}` : "sessionId" in command ? command.sessionId : "$catalog";
    const previous = command.type === "session.interrupt" ? undefined : sessionTails.get(key);
    const pending = (previous ?? Promise.resolve()).catch(() => {}).then(async () => {
      let result: CommandResult;
      try { result = await execute(envelope); }
      catch (error) { result = fail(envelope.id, "COMMAND_FAILED", errorMessage(error)); }
      store.finishCommand(envelope.id, hash, result);
      publishState();
      return result;
    });
    commands.set(envelope.id, pending);
    if (command.type !== "session.interrupt") sessionTails.set(key, pending);
    void pending.finally(() => {
      commands.delete(envelope.id);
      if (sessionTails.get(key) === pending) sessionTails.delete(key);
    });
    return pending;
  }

  function authorized(request: Request, websocket = false): boolean {
    if (request.headers.has("origin")) return false; // Only the privileged desktop process calls this local endpoint.
    const candidate = websocket ? request.headers.get("sec-websocket-protocol")?.split(",").map(part => part.trim())[1]
      : (/^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("authorization") ?? "")?.[1]);
    if (!candidate || !/^[a-f0-9]{64}$/.test(candidate)) return false;
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
  }

  function createServer(hostname: string, port: number, remote = false) {
  return Bun.serve<SocketData>({
    hostname, port, maxRequestBodySize: 24 * 1024 * 1024,
    async fetch(request, server) {
      const url = new URL(request.url);
      const websocket = url.pathname === "/v1/events";
      const remoteAddress = remote ? server.requestIP(request)?.address : undefined;
      const verified = remote
        ? !request.headers.has("origin") && Boolean(remoteAddress && await network!.verify(remoteAddress).catch(() => false))
        : authorized(request, websocket);
      if (!verified) return Response.json({ error: "Unauthorized" }, { status: 401 });
      try {
        if (request.method === "GET" && url.pathname === "/v1/health") return Response.json({ hostId: store.host.id, host: store.host, protocolVersion: 1 });
        if (websocket) {
          const after = Number(url.searchParams.get("after") ?? 0);
          if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid event cursor.");
          return server.upgrade(request, { data: { after, remoteAddress }, headers: { "Sec-WebSocket-Protocol": "agent-desktop" } })
            ? undefined : Response.json({ error: "WebSocket upgrade required" }, { status: 400 });
        }
        if (!remote && request.method === "GET" && url.pathname === "/v1/peers") {
          if (network) await refreshNetwork();
          return Response.json(network ? network.state : { status: "unavailable", error: "Tailscale discovery is disabled for this host.", hosts: [], checkedAt: Date.now() });
        }
        if (request.method === "GET" && url.pathname === "/v1/state") return Response.json(snapshot());
        if (request.method === "GET" && url.pathname === "/v1/preferences") return Response.json(preferences!.snapshot(), { headers: { "Cache-Control": "no-store" } });
        if (url.pathname === "/v1/theme") {
          if (request.method === "GET") return Response.json(await theme!.refresh(), { headers: { "Cache-Control": "no-store" } });
          if (request.method === "POST") {
            const raw = await request.text();
            if (Buffer.byteLength(raw) > 256 * 1024) throw new Error("The theme document exceeds 256 KiB.");
            const input = JSON.parse(raw) as { document: unknown; expectedRevision: string };
            if (!input || typeof input !== "object" || Object.keys(input).some(key => !["document", "expectedRevision"].includes(key))) throw new Error("Invalid theme update.");
            try { return Response.json(await theme!.set(input.document, input.expectedRevision), { headers: { "Cache-Control": "no-store" } }); }
            catch (error) { if (error instanceof ThemeConflictError) return Response.json({ error: error.message }, { status: 409 }); throw error; }
          }
        }
        if (request.method === "POST" && url.pathname === "/v1/preferences/merge") return Response.json(preferences!.merge(await request.json()), { headers: { "Cache-Control": "no-store" } });
        const themeAssetResponse = await themeAssets!.handle(request);
        if (themeAssetResponse) return themeAssetResponse;
        const accountResponse = await accounts!.route(request, url);
        if (accountResponse) return accountResponse;
        const settingsResponse = await settings!.route(request, url);
        if (settingsResponse) return settingsResponse;
        const terminalResponse = await terminalsHttp!.handle(request);
        if (terminalResponse) { terminalResponse.headers.set("Cache-Control", "no-store"); return terminalResponse; }
        if (url.pathname.startsWith("/v2/terminals/")) {
          if (!nativeTerminalsHttp) return Response.json({ error: { code: "NATIVE_TERMINAL_BUNDLE_MISSING", message: "The pinned native terminal bundle is missing from this host. Build or reinstall its native runtime." } }, { status: 503, headers: { "Cache-Control": "no-store" } });
          const nativeResponse = await nativeTerminalsHttp.handle(request);
          if (nativeResponse) { nativeResponse.headers.set("Cache-Control", "no-store"); return nativeResponse; }
        }
        if (request.method === "POST" && url.pathname === "/v1/workspace/query") {
          const input = await request.json() as { target?: unknown; query?: unknown };
          return Response.json(await workspaces.query(parseWorkspaceTarget(input?.target), parseWorkspaceQuery(input?.query)), { headers: { "Cache-Control": "no-store" } });
        }
        const interactionPath = /^\/v1\/sessions\/([^/]+)\/interactions$/.exec(url.pathname);
        if (interactionPath) {
          const handle = await getHandle(decodeURIComponent(interactionPath[1]!));
          if (request.method === "GET") return Response.json(await handle.listInteractions(), { headers: { "Cache-Control": "no-store" } });
          if (request.method === "POST") {
            const answer = parseInteractionAnswer(await request.json());
            try { await handle.respondInteraction(answer.interactionId, answer.response); }
            catch { return Response.json({ error: "The interaction is no longer pending or the response is not valid. Refresh its current state before retrying." }, { status: 409 }); }
            return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
          }
        }
        if (request.method === "POST" && url.pathname === "/v1/commands") return Response.json(await dispatch(parseCommandEnvelope(await request.json())));
        const messagePath = /^\/v1\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
        if (request.method === "GET" && messagePath) return Response.json(await (await getHandle(decodeURIComponent(messagePath[1]!))).getMessages());
        return Response.json({ error: "Not found" }, { status: 404 });
      } catch (error) { return Response.json({ error: errorMessage(error) }, { status: 400 }); }
    },
    websocket: {
      open(peer) {
        let cursor = peer.data.after;
        // Large gaps resume from the fresh catalog + native transcript, keeping reconnect buffers bounded.
        if (store.lastEventSequence - cursor <= 500) {
          for (const event of store.eventsAfter(cursor, 500)) {
            const payload = JSON.stringify(event);
            if (peer.getBufferedAmount() + Buffer.byteLength(payload) > 8 * 1024 * 1024) break;
            peer.send(payload);
          }
        }
        peers.add(peer);
        peer.send(JSON.stringify({ sequence: store.lastEventSequence, type: "state", state: snapshot() } satisfies HostEvent));
      },
      message() {},
      close(peer) { peers.delete(peer); },
      maxPayloadLength: 1024,
    },
  });
  }
  server = createServer("127.0.0.1", options.port ?? 0);
  function refreshNetwork(): Promise<void> {
    if (!network || stopping) return Promise.resolve();
    if (networkCall) return networkCall;
    networkCall = (async () => {
      const state = await network.refresh();
      if (stopping) return;
      if (!state.listenAddress || tailServer?.hostname !== state.listenAddress) {
        tailServer?.stop(true); tailServer = undefined;
        if (state.listenAddress) {
          try { tailServer = createServer(state.listenAddress, TAILNET_PORT, true); }
          catch (error) { network.state = { ...state, status: "unavailable", error: `Cannot listen on Tailscale: ${errorMessage(error)}` }; }
        }
      }
      for (const peer of peers) {
        if (peer.data.remoteAddress && !await network.verify(peer.data.remoteAddress).catch(() => false)) peer.close(1008, "Device authorization changed");
      }
      preferencePeers = state.hosts.flatMap(peer => peer.availability === "available" && peer.host && peer.origin && peer.host.id !== store.host.id
        ? [{ hostId: peer.host.id, origin: peer.origin }] : []);
      void preferences!.sync(preferencePeers);
      syncThemeAsset();
    })().finally(() => { networkCall = undefined; });
    return networkCall;
  }
  if (network) {
    void refreshNetwork();
    networkTimer = setInterval(() => { void refreshNetwork(); }, 15_000);
  }
  const connection: LocalConnection = { origin: `http://127.0.0.1:${server.port}`, token, pid: process.pid, hostId: store.host.id, protocolVersion: 1 };
  await Bun.write(temporary, JSON.stringify(connection));
  await chmod(temporary, 0o600);
  await rename(temporary, join(dataDirectory, "connection.json"));
  publishedConnection = true;
  const discovery = runtime.listModels(options.discoveryDirectory ?? homedir()).then(value => { models = value; }).catch(error => { modelsError = errorMessage(error); })
    .finally(() => { modelsLoading = false; if (!stopping) publishState(); });

  let stopCall: Promise<void> | undefined;
  function stop(): Promise<void> {
    if (stopCall) return stopCall;
    stopping = true;
    clearInterval(networkTimer);
    server!.stop(true); tailServer?.stop(true);
    stopCall = (async () => {
      try {
        terminalsHttp!.dispose();
        nativeTerminalsHttp?.dispose();
        // Start cancellation before waiting for requests that need those
        // workers to settle. Discovery may be blocked on a native network read.
        const outcomes = await Promise.allSettled([runtime.dispose(), networkCall, discovery, modelsRefresh,
          accounts!.dispose(), terminals!.shutdown(), nativeTerminals?.shutdown(), settings!.dispose(), themeAssets!.dispose(),
          theme!.dispose().finally(() => preferences!.dispose())]);
        await Promise.allSettled([...commands.values(), ...executions.values()]);
        const errors = outcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
        if (errors.length) throw new AggregateError(errors, "Some host resources did not finish cleanup.");
      } finally {
        // Remove our locator while still owning the lease, so a successor's locator survives.
        try { await rm(join(dataDirectory, "connection.json"), { force: true }); }
        finally { store.close(); lease.release(); }
      }
    })();
    return stopCall;
  }
  return { connection, store, snapshot, dispatch, stop };
  } catch (error) {
    clearInterval(networkTimer);
    server?.stop(true); tailServer?.stop(true);
    try { terminalsHttp?.dispose(); nativeTerminalsHttp?.dispose(); await Promise.allSettled([terminals?.shutdown(), nativeTerminals?.shutdown()]); await themeAssets?.dispose(); await theme?.dispose(); await accounts?.dispose(); await preferences?.dispose(); await settings?.dispose(); await runtime?.dispose(); }
    finally {
      try {
        store?.close();
        await rm(temporary, { force: true });
        if (publishedConnection) await rm(join(dataDirectory, "connection.json"), { force: true });
      } finally { lease.release(); }
    }
    throw error;
  }
}

if (import.meta.main) {
  const host = await startHost({ tailscale: true });
  // OMP owns the process signal exit and waits for registered cleanup. A second
  // SIGTERM listener races its native hard exit and can leave our locator behind.
  registerExitCleanup("agent-desktop-host", () => host.stop(), { exitOnly: true });
  process.stdout.write(`Agent Desktop host ready on ${host.connection.origin}\n`);
}
