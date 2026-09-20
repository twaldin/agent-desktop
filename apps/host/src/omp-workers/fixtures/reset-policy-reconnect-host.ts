// A real disposable host process. Killing this process leaves the original child
// and its SQLite journal, not a fabricated worker-loss or completion response.
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NativeResetPolicy } from "../../native-reset-policy";
import { ResetAccountAdmissions } from "../../session-reset-admission";
import { HostStore } from "../../store";
import { NativeResetPolicyWorkerOwner } from "../reset-policy-owner";
import { WorkerRuntime, type WorkerSession } from "../runtime";

const root = process.env.RESET_RECONNECT_FIXTURE_ROOT!;
const store = new HostStore(path.join(root, "host"));
const policy = new NativeResetPolicy({ store, admissions: new ResetAccountAdmissions(store) });
const admissionReply = Promise.withResolvers<void>();
if (process.env.RESET_RECONNECT_HOLD_ADMISSION !== "1") admissionReply.resolve();
let failDrain = process.env.RESET_RECONNECT_FAIL_DRAIN === "1";
let session: WorkerSession | undefined;
const runtime = new WorkerRuntime({ agentDir: path.join(root, "agent"), environment: process.env,
  workerPath: fileURLToPath(new URL("./reset-policy-reconnect-worker.ts", import.meta.url)),
  createResetPolicyOwner: context => {
    const owner = new NativeResetPolicyWorkerOwner({ store, policy, context });
    return {
      async handle(request) {
        const reply = await owner.handle(request);
        process.send?.({ type: "handled", request, reply });
        if (reply.kind === "admission.execute") await admissionReply.promise;
        return reply;
      },
      beginClose: () => owner.beginClose(), workerLost: () => owner.workerLost(),
      workerExited: () => owner.workerExited(), async drain() {
        await owner.drain();
        if (failDrain) { failDrain = false; throw new Error("Controlled owner-drain failure"); }
      },
    };
  },
});
process.on("message", message => {
  const command = message as { type: string };
  if (command.type === "releaseAdmission") admissionReply.resolve();
  if (command.type === "blocked") void session!.prompt("Controlled reset recovery boundary.").then(
    value => process.send?.({ type: "promptSettled", value }),
    error => process.send?.({ type: "promptSettled", error: String(error) }));
  if (command.type === "detach") void (async () => {
    const disposal = runtime.dispose({ preserveReconnect: true });
    process.send?.({ type: "detaching" });
    await disposal;
    await policy.drain();
    store.close();
    process.send?.({ type: "detached", storeClosed: true });
  })().catch(error => process.send?.({ type: "handoffFailed", error: String(error),
    storeReadable: Array.isArray(store.listSessions()) }));
});
try {
  session = await runtime.create({ cwd: path.join(root, "project"), model: { provider: "openai-codex", id: "gpt-5.4-mini" }, interactions: true,
    onEvent: event => {
      if (event.type === "extension_interaction_requested") process.send?.({ type: "interaction", interaction: event.interaction });
    } });
  const endpoint = await session.enableBrowserRecovery!(path.join(root, "worker.sock"), randomBytes(32).toString("hex"), randomUUID());
  process.send?.({ type: "created", endpoint });
} catch (error) {
  process.send?.({ type: "failure", error: String(error) });
  await runtime.dispose().catch(() => {});
  store.close(); process.exit(1);
}
