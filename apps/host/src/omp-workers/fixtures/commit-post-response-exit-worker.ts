// Protocol fixture: reports generation success, then dies before disposal can be acknowledged.
import { WORKER_PROTOCOL_VERSION, type ParentMessage } from "../protocol";
process.on("message", (value: ParentMessage) => {
  if (value.type !== "request") return;
  if (value.operation === "init") process.send!({ type: "response", id: value.id, ok: true });
  if (value.operation === "generateCommit") {
    process.send!({ type: "response", id: value.id, ok: true, value: {
      commit: { type: "test", summary: "must not escape" }, message: "test: must not escape", validationError: null, stagedAll: false,
    } }, undefined, () => process.exit(0));
  }
});
process.send!({ type: "ready", version: WORKER_PROTOCOL_VERSION });
