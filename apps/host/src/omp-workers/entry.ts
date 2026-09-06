import { parseBrowserControlRequest, parseGoalMutationRequest, parseResolveDetachedQuestionRequest } from "@agent-desktop/shared";
import { serialize } from "node:v8";
import type { OmpRuntime, OmpSession, OmpRuntimeEvent } from "../omp";
import { validBrowserFrameTarget, type BrowserMetadataAvailability, type NativeBrowserTabMetadata } from "@agent-desktop/shared";
import { projectNativeBrowserFrame } from "../omp-browser/frame";
import { remoteError, WORKER_PROTOCOL_VERSION, type ChildMessage, type ParentMessage, type SessionSnapshot } from "./protocol";
import { projectWorkerEvent } from "./events";

// All SDK imports are deferred until the child has received its explicit native
// directory. The daemon never imports/initializes OMP through this boundary.
let runtime: OmpRuntime | undefined;
let session: OmpSession | undefined;
let initializing = false;
let stopping = false;
let shuttingDown: Promise<void> | undefined;
let pendingDispose: { id: string; exitCode: number; deadline: ReturnType<typeof setTimeout> } | undefined;
let snapshotRevision = 0;
let activeRequests = 0;
let promotionInFlight = false;
let promotedOwnerRetired = false;
let latestActivity: SessionSnapshot["activity"] | undefined;

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
  if (!process.connected || !process.send) throw new Error("OMP worker lost its owning daemon");
  process.send(message);
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

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return shuttingDown;
  stopping = true;
  shuttingDown = (async () => {
    const deadline = setTimeout(() => process.exit(exitCode || 1), 12_000);
    deadline.unref();
    try { await runtime?.dispose(); }
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
      ...(error === undefined ? {} : { error: remoteError(error) }), phase, snapshot: snapshot() });
  };
  try {
    if (stopping && message.operation !== "dispose") throw new Error("OMP worker is stopping");
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
        const { OmpRuntime } = await import("../omp");
        runtime = new OmpRuntime({ agentDir: init.agentDir });
        if (init.mode === "create") session = await runtime.create({ ...init.options, onEvent: emit });
        if (init.mode === "open") session = await runtime.open({ ...init.options, onEvent: emit });
        respond(true, snapshot());
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
      case "getBtw": respond(true, requireSession().getBtw()); break;
      case "startBtw": respond(true, requireSession().startBtw(message.args)); break;
      case "cancelBtw": respond(true, requireSession().cancelBtw(message.args.runId)); break;
      case "promoteBtw": respond(true, await requireSession().promoteBtw(message.args.runId, message.args.operationId)); break;
      case "getBrowserMetadata": {
        const owner = requireSession().id;
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
        respond(true, await requireSession().createBrowserTab(message.args.name));
        break;
      }
      case "controlBrowser": {
        const owner = requireSession().id, request = parseBrowserControlRequest(message.args.request);
        if (request.target.workerPid !== process.pid) { const error = new Error("The browser worker changed."); error.name = "BrowserActionRejected"; throw error; }
        const native = await import("@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor") as unknown as {
          performTabHumanActionForOwner?: (owner: string, target: typeof request.target, context: typeof request.context, action: typeof request.action) => Promise<unknown>
        };
        if (!native.performTabHumanActionForOwner) { const error = new Error("Native browser controls are unavailable."); error.name = "BrowserActionRejected"; throw error; }
        respond(true, await native.performTabHumanActionForOwner(owner, request.target, request.context, request.action));
        break;
      }
      case "getBrowserFrame": {
        const owner = requireSession().id, target = message.args.target;
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
          try { await runtime?.dispose(); disposed = true; } catch (error) { failure = error; }
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
    if (message.operation === "startPrompt" || message.operation === "startGoalContinuation" || message.operation === "startQuestionDelivery") {
      respond(false, undefined, error, "accepted");
      respond(false, undefined, error, "completion");
    } else respond(false, undefined, error);
  } finally {
    if (admitted) activeRequests--;
    if (ownsPromotion) { promotionInFlight = false; promotedOwnerRetired = session?.id !== originId || session?.sessionFile !== originFile; }
  }
}

process.on("message", (value: unknown) => {
  if (!value || typeof value !== "object" || !("type" in value)) return;
  const message = value as ParentMessage;
  if (message.type === "disposeAck") {
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
});
process.on("disconnect", () => { void shutdown(1); });
process.on("SIGTERM", () => { void shutdown(0); });
process.on("SIGINT", () => { void shutdown(0); });
process.on("uncaughtException", error => { void fatal(error); });
process.on("unhandledRejection", error => { void fatal(error); });
send({ type: "ready", version: WORKER_PROTOCOL_VERSION });
