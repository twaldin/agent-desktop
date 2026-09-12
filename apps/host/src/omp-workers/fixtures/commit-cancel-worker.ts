// Protocol-only fixture: native generation behavior is tested separately.
import { writeFileSync } from "node:fs";
import { WORKER_PROTOCOL_VERSION, type ParentMessage } from "../protocol";
writeFileSync(process.env.COMMIT_WORKER_PID!, String(process.pid));
process.on("message", (value: ParentMessage) => {
  if (value.type === "disposeAck") process.exit(0);
  if (value.type !== "request") return;
  if (value.operation === "init") {
    if (process.env.COMMIT_WORKER_HOLD === "startup") writeFileSync(process.env.COMMIT_WORKER_STAGE!, "startup");
    else process.send!({ type: "response", id: value.id, ok: true });
  }
  if (value.operation === "generateCommit") {
    process.send!({ type: "commitProgress", id: value.id, message: "Controlled generation pending" });
    writeFileSync(process.env.COMMIT_WORKER_STAGE!, "generation");
  }
  if (value.operation === "dispose") process.send!({ type: "response", id: value.id, ok: true });
});
process.send!({ type: "ready", version: WORKER_PROTOCOL_VERSION });
