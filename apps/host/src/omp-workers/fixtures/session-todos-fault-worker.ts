// IPC fault injection only. Native state/persistence is tested by the separate
// provider-free native fixture; this fixture tests delivery classification.
import { appendFileSync } from "node:fs";
import { WORKER_PROTOCOL_VERSION, type ParentMessage, type SessionSnapshot } from "../protocol";
let disposeId: string | undefined;
const unavailable = { availability: "unsupported", reason: "Fault injection fixture" } as const;
const state = { ticket: { nativeSessionId: "session", epoch: "epoch", revision: "revision" }, phases: [], markdown: "# Todos\n", nativeCommandAvailable: true, reconciliationRequired: false };
process.on("message", (message: ParentMessage) => {
  if (message.type === "disposeAck" && message.id === disposeId) process.exit(0);
  if (message.type !== "request") return;
  if (message.operation === "init") {
    const cwd = message.args.mode === "create" ? message.args.options.cwd : process.env.HOME!;
    const snapshot: SessionSnapshot = { revision: 1, id: "session", sessionFile: `${cwd}/session.jsonl`, cwd, model: null, isStreaming: false, hasPostPromptWork: false, createdAt: 1, activity: { goal: unavailable, agents: unavailable, jobs: unavailable, sources: unavailable } };
    process.send!({ type: "response", id: message.id, ok: true, snapshot });
  }
  if (message.operation === "getTodos") process.send!({ type: "response", id: message.id, ok: true, value: state });
  if (message.operation === "mutateTodos") {
    const mode = process.env.TODOS_FAULT;
    if (mode === "rejected") {
      process.send!({ type: "response", id: message.id, ok: false, error: { name: "Error", message: "Explicit pre-effect refusal", code: "TODOS_REJECTED" } }); return;
    }
    appendFileSync(process.env.TODOS_EFFECT_LOG!, "effect\n");
    if (mode === "lost") process.exit(24);
    if (mode === "unclassified") { process.send!({ type: "response", id: message.id, ok: false, error: { name: "Error", message: "Reply construction failed after effect" } }); return; }
    process.send!({ type: "response", id: message.id, ok: true, value: { commandId: message.args.commandId, state: { ...state, ticket: { ...state.ticket, epoch: "replacement" } }, output: "" } });
  }
  if (message.operation === "dispose") { disposeId = message.id; process.send!({ type: "response", id: message.id, ok: true }); }
});
process.send!({ type: "ready", version: WORKER_PROTOCOL_VERSION });
