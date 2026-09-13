import { mock } from "bun:test";
import { WORKER_PROTOCOL_VERSION, type ParentMessage } from "../protocol";

if (process.env.FORCE_TOOL_RAW_CHILD === "1") {
  let disposeId: string | undefined;
  process.on("message", (value: ParentMessage) => {
    if (value.type === "disposeAck" && value.id === disposeId) process.exit(0);
    if (value.type !== "request") return;
    if (value.operation === "init") process.send!({ type: "response", id: value.id, ok: true,
      snapshot: snapshot(value.args.mode === "create" ? value.args.options.cwd : "/controlled") });
    if (value.operation === "getForceTool") process.send!({ type: "response", id: value.id, ok: true, value: { ...state(), injected: true } } as never);
    if (value.operation === "startPrompt") {
      const commandId = value.args.options?.commandId ?? "missing";
      process.send!({ type: "response", id: value.id, phase: "accepted", ok: true, value: null,
        forceToolReceipt: { ...receipt(commandId), commandId: `${commandId}-changed` } } as never);
      process.send!({ type: "response", id: value.id, phase: "completion", ok: true, value: true });
    }
    if (value.operation === "dispose") { disposeId = value.id; process.send!({ type: "response", id: value.id, ok: true }); }
  });
  process.send!({ type: "ready", version: WORKER_PROTOCOL_VERSION });
} else {
  const activity = {
    goal: { availability: "unsupported", reason: "Controlled worker fixture" },
    jobs: { availability: "unsupported", reason: "Controlled worker fixture" },
    agents: { availability: "unsupported", reason: "Controlled worker fixture" },
    sources: { availability: "unsupported", reason: "Controlled worker fixture" },
  } as const;
  class FixtureOmpRuntime {
    create(options: { cwd: string }) { return session(options.cwd); }
    open(options: { expectedIdentity?: { cwd?: string } }) { return session(options.expectedIdentity?.cwd ?? "/controlled"); }
    dispose() {}
  }
  mock.module(new URL("../../omp/index.ts", import.meta.url).href, () => ({ OmpRuntime: FixtureOmpRuntime }));
  await import("../entry");

  function session(cwd: string) {
    let cancelled = false;
    return {
      id: "force-tool-session", sessionFile: `${cwd}/force-tool.jsonl`, cwd, model: null, thinkingLevel: undefined,
      isStreaming: false, hasPostPromptWork: false, title: undefined, createdAt: 1, modelFallbackMessage: undefined,
      getSessionActivity: () => activity,
      getForceTool: () => process.env.FORCE_TOOL_BAD_STATE === "1" ? { ...state(cancelled), injected: true } : state(cancelled),
      cancelForceTool: ({ directiveId }: { directiveId: string }) => {
        if (process.env.FORCE_TOOL_CANCEL === "refused") throw new Error("Controlled native cancellation refusal");
        cancelled = true;
        if (process.env.FORCE_TOOL_CANCEL === "lost") process.exit(24);
        const result = { state: state(cancelled), cancelledDirectiveId: directiveId };
        return process.env.FORCE_TOOL_CANCEL === "malformed" ? { ...result, cancelledDirectiveId: "changed-directive" } : result;
      },
      startPrompt: (_text: string, options?: { commandId?: string }) => promptRun(process.env.FORCE_TOOL_PROMPT ?? "accepted", options?.commandId),
      dispose() {},
    };
  }
}

function state(cancelled = false) {
  return {
    epoch: "epoch-1", revision: 3, nativeSessionId: "force-tool-session",
    model: { provider: "google", id: "gemini-2.5-flash", api: "google-generative-ai" },
    availability: { state: "supported" as const, reason: "" },
    tools: [{ name: "bash", available: true }],
    directives: cancelled ? [] : [{ id: "directive-1", toolName: "bash", commandId: "command-1", phase: "pending-tool" as const, requeued: false }],
    canArm: true, canCancel: !cancelled,
  };
}

function snapshot(cwd = "/controlled") {
  return { revision: 1, id: "force-tool-session", sessionFile: `${cwd}/force-tool.jsonl`, cwd, model: null,
    isStreaming: false, hasPostPromptWork: false, createdAt: 1,
    activity: { goal: { availability: "unsupported", reason: "Controlled worker fixture" }, jobs: { availability: "unsupported", reason: "Controlled worker fixture" },
      agents: { availability: "unsupported", reason: "Controlled worker fixture" }, sources: { availability: "unsupported", reason: "Controlled worker fixture" } } };
}

function receipt(commandId: string) {
  return { commandId, epoch: "epoch-1", directiveId: "directive-1", toolName: "bash", arm: "armed" as const, prompt: "recorded" as const, promptEntryId: "entry-1" };
}

function promptRun(mode: string, commandId = "missing") {
  if (mode === "ordinary") return {
    accepted: Promise.resolve({ kind: "native-command", command: "automation-flow" }),
    completion: Promise.resolve(false),
    get forceToolReceipt() { return undefined; },
  };
  const forceToolReceipt = mode === "untyped" ? { ...receipt(commandId), injected: true }
    : mode === "mismatch" ? receipt(`${commandId}-changed`) : receipt(commandId);
  if (mode === "lost") {
    setTimeout(() => process.exit(23), 10);
    return { accepted: new Promise(() => {}), completion: new Promise(() => {}), get forceToolReceipt() { return undefined; } };
  }
  if (mode === "rejected") {
    const error = Object.assign(new Error("Native admission failed with key=fixture-secret"), { name: "NativeAdmissionError", forceToolReceipt });
    return { accepted: Promise.reject(error), completion: Promise.reject(error), get forceToolReceipt() { return forceToolReceipt; } };
  }
  return { accepted: Promise.resolve({ kind: "user-message", entryId: "entry-1" }), completion: Promise.resolve(true), get forceToolReceipt() { return forceToolReceipt; } };
}
