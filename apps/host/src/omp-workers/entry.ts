import { WorkerBrowserEvaluationChannels } from "../omp-browser/evaluation";
import { WorkerBrowserObservations } from "../omp-browser/observation";
import { WorkerBrowserReservations } from "../omp-browser/reservation";
import { WorkerBrowserCloses } from "../omp-browser/close";
import { parseNativeMcpAuthorizationId, parseNativeMcpAuthorizationReply, parseNativeMcpAuthorizationStart } from "@agent-desktop/shared";
import { parseNativeSessionMcpResourceRequest } from "@agent-desktop/shared";
import { parseNativeSessionMcpReload, parseNativeSessionMcpReconnect } from "@agent-desktop/shared";
import { parseBrowserControlRequest, parseBrowserNavigationUrl, parseGoalMutationRequest, parseResolveDetachedQuestionRequest } from "@agent-desktop/shared";
import { serialize } from "node:v8";
import type { OmpRuntime, OmpSession, OmpRuntimeEvent } from "../omp";
import { validBrowserFrameTarget, type BrowserMetadataAvailability, type NativeBrowserTabMetadata } from "@agent-desktop/shared";
import { projectNativeBrowserFrame } from "../omp-browser/frame";
import { remoteError, WORKER_PROTOCOL_VERSION, type ChildMessage, type ParentMessage, type SessionSnapshot } from "./protocol";
import { projectWorkerEvent } from "./events";
import { WorkerReconnectServer } from "./reconnect-wire";

// All SDK imports are deferred until the child has received its explicit native
// directory. The daemon never imports/initializes OMP through this boundary.
let marketplaces: Promise<import("../integrations/marketplaces").NativeMarketplaces> | undefined;
let plugins: Promise<import("../integrations/plugins").NativePlugins> | undefined;
let ssh: Promise<import("../integrations/ssh").NativeSsh> | undefined;
let mcp: Promise<import("../integrations/mcp").NativeMcp> | undefined;
let runtime: OmpRuntime | undefined;
let browserOwner: import("../omp-browser/owner").NativeBrowserOwner | undefined;
const browserCloses = new WorkerBrowserCloses(process.pid, () => browserOwner ?? requireSession());
const browserObservations = new WorkerBrowserObservations(process.pid, () => browserOwner ?? requireSession());
const browserReservations = new WorkerBrowserReservations(process.pid, () => {
  if (!browserOwner) throw new Error("Reservation requires the original browser-only owner.");
  return browserOwner;
});
const browserEvaluations = new WorkerBrowserEvaluationChannels(browserReservations, () => {
  if (!browserOwner) throw new Error("Evaluation requires the original browser-only owner.");
  return browserOwner;
}, (binding, frame) => send({ type: "browserEvaluationFrame", binding, frame }));
let nativeDisposal: Promise<void> | undefined;
let commitGeneration: Promise<import("./protocol").CommitGenerationResult> | undefined;
let commitAbort: AbortController | undefined;
let session: OmpSession | undefined;
let initializing = false;
let stopping = false;
let shuttingDown: Promise<void> | undefined;
let pendingDispose: { id: string; exitCode: number; deadline: ReturnType<typeof setTimeout> } | undefined;
let reconnect: WorkerReconnectServer | undefined;
let snapshotRevision = 0;
let activeRequests = 0;
let promotionInFlight = false;
let promotedOwnerRetired = false;
let latestActivity: SessionSnapshot["activity"] | undefined;
type RetainedInstall = { binding: import("../omp-browser/evaluation-wire").BrowserEvaluationBinding; native?: { receive(frame: unknown): void; dispose(): Promise<void> };
  descriptor: import("../omp-browser/evaluation-wire").BrowserEvaluationDescriptor; kindTag: import("@agent-desktop/shared").NativeBrowserTabMetadata["kindTag"];
  safeDir: string; receiver?: (frame: unknown) => void; pending: Map<string, ReturnType<typeof Promise.withResolvers<Record<string, unknown>>>>; frames: unknown[]; disposed: boolean; disposal?: Promise<void> };
const retainedInstalls = new Map<string, RetainedInstall>();
const retainedKey = (binding: import("../omp-browser/evaluation-wire").BrowserEvaluationBinding) => JSON.stringify([binding.ownerId,binding.workerPid,binding.name,binding.targetId,binding.operationId,binding.backend]);

async function disposeRetainedInstall(record: RetainedInstall, reason: string): Promise<void> {
  if (record.disposal)return record.disposal;
  record.disposed = true;
  for (const deferred of record.pending.values()) deferred.reject(new Error(reason));
  record.pending.clear();
  record.frames.length = 0;
  const key=retainedKey(record.binding);
  record.disposal=Promise.resolve().then(()=>record.native?.dispose()).finally(()=>{
    if(retainedInstalls.get(key)===record)retainedInstalls.delete(key);
  });
  return record.disposal;
}

function snapshot(): SessionSnapshot | undefined {
  if (!session) return undefined;
  // Disposal settles outstanding prompt RPCs after the native session has
  // become unreadable. Retain only its last live activity projection; current
  // lifecycle fields must still show the native stop instead of stale streaming.
  const activity = stopping ? latestActivity : session.getSessionActivity();
  if (!activity) return undefined;
  latestActivity = activity;
  return {
    revision: ++snapshotRevision,
    id: session.id, sessionFile: session.sessionFile, cwd: session.cwd,
    model: session.model, thinkingLevel: session.thinkingLevel,
    isStreaming: session.isStreaming, hasPostPromptWork: session.hasPostPromptWork,
    title: session.title, createdAt: session.createdAt,
    modelFallbackMessage: session.modelFallbackMessage,
    activity,
  };
}

function send(message: ChildMessage): void {
  if (process.connected && process.send) process.send(message);
  else if (reconnect) reconnect.send(message);
  else throw new Error("OMP worker lost its owning daemon");
}

// Acknowledged event delivery bounds the child's native-event backlog. Exceeding
// the bound fails this worker visibly; it never silently discards native events.
const MAX_EVENT_BYTES = 32 * 1024 * 1024;
const MAX_QUEUED_EVENTS = 2048;
const queue: Array<{ message: Extract<ChildMessage, { type: "event" }>; bytes: number }> = [];
let bufferedBytes = 0;
let inFlight: { sequence: number; bytes: number } | undefined;
let sequence = 0;
function drain(): void {
  if (inFlight || !queue.length) return;
  const next = queue.shift()!;
  inFlight = { sequence: next.message.sequence, bytes: next.bytes };
  send(next.message);
}
function emit(event: OmpRuntimeEvent): void {
  if (stopping) return;
  try {
    const message: Extract<ChildMessage, { type: "event" }> = {
      type: "event", sequence: ++sequence, event: structuredClone(projectWorkerEvent(event)), snapshot: snapshot(),
    };
    const bytes = serialize(message).byteLength;
    if (bufferedBytes + bytes > MAX_EVENT_BYTES || queue.length >= MAX_QUEUED_EVENTS) {
      throw new Error("OMP worker event delivery exceeded its bounded buffer");
    }
    bufferedBytes += bytes;
    queue.push({ message, bytes });
    drain();
  } catch (error) { void fatal(error); }
}

// Stop admission first; an in-flight close drains before either native owner is
// destroyed. Independent owner cleanup still runs after a close failure.
function disposeNativeOwners(): Promise<void> {
  if (nativeDisposal) return nativeDisposal;
  const completion = Promise.withResolvers<void>(); nativeDisposal = completion.promise;
  void (async () => {
    const errors: unknown[] = [];
    const closes = browserCloses.dispose();
    const observations = browserObservations.dispose();
    const evaluations = browserEvaluations.dispose();
    const evaluationResult = evaluations.then(() => undefined, error => { errors.push(error); });
    const reservations = browserReservations.dispose();
    // Observe the drain immediately, even while commit cancellation settles.
    const closeResult = closes.then(() => undefined, error => { errors.push(error); });
    const observationResult = observations.then(() => undefined, error => { errors.push(error); });
    try { commitAbort?.abort(); await commitGeneration?.catch(() => {}); } catch (error) { errors.push(error); }
    await Promise.all([closeResult, observationResult]);
    const results = await Promise.allSettled([
      ...[...retainedInstalls.values()].map(record => disposeRetainedInstall(record, "Retained browser owner was disposed.")),
      Promise.resolve().then(() => browserOwner?.dispose()),
      Promise.resolve().then(() => runtime?.dispose()),
      reservations, evaluationResult,
    ]);
    for (const result of results) if (result.status === "rejected") errors.push(result.reason);
    if (errors.length) throw new AggregateError(errors, `OMP worker native cleanup failed: ${errors.map(error => remoteError(error).message).join("; ").slice(0, 8192)}`);
  })().then(completion.resolve, completion.reject);
  return completion.promise;
}

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return shuttingDown;
  stopping = true;
  shuttingDown = (async () => {
    const deadline = setTimeout(() => process.exit(exitCode || 1), 12_000);
    deadline.unref();
    try { await disposeNativeOwners(); }
    catch { exitCode = 1; }
    finally { clearTimeout(deadline); process.exit(exitCode); }
  })();
  return shuttingDown;
}

async function fatal(error: unknown): Promise<void> {
  if (stopping) return;
  try { send({ type: "fatal", error: remoteError(error) }); }
  finally { await shutdown(1); }
}

function requireSession(): OmpSession {
  if (!session) throw new Error("OMP worker has no initialized session");
  return session;
}

function browserOwnerId(): string { return browserOwner ? browserOwner.id : requireSession().id; }

function browserMetadata(value: unknown): BrowserMetadataAvailability {
  if (!Array.isArray(value)) return { availability: "unavailable", reason: "Pinned native browser metadata returned an invalid tab list." };
  const tabs: NativeBrowserTabMetadata[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return { availability: "unavailable", reason: "Pinned native browser metadata returned an invalid tab." };
    const tab = item as Record<string, unknown>, info = tab.info;
    if (!info || typeof info !== "object") return { availability: "unavailable", reason: "Pinned native browser metadata omitted tab readiness data." };
    const ready = info as Record<string, unknown>, viewport = ready.viewport;
    if (typeof tab.name !== "string" || typeof tab.targetId !== "string" || (tab.backend !== "worker" && tab.backend !== "cmux") || !["headless", "spawned", "connected", "relay", "cmux"].includes(String(tab.kindTag)) || !["alive", "dead"].includes(String(tab.state)) || typeof ready.url !== "string" || typeof ready.targetId !== "string" || !viewport || typeof viewport !== "object") return { availability: "unavailable", reason: "Pinned native browser metadata has unsupported fields." };
    const size = viewport as Record<string, unknown>;
    if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || (size.deviceScaleFactor !== undefined && !Number.isFinite(size.deviceScaleFactor))) return { availability: "unavailable", reason: "Pinned native browser metadata has an invalid viewport." };
    tabs.push({ name: tab.name, targetId: tab.targetId, backend: tab.backend, kindTag: tab.kindTag as NativeBrowserTabMetadata["kindTag"], state: tab.state as NativeBrowserTabMetadata["state"], url: ready.url, ...(typeof ready.title === "string" ? { title: ready.title } : {}), viewport: { width: size.width as number, height: size.height as number, ...(typeof size.deviceScaleFactor === "number" ? { deviceScaleFactor: size.deviceScaleFactor } : {}) } });
  }
  return { availability: "running", workerPid: process.pid, tabs };
}

async function request(message: Extract<ParentMessage, { type: "request" }>): Promise<void> {
  let admitted = false, ownsPromotion = false;
  const originId = session?.id, originFile = session?.sessionFile;
  const respond = (ok: boolean, value?: unknown, error?: unknown, phase?: "accepted" | "completion") => {
    send({ type: "response", id: message.id, ok, value,
      ...(message.operation === "requestBrowserEvaluation" ? { evaluation: { binding: message.args.binding, sequence: message.args.sequence } } : {}),
      ...(error === undefined ? {} : { error: remoteError(error) }), phase, snapshot: snapshot() });
  };
  try {
    if (stopping && message.operation !== "dispose" && message.operation !== "disposeBrowserEvaluation") throw new Error("OMP worker is stopping");
    const interactive = ["listInteractions", "respondInteraction", "cancelInteractions", "dispose"].includes(message.operation);
    if ((promotionInFlight || promotedOwnerRetired) && !interactive) throw new Error("The native session is transitioning after side-chat promotion. Reopen it after worker retirement.");
    if (message.operation === "promoteBtw") {
      if (activeRequests) throw new Error("Wait for the current native operation before promoting a side answer.");
      promotionInFlight = ownsPromotion = true;
    }
    activeRequests++; admitted = true;
    switch (message.operation) {
      case "init": {
        if (runtime || initializing) throw new Error("OMP worker can initialize only once");
        initializing = true;
        const init = message.args;
        // Child-only override aligns OMP global native paths with the explicit
        // adapter directory, including default session paths. Omitted means
        // ordinary native profile/environment discovery remains unchanged.
        if (init.agentDir) process.env.PI_CODING_AGENT_DIR = init.agentDir;
        if (init.mode === "browser") {
          const { NativeBrowserOwner } = await import("../omp-browser/owner");
          if (stopping) throw new Error("OMP worker is stopping");
          browserOwner = new NativeBrowserOwner({ ...init.owner, agentDir: init.agentDir });
          await browserOwner.ready();
          if (stopping) throw new Error("OMP worker is stopping");
          respond(true, { ownerId: browserOwner.id, cwd: browserOwner.cwd });
          break;
        }
        const { OmpRuntime } = await import("../omp");
        runtime = new OmpRuntime({ agentDir: init.agentDir });
        if (init.mode === "create") session = await runtime.create({ ...init.options, onEvent: emit });
        if (init.mode === "open") session = await runtime.open({ ...init.options, onEvent: emit });
        respond(true, snapshot());
        break;
      }
      case "enableReconnect": {
        if (reconnect) throw new Error("OMP worker reconnect endpoint is already enabled.");
        reconnect = await WorkerReconnectServer.listen(message.args, receiveParent,
          () => ({ type: "recovered", version: WORKER_PROTOCOL_VERSION, pid: process.pid,
            instanceId: reconnect!.endpoint.instanceId, snapshot: snapshot() } satisfies ChildMessage));
        respond(true, reconnect.endpoint);
        break;
      }
      case "generateCommit": {
        if (!runtime || session || commitAbort) throw new Error("Commit generation requires a fresh discovery worker.");
        commitAbort = new AbortController();
        const abort = commitAbort;
        commitGeneration = (async () => {
          const { generateGitCommitFromDiff, formatConventionalCommit } = await import("@oh-my-pi/pi-coding-agent/commit");
          abort.signal.throwIfAborted();
          const generated = await generateGitCommitFromDiff({ ...message.args, signal: abort.signal,
            onProgress: text => { if (!stopping) send({ type: "commitProgress", id: message.id, message: text.slice(0, 4096) }); },
          });
          return { ...generated, message: formatConventionalCommit(generated.commit) };
        })();
        respond(true, await commitGeneration);
        break;
      }
      case "getMarketplaceCatalog":
      case "acquirePlugin": {
        if (!runtime || session) throw new Error("Native acquisition requires an initialized discovery worker.");
        marketplaces ??= import("../integrations/marketplaces").then(module => new module.NativeMarketplaces());
        const backend = await marketplaces;
        respond(true, message.operation === "getMarketplaceCatalog" ? await backend.read(message.args.cwd) : await backend.mutate(message.args.cwd,message.args.expectedRevision,message.args.action));
        break;
      }
      case "getPlugins":
      case "mutatePlugin": {
        if (!runtime || session) throw new Error("Native configuration requires an initialized discovery worker.");
        plugins ??= import("../integrations/plugins").then(module => new module.NativePlugins());
        const backend = await plugins;
        respond(true, message.operation === "getPlugins" ? await backend.read(message.args.cwd) : await backend.mutate(message.args.cwd, message.args.mutation));
        break;
      }
      case "refreshSshConfiguration": {
        if (!runtime) throw new Error("OMP worker is not initialized");
        // Same native cache reset used by /ssh; existing remote tool work is not cancelled.
        const { reset } = await import("@oh-my-pi/pi-coding-agent/discovery");
        reset(); respond(true, null); break;
      }
      case "getSshHosts":
      case "getSshHostDetail":
      case "mutateSshHost": {
        if (!runtime || session) throw new Error("Native configuration requires an initialized discovery worker.");
        ssh ??= import("../integrations/ssh").then(module => new module.NativeSsh());
        const backend = await ssh;
        respond(true, message.operation === "getSshHosts" ? await backend.read(message.args.cwd)
          : message.operation === "getSshHostDetail" ? await backend.detail(message.args.cwd, message.args.request)
          : await backend.mutate(message.args.cwd, message.args.mutation));
        break;
      }
      case "getMcpServers":
      case "getMcpServerDetail":
      case "mutateMcpServer": {
        if (!runtime || session) throw new Error("Native configuration requires an initialized discovery worker.");
        mcp ??= import("../integrations/mcp").then(module => new module.NativeMcp());
        const backend = await mcp;
        respond(true, message.operation === "getMcpServers" ? await backend.read(message.args.cwd)
          : message.operation === "getMcpServerDetail" ? await backend.detail(message.args.cwd, message.args.request)
          : await backend.mutate(message.args.cwd, message.args.mutation));
        break;
      }
      case "listModels":
        if (!runtime) throw new Error("OMP worker is not initialized");
        respond(true, await runtime.listModels(message.args.cwd, { refresh: message.args.refresh }));
        break;
      case "listModelCapabilities":
        if (!runtime) throw new Error("OMP worker is not initialized");
        respond(true, await runtime.listModelCapabilities(message.args.cwd, { refresh: message.args.refresh }));
        break;
      case "getComposerCatalog":
        if (!runtime) throw new Error("OMP worker is not initialized");
        respond(true, await runtime.getComposerCatalog(message.args.cwd, { refresh: message.args.refresh }));
        break;
      case "getComposerActions": if (!runtime) throw new Error("OMP worker is not initialized"); respond(true, message.args.cwd ? await runtime.getComposerActions(message.args.cwd, { refresh: message.args.refresh }) : await requireSession().getComposerActions()); break;
      case "getSkillInventory": if (!runtime || session) throw new Error("Native skill inventory requires an initialized discovery worker."); respond(true, await runtime.getSkillInventory(message.args.cwd, { refresh: message.args.refresh })); break;
      case "getComposerCompletions": if (!runtime) throw new Error("OMP worker is not initialized"); respond(true, message.args.cwd ? await runtime.getComposerCompletions(message.args.cwd, message.args.query) : await requireSession().getComposerCompletions(message.args.query)); break;
      case "getMessages": respond(true, requireSession().getMessages()); break;
      case "getSessionActivity": {
        const active = requireSession();
        await active.refreshGoalUsage();
        respond(true, active.getSessionActivity());
        break;
      }
      case "mutateGoal": {
        respond(true, await requireSession().mutateGoal(parseGoalMutationRequest(message.args.request)));
        break;
      }
      case "getGoalContinuationEligibility": respond(true, requireSession().getGoalContinuationEligibility()); break;
      case "startGoalContinuation": {
        if (typeof message.args.expectedGoalId !== "string" || message.args.expectedGoalId.length < 1 || message.args.expectedGoalId.length > 200) {
          const error = new Error("Invalid native goal continuation identity."); error.name = "GoalContinuationRejected"; throw error;
        }
        const run = requireSession().startGoalContinuation(message.args.expectedGoalId);
        await Promise.all([
          run.accepted.then(value => respond(true, value, undefined, "accepted"), error => respond(false, undefined, error, "accepted")),
          run.completion.then(value => respond(true, value, undefined, "completion"), error => respond(false, undefined, error, "completion")),
        ]);
        break;
      }
      case "listQuestions": respond(true, await requireSession().listQuestions()); break;
      case "resolveQuestion": respond(true, await requireSession().resolveQuestion(parseResolveDetachedQuestionRequest(message.args.request))); break;
      case "startQuestionDelivery": {
        if (typeof message.args.questionId !== "string" || message.args.questionId.length < 1 || message.args.questionId.length > 200) {
          const error = new Error("Invalid detached question identity."); error.name = "DetachedQuestionRejected"; throw error;
        }
        const run = requireSession().startQuestionDelivery(message.args.questionId);
        await Promise.all([
          run.accepted.then(value => respond(true, value, undefined, "accepted"), error => respond(false, undefined, error, "accepted")),
          run.completion.then(value => respond(true, value, undefined, "completion"), error => respond(false, undefined, error, "completion")),
        ]);
        break;
      }
      case "readSessionMcpResource": respond(true, await requireSession().readSessionMcpResource(parseNativeSessionMcpResourceRequest(message.args.request))); break;
      case "startSessionMcpAuthorization": respond(true, requireSession().startSessionMcpAuthorization(parseNativeMcpAuthorizationStart(message.args.request))); break;
      case "getSessionMcpAuthorization": respond(true, requireSession().getSessionMcpAuthorization()); break;
      case "respondSessionMcpAuthorization": respond(true, requireSession().respondSessionMcpAuthorization(parseNativeMcpAuthorizationReply(message.args.request))); break;
      case "cancelSessionMcpAuthorization": respond(true, requireSession().cancelSessionMcpAuthorization(parseNativeMcpAuthorizationId(message.args.authorizationId))); break;
      case "getSessionMcp": respond(true, requireSession().getSessionMcp()); break;
      case "reloadSessionMcp": respond(true, await requireSession().reloadSessionMcp(parseNativeSessionMcpReload(message.args.request))); break;
      case "reconnectSessionMcp": respond(true, await requireSession().reconnectSessionMcp(parseNativeSessionMcpReconnect(message.args.request))); break;
      case "getBtw": respond(true, requireSession().getBtw()); break;
      case "startBtw": respond(true, requireSession().startBtw(message.args)); break;
      case "cancelBtw": respond(true, requireSession().cancelBtw(message.args.runId)); break;
      case "promoteBtw": respond(true, await requireSession().promoteBtw(message.args.runId, message.args.operationId)); break;
      case "getBrowserMetadata": {
        const owner = browserOwnerId();
        let native: { listTabsForOwner?: (ownerSessionId: string) => unknown };
        try { native = await import("@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor") as typeof native; }
        catch { respond(true, { availability: "unavailable", reason: "This host could not load its pinned native browser metadata seam." } satisfies BrowserMetadataAvailability); break; }
        if (typeof native.listTabsForOwner !== "function") respond(true, { availability: "unavailable", reason: "This host's pinned OMP package does not include the owner-filtered browser metadata patch." } satisfies BrowserMetadataAvailability);
        else respond(true, browserMetadata(native.listTabsForOwner(owner)));
        break;
      }
      case "createBrowserTab": {
        if (typeof message.args.name !== "string" || !/^desktop-[a-zA-Z0-9-]{1,100}$/.test(message.args.name)) {
          const error = new Error("Invalid native browser tab creation identity.");
          error.name = "BrowserTabCreateRejected";
          throw error;
        }
        let initialUrl: string | undefined;
        try { if (message.args.initialUrl !== undefined) initialUrl = parseBrowserNavigationUrl(message.args.initialUrl); }
        catch { const error = new Error("Invalid initial browser address."); error.name = "BrowserTabCreateRejected"; throw error; }
        respond(true, await (browserOwner ?? requireSession()).createBrowserTab(message.args.name, initialUrl));
        break;
      }
      case "controlBrowser": {
        const owner = browserOwnerId(), request = parseBrowserControlRequest(message.args.request);
        if (request.target.workerPid !== process.pid) { const error = new Error("The browser worker changed."); error.name = "BrowserActionRejected"; throw error; }
        const native = await import("@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor") as unknown as {
          performTabHumanActionForOwner?: (owner: string, target: typeof request.target, context: typeof request.context, action: typeof request.action) => Promise<unknown>
        };
        if (!native.performTabHumanActionForOwner) { const error = new Error("Native browser controls are unavailable."); error.name = "BrowserActionRejected"; throw error; }
        respond(true, await native.performTabHumanActionForOwner(owner, request.target, request.context, request.action));
        break;
      }
      case "closeBrowserTab": respond(true, await browserCloses.close(message.args.target)); break;
      case "inspectBrowserTab": respond(true, await browserObservations.inspect(message.args.target)); break;
      case "openBrowserEvaluation": respond(true, await browserEvaluations.open(message.args.binding, message.args.timeoutMs)); break;
      case "startBrowserEvaluation": await browserEvaluations.start(message.args.binding); respond(true); break;
      case "requestBrowserEvaluation": await browserEvaluations.request(message.args.binding, message.args.sequence, message.args.method, message.args.params, message.args.options, respond); break;
      case "disposeBrowserEvaluation": await browserEvaluations.close(message.args.binding); respond(true); break;
      case "inspectOpenBrowserEvaluation": respond(true, browserEvaluations.inspect(message.args.binding)); break;
      case "inspectRetainedBrowserEvaluation": {
        const record=retainedInstalls.get(retainedKey(message.args.binding));
        if(!record||record.disposed||!record.native)throw new Error("Retained browser installation is unavailable.");
        respond(true,{pending:record.pending.size,bufferedFrames:record.frames.length});break;
      }
      case "reserveBrowserEvaluation": respond(true, await browserReservations.reserve(message.args.target, message.args.operationId)); break;
      case "inspectBrowserEvaluationReservation": respond(true, browserReservations.inspect(message.args.target, message.args.operationId)); break;
      case "prepareRetainedBrowserEvaluation": {
        requireSession(); const {binding,descriptor,kindTag,safeDir}=message.args, key = retainedKey(binding);
        if (retainedInstalls.has(key) || binding.backend !== descriptor.backend || binding.name.length > 200 || binding.targetId.length > 200) throw new Error("Invalid retained browser installation identity.");
        const pending = new Map<string, ReturnType<typeof Promise.withResolvers<Record<string, unknown>>>>();
        const record: RetainedInstall = { binding,descriptor,kindTag,safeDir,pending,frames:[],disposed:false };
        retainedInstalls.set(key, record);
        respond(true,{prepared:true});
        break;
      }
      case "activateRetainedBrowserEvaluation": {
        const active=requireSession(), binding=message.args.binding, key=retainedKey(binding), record=retainedInstalls.get(key);
        if(!record||record.disposed||record.native)throw new Error("Retained browser installation was not prepared.");
        const {descriptor}=record;
        let sequence = 0;
        try {
          const native = await active.installRetainedBrowserEvaluation({ sourceOwnerId: binding.ownerId, operationId: binding.operationId,
            name: binding.name, targetId: binding.targetId, kindTag: record.kindTag, safeDir: record.safeDir, backend: binding.backend,
            ...(descriptor.backend === "cdp" ? { descriptor: descriptor.descriptor as unknown as Record<string, unknown> }
              : { state: descriptor.state as unknown as Record<string, unknown> }) }, {
            post: frame => send({ type: "retainedBrowserFrame", binding, frame: frame as import("../omp-browser/evaluation-wire").BrowserEvaluationFrame }),
            installReceiver: receive => {
              if (record.disposed || record.receiver) throw new Error("Retained browser receiver changed.");
              record.receiver = receive;
              for (const frame of record.frames.splice(0)) receive(frame);
            },
            request: (method, params, options) => {
              if (record.disposed || record.pending.size >= 64) return Promise.reject(new Error("Retained cmux request is unavailable."));
              const id = String(++sequence), deferred = Promise.withResolvers<Record<string, unknown>>(); record.pending.set(id, deferred);
              try { send({ type: "retainedBrowserRequest", binding, id, method, params, options }); }
              catch (error) { record.pending.delete(id); deferred.reject(error); }
              return deferred.promise.finally(() => { record.pending.delete(id); });
            },
          });
          record.native = native;
          for (const frame of record.frames.splice(0)) native.receive(frame);
        } catch (error) {
          await disposeRetainedInstall(record, "Retained browser installation failed.");
          throw error;
        }
        respond(true, { installed: true, sessionId: active.id, sourceOwnerId: binding.ownerId, operationId: binding.operationId, name: binding.name, targetId: binding.targetId, backend: binding.backend });
        break;
      }
      case "disposeRetainedBrowserEvaluation": {
        const record=retainedInstalls.get(retainedKey(message.args.binding));
        if(record)await disposeRetainedInstall(record,"Retained browser installation was cancelled.");
        respond(true,null);break;
      }
      case "getBrowserFrame": {
        const owner = browserOwnerId(), target = message.args.target;
        if (!validBrowserFrameTarget(target) || target.workerPid !== process.pid) throw new Error("The selected browser frame belongs to a stale or invalid worker target.");
        let native: { captureTabViewportForOwner?: (ownerSessionId: string, target: { name: string; targetId: string }) => Promise<unknown> };
        try { native = await import("@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor") as typeof native; }
        catch { throw new Error("This host could not load its pinned native browser capture seam."); }
        if (typeof native.captureTabViewportForOwner !== "function") throw new Error("This host's pinned OMP package does not include native browser viewport capture.");
        respond(true, projectNativeBrowserFrame(await native.captureTabViewportForOwner(owner, { name: target.name, targetId: target.targetId }), target, owner));
        break;
      }
      case "getImage": respond(true, await requireSession().getImage(message.args.nativeEntryId, message.args.blockIndex)); break;
      case "startPrompt": {
        const run = requireSession().startPrompt(message.args.text, message.args.options);
        // Preserve independent native acceptance and completion, including an
        // acceptance error after a dispatch has already begun.
        await Promise.all([
          run.accepted.then(value => respond(true, value, undefined, "accepted"), error => respond(false, undefined, error, "accepted")),
          run.completion.then(value => respond(true, value, undefined, "completion"), error => respond(false, undefined, error, "completion")),
        ]);
        break;
      }
      case "steer": respond(true, await requireSession().steer(message.args.text, message.args.expectedApprovalMode, message.args.options)); break;
      case "startFollowUp": {
        const run = requireSession().startFollowUp(message.args.text, message.args.delivery, message.args.expectedApprovalMode);
        await Promise.all([
          run.accepted.then(value => respond(true, value, undefined, "accepted"), error => respond(false, undefined, error, "accepted")),
          run.completion.then(value => respond(true, value, undefined, "completion"), error => respond(false, undefined, error, "completion")),
        ]);
        break;
      }
      case "getQueuedMessages": respond(true, requireSession().getQueuedMessages()); break;
      case "mutateQueuedMessages": respond(true, requireSession().mutateQueuedMessages(message.args.mutation)); break;
      case "assertTaskLocationReady": requireSession().assertTaskLocationReady(); respond(true); break;
      case "moveSession": respond(true, await requireSession().moveSession(message.args.cwd)); break;
      case "abort": await requireSession().abort(); respond(true); break;
      case "setModel": await requireSession().setModel(message.args.model); respond(true); break;
      case "listAccountChoices": respond(true, await requireSession().listAccountChoices()); break;
      case "pinAccount": respond(true, await requireSession().pinAccount(message.args.credentialId)); break;
      case "releaseAccountForReselection": respond(true, await requireSession().releaseAccountForReselection()); break;
      case "listInteractions": respond(true, await requireSession().listInteractions()); break;
      case "respondInteraction": await requireSession().respondInteraction(message.args.id, message.args.response); respond(true); break;
      case "cancelInteractions": await requireSession().cancelInteractions(message.args.reason); respond(true); break;
      case "getControls": respond(true, await requireSession().getControls()); break;
      case "mutateControls": respond(true, await requireSession().mutateControls(message.args)); break;
      case "setApprovalOverride": respond(true, await requireSession().setApprovalOverride(message.args.mode, message.args.expectedRevision)); break;
      case "dispose":
        stopping = true;
        {
          let disposed = false;
          let failure: unknown;
          try { await disposeNativeOwners(); disposed = true; } catch (error) { failure = error; }
          if (pendingDispose) throw new Error("OMP worker disposal is already awaiting acknowledgement");
          // Bun's advanced IPC can still have queued bytes after send() and
          // setImmediate(). Keep the child alive until the owner receives this
          // exact result. Do not read disposed native metadata to build it.
          pendingDispose = { id: message.id, exitCode: disposed ? 0 : 1,
            deadline: setTimeout(() => process.exit(1), 12_000) };
          send({ type: "response", id: message.id, ok: disposed,
            ...(disposed ? {} : { error: remoteError(failure) }) });
        }
        break;
    }
  } catch (error) {
    if (message.operation === "startPrompt" || message.operation === "startGoalContinuation" || message.operation === "startQuestionDelivery" || message.operation === "startFollowUp") {
      respond(false, undefined, error, "accepted");
      respond(false, undefined, error, "completion");
    } else respond(false, undefined, error);
  } finally {
    if (admitted) activeRequests--;
    if (ownsPromotion) { promotionInFlight = false; promotedOwnerRetired = session?.id !== originId || session?.sessionFile !== originFile; }
  }
}

function receiveParent(value: unknown): void {
  if (!value || typeof value !== "object" || !("type" in value)) return;
  const message = value as ParentMessage;
  if (message.type === "browserEvaluationFrame") {
    // Native channel sequencing owns ACKs. Terminal frames remain routed while
    // stopping; a bad channel frame does not recreate or kill its resource.
    try { browserEvaluations.receive(message.binding, message.frame); } catch { /* Matched-channel failures are retained by its drain. */ }
  } else if (message.type === "retainedBrowserFrame") {
    try {
      const record = retainedInstalls.get(retainedKey(message.binding));
      if (!record) return;
      if (record.receiver) record.receiver(message.frame);
      else if(record.disposed)return;
      else if (record.native) record.native.receive(message.frame);
      else if (record.frames.length < 256) record.frames.push(message.frame);
      else throw new Error("Retained browser startup frame capacity reached.");
    } catch { /* Native retained cleanup owns failure. */ }
  } else if (message.type === "retainedBrowserResponse") {
    const pending = retainedInstalls.get(retainedKey(message.binding))?.pending.get(message.id);
    if (pending) message.ok ? pending.resolve(message.value ?? {}) : pending.reject(Object.assign(new Error(message.error?.message ?? "Retained cmux request failed."), { name: message.error?.name ?? "Error" }));
  } else if (message.type === "browserEvaluationAck") {
    try { browserEvaluations.acknowledge(message.binding, message.sequence); } catch { /* No lookup or allocation on foreign receipts. */ }
  } else if (message.type === "disposeAck") {
    if (message.id === pendingDispose?.id) {
      clearTimeout(pendingDispose.deadline);
      process.exit(pendingDispose.exitCode);
    }
  } else if (message.type === "eventAck") {
    if (message.sequence === inFlight?.sequence) {
      bufferedBytes -= inFlight.bytes;
      inFlight = undefined;
      try { drain(); } catch (error) { void fatal(error); }
    }
  } else if (message.type === "request" && typeof message.id === "string") {
    void request(message).catch(fatal);
  }
}
process.on("message", receiveParent);
process.on("disconnect", () => { if (!reconnect) void shutdown(1); });
process.on("SIGTERM", () => { void shutdown(0); });
process.on("SIGINT", () => { void shutdown(0); });
process.on("uncaughtException", error => { void fatal(error); });
process.on("unhandledRejection", error => { void fatal(error); });
send({ type: "ready", version: WORKER_PROTOCOL_VERSION });
